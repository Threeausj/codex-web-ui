import { test, expect, login, MockCodex } from './fixtures';

const workspace = '/workspace/demo';
const projectChoice = (page: any) => page.getByRole('combobox', { name: '新对话项目', exact: true });
const input = (page: any) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const projectGroup = (page: any, host = 'local') => page.locator(`.nav-project-group[data-host-id="${host}"][data-project-path="${workspace}"]`);

function nativeProject(mock: MockCodex, host = 'local') {
  mock.nativeProjectSupported = true;
  mock.nativeProjectIds.set(JSON.stringify([host, workspace]), `native-${host}`);
  const target = host === 'local' ? mock : mock.hostMocks.get(host)!;
  (target.threads[0] as any).projectId = `native-${host}`;
}

test('choosing no project retains the current host, draft and attachment, and starts a native chat without a project', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  nativeProject(mock);
  await login(page);
  const resolvedBefore = mock.nativeProjectResolutions.length;
  await input(page).fill('不关联项目的聊天草稿');
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+UqsAAAAASUVORK5CYII=', 'base64') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('保留附件') },
  ]);
  await expect(page.locator('.attachment')).toHaveCount(2);
  await projectChoice(page).selectOption({ label: '不在项目中工作' });
  await expect(projectChoice(page)).toBeEnabled();
  await expect(projectChoice(page)).toHaveValue('');
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '聊天');
  await expect(page.locator('.welcome')).toContainText('不关联项目');
  await expect(input(page)).toHaveValue('不关联项目的聊天草稿');
  await expect(page.locator('.attachment')).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: '新对话主机', exact: true })).toHaveValue('local');
  expect(mock.nativeProjectResolutions).toHaveLength(resolvedBefore);
  await page.screenshot({ path: '.data/projectless-chat-desktop.png' });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.method).toBe('turn/start');
  expect(mock.request('thread/start')?.params.projectId).toBeNull();
  expect(mock.request('thread/start')?.params.threadSource).toBe('codex-web:no-project');
  expect(mock.request('thread/start')?.params.cwd).toMatch(/^\//);
  expect(mock.request('turn/start')?.params.input[0].text).toContain('不关联项目的聊天草稿');
  expect(mock.request('turn/start')?.params.input[0].text).toContain('/test/uploads/notes.txt');
  expect(mock.request('turn/start')?.params.input).toContainEqual({ type: 'localImage', path: '/test/uploads/sample.png' });
  await expect(projectGroup(page).locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '聊天');
});

test('a no-project chat does not inherit extra workspace roots from a project sharing its execution directory', async ({ page, mock }) => {
  nativeProject(mock);
  mock.projects[0].rootPaths = [workspace, '/workspace/shared-private', '/workspace/assets-private'];
  await login(page);
  await projectChoice(page).selectOption({ label: '不在项目中工作' });
  await expect(projectChoice(page)).toBeEnabled();
  await input(page).fill('只使用当前执行目录，不继承项目的其他目录');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.method).toBe('turn/start');
  expect(mock.request('thread/start')?.params.cwd).toBe(workspace);
  expect(mock.request('thread/start')?.params.runtimeWorkspaceRoots).toEqual([workspace]);
  expect(mock.request('turn/start')?.params.runtimeWorkspaceRoots).toEqual([workspace]);
  expect(mock.request('turn/start')?.params.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: [workspace] });
  expect(JSON.stringify(mock.request('thread/start')?.params)).not.toContain('/workspace/shared-private');
  expect(JSON.stringify(mock.request('turn/start')?.params)).not.toContain('/workspace/assets-private');
});

