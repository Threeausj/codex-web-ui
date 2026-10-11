import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const uploadDirectory = '/workspace/demo/.codex-web-uploads/12345678-abcd-4321-9876-123456789abc';
function editableTurn(mock: MockCodex) {
  mock.turns.get('thread-existing')!.push({ id: 'edit-attachment-turn', status: 'completed', itemsView: 'full',
    items: [
      { id: 'edit-attachment-user', type: 'userMessage', content: [
        { type: 'text', text: `原问题\n\n附件文件：${uploadDirectory}/0-old.txt（old.txt）`, text_elements: [] },
        { type: 'localImage', path: '/workspace/demo/old.png' },
      ] },
      { id: 'edit-attachment-answer', type: 'agentMessage', text: '旧回复' },
    ] });
}
async function openEditor(page: Page) {
  await login(page);
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveValue('原问题');
  await expect(page.locator('.edit-attachment')).toHaveCount(2);
}
async function uploads(page: Page, options: { fail?: boolean; hold?: boolean } = {}) {
  const bodies: Buffer[] = [];
  let release: (() => void) | undefined;
  await page.route('**/api/uploads', async route => {
    const body = route.request().postDataBuffer()!;
    bodies.push(body);
    if (options.hold) await new Promise<void>(resolve => { release = resolve; });
    if (options.fail) { options.fail = false; await route.fulfill({ status: 500, json: { error: 'Test edit upload failed' } }); return; }
    const names = [...body.toString().matchAll(/filename="([^"]+)"/g)].map(match => match[1]!);
    await route.fulfill({ status: 201, json: { files: names.map((name, index) => ({ name, path: `${uploadDirectory}/${index}-${name}`,
      mime: name.endsWith('.png') ? 'image/png' : 'text/plain', size: 4 })) } });
  });
  return { bodies, release: () => release?.() };
}

