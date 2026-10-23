import { test, expect, login, MockCodex, editSource } from './fixtures';
import { docxFixture, pptxFixture, xlsxFixture } from './office-fixtures';
import Zip from 'jszip';

function files(mock: MockCodex, values: Record<string, Buffer>) {
  mock.turns.get('thread-existing')![0].items[1].text = Object.keys(values).map(name => `[${name}](/workspace/demo/${name})`).join('\n\n');
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    const name = String(request.params?.path || '').split('/').at(-1);
    if (request.method === 'fs/getMetadata' && values[name!]) {
      socket.send(JSON.stringify({ id: request.id, result: { isFile: true, isDirectory: false, size: values[name!]!.length } })); return;
    }
    if (request.method === 'fs/readDirectory' && request.params?.path === '/workspace/demo') {
      socket.send(JSON.stringify({ id: request.id, result: { entries: Object.keys(values).map(fileName => ({ fileName, isDirectory: false })) } })); return;
    }
    if (request.method === 'fs/readFile' && values[name!]) {
      mock.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, result: { dataBase64: values[name!]!.toString('base64') } })); return;
    }
    return receive(socket, request);
  };
}
async function open(page: any, name: string) {
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Office 文件预览', exact: true })).toBeVisible();
}
test('DOCX renders Chinese pages locally in a script-disabled frame without opening external relationships', async ({ page, mock }) => {
  files(mock, { '说明.docx': await docxFixture() });
  const remoteRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('office-private-preview.invalid')) remoteRequests.push(request.url()); });
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await open(page, '说明.docx');
  const frame = page.frameLocator('iframe[title="说明.docx 只读预览"]');
  await expect(frame.getByText('中文工作文档 · 第一页', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Office 页码', { exact: true })).toHaveText('1 / 2');
  await expect(frame.getByText('第二页的独立内容', { exact: true })).not.toBeVisible();
  await page.locator('.workspace-panel').screenshot({ path: '.data/office-docx-desktop.png' });
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(frame.getByText('第二页的独立内容', { exact: true })).toBeVisible();
  await expect(frame.getByText('中文工作文档 · 第一页', { exact: true })).not.toBeVisible();
  await expect(page.locator('iframe[title="说明.docx 只读预览"]')).toHaveAttribute('sandbox', 'allow-same-origin');
  expect(remoteRequests).toEqual([]);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
});
for (const extension of ['xlsx', 'xls']) test(`${extension} sheets paginate cached values and preserve literal cell text without executing HTML`, async ({ page, mock }) => {
  files(mock, { [`结果.${extension}`]: xlsxFixture(extension === 'xls') });
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await open(page, `结果.${extension}`);
  const table = page.getByRole('table', { name: '工作表内容', exact: true });
  await expect(table.getByRole('cell', { name: '病例编号', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '<img src="https://office-private-preview.invalid/image" onerror="alert(1)">', exact: true })).toBeVisible();
  await expect(table.locator('img,script')).toHaveCount(0);
  await expect(table.getByRole('cell', { name: '2', exact: true })).toBeVisible();
  await expect(page.getByLabel('Office 页码', { exact: true })).toHaveText('1 / 3');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(table.getByRole('cell', { name: '病例 50', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '病例编号', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '选择工作表', exact: true }).selectOption('1');
  await expect(table.getByRole('cell', { name: '第二个工作表', exact: true })).toBeVisible();
  await expect(page.getByLabel('Office 页码', { exact: true })).toHaveText('1 / 1');
});
test('PPTX renders one real slide at a time and cleans up when another file is opened', async ({ page, mock }) => {
  files(mock, { '报告.pptx': await pptxFixture(), '说明.docx': await docxFixture() });
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await open(page, '报告.pptx');
  const frame = page.frameLocator('iframe[title="报告.pptx 只读预览"]');
  await expect(frame.getByText('中文幻灯片 1', { exact: true })).toBeVisible();
  await page.locator('.workspace-panel').screenshot({ path: '.data/office-pptx-desktop.png' });
  await expect(page.getByLabel('Office 页码', { exact: true })).toHaveText('1 / 2');
  // This text carries an internal jump-to-slide-2 relationship. Read-only
  // previews keep page navigation in the toolbar, including for shape links.
  await frame.getByText('中文幻灯片 1', { exact: true }).click();
  await expect(frame.getByText('中文幻灯片 1', { exact: true })).toBeVisible();
  await expect(frame.getByText('中文幻灯片 2', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(frame.getByText('中文幻灯片 2', { exact: true })).toBeVisible();
  await expect(frame.getByText('中文幻灯片 1', { exact: true })).toHaveCount(0);
  await open(page, '说明.docx');
  await expect(page.locator('iframe[title="报告.pptx 只读预览"]')).toHaveCount(0);
  await expect(page.frameLocator('iframe[title="说明.docx 只读预览"]').getByText('中文工作文档 · 第一页', { exact: true })).toBeVisible();
});
test('damaged and legacy Office files retain download and retry actions without changing the file', async ({ page, mock }) => {
  const values = { '损坏.docx': Buffer.from('broken'), '旧版.doc': Buffer.from('legacy') };
  files(mock, values);
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await open(page, '损坏.docx');
  const region = page.getByRole('region', { name: 'Office 文件预览', exact: true });
  await expect(region.getByRole('alert')).toContainText('已损坏');
  await region.getByRole('button', { name: '重试预览', exact: true }).click();
  await expect(region.getByRole('alert')).toContainText('已损坏');
  const download = page.waitForEvent('download');
  await region.getByRole('button', { name: '下载原文件', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('损坏.docx');
  await open(page, '旧版.doc');
  await expect(region.getByRole('alert')).toContainText('旧版 DOC／PPT 暂不支持');
  await expect(region.getByRole('button', { name: '下载原文件', exact: true })).toBeVisible();
});

test('phone Office pages and sheet tabs remain usable without widening the application', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  files(mock, { '说明.docx': await docxFixture(), '结果.xlsx': xlsxFixture(false, true) });
  await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await open(page, '说明.docx');
  const frame = page.frameLocator('iframe[title="说明.docx 只读预览"]');
  await expect(frame.getByText('中文工作文档 · 第一页', { exact: true })).toBeVisible();
  await page.locator('.workspace-panel').screenshot({ path: '.data/office-docx-phone.png' });
  await page.getByRole('combobox', { name: 'Office 缩放', exact: true }).selectOption('50');
  await expect(page.getByRole('combobox', { name: 'Office 缩放', exact: true })).toHaveValue('50');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(frame.getByText('第二页的独立内容', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭工作区', exact: true }).click();
  await open(page, '结果.xlsx');
  await expect(page.getByRole('cell', { name: '病例编号', exact: true })).toBeVisible();
  const scroll = page.locator('.office-sheet-scroll');
  expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await scroll.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  expect(await scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await page.getByRole('combobox', { name: '选择工作表', exact: true }).selectOption('1');
  await expect(page.getByRole('cell', { name: '第二个工作表', exact: true })).toBeVisible();
  await page.locator('.workspace-panel').screenshot({ path: '.data/office-xlsx-phone.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('a DOCX at the exact 8 MiB boundary is previewed rather than rejected by Base64 rounding', async ({ page, mock }) => {
  const maximum = 8 * 1024 * 1024, zip = await Zip.loadAsync(await docxFixture());
  zip.file('preview-padding.bin', new Uint8Array(0));
  const overhead = (await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })).length;
  zip.file('preview-padding.bin', new Uint8Array(maximum - overhead));
  const bytes = Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }));
  expect(bytes.length).toBe(maximum);
  files(mock, { '边界.docx': bytes });
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await open(page, '边界.docx');
  await expect(page.frameLocator('iframe[title="边界.docx 只读预览"]').getByText('中文工作文档 · 第一页', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('switching hosts disposes Office rendering and restores the correct host document', async ({ page, mock }) => {
  const remote = new MockCodex();
  mock.threads[0] = { ...mock.threads[0], name: 'Alpha 会话' };
  remote.threads[0] = { ...remote.threads[0], name: 'Beta 会话' };
  mock.hosts.push({ id: 'host-b', name: 'Beta 主机', kind: 'ssh', hostname: 'beta.invalid', cwd: '/workspace/demo' });
  mock.projects.push({ id: 'beta', name: 'Beta 项目', path: '/workspace/demo', hostId: 'host-b', source: 'web' });
  mock.hostMocks.set('host-b', remote);
  files(mock, { '说明.docx': await docxFixture() });
  files(remote, { '结果.xlsx': xlsxFixture() });
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: 'Alpha 会话' }).click();
  await open(page, '说明.docx');
  await expect(page.frameLocator('iframe[title="说明.docx 只读预览"]').getByText('中文工作文档 · 第一页', { exact: true })).toBeVisible();
  await page.locator('[data-section="recent"] [data-host-id="host-b"] .thread-row').filter({ hasText: 'Beta 会话' }).click();
  await expect(page.locator('iframe[title="说明.docx 只读预览"]')).toHaveCount(0);
  await open(page, '结果.xlsx');
  await expect(page.getByRole('cell', { name: '病例编号', exact: true })).toBeVisible();
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: 'Alpha 会话' }).click();
  await expect(page.getByRole('table', { name: '工作表内容', exact: true })).toHaveCount(0);
  await expect(page.frameLocator('iframe[title="说明.docx 只读预览"]').getByText('中文工作文档 · 第一页', { exact: true })).toBeVisible();
});

test('inactive Office packages are re-read on tab return and text drafts survive Office cleanup', async ({ page, mock }) => {
  files(mock, { '说明.docx': await docxFixture(), '结果.xlsx': xlsxFixture(), '草稿.ts': Buffer.from('const original = true;') });
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await page.getByRole('link', { name: '草稿.ts', exact: true }).click();
  await editSource(page, '草稿.ts 文件内容', 'const draft = "仍未保存";');
  await open(page, '说明.docx');
  await expect(page.frameLocator('iframe[title="说明.docx 只读预览"]').getByText('中文工作文档 · 第一页', { exact: true })).toBeVisible();
  await open(page, '结果.xlsx');
  await expect(page.getByRole('cell', { name: '病例编号', exact: true })).toBeVisible();
  const docxReads = () => mock.requests.filter(request => request.method === 'fs/readFile' && request.params?.path === '/workspace/demo/说明.docx').length;
  expect(docxReads()).toBe(1);
  const tabs = page.getByRole('navigation', { name: '已打开文件', exact: true });
  await tabs.getByRole('button', { name: '说明.docx', exact: true }).click();
  await expect(page.frameLocator('iframe[title="说明.docx 只读预览"]').getByText('中文工作文档 · 第一页', { exact: true })).toBeVisible();
  expect(docxReads()).toBe(2);
  // Closing the current tab selects the inactive workbook, which must also
  // recover bytes instead of leaving a generic binary/download placeholder.
  await tabs.getByRole('button', { name: '关闭文件 说明.docx', exact: true }).click();
  await expect(page.getByRole('cell', { name: '病例编号', exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'fs/readFile' && request.params?.path === '/workspace/demo/结果.xlsx')).toHaveLength(2);
  await tabs.getByRole('button', { name: '草稿.ts', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '草稿.ts 文件内容', exact: true })).toHaveText('const draft = "仍未保存";');
  await expect(page.locator('.file-editor-footer')).toContainText('未保存');
  expect(mock.requests.filter(request => request.method === 'fs/writeFile')).toEqual([]);
});
