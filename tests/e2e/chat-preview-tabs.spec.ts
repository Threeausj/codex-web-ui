import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const editor = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const strip = (page: Page) => page.getByRole('tablist', { name: '聊天标签页', exact: true });
const tab = (page: Page, title: string) => strip(page).getByRole('tab', { name: title, exact: true });
const row = (page: Page, title: string, hostId = 'local') =>
  page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"] .thread-row`).filter({ hasText: title }).first();
async function revealSidebar(page: Page) {
  const toggle = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await toggle.isVisible() && !await page.locator('.sidebar').evaluate(element => element.classList.contains('mobile-open')))
    await toggle.click();
}
async function preview(page: Page, title: string, hostId = 'local') {
  await revealSidebar(page);
  await row(page, title, hostId).click();
  await expect(tab(page, title)).toHaveAttribute('aria-selected', 'true');
  await expect(editor(page)).toBeEnabled();
}
function add(mock: MockCodex, id: string, title: string) {
  mock.threads.push({ ...mock.threads[0]!, id, name: title, preview: title, status: { type: 'idle' } });
  mock.turns.set(id, [{ id: `turn-${id}`, status: 'completed', itemsView: 'full', error: null,
    items: [{ id: `answer-${id}`, type: 'agentMessage', text: `${title}的正文` }] }]);
}
async function storedTabs(page: Page) {
  return page.evaluate(() => new Promise<{ hostId: string; threadId: string; title: string }[]>((resolve, reject) => {
    const open = indexedDB.open('codex-private-work', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('records')) { db.close(); resolve([]); return; }
      const read = db.transaction('records').objectStore('records').getAll();
      read.onsuccess = () => {
        db.close();
        const stored = read.result.find(record => { try { return JSON.parse(record.key)[1] === 'chat-tabs'; } catch { return false; } });
        resolve(stored?.value?.entries || []);
      };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }));
}
function untouched(mock: MockCodex) {
  expect(mock.requests.filter(request => ['turn/start', 'turn/interrupt', 'thread/archive', 'thread/delete', 'thread/unsubscribe'].includes(request.method || ''))).toEqual([]);
}

test('single-click conversations reuse one temporary tab and keep separate drafts without persisting navigation tabs', async ({ page, mock }) => {
  add(mock, 'preview-second', '临时查看第二条');
  await login(page); await preview(page, '已有测试历史');
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(1);
  await editor(page).fill('第一条临时会话的未发草稿');
  await preview(page, '临时查看第二条');
  await expect(strip(page).getByRole('tab')).toHaveCount(1);
  await expect(tab(page, '已有测试历史')).toHaveCount(0);
  await editor(page).fill('第二条临时会话的未发草稿');
  await preview(page, '已有测试历史');
  await expect(editor(page)).toHaveValue('第一条临时会话的未发草稿');
  await preview(page, '临时查看第二条');
  await expect(editor(page)).toHaveValue('第二条临时会话的未发草稿');
  await expect(strip(page).getByRole('tab')).toHaveCount(1);
  expect(await storedTabs(page)).toEqual([]);
  expect(mock.sockets).toHaveLength(1);
  untouched(mock);
});

test('double-clicking a sidebar conversation keeps it while native history is still loading', async ({ page, mock }) => {
  add(mock, 'kept-sidebar', '双击保留的聊天');
  const receive = (mock as any).receive.bind(mock);
  const held: { socket: any; request: any }[] = [];
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/resume' && request.params?.threadId === 'kept-sidebar') {
      held.push({ socket, request }); return;
    }
    return receive(socket, request);
  };
  await login(page);
  await row(page, '双击保留的聊天').dblclick();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await expect(tab(page, '双击保留的聊天')).toHaveAttribute('aria-selected', 'true');
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(0);
  await expect.poll(() => storedTabs(page)).toEqual([{ hostId: 'local', threadId: 'kept-sidebar', title: '双击保留的聊天', pinned: false, lastOpened: expect.any(Number) }]);
  for (const entry of held.splice(0)) receive(entry.socket, entry.request);
  await expect(editor(page)).toBeEnabled();
  await preview(page, '已有测试历史');
  await expect(strip(page).getByRole('tab')).toHaveCount(2);
  await expect(tab(page, '双击保留的聊天')).toHaveAttribute('aria-selected', 'false');
  untouched(mock);
});

