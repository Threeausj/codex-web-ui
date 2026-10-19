import { test, expect, login, MockCodex, editSource } from './fixtures';
import type { Page } from '@playwright/test';

type Request = { id: string | number; method: string; params?: any };
type HeldReply = { socket: { send: (raw: string) => void }; request: Request; result: unknown };

function filesystem(mock: MockCodex, roots: Record<string, string[]>, files: Record<string, string>) {
  const receive = (mock as any).receive.bind(mock);
  const held: HeldReply[] = [];
  const hold = new Set<string>();
  const directories = new Set(Object.keys(roots));
  (mock as any).receive = (socket: HeldReply['socket'], request: Request) => {
    const path = request.params?.path;
    let result: unknown;
    if (request.method === 'fs/readDirectory' && directories.has(path)) {
      result = { entries: roots[path]!.map(fileName => ({ fileName, isDirectory: directories.has(`${path}/${fileName}`) })) };
    } else if (request.method === 'fs/readFile' && Object.hasOwn(files, path)) {
      result = { dataBase64: Buffer.from(files[path]!).toString('base64') };
    } else if (request.method === 'fs/getMetadata' && (directories.has(path) || Object.hasOwn(files, path))) {
      result = { isDirectory: directories.has(path), isFile: Object.hasOwn(files, path), isSymlink: false };
    } else if (!['fs/readDirectory', 'fs/readFile', 'fs/getMetadata'].includes(request.method)) {
      return receive(socket, request);
    } else {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: `No such file or directory (os error 2): ${path}` } }));
    }
    mock.requests.push(request);
    if (hold.has(`${request.method}:${path}`)) held.push({ socket, request, result });
    else socket.send(JSON.stringify({ id: request.id, result }));
  };
  return {
    hold,
    held,
    release(error?: string) {
      hold.clear();
      for (const { socket, request, result } of held.splice(0)) {
        // The previous host's WebSocket can already have been retired. File
        // reads use an independent HTTP response and still finish after it.
        socket.send(JSON.stringify({ id: request.id, ...(error ? { error: { code: -32000, message: error } } : { result }) }));
      }
    },
  };
}

function twoHosts(mock: MockCodex, aRoot = '/srv/alpha', bRoot = '/srv/beta') {
  const remote = new MockCodex();
  mock.threads[0] = { ...mock.threads[0], name: 'Alpha 会话', preview: 'Alpha 会话', cwd: aRoot };
  remote.threads[0] = { ...remote.threads[0], name: 'Beta 会话', preview: 'Beta 会话', cwd: bRoot };
  mock.hosts.push({ id: 'host-b', name: 'Beta 主机', kind: 'ssh', hostname: 'beta.invalid', cwd: bRoot });
  mock.projects = [
    { id: 'alpha-project', name: 'Alpha 项目', path: aRoot, hostId: 'local', source: 'web' },
    { id: 'beta-project', name: 'Beta 项目', path: bRoot, hostId: 'host-b', source: 'web' },
  ];
  mock.hostMocks.set('host-b', remote);
  return remote;
}

