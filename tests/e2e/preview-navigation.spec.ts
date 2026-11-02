import { test, expect, login, editSource, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

type Request = { id: string | number; method: string; params?: any };
type HeldReply = { socket: { send: (raw: string) => void }; request: Request; result: unknown };
const alphaRoot = '/srv/preview-alpha';
const betaRoot = '/srv/preview-beta';
const sourcePath = `${alphaRoot}/alpha.ts`;
const sourceText = 'const alphaSource = true;';

function conversations(mock: MockCodex, sameDirectory = false) {
  const original = structuredClone(mock.threads[0]!);
  mock.threads = [
    { ...original, name: 'Alpha 会话', preview: 'Alpha 会话', cwd: alphaRoot },
    { ...original, id: 'thread-beta', name: 'Beta 会话', preview: 'Beta 会话', cwd: sameDirectory ? alphaRoot : betaRoot },
  ];
  mock.projects = [
    { id: 'preview-alpha', name: 'Alpha 项目', path: alphaRoot, hostId: 'local', source: 'web' },
    { id: 'preview-beta', name: 'Beta 项目', path: betaRoot, hostId: 'local', source: 'web' },
  ];
  mock.turns.get('thread-existing')![0].items[1].text = `[Alpha 源文件](${sourcePath}:1)`;
  const beta = structuredClone(mock.turns.get('thread-existing')!);
  beta[0].id = 'beta-history';
  beta[0].items[1].text = 'Beta 目录的聊天内容';
  mock.turns.set('thread-beta', beta);
}
function filesystem(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  const held: HeldReply[] = [];
  const hold = new Set<string>();
  (mock as any).receive = (socket: HeldReply['socket'], request: Request) => {
    const path = request.params?.path;
    let result: unknown;
    if (request.method === 'fs/getMetadata' && path === sourcePath)
      result = { isDirectory: false, isFile: true, isSymlink: false };
    else if (request.method === 'fs/readDirectory' && [alphaRoot, betaRoot].includes(path))
      result = { entries: [{ fileName: path === alphaRoot ? 'alpha.ts' : 'beta.ts', isDirectory: false }] };
    else if (request.method === 'fs/readFile' && path === sourcePath)
      result = { dataBase64: Buffer.from(sourceText).toString('base64') };
    else return receive(socket, request);
    mock.requests.push(request);
    if (hold.has(`${request.method}:${path}`)) held.push({ socket, request, result });
    else socket.send(JSON.stringify({ id: request.id, result }));
  };
  return {
    hold, held,
    release() {
      hold.clear();
      for (const { socket, request, result } of held.splice(0)) socket.send(JSON.stringify({ id: request.id, result }));
    },
  };
}
async function openConversation(page: Page, title: string) {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"] .thread-row').filter({ hasText: title }).first().click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
}
async function painted(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
const sourceReads = (mock: MockCodex) => mock.requests.filter(request =>
  ['fs/getMetadata', 'fs/readFile'].includes(request.method || '') && request.params?.path === sourcePath).map(request => request.method);

for (const width of [1440, 390]) test(`${width}px: returning to a conversation in another working directory retains chat and file drafts without replaying its file link`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 900 });
  conversations(mock); filesystem(mock);
  await login(page); await openConversation(page, 'Alpha 会话');
  const composer = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await composer.fill('Alpha 的未发送聊天草稿');
  await page.getByRole('link', { name: 'Alpha 源文件', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'alpha.ts 文件内容', exact: true });
  await expect(source).toHaveText(sourceText);
  await editSource(page, 'alpha.ts 文件内容', 'const alphaDraft = "unsaved";');
  const before = sourceReads(mock);
  await openConversation(page, 'Beta 会话');
  await composer.fill('Beta 的未发送聊天草稿');
  await page.getByRole('tab', { name: 'Alpha 会话', exact: true }).click();
  // A restored file tab is metadata; only an explicit click may select it.
  const fileTab = page.getByRole('tab', { name: 'alpha.ts', exact: true });
  await expect(fileTab).toBeVisible();
  if (width > 760) await expect(page.locator('.workspace-panel .file-tree-row')).toHaveText(['alpha.ts']);
  await painted(page);
  await expect(page.getByRole('tab', { name: 'Alpha 会话', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(fileTab).toHaveAttribute('aria-selected', 'false');
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue('Alpha 的未发送聊天草稿');
  await expect(page.locator('.center-file-preview')).toBeHidden();
  expect(sourceReads(mock)).toEqual(before);
  await fileTab.click();
  await expect(source).toBeVisible();
  await expect(source).toHaveText('const alphaDraft = "unsaved";');
  expect(sourceReads(mock)).toEqual(before);
  await page.getByRole('tab', { name: 'Beta 会话', exact: true }).click();
  await expect(composer).toHaveValue('Beta 的未发送聊天草稿');
  expect(mock.requests.filter(request => request.method === 'fs/writeFile')).toEqual([]);
});

for (const sameDirectory of [false, true]) for (const method of ['fs/getMetadata', 'fs/readFile']) test(`a pending ${method} cannot select a file after moving to ${sameDirectory ? 'another conversation in the same directory' : 'a different working directory'}`, async ({ page, mock }) => {
  conversations(mock, sameDirectory);
  const filesystemWire = filesystem(mock);
  filesystemWire.hold.add(`${method}:${sourcePath}`);
  await login(page); await openConversation(page, 'Alpha 会话');
  await page.getByRole('link', { name: 'Alpha 源文件', exact: true }).click();
  await expect.poll(() => filesystemWire.held.length).toBe(1);
  await openConversation(page, 'Beta 会话');
  const composer = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await composer.fill('切换后的 Beta 草稿');
  filesystemWire.release();
  await painted(page);
  await expect(page.getByRole('tab', { name: 'Beta 会话', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue('切换后的 Beta 草稿');
  await expect(page.locator('.center-file-preview')).toBeHidden();
  await expect(page.locator('.global-error, .workspace-panel .panel-error')).toHaveCount(0);
  const beforeReturn = sourceReads(mock);
  await page.getByRole('tab', { name: 'Alpha 会话', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Alpha 源文件', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-panel .file-tree-row')).toHaveText(['alpha.ts']);
  await painted(page);
  await expect(page.getByRole('tab', { name: 'Alpha 会话', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(sourceReads(mock)).toEqual(beforeReturn);
  // Retiring the earlier navigation must not consume the next deliberate click.
  await page.getByRole('link', { name: 'Alpha 源文件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'alpha.ts 文件内容', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'alpha.ts', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('top chat tabs keep three conversations selected across two hosts and two remote working directories without reopening saved previews', async ({ page, mock }) => {
  const remote = new MockCodex();
  const gammaRoot = '/srv/preview-gamma';
  const betaPath = `${betaRoot}/beta.ts`;
  const original = structuredClone(mock.threads[0]!);
  mock.threads = [{ ...original, name: 'Alpha 主机会话', preview: 'Alpha 主机会话', cwd: alphaRoot }];
  mock.turns.get('thread-existing')![0].items[1].text = `[Alpha 源文件](${sourcePath}:1)`;
  const remoteOriginal = structuredClone(remote.threads[0]!);
  remote.threads = [
    { ...remoteOriginal, id: 'remote-beta', name: 'Beta 远程会话', preview: 'Beta 远程会话', cwd: betaRoot },
    { ...remoteOriginal, id: 'remote-gamma', name: 'Gamma 远程会话', preview: 'Gamma 远程会话', cwd: gammaRoot },
  ];
  const betaTurns = structuredClone(remote.turns.get('thread-existing')!);
  betaTurns[0].id = 'remote-beta-history';
  betaTurns[0].items[1].text = `[Beta 源文件](${betaPath}:1)`;
  remote.turns.set('remote-beta', betaTurns);
  const gammaTurns = structuredClone(betaTurns);
  gammaTurns[0].id = 'remote-gamma-history';
  gammaTurns[0].items[1].text = '第三个标签页属于同一远程主机的其他工作目录';
  remote.turns.set('remote-gamma', gammaTurns);
  const hostId = 'preview-remote';
  mock.hosts.push({ id: hostId, name: '预览远程主机', kind: 'ssh', hostname: 'fixture.invalid', cwd: betaRoot });
  mock.hostMocks.set(hostId, remote);
  mock.projects = [
    { id: 'preview-alpha', name: 'Alpha 项目', path: alphaRoot, hostId: 'local', source: 'web' },
    { id: 'preview-beta', name: 'Beta 项目', path: betaRoot, hostId, source: 'web' },
    { id: 'preview-gamma', name: 'Gamma 项目', path: gammaRoot, hostId, source: 'web' },
  ];
  filesystem(mock);
  const receive = (remote as any).receive.bind(remote);
  (remote as any).receive = (socket: HeldReply['socket'], request: Request) => {
    const path = request.params?.path;
    let result: unknown;
    if (request.method === 'fs/getMetadata' && path === betaPath) result = { isDirectory: false, isFile: true, isSymlink: false };
    else if (request.method === 'fs/readDirectory' && [betaRoot, gammaRoot].includes(path)) result = { entries: [{ fileName: path === betaRoot ? 'beta.ts' : 'gamma.ts', isDirectory: false }] };
    else if (request.method === 'fs/readFile' && path === betaPath) result = { dataBase64: Buffer.from('const betaSource = true;').toString('base64') };
    else return receive(socket, request);
    remote.requests.push(request);
    socket.send(JSON.stringify({ id: request.id, result }));
  };
  const openRemote = async (title: string) => {
    await page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"] .thread-row`).filter({ hasText: title }).first().click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  };
  await login(page); await openConversation(page, 'Alpha 主机会话');
  await page.getByRole('link', { name: 'Alpha 源文件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'alpha.ts 文件内容', exact: true })).toBeVisible();
  await openRemote('Beta 远程会话');
  await page.getByRole('link', { name: 'Beta 源文件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'beta.ts 文件内容', exact: true })).toBeVisible();
  await openRemote('Gamma 远程会话');
  const baseline = () => [...mock.requests, ...remote.requests].filter(request =>
    ['fs/getMetadata', 'fs/readFile'].includes(request.method || '') && [sourcePath, betaPath].includes(request.params?.path)).map(request => `${request.method}:${request.params?.path}`);
  const before = baseline();
  for (const [title, filename] of [['Alpha 主机会话', 'alpha.ts'], ['Beta 远程会话', 'beta.ts'], ['Gamma 远程会话', 'gamma.ts'], ['Beta 远程会话', 'beta.ts'], ['Alpha 主机会话', 'alpha.ts']]) {
    await page.getByRole('tab', { name: title, exact: true }).click();
    await expect(page.locator('.workspace-panel .file-tree-row')).toHaveText([filename!]);
    await painted(page);
    await expect(page.getByRole('tab', { name: title, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeVisible();
    await expect(page.locator('.center-file-preview')).toBeHidden();
    expect(baseline()).toEqual(before);
  }
  await page.getByRole('tab', { name: 'Beta 远程会话', exact: true }).click();
  await page.getByRole('tab', { name: 'beta.ts', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'beta.ts 文件内容', exact: true })).toBeVisible();
  expect(baseline()).toEqual(before);
});

test('a failed background image restoration does not open the mobile workspace over the selected chat', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  conversations(mock); filesystem(mock);
  const imagePath = `${alphaRoot}/cached.png`;
  mock.turns.get('thread-existing')![0].items[1].text = `[旧图](${imagePath})`;
  const receive = (mock as any).receive.bind(mock);
  let failImage = false;
  let imageReads = 0;
  (mock as any).receive = (socket: HeldReply['socket'], request: Request) => {
    if (request.params?.path !== imagePath) return receive(socket, request);
    mock.requests.push(request);
    if (request.method === 'fs/getMetadata') return socket.send(JSON.stringify({ id: request.id, result: { isDirectory: false, isFile: true, isSymlink: false } }));
    if (request.method === 'fs/readFile') {
      imageReads++;
      return socket.send(JSON.stringify({ id: request.id, ...(failImage
        ? { error: { code: -32000, message: '旧图已删除' } }
        : { result: { dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kCioAAAAASUVORK5CYII=' } }) }));
    }
    return receive(socket, request);
  };
  await login(page); await openConversation(page, 'Alpha 会话');
  await page.getByRole('link', { name: '旧图', exact: true }).click();
  await expect(page.locator('.center-file-preview .file-image img')).toBeVisible();
  await expect(page.locator('.workspace-panel')).toBeHidden();
  await openConversation(page, 'Beta 会话');
  failImage = true;
  await page.getByRole('tab', { name: 'Alpha 会话', exact: true }).click();
  await expect.poll(() => imageReads).toBe(2);
  await painted(page);
  await expect(page.getByRole('tab', { name: 'Alpha 会话', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-panel')).toBeHidden();
  await expect(page.locator('.center-file-preview')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'cached.png', exact: true })).toBeVisible();
});
