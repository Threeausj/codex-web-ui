import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const sourceId = 'thread-existing';
const capabilities = { status: 'known', checkedCliVersion: '0.165.0', methods: {
  'thread/fork': { available: true, params: ['threadId', 'attachToSource', 'excludeTurns', 'deferGoalContinuation'], required: ['threadId'] },
  'thread/list': { available: true, params: ['attachedToThreadId', 'cursor', 'limit', 'modelProviders', 'archived'], required: [] },
} };
async function wire(page: Page, mock: MockCodex, hostId = 'local') {
  const controls = { supported: true, goal: null as any, ephemeral: false, goalError: '', children: [] as any[], archived: [] as any[], hold: false, uncertain: false, release: undefined as (() => void) | undefined };
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: controls.supported ? capabilities : { status: 'unknown', methods: {} } }));
  const original = (mock as any).receive.bind(mock);
  let count = 0;
  (mock as any).receive = (socket: any, request: any) => {
    const p = request.params || {};
    const reply = (result: any) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'thread/list' && p.attachedToThreadId) return reply({ data: p.archived ? controls.archived : controls.children, nextCursor: null });
    if (request.method === 'thread/goal/get') {
      if (!controls.goalError) return reply({ goal: controls.goal });
      mock.requests.push(request); return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: controls.goalError } }));
    }
    if (request.method === 'thread/read' && p.threadId === sourceId) return reply({ thread: { ...mock.threads[0], ephemeral: controls.ephemeral } });
    if (request.method === 'thread/fork' && p.attachToSource) {
      const finish = () => {
        const thread = { ...mock.threads[0], id: `attached-${++count}`, name: `附属测试分支 ${count}`, ephemeral: false, forkedFromId: sourceId, hostId };
        controls.children.push(thread);
        mock.turns.set(thread.id, structuredClone(mock.turns.get(sourceId) || []));
        if (controls.uncertain) {
          mock.requests.push(request);
          socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: '创建结果未知', data: { uncertain: true } } }));
        } else reply({ thread });
      };
      if (controls.hold) controls.release = finish; else finish();
      return;
    }
    const child = [...controls.children, ...controls.archived].find(entry => entry.id === p.threadId);
    if (child && ['thread/read', 'thread/resume'].includes(request.method)) return reply({ thread: child, model: mock.config.model, reasoningEffort: 'medium' });
    if (child && request.method === 'thread/name/set') { child.name = p.name; return reply({}); }
    if (child && request.method === 'thread/delete') {
      controls.children = controls.children.filter(entry => entry.id !== child.id);
      controls.archived = controls.archived.filter(entry => entry.id !== child.id);
      return reply({});
    }
    if (child && request.method === 'thread/unarchive') {
      controls.archived = controls.archived.filter(entry => entry.id !== child.id); controls.children.push(child); return reply({ thread: child });
    }
    return original(socket, request);
  };
  return controls;
}
async function open(page: Page, hostId = 'local') {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"] .thread-row`).filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.getByRole('button', { name: '附属分支…', exact: true }).click();
  return page.getByRole('dialog', { name: '附属分支', exact: true });
}