async function switchConversation(page: Page, hostId: string, name: string) {
  await page.locator(`[data-section="recent"] [data-host-id="${hostId}"] .thread-row`).filter({ hasText: name }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
}

async function openFiles(page: Page) {
  if (!await page.locator('.workspace-tabs').isVisible()) await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
}

test('switching hosts discards the previous host directory and pending file-link target', async ({ page, mock }) => {
  const remote = twoHosts(mock);
  mock.turns.get('thread-existing')![0].items[1].text = '[Alpha 源文件](/srv/alpha/docs/alpha.ts:1)';
  filesystem(mock, { '/srv/alpha': ['docs'], '/srv/alpha/docs': ['alpha.ts'] }, { '/srv/alpha/docs/alpha.ts': 'const alpha = true;' });
  filesystem(remote, { '/srv/beta': ['beta.ts'] }, { '/srv/beta/beta.ts': 'const beta = true;' });
  await login(page);
  await switchConversation(page, 'local', 'Alpha 会话');
  await openFiles(page);
  await page.locator('.file-tree-row').filter({ hasText: 'docs' }).click();
  await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue('/srv/alpha/docs');
  await page.getByRole('link', { name: 'Alpha 源文件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'alpha.ts 文件内容', exact: true })).toHaveText('const alpha = true;');
  await switchConversation(page, 'host-b', 'Beta 会话');
  await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue('/srv/beta');
  await expect(page.locator('.file-tree-row')).toHaveText(['beta.ts']);
  await expect(page.getByRole('navigation', { name: '已打开文件' })).toHaveCount(0);
  await expect(page.locator('.workspace-panel .panel-error')).toHaveCount(0);
  await expect(page.locator('.global-error')).toHaveCount(0);
  expect(remote.requests.filter(request => request.method?.startsWith('fs/') && request.params?.path?.startsWith('/srv/alpha'))).toEqual([]);
});

test('the same path on two hosts keeps separate unsaved tabs and restores each draft', async ({ page, mock }) => {
  const root = '/workspace/shared';
  const remote = twoHosts(mock, root, root);
  filesystem(mock, { [root]: ['shared.ts'] }, { [`${root}/shared.ts`]: 'const source = "alpha";' });
  filesystem(remote, { [root]: ['shared.ts'] }, { [`${root}/shared.ts`]: 'const source = "beta";' });
  await login(page);
  await switchConversation(page, 'local', 'Alpha 会话');
  await openFiles(page);
  await page.locator('.file-tree-row').filter({ hasText: 'shared.ts' }).click();
  await editSource(page, 'shared.ts 文件内容', 'const draft = "alpha unsaved";');
  await switchConversation(page, 'host-b', 'Beta 会话');
  await expect(page.locator('.file-tree-row')).toHaveText(['shared.ts']);
  await page.locator('.file-tree-row').filter({ hasText: 'shared.ts' }).click();
  await expect(page.getByRole('textbox', { name: 'shared.ts 文件内容', exact: true })).toHaveText('const source = "beta";');
  await editSource(page, 'shared.ts 文件内容', 'const draft = "beta unsaved";');
  await switchConversation(page, 'local', 'Alpha 会话');
  await expect(page.getByRole('textbox', { name: 'shared.ts 文件内容', exact: true })).toHaveText('const draft = "alpha unsaved";');
  await expect(page.locator('.file-editor-footer')).toContainText('未保存');
  await switchConversation(page, 'host-b', 'Beta 会话');
  await expect(page.getByRole('textbox', { name: 'shared.ts 文件内容', exact: true })).toHaveText('const draft = "beta unsaved";');
  await expect(page.locator('.file-editor-footer')).toContainText('未保存');
  expect([...mock.requests, ...remote.requests].filter(request => request.method === 'fs/writeFile')).toEqual([]);
});

test('late directory and file responses from Alpha cannot replace the selected Beta workspace', async ({ page, mock }) => {
  const remote = twoHosts(mock);
  mock.turns.get('thread-existing')![0].items[1].text = '[延迟源文件](/srv/alpha/late.ts:1)';
  const alpha = filesystem(mock, { '/srv/alpha': ['slow'], '/srv/alpha/slow': ['late-only.ts'] }, { '/srv/alpha/late.ts': 'const lateAlpha = true;' });
  filesystem(remote, { '/srv/beta': ['beta.ts'] }, { '/srv/beta/beta.ts': 'const beta = true;' });
  alpha.hold.add('fs/readDirectory:/srv/alpha/slow');
  alpha.hold.add('fs/readFile:/srv/alpha/late.ts');
  await login(page);
  await switchConversation(page, 'local', 'Alpha 会话');
  await openFiles(page);
  await page.locator('.file-tree-row').filter({ hasText: 'slow' }).click();
  await page.getByRole('link', { name: '延迟源文件', exact: true }).click();
  await expect.poll(() => alpha.held.length).toBe(2);
  await switchConversation(page, 'host-b', 'Beta 会话');
  await expect(page.locator('.file-tree-row')).toHaveText(['beta.ts']);
  alpha.release();
  await page.locator('.file-tree-row').filter({ hasText: 'beta.ts' }).click();
  await expect(page.getByRole('textbox', { name: 'beta.ts 文件内容', exact: true })).toHaveText('const beta = true;');
  await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue('/srv/beta');
  await expect(page.getByRole('navigation', { name: '已打开文件' })).not.toContainText('late.ts');
  await expect(page.locator('.workspace-panel .panel-error')).toHaveCount(0);
});

test('a file read failure received after leaving its host does not report an error on the new host', async ({ page, mock }) => {
  const remote = twoHosts(mock);
  mock.turns.get('thread-existing')![0].items[1].text = '[延迟失败的文件](/srv/alpha/missing.ts:1)';
  const alpha = filesystem(mock, { '/srv/alpha': ['missing.ts'] }, { '/srv/alpha/missing.ts': 'const beforeRemoval = true;' });
  filesystem(remote, { '/srv/beta': ['beta.ts'] }, { '/srv/beta/beta.ts': 'const beta = true;' });
  alpha.hold.add('fs/readFile:/srv/alpha/missing.ts');
  await login(page);
  await switchConversation(page, 'local', 'Alpha 会话');
  await page.getByRole('link', { name: '延迟失败的文件', exact: true }).click();
  await expect.poll(() => alpha.held.length).toBe(1);
  await switchConversation(page, 'host-b', 'Beta 会话');
  await expect(page.locator('.file-tree-row')).toHaveText(['beta.ts']);
  const failedRead = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/hosts/local/files' && url.searchParams.get('path') === '/srv/alpha/missing.ts';
  });
  alpha.release('No such file or directory (os error 2): /srv/alpha/missing.ts');
  const response = await failedRead;
  expect(response.status()).toBe(502);
  await response.finished();
  await page.locator('.file-tree-row').filter({ hasText: 'beta.ts' }).click();
  await expect(page.getByRole('textbox', { name: 'beta.ts 文件内容', exact: true })).toHaveText('const beta = true;');
  await expect(page.locator('.global-error')).toHaveCount(0);
  await expect(page.locator('.workspace-panel .panel-error')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue('/srv/beta');
});

test('reconnection keeps a browsed directory while selecting another project clears old directory errors', async ({ page, mock }) => {
  mock.threads[0] = { ...mock.threads[0], name: 'Alpha 会话', preview: 'Alpha 会话', cwd: '/srv/alpha' };
  mock.threads.push({ ...mock.threads[0], id: 'thread-gamma', name: 'Gamma 会话', preview: 'Gamma 会话', cwd: '/srv/gamma' });
  mock.projects = [
    { id: 'alpha-project', name: 'Alpha 项目', path: '/srv/alpha', hostId: 'local', source: 'web' },
    { id: 'gamma-project', name: 'Gamma 项目', path: '/srv/gamma', hostId: 'local', source: 'web' },
  ];
  filesystem(mock, { '/srv/alpha': ['docs'], '/srv/alpha/docs': ['alpha.ts'], '/srv/gamma': ['gamma.ts'] }, {});
  await login(page);
  await switchConversation(page, 'local', 'Alpha 会话');
  await openFiles(page);
  await page.locator('.file-tree-row').filter({ hasText: 'docs' }).click();
  await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue('/srv/alpha/docs');
  const requests = mock.requests.filter(request => request.method === 'fs/readDirectory').length;
  mock.emit('bridge/status', { connected: false });
  await expect(page.locator('.connection-banner')).toContainText('重连');
  mock.emit('bridge/status', { connected: true });
  await expect.poll(() => mock.requests.filter(request => request.method === 'fs/readDirectory').length).toBeGreaterThan(requests);
  await expect(page.locator('.file-tree-row')).toHaveText(['alpha.ts']);
  expect(mock.request('fs/readDirectory')?.params.path).toBe('/srv/alpha/docs');
  await page.getByRole('textbox', { name: '目录路径', exact: true }).fill('/srv/alpha/missing');
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(page.locator('.workspace-panel .panel-error')).toContainText('No such file or directory');
  await switchConversation(page, 'local', 'Gamma 会话');
  await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue('/srv/gamma');
  await expect(page.locator('.file-tree-row')).toHaveText(['gamma.ts']);
  await expect(page.locator('.workspace-panel .panel-error')).toHaveCount(0);
});
