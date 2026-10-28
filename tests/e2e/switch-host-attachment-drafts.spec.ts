import { test, expect, login, MockCodex } from './fixtures';
import type { Page, Route } from '@playwright/test';

const remoteId = 'draft-remote';
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+UqsAAAAASUVORK5CYII=', 'base64');
const image = (name: string) => ({ name, mimeType: 'image/png', buffer: imageBytes });
const document = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('unsent private file') });
const editor = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const attachments = (page: Page) => page.locator('.composer .attachment');
const tab = (page: Page, hostId: string, threadId = 'thread-existing') =>
  page.locator(`.chat-tab[data-host-id="${hostId}"][data-thread-id="${threadId}"]`).getByRole('tab');

function remoteFixture(mock: MockCodex) {
  const remote = new MockCodex();
  remote.threads[0]!.name = remote.threads[0]!.preview = '远端附件草稿';
  remote.turns.get('thread-existing')![0].items[1].text = '远端附件会话内容';
  mock.hosts.push({ id: remoteId, name: '附件草稿远端', kind: 'ssh', cwd: '/srv' });
  mock.projects.push({ ...mock.projects[0], id: 'draft-remote-project', hostId: remoteId });
  mock.hostMocks.set(remoteId, remote);
  return remote;
}
async function open(page: Page, hostId: string, threadId = 'thread-existing') {
  const existingTab = tab(page, hostId, threadId);
  if (await existingTab.count()) await existingTab.click();
  else {
    const name = threadId === 'other-draft' ? '另一份草稿' : hostId === remoteId ? '远端附件草稿' : '已有测试历史';
    await page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"] .thread-row`).filter({ hasText: name }).click();
  }
  await expect(tab(page, hostId, threadId)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
  await expect(page.locator('.conversation-loading')).toHaveCount(0);
  await expect(editor(page)).toBeEnabled();
}
type Upload = { hostId: string; names: string[]; body: Buffer };
async function uploads(page: Page, hold?: (upload: Upload) => Promise<void>) {
  const calls: Upload[] = [];
  await page.route('**/api/uploads', async (route: Route) => {
    const body = route.request().postDataBuffer()!;
    const raw = body.toString('utf8');
    const hostId = /name="hostId"\r\n\r\n([^\r\n]+)/.exec(raw)?.[1] || '';
    const names = [...raw.matchAll(/name="files"; filename="([^"]+)"/g)].map(match => match[1]!);
    const upload = { hostId, names, body }; calls.push(upload);
    await hold?.(upload);
    await route.fulfill({ status: 201, json: { files: names.map(name => ({
      name, path: `/${hostId}/draft-uploads/${name}`, mime: name.endsWith('.png') ? 'image/png' : 'text/plain',
      size: name.endsWith('.png') ? imageBytes.length : 19,
    })) } });
  });
  return calls;
}
async function imageDecoded(page: Page, name: string) {
  const preview = attachments(page).getByAltText(name, { exact: true });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
}

test('same-host chat switches restore image and file drafts and remove only the selected chat attachment', async ({ page, mock }) => {
  mock.threads.push({ ...mock.threads[0]!, id: 'other-draft', name: '另一份草稿', preview: '另一份草稿' });
  mock.turns.set('other-draft', []);
  const calls = await uploads(page);
  await login(page); await open(page, 'local');
  await editor(page).fill('第一条聊天的图片和文件');
  await page.locator('input[type="file"]').setInputFiles([image('first.png'), document('first.txt')]);
  await expect(attachments(page)).toHaveCount(2); await imageDecoded(page, 'first.png');
  await open(page, 'local', 'other-draft');
  await expect(attachments(page)).toHaveCount(0);
  await editor(page).fill('第二条聊天自己的文件');
  await page.locator('input[type="file"]').setInputFiles(document('second.txt'));
  await expect(attachments(page)).toHaveCount(1);
  await open(page, 'local');
  await expect(editor(page)).toHaveValue('第一条聊天的图片和文件');
  await expect(attachments(page)).toHaveCount(2); await imageDecoded(page, 'first.png');
  await attachments(page).filter({ hasText: 'first.png' }).getByRole('button', { name: '移除附件', exact: true }).click();
  await expect(attachments(page)).toHaveCount(1);
  await open(page, 'local', 'other-draft');
  await expect(attachments(page)).toHaveText(/second.txt/);
  await open(page, 'local');
  await expect(attachments(page)).toHaveText(/first.txt/);
  expect(calls).toHaveLength(2);
  expect(mock.sockets).toHaveLength(1);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('cross-host tabs keep independent binary drafts through live events and a reload, then send only destination paths', async ({ page, mock }) => {
  const remote = remoteFixture(mock), calls = await uploads(page);
  await login(page); await open(page, 'local');
  await editor(page).fill('本机保留的图文草稿');
  await page.locator('input[type="file"]').setInputFiles([image('local.png'), document('local.txt')]);
  await expect(attachments(page)).toHaveCount(2);
  await open(page, remoteId); await expect(attachments(page)).toHaveCount(0);
  await editor(page).fill('远端独立的图片草稿');
  await page.locator('input[type="file"]').setInputFiles(image('remote.png'));
  await expect(attachments(page)).toHaveCount(1);
  const late = { id: 'same-native-id-late-local', type: 'agentMessage', text: '仅属于本机的后台更新', phase: 'final_answer' };
  mock.turns.get('thread-existing')![0].items.push(late);
  mock.emit('item/completed', { threadId: 'thread-existing', turnId: 'turn-history', item: late });
  await expect(page.locator('.agent-message')).not.toContainText('仅属于本机的后台更新');
  await expect(editor(page)).toHaveValue('远端独立的图片草稿');
  await open(page, 'local');
  await expect(editor(page)).toHaveValue('本机保留的图文草稿');
  await expect(attachments(page)).toHaveCount(2); await imageDecoded(page, 'local.png');
  await expect(page.locator('.agent-message')).toContainText('仅属于本机的后台更新');
  expect(mock.sockets).toHaveLength(1); expect(remote.sockets).toHaveLength(1);
  await page.reload();
  await expect(editor(page)).toHaveValue('本机保留的图文草稿');
  await expect(attachments(page)).toHaveCount(2); await imageDecoded(page, 'local.png');
  await open(page, remoteId);
  await expect(editor(page)).toHaveValue('远端独立的图片草稿');
  await expect(attachments(page)).toHaveCount(1); await imageDecoded(page, 'remote.png');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => remote.request('turn/start')?.params.input).toContainEqual({ type: 'localImage', path: `/${remoteId}/draft-uploads/remote.png` });
  expect(JSON.stringify(remote.request('turn/start')?.params.input)).not.toContain('/local/draft-uploads/');
  await expect(attachments(page)).toHaveCount(0);
  await open(page, 'local');
  await expect(editor(page)).toHaveValue('本机保留的图文草稿');
  await expect(attachments(page)).toHaveCount(2);
  expect(calls.map(call => call.hostId)).toEqual(['local', remoteId]);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('an upload completing after a host switch joins its source draft without changing the current host draft', async ({ page, mock }) => {
  remoteFixture(mock);
  let release!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls = await uploads(page, async () => { started(); await gate; });
  await login(page); await open(page, 'local');
  await editor(page).fill('等待图片上传的本机草稿');
  await page.locator('input[type="file"]').setInputFiles(image('delayed.png'));
  await began;
  await open(page, remoteId);
  await editor(page).fill('上传期间写下的远端文字');
  await expect(attachments(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  release();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(editor(page)).toHaveValue('上传期间写下的远端文字');
  await expect(attachments(page)).toHaveCount(0);
  await open(page, 'local');
  await expect(editor(page)).toHaveValue('等待图片上传的本机草稿');
  await expect(attachments(page)).toHaveCount(1); await imageDecoded(page, 'delayed.png');
  expect(calls).toHaveLength(1);
});

test('clipboard byte comparison finishing after a host switch still uploads once to the original draft', async ({ page, mock }) => {
  remoteFixture(mock);
  const calls = await uploads(page);
  await login(page); await open(page, 'local');
  await editor(page).fill('剪贴板处理期间保留的图片草稿');
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (window as any).releaseClipboardRead = release;
    (window as any).clipboardReadStarted = false;
    File.prototype.arrayBuffer = async function () {
      if (this.name.startsWith('slow-paste-')) {
        (window as any).clipboardReadStarted = true;
        await gate;
      }
      return original.call(this);
    };
  });
  await editor(page).evaluate((element, bytes) => {
    const clipboard = new DataTransfer();
    for (const name of ['slow-paste-source.png', 'slow-paste-browser-alias.png'])
      clipboard.items.add(new File([Uint8Array.from(bytes)], name, { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, [...imageBytes]);
  await expect.poll(() => page.evaluate(() => (window as any).clipboardReadStarted)).toBe(true);
  await open(page, remoteId);
  await editor(page).fill('远端文字不能接收前一个剪贴板');
  expect(calls).toHaveLength(0);
  await page.evaluate(() => (window as any).releaseClipboardRead());
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]!.hostId).toBe('local');
  expect(calls[0]!.names).toEqual(['slow-paste-source.png']);
  await expect(attachments(page)).toHaveCount(0);
  await expect(editor(page)).toHaveValue('远端文字不能接收前一个剪贴板');
  await open(page, 'local');
  await expect(editor(page)).toHaveValue('剪贴板处理期间保留的图片草稿');
  await expect(attachments(page)).toHaveCount(1); await imageDecoded(page, 'slow-paste-source.png');
});

test('a delayed send acknowledgement clears only submitted attachments and preserves another chat draft', async ({ page, mock }) => {
  mock.threads.push({ ...mock.threads[0]!, id: 'other-draft', name: '另一份草稿', preview: '另一份草稿' });
  mock.turns.set('other-draft', []); await uploads(page);
  await login(page); await open(page, 'local');
  await editor(page).fill('这条图片消息将发送');
  await page.locator('input[type="file"]').setInputFiles(image('submitted.png'));
  await expect(attachments(page)).toHaveCount(1);
  mock.holdTurnStartResponse = true;
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.input).toContainEqual({ type: 'localImage', path: '/local/draft-uploads/submitted.png' });
  await open(page, 'local', 'other-draft');
  await editor(page).fill('另一条聊天不能被清空的草稿');
  mock.releaseTurnStartResponse();
  await page.locator('input[type="file"]').setInputFiles(image('retained.png'));
  await expect(attachments(page)).toHaveCount(1);
  await open(page, 'local');
  await expect(attachments(page)).toHaveCount(0);
  await open(page, 'local', 'other-draft');
  await expect(editor(page)).toHaveValue('另一条聊天不能被清空的草稿');
  await expect(attachments(page)).toHaveCount(1); await imageDecoded(page, 'retained.png');
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
});
