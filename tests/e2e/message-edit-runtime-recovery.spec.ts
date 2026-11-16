import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const threadId = 'thread-existing';
const latestTurnId = 'runtime-edit-tail';
const uploadPath = '/workspace/demo/.codex-web-uploads/12345678-abcd-4321-9876-123456789abc/0-edit-notes.txt';
const editor = (page: Page) => page.getByRole('textbox', { name: '编辑消息内容', exact: true });
const save = (page: Page) => page.getByRole('button', { name: '保存并重新发送', exact: true });
function editable(mock: MockCodex) {
  mock.turns.get(threadId)!.push({ id: latestTurnId, status: 'completed', itemsView: 'full', error: null,
    items: [
      { id: 'runtime-edit-user', type: 'userMessage', content: [
        { type: 'text', text: '回退会卸载运行时的原问题', text_elements: [] },
        { type: 'localImage', path: '/workspace/demo/edit-reference.png' },
      ] },
      { id: 'runtime-edit-answer', type: 'agentMessage', text: '需要替换的原回复' },
    ] });
}
async function openEditor(page: Page, mock: MockCodex, settings = false) {
  editable(mock);
  await login(page);
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toBeVisible();
  if (settings) {
    await page.getByRole('combobox', { name: '选择模型', exact: true }).selectOption('mock-model-b');
    await page.getByRole('combobox', { name: '推理强度', exact: true }).selectOption('high');
    await page.getByRole('combobox', { name: '选择权限', exact: true }).selectOption('read-only');
  }
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('下一条独立消息草稿');
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await editor(page).fill('123 修正后的问题');
}
/** Native revert can retire its runtime before returning the retained prefix.
 * A history-only read is insufficient to restore the lost writer attachment. */
function unloadOnRevert(mock: MockCodex, event: 'notLoaded' | 'closed', options: { failResume?: boolean; holdResume?: boolean; resumeError?: string; timing?: 'history'; uncertainRevert?: boolean; resumeActive?: boolean } = {}) {
  let reverted = false, unloaded = false, failResume = options.failResume === true;
  let release: (() => void) | undefined;
  const receive = (mock as any).receive.bind(mock);
  const unload = (send: (raw: any) => void) => {
    unloaded = true;
    mock.threads.find(thread => thread.id === threadId)!.status = { type: 'notLoaded' };
    send(JSON.stringify(event === 'closed'
      ? { method: 'thread/closed', params: { threadId } }
      : { method: 'thread/status/changed', params: { threadId, status: { type: 'notLoaded' } } }));
  };
  (mock as any).receive = (socket: any, request: any) => {
    if (reverted && !unloaded && options.timing === 'history' && request.method === 'thread/turns/list' && request.params?.limit === 30)
      unload(socket.send.bind(socket));
    if (unloaded && request.method === 'thread/resume' && request.params?.threadId === threadId) {
      const resume = () => {
        if (failResume) {
          failResume = false;
          mock.requests.push(request);
          socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: options.resumeError || 'Test edit recovery resume failed' } }));
          return;
        }
        mock.threads.find(thread => thread.id === threadId)!.status = { type: options.resumeActive ? 'active' : 'idle' };
        receive(socket, request);
      };
      if (options.holdResume) { options.holdResume = false; release = resume; return; }
      resume(); return;
    }
    if (request.method === 'thread/revert' && !reverted) {
      const send = socket.send.bind(socket);
      const sink = Object.create(socket);
      sink.send = (raw: any) => {
        const response = JSON.parse(raw.toString());
        if (response.id === request.id && response.result) {
          reverted = true;
          if (!options.timing) unload(send);
          if (options.uncertainRevert) {
            send(JSON.stringify({ id: request.id, error: { code: -32000, message: 'Test revert acknowledgement lost', data: { uncertain: true } } }));
            return;
          }
        }
        send(raw);
      };
      receive(sink, request); return;
    }
    return receive(socket, request);
  };
  return { get unloaded() { return unloaded; }, get held() { return !!release; }, release() { release?.(); release = undefined; } };
}
function mutations(mock: MockCodex, method: string) { return mock.requests.filter(request => request.method === method); }

