import { test, expect, login, MockCodex } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { createHash } from 'node:crypto';

type Entry = { directory: boolean; content?: string; revision: number };
async function files(page: Page, mock: MockCodex) {
  const remote = new MockCodex();remote.threads[0]!.name = '另一台主机的聊天';
  mock.hosts.push({ id: 'file-remote', name: '文件远端', kind: 'ssh', cwd: '/workspace/demo' });
  mock.projects.push({ ...mock.projects[0]!, id: 'remote-files', hostId: 'file-remote' });mock.hostMocks.set('file-remote', remote);
  const local = new Map<string, Entry>([
    ['/workspace', { directory: true, revision: 1 }], ['/workspace/demo', { directory: true, revision: 1 }],
    ['/workspace/demo/README.md', { directory: false, content: '# 原文件', revision: 1 }],
    ['/workspace/demo/index.html', { directory: false, content: '<h1>Hello</h1>', revision: 1 }],
  ]);
  const remoteFiles = new Map<string, Entry>([...local].map(([key, value]) => [key, { ...value }]));
  const inventories = new Map([['local', local], ['file-remote', remoteFiles]]);
  const list = (inventory: Map<string, Entry>, parent: string) => [...inventory].filter(([path]) => path.startsWith(parent.replace(/\/$/, '') + '/') && !path.slice(parent.replace(/\/$/, '').length + 1).includes('/')).map(([path, entry]) => ({ fileName: path.split('/').pop()!, isDirectory: entry.directory }));
  for (const [hostId, target] of [['local', mock], ['file-remote', remote]] as const) {
    const receive = (target as any).receive.bind(target);
    (target as any).receive = (socket: any, request: any) => {
      const inventory = inventories.get(hostId)!, p = request.params || {};
      const reply = (result: unknown) => { target.requests.push(request);socket.send(JSON.stringify({ id: request.id, result })); };
      if (request.method === 'fs/readDirectory') return reply({ entries: list(inventory, p.path) });
      if (request.method === 'fs/readFile') return reply({ dataBase64: Buffer.from(inventory.get(p.path)?.content || '').toString('base64') });
      if (request.method === 'fs/writeFile') { const entry = inventory.get(p.path)!;entry.content = Buffer.from(p.dataBase64, 'base64').toString();entry.revision++;return reply({}); }
      return receive(socket, request);
    };
  }
  await page.route(/\/api\/hosts\/[^/]+\/directories(?:\?|$)/, route => {
    const url = new URL(route.request().url()), hostId = url.pathname.split('/')[3]!, inventory = inventories.get(hostId)!;
    const path = url.searchParams.get('path') || '/workspace';
    return route.fulfill({ json: { path, entries: list(inventory, path) } });
  });
  const requests: { hostId: string; body: any }[] = [];
  const version = (entry: Entry) => createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  let failure = '', hold: (() => Promise<void>) | undefined;
  await page.route(/\/api\/hosts\/[^/]+\/file-entries(?:\/inspect)?$/, async (route: Route) => {
    const hostId = new URL(route.request().url()).pathname.split('/')[3]!, inventory = inventories.get(hostId)!, body = route.request().postDataJSON();
    const path = body.directory.replace(/\/$/, '') + '/' + body.name, entry = inventory.get(path);
    if (route.request().url().endsWith('/inspect')) return route.fulfill({ status: entry ? 200 : 404, json: entry ? { version: version(entry), isDirectory: entry.directory } : { error: '不存在' } });
    requests.push({ hostId, body });await hold?.();
    if (failure) { const message = failure;failure = '';return route.fulfill({ status: 409, json: { error: message } }); }
    if (body.operation.startsWith('create')) {
      if (entry) return route.fulfill({ status: 409, json: { error: '同名文件或文件夹已存在' } });
      inventory.set(path, { directory: body.operation === 'createDirectory', content: '', revision: 1 });
    } else if (!entry || body.expectedVersion !== version(entry)) return route.fulfill({ status: 409, json: { error: '文件已变化，请刷新后重试' } });
    const destination = body.operation === 'rename' ? body.directory.replace(/\/$/, '') + '/' + body.newName : path;
    if (body.operation === 'rename') {
      if (inventory.has(destination)) return route.fulfill({ status: 409, json: { error: '同名文件或文件夹已存在' } });
      for (const [key, value] of [...inventory]) if (key === path || key.startsWith(path + '/')) { inventory.delete(key);inventory.set(destination + key.slice(path.length), value); }
    }
    if (body.operation === 'delete') for (const key of [...inventory.keys()]) if (key === path || key.startsWith(path + '/')) inventory.delete(key);
    return route.fulfill({ json: { hostId, directory: body.directory, path: destination, operation: body.operation, isDirectory: body.operation === 'createDirectory' || !!entry?.directory, ...(['delete', 'rename'].includes(body.operation) ? { previousPath: path } : {}) } });
  });
  return { local, remoteFiles, requests, remote, fail(message: string) { failure = message; }, hold(value: () => Promise<void>) { hold = value; } };
}
async function workspace(page: Page) {
  await login(page);await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await expect(page.locator('.file-tree-row').filter({ hasText: 'README.md' })).toBeVisible();
}
async function create(page: Page, type: '文件' | '文件夹', name: string, container = page.locator('aside.workspace-panel')) {
  await container.getByRole('button', { name: `新建${type}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `新建${type}`, exact: true });
  await dialog.getByRole('textbox', { name: `${type}名称`, exact: true }).fill(name);
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function rename(page: Page, previous: string, name: string) {
  await page.getByRole('button', { name: `${previous} 文件操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: /重命名/ }).click();
  const dialog = page.getByRole('dialog', { name: '重命名', exact: true });
  await dialog.getByRole('textbox', { name: '新名称', exact: true }).fill(name);
  await dialog.getByRole('button', { name: '确认重命名', exact: true }).click();await expect(dialog).toHaveCount(0);
}