test('visiting an existing project chat in another directory does not overwrite the explicit no-project default', async ({ page, mock }) => {
  nativeProject(mock);
  const otherRoot = '/workspace/another-project';
  mock.projects.push({ id: 'another-project', path: otherRoot, name: '另一个项目', hostId: 'local', source: 'web' });
  mock.nativeProjectIds.set(JSON.stringify(['local', otherRoot]), 'native-another');
  mock.threads[0].cwd = otherRoot;
  (mock.threads[0] as any).projectId = 'native-another';
  await login(page);
  await projectChoice(page).selectOption({ label: '不在项目中工作' });
  await expect(projectChoice(page)).toBeEnabled();
  await input(page).fill('保留普通聊天的默认位置');
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '另一个项目');
  await page.locator('.new-thread-button').click();
  await expect(projectChoice(page)).toHaveValue('');
  await expect(input(page)).toHaveValue('保留普通聊天的默认位置');
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '聊天');
  await page.reload();
  await expect(input(page)).toBeEnabled();
  await expect(projectChoice(page)).toHaveValue('');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.method).toBe('turn/start');
  expect(mock.request('thread/start')?.params.projectId).toBeNull();
  expect(mock.request('thread/start')?.params.threadSource).toBe('codex-web:no-project');
});

test('expanding a multi-root project while in no-project context still queries every project root without widening execution roots', async ({ page, mock }) => {
  const roots = [workspace, '/workspace/shared-private', '/workspace/assets-private'];
  mock.projects[0].rootPaths = roots;
  mock.preferences.collapsed[`project:local:${workspace}`] = true;
  mock.threads[0].cwd = roots[1];
  await login(page);
  await projectChoice(page).selectOption({ label: '不在项目中工作' });
  await expect(projectChoice(page)).toBeEnabled();
  const queriedBefore = mock.requests.filter(request => request.method === 'thread/list' && request.params.limit === 60).length;
  await projectGroup(page).getByRole('button', { name: '展开项目 Demo Project', exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'thread/list' && request.params.limit === 60).length).toBeGreaterThan(queriedBefore);
  const query = mock.requests.filter(request => request.method === 'thread/list' && request.params.limit === 60).at(-1)!;
  expect(query.params.cwd).toEqual(roots);
  await expect(projectGroup(page).locator('.thread-row')).toHaveCount(1);
  await expect(projectChoice(page)).toHaveValue('');
  await input(page).fill('查看其他项目不会扩大本次执行目录');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.method).toBe('turn/start');
  expect(mock.request('thread/start')?.params.runtimeWorkspaceRoots).toEqual([workspace]);
  expect(mock.request('turn/start')?.params.runtimeWorkspaceRoots).toEqual([workspace]);
});

test('forking a completed no-project chat preserves its source marker and keeps the branch outside projects', async ({ page, mock }) => {
  nativeProject(mock);
  await login(page);
  await projectChoice(page).selectOption({ label: '不在项目中工作' });
  await expect(projectChoice(page)).toBeEnabled();
  await input(page).fill('普通聊天创建分支');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('流式回复完成 ✅', { exact: true })).toBeVisible();
  const sourceId = mock.request('turn/start')!.params.threadId;
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.getByRole('button', { name: '创建分支', exact: true }).click();
  await expect.poll(() => mock.request('thread/fork')?.params.threadId).toBe(sourceId);
  expect(mock.request('thread/fork')?.params.threadSource).toBe('codex-web:no-project');
  await expect(page.locator('.main-header h1')).toHaveText('分支测试对话');
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '聊天');
  await expect(projectGroup(page).locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('[data-section="recent"] .thread-row')).toHaveCount(3);
  await page.reload();
  await expect(input(page)).toBeEnabled();
  await expect(page.locator('.main-header h1')).toHaveText('分支测试对话');
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '聊天');
  await expect(projectGroup(page).locator('.thread-row')).toHaveCount(1);
});

