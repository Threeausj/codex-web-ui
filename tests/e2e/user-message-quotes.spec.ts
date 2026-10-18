import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';
import { formatConversationQuote } from '../../src/lib/conversation-selection';

const quoteName = '部署 codex-web-ui';
const quoted = [
  '### 已确认的行为',
  '',
  '- 即时引导保留正在执行的任务。',
  '- 恢复会话时核对权限。',
  '',
  '| 项目 | 状态 |',
  '| --- | --- |',
  '| 远端输出 | 已保留 |',
  '',
  '```ts',
  'const result = await command.exec();',
  '```',
  '',
  '上下文公式 $\\frac{218}{500}$。',
].join('\n');
const selection = formatConversationQuote({ hostId: 'local', threadId: 'thread-existing', threadName: quoteName, text: quoted });

function history(mock: MockCodex, text: string) {
  mock.turns.get('thread-existing')![0].items[0].content = [{ type: 'text', text, text_elements: [] }];
}
async function openHistory(page: Page) {
  await login(page);
  if ((page.viewportSize()?.width || 1280) <= 760) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator('[data-selection-item-id="history-user"]')).toBeVisible();
}

for (const [width, theme] of [[1440, 'light'], [390, 'dark']] as const) {
  test(`${width}px ${theme} conversation references use compact expandable Markdown cards`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => localStorage.setItem('codex.theme', value), theme);
    history(mock, `请按这些内容继续修改。\n\n${selection}\n\n保留普通正文 **原始格式**，不要改动上传的图片。`);
    await openHistory(page);
    const user = page.locator('[data-selection-item-id="history-user"]');
    const card = user.getByRole('region', { name: `引用对话：${quoteName}`, exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: `展开引用 ${quoteName}`, exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('.user-quote-body')).toHaveCount(0);
    await expect(user).toContainText('保留普通正文 **原始格式**');
    await expect(user).not.toContainText('[引用对话：');
    expect((await card.boundingBox())!.height).toBeLessThan(125);
    await page.screenshot({ path: `.data/user-message-quotes-${width}-${theme}-collapsed.png`, animations: 'disabled' });
    await card.getByRole('button', { name: `展开引用 ${quoteName}`, exact: true }).click();
    await expect(card.locator('table')).toHaveCount(1);
    await expect(card.locator('pre code')).toHaveText('const result = await command.exec();\n');
    await expect(card.locator('.katex')).toHaveCount(1);
    await expect(card.locator('li')).toHaveCount(2);
    await expect(card.getByRole('button', { name: `收起引用 ${quoteName}`, exact: true })).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `.data/user-message-quotes-${width}-${theme}-expanded.png`, animations: 'disabled' });
    await card.getByRole('button', { name: `收起引用 ${quoteName}`, exact: true }).click();
    await expect(card.locator('.user-quote-body')).toHaveCount(0);
    expect(mock.request('turn/start')).toBeUndefined();
    expect(mock.request('turn/steer')).toBeUndefined();
  });
}

test('short historical and file references render safely while ordinary messages stay literal', async ({ page, mock }) => {
  const unsafe = '<img src=x onerror="window.quoteUnsafe=true">\n<script>window.quoteUnsafe=true</script>\n[危险链接](javascript:window.quoteUnsafe=true)';
  const ordinary = '普通正文 **不渲染粗体**，`code` 和 > 都保持原样。';
  history(mock, [`历史引用[引用对话：安全检查]\n${unsafe.split('\n').map(line => `> ${line}`).join('\n')}`, '[引用文件：/repo/example.ts:2–3]\n> `ready()`', ordinary].join('\n\n'));
  await openHistory(page);
  const user = page.locator('[data-selection-item-id="history-user"]');
  await expect(user.locator('.user-quote')).toHaveCount(2);
  await expect(user.getByRole('region', { name: '引用对话：安全检查', exact: true }).locator('.user-quote-body')).toBeVisible();
  await expect(user.getByRole('region', { name: '引用文件：/repo/example.ts:2–3', exact: true })).toContainText('ready()');
  await expect(user.locator('script, [onerror], [onload], a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).quoteUnsafe)).toBeUndefined();
  await expect(user.locator('.user-message-text').last()).toHaveText(ordinary);
  await expect(user.locator('.user-message-text strong, .user-message-text code')).toHaveCount(0);
});

test('copying and editing a rendered quotation keep the original source text', async ({ page, mock }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { (window as any).lastQuotedCopy = text; },
  } }));
  const source = `继续修改\n\n${selection}`;
  history(mock, source);
  await openHistory(page);
  const message = page.locator('.user-message').first();
  await message.getByRole('button', { name: '复制消息', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).lastQuotedCopy)).toBe(source);
  await message.getByRole('button', { name: '编辑消息', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑消息内容', exact: true })).toHaveValue(source);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(message.locator('.user-quote')).toBeVisible();
});
