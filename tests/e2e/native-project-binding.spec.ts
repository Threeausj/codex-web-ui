import { test, expect, login, MockCodex } from './fixtures';

const root = '/workspace/demo';

for (const hostId of ['local', 'ssh-native-project']) {
  test(`a new ${hostId} chat binds the selected host's native project identity rather than its Web ID`, async ({ page, mock }) => {
    mock.nativeProjectSupported = true;
    mock.nativeProjectIds.set(JSON.stringify(['local', root]), 'native-local-project');
    let target = mock;
    if (hostId !== 'local') {
      target = new MockCodex();
      mock.hosts.push({ id: hostId, name: 'NAS', kind: 'ssh', cwd: root });
      mock.projects.push({ id: 'web-nas-project', name: 'NAS项目', path: root, hostId, source: 'web' });
      mock.hostMocks.set(hostId, target);
      mock.nativeProjectIds.set(JSON.stringify([hostId, root]), 'native-nas-project');
    }
    await login(page);
    if (hostId !== 'local') {
      await page.getByRole('combobox', { name: '新对话主机', exact: true }).selectOption(hostId);
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      await expect(page.getByRole('combobox', { name: '新对话项目', exact: true })).toHaveValue(root);
      await expect(page.getByRole('combobox', { name: '新对话主机', exact: true })).toBeEnabled();
    }
    await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('回应问候');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => target.request('turn/start')?.method).toBe('turn/start');
    expect(mock.nativeProjectResolutions).toEqual([{ hostId, path: root }]);
    expect(target.request('thread/start')?.params).toMatchObject({ cwd: root, projectId: hostId === 'local' ? 'native-local-project' : 'native-nas-project' });
    if (hostId !== 'local') expect(mock.request('thread/start')).toBeUndefined();
  });
}

test('an old Codex explicitly lacking native projects still creates the chat without an unknown projectId field', async ({ page, mock }) => {
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('旧版本仍可使用');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.method).toBe('turn/start');
  expect(mock.nativeProjectResolutions).toEqual([{ hostId: 'local', path: root }]);
  expect(mock.request('thread/start')?.params).not.toHaveProperty('projectId');
});

test('a directory without a configured project is not assigned to another project on the same host', async ({ page, mock }) => {
  mock.projects = [{ id: 'unrelated', hostId: 'local', name: '其他项目', path: '/workspace/other', source: 'web' }];
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('当前目录独立对话');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.method).toBe('turn/start');
  expect(mock.nativeProjectResolutions).toEqual([]);
  expect(mock.request('thread/start')?.params).toMatchObject({ cwd: root });
  expect(mock.request('thread/start')?.params).not.toHaveProperty('projectId');
});

test('an exact project directory takes precedence over an earlier project that lists it as a secondary root', async ({ page, mock }) => {
  mock.projects.unshift({ id: 'group', hostId: 'local', name: '多根项目', path: '/workspace/group', rootPaths: ['/workspace/group', root], source: 'web' });
  mock.nativeProjectSupported = true;
  mock.nativeProjectIds.set(JSON.stringify(['local', root]), 'native-exact-root-project');
  mock.nativeProjectIds.set(JSON.stringify(['local', '/workspace/group']), 'native-secondary-root-group');
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('按精确目录归类');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.method).toBe('turn/start');
  expect(mock.nativeProjectResolutions).toEqual([{ hostId: 'local', path: root }]);
  expect(mock.request('thread/start')?.params.projectId).toBe('native-exact-root-project');
});

test('an ambiguous secondary project root preserves the draft and requires an explicit destination', async ({ page, mock }) => {
  mock.projects = ['first', 'second'].map(id => ({ id, hostId: 'local', name: `${id}项目`, path: `/workspace/${id}`, rootPaths: [root], source: 'web' }));
  await login(page);
  const input = page.getByRole('textbox', { name: '消息输入框' });
  await input.fill('不能猜测项目归属');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('当前目录属于多个项目');
  await expect(input).toHaveValue('不能猜测项目归属');
  expect(mock.nativeProjectResolutions).toEqual([]);
  expect(mock.request('thread/start')).toBeUndefined();
});

test('a transient native project failure preserves the draft and attachment and never creates an unassigned chat', async ({ page, mock }) => {
  let attempts = 0;
  await page.route('**/api/uploads', route => route.fulfill({ status: 201, json: {
    files: [{ name: 'notes.txt', path: '/test/uploads/notes.txt', mime: 'text/plain', size: 18 }],
  } }));
  await page.route('**/api/projects/resolve-native', route => {
    attempts++;
    expect(route.request().postDataJSON()).toEqual({ hostId: 'local', path: root });
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: '项目连接暂时失败，请重试' } })
      : route.fulfill({ json: { supported: true, projectId: 'native-recovered-project' } });
  });
  await login(page);
  const input = page.getByRole('textbox', { name: '消息输入框' });
  await input.fill('不要丢失这份草稿');
  await page.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('project attachment') });
  await expect(page.locator('.attachment')).toHaveCount(1);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('项目连接暂时失败');
  await expect(input).toHaveValue('不要丢失这份草稿');
  await expect(page.locator('.attachment')).toHaveCount(1);
  expect(mock.request('thread/start')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.method).toBe('turn/start');
  expect(mock.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
  expect(mock.request('thread/start')?.params.projectId).toBe('native-recovered-project');
  expect(mock.request('turn/start')?.params.input[0].text).toContain('notes.txt');
});

