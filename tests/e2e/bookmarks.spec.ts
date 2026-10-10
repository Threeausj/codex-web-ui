import { test, expect, login, MockCodex } from './fixtures';
import type { Page, WebSocketRoute } from '@playwright/test';
import type { ConversationBookmark } from '../../shared/bookmarks';

const workspace = '/workspace/demo';
const source = { threadId: 'thread-existing', turnId: 'turn-history', itemId: 'history-agent', text: '历史保持可读', threadName: '已有测试历史' };
const bookmark = (overrides: Partial<ConversationBookmark> = {}): ConversationBookmark => ({
  id: '00000000-0000-4000-8000-000000000001', hostId: 'local', projectPath: workspace, name: '重点结论',
  source: { ...source }, createdAt: 1791200000000, updatedAt: 1791200000000, ...overrides,
});

async function openHistory(page: Page, name = '已有测试历史') {
  if ((page.viewportSize()?.width || 1280) <= 760 && !await page.locator('.sidebar').evaluate(element => element.classList.contains('mobile-open')))
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: name }).first().click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
}
async function selectMessage(page: Page, itemId = 'history-agent') {
  const body = page.locator(`[data-selection-item-id="${itemId}"]`);
  await expect(body).toBeVisible();
  await body.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await body.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.getByRole('toolbar', { name: '所选对话内容' })).toBeVisible();
}
async function addFavorite(page: Page) {
  await selectMessage(page);
  await page.getByRole('toolbar', { name: '所选对话内容' }).getByRole('button', { name: '收藏', exact: true }).click();
  await expect(page.locator('.bookmark-name-dialog')).toBeVisible();
}
async function openPanel(page: Page, projectName = 'Demo Project') {
  if ((page.viewportSize()?.width || 1280) <= 760 && !await page.locator('.sidebar').evaluate(element => element.classList.contains('mobile-open')))
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.getByRole('button', { name: `${projectName} 项目操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '收藏对话', exact: true }).click();
  await expect(page.locator('.bookmarks-panel')).toBeVisible();
}
function expectNoModelMutation(mock: MockCodex) {
  expect(mock.requests.filter(request => ['turn/start', 'turn/steer', 'thread/revert', 'thread/delete'].includes(request.method || ''))).toHaveLength(0);
}

/** Real native paging shapes; the source turn can be outside the loaded window. */
function pagedHistory(mock: MockCodex) {
  const original = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: WebSocketRoute, request: any) => {
    if (!['thread/turns/list', 'thread/items/list'].includes(request.method)) return original(socket, request);
    mock.requests.push(request);
    const params = request.params;
    let data: any[], nextCursor: string | null;
    if (request.method === 'thread/turns/list') {
      const all = [...(mock.turns.get(params.threadId) || [])].reverse();
      const offset = Number(params.cursor || 0);
      data = all.slice(offset, offset + params.limit).map(turn => ({ ...turn, itemsView: params.itemsView,
        items: params.itemsView === 'notLoaded' ? [] : params.itemsView === 'summary'
          ? [turn.items.find((item: any) => item.type === 'userMessage'), turn.items.filter((item: any) => item.type === 'agentMessage').at(-1)].filter(Boolean) : turn.items,
      }));
      nextCursor = offset + params.limit < all.length ? String(offset + params.limit) : null;
    } else {
      const turn = (mock.turns.get(params.threadId) || []).find(turn => turn.id === params.turnId);
      const offset = Number(params.cursor || 0);
      data = (turn?.items || []).slice(offset, offset + params.limit).map((item: any) => ({ turnId: params.turnId, item }));
      nextCursor = offset + params.limit < (turn?.items.length || 0) ? String(offset + params.limit) : null;
    }
    socket.send(JSON.stringify({ id: request.id, result: { data, nextCursor } }));
  };
}
function largeHistory(mock: MockCodex, count = 100) {
  mock.turns.set('thread-existing', Array.from({ length: count }, (_, index) => ({
    id: `long-turn-${index}`, itemsView: 'full', status: 'completed', startedAt: 1791200000 + index,
    completedAt: 1791200001 + index, durationMs: 1000,
    items: [
      { id: `long-user-${index}`, type: 'userMessage', content: [{ type: 'text', text: `历史问题 ${index}` }] },
      { id: `long-agent-${index}`, type: 'agentMessage', text: `历史答复 ${index}\n${'详细说明用于观察虚拟历史定位。'.repeat(25)}`, phase: 'final_answer' },
    ],
  })));
  pagedHistory(mock);
}

test('selected conversation text asks for its first bookmark name, cancel is harmless and save preserves composer draft', async ({ page, mock }) => {
  await login(page); await openHistory(page);
  const draft = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await draft.fill('尚未发送的主对话草稿');
  await addFavorite(page);
  const name = page.getByRole('textbox', { name: '收藏名称', exact: true });
  await expect(name).toHaveValue('历史保持可读'); await expect(name).toBeFocused();
  await expect.poll(() => name.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBe('历史保持可读'.length);
  await page.locator('.bookmark-name-dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(mock.bookmarkRequests.filter(request => request.method === 'POST')).toHaveLength(0);
  await addFavorite(page); await name.fill('架构关键结论');
  await page.locator('.bookmark-name-dialog').getByRole('button', { name: '收藏', exact: true }).click();
  await expect(page.locator('.bookmark-name-dialog')).toHaveCount(0);
  await expect.poll(() => mock.bookmarks.length).toBe(1);
  expect(mock.bookmarks[0]).toMatchObject({ name: '架构关键结论', hostId: 'local', projectPath: workspace, source });
  await expect(draft).toHaveValue('尚未发送的主对话草稿'); expectNoModelMutation(mock);
});

test('failed initial save retains edited name and source, successful retry survives reload without duplicate bookmarks', async ({ page, mock }) => {
  await login(page); await openHistory(page); await addFavorite(page);
  mock.failBookmarkSaveNext = true;
  await page.getByRole('textbox', { name: '收藏名称', exact: true }).fill('重试仍保留的名称');
  const save = page.locator('.bookmark-name-dialog').getByRole('button', { name: '收藏', exact: true });
  await save.click();
  await expect(page.locator('.bookmark-name-dialog').getByRole('alert')).toContainText('模拟收藏保存失败');
  await expect(page.getByRole('textbox', { name: '收藏名称', exact: true })).toHaveValue('重试仍保留的名称');
  await expect(page.locator('.bookmark-name-excerpt')).toHaveText(source.text);
  await save.click(); await expect(page.locator('.bookmark-name-dialog')).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('textbox', { name: '消息输入框' })).toBeEnabled();
  await openPanel(page); await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await expect(page.locator('.bookmark-name')).toHaveText('重试仍保留的名称');
  expect(mock.bookmarks).toHaveLength(1); expectNoModelMutation(mock);
});

test('project bookmarks stay scoped, search across names and excerpts, and support rename and remove without changing conversations', async ({ page, mock }) => {
  mock.projects.push({ ...mock.projects[0], id: 'other-project', name: 'Other Project', path: '/workspace/other' });
  mock.bookmarks = [bookmark(), bookmark({ id: '00000000-0000-4000-8000-000000000002', name: '另一条收藏', source: { ...source, text: '支持检索的独特片段' } }),
    bookmark({ id: '00000000-0000-4000-8000-000000000003', name: '其他项目私有收藏', projectPath: '/workspace/other' })];
  await login(page); await openPanel(page);
  await expect(page.locator('.bookmark-entry')).toHaveCount(2);
  await expect(page.locator('.bookmarks-panel')).not.toContainText('其他项目私有收藏');
  const search = page.getByRole('searchbox', { name: '搜索收藏', exact: true });
  await search.fill('独特片段'); await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await expect(page.locator('.bookmark-name')).toHaveText('另一条收藏');
  await search.fill('不存在的关键字'); await expect(page.locator('.bookmarks-panel')).toContainText('没有匹配的收藏');
  await search.fill('');
  await page.getByRole('button', { name: '重命名收藏 重点结论', exact: true }).click();
  await page.getByRole('textbox', { name: '收藏名称', exact: true }).fill('重新命名的结论');
  await page.locator('.bookmark-name-dialog').getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page.getByRole('button', { name: '跳转到收藏 重新命名的结论', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消收藏 另一条收藏', exact: true }).click();
  await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await page.getByRole('button', { name: '关闭收藏对话', exact: true }).click(); await openPanel(page, 'Other Project');
  await expect(page.locator('.bookmark-entry')).toHaveCount(1); await expect(page.locator('.bookmark-name')).toHaveText('其他项目私有收藏');
  expect(mock.bookmarks).toHaveLength(2); expectNoModelMutation(mock);
});

test('opening a loaded bookmark highlights its original text without loading history or losing the unsent draft', async ({ page, mock }) => {
  mock.bookmarks = [bookmark()]; await login(page); await openHistory(page);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true }); await input.fill('保留定位前草稿');
  const reads = mock.requests.filter(request => request.method === 'thread/turns/list').length;
  await openPanel(page); await page.getByRole('button', { name: '跳转到收藏 重点结论', exact: true }).click();
  await expect(page.locator('.bookmarks-panel')).toHaveCount(0);
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toHaveClass(/bookmark-location/);
  await expect.poll(() => page.evaluate(() => (CSS as any).highlights?.get('conversation-bookmark')?.size)).toBe(1);
  expect(mock.requests.filter(request => request.method === 'thread/items/list')).toHaveLength(0);
  expect(mock.requests.filter(request => request.method === 'thread/turns/list')).toHaveLength(reads);
  await expect(input).toHaveValue('保留定位前草稿'); expectNoModelMutation(mock);
});

test('an old bookmark reads only its native turn in bounded item pages and pins its virtualized message for scrolling', async ({ page, mock }) => {
  largeHistory(mock);
  const oldest = mock.turns.get('thread-existing')![0];
  oldest.items.splice(1, 0, ...Array.from({ length: 45 }, (_, index) => ({ id: `old-command-${index}`, type: 'commandExecution', status: 'completed', command: `printf ${index}`, aggregatedOutput: 'process detail', exitCode: 0 })),
    { id: 'old-target', type: 'agentMessage', phase: 'commentary', text: '最早一轮需要回看的具体说明' });
  mock.bookmarks = [bookmark({ source: { ...source, turnId: oldest.id, itemId: 'old-target', text: '需要回看的具体说明' } })];
  await login(page); await openHistory(page);
  // More than 80 blocks activates the actual IntersectionObserver unmounting.
  await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
  await expect.poll(() => page.locator('.virtual-history-block').count()).toBe(60);
  await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
  await expect.poll(() => page.locator('.virtual-history-block').count()).toBeGreaterThan(80);
  const summaryReads = mock.requests.filter(request => request.method === 'thread/turns/list').length;
  await openPanel(page); await page.getByRole('button', { name: '跳转到收藏 重点结论', exact: true }).click();
  const target = page.locator('[data-selection-item-id="old-target"]');
  await expect(target).toHaveClass(/bookmark-location/); await expect(target).toBeInViewport();
  const pages = mock.requests.filter(request => request.method === 'thread/items/list');
  expect(pages).toHaveLength(2); expect(pages.map(request => request.params.turnId)).toEqual([oldest.id, oldest.id]);
  expect(pages.map(request => request.params.cursor)).toEqual([null, '40']);
  expect(pages.every(request => request.params.limit === 40)).toBe(true);
  expect(mock.requests.filter(request => request.method === 'thread/turns/list')).toHaveLength(summaryReads);
  expect(mock.requests.filter(request => request.method === 'thread/turns/list' && request.params.itemsView === 'full')).toHaveLength(0);
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(target).toHaveCount(1);
  // The normal pager later reaches this detached turn. It must merge the
  // bookmark message once and restore the original chronological position.
  await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
  await expect.poll(() => page.locator('.virtual-history-block').count()).toBe(100);
  const chronology = await page.locator('.virtual-history-block').evaluateAll(elements => elements.map(element => element.getAttribute('data-history-id')));
  expect(chronology.slice(0, 3)).toEqual(['long-turn-0', 'long-turn-1', 'long-turn-2']);
  await expect(target).toHaveCount(1); expectNoModelMutation(mock);
});

test('a bookmark from another host opens that conversation and never resolves an identical local thread or item id', async ({ page, mock }) => {
  const remote = new MockCodex(); remote.threads[0]!.name = '远程项目历史'; remote.turns.get(source.threadId)![0].items[1].text = '远程专属收藏原文';
  mock.hosts.push({ id: 'ssh-bookmark', name: '远程服务器', kind: 'ssh', hostname: 'remote.invalid', cwd: workspace });
  mock.projects.push({ ...mock.projects[0], id: 'remote-project', hostId: 'ssh-bookmark', name: 'Remote Project' }); mock.hostMocks.set('ssh-bookmark', remote);
  mock.bookmarks = [bookmark({ hostId: 'ssh-bookmark', name: '远程收藏', source: { ...source, text: '远程专属收藏原文', threadName: '远程项目历史' } })];
  await login(page); await openHistory(page); await openPanel(page, 'Remote Project');
  await page.getByRole('button', { name: '跳转到收藏 远程收藏', exact: true }).click();
  await expect(page.locator('.bookmarks-panel')).toHaveCount(0);
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toContainText('远程专属收藏原文');
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toHaveClass(/bookmark-location/);
  expect(remote.request('thread/resume')?.params.threadId).toBe(source.threadId);
  expectNoModelMutation(mock); expectNoModelMutation(remote);
});

test('a removed source message reports the missing location and retains the bookmark excerpt for later recovery', async ({ page, mock }) => {
  pagedHistory(mock); mock.bookmarks = [bookmark({ source: { ...source, turnId: 'deleted-turn', itemId: 'deleted-item' } })];
  await login(page); await openHistory(page); await openPanel(page);
  await page.getByRole('button', { name: '跳转到收藏 重点结论', exact: true }).click();
  await expect(page.locator('.bookmarks-panel').getByRole('alert')).toContainText('未找到收藏的原消息');
  await expect(page.locator('.bookmark-entry')).toContainText(source.text);
  await expect(page.getByRole('button', { name: '跳转到收藏 重点结论', exact: true })).toBeEnabled();
  expect(mock.bookmarks).toHaveLength(1); expectNoModelMutation(mock);
});

test('reopening a detached old bookmark checks the native source again instead of accepting a deleted cached fragment', async ({ page, mock }) => {
  largeHistory(mock, 40);
  const oldest = mock.turns.get(source.threadId)![0];
  const target = oldest.items[1];
  mock.bookmarks = [bookmark({ source: { ...source, turnId: oldest.id, itemId: target.id, text: target.text } })];
  await login(page); await openHistory(page); await openPanel(page);
  await page.getByRole('button', { name: '跳转到收藏 重点结论', exact: true }).click();
  await expect(page.locator(`[data-selection-item-id="${target.id}"]`)).toHaveClass(/bookmark-location/);
  oldest.items.splice(1, 1);
  await openPanel(page); await page.getByRole('button', { name: '跳转到收藏 重点结论', exact: true }).click();
  await expect(page.locator('.bookmarks-panel').getByRole('alert')).toContainText('未找到收藏的原消息');
  expect(mock.requests.filter(request => request.method === 'thread/items/list')).toHaveLength(2);
  expect(mock.bookmarks).toHaveLength(1); expectNoModelMutation(mock);
});

test('a truncated cached message is replaced by its native source before highlighting the saved quotation', async ({ page, mock }) => {
  const item = mock.turns.get(source.threadId)![0].items[1];
  item.text = '此前只缓存了消息的开头'; item.cacheTruncated = true;
  pagedHistory(mock);
  mock.bookmarks = [bookmark({ source: { ...source, text: '重新读取后的完整收藏内容' } })];
  await login(page); await openHistory(page);
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toContainText('此前只缓存了消息的开头');
  item.text = '原始完整答复中包含重新读取后的完整收藏内容和后续说明'; delete item.cacheTruncated;
  await openPanel(page); await page.getByRole('button', { name: '跳转到收藏 重点结论', exact: true }).click();
  await expect(page.locator('.bookmarks-panel')).toHaveCount(0);
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toContainText('重新读取后的完整收藏内容');
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toHaveClass(/bookmark-location/);
  expect(mock.requests.filter(request => request.method === 'thread/items/list')).toHaveLength(1);
  expectNoModelMutation(mock);
});

test('360px dark mode fits all selection actions and mobile Back closes naming then bookmarks without leaving the conversation', async ({ page, mock }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.addInitScript(() => localStorage.setItem('codex.theme', 'dark'));
  mock.bookmarks = [bookmark()]; await login(page); await openHistory(page); await selectMessage(page);
  const toolbar = page.getByRole('toolbar', { name: '所选对话内容' });
  await expect(toolbar.getByRole('button')).toHaveCount(3);
  const bounds = await toolbar.boundingBox(); expect(bounds).toBeTruthy();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(780);
  await toolbar.getByRole('button', { name: '收藏', exact: true }).click();
  await expect(page.locator('.bookmark-name-dialog')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.codexMobilePanel))).toBe(true);
  await page.evaluate(() => history.back()); await expect(page.locator('.bookmark-name-dialog')).toHaveCount(0);
  await expect(page.getByText(source.text, { exact: true }).first()).toBeVisible();
  const url = page.url(); await openPanel(page);
  await page.getByRole('button', { name: '重命名收藏 重点结论', exact: true }).click();
  await expect(page.locator('.bookmark-name-dialog')).toBeVisible();
  await page.evaluate(() => history.back()); await expect(page.locator('.bookmark-name-dialog')).toHaveCount(0);
  await expect(page.locator('.bookmarks-panel')).toBeVisible();
  await page.evaluate(() => history.back()); await expect(page.locator('.bookmarks-panel')).toHaveCount(0);
  expect(page.url()).toBe(url); expect(mock.bookmarks[0]!.name).toBe('重点结论');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); expectNoModelMutation(mock);
});