test('workspace creates files and folders and renames an open unsaved file without losing its draft', async ({ page, mock }) => {
  const f = await files(page, mock);await workspace(page);
  await create(page, '文件', '新的笔记.txt');
  await expect(page.getByRole('tab', { name: '新的笔记.txt', exact: true })).toBeVisible();
  const editor = page.getByRole('textbox', { name: '新的笔记.txt 文件内容', exact: true });await editor.fill('尚未保存的中文文字');
  await rename(page, '新的笔记.txt', '重命名.txt');
  await expect(page.getByRole('tab', { name: '新的笔记.txt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '重命名.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '重命名.txt 文件内容', exact: true })).toHaveText('尚未保存的中文文字');
  await page.getByRole('region', { name: '文件预览', exact: true }).getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => f.local.get('/workspace/demo/重命名.txt')?.content).toBe('尚未保存的中文文字');
  await create(page, '文件夹', '新文件夹');await expect(page.locator('.file-tree-row').filter({ hasText: '新文件夹' })).toBeVisible();
  await rename(page, '新文件夹', '代码目录');expect(f.local.get('/workspace/demo/代码目录')?.directory).toBe(true);
});

test('rename conflicts keep both files and the dialog text for correction; invalid names never submit', async ({ page, mock }) => {
  const f = await files(page, mock);await workspace(page);
  const row = page.locator('.file-tree-row').filter({ hasText: 'README.md' });await row.focus();await row.press('F2');
  const dialog = page.getByRole('dialog', { name: '重命名', exact: true });
  await dialog.getByRole('textbox', { name: '新名称', exact: true }).fill('../escape');
  await expect(dialog.getByRole('button', { name: '确认重命名', exact: true })).toBeDisabled();expect(f.requests).toHaveLength(0);
  await dialog.getByRole('textbox', { name: '新名称', exact: true }).fill('index.html');await dialog.getByRole('button', { name: '确认重命名', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('同名');expect(f.local.get('/workspace/demo/README.md')?.content).toBe('# 原文件');
  await dialog.getByRole('textbox', { name: '新名称', exact: true }).fill('成功.md');await dialog.getByRole('button', { name: '确认重命名', exact: true }).click();
  await expect(dialog).toHaveCount(0);await expect(page.locator('.file-tree-row').filter({ hasText: '成功.md' })).toBeVisible();
});

for (const width of [1440, 390]) test(`new project picker can create, rename and delete folders and files (${width}px)`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 900 });const f = await files(page, mock);await login(page);
  if (width < 760) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('.settings-button').click();await page.locator('.settings-nav').getByRole('button', { name: '项目', exact: true }).click();
  await page.getByRole('button', { name: '浏览项目文件夹', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择项目文件夹', exact: true });
  await expect(picker.getByRole('button', { name: '使用文件夹', exact: true })).toBeEnabled();
  await create(page, '文件夹', '新项目', picker);await rename(page, '新项目', '中文项目');
  await picker.getByRole('button', { name: '进入 中文项目', exact: true }).click();
  await create(page, '文件', 'README.txt', picker);await expect(picker.getByRole('button', { name: '文件 README.txt', exact: true })).toBeVisible();
  await rename(page, 'README.txt', '说明.txt');
  await picker.getByRole('button', { name: '说明.txt 文件操作', exact: true }).click();await page.getByRole('menuitem', { name: /删除/ }).click();
  const deletion = page.getByRole('dialog', { name: '删除', exact: true });await deletion.getByRole('button', { name: '取消', exact: true }).click();
  expect(f.local.has('/workspace/中文项目/说明.txt')).toBe(true);
  await picker.getByRole('button', { name: '说明.txt 文件操作', exact: true }).click();await page.getByRole('menuitem', { name: /删除/ }).click();
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click();await expect(deletion).toHaveCount(0);
  expect(f.local.has('/workspace/中文项目/说明.txt')).toBe(false);
  await picker.getByRole('button', { name: '使用文件夹', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '项目路径', exact: true })).toHaveValue('/workspace/中文项目');
  await page.getByRole('button', { name: '添加项目', exact: true }).last().click();
  await expect.poll(() => mock.projects.some(project => project.path === '/workspace/中文项目')).toBe(true);
});