for (const [width, event, timing] of [[1440, 'notLoaded', undefined], [390, 'closed', undefined], [1440, 'notLoaded', 'history']] as const)
  test(`${width}px ${timing || 'before receipt'}: editing after native ${event} reattaches once and preserves edited files and the independent composer draft`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 900 });
    const runtime = unloadOnRevert(mock, event, { timing });
    await page.route('**/api/uploads', route => route.fulfill({ status: 201, json: {
      files: [{ name: 'edit-notes.txt', path: uploadPath, mime: 'text/plain', size: 4 }],
    } }));
    await openEditor(page, mock, true);
    await page.getByLabel('上传编辑附件').setInputFiles({ name: 'edit-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('note') });
    await expect(page.locator('.edit-attachment')).toHaveCount(2);
    await save(page).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
    await expect(page.getByText('流式回复完成 ✅', { exact: true })).toBeVisible();
    await expect(page.getByText('需要替换的原回复', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('下一条独立消息草稿');
    expect(runtime.unloaded).toBe(true);
    expect(mutations(mock, 'thread/revert')).toHaveLength(1);
    expect(mutations(mock, 'thread/resume')).toHaveLength(2);
    expect(mutations(mock, 'turn/start')).toHaveLength(1);
    expect(mock.request('turn/start')!.params.model).toBe('mock-model-b');
    expect(mock.request('turn/start')!.params.effort).toBe('high');
    expect(mock.request('turn/start')!.params.sandboxPolicy.type).toBe('readOnly');
    expect(mock.request('turn/start')!.params.input).toContainEqual({ type: 'localImage', path: '/workspace/demo/edit-reference.png' });
    expect(mock.request('turn/start')!.params.input[0].text).toContain(`附件文件：${uploadPath}（edit-notes.txt）`);
    expect(mutations(mock, 'thread/start')).toHaveLength(0);
    expect(mutations(mock, 'turn/steer')).toHaveLength(0);
    expect(mutations(mock, 'turn/interrupt')).toHaveLength(0);
  });

test('a failed edit reattachment keeps the same draft retryable without reverting another turn', async ({ page, mock }) => {
  unloadOnRevert(mock, 'notLoaded', { failResume: true });
  await openEditor(page, mock);
  await save(page).click();
  await expect(page.locator('.message-edit-error')).toContainText('Test edit recovery resume failed');
  await expect(editor(page)).toHaveValue('123 修正后的问题');
  await expect(save(page)).toBeEnabled();
  await expect(page.locator('.composer').getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  expect(mutations(mock, 'turn/start')).toHaveLength(0);
  expect(mock.turns.get(threadId)!.map(turn => turn.id)).toEqual(['turn-history']);
  await save(page).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  expect(mutations(mock, 'thread/revert')).toHaveLength(1);
  expect(mutations(mock, 'thread/resume')).toHaveLength(3);
  expect(mutations(mock, 'turn/start')).toHaveLength(1);
});

test('a new turn from another client during edit reattachment cannot receive replacement input', async ({ page, mock }) => {
  const runtime = unloadOnRevert(mock, 'notLoaded', { holdResume: true });
  await openEditor(page, mock);
  await save(page).click();
  await expect.poll(() => runtime.held).toBe(true);
  expect(mutations(mock, 'turn/start')).toHaveLength(0);
  const external = { id: 'runtime-external-turn', status: 'inProgress', itemsView: 'full', error: null,
    items: [{ id: 'runtime-external-user', type: 'userMessage', content: [{ type: 'text', text: '其他客户端的新任务', text_elements: [] }] }] };
  mock.turns.get(threadId)!.push(external);
  mock.emit('turn/started', { threadId, turn: external });
  runtime.release();
  await expect(page.locator('.message-edit-error')).toContainText('其他客户端更新');
  await expect(editor(page)).toHaveValue('123 修正后的问题');
  expect(mutations(mock, 'thread/revert')).toHaveLength(1);
  expect(mutations(mock, 'turn/start')).toHaveLength(0);
  expect(mutations(mock, 'turn/steer')).toHaveLength(0);
});


test('a second native unload while edit reattachment is pending cannot authorize sending', async ({ page, mock }) => {
  const runtime = unloadOnRevert(mock, 'notLoaded', { holdResume: true });
  await openEditor(page, mock);
  await save(page).click();
  await expect.poll(() => runtime.held).toBe(true);
  mock.emit('thread/status/changed', { threadId, status: { type: 'notLoaded' } });
  runtime.release();
  await expect(page.locator('.message-edit-error')).toBeVisible();
  await expect(editor(page)).toHaveValue('123 修正后的问题');
  expect(mutations(mock, 'thread/revert')).toHaveLength(1);
  expect(mutations(mock, 'turn/start')).toHaveLength(0);
  expect(mutations(mock, 'turn/steer')).toHaveLength(0);
  await page.locator('.message-editor').getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('下一条独立消息草稿');
});

test('an edit reattachment writer conflict preserves the draft and cannot take over another client', async ({ page, mock }) => {
  unloadOnRevert(mock, 'notLoaded', { failResume: true, resumeError: 'thread thread-existing already has an active writer' });
  await openEditor(page, mock);
  await save(page).click();
  await expect(page.locator('.message-edit-error')).toBeVisible();
  await expect(editor(page)).toHaveValue('123 修正后的问题');
  expect(mutations(mock, 'thread/revert')).toHaveLength(1);
  expect(mutations(mock, 'turn/start')).toHaveLength(0);
  expect(mutations(mock, 'turn/steer')).toHaveLength(0);
  expect(mutations(mock, 'turn/interrupt')).toHaveLength(0);
  expect(mutations(mock, 'thread/unsubscribe')).toHaveLength(0);
});

test('an uncertain revert acknowledgement never repeats its mutation or submits replacement input', async ({ page, mock }) => {
  unloadOnRevert(mock, 'notLoaded', { uncertainRevert: true });
  await openEditor(page, mock);
  await save(page).click();
  await expect(page.locator('.message-edit-error')).toContainText('Test revert acknowledgement lost');
  await expect(editor(page)).toHaveValue('123 修正后的问题');
  await editor(page).press('Control+Enter');
  expect(mutations(mock, 'thread/revert')).toHaveLength(1);
  expect(mutations(mock, 'turn/start')).toHaveLength(0);
  expect(mutations(mock, 'turn/steer')).toHaveLength(0);
  expect(mock.turns.get(threadId)!.map(turn => turn.id)).toEqual(['turn-history']);
});


test('an active native resume response without live notifications cannot authorize replacement input', async ({ page, mock }) => {
  unloadOnRevert(mock, 'notLoaded', { resumeActive: true });
  await openEditor(page, mock);
  await save(page).click();
  await expect(page.locator('.message-edit-error')).toContainText('其他客户端更新');
  await expect(editor(page)).toHaveValue('123 修正后的问题');
  expect(mutations(mock, 'thread/revert')).toHaveLength(1);
  expect(mutations(mock, 'turn/start')).toHaveLength(0);
  expect(mutations(mock, 'turn/steer')).toHaveLength(0);
  expect(mutations(mock, 'turn/interrupt')).toHaveLength(0);
});

for (const changed of ['none', 'profile', 'reviewer'] as const)
  test(`native permission provenance ${changed === 'none' ? 'survives' : `changed ${changed} blocks`} edit reattachment`, async ({ page, mock }) => {
    mock.preferences.defaultPermission = 'workspace-write';
    mock.preferences.defaultPermissionExplicit = false;
    const receive = (mock as any).receive.bind(mock);
    let resumes = 0;
    (mock as any).receive = (socket: any, request: any) => {
      if (request.method !== 'thread/resume') return receive(socket, request);
      mock.requests.push(request);
      const recovering = ++resumes > 1;
      const profile = recovering && changed === 'profile' ? 'different-native-profile' : 'saved-native-profile';
      const reviewer = recovering && changed === 'reviewer' ? 'auto_review' : 'user';
      // Key order differs between native replies; equivalent grants must not
      // fail restoration merely because a serializer reordered their fields.
      const sandbox = recovering
        ? { excludeSlashTmp: true, networkAccess: true, type: 'workspaceWrite', excludeTmpdirEnvVar: true, writableRoots: ['/workspace/demo', '/approved/data'] }
        : { type: 'workspaceWrite', writableRoots: ['/workspace/demo', '/approved/data'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
      socket.send(JSON.stringify({ id: request.id, result: {
        thread: mock.threads.find(thread => thread.id === threadId), model: mock.config.model, reasoningEffort: 'medium', sandbox,
        approvalPolicy: { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: true, mcp_elicitations: false } },
        activePermissionProfile: { id: profile, extends: ':workspace' }, approvalsReviewer: reviewer,
      } }));
    };
    unloadOnRevert(mock, 'notLoaded');
    await openEditor(page, mock);
    await expect(page.getByRole('combobox', { name: '选择权限', exact: true })).toHaveValue('resumed');
    await save(page).click();
    if (changed === 'none') {
      await expect(editor(page)).toHaveCount(0);
      await expect(page.getByText('流式回复完成 ✅', { exact: true })).toBeVisible();
      expect(mutations(mock, 'turn/start')).toHaveLength(1);
      expect(mock.request('turn/start')!.params).not.toHaveProperty('sandboxPolicy');
      expect(mock.request('turn/start')!.params).not.toHaveProperty('approvalPolicy');
      expect(mock.request('turn/start')!.params).not.toHaveProperty('permissions');
    } else {
      await expect(page.locator('.message-edit-error')).toContainText('恢复后的会话权限已变化');
      await expect(editor(page)).toHaveValue('123 修正后的问题');
      expect(mutations(mock, 'turn/start')).toHaveLength(0);
      expect(mutations(mock, 'turn/steer')).toHaveLength(0);
    }
    expect(mutations(mock, 'thread/resume')).toHaveLength(2);
    expect(mutations(mock, 'thread/revert')).toHaveLength(1);
    expect(mock.requests.filter(request => request.method === 'thread/resume').every(request =>
      !('sandbox' in request.params) && !('approvalPolicy' in request.params) && !('permissions' in request.params))).toBe(true);
  });
