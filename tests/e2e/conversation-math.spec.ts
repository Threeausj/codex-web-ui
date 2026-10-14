import type { Page } from '@playwright/test';
import { test, expect, login, type MockCodex } from './fixtures';

function history(mock: MockCodex, user: string, agent = user) {
  const items = mock.turns.get('thread-existing')![0].items;
  items[0].content = [{ type: 'text', text: user, text_elements: [] }];
  items[1].text = agent;
}

async function openHistory(page: Page) {
  await login(page);
  if ((page.viewportSize()?.width || 1280) <= 760)
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toBeVisible();
}

test('both conversation roles render inline and display formulas with accessible mathematics', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  history(mock, String.raw`内联 $E=mc^2$ 与 \(\alpha+\beta\)。

$$\frac{a}{b}=\sqrt{x}$$

\[\sum_{i=1}^{n}i=\frac{n(n+1)}{2}\]`);
  await openHistory(page);
  for (const id of ['history-user', 'history-agent']) {
    const message = page.locator(`[data-selection-item-id="${id}"]`);
    await expect(message.locator('.katex')).toHaveCount(4);
    await expect(message.locator('.katex-display')).toHaveCount(2);
    await expect(message.locator('.katex-mathml math')).toHaveCount(4);
    await expect(message.locator('.katex-mathml mfrac')).toHaveCount(2);
    await expect(message.locator('.katex-mathml msqrt')).toHaveCount(1);
    await expect(message).toContainText('内联');
    await expect(message.locator('.katex-error')).toHaveCount(0);
    const centered = await message.locator('.katex-display').first().evaluate(element => {
      const container = element.getBoundingClientRect();
      const segments = [...element.querySelectorAll('.katex-html > .katex-base')].map(segment => segment.getBoundingClientRect());
      const left = Math.min(...segments.map(segment => segment.left));
      const right = Math.max(...segments.map(segment => segment.right));
      return Math.abs((left + right) / 2 - (container.left + container.right) / 2);
    });
    expect(centered).toBeLessThan(2);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: '.data/conversation-math-desktop.png' });
});

test('formulas retain mathematical structure beside Markdown lists and tables', async ({ page, mock }) => {
  history(mock, '请展示矩阵', String.raw`- 概率：$\mathbb{P}(X\le x)=\Phi(x)$
- 矩阵：$\begin{pmatrix}a&b\\c&d\end{pmatrix}$

| 数量 | 表达式 |
| --- | --- |
| 损失 | $\frac{1}{n}\sum_{i=1}^{n}(y_i-\hat y_i)^2$ |

$$\int_0^\infty e^{-x^2}\,dx=\frac{\sqrt{\pi}}{2}$$`);
  await openHistory(page);
  const answer = page.locator('[data-selection-item-id="history-agent"]');
  await expect(answer.locator('li .katex')).toHaveCount(2);
  await expect(answer.locator('td .katex')).toHaveCount(1);
  await expect(answer.locator('.katex-display')).toHaveCount(1);
  await expect(answer.locator('.katex-mathml mtable')).toHaveCount(1);
  await expect(answer.locator('.katex-mathml mfrac')).toHaveCount(2);
  await expect(answer.locator('.katex-mathml msqrt')).toHaveCount(1);
});

test('source code, escaped delimiters and prices stay literal instead of becoming formulas', async ({ page, mock }) => {
  const source = [
    '内联代码 `$x^2$` 与 `\\(a+b\\)`。',
    '```tex\n$$\\frac{x}{y}$$\n\\[z^2\\]\n```',
    '价格是 $5 和 $10。转义写法 \\$x\\$。',
    '真正公式 $x^2$。',
  ].join('\n\n');
  history(mock, source);
  await openHistory(page);
  for (const id of ['history-user', 'history-agent'])
    await expect(page.locator(`[data-selection-item-id="${id}"] .katex`)).toHaveCount(1);
  const answer = page.locator('[data-selection-item-id="history-agent"]');
  await expect(answer.locator('code .katex')).toHaveCount(0);
  await expect(answer.locator('pre')).toContainText('$$\\frac{x}{y}$$');
  await expect(answer).toContainText('价格是 $5 和 $10');
});

