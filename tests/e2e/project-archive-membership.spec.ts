import { test, expect, login, MockCodex } from './fixtures';

const source = '/workspace/demo';
const destination = '/workspace/destination';
const row = (page: any, hostId = 'local') => page.locator(`.nav-project-group[data-host-id="${hostId}"][data-project-path="${source}"] .project-row`).first();
async function archive(page: any, hostId = 'local') {
  await row(page, hostId).click({ button: 'right' });
  page.once('dialog', (dialog: any) => dialog.accept());
  await page.getByRole('menuitem', { name: '归档聊天', exact: true }).click();
}
function bindings(mock: MockCodex, hostId = 'local') {
  mock.nativeProjectSupported = true;
  mock.nativeProjectIds.set(JSON.stringify([hostId, source]), 'native-source');
}
function answer(socket: any, request: any, result: any) {
  socket.send(JSON.stringify({ id: request.id, result }));
}
const archivedIds = (mock: MockCodex) => mock.archivedThreads.map(thread => thread.id).sort();
const mutations = (mock: MockCodex) => mock.requests.filter(request => ['thread/archive', 'thread/delete'].includes(request.method || ''));

test('project archive pages native membership and legacy roots on its own host, preserving moved-out chats', async ({ page, mock }) => {
  const remote = new MockCodex();
  const original = remote.threads[0];
  const thread = (id: string, cwd: string, projectId: string | null) => ({ ...original, id, name: id, cwd, projectId, recencyAt: original.createdAt });
  remote.threads = [
    thread('moved-out', source, 'native-destination'),
    thread('moved-in-one', destination, 'native-source'),
    thread('moved-in-two', '/workspace/another-original-directory', 'native-source'),
    thread('legacy-one', source, null),
    thread('legacy-two', source, null),
    thread('legacy-additional-root', '/workspace/shared', null),
    thread('assigned-additional-root', '/workspace/shared', 'native-destination'),
    thread('unrelated', '/workspace/other', null),
  ];
  mock.hosts.push({ id: 'ssh-archive-membership', name: '远程项目主机', kind: 'ssh' });
  mock.projects.push({ ...mock.projects[0], id: 'remote-source', name: '远程源项目', hostId: 'ssh-archive-membership', rootPaths: [source, '/workspace/shared', source] });
  mock.hostMocks.set('ssh-archive-membership', remote);
  bindings(mock, 'ssh-archive-membership');
  const receive = (remote as any).receive.bind(remote);
  (remote as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/list' || request.params.limit !== 100) return receive(socket, request);
    remote.requests.push(request);
    const p = request.params;
    const candidates = remote.threads.filter((thread: any) => (!p.cwd || p.cwd.includes(thread.cwd)) && thread.projectId === p.projectId);
    const offset = p.cursor ? Number(p.cursor) : 0;
    answer(socket, request, { data: candidates.slice(offset, offset + 1), nextCursor: offset + 1 < candidates.length ? String(offset + 1) : null });
  };
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').first().click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  await archive(page, 'ssh-archive-membership');
  await expect.poll(() => archivedIds(remote)).toEqual(['legacy-additional-root', 'legacy-one', 'legacy-two', 'moved-in-one', 'moved-in-two']);
  expect(remote.threads.map(thread => thread.id).sort()).toEqual(['assigned-additional-root', 'moved-out', 'unrelated']);
  const queries = remote.requests.filter(request => request.method === 'thread/list' && request.params.limit === 100).map(request => request.params);
  expect(queries).toHaveLength(5);
  expect(queries.filter(params => params.projectId === 'native-source')).toHaveLength(2);
  expect(queries.filter(params => params.projectId === null && params.cwd?.includes(source))).toHaveLength(2);
  expect(queries.filter(params => params.cwd).every(params => Array.isArray(params.cwd))).toBe(true);
  expect(queries.every(params => params.archived === false)).toBe(true);
  expect(remote.requests.filter(request => request.method === 'thread/delete')).toHaveLength(0);
  expect(mutations(mock)).toHaveLength(0);
  await expect(page.locator('.header-host')).toHaveText('本机');
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
});

test('a project move received after the list snapshot prevents archive even when thread/read arrives stale', async ({ page, mock }) => {
  bindings(mock);
  Object.assign(mock.threads[0], { projectId: 'native-source', recencyAt: mock.threads[0].createdAt });
  let archiving = false;
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/list' && request.params.limit === 100) archiving = true;
    if (archiving && request.method === 'thread/read') {
      mock.requests.push(request);
      const stale = { ...mock.threads[0] };
      (mock.threads[0] as any).projectId = 'native-destination';
      mock.emit('thread/project/updated', { threadId: stale.id, projectId: 'native-destination' });
      answer(socket, request, { thread: stale });
      return;
    }
    return receive(socket, request);
  };
  await login(page);
  await archive(page);
  await expect(page.getByText('已归档 0 个对话，可在已归档对话中恢复', { exact: true })).toBeVisible();
  expect(mutations(mock)).toHaveLength(0);
  expect(mock.threads).toHaveLength(1);
  expect((mock.threads[0] as any).projectId).toBe('native-destination');
});

test('explicitly unsupported native projects retain legacy cwd archive without touching assigned chats', async ({ page, mock }) => {
  const original = mock.threads[0];
  mock.threads = [
    { ...original, id: 'legacy-older-server', recencyAt: original.createdAt },
    { ...original, id: 'assigned-elsewhere', projectId: 'another-project', recencyAt: original.createdAt } as any,
    { ...original, id: 'different-directory', cwd: destination, recencyAt: original.createdAt },
  ];
  await login(page);
  await archive(page);
  await expect.poll(() => archivedIds(mock)).toEqual(['legacy-older-server']);
  expect(mock.threads.map(thread => thread.id).sort()).toEqual(['assigned-elsewhere', 'different-directory']);
  expect(mock.requests.filter(request => request.method === 'thread/delete')).toHaveLength(0);
});

test('binding errors, repeated pagination and metadata errors fail closed before archiving', async ({ page, mock }) => {
  Object.assign(mock.threads[0], { projectId: 'native-source', recencyAt: mock.threads[0].createdAt });
  bindings(mock);
  let bindingFailure = false;
  await page.route('**/api/projects/native-bindings?*', async route => {
    if (!bindingFailure) return route.fallback();
    await route.fulfill({ status: 502, json: { error: '项目归属读取失败' } });
  });
  let mode = 'normal';
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/list' && request.params.limit === 100 && mode === 'repeat') {
      mock.requests.push(request);
      answer(socket, request, { data: mock.threads, nextCursor: 'repeated-page' });
      return;
    }
    if (request.method === 'thread/read' && mode === 'metadata-error') {
      mock.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: '对话归属读取失败' } }));
      return;
    }
    return receive(socket, request);
  };
  await login(page);
  await expect(row(page)).toBeVisible();
  await expect.poll(() => mock.requests.some(request => request.method === 'thread/list')).toBe(true);
  bindingFailure = true;
  await archive(page);
  await expect(page.getByText('项目归属读取失败', { exact: true })).toBeVisible();
  expect(mutations(mock)).toHaveLength(0);
  bindingFailure = false;
  mode = 'repeat';
  await archive(page);
  await expect(page.getByText('项目历史分页重复，请刷新后重试', { exact: true })).toBeVisible();
  expect(mutations(mock)).toHaveLength(0);
  mode = 'metadata-error';
  await archive(page);
  await expect(page.getByText('已归档 0 个对话，其余未完成：对话归属读取失败', { exact: true })).toBeVisible();
  expect(mutations(mock)).toHaveLength(0);
  expect(mock.threads).toHaveLength(1);
});
