import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

/** Native-looking sidebar wire responses, wholly isolated from live Codex. */
function selectionWire(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  const state = { sideThreadId: '', forks: 0, releases: [] as string[] };
  (mock as any).receive = (socket: any, request: any) => {
    const params = request.params || {};
    const reply = (result: unknown) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'skills/list') return reply({ data: [{ cwd: params.cwds?.[0], errors: [], skills: [{
      name: 'writer', description: '整理文档', enabled: true, path: '/test/skills/writer/SKILL.md', scope: 'user',
    }] }] });
    if (request.method === 'thread/goal/get') return reply({ goal: null });
    if (request.method === 'thread/unsubscribe') { state.releases.push(params.threadId); return reply({}); }
    if (request.method === 'thread/fork' && params.ephemeral) {
      state.sideThreadId = `side-question-${++state.forks}`;
      const source = mock.threads.find(thread => thread.id === params.threadId)!;
      const thread = { ...source, id: state.sideThreadId, name: null, preview: '', ephemeral: true, forkedFromId: params.threadId, turns: [] };
      mock.turns.set(thread.id, []);
      mock.emit('thread/started', { thread });
      return reply({ thread, model: mock.config.model, reasoningEffort: 'medium', sandbox: { type: 'readOnly' } });
    }
    return receive(socket, request);
  };
  return state;
}

async function selectHistory(page: Page, itemId = 'history-agent') {
  await login(page);
  if ((page.viewportSize()?.width || 1280) <= 760) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click();
  await expect(page.locator(`[data-selection-item-id="${itemId}"]`)).toBeVisible();
}

async function selectMessage(page: Page, itemId = 'history-agent') {
  const body = page.locator(`[data-selection-item-id="${itemId}"]`);
  await body.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))));
  await body.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.getByRole('toolbar', { name: '所选对话内容' })).toBeVisible();
}

test('adding a quotation preserves typed draft, uploaded attachment and selected skill', async ({ page, mock }) => {
  selectionWire(mock);
  await selectHistory(page);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('/writer');
  await page.getByRole('listbox', { name: '对话指令' }).getByRole('option').filter({ hasText: '/writer' }).click();
  await input.fill('针对这段内容补充说明');
  await page.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('unsent attachment') });
  const attachments = await page.locator('.attachment').count();
  await selectMessage(page);
  await page.getByRole('button', { name: '添加到对话', exact: true }).click();
  await expect(input).toHaveValue('针对这段内容补充说明');
  await expect(page.locator('.composer-token')).toContainText('writer');
  await expect(page.locator('.attachment')).toHaveCount(attachments);
  await expect(page.locator('.composer-quote')).toContainText('历史保持可读');
  expect(mock.request('turn/start')).toBeUndefined();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.input).toContainEqual({ type: 'text', text: '[引用对话：已有测试历史]\n> 历史保持可读', text_elements: [] });
  expect(mock.request('turn/start')?.params.input).toContainEqual({ type: 'skill', name: 'writer', path: '/test/skills/writer/SKILL.md' });
  expect(mock.request('turn/start')?.params.input[0].text).toContain('针对这段内容补充说明');
  expect(mock.request('turn/start')?.params.input[0].text).toContain('notes.txt');
  await expect(page.locator('.composer-quote')).toHaveCount(0);
});

test('quote-only sending works, while a failed send preserves the quotation for retry', async ({ page, mock }) => {
  selectionWire(mock);
  await selectHistory(page);
  mock.failTurnStartNext = true;
  await selectMessage(page);
  await page.getByRole('button', { name: '添加到对话', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Test turn start failed', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.composer-quote')).toContainText('历史保持可读');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.composer-quote')).toHaveCount(0);
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(2);
  const request = mock.requests.filter(request => request.method === 'turn/start').at(-1)!;
  expect(request.params.threadId).toBe('thread-existing');
  expect(request.params.input).toContainEqual({ type: 'text', text: '[引用对话：已有测试历史]\n> 历史保持可读', text_elements: [] });
});