test('unfinished streamed formulas stay readable and render when their closing delimiter arrives', async ({ page, mock }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openHistory(page);
  const item = { id: 'stream-math', type: 'agentMessage', phase: 'final_answer', text: String.raw`已完成 $x^2$。

$$\frac{1}{` };
  const turn = { id: 'math-stream-turn', status: 'inProgress', items: [item], error: null };
  mock.turns.get('thread-existing')!.push(turn);
  mock.emit('turn/started', { threadId: 'thread-existing', turn });
  const answer = page.locator('[data-selection-item-id="stream-math"]');
  await expect(answer.locator('.katex')).toHaveCount(1);
  await expect(answer).toContainText('$$\\frac{1}{');
  mock.emit('item/agentMessage/delta', { threadId: 'thread-existing', turnId: turn.id, itemId: item.id, delta: '2}$$' });
  await expect(answer.locator('.katex')).toHaveCount(2);
  await expect(answer.locator('.katex-display')).toHaveCount(1);
  item.text += '2}$$';
  turn.status = 'completed';
  mock.emit('item/completed', { threadId: 'thread-existing', turnId: turn.id, item });
  mock.emit('turn/completed', { threadId: 'thread-existing', turn });
  await expect(answer.locator('.katex')).toHaveCount(2);
  await expect(answer.locator('.katex-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('untrusted math commands and HTML cannot execute scripts or fetch formula images', async ({ page, mock }) => {
  const remoteImages: string[] = [];
  await page.route('https://math-unsafe.invalid/**', route => {
    remoteImages.push(route.request().url());
    return route.abort();
  });
  history(mock, String.raw`<script>window.mathUnsafe=true</script>
<svg onload="window.mathUnsafe=true"></svg>

$\href{javascript:window.mathUnsafe=true}{危险链接}$

$\includegraphics{https://math-unsafe.invalid/formula.png}$

$\htmlClass{unsafe}{x}$

正常 $a+b$。`);
  await openHistory(page);
  for (const id of ['history-user', 'history-agent']) {
    const message = page.locator(`[data-selection-item-id="${id}"]`);
    await expect(message.locator('script, iframe, [onload], [onclick], a[href^="javascript:"], img')).toHaveCount(0);
    await expect(message.locator('.unsafe')).toHaveCount(0);
    await expect(message.locator('.katex').last()).toBeVisible();
  }
  expect(await page.evaluate(() => (window as any).mathUnsafe)).toBeUndefined();
  expect(remoteImages).toEqual([]);
});

test('image descriptions containing math and quotes stay plain safe attributes and keep pictures loadable', async ({ page, mock }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=', 'base64');
  const remoteUrl = 'https://math-images.invalid/image.png';
  await page.route(remoteUrl, route => route.fulfill({ contentType: 'image/png', body: png }));
  await page.route('**/api/hosts/local/images?*', route => route.fulfill({ contentType: 'image/png', body: png }));
  const remoteAlt = 'Dollar $x$ "quoted"';
  const localAlt = String.raw`Local \(y\) "quoted"`;
  const title = '" onerror="window.mathUnsafe=true';
  history(mock, '请看图片', [
    `![${remoteAlt}](${remoteUrl} '${title}')`,
    `![${localAlt}](/workspace/demo/plot.png '${title}')`,
    '图片外的公式 $z^2$。',
  ].join('\n\n'));
  await openHistory(page);
  const answer = page.locator('[data-selection-item-id="history-agent"]');
  const images = answer.locator('img');
  await expect(images).toHaveCount(2);
  await expect(images.nth(0)).toHaveAttribute('src', remoteUrl);
  await expect(images.nth(0)).toHaveAttribute('alt', remoteAlt);
  await expect(images.nth(1)).toHaveAttribute('src', '/api/hosts/local/images?path=%2Fworkspace%2Fdemo%2Fplot.png');
  await expect(images.nth(1)).toHaveAttribute('alt', localAlt);
  for (const image of [images.nth(0), images.nth(1)]) {
    await expect(image).toHaveAttribute('title', title);
    await expect(image).not.toHaveAttribute('onerror');
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  }
  await expect(answer.locator('.katex')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).mathUnsafe)).toBeUndefined();
});