test('double-clicking the temporary tab makes it durable, and later previews never replace durable tabs', async ({ page, mock }) => {
  add(mock, 'preview-second', '第二条预览'); add(mock, 'preview-third', '第三条预览');
  await login(page); await preview(page, '已有测试历史');
  await tab(page, '已有测试历史').dblclick();
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(0);
  await expect.poll(async () => (await storedTabs(page)).map(entry => entry.threadId)).toEqual(['thread-existing']);
  await preview(page, '第二条预览');
  await expect(strip(page).getByRole('tab')).toHaveCount(2);
  await preview(page, '第三条预览');
  await expect(tab(page, '第二条预览')).toHaveCount(0);
  await expect(tab(page, '已有测试历史')).toHaveCount(1);
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(1);
  expect((await storedTabs(page)).map(entry => entry.threadId)).toEqual(['thread-existing']);
  await page.screenshot({ path: '.data/chat-preview-and-kept-tabs-desktop.png' });
  await tab(page, '第三条预览').dblclick();
  await expect.poll(async () => (await storedTabs(page)).map(entry => entry.threadId)).toEqual(['thread-existing', 'preview-third']);
  await page.reload();
  await expect(tab(page, '已有测试历史')).toBeVisible();
  await expect(tab(page, '第三条预览')).toBeVisible();
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(0);
  untouched(mock);
});

test('phone users can keep a preview from its menu without a double-click gesture', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  add(mock, 'phone-preview', '手机临时查看');
  await login(page); await preview(page, '已有测试历史');
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.locator('.thread-menu').getByRole('button', { name: '保留在标签栏', exact: true }).click();
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(0);
  await expect.poll(async () => (await storedTabs(page)).map(entry => entry.threadId)).toEqual(['thread-existing']);
  await preview(page, '手机临时查看');
  await expect(tab(page, '已有测试历史')).toHaveCount(1);
  await expect(strip(page).getByRole('tab')).toHaveCount(2);
  await expect(tab(page, '手机临时查看')).toBeInViewport();
  untouched(mock);
});

test('temporary tabs remain scoped to the selected host and do not interrupt a running chat', async ({ page, mock }) => {
  const remote = new MockCodex();
  remote.threads[0]!.name = remote.threads[0]!.preview = '远端临时查看';
  remote.turns.get('thread-existing')![0].items[1].text = '远端会话正文';
  mock.hosts.push({ id: 'preview-remote', name: '预览远端', kind: 'ssh', hostname: 'fixture.invalid' });
  mock.hostMocks.set('preview-remote', remote);
  mock.threads[0]!.status = { type: 'active' };
  mock.turns.get('thread-existing')![0].status = 'inProgress';
  await login(page); await preview(page, '已有测试历史');
  await editor(page).fill('运行中本机会话草稿');
  await preview(page, '远端临时查看', 'preview-remote');
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(1);
  await expect(strip(page).getByRole('tab')).toHaveCount(1);
  await expect(page.locator('.agent-message')).toContainText('远端会话正文');
  await editor(page).fill('远端临时会话草稿');
  await preview(page, '已有测试历史');
  await expect(editor(page)).toHaveValue('运行中本机会话草稿');
  await expect(strip(page).getByRole('tab')).toHaveCount(1);
  expect(await storedTabs(page)).toEqual([]);
  expect(mock.sockets).toHaveLength(1); expect(remote.sockets).toHaveLength(1);
  untouched(mock); untouched(remote);
});