test('quotations survive reload in their original thread and cannot leak into another thread', async ({ page, mock }) => {
  selectionWire(mock);
  const other = { ...mock.threads[0], id: 'thread-other', name: '另一个对话', preview: '另一个对话' };
  mock.threads.push(other); mock.turns.set(other.id, []);
  await selectHistory(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('保存引用草稿');
  await selectMessage(page);
  await page.getByRole('button', { name: '添加到对话', exact: true }).click();
  await page.reload();
  await expect(page.locator('.composer-quote')).toContainText('历史保持可读');
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('保存引用草稿');
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '另一个对话' }).click();
  await expect(page.locator('.composer-quote')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('');
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click();
  await expect(page.locator('.composer-quote')).toContainText('历史保持可读');
  await page.getByRole('button', { name: '移除引用 1', exact: true }).click();
  await expect(page.locator('.composer-quote')).toHaveCount(0);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('selection actions remain usable by keyboard and dismiss after Escape or a thread switch', async ({ page, mock }) => {
  selectionWire(mock);
  mock.threads.push({ ...mock.threads[0], id: 'thread-other', name: '另一个对话', preview: '另一个对话' }); mock.turns.set('thread-other', []);
  await selectHistory(page);
  await selectMessage(page);
  await page.getByRole('button', { name: '添加到对话', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.composer-quote')).toContainText('历史保持可读');
  await selectMessage(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: '所选对话内容' })).toHaveCount(0);
  await selectMessage(page);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '另一个对话' }).click();
  await expect(page.getByRole('toolbar', { name: '所选对话内容' })).toHaveCount(0);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('mobile selection actions fit the viewport and open a keyboard-sized sidebar without sending', async ({ page, mock }) => {
  selectionWire(mock);
  await page.setViewportSize({ width: 390, height: 844 });
  await selectHistory(page);
  await selectMessage(page);
  const toolbar = page.getByRole('toolbar', { name: '所选对话内容' });
  const box = await toolbar.boundingBox();
  expect(box).toBeTruthy(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(391); expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await page.getByRole('button', { name: '在侧边聊天中提问', exact: true }).click();
  const panel = page.getByRole('region', { name: '侧边聊天', exact: true });
  // A section with an accessible name has implicit region semantics.
  await expect(panel).toBeVisible();
  await expect(page.getByRole('textbox', { name: '围绕引用内容提问', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 460 });
  const question = await page.getByRole('textbox', { name: '围绕引用内容提问', exact: true }).boundingBox();
  expect(question!.y + question!.height).toBeLessThanOrEqual(460);
  expect(mock.request('thread/fork')).toBeUndefined(); expect(mock.request('turn/start')).toBeUndefined();
});

test('side questions start an independent read-only ephemeral branch and preserve main state', async ({ page, mock }) => {
  const wire = selectionWire(mock);
  await selectHistory(page);
  const main = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await main.fill('原对话尚未发送的草稿');
  await selectMessage(page);
  await page.getByRole('button', { name: '在侧边聊天中提问', exact: true }).click();
  expect(mock.request('thread/fork')).toBeUndefined();
  await expect(page.getByRole('region', { name: '侧边聊天', exact: true })).toContainText('历史保持可读');
  await page.getByRole('textbox', { name: '围绕引用内容提问', exact: true }).fill('请解释这段话');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect.poll(() => !!mock.request('turn/start')).toBe(true);
  expect(mock.request('thread/fork')?.params).toMatchObject({ threadId: 'thread-existing', lastTurnId: 'turn-history', excludeTurns: true, ephemeral: true, sandbox: 'read-only' });
  expect(mock.request('thread/fork')?.params.deferGoalContinuation).toBeUndefined();
  expect(mock.request('turn/start')?.params).toMatchObject({ threadId: wire.sideThreadId, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  expect(mock.request('turn/start')?.params.input).toContainEqual({ type: 'text', text: '[引用对话：已有测试历史]\n> 历史保持可读', text_elements: [] });
  await expect(page.locator('.side-chat-transcript')).toContainText('流式回复完成 ✅');
  await expect(main).toHaveValue('原对话尚未发送的草稿');
  expect(mock.turns.get('thread-existing')).toHaveLength(1);
  await expect(page.locator('.side-chat-transcript').getByRole('button', { name: '从此处创建分支', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/codex-selected-side-chat.png', fullPage: true });
  await page.getByRole('button', { name: '关闭侧边聊天', exact: true }).click();
  await expect(page.locator('.side-chat-panel')).toHaveCount(0);
  await expect.poll(() => wire.releases).toContain(wire.sideThreadId);
  await expect(main).toHaveValue('原对话尚未发送的草稿');
});

test('hiding and reopening the sidebar preserves an unsent question and quotes cannot auto-invoke skills', async ({ page, mock }) => {
  selectionWire(mock);
  mock.turns.get('thread-existing')![0].items.find((item: any) => item.type === 'agentMessage').text = '解释 $writer 这个技能的作用';
  await selectHistory(page);
  await selectMessage(page);
  await page.getByRole('button', { name: '在侧边聊天中提问', exact: true }).click();
  const side = page.getByRole('textbox', { name: '围绕引用内容提问', exact: true });
  await side.fill('尚未发送的侧边问题');
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await expect(page.locator('.side-chat-panel')).toBeHidden();
  await page.getByRole('button', { name: '打开侧边聊天', exact: true }).click();
  await expect(side).toHaveValue('尚未发送的侧边问题');
  await page.getByRole('button', { name: '关闭侧边聊天', exact: true }).click();
  await selectMessage(page);
  await page.getByRole('button', { name: '添加到对话', exact: true }).click();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => !!mock.request('turn/start')).toBe(true);
  expect(mock.request('turn/start')?.params.input.some((input: any) => input.type === 'skill')).toBe(false);
  expect(mock.request('thread/fork')).toBeUndefined();
});

test('a sidebar can answer while the parent runs and side approvals stay in the sidebar', async ({ page, mock }) => {
  const wire = selectionWire(mock);
  await selectHistory(page);
  const running = { id: 'parent-still-running', status: 'inProgress', itemsView: 'full', items: [
    { id: 'parent-new-question', type: 'userMessage', content: [{ type: 'text', text: '正在执行原任务' }] },
  ] };
  mock.turns.get('thread-existing')!.push(running);
  mock.emit('turn/started', { threadId: 'thread-existing', turn: running });
  await expect(page.locator('.composer').getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await selectMessage(page);
  await page.getByRole('button', { name: '在侧边聊天中提问', exact: true }).click();
  mock.requireApprovalNext = true;
  await page.getByRole('textbox', { name: '围绕引用内容提问', exact: true }).fill('解释历史答复，但不要中断原任务');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(page.locator('.side-chat-panel .approval-card')).toContainText('执行可恢复的测试命令');
  await expect(page.locator('.conversation-scroll .approval-card')).toHaveCount(0);
  await page.locator('.side-chat-panel').getByRole('button', { name: '允许一次', exact: true }).click();
  await expect(page.locator('.side-chat-transcript')).toContainText('审批后继续工作');
  await expect(page.locator('.composer').getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'turn/steer')).toHaveLength(0);
  expect(mock.requests.filter(request => request.method === 'turn/start').map(request => request.params.threadId)).toEqual([wire.sideThreadId]);
  expect(mock.turns.get('thread-existing')!.at(-1)!.status).toBe('inProgress');
});

test('eight bounded quotations deduplicate and prevent further additions without dropping existing selections', async ({ page, mock }) => {
  selectionWire(mock);
  mock.turns.set('thread-existing', Array.from({ length: 9 }, (_, index) => ({
    id: `quoted-turn-${index}`, status: 'completed', itemsView: 'full', durationMs: 1000, items: [
      { id: `quote-user-${index}`, type: 'userMessage', content: [{ type: 'text', text: `问题 ${index + 1}` }] },
      { id: `quote-${index}`, type: 'agentMessage', text: `需要引用的第 ${index + 1} 段` },
    ],
  })));
  await selectHistory(page, 'quote-0');
  for (let index = 0; index < 8; index++) {
    await selectMessage(page, `quote-${index}`);
    await page.getByRole('button', { name: '添加到对话', exact: true }).click();
  }
  await expect(page.locator('.composer-quote')).toHaveCount(8);
  await selectMessage(page, 'quote-0');
  await page.getByRole('button', { name: '添加到对话', exact: true }).click();
  await expect(page.locator('.composer-quote')).toHaveCount(8);
  await selectMessage(page, 'quote-8');
  await page.getByRole('button', { name: '添加到对话', exact: true }).click();
  await expect(page.getByText('引用内容已达上限，请先发送或移除已有引用。', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.composer-quote')).toHaveCount(8);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('sidebar can quote its answer, save visible context without another model call, and explicitly reset its history anchor', async ({ page, mock }) => {
  const wire = selectionWire(mock);
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/inject_items') { mock.requests.push(request); return socket.send(JSON.stringify({ id: request.id, result: {} })); }
    return receive(socket, request);
  };
  await selectHistory(page);
  const main = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await main.fill('主对话草稿');
  await selectMessage(page);
  await page.getByRole('button', { name: '在侧边聊天中提问', exact: true }).click();
  const panel = page.getByRole('region', { name: '侧边聊天', exact: true });
  await page.getByRole('textbox', { name: '围绕引用内容提问', exact: true }).fill('解释一下');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(panel.getByRole('button', { name: '引用回答到主对话' })).toBeEnabled();
  await panel.getByRole('button', { name: '引用回答到主对话' }).click();
  await expect(page.locator('.composer-quote')).toContainText('流式回复完成 ✅');
  await expect(main).toHaveValue('主对话草稿');
  const inferenceCount = mock.requests.filter(request => request.method === 'turn/start').length;
  await panel.getByRole('button', { name: '保存并置顶正式分支' }).click();
  await expect(panel.getByRole('button', { name: '分支已保存' })).toBeDisabled();
  const fork = mock.requests.filter(request => request.method === 'thread/fork' && request.params.ephemeral === false).at(-1)!;
  expect(fork.params).toMatchObject({ threadId: 'thread-existing', lastTurnId: 'turn-history', ephemeral: false, deferGoalContinuation: true });
  expect(mock.request('thread/inject_items')!.params.items[0].content[0].text).toContain('流式回复完成 ✅');
  const savedId = mock.request('thread/inject_items')!.params.threadId;
  expect(mock.preferences.pins).toContainEqual({ kind: 'thread', hostId: 'local', id: savedId, label: '已有测试历史 · 侧边问答' });
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(inferenceCount);
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: '另开侧边分支' }).click();
  await expect(panel.getByRole('button', { name: '保存并置顶正式分支' })).toHaveCount(0);
  await expect(panel.getByText('想了解这段内容的哪一部分？')).toBeVisible();
  expect(wire.releases).toContain(wire.sideThreadId);
  await expect(main).toHaveValue('主对话草稿');
  // Native unstarted forks may be absent from thread/list. Reload must hydrate
  // the explicitly pinned branch by ID without creating a model turn.
  const savedThread = structuredClone(mock.threads.find(thread => thread.id === savedId)!);
  mock.threads = mock.threads.filter(thread => thread.id !== savedId);
  const receiveSaved = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/read' && request.params?.threadId === savedId) {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, result: { thread: savedThread } }));
    }
    return receiveSaved(socket, request);
  };
  await page.reload();
  await expect(page.locator('[data-section="pinned"] .thread-row').filter({ hasText: '已有测试历史 · 侧边问答' })).toBeVisible();
  await expect(main).toHaveValue('主对话草稿');
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(inferenceCount);
});
