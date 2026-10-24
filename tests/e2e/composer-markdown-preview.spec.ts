import { test, expect, login, setComposerSelection, getComposerSelection, readComposerClipboardSource, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const sourceInput = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const preview = (page: Page) => page.getByRole('region', { name: 'Markdown 草稿预览', exact: true });
const openPreview = (page: Page) => page.getByRole('button', { name: '预览 Markdown', exact: true }).click();
async function history(page: Page) {
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: '已有测试历史' }).click();
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toBeVisible();
}
async function quoteHistory(page: Page) {
  await page.locator('[data-selection-item-id="history-agent"]').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '添加到对话', exact: true }).click();
}

test('an explicit draft preview renders safe Markdown and math, while sending the original source', async ({ page, mock }) => {
  const source = [
    '# 发布计划', '**重点内容**', '- 第一项\n- 第二项',
    '| 项目 | 状态 |\n| --- | --- |\n| UI | 完成 |',
    '```ts\nconst value = 42;\n```', String.raw`公式 $E=mc^2$。`,
    '[安全链接](https://example.com/docs)',
    '<script>window.composerUnsafe = true</script>',
    '<svg onload="window.composerUnsafe=true"></svg>',
    '[危险链接](javascript:alert(1))',
    '<img src="missing-preview.png" onerror="window.composerUnsafe=true">',
  ].join('\n\n');
  await login(page);
  await sourceInput(page).fill(source);
  await expect(preview(page)).toHaveCount(0);
  await openPreview(page);
  const rendered = preview(page);
  await expect(sourceInput(page)).toBeHidden();
  await expect(rendered.getByRole('heading', { name: '发布计划' })).toBeVisible();
  await expect(rendered.locator('strong')).toHaveText('重点内容');
  await expect(rendered.locator('li')).toHaveCount(2);
  await expect(rendered.locator('table td')).toHaveText(['UI', '完成']);
  await expect(rendered.locator('pre code')).toContainText('const value = 42;');
  await expect(rendered.locator('.katex-mathml math')).toHaveCount(1);
  await expect(rendered.locator('script, iframe, [onload], [onerror], a[href^="javascript:"]')).toHaveCount(0);
  await expect(rendered.getByRole('link', { name: '安全链接' })).toHaveAttribute('target', '_blank');
  await expect(rendered.getByRole('link', { name: '安全链接' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.evaluate(() => (window as any).composerUnsafe)).toBeUndefined();
  await page.screenshot({ path: '.data/composer-markdown-desktop.png' });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.input[0]?.text).toBe(source);
  await expect(sourceInput(page)).toBeVisible();
  await expect(sourceInput(page)).toHaveValue('');
});

test('returning to source restores the caret and keeps Enter, Shift+Enter and mention insertion working', async ({ page, mock }) => {
  await login(page);
  const input = sourceInput(page);
  await input.fill('**原始草稿**');
  await setComposerSelection(input, 2, 6);
  await openPreview(page);
  await page.getByRole('button', { name: '编辑 Markdown', exact: true }).click();
  await expect(input).toBeFocused();
  expect(await getComposerSelection(input)).toEqual([2, 6]);
  await input.fill('第一行');
  await input.press('End');
  await input.press('Shift+Enter');
  await input.press('x');
  await expect(input).toHaveValue('第一行\nx');
  await openPreview(page);
  await page.getByRole('button', { name: '选择模式或引用项目文件', exact: true }).click();
  await expect(preview(page)).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(page.getByRole('listbox')).toBeVisible();
  await input.press('Escape');
  await input.fill('**编辑后发送**');
  await input.press('Enter');
  await expect.poll(() => mock.request('turn/start')?.params.input[0]?.text).toBe('**编辑后发送**');
});

test('previewing keeps uploads, quoted context and structured skills attached to the raw message', async ({ page, mock }) => {
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => {
    if (request.method === 'skills/list') {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, result: { data: [{ cwd: '/workspace/demo', errors: [], skills: [{
        name: 'writer', description: '整理文档', enabled: true, path: '/test/skills/writer/SKILL.md', scope: 'user',
      }] }] } }));
    }
    return receive(socket, request);
  };
  await history(page);
  await sourceInput(page).fill('/writer');
  await page.getByRole('listbox').getByRole('option').filter({ hasText: '/writer' }).click();
  await sourceInput(page).fill('## 请分析附件\n\n保留 **原始语法**。');
  await openPreview(page);
  await page.locator('.composer input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('unsent notes') });
  await expect(page.locator('.attachment').filter({ hasText: 'notes.txt' })).toBeVisible();
  await expect(preview(page)).toBeVisible();
  await quoteHistory(page);
  await expect(preview(page)).toHaveCount(0);
  await expect(sourceInput(page)).toBeFocused();
  await expect(page.locator('.composer-token')).toContainText('writer');
  await expect(page.locator('.composer-quote')).toContainText('历史保持可读');
  await openPreview(page);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.input[0]?.text).toContain('## 请分析附件\n\n保留 **原始语法**。');
  const input = mock.request('turn/start')!.params.input;
  expect(input[0].text).toContain('notes.txt');
  expect(input).toContainEqual({ type: 'text', text: '[引用对话：已有测试历史]\n> 历史保持可读', text_elements: [] });
  expect(input).toContainEqual({ type: 'skill', name: 'writer', path: '/test/skills/writer/SKILL.md' });
});