test('closing an active preview returns to its kept neighbor without interrupting work', async ({ page, mock }) => {
  add(mock, 'closing-preview', '关闭临时查看');
  mock.threads.find(thread => thread.id === 'closing-preview')!.status = { type: 'active' };
  mock.turns.get('closing-preview')![0].status = 'inProgress';
  await login(page); await preview(page, '已有测试历史');
  await tab(page, '已有测试历史').dblclick();
  await editor(page).fill('保留标签的草稿');
  await preview(page, '关闭临时查看');
  await editor(page).fill('被关闭的临时会话草稿');
  await page.getByRole('button', { name: '关闭标签页：关闭临时查看', exact: true }).click();
  await expect(tab(page, '关闭临时查看')).toHaveCount(0);
  await expect(tab(page, '已有测试历史')).toHaveAttribute('aria-selected', 'true');
  await expect(editor(page)).toHaveValue('保留标签的草稿');
  await preview(page, '关闭临时查看');
  await expect(editor(page)).toHaveValue('被关闭的临时会话草稿');
  expect((await storedTabs(page)).map(entry => entry.threadId)).toEqual(['thread-existing']);
  untouched(mock);
});

test('creating and sending a new chat keeps an existing preview and its independent draft', async ({ page, mock }) => {
  await login(page); await preview(page, '已有测试历史');
  await editor(page).fill('原临时会话的草稿');
  await page.getByRole('button', { name: '新建聊天标签页', exact: true }).click();
  await expect(page.locator('.welcome')).toBeVisible();
  await expect(tab(page, '新对话')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, '已有测试历史')).toHaveAttribute('aria-selected', 'false');
  await editor(page).fill('从新标签创建正式聊天');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(1);
  await expect(tab(page, '新对话')).toHaveCount(0);
  await expect(strip(page).getByRole('tab')).toHaveCount(2);
  await expect.poll(async () => (await storedTabs(page)).length).toBe(1);
  expect((await storedTabs(page)).some(entry => entry.threadId === 'thread-existing')).toBe(false);
  await tab(page, '已有测试历史').click();
  await expect(editor(page)).toHaveValue('原临时会话的草稿');
  expect(mock.request('turn/interrupt')).toBeUndefined();
});

test('project rows and search results use the same single-preview and double-keep behavior', async ({ page, mock }) => {
  add(mock, 'project-preview', '项目中的临时会话');
  add(mock, 'search-preview', '从搜索保留会话');
  await login(page);
  const projectRow = page.locator('[data-section="projects"] .thread-row').filter({ hasText: '项目中的临时会话' });
  await projectRow.click();
  await expect(tab(page, '项目中的临时会话')).toHaveAttribute('aria-selected', 'true');
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(1);
  await projectRow.dblclick();
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(0);
  await expect.poll(async () => (await storedTabs(page)).map(entry => entry.threadId)).toEqual(['project-preview']);
  await page.getByRole('textbox', { name: '搜索对话', exact: true }).fill('从搜索保留会话');
  const result = page.locator('.nav-search-results .thread-row').filter({ hasText: '从搜索保留会话' });
  await result.click();
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(1);
  await result.dblclick();
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(0);
  await expect.poll(async () => (await storedTabs(page)).map(entry => entry.threadId)).toEqual(['project-preview', 'search-preview']);
  untouched(mock);
});

test('a remote preview title appears immediately while its destination initialization is still pending', async ({ page, mock }) => {
  const remote = new MockCodex();
  remote.threads[0]!.name = remote.threads[0]!.preview = '仍在连接的远端会话';
  mock.hosts.push({ id: 'slow-preview-remote', name: '缓慢预览远端', kind: 'ssh', hostname: 'fixture.invalid' });
  mock.hostMocks.set('slow-preview-remote', remote);
  const receive = (remote as any).receive.bind(remote);
  const held: { socket: any; request: any }[] = [];
  (remote as any).receive = (socket: any, request: any) => {
    if (request.method === 'initialize') { held.push({ socket, request }); return; }
    return receive(socket, request);
  };
  await login(page); await preview(page, '已有测试历史');
  await row(page, '仍在连接的远端会话', 'slow-preview-remote').click();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await expect(tab(page, '仍在连接的远端会话')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, '已有测试历史')).toHaveCount(0);
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(1);
  await expect(editor(page)).toBeDisabled();
  expect(await storedTabs(page)).toEqual([]);
  for (const entry of held.splice(0)) receive(entry.socket, entry.request);
  await expect(editor(page)).toBeEnabled();
  await expect(strip(page).locator('.chat-tab.preview')).toHaveCount(1);
  expect(await storedTabs(page)).toEqual([]);
  untouched(mock); untouched(remote);
});
