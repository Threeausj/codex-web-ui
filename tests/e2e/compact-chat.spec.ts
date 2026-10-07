import { test, expect, login } from './fixtures';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=', 'base64');

test('local PNG attachments display inline on phones and missing images retain an open-file fallback', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  await page.route('**/api/hosts/*/images?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path')!; requests.push(path);
    return path.includes('missing') ? route.fulfill({ status: 404, json: { error: 'File not found' } }) : route.fulfill({ contentType: 'image/png', body: png });
  });
  mock.turns.get('thread-existing')![0].items[0].content.push({ type: 'localImage', path: '/.codex-web-uploads/test/image.png' }, { type: 'localImage', path: '/.codex-web-uploads/test/missing.png' });
  await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const image = page.locator('.conversation-image img');
  await expect(image).toHaveCount(1); await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  await expect(page.getByRole('button', { name: '查看图片 missing.png', exact: true })).toContainText('图片无法加载');
  const layout = await image.evaluate(element => ({ right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width }));
  expect(layout.right).toBeLessThanOrEqual(390); expect(layout.width).toBeLessThanOrEqual(360);
  expect(requests).toEqual(expect.arrayContaining(['/.codex-web-uploads/test/image.png', '/.codex-web-uploads/test/missing.png']));
  expect(mock.request('turn/start')).toBeUndefined();
});

test('tool output is a compact expandable row and changes expose counts, filename filtering, and independent previews', async ({ page, mock }) => {
  mock.turns.get('thread-existing')![0].items.splice(1, 0,
    { id: 'compact-command', type: 'commandExecution', command: 'printf compact', aggregatedOutput: 'compact output', exitCode: 0, status: 'completed' },
    { id: 'compact-change', type: 'fileChange', changes: [{ path: '/workspace/demo/alpha.ts', kind: 'update', diff: '--- a/alpha.ts\n+++ b/alpha.ts\n@@ -1 +1,2 @@\n-before\n+after\n+extra' }, { path: '/workspace/demo/beta.md', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }] });
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await page.locator('.turn-activity > summary').click();
  await page.locator('.activity-batch > summary').click();
  const row = page.locator('.tool-item').filter({ hasText: 'printf compact' });
  await expect(row.locator('.tool-content')).toBeHidden();
  const appearance = await row.evaluate(element => ({ border: getComputedStyle(element).borderTopWidth, height: element.getBoundingClientRect().height }));
  expect(appearance.border).toBe('0px'); expect(appearance.height).toBeLessThanOrEqual(40);
  await row.locator('summary').click(); await expect(row.locator('.tool-content')).toContainText('compact output');
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.locator('.workspace-tabs').getByRole('button', { name: /^变更/ }).click();
  const changes = page.locator('.change-card'); await expect(changes).toHaveCount(2);
  await expect(changes.first().locator('.diff-count-add')).toHaveText('+2');
  await expect(changes.first().locator('.diff-count-remove')).toHaveText('−1');
  await expect(changes.first().locator('.diff-code')).toBeHidden();
  await page.getByRole('textbox', { name: '搜索变更文件名', exact: true }).fill('BETA');
  await expect(changes).toHaveCount(1); await expect(changes).toContainText('beta.md');
  await page.getByRole('textbox', { name: '搜索变更文件名', exact: true }).fill('absent');
  await expect(page.getByText('没有匹配的变更文件', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除变更搜索', exact: true }).click(); await expect(changes).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath('compact-chat-preview.png'), fullPage: true });
  const colors = await changes.first().evaluate(element => ({ add: getComputedStyle(element.querySelector('.diff-count-add')!).color, remove: getComputedStyle(element.querySelector('.diff-count-remove')!).color }));
  expect(colors.add).not.toBe(colors.remove);
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索文件名', exact: true }).fill('readme');
  await expect(page.locator('.file-tree-entry')).toHaveCount(1); await expect(page.locator('.file-tree-entry')).toContainText('README.md');
});

test('session close keeps other sessions connected and survives refresh until explicit reconnect', async ({ page, mock }) => {
  let released = false; const mutations: any[] = [];
  const runtime = () => ({ connected: true, paused: false, managed: true, loadedThreadCount: released ? 1 : 2, activeThreadCount: 0, processes: [{ pid: 1234, role: 'app-server', local: true }], threads: [{ id: 'thread-existing', name: '已有测试历史', pid: released ? undefined : 1234, released, loaded: !released, active: false }, { id: 'other-session', name: '其他任务', pid: 1234, released: false, loaded: true, active: true }] });
  await page.route(/\/api\/hosts\/local\/resources(?:\?|$)/, route => route.fulfill({ json: { hostId: 'local', sampledAt: Date.now(), runtime: runtime() } }));
  await page.route('**/api/hosts/local/runtime/threads/thread-existing/*', route => {
    released = route.request().url().endsWith('/close'); mock.runtimeReleasedThreads = released ? [{ hostId: 'local', threadId: 'thread-existing' }] : []; mutations.push({ action: released ? 'close' : 'resume', body: route.request().postDataJSON() });
    mock.emit('bridge/status', { connected: true, paused: false, hostId: 'local', releasedThreadIds: released ? ['thread-existing'] : [], mode: 'spawn', activeProcesses: [] });
    return route.fulfill({ json: { ok: true, runtime: runtime() } });
  });
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('会话关闭后保留草稿');
  await page.locator('.resources-button').click();
  const panel = page.getByRole('dialog', { name: '资源管理', exact: true });
  const session = panel.locator('.runtime-thread').filter({ hasText: '已有测试历史' });
  await expect(session).toContainText('PID 1234');
  page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '关闭会话 已有测试历史', exact: true }).click();
  await expect(session).toContainText('已关闭'); await expect(panel.locator('.runtime-thread').filter({ hasText: '其他任务' })).toContainText('PID 1234');
  await panel.getByRole('button', { name: '关闭资源管理', exact: true }).click();
  await expect(page.locator('.connection-banner').filter({ hasText: '此会话的 Web 连接已关闭' })).toContainText('此会话的 Web 连接已关闭');
  const count = mock.requests.filter(request => request.method === 'thread/resume').length;
  await page.reload();
  await expect(page.locator('.connection-banner').filter({ hasText: '此会话的 Web 连接已关闭' })).toContainText('此会话的 Web 连接已关闭');
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(count);
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('会话关闭后保留草稿');
  await page.getByRole('button', { name: '重新连接会话', exact: true }).click();
  await expect(page.locator('.connection-banner').filter({ hasText: '此会话的 Web 连接已关闭' })).not.toBeVisible();
  expect(mutations).toEqual([{ action: 'close', body: { confirmed: true } }, { action: 'resume', body: {} }]);
  await expect.poll(() => mock.requests.filter(request => request.method === 'thread/resume').length).toBeGreaterThan(count);
});