test('draft previews reset on thread and host switches while keeping each original draft isolated', async ({ page, mock }) => {
  const other = { ...mock.threads[0], id: 'thread-other', name: '第二个会话', preview: '第二个会话' };
  mock.threads.push(other); mock.turns.set(other.id, []);
  const remote = new MockCodex(); remote.threads[0].name = '远端同 ID 会话'; remote.threads[0].preview = '远端同 ID 会话';
  mock.hosts.push({ id: 'ssh-preview', kind: 'ssh', name: '预览测试主机', cwd: '/workspace/demo' });
  mock.hostMocks.set('ssh-preview', remote);
  await history(page);
  await sourceInput(page).fill('# 本机原会话草稿');
  await openPreview(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: '第二个会话' }).click();
  await expect(sourceInput(page)).toBeVisible();
  await expect(sourceInput(page)).toHaveValue('');
  await sourceInput(page).fill('**第二个草稿**');
  await openPreview(page);
  await page.locator('[data-section="recent"] [data-host-id="ssh-preview"] .thread-row').click();
  await expect(sourceInput(page)).toBeVisible();
  await expect(sourceInput(page)).toHaveValue('');
  await sourceInput(page).fill('远端 *独立草稿*');
  await openPreview(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: '已有测试历史' }).click();
  await expect(sourceInput(page)).toBeVisible();
  await expect(sourceInput(page)).toHaveValue('# 本机原会话草稿');
  await expect(preview(page)).toHaveCount(0);
  expect(mock.request('turn/start')).toBeUndefined();
  expect(remote.request('turn/start')).toBeUndefined();
});

test('the preview is bounded without truncating the editable draft or sending partial content', async ({ page, mock }) => {
  const source = '# 长草稿\n\n' + 'a'.repeat(100_100) + '\n\n保留全文结尾';
  await login(page);
  await sourceInput(page).fill(source);
  await openPreview(page);
  await expect(preview(page)).toContainText('仅预览前 100,000 个字符');
  await expect(preview(page)).not.toContainText('保留全文结尾');
  expect(await preview(page).evaluate(element => element.clientHeight)).toBeLessThanOrEqual(210);
  await page.getByRole('button', { name: '编辑 Markdown', exact: true }).click();
  expect(await readComposerClipboardSource(sourceInput(page))).toBe(source);
  await openPreview(page);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.input[0]?.text).toBe(source);
});

test('a running turn accepts raw Markdown steering from the preview', async ({ page, mock }) => {
  mock.holdFinalMessage = true;
  await history(page);
  await sourceInput(page).fill('开始执行');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  const source = '### 追加要求\n\n- **保留格式**';
  await sourceInput(page).fill(source);
  await openPreview(page);
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await expect.poll(() => mock.request('turn/steer')?.params.input[0]?.text).toBe(source);
});

