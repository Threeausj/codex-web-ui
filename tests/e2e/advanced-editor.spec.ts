import { test, expect, login, slash } from './fixtures';
import type { Page } from '@playwright/test';

async function replaceSource(page: Page, name: string, text: string) {
  // Let CodeMirror process its own select-all key binding before text input;
  // DOM-only fill can race an asynchronously loaded language compartment.
  const editor = page.getByRole('textbox', { name });
  await editor.click(); await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
  await expect(editor).toHaveText(text, { useInnerText: true });
}

test('multiple file drafts survive tab switches, bridge reconnection, panel closure and page reload', async ({ page, mock }) => {
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click(); await slash(page, 'terminal');
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await page.locator('.file-view-switch').getByRole('button', { name: '源码', exact: true }).click();
  await replaceSource(page, 'README.md 文件内容', '# Private draft\nUnsaved second line');
  await page.getByRole('button', { name: '返回文件列表' }).click();
  await page.locator('.file-tree-row').filter({ hasText: 'index.html' }).click();
  await replaceSource(page, 'index.html 文件内容', '<h1>Second draft</h1>');
  mock.emit('bridge/status', { connected: false }); mock.emit('bridge/status', { connected: true });
  await page.getByRole('navigation', { name: '已打开文件' }).getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'README.md 文件内容' })).toHaveText('# Private draftUnsaved second line');
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'README.md 文件内容' })).toContainText('Private draft');
  // Wait for a committed IndexedDB record rather than an arbitrary debounce.
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('codex-private-work', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const tx = open.result.transaction('records'); const rows = tx.objectStore('records').getAll(); rows.onsuccess = () => { resolve(rows.result.filter(row => JSON.stringify(row.value).includes('Second draft')).length); open.result.close(); }; };
  }))).toBeGreaterThan(0);
  // Hold just the file-workspace read receipt to simulate slow mobile
  // storage. The original saved tabs must survive the restoration window.
  await page.addInitScript(() => {
    const held: (() => void)[] = [];
    let holding = true, writes = 0;
    (window as any).draftReadProbe = { held, get writes() { return writes; }, release() { holding = false; held.splice(0).forEach(done => done()); } };
    const isWorkspace = (key: unknown) => { try { return JSON.parse(String(key))[1] === 'file-workspace'; } catch { return false; } };
    const get = IDBObjectStore.prototype.get, put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.get = function(key) {
      if (this.transaction.db.name === 'codex-private-work' && isWorkspace(key)) (this.transaction as any).holdDraftReceipt = true;
      return get.call(this, key);
    };
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.transaction.db.name === 'codex-private-work' && isWorkspace(value?.key)) writes++;
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(handler) {
      descriptor.set!.call(this, (event: Event) => {
        if (holding && (this as any).holdDraftReceipt && typeof handler === 'function') held.push(() => handler.call(this, event));
        else if (typeof handler === 'function') handler.call(this, event);
      });
    } });
  });
  await page.reload();
  const workspace = page.getByRole('button', { name: '切换工作区', exact: true });
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  if (!await page.locator('.workspace-tabs').isVisible()) await workspace.click();
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).draftReadProbe.held.length)).toBeGreaterThan(0);
  // Keep restoration pending longer than the editor's persistence debounce.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).draftReadProbe.writes)).toBe(0);
  await page.evaluate(() => (window as any).draftReadProbe.release());
  await page.getByRole('navigation', { name: '已打开文件' }).getByRole('button', { name: 'index.html', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'index.html 文件内容' })).toHaveText('<h1>Second draft</h1>');
  expect(mock.requests.filter(request => request.method === 'fs/writeFile')).toHaveLength(0);
});

test('file links locate source lines and selected code is quoted with filename and line range', async ({ page, mock }) => {
  mock.turns.get('thread-existing')![0].items[1].text = '[第二行](/workspace/demo/README.md:2)';
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await page.getByRole('link', { name: '第二行', exact: true }).click();
  await expect(page.locator('.file-editor-footer')).toContainText('定位第 2 行');
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await page.locator('.code-selection-toolbar').getByRole('button', { name: '添加到对话', exact: true }).click();
  await expect(page.locator('.composer-quote')).toContainText('README.md');
  expect(mock.requests.some(request => request.method === 'turn/start')).toBe(false);
});

test('PDF files render locally with pagination and retain original download access', async ({ page, mock }) => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.params?.path?.endsWith('sample.pdf')) {
      if (request.method === 'fs/getMetadata') return socket.send(JSON.stringify({ id: request.id, result: { isDirectory: false, isFile: true } }));
      if (request.method === 'fs/readFile') return socket.send(JSON.stringify({ id: request.id, result: { dataBase64: Buffer.from(pdf).toString('base64') } }));
    }
    return receive(socket, request);
  };
  mock.turns.get('thread-existing')![0].items[1].text = '[PDF](/workspace/demo/sample.pdf)';
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click(); await page.getByRole('link', { name: 'PDF', exact: true }).click();
  const preview = page.getByRole('region', { name: 'PDF 预览' });
  await expect(preview).toContainText('1 / 2');
  await expect.poll(() => preview.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(0);
  await preview.getByRole('button', { name: '下一页' }).click(); await expect(preview).toContainText('2 / 2');
  await expect(page.getByRole('button', { name: '下载文件', exact: true })).toBeEnabled();
  expect(mock.requests.filter(request => request.method === 'fs/writeFile')).toHaveLength(0);
});