for (const width of [1440, 390]) test(`${width}px attached branches can be created, renamed, deleted and explicitly opened without starting a model turn`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 900 });
  const controls = await wire(page, mock); await login(page);
  const panel = await open(page);
  await expect(panel).toContainText('删除原对话前，需要先删除全部附属分支');
  await expect(panel.getByText('还没有附属分支', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '新建附属分支', exact: true }).click();
  await expect(panel.getByRole('button', { name: '附属测试分支 1', exact: true })).toBeVisible();
  expect(mock.request('thread/fork')?.params).toEqual({ threadId: sourceId, attachToSource: true, excludeTurns: true });
  expect(mock.request('thread/goal/get')?.params).toEqual({ threadId: sourceId });
  expect(controls.children).toHaveLength(1);
  await panel.getByRole('button', { name: '重命名 附属测试分支 1', exact: true }).click();
  await panel.getByRole('textbox', { name: '附属分支名称', exact: true }).fill('独立附属记录');
  await panel.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(panel.getByRole('button', { name: '独立附属记录', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '删除 独立附属记录', exact: true }).click();
  await panel.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(panel.getByText('还没有附属分支', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '新建附属分支', exact: true }).click();
  await panel.getByRole('button', { name: '附属测试分支 2', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.main-header h1')).toHaveText('附属测试分支 2');
  expect(mock.request('thread/resume')?.params.threadId).toBe('attached-2');
  for (const method of ['turn/start', 'turn/steer', 'turn/interrupt', 'thread/goal/set', 'thread/goal/clear']) expect(mock.request(method)).toBeUndefined();
});

for (const invalid of ['unknown capability', 'source goal', 'ephemeral source', 'unreadable goal']) test(`attached fork refuses ${invalid} before mutation`, async ({ page, mock }) => {
  const controls = await wire(page, mock);
  if (invalid === 'unknown capability') controls.supported = false;
  if (invalid === 'source goal') controls.goal = { objective: '持续推进', status: 'active' };
  if (invalid === 'ephemeral source') controls.ephemeral = true;
  if (invalid === 'unreadable goal') controls.goalError = 'Goal 状态无法确认';
  await login(page); const panel = await open(page);
  if (controls.supported) {
    await expect(panel.getByText('还没有附属分支', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '新建附属分支', exact: true }).click();
  }
  await expect(panel.getByRole('alert')).toContainText(invalid === 'unknown capability' ? '更新并重启' : invalid === 'source goal' ? '包含 Goal' : invalid === 'ephemeral source' ? '已保存' : 'Goal 状态无法确认');
  expect(mock.request('thread/fork')).toBeUndefined();
  expect(mock.request('thread/goal/clear')).toBeUndefined();
});

test('a closed manager does not jump to its delayed fork after a different conversation is selected', async ({ page, mock }) => {
  const controls = await wire(page, mock); controls.hold = true;
  mock.threads.push({ ...mock.threads[0], id: 'different-conversation', name: '继续阅读另一会话' });
  await login(page); const panel = await open(page);
  await expect(panel.getByText('还没有附属分支', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '新建附属分支', exact: true }).click();
  await expect.poll(() => !!controls.release).toBe(true);
  await panel.getByRole('button', { name: '关闭附属分支', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '继续阅读另一会话' }).click();
  controls.release!();
  await expect.poll(() => controls.children.length).toBe(1);
  await expect(page.locator('.main-header h1')).toHaveText('继续阅读另一会话');
  expect(mock.request('thread/resume')?.params.threadId).toBe('different-conversation');
});

test('archived attached branches remain discoverable and can be restored before opening', async ({ page, mock }) => {
  const controls = await wire(page, mock);
  controls.archived.push({ ...mock.threads[0], id: 'attached-archived', name: '已归档的附属记录', ephemeral: false });
  mock.turns.set('attached-archived', structuredClone(mock.turns.get(sourceId)!));
  await login(page); const panel = await open(page);
  await panel.getByLabel('已归档', { exact: true }).check();
  await panel.getByRole('button', { name: '已归档的附属记录', exact: true }).click();
  await expect(page.locator('.main-header h1')).toHaveText('已归档的附属记录');
  expect(mock.request('thread/unarchive')?.params).toEqual({ threadId: 'attached-archived' });
});

test('an uncertain attached fork is not repeated until a successful read confirms the hidden branch list', async ({ page, mock }) => {
  const controls = await wire(page, mock); controls.uncertain = true;
  await login(page); const panel = await open(page);
  await expect(panel.getByText('还没有附属分支', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '新建附属分支', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('勿重复创建');
  await expect(panel.getByRole('button', { name: '新建附属分支', exact: true })).toBeDisabled();
  expect(mock.requests.filter(request => request.method === 'thread/fork')).toHaveLength(1);
  await panel.getByRole('button', { name: '刷新附属分支', exact: true }).click();
  await expect(panel.getByRole('button', { name: '附属测试分支 1', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '新建附属分支', exact: true })).toBeEnabled();
  expect(mock.requests.filter(request => request.method === 'thread/fork')).toHaveLength(1);
});

test('attached branches on a remote host use only that host and preserve the local conversation', async ({ page, mock }) => {
  const remote = new MockCodex();
  mock.hosts.push({ id: 'attached-remote', kind: 'ssh', name: '附属分支主机', hostname: 'attached.fixture.test' });
  mock.hostMocks.set('attached-remote', remote);
  await wire(page, remote, 'attached-remote');
  await login(page); const panel = await open(page, 'attached-remote');
  await expect(panel.getByText('还没有附属分支', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '新建附属分支', exact: true }).click();
  await expect(panel.getByRole('button', { name: '附属测试分支 1', exact: true })).toBeVisible();
  expect(remote.request('thread/fork')?.params.attachToSource).toBe(true);
  expect(mock.request('thread/fork')).toBeUndefined();
  expect(remote.request('turn/start')).toBeUndefined();
});