test('queue delivery from a preview submits the Markdown source without starting or steering a turn', async ({ page, mock }) => {
  const methods = {
    add: ['threadId', 'input', 'clientUserMessageId'], list: ['threadId', 'limit', 'cursor'],
    update: ['threadId', 'queuedSubmissionId', 'input'], delete: ['threadId', 'queuedSubmissionId'],
    reorder: ['threadId', 'queuedSubmissionIds'], start: ['threadId', 'queuedSubmissionId'],
  };
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: {
    status: 'known', checkedAt: Date.now(), methods: {
      ...Object.fromEntries(Object.entries(methods).map(([name, params]) => [`thread/queue/${name}`, { available: true, params, required: ['threadId'] }])),
      'thread/settings/update': { available: true, params: ['threadId', 'cwd', 'model', 'effort', 'sandboxPolicy', 'approvalPolicy', 'collaborationMode'], required: ['threadId'] },
    },
  } }));
  mock.turns.get('thread-existing')!.push({ id: 'preview-running', status: 'inProgress', items: [], itemsView: 'full', error: null });
  const items: any[] = [];
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => {
    if (request.method === 'thread/settings/update' || request.method?.startsWith('thread/queue/')) {
      mock.requests.push(request);
      let result: any = {};
      if (request.method === 'thread/queue/list') result = { data: items, nextCursor: null };
      if (request.method === 'thread/queue/add') {
        const item = { id: 'preview-queued', input: request.params.input, clientUserMessageId: request.params.clientUserMessageId };
        items.push(item); result = { queuedSubmission: item };
      }
      return socket.send(JSON.stringify({ id: request.id, result }));
    }
    return receive(socket, request);
  };
  await history(page);
  await expect.poll(() => mock.request('thread/queue/list')?.method).toBe('thread/queue/list');
  await page.getByRole('combobox', { name: '消息发送方式' }).selectOption('queue');
  const source = '## 下一轮\n\n- 保留 **Markdown** 源码';
  await sourceInput(page).fill(source);
  await openPreview(page);
  await page.getByRole('button', { name: '加入下一轮队列', exact: true }).click();
  await expect.poll(() => mock.request('thread/queue/add')?.params.input[0]?.text).toBe(source);
  await expect(sourceInput(page)).toBeVisible();
  await expect(sourceInput(page)).toHaveValue('');
  expect(mock.request('turn/start')).toBeUndefined();
  expect(mock.request('turn/steer')).toBeUndefined();
});

test('a failed preview send keeps the source intact for editing and retry', async ({ page, mock }) => {
  await history(page);
  const source = '### 失败后保留\n\n**完整草稿**';
  await sourceInput(page).fill(source);
  await openPreview(page);
  mock.failTurnStartNext = true;
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Test turn start failed', { exact: true }).first()).toBeVisible();
  await expect(preview(page)).toBeVisible();
  await page.getByRole('button', { name: '编辑 Markdown', exact: true }).click();
  await expect(sourceInput(page)).toHaveValue(source);
  await openPreview(page);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(2);
  expect(mock.request('turn/start')?.params.input[0]?.text).toBe(source);
  await expect(sourceInput(page)).toHaveValue('');
});

for (const width of [320, 390]) {
  test(`mobile ${width}px dark preview stays scrollable and can return to editable source`, async ({ page }) => {
    await page.setViewportSize({ width, height: 480 });
    await page.addInitScript(() => localStorage.setItem('codex.theme', 'dark'));
    await login(page);
    const source = '# 手机草稿\n\n' + '- 列表中的 **重点**\n'.repeat(20);
    await sourceInput(page).fill(source);
    await openPreview(page);
    await expect(preview(page)).toBeVisible();
    const box = await preview(page).boundingBox();
    expect(box!.height).toBeLessThanOrEqual(210);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await preview(page).evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await page.locator('.composer-area').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport();
    await page.setViewportSize({ width, height: 320 });
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: '编辑 Markdown', exact: true })).toBeInViewport();
    await page.screenshot({ path: `.data/composer-markdown-mobile-${width}.png` });
    await page.getByRole('button', { name: '编辑 Markdown', exact: true }).click();
    await expect(sourceInput(page)).toBeFocused();
    expect(await readComposerClipboardSource(sourceInput(page))).toBe(source);
    await sourceInput(page).press('Escape');
  });
}