test('edit attachments can replace images and ordinary files without consuming the next composer draft', async ({ page, mock }) => {
  editableTurn(mock); const capture = await uploads(page);
  await openEditor(page);
  const composer = page.getByRole('textbox', { name: '消息输入框' });
  await composer.fill('下一条消息草稿');
  await page.getByRole('button', { name: '移除编辑附件 old.png' }).click();
  await page.getByRole('button', { name: '移除编辑附件 old.txt' }).click();
  await page.getByRole('textbox', { name: '编辑消息内容' }).fill('修改后问题');
  await page.getByLabel('上传编辑附件').setInputFiles([
    { name: 'new.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) },
    { name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('file') },
  ]);
  await expect(page.locator('.edit-attachment')).toHaveCount(2);
  await expect(page.locator('.composer .attachment')).toHaveCount(0);
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveCount(0);
  await expect(composer).toHaveValue('下一条消息草稿');
  const input = mock.request('turn/start')!.params.input;
  expect(input).toContainEqual({ type: 'localImage', path: `${uploadDirectory}/0-new.png` });
  expect(input).not.toContainEqual({ type: 'localImage', path: '/workspace/demo/old.png' });
  expect(input[0].text).toBe(`修改后问题\n\n附件文件：${uploadDirectory}/1-new.txt（new.txt）`);
  expect(capture.bodies).toHaveLength(1);
});

test('pasted image aliases upload once and an attachment-only edit is accepted', async ({ page, mock }) => {
  editableTurn(mock); const capture = await uploads(page);
  await openEditor(page);
  await page.getByRole('button', { name: '移除编辑附件 old.png' }).click();
  await page.getByRole('button', { name: '移除编辑附件 old.txt' }).click();
  const editor = page.getByRole('textbox', { name: '编辑消息内容' });
  await editor.fill('');
  await expect(page.getByRole('button', { name: '保存并重新发送' })).toBeDisabled();
  const prevented = await editor.evaluate(element => {
    const clipboard = new DataTransfer();
    const bytes = new Uint8Array([137, 80, 78, 71]);
    clipboard.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    clipboard.items.add(new File([bytes], 'alias.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
    element.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.locator('.edit-attachment')).toHaveCount(1);
  expect(capture.bodies[0]!.toString().match(/filename=/g)).toHaveLength(1);
  await page.getByRole('button', { name: '保存并重新发送' }).click();
  await expect(editor).toHaveCount(0);
  expect(mock.request('turn/start')!.params.input).toEqual([
    { type: 'text', text: '', text_elements: [] }, { type: 'localImage', path: `${uploadDirectory}/0-paste.png` },
  ]);
});

test('upload and replacement failures retain edited files for retry and disable uploads during resend', async ({ page, mock }) => {
  editableTurn(mock); await uploads(page, { fail: true });
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: '编辑消息内容' });
  await editor.fill('保留编辑草稿');
  const picker = page.getByLabel('上传编辑附件');
  const newFile = { name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('file') };
  await picker.setInputFiles(newFile);
  await expect(page.locator('.message-edit-error')).toContainText('Test edit upload failed');
  await expect(editor).toHaveValue('保留编辑草稿');
  await expect(page.locator('.edit-attachment')).toHaveCount(2);
  await picker.setInputFiles(newFile);
  await expect(page.locator('.edit-attachment')).toHaveCount(3);
  mock.failTurnStartNext = true;
  await page.getByRole('button', { name: '保存并重新发送' }).click();
  await expect(page.locator('.message-edit-error')).toContainText('Test turn start failed');
  await expect(page.locator('.edit-attachment')).toHaveCount(3);
  await expect(editor).toHaveValue('保留编辑草稿');
  mock.holdTurnStartResponse = true;
  await page.getByRole('button', { name: '保存并重新发送' }).click();
  await expect(picker).toBeDisabled();
  await expect(page.getByRole('button', { name: '添加文件或图片', exact: true })).toBeDisabled();
  mock.releaseTurnStartResponse();
  await expect(editor).toHaveCount(0);
  expect(mock.requests.filter(request => request.method === 'thread/revert')).toHaveLength(1);
  expect(mock.request('turn/start')!.params.input[0].text).toContain(`附件文件：${uploadDirectory}/0-retry.txt（retry.txt）`);
});

test('canceling a pending upload releases the inline draft and never appends files to another composer', async ({ page, mock }) => {
  editableTurn(mock); const capture = await uploads(page, { hold: true });
  await openEditor(page);
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    const lifecycle = { created: 0, revoked: 0 };
    (window as any).editBlobLifecycle = lifecycle;
    URL.createObjectURL = value => { lifecycle.created++; return create(value); };
    URL.revokeObjectURL = value => { lifecycle.revoked++; revoke(value); };
  });
  await page.getByLabel('上传编辑附件').setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  await expect(page.getByRole('button', { name: '正在上传…' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存并重新发送' })).toBeDisabled();
  await page.locator('.message-editor').getByRole('button', { name: '取消', exact: true }).click();
  capture.release();
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveCount(0);
  await expect(page.locator('.attachment')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).editBlobLifecycle)).toEqual({ created: 1, revoked: 1 });
  expect(mock.request('thread/revert')).toBeUndefined();
});

test('refreshing the same conversation retains a completed upload in the captured editor', async ({ page, mock }) => {
  editableTurn(mock); const capture = await uploads(page, { hold: true });
  await openEditor(page);
  await page.getByRole('textbox', { name: '编辑消息内容' }).fill('同步时保留的附件草稿');
  await page.getByLabel('上传编辑附件').setInputFiles({ name: 'refresh.txt', mimeType: 'text/plain', buffer: Buffer.from('file') });
  await expect(page.getByRole('button', { name: '正在上传…' })).toBeVisible();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveValue('同步时保留的附件草稿');
  capture.release();
  await expect(page.locator('.edit-attachment')).toHaveCount(3);
  await page.getByRole('button', { name: '保存并重新发送' }).click();
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveCount(0);
  expect(mock.request('turn/start')!.params.input[0].text).toContain(`附件文件：${uploadDirectory}/0-refresh.txt（refresh.txt）`);
});

test('a late edited upload cannot leak a local path into a newly selected remote conversation', async ({ page, mock }) => {
  const remote = new MockCodex();
  mock.hosts.push({ id: 'edit-remote', name: '编辑附件远端', kind: 'ssh', cwd: '/srv' });
  mock.projects.push({ id: 'edit-project', name: '远端编辑项目', hostId: 'edit-remote', path: '/srv/project', source: 'web' });
  mock.hostMocks.set('edit-remote', remote);
  editableTurn(mock); const capture = await uploads(page, { hold: true });
  await openEditor(page);
  await page.getByLabel('上传编辑附件').setInputFiles({ name: 'local-only.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  await expect(page.getByRole('button', { name: '正在上传…' })).toBeVisible();
  await page.locator('.new-thread-button').click();
  await page.getByRole('combobox', { name: '新对话主机', exact: true }).selectOption('edit-remote');
  await expect(page.getByRole('combobox', { name: '新对话主机', exact: true })).toHaveValue('edit-remote');
  capture.release();
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveCount(0);
  await expect(page.locator('.attachment')).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('远端独立问题');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => remote.request('turn/start')?.params.input).toEqual([{ type: 'text', text: '远端独立问题', text_elements: [] }]);
  expect(mock.request('thread/revert')).toBeUndefined();
});

test('mobile inline editing exposes its file picker and keeps long attachment names within the message', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  editableTurn(mock); await uploads(page);
  await openEditor(page);
  const choose = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加文件或图片', exact: true }).click();
  const fileName = '需要替换的非常长文件名称-'.repeat(5) + '.txt';
  await (await choose).setFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from('file') });
  await expect(page.locator('.edit-attachment')).toHaveCount(3);
  const layout = await page.locator('.message-editor').evaluate(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, width: document.documentElement.clientWidth,
      attachments: [...element.querySelectorAll('.edit-attachment')].map(attachment => {
        const bounds = attachment.getBoundingClientRect(); return { left: bounds.left, right: bounds.right };
      }) };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.width);
  for (const attachment of layout.attachments) {
    expect(attachment.left).toBeGreaterThanOrEqual(layout.left);
    expect(attachment.right).toBeLessThanOrEqual(layout.right);
  }
  await page.getByRole('button', { name: '移除编辑附件 old.png' }).click();
  await page.getByRole('button', { name: '移除编辑附件 old.txt' }).click();
  await page.getByRole('textbox', { name: '编辑消息内容' }).fill('');
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveCount(0);
  expect(mock.request('turn/start')!.params.input[0].text).toBe(`附件文件：${uploadDirectory}/0-${fileName}（${fileName}）`);
});
