import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const root = '/workspace/demo';
const directory = `${root}/outputs/压缩包`;
const filename = '13 例结果.zip';
const archivePath = `${directory}/${filename}`;

function fileNavigation(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: { send: (raw: string) => void }, request: any) => {
    const path = request.params?.path;
    let result: unknown;
    if (request.method === 'fs/getMetadata' && path === archivePath) {
      result = { isDirectory: false, isFile: true, isSymlink: false, createdAtMs: 0, modifiedAtMs: 0 };
    } else if (request.method === 'fs/readDirectory' && path === directory) {
      result = { entries: [{ fileName: filename, isDirectory: false }, { fileName: 'summary.json', isDirectory: false }] };
    } else return receive(socket, request);
    mock.requests.push(request);
    socket.send(JSON.stringify({ id: request.id, result }));
  };
  mock.turns.get('thread-existing')![0].items[1].text = `[更新后的 13 例 ZIP（1.17 GiB）](${encodeURI(archivePath)})`;
}

// Chromium hands a.download to its browser download manager outside Playwright
// routing. Assert that handoff's URL/filename here; server/file-download.test.ts
// separately verifies authentication, bounded transfer and exact response bytes.
async function attachmentRoutes(page: Page) {
  const previews: { hostId: string; path: string }[] = [];
  await page.route('**/api/hosts/*/files?**', route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('path') !== archivePath) return route.fallback();
    previews.push({ hostId: decodeURIComponent(url.pathname.split('/')[3]!), path: archivePath });
    return route.fulfill({ status: 413, json: { error: '文件超过 8 MB，请使用终端读取' } });
  });
  return { previews };
}

async function selectHistory(page: Page, hostId = 'local') {
  const openSidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await openSidebar.isVisible()) await openSidebar.click();
  await page.locator(`[data-section="recent"] [data-host-id="${hostId}"] .thread-row`).first().click();
  await expect(page.getByRole('link', { name: '更新后的 13 例 ZIP（1.17 GiB）', exact: true })).toBeVisible();
}

for (const mobile of [false, true]) {
  test(`a too-large conversation file opens its directory and downloads without Base64 RPC (${mobile ? 'phone' : 'desktop'})`, async ({ page, mock }) => {
    fileNavigation(mock);
    const { previews } = await attachmentRoutes(page);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await selectHistory(page);
    await page.getByRole('link', { name: '更新后的 13 例 ZIP（1.17 GiB）', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue(directory);
    await expect(page.locator('.file-tree-row').filter({ hasText: filename })).toBeVisible();
    await expect(page.locator('.code-editor')).toHaveCount(0);
    await expect(page.locator('.global-error')).toHaveCount(0);
    expect(previews).toEqual([{ hostId: 'local', path: archivePath }]);
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: `下载 ${filename}`, exact: true }).click();
    const download = await downloadReady;
    expect(download.suggestedFilename()).toBe(filename);
    const url = new URL(download.url());
    expect(url.pathname).toBe('/api/hosts/local/download');
    expect(url.searchParams.get('path')).toBe(archivePath);
    expect(mock.requests.filter(request => request.method === 'fs/readFile' && request.params.path === archivePath)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('a failed preview replaces the previous editor and clears a stale filename filter on the selected remote host', async ({ page, mock }) => {
  const remote = new MockCodex();
  fileNavigation(remote);
  mock.hosts.push({ id: 'remote-gpu', name: 'RTX5090x8', kind: 'ssh', hostname: 'gpu.invalid', cwd: root });
  mock.hostMocks.set('remote-gpu', remote);
  mock.projects.push({ id: 'remote-demo', name: 'GPU Project', hostId: 'remote-gpu', path: root, source: 'web' });
  await attachmentRoutes(page);
  await login(page);
  await selectHistory(page, 'remote-gpu');
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索文件名', exact: true }).fill('README');
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await expect(page.getByRole('region', { name: 'Markdown 文件预览' })).toBeVisible();
  await page.getByRole('link', { name: '更新后的 13 例 ZIP（1.17 GiB）', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue(directory);
  await expect(page.getByRole('textbox', { name: '搜索文件名', exact: true })).toHaveValue('');
  await expect(page.locator('.file-tree-row').filter({ hasText: filename })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Markdown 文件预览' })).toHaveCount(0);
  // The tab survives for later reading; only the failed link's containing
  // directory becomes active, so an unsaved file cannot be silently discarded.
  await expect(page.getByRole('navigation', { name: '已打开文件' })).toContainText('README.md');
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: `下载 ${filename}`, exact: true }).click();
  const download = await downloadReady;
  const url = new URL(download.url());
  expect(url.pathname).toBe('/api/hosts/remote-gpu/download');
  expect(url.searchParams.get('path')).toBe(archivePath);
  expect(mock.requests.filter(request => request.method?.startsWith('fs/') && request.params?.path === archivePath)).toEqual([]);
  await expect(page.locator('.global-error')).toHaveCount(0);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`returning to a cached editor discards a late file ${outcome} from an earlier link`, async ({ page, mock }) => {
    const cachedPath = `${root}/cached.txt`, latePath = `${root}/late.txt`;
    mock.turns.get('thread-existing')![0].items[1].text = `[已缓存 B](${cachedPath}) [挂起 A](${latePath})`;
    let release: (() => void) | undefined;
    const receive = (mock as any).receive.bind(mock);
    (mock as any).receive = (socket: { send: (raw: string) => void }, request: any) => {
      const path = request.params?.path;
      if (request.method === 'fs/getMetadata' && [cachedPath, latePath].includes(path)) {
        mock.requests.push(request);
        socket.send(JSON.stringify({ id: request.id, result: { isDirectory: false, isFile: true, isSymlink: false } }));
        return;
      }
      if (request.method === 'fs/readFile' && [cachedPath, latePath].includes(path)) {
        mock.requests.push(request);
        if (path === cachedPath) {
          socket.send(JSON.stringify({ id: request.id, result: { dataBase64: Buffer.from('cached B remains selected').toString('base64') } }));
        } else release = () => socket.send(JSON.stringify({ id: request.id, ...(outcome === 'success'
          ? { result: { dataBase64: Buffer.from('late A must not replace cached B').toString('base64') } }
          : { error: { code: -32000, message: 'late A cannot be read' } }) }));
        return;
      }
      return receive(socket, request);
    };
    await login(page);
    await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').first().click();
    await page.getByRole('link', { name: '已缓存 B', exact: true }).click();
    const cachedEditor = page.getByRole('textbox', { name: 'cached.txt 文件内容', exact: true });
    await expect(cachedEditor).toHaveText('cached B remains selected');
    await page.getByRole('link', { name: '挂起 A', exact: true }).click();
    await expect.poll(() => !!release).toBe(true);
    await page.getByRole('link', { name: '已缓存 B', exact: true }).click();
    await expect(cachedEditor).toHaveText('cached B remains selected');
    const lateResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/hosts/local/files' && url.searchParams.get('path') === latePath;
    });
    release!();
    const response = await lateResponse;
    expect(response.status()).toBe(outcome === 'success' ? 200 : 502);
    await response.finished();
    // Let the browser consume the completed HTTP response and render its next
    // frame before checking that the stale success/error had no effect.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(cachedEditor).toHaveText('cached B remains selected');
    await expect(page.getByRole('navigation', { name: '已打开文件' })).not.toContainText('late.txt');
    await expect(page.locator('.workspace-panel .panel-error, .global-error')).toHaveCount(0);
    expect(mock.requests.filter(request => request.method === 'fs/readFile' && request.params.path === cachedPath)).toHaveLength(1);
  });
}