test('deleting an unsaved open file retains the recoverable text and requires confirmation', async ({ page, mock }) => {
  const f = await files(page, mock);await workspace(page);await create(page, '文件', 'draft.txt');
  await page.getByRole('textbox', { name: 'draft.txt 文件内容', exact: true }).fill('删除后也不能丢的草稿');
  await page.getByRole('button', { name: 'draft.txt 文件操作', exact: true }).click();await page.getByRole('menuitem', { name: /删除/ }).click();
  const dialog = page.getByRole('dialog', { name: '删除', exact: true });
  page.once('dialog', dialog => dialog.accept());await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog).toHaveCount(0);expect(f.local.has('/workspace/demo/draft.txt')).toBe(false);
  await expect(page.getByRole('textbox', { name: 'draft.txt 文件内容', exact: true })).toHaveText('删除后也不能丢的草稿');
  await expect(page.getByRole('region', { name: '文件预览', exact: true }).getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.getByText('磁盘文件已删除；未保存的文字草稿仍保留在此标签，可复制后另存。')).toBeVisible();
});

test('renaming a directory remaps open descendants and keeps unsaved edits after switching back', async ({ page, mock }) => {
  const f = await files(page, mock);
  f.local.set('/workspace/demo/source', { directory: true, revision: 1 });
  f.local.set('/workspace/demo/source/code.txt', { directory: false, content: '原文', revision: 1 });
  await workspace(page);await page.locator('.file-tree-row').filter({ hasText: 'source' }).click();
  await page.locator('.file-tree-row').filter({ hasText: 'code.txt' }).click();
  await page.getByRole('textbox', { name: 'code.txt 文件内容', exact: true }).fill('目录重命名保留草稿');
  await page.getByRole('button', { name: '上一级目录', exact: true }).click();
  await rename(page, 'source', 'new-source');
  await expect(page.locator('.chat-tabs .file-tab')).toHaveAttribute('data-file-path', '/workspace/demo/new-source/code.txt');
  await expect(page.getByRole('textbox', { name: 'code.txt 文件内容', exact: true })).toHaveText('目录重命名保留草稿');
  await page.getByRole('region', { name: '文件预览', exact: true }).getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => f.local.get('/workspace/demo/new-source/code.txt')?.content).toBe('目录重命名保留草稿');
});

test('a delayed mutation stays on its captured host and updates its saved tabs after navigation', async ({ page, mock }) => {
  const f = await files(page, mock);await workspace(page);await create(page, '文件', '跨主机.txt');
  await page.getByRole('textbox', { name: '跨主机.txt 文件内容', exact: true }).fill('原主机未保存内容');
  let release!: () => void;const pending = new Promise<void>(resolve => { release = resolve; });f.hold(() => pending);
  await page.getByRole('button', { name: '跨主机.txt 文件操作', exact: true }).click();await page.getByRole('menuitem', { name: /重命名/ }).click();
  const dialog = page.getByRole('dialog', { name: '重命名', exact: true });await dialog.getByRole('textbox', { name: '新名称', exact: true }).fill('只改原主机.txt');
  await dialog.getByRole('button', { name: '确认重命名', exact: true }).click();
  await expect.poll(() => f.requests.filter(request => request.body.operation === 'rename').length).toBe(1);
  // The operation dialog traps input; a programmatic route switch simulates
  // another navigation source while the server reply is still in flight.
  await page.locator('[data-section="recent"] [data-host-id="file-remote"] .thread-row').first().evaluate((button: HTMLElement) => button.click());
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'file-remote');
  await expect(dialog).toHaveCount(0);release();
  await expect(page.locator('.chat-tabs .file-tab[data-file-host="local"] [role="tab"]')).toHaveAccessibleName('只改原主机.txt');
  expect(f.remoteFiles.has('/workspace/demo/只改原主机.txt')).toBe(false);
  expect(f.requests.find(request => request.body.operation === 'rename')!.hostId).toBe('local');
  await create(page, '文件', '远端文件.txt');expect(f.remoteFiles.has('/workspace/demo/远端文件.txt')).toBe(true);
  expect(f.local.has('/workspace/demo/远端文件.txt')).toBe(false);
  await page.locator('.chat-tabs .file-tab[data-file-host="local"] [role="tab"]').click();
  await expect(page.getByRole('textbox', { name: '只改原主机.txt 文件内容', exact: true })).toHaveText('原主机未保存内容');
});

test('file menus stay in the viewport and support keyboard navigation without closing the project picker', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 600 });await files(page, mock);await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();await page.locator('.settings-button').click();
  await page.locator('.settings-nav').getByRole('button', { name: '项目', exact: true }).click();await page.getByRole('button', { name: '浏览项目文件夹', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择项目文件夹', exact: true });
  await picker.getByRole('button', { name: 'demo 文件操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /重命名/ })).toBeFocused();await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: /删除/ })).toBeFocused();await expect(page.getByRole('menuitem', { name: /删除/ })).toBeInViewport();
  await page.keyboard.press('Escape');await expect(page.getByRole('menu')).toHaveCount(0);await expect(picker).toBeVisible();
});