test('copying rendered user and assistant formulas preserves the original message source', async ({ page, mock }) => {
  await page.addInitScript(() => {
    (window as any).copiedMathSources = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).copiedMathSources.push(text); },
    } });
  });
  const user = String.raw`解释 $x^2$ 与 \(\alpha+\beta\)。`;
  const agent = String.raw`分数：

$$\frac{1}{2}$$

根号 \(\sqrt{x}\)。`;
  history(mock, user, agent);
  await openHistory(page);
  await expect(page.locator('[data-selection-item-id="history-user"] .katex')).toHaveCount(2);
  await expect(page.locator('[data-selection-item-id="history-agent"] .katex')).toHaveCount(2);
  await page.locator('.user-message').hover();
  await page.getByRole('button', { name: '复制消息', exact: true }).click();
  await page.getByRole('button', { name: '复制回复', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copiedMathSources)).toEqual([user, agent]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`unbreakable inline formulas stay scrollable inside both mobile message roles in ${theme} mode`, async ({ page, mock }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    const matrix = String.raw`\begin{bmatrix}` +
      Array.from({ length: 28 }, (_, index) => `a_{${index}}`).join('&') + String.raw`\end{bmatrix}`;
    history(mock, `前文 $${matrix}$ 后文。短式 $x^2$。`);
    await openHistory(page);
    await page.evaluate(() => document.fonts.ready);
    for (const id of ['history-user', 'history-agent']) {
      const message = page.locator(`[data-selection-item-id="${id}"]`);
      await expect(message.locator('.katex-display')).toHaveCount(0);
      await expect(message.locator('.katex')).toHaveCount(2);
      const formula = message.locator('.katex').first();
      const layout = await formula.evaluate(element => {
        element.scrollLeft = 0;
        const first = element.querySelector('.katex-html > .katex-base')!.getBoundingClientRect().left;
        const firstVisible = first >= element.getBoundingClientRect().left - 1;
        element.scrollLeft = element.scrollWidth;
        const last = element.querySelector('.katex-html > .katex-base')!.getBoundingClientRect().right;
        return { firstVisible, lastVisible: last <= element.getBoundingClientRect().right + 1,
          scrollLeft: element.scrollLeft, width: element.clientWidth, contentWidth: element.scrollWidth,
          right: element.getBoundingClientRect().right };
      });
      expect(layout.contentWidth).toBeGreaterThan(layout.width);
      expect(layout.scrollLeft).toBeGreaterThan(0);
      expect(layout.firstVisible).toBe(true);
      expect(layout.lastVisible).toBe(true);
      expect(layout.right).toBeLessThanOrEqual(390);
      await expect(message).toContainText('前文');
      await expect(message).toContainText('后文');
      await expect(message.locator('.katex').last()).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test(`long formulas scroll inside mobile messages and use local math fonts in ${theme} mode`, async ({ page, mock }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    // A matrix is indivisible. Unlike a sum, valid TeX cannot wrap its columns
    // at binary operators, so it exercises horizontal overflow handling.
    const longFormula = String.raw`\begin{bmatrix}` +
      Array.from({ length: 28 }, (_, index) => `\\frac{a_{${index}}}{b_{${index}}}`).join('&') +
      String.raw`\end{bmatrix}`;
    history(mock, `长公式：\n\n$$${longFormula}$$`);
    const fontOrigins: string[] = [];
    page.on('request', request => {
      if (request.resourceType() === 'font') fontOrigins.push(new URL(request.url()).origin);
    });
    await openHistory(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.evaluate(() => document.fonts.ready);
    for (const id of ['history-user', 'history-agent']) {
      const formula = page.locator(`[data-selection-item-id="${id}"] .katex-display`);
      await expect(formula).toBeVisible();
      const layout = await formula.evaluate(element => {
        const style = getComputedStyle(element);
        const overflow = element.scrollWidth > element.clientWidth;
        element.scrollLeft = 0;
        const left = element.querySelector('.katex-html > .katex-base')!.getBoundingClientRect().left;
        const firstSymbolVisible = left >= element.getBoundingClientRect().left - 1;
        element.scrollLeft = element.scrollWidth;
        const right = element.querySelector('.katex-html > .katex-base')!.getBoundingClientRect().right;
        const lastSymbolVisible = right <= element.getBoundingClientRect().right + 1;
        element.scrollLeft = 100;
        return { overflow, scrollLeft: element.scrollLeft, overflowX: style.overflowX,
          firstSymbolVisible, lastSymbolVisible, color: style.color, right: element.getBoundingClientRect().right };
      });
      expect(layout.overflow).toBe(true);
      expect(layout.overflowX).toMatch(/auto|scroll/);
      expect(layout.scrollLeft).toBeGreaterThan(0);
      expect(layout.firstSymbolVisible).toBe(true);
      expect(layout.lastSymbolVisible).toBe(true);
      expect(layout.right).toBeLessThanOrEqual(390);
      expect(layout.color).not.toBe(theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
      await formula.evaluate(element => { element.scrollLeft = 0; });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
    expect(fontOrigins.length).toBeGreaterThan(0);
    expect(fontOrigins.every(origin => origin === new URL(page.url()).origin)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`math-mobile-${theme}.png`) });
    if (theme === 'dark') await page.screenshot({ path: '.data/conversation-math-mobile-dark.png' });
  });
}

test('side-chat questions and their streamed answers share conversation formula rendering', async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  const sideId = 'math-side-branch';
  (mock as any).receive = (socket: any, request: any) => {
    const reply = (result: unknown) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'thread/goal/get') return reply({ goal: null });
    if (request.method === 'thread/fork' && request.params.ephemeral) {
      const source = mock.threads.find(thread => thread.id === request.params.threadId)!;
      const thread = { ...source, id: sideId, ephemeral: true, forkedFromId: source.id, turns: [] };
      mock.turns.set(sideId, []);
      return reply({ thread, model: mock.config.model, reasoningEffort: 'medium', sandbox: { type: 'readOnly' } });
    }
    return receive(socket, request);
  };
  await openHistory(page);
  await page.getByRole('button', { name: '新建侧边聊天', exact: true }).click();
  await page.getByRole('textbox', { name: '基于当前对话提问', exact: true }).fill('解释 $x^2$');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(page.locator('.side-chat-transcript .user-bubble .katex')).toHaveCount(1);
  const turn = mock.turns.get(sideId)!.at(-1)!;
  const item = { id: 'side-math-answer', type: 'agentMessage', phase: 'final_answer', text: String.raw`结果 \(x^2\)。

$$\sqrt{x}$$` };
  turn.items.push(item);
  mock.emit('item/completed', { threadId: sideId, turnId: turn.id, item });
  const answer = page.locator('.side-chat-transcript [data-selection-item-id="side-math-answer"]');
  await expect(answer.locator('.katex')).toHaveCount(2);
  await expect(answer.locator('.katex-display')).toHaveCount(1);
});
