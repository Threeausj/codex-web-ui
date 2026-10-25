import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

function sidebarWire(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  const control = { sideId: 'retained-side-branch', releases: [] as string[] };
  (mock as any).receive = (socket: any, request: any) => {
    const params = request.params || {};
    const reply = (result: unknown) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'thread/goal/get') return reply({ goal: null });
    if (request.method === 'thread/unsubscribe') { control.releases.push(params.threadId); return reply({}); }
    if (request.method === 'thread/fork' && params.ephemeral) {
      const source = mock.threads.find(thread => thread.id === params.threadId)!;
      const thread = { ...source, id: control.sideId, ephemeral: true, forkedFromId: source.id, turns: [] };
      mock.turns.set(thread.id, []);
      return reply({ thread, model: mock.config.model, reasoningEffort: 'medium', sandbox: { type: 'readOnly' } });
    }
    return receive(socket, request);
  };
  return control;
}

async function openSidebar(page: Page) {
  await login(page);
  if ((page.viewportSize()?.width || 1280) <= 760) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建侧边聊天', exact: true }).click();
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`side questions accept keyboard input, punctuation and Chinese composition (${viewport.width}px)`, async ({ page, mock }) => {
    await page.setViewportSize(viewport);
    sidebarWire(mock);
    await openSidebar(page);
    const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
    await input.click();
    await input.pressSequentially('Explain this? @ /');
    await expect(input).toHaveValue('Explain this? @ /');
    await input.evaluate(element => {
      const field = element as HTMLTextAreaElement;
      field.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      field.value += ' 中文问题';
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: ' 中文问题', isComposing: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 229, isComposing: true }));
      field.dispatchEvent(new CompositionEvent('compositionend', { data: ' 中文问题' }));
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' 中文问题' }));
    });
    await expect(input).toHaveValue('Explain this? @ / 中文问题');
    expect(mock.request('turn/start')).toBeUndefined();
    await input.press('Shift+Enter');
    await input.pressSequentially('second line');
    await expect(input).toHaveValue('Explain this? @ / 中文问题\nsecond line');
    await expect(input).toBeFocused();
    await expect(page.getByRole('button', { name: '发送侧边问题', exact: true })).toBeEnabled();
  });
}

test('the mobile keyboard cannot push a quoted side question outside the visible panel', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  sidebarWire(mock);
  mock.turns.get('thread-existing')![0].items.find((item: any) => item.id === 'history-agent').text = '较长的引用内容\n'.repeat(24);
  await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await page.locator('[data-selection-item-id="history-agent"]').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '在侧边聊天中提问', exact: true }).click();
  const input = page.getByRole('textbox', { name: '围绕引用内容提问', exact: true });
  // The Android keyboard reduces the visible viewport to about half its height.
  await page.setViewportSize({ width: 390, height: 320 });
  const box = (await input.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(320);
  await input.click();
  await input.pressSequentially('typed with keyboard open');
  await expect(input).toHaveValue('typed with keyboard open');
  await expect(input).toBeFocused();
  await expect(page.getByRole('button', { name: '发送侧边问题', exact: true })).toBeInViewport();
});