test('no-project selection and its draft survive reloading without falling back to the execution directory project', async ({ page, mock }) => {
  nativeProject(mock);
  await login(page);
  await projectChoice(page).selectOption({ label: '不在项目中工作' });
  await expect(projectChoice(page)).toBeEnabled();
  await input(page).fill('刷新后仍然是不关联项目的草稿');
  await page.reload();
  await expect(input(page)).toBeEnabled();
  await expect(projectChoice(page)).toHaveValue('');
  await expect(input(page)).toHaveValue('刷新后仍然是不关联项目的草稿');
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '聊天');
  await projectChoice(page).selectOption(workspace);
  await expect(projectChoice(page)).toBeEnabled();
  await expect(projectChoice(page)).toHaveValue(workspace);
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', 'Demo Project');
  await expect(input(page)).toHaveValue('刷新后仍然是不关联项目的草稿');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('thread/start')?.params.projectId).toBe('native-local');
});

for (const supported of [true, false]) {
  test(`an explicit no-project chat stays outside project groups after reload and in a fresh browser client (native projects ${supported ? 'available' : 'unavailable'})`, async ({ page, mock }) => {
    if (supported) nativeProject(mock);
    await login(page);
    await projectChoice(page).selectOption({ label: '不在项目中工作' });
    await expect(projectChoice(page)).toBeEnabled();
    await input(page).fill('仅属于聊天而不是项目');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => mock.request('turn/start')?.method).toBe('turn/start');
    const threadId = mock.request('turn/start')!.params.threadId;
    await expect(projectGroup(page).locator('.thread-row')).toHaveCount(1);
    await expect(page.locator('[data-section="recent"] .thread-row')).toHaveCount(2);
    await page.reload();
    await expect(input(page)).toBeEnabled();
    await expect(projectGroup(page).locator('.thread-row')).toHaveCount(1);
    await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '聊天');

    const context = await page.context().browser()!.newContext();
    const other = await context.newPage();
    await mock.install(other);
    try {
      await other.goto('/');
      await expect(input(other)).toBeEnabled();
      await expect(projectGroup(other).locator('.thread-row')).toHaveCount(1);
      const recent = other.locator('[data-section="recent"] .thread-row');
      await expect(recent).toHaveCount(2);
      await recent.filter({ hasText: mock.threads.find(thread => thread.id === threadId)!.name }).click();
      await expect.poll(() => mock.request('thread/resume')?.params.threadId).toBe(threadId);
      await expect(other.locator('.main-header')).toHaveAttribute('data-project-name', '聊天');
    } finally { await context.close(); }
  });
}

test('the mobile project selector can choose no project on a remote host and return to a project without losing the draft', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const remote = new MockCodex();
  mock.hosts.push({ id: 'ssh-chat', kind: 'ssh', name: '远程聊天主机', cwd: '/srv' });
  mock.hostMocks.set('ssh-chat', remote);
  mock.projects.push({ id: 'remote-chat-project', hostId: 'ssh-chat', path: workspace, name: '远程项目', source: 'web' });
  nativeProject(mock, 'ssh-chat');
  await login(page);
  await input(page).fill('手机上的普通聊天');
  const host = page.getByRole('combobox', { name: '新对话主机', exact: true });
  await host.selectOption('ssh-chat');
  await expect(projectChoice(page)).toBeEnabled();
  await projectChoice(page).selectOption({ label: '不在项目中工作' });
  await expect(projectChoice(page)).toHaveValue('');
  await expect(input(page)).toHaveValue('手机上的普通聊天');
  await expect(host).toHaveValue('ssh-chat');
  await projectChoice(page).selectOption(workspace);
  await expect(projectChoice(page)).toHaveValue(workspace);
  await projectChoice(page).selectOption({ label: '不在项目中工作' });
  await expect(projectChoice(page)).toBeEnabled();
  const group = page.getByRole('group', { name: '新对话位置', exact: true });
  expect(await group.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await group.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.data/projectless-chat-mobile.png' });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => remote.request('turn/start')?.method).toBe('turn/start');
  expect(remote.request('thread/start')?.params.projectId).toBeNull();
  expect(remote.request('thread/start')?.params.threadSource).toBe('codex-web:no-project');
  expect(mock.request('thread/start')).toBeUndefined();
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '聊天');
});
