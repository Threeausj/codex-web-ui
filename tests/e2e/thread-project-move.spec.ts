import { test, expect, login, MockCodex } from './fixtures';

const a = '/workspace/demo', b = '/workspace/second';
function prepare(mock: MockCodex) {
  mock.nativeProjectSupported = true;
  mock.nativeProjectIds.set(JSON.stringify(['local', a]), 'native-a');
  mock.nativeProjectIds.set(JSON.stringify(['local', b]), 'native-b');
  mock.projects.push({ id: 'web-b', name: '项目 B', hostId: 'local', path: b, source: 'web' });
  (mock.threads[0] as any).projectId = 'native-a';
}
const group = (page: any, path: string) => page.locator(`.nav-project-group[data-host-id="local"][data-project-path="${path}"]`);

test('moving a chat uses the same host native project, keeps cwd and draft, and survives reload', async ({ page, mock }) => {
  prepare(mock);
  mock.hosts.push({ id: 'ssh-other', name: '其他主机', kind: 'ssh', cwd: '/remote' });
  mock.hostMocks.set('ssh-other', new MockCodex());
  mock.projects.push({ id: 'remote-b', name: '其他主机项目', path: '/remote', hostId: 'ssh-other', source: 'web' });
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('项目调整时保留的草稿');
  await page.locator('[data-section="recent"] [data-host-id="local"] .nav-row-menu').first().click();
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '移动到项目', exact: true });
  const select = dialog.getByRole('combobox', { name: '目标项目' });
  await expect(select).toBeEnabled();
  expect(await select.locator('option').allTextContents()).not.toContain('其他主机项目');
  await select.selectOption(b);
  await dialog.getByRole('button', { name: '移动对话', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.request('thread/metadata/update')?.params).toEqual({ threadId: 'thread-existing', projectId: 'native-b' });
  expect(mock.threads[0].cwd).toBe(a);
  await expect(input).toHaveValue('项目调整时保留的草稿');
  await expect(group(page, a).locator('.thread-row')).toHaveCount(0);
  await expect(group(page, b).locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('.main-header')).toHaveAttribute('data-project-name', '项目 B');
  await expect(group(page, b).locator('.nav-project-header')).toHaveClass(/active/);
  await expect(group(page, a).locator('.nav-project-header')).not.toHaveClass(/active/);
  expect(mock.request('thread/settings/update')).toBeUndefined();
  await page.reload();
  await expect(group(page, b).locator('.thread-row')).toHaveCount(1);
  await expect(group(page, a).locator('.thread-row')).toHaveCount(0);
  await expect(input).toHaveValue('项目调整时保留的草稿');
  expect(mock.requests.some(request => request.method === 'thread/list' && request.params.projectId === 'native-b' && !request.params.cwd)).toBe(true);
});

test('the mobile conversation header exposes project adjustment', async ({ page, mock }) => {
  prepare(mock);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '移动到项目', exact: true });
  await expect(dialog.getByRole('combobox', { name: '目标项目' })).toBeEnabled();
  await dialog.getByRole('combobox', { name: '目标项目' }).selectOption(b);
  await dialog.getByRole('button', { name: '移动对话', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((mock.threads[0] as any).projectId).toBe('native-b');
});

for (const unsupported of ['projects', 'metadata']) {
  test(`unsupported native ${unsupported} leaves the original project unchanged and explains the failure`, async ({ page, mock }) => {
    prepare(mock);
    if (unsupported === 'projects') mock.nativeProjectSupported = false;
    else mock.failProjectMoveNext = true;
    await login(page);
    await page.locator('[data-section="recent"] .nav-row-menu').first().click();
    await page.getByRole('button', { name: '移动到项目', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '移动到项目', exact: true });
    await expect(dialog.getByRole('combobox', { name: '目标项目' })).toBeEnabled();
    await dialog.getByRole('combobox', { name: '目标项目' }).selectOption(b);
    await dialog.getByRole('button', { name: '移动对话', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('不支持原生项目调整');
    expect((mock.threads[0] as any).projectId).toBe('native-a');
    expect(mock.threads[0].cwd).toBe(a);
    if (unsupported === 'projects') expect(mock.request('thread/metadata/update')).toBeUndefined();
  });
}

test('a native project update from another client regroups the chat without changing its working directory', async ({ page, mock }) => {
  prepare(mock);
  await login(page);
  await expect(group(page, a).locator('.thread-row')).toHaveCount(1);
  (mock.threads[0] as any).projectId = 'native-b';
  mock.emit('thread/project/updated', { threadId: 'thread-existing', projectId: 'native-b' });
  await expect(group(page, a).locator('.thread-row')).toHaveCount(0);
  await expect(group(page, b).locator('.thread-row')).toHaveCount(1);
  expect(mock.threads[0].cwd).toBe(a);
});

test('a runtime that ignores projectId cannot report a successful project adjustment', async ({ page, mock }) => {
  prepare(mock);
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => {
    if (request.method === 'thread/metadata/update') {
      mock.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, result: { thread: mock.threads[0] } }));
      return;
    }
    return receive(socket, request);
  };
  await login(page);
  await page.locator('[data-section="recent"] .nav-row-menu').first().click();
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '移动到项目', exact: true });
  await expect(dialog.getByRole('combobox', { name: '目标项目' })).toBeEnabled();
  await dialog.getByRole('combobox', { name: '目标项目' }).selectOption(b);
  await dialog.getByRole('button', { name: '移动对话', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Codex 未确认项目调整');
  expect((mock.threads[0] as any).projectId).toBe('native-a');
  await expect(group(page, a).locator('.thread-row')).toHaveCount(1);
  await expect(group(page, b).locator('.thread-row')).toHaveCount(0);
});

test('moving a background host chat keeps the selected host, conversation and draft untouched', async ({ page, mock }) => {
  prepare(mock);
  const remote = new MockCodex();
  mock.hosts.push({ id: 'ssh-move', name: '移动测试主机', kind: 'ssh', cwd: a });
  mock.hostMocks.set('ssh-move', remote);
  mock.projects.push({ id: 'remote-a', name: '远程 A', path: a, hostId: 'ssh-move', source: 'web' },
    { id: 'remote-b', name: '远程 B', path: b, hostId: 'ssh-move', source: 'web' });
  mock.nativeProjectIds.set(JSON.stringify(['ssh-move', a]), 'remote-native-a');
  mock.nativeProjectIds.set(JSON.stringify(['ssh-move', b]), 'remote-native-b');
  (remote.threads[0] as any).projectId = 'remote-native-a';
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('本机当前草稿');
  await page.locator('[data-section="recent"] [data-host-id="ssh-move"] .nav-row-menu').first().click();
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '移动到项目', exact: true });
  await expect(dialog.getByRole('combobox', { name: '目标项目' })).toBeEnabled();
  expect(await dialog.getByRole('combobox', { name: '目标项目' }).locator('option').allTextContents()).not.toContain('项目 B');
  await dialog.getByRole('combobox', { name: '目标项目' }).selectOption(b);
  await dialog.getByRole('button', { name: '移动对话', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(remote.request('thread/metadata/update')?.params).toEqual({ threadId: 'thread-existing', projectId: 'remote-native-b' });
  expect(mock.request('thread/metadata/update')).toBeUndefined();
  expect((mock.threads[0] as any).projectId).toBe('native-a');
  expect(remote.threads[0].cwd).toBe(a);
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'local');
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('本机当前草稿');
});