test('hiding a running side chat keeps its streamed answer and editable follow-up draft', async ({ page, mock }) => {
  const wire = sidebarWire(mock);
  mock.holdFinalMessage = true;
  await openSidebar(page);
  const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
  await input.fill('最初的侧边问题');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止侧边回答', exact: true })).toBeVisible();
  await input.click();
  await input.pressSequentially('follow-up draft');
  await page.getByRole('button', { name: '收起侧边聊天', exact: true }).click();
  await expect(page.locator('#side-chat-panel')).toBeHidden();
  mock.finishStream();
  await page.getByRole('button', { name: '新建侧边聊天', exact: true }).click();
  await expect(page.locator('.side-chat-transcript')).toContainText('流式回复完成 ✅');
  await expect(input).toHaveValue('follow-up draft');
  expect(mock.requests.filter(request => request.method === 'thread/fork')).toHaveLength(1);
  expect(mock.requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(0);
  expect(wire.releases).toHaveLength(0);
});

test('ending a side chat requires confirmation; cancel and Escape keep answers and drafts', async ({ page, mock }) => {
  const wire = sidebarWire(mock);
  await openSidebar(page);
  const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
  await input.fill('已发送问题');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(page.locator('.side-chat-transcript')).toContainText('流式回复完成 ✅');
  await input.fill('未发送草稿');
  const end = page.getByRole('button', { name: '结束侧边聊天', exact: true });
  const dialog = page.getByRole('dialog', { name: '结束侧边聊天？', exact: true });
  await end.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('已保存的正式分支会保留');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toHaveValue('未发送草稿');
  await expect(input).toBeFocused();
  await end.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(wire.releases).toHaveLength(0);
  await end.click();
  await dialog.getByRole('button', { name: '确认结束', exact: true }).click();
  await expect(page.locator('#side-chat-panel')).toHaveCount(0);
  await expect.poll(() => wire.releases).toEqual([wire.sideId]);
  await page.getByRole('button', { name: '新建侧边聊天', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.side-chat-transcript')).not.toContainText('流式回复完成 ✅');
  expect(mock.requests.filter(request => request.method === 'thread/fork')).toHaveLength(1);
});

test('switching a main conversation retains the side branch, its original context and its draft', async ({ page, mock }) => {
  const wire = sidebarWire(mock);
  mock.threads.push({ ...mock.threads[0], id: 'another-parent', name: '另一个主对话', preview: '另一个主对话' });
  mock.turns.set('another-parent', []);
  await openSidebar(page);
  const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
  await input.fill('解释原对话');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(page.locator('.side-chat-transcript')).toContainText('流式回复完成 ✅');
  await input.fill('还要解释原对话');
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '另一个主对话' }).first().click();
  await expect(page.locator('.main-header')).toContainText('另一个主对话');
  await expect(page.locator('#side-chat-panel')).toBeHidden();
  await page.getByRole('button', { name: '新建侧边聊天', exact: true }).click();
  await expect(input).toHaveValue('还要解释原对话');
  await expect(page.locator('.side-chat-origin')).toContainText('已有测试历史');
  await expect(page.locator('.side-chat-context-notice')).toContainText('仍使用原对话上下文');
  await expect(page.getByRole('button', { name: '引用回答到主对话', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(2);
  expect(mock.requests.filter(request => request.method === 'turn/start').map(request => request.params.threadId)).toEqual([wire.sideId, wire.sideId]);
  expect(mock.turns.get('another-parent')).toHaveLength(0);
  expect(wire.releases).toHaveLength(0);
  await page.getByRole('button', { name: '返回原对话', exact: true }).click();
  await expect(page.locator('.main-header')).toContainText('已有测试历史');
  await expect(page.locator('#side-chat-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: '引用回答到主对话', exact: true })).toBeEnabled();
});

test('switching hosts keeps a side draft editable without sending to or ending it on the wrong host', async ({ page, mock }) => {
  const wire = sidebarWire(mock);
  const remote = new MockCodex();
  remote.threads[0] = { ...remote.threads[0], name: '远程主对话', preview: '远程主对话' };
  mock.hosts.push({ id: 'ssh-retained', name: '另一台服务器', kind: 'ssh', hostname: 'fixture.invalid', cwd: '/workspace/demo' });
  mock.projects.push({ ...mock.projects[0], id: 'remote-project', hostId: 'ssh-retained', name: 'Remote Project' });
  mock.hostMocks.set('ssh-retained', remote);
  await openSidebar(page);
  const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
  await input.fill('保留原主机上下文');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(page.locator('.side-chat-transcript')).toContainText('流式回复完成 ✅');
  await input.fill('original host draft');
  await page.locator('[data-section="recent"] [data-host-id="ssh-retained"] .thread-row').first().click();
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'ssh-retained');
  await page.getByRole('button', { name: '新建侧边聊天', exact: true }).click();
  await expect(input).toHaveValue('original host draft');
  await expect(input).toBeEditable();
  await input.click();
  await input.press('End');
  await input.pressSequentially(' continued offline');
  await expect(input).toHaveValue('original host draft continued offline');
  await expect(page.getByRole('button', { name: '发送侧边问题', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '结束侧边聊天', exact: true })).toBeDisabled();
  expect(remote.requests.filter(request => ['thread/fork', 'turn/start', 'turn/interrupt'].includes(request.method!))).toHaveLength(0);
  expect(wire.releases).toHaveLength(0);
  await page.getByRole('button', { name: '返回原对话', exact: true }).click();
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'local');
  await expect(page.locator('#side-chat-panel')).toBeVisible();
  await expect(input).toHaveValue('original host draft continued offline');
  await expect(page.getByRole('button', { name: '发送侧边问题', exact: true })).toBeEnabled();
});

test('mobile Back dismisses the end confirmation before hiding the retained side chat', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  sidebarWire(mock);
  await openSidebar(page);
  const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
  await input.fill('返回时保留草稿');
  await page.getByRole('button', { name: '结束侧边聊天', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '结束侧边聊天？', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#side-chat-panel')).toBeVisible();
  await expect(input).toHaveValue('返回时保留草稿');
  await page.evaluate(() => history.back());
  await expect(page.locator('#side-chat-panel')).toBeHidden();
  await page.getByRole('button', { name: '新建侧边聊天', exact: true }).click();
  await expect(input).toHaveValue('返回时保留草稿');
  expect(mock.request('thread/fork')).toBeUndefined();
});

test('a failed side send keeps its draft and reuses the accepted branch for explicit retry', async ({ page, mock }) => {
  sidebarWire(mock);
  mock.failTurnStartNext = true;
  await openSidebar(page);
  const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
  await input.fill('不要丢失这个问题');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(page.locator('.side-chat-error')).toContainText('Test turn start failed');
  await expect(input).toHaveValue('不要丢失这个问题');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(page.locator('.side-chat-transcript')).toContainText('流式回复完成 ✅');
  await expect(input).toHaveValue('');
  expect(mock.requests.filter(request => request.method === 'thread/fork')).toHaveLength(1);
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(2);
});

test('an ended native branch cannot clear its retained draft when an older start acknowledgement arrives', async ({ page, mock }) => {
  const wire = sidebarWire(mock);
  mock.holdTurnStartResponse = true;
  mock.holdFinalMessage = true;
  await openSidebar(page);
  const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
  await input.fill('等待回执的侧边问题');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(1);
  mock.emit('thread/closed', { threadId: wire.sideId });
  await expect(page.getByRole('button', { name: '发送侧边问题', exact: true })).toBeEnabled();
  mock.releaseTurnStartResponse();
  await expect.poll(() => wire.releases).toContain(wire.sideId);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(input).toHaveValue('等待回执的侧边问题');
  await expect(page.locator('.side-chat-panel')).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'thread/fork')).toHaveLength(1);
});