test('an invalid supported native project response cannot silently fall back to an unassigned chat', async ({ page, mock }) => {
  await page.route('**/api/projects/resolve-native', route => route.fulfill({ json: { supported: true, projectId: null } }));
  await login(page);
  const input = page.getByRole('textbox', { name: '消息输入框' });
  await input.fill('原生归属必须确认');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法确认项目归属');
  await expect(input).toHaveValue('原生归属必须确认');
  expect(mock.request('thread/start')).toBeUndefined();
});

test('selecting an existing chat while native project resolution is pending cannot send the draft into either chat', async ({ page, mock }) => {
  let finishResolution: (() => Promise<void>) | undefined;
  await page.route('**/api/projects/resolve-native', async route => {
    await new Promise<void>(resolve => {
      finishResolution = async () => { await route.fulfill({ json: { supported: true, projectId: 'late-project' } }); resolve(); };
    });
  });
  await login(page);
  const input = page.getByRole('textbox', { name: '消息输入框' });
  const existing = page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: '已有测试历史' }).first();
  await existing.click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await input.fill('已有对话自己的草稿');
  await page.locator('.new-thread-button').click();
  await input.fill('待解析项目的新消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => !!finishResolution).toBe(true);
  await existing.click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('已有对话自己的草稿');
  await finishResolution!();
  await expect(page.getByRole('alert')).toContainText('新对话位置已变化');
  await expect(input).toHaveValue('已有对话自己的草稿');
  expect(mock.request('thread/start')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
  await page.locator('.new-thread-button').click();
  await expect(input).toHaveValue('待解析项目的新消息');
});

test('continuing an existing conversation preserves its original native project without resolving a new one', async ({ page, mock }) => {
  (mock.threads[0] as any).projectId = 'native-original-project';
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息输入框' }).fill('继续原有对话');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.threadId).toBe('thread-existing');
  expect(mock.nativeProjectResolutions).toEqual([]);
  expect(mock.request('thread/start')).toBeUndefined();
  expect(mock.request('thread/metadata/update')).toBeUndefined();
});

test('changing hosts while native project resolution is pending cannot create a thread or submit on either host', async ({ page, mock }) => {
  const remote = new MockCodex();
  mock.hosts.push({ id: 'ssh-pending-project', name: 'NAS待连接主机', kind: 'ssh', cwd: '/srv/nas' });
  mock.projects.push({ id: 'pending-project', name: 'NAS待连接项目', path: '/srv/nas', hostId: 'ssh-pending-project', source: 'web' });
  mock.hostMocks.set('ssh-pending-project', remote);
  let finishResolution: (() => Promise<void>) | undefined;
  await page.route('**/api/projects/resolve-native', async route => {
    await new Promise<void>(resolve => {
      finishResolution = async () => { await route.fulfill({ json: { supported: true, projectId: 'native-local-before-switch' } }); resolve(); };
    });
  });
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('本机项目待发送消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => !!finishResolution).toBe(true);
  await page.locator('.project-row').filter({ hasText: 'NAS待连接项目' }).click();
  await expect(page.locator('.header-host')).toHaveText('NAS待连接主机');
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toBeEnabled();
  await finishResolution!();
  await expect(page.getByRole('alert')).toContainText('新对话位置已变化');
  expect(mock.request('thread/start')).toBeUndefined();
  expect(remote.request('thread/start')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
  expect(remote.request('turn/start')).toBeUndefined();
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('');
});

test('native project moves update the cached conversation metadata without changing its draft or cwd', async ({ page, mock }) => {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: '消息输入框' });
  await input.fill('移动项目时保留的草稿');
  async function cachedProject() {
    return page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('codex-private-conversations', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<string | null | undefined>((resolve, reject) => {
          const request = database.transaction('snapshots').objectStore('snapshots').getAll();
          request.onsuccess = () => resolve(request.result.find(entry => entry.hostId === 'local' && entry.threadId === 'thread-existing')?.thread.projectId);
          request.onerror = () => reject(request.error);
        });
      } finally { database.close(); }
    });
  }
  mock.emit('thread/project/updated', { threadId: 'thread-existing', projectId: 'native-moved-project' });
  await expect.poll(cachedProject).toBe('native-moved-project');
  mock.emit('thread/project/updated', { threadId: 'thread-existing', projectId: null });
  await expect.poll(cachedProject).toBeNull();
  await expect(input).toHaveValue('移动项目时保留的草稿');
  expect(mock.request('turn/start')).toBeUndefined();
  expect(mock.request('thread/settings/update')).toBeUndefined();
});
