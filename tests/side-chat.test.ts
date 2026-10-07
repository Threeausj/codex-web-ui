import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, reactive } from 'vue';
import { PrivateState } from '../src/lib/private-state';
import { useSideChat } from '../src/lib/side-chat';

const selected = { hostId: 'local', threadId: 'parent', turnId: 'parent-turn', itemId: 'parent-answer', text: 'NAS Git 读取不再依赖 bwrap；$dangerous', threadName: '部署项目' };

test('sidebar retains its first history anchor, can explicitly restart, and saves visible answers in a separate persistent branch', async () => {
  const value = fixture();
  try {
    const original = JSON.stringify(value.main);
    value.controller.prepare(selected);
    await value.controller.send('解释');
    value.emit('turn/completed', { threadId: 'side', turn: { id: 'side-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: '可见回答' }] } });
    value.controller.prepare({ ...selected, turnId: 'new-selected-turn', text: '另一个选段' });
    assert.equal(value.controller.state.anchor?.turnId, 'parent-turn');
    assert.match(value.controller.state.notice, /沿用首次/);
    value.overrides.set('thread/fork', input => ({ thread: { id: input.ephemeral ? 'another-side' : 'saved-sidebar', ephemeral: input.ephemeral, forkedFromId: 'parent' } }));
    const saved = await value.controller.saveBranch('保存的问答');
    assert.equal(saved, 'saved-sidebar');
    const fork = value.calls.filter(call => call.method === 'thread/fork').at(-1)!.params;
    assert.equal(fork.threadId, 'parent');
    assert.equal(fork.lastTurnId, 'parent-turn');
    assert.equal(fork.ephemeral, false);
    assert.equal(fork.deferGoalContinuation, true);
    const injected = value.calls.find(call => call.method === 'thread/inject_items')!;
    assert.equal(injected.params.threadId, 'saved-sidebar');
    assert.match(injected.params.items[0].content[0].text, /可见回答/);
    assert.equal(value.calls.filter(call => call.method === 'turn/start').length, 1, 'Saving must never start an inference or steer the parent');
    assert.equal(JSON.stringify(value.main), original);
    assert.equal(value.controller.answerQuote()?.text, '可见回答');
    assert.equal(value.controller.answerQuote()?.threadId, 'parent');
    assert.equal(await value.controller.saveBranch(), 'saved-sidebar', 'Repeated save reuses the accepted result');
    await value.controller.newBranch();
    assert.equal(value.controller.state.threadId, '');
    assert.equal(value.controller.state.source?.turnId, 'new-selected-turn');
    assert.equal(value.controller.state.items.length, 0);
  } finally { value.controller.dispose(); }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}
function fixture() {
  const main = reactive<any>({
    authenticated: true, connected: true, hostId: 'local', switchingHost: false, runtimePaused: false,
    activeThread: { id: 'parent', cwd: '/workspace', name: '部署项目' },
    turns: [{ id: 'parent-turn', status: 'completed', items: [] }], items: [{ id: 'parent-answer', type: 'agentMessage', text: selected.text }],
    busy: true, model: 'test-model', effort: 'high', collaborationMode: 'plan', goalMode: true,
    goal: { status: 'active', objective: 'parent goal' }, modeCapabilities: { plan: true, goal: true },
    permission: 'danger-full-access', requirements: null, attachments: [{ path: '/private/original.png' }], selectedSkills: [{ name: 'parent-skill' }],
  });
  const listeners = new Set<(hostId: string, event: any) => boolean | void>();
  const calls: { hostId: string; method: string; params: any }[] = [];
  const overrides = new Map<string, (params: any) => any>();
  const identity = { authenticationGeneration: 1, engineId: 'engine-a' };
  const emit = (method: string, params: any, id?: string) => [...listeners].map(listener => listener('local', { method, params, ...(id ? { id } : {}) }));
  const rows = new Map<string, any>();
  const journal = new PrivateState({ read: async key => rows.get(key), write: async row => { rows.set(row.key, structuredClone(row)); }, remove: async key => { rows.delete(key); }, clear: async () => { rows.clear(); } }); journal.activate('hashed-test-session');
  const api = {
    operationJournal: journal,
    runtimeIdentity: () => ({ ...identity }),
    subscribeProtocol: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); },
    async sideChatRpc(hostId: string, method: string, params: any) {
      calls.push({ hostId, method, params });
      const custom = overrides.get(method);
      if (custom) return custom(params);
      if (method === 'thread/fork') return { thread: { id: 'side', ephemeral: true, forkedFromId: 'parent' } };
      if (method === 'thread/goal/get') return { goal: { status: 'active', objective: 'parent goal' } };
      if (method === 'turn/start') return { turn: { id: 'side-turn', status: 'inProgress', items: [] } };
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      return {};
    },
  };
  const controller = useSideChat(api, main);
  return { controller, main, api, calls, overrides, identity, emit, rows, journal };
}

test('closing the panel during formal branch creation finishes the save without duplicating its fork', async () => {
  const f = fixture(); const held = deferred<any>();
  try {
    f.controller.prepare(selected); await f.controller.send('解释');
    f.emit('turn/completed', { threadId: 'side', turn: { id: 'side-turn', status: 'completed' } });
    f.overrides.set('thread/fork', () => held.promise);
    const saved = f.controller.saveBranch(); await new Promise(resolve => setImmediate(resolve));
    await f.controller.close(); assert.equal(f.controller.state.open, false); assert.equal(f.controller.state.saving, true);
    held.resolve({ thread: { id: 'formal', ephemeral: false, path: '/sessions/formal.jsonl' } });
    assert.equal(await saved, 'formal'); assert.equal(f.controller.state.saving, false);
    assert.equal(f.calls.filter(call => call.method === 'thread/inject_items').length, 1);
    f.controller.prepare(selected); assert.equal(await f.controller.saveBranch(), 'formal');
    assert.equal(f.calls.filter(call => call.method === 'thread/fork').length, 2, 'One ephemeral question fork and one formal save fork');
    assert.equal(f.rows.size, 0);
  } finally { held.resolve({ thread: { id: 'formal', ephemeral: false } }); f.controller.dispose(); }
});

test('a verified formal ID survives controller replacement before goal cleanup finishes', async () => {
  const f = fixture(); let reloaded: ReturnType<typeof useSideChat> | undefined;
  try {
    f.controller.prepare(selected); await f.controller.send('解释');
    f.emit('turn/completed', { threadId: 'side', turn: { id: 'side-turn', status: 'completed' } });
    f.overrides.set('thread/fork', () => { throw Object.assign(new Error('ACK lost'), { uncertain: true }); });
    await assert.rejects(f.controller.saveBranch(), /ACK lost/);
    f.overrides.set('thread/read', () => ({ thread: { id: 'formal-recovered', forkedFromId: 'parent', ephemeral: false, path: '/sessions/formal.jsonl', status: { type: 'idle' } } }));
    f.overrides.set('thread/goal/get', () => { throw new Error('cleanup offline'); });
    await assert.rejects(f.controller.resumeSavedBranch('formal-recovered'), /cleanup offline/);
    f.controller.dispose(); reloaded = useSideChat(f.api, f.main); reloaded.prepare(selected);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reloaded.state.saveTargetThreadId, 'formal-recovered'); assert.equal(reloaded.state.saveUncertain, '');
    f.overrides.delete('thread/goal/get'); await reloaded.saveBranch();
    assert.equal(f.calls.filter(call => call.method === 'thread/fork').length, 2);
    assert.equal(f.calls.find(call => call.method === 'thread/inject_items')?.params.threadId, 'formal-recovered');
  } finally { reloaded?.dispose(); f.controller.dispose(); }
});

test('a confirmed failed formal fork clears its receipt so a refresh can safely retry once', async () => {
  const f = fixture(); let reloaded: ReturnType<typeof useSideChat> | undefined;
  try {
    f.controller.prepare(selected); await f.controller.send('解释');
    f.emit('turn/completed', { threadId: 'side', turn: { id: 'side-turn', status: 'completed' } });
    f.overrides.set('thread/fork', () => { throw new Error('native rejection'); });
    await assert.rejects(f.controller.saveBranch(), /native rejection/); assert.equal(f.rows.size, 0);
    f.controller.dispose(); reloaded = useSideChat(f.api, f.main); reloaded.prepare(selected); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reloaded.state.saveUncertain, '');
  } finally { reloaded?.dispose(); f.controller.dispose(); }
});

test('selection opens without inference; explicit question forks an isolated readonly branch and clears only its inherited goal', async () => {
  const value = fixture();
  try {
    const initialMain = JSON.stringify(value.main);
    value.controller.prepare(selected);
    assert.equal(value.controller.state.open, true);
    assert.equal(value.calls.length, 0);
    await value.controller.send('这句话是什么意思？');
    assert.deepEqual(value.calls.map(call => call.method), ['thread/fork', 'thread/goal/get', 'thread/goal/clear', 'turn/start']);
    const fork = value.calls[0].params;
    assert.deepEqual(fork, { threadId: 'parent', lastTurnId: 'parent-turn', excludeTurns: true, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', model: 'test-model', cwd: '/workspace' });
    assert.equal(value.calls[1].params.threadId, 'side');
    assert.equal(value.calls[2].params.threadId, 'side');
    const turn = value.calls[3].params;
    assert.equal(turn.threadId, 'side');
    assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(turn.approvalPolicy, 'never');
    assert.equal(turn.collaborationMode.mode, 'default');
    assert.deepEqual(turn.input.map((input: any) => input.type), ['text', 'text']);
    assert.equal(turn.input[0].text, '这句话是什么意思？');
    assert.match(turn.input[1].text, /引用对话：部署项目/);
    assert.match(turn.input[1].text, /\$dangerous/);
    assert.equal(value.controller.state.items[0].status, undefined, 'An accepted start response confirms the optimistic user input even without an item replay');
    assert.equal(value.controller.state.items[0].turnId, 'side-turn');
    assert.equal(JSON.stringify(value.main), initialMain, 'A sidebar must not alter parent selection, running state, mode, attachments or skills');
    await value.controller.close();
    assert.deepEqual(value.calls.slice(-2).map(call => [call.method, call.params.threadId]), [['turn/interrupt', 'side'], ['thread/unsubscribe', 'side']]);
  } finally { value.controller.dispose(); }
});

test('side events stream while its pane is hidden; a late start response cannot revive a completed task', async () => {
  const value = fixture();
  try {
    value.controller.prepare(selected);
    value.overrides.set('turn/start', (params: any) => {
      value.controller.state.open = false;
      const user = { id: 'native-user', type: 'userMessage', clientId: params.clientUserMessageId, content: params.input };
      value.emit('turn/started', { threadId: 'side', turn: { id: 'side-turn', status: 'inProgress', items: [user] } });
      value.emit('item/agentMessage/delta', { threadId: 'side', turnId: 'side-turn', itemId: 'answer', delta: '侧边回复' });
      value.emit('turn/completed', { threadId: 'side', turn: { id: 'side-turn', status: 'completed', items: [user, { id: 'answer', type: 'agentMessage', text: '侧边回复' }] } });
      return { turn: { id: 'side-turn', status: 'inProgress', items: [] } };
    });
    await value.controller.send('解释');
    assert.equal(value.controller.state.busy, false);
    assert.equal(value.controller.state.turns[0].status, 'completed');
    assert.equal(value.controller.state.items.filter(item => item.type === 'userMessage').length, 1);
    assert.equal(value.controller.state.items.at(-1)?.text, '侧边回复');
    assert.equal(value.main.busy, true);
    assert.deepEqual(value.emit('item/commandExecution/requestApproval', { threadId: 'side' }, 'managed-approval'), [undefined]);
    assert.deepEqual(value.emit('item/agentMessage/delta', { threadId: 'parent', itemId: 'parent-live', delta: 'parent' }), [undefined]);
    value.controller.prepare({ ...selected, text: '新的选段' });
    await value.controller.send('继续解释');
    assert.equal(value.calls.filter(call => call.method === 'thread/fork').length, 1, 'Changing the selection in the same parent reuses the independent side branch');
  } finally { value.controller.dispose(); }
});

test('selecting a running parent turn forks before it and supplies the selected excerpt explicitly', async () => {
  const value = fixture();
  try {
    value.main.turns.push({ id: 'running-parent', status: 'inProgress', items: [] });
    value.controller.prepare({ ...selected, turnId: 'running-parent' });
    await value.controller.send('解释正在输出的这句话');
    assert.equal(value.calls[0].params.beforeTurnId, 'running-parent');
    assert.equal(value.calls[0].params.lastTurnId, undefined);
    assert.equal(value.calls.find(call => call.method === 'turn/start')?.params.input[1].text.includes(selected.text), true);
  } finally { value.controller.dispose(); }
});

test('a late fork after close is unsubscribed and never starts a model turn', async () => {
  const value = fixture();
  try {
    const held = deferred<any>();
    value.overrides.set('thread/fork', () => held.promise);
    value.controller.prepare(selected);
    const send = value.controller.send('解释');
    await new Promise(resolve => setImmediate(resolve));
    await value.controller.close();
    held.resolve({ thread: { id: 'late-side', ephemeral: true } });
    await send;
    assert.deepEqual(value.calls.map(call => call.method), ['thread/fork', 'thread/unsubscribe']);
    assert.equal(value.calls[1].params.threadId, 'late-side');
    assert.equal(value.controller.state.source, null);
  } finally { value.controller.dispose(); }
});

test('host switching submits side cleanup on the old shared socket without interrupting the parent', async () => {
  const value = fixture();
  try {
    value.controller.prepare(selected);
    await value.controller.send('解释');
    value.controller.state.open = false;
    value.main.switchingHost = true;
    assert.equal(value.controller.state.source, null);
    assert.deepEqual(value.calls.slice(-2).map(call => [call.method, call.params.threadId]), [['turn/interrupt', 'side'], ['thread/unsubscribe', 'side']]);
    assert.equal(value.main.activeThread.id, 'parent');
  } finally { value.controller.dispose(); }
});

test('reconnect recovers only side history and keeps newer live events over a delayed snapshot', async () => {
  const value = fixture();
  try {
    value.controller.prepare(selected);
    await value.controller.send('解释');
    value.main.connected = false;
    await nextTick();
    const held = deferred<any>();
    value.overrides.set('thread/turns/list', () => held.promise);
    value.main.connected = true;
    await nextTick();
    value.emit('item/agentMessage/delta', { threadId: 'side', turnId: 'side-turn', itemId: 'live-answer', delta: 'newer' });
    value.emit('turn/completed', { threadId: 'side', turn: { id: 'side-turn', status: 'completed', items: [{ id: 'live-answer', type: 'agentMessage', text: 'newer' }] } });
    held.resolve({ data: [{ id: 'side-turn', status: 'inProgress', items: [{ id: 'live-answer', type: 'agentMessage', text: 'old' }] }], nextCursor: null });
    await value.controller.recover();
    assert.equal(value.controller.state.items.find(item => item.id === 'live-answer')?.text, 'newer');
    assert.equal(value.controller.state.busy, false);
    assert.equal(value.calls.at(-1)?.method, 'thread/turns/list');
    assert.equal(value.calls.some(call => call.method === 'thread/resume'), false);
  } finally { value.controller.dispose(); }
});

test('an engine restart ends an ephemeral side thread instead of silently replaying its question', async () => {
  const value = fixture();
  try {
    value.controller.prepare(selected);
    await value.controller.send('解释');
    const before = value.calls.length;
    value.emit('bridge/status', { connected: true, engineId: 'engine-b' });
    assert.equal(value.controller.state.threadId, '');
    assert.equal(value.controller.state.busy, false);
    assert.match(value.controller.state.error, /进程已重启/);
    assert.equal(value.calls.length, before);
    assert.equal(value.main.activeThread.id, 'parent');
  } finally { value.controller.dispose(); }
});

test('managed restrictions remain in effect and unsupported ephemeral forks are never used for inference', async () => {
  const value = fixture();
  try {
    value.controller.prepare(selected);
    value.main.requirements = { allowedSandboxModes: ['workspace-write'] };
    await assert.rejects(value.controller.send('解释'), /管理策略/);
    assert.equal(value.calls.length, 0);
    value.main.requirements = { allowedApprovalPolicies: ['on-request'], allowedSandboxModes: ['read-only'] };
    value.overrides.set('thread/fork', () => ({ thread: { id: 'old-side', ephemeral: false } }));
    await assert.rejects(value.controller.send('解释'), /不支持临时侧边聊天/);
    assert.equal(value.calls[0].params.approvalPolicy, 'on-request');
    assert.deepEqual(value.calls.map(call => call.method), ['thread/fork', 'thread/unsubscribe']);
  } finally { value.controller.dispose(); }
});

test('goal verification failure releases only the new fork and invalid selections never reach RPC', async () => {
  const value = fixture();
  try {
    assert.throws(() => value.controller.prepare({ ...selected, hostId: 'other' }), /重新选择/);
    assert.throws(() => value.controller.prepare({ ...selected, text: 'x'.repeat(16001) }), /重新选择/);
    assert.equal(value.calls.length, 0);
    value.controller.prepare(selected);
    value.overrides.set('thread/goal/get', () => { throw new Error('verification unavailable'); });
    await assert.rejects(value.controller.send('解释'), /目标状态/);
    assert.deepEqual(value.calls.map(call => call.method), ['thread/fork', 'thread/goal/get', 'thread/unsubscribe']);
    assert.equal(value.calls.at(-1)?.params.threadId, 'side');
    assert.equal(value.controller.state.threadId, '');
  } finally { value.controller.dispose(); }
});

test('native ephemeral forks explicitly cannot inherit goals; unrelated invalid-request failures remain blocking', async () => {
  const value = fixture();
  try {
    value.controller.prepare(selected);
    value.overrides.set('thread/goal/get', () => { throw Object.assign(new Error('ephemeral thread does not support goals: side'), { code: -32600 }); });
    await value.controller.send('解释');
    assert.deepEqual(value.calls.map(call => call.method), ['thread/fork', 'thread/goal/get', 'turn/start']);
    assert.equal(value.calls[0].params.deferGoalContinuation, undefined);
    assert.equal(value.main.goal.status, 'active');
    await value.controller.close();
    value.controller.prepare(selected);
    value.overrides.set('thread/goal/get', () => { throw Object.assign(new Error('Invalid goal request'), { code: -32600 }); });
    await assert.rejects(value.controller.send('解释'), /目标状态/);
    assert.equal(value.calls.at(-1)?.method, 'thread/unsubscribe');
  } finally { value.controller.dispose(); }
});

test('native metadata-only recovery retains the transcript and never claims to restore missed ephemeral messages', async () => {
  const value = fixture();
  try {
    value.controller.prepare(selected);
    await value.controller.send('解释');
    value.emit('item/agentMessage/delta', { threadId: 'side', turnId: 'side-turn', itemId: 'retained-answer', delta: '已收到的侧边文本' });
    value.overrides.set('thread/turns/list', () => { throw Object.assign(new Error('ephemeral threads do not support thread/turns/list'), { code: -32600 }); });
    value.overrides.set('thread/read', () => ({ thread: { id: 'side', ephemeral: true, status: { type: 'idle' } } }));
    await value.controller.recover();
    assert.equal(value.controller.state.items.find(item => item.id === 'retained-answer')?.text, '已收到的侧边文本');
    assert.equal(value.controller.state.busy, false);
    assert.match(value.controller.state.notice, /不支持补读/);
    assert.deepEqual(value.calls.slice(-2).map(call => [call.method, call.params.threadId]), [['thread/turns/list', 'side'], ['thread/read', 'side']]);
    assert.equal(value.calls.at(-1)?.params.includeTurns, false);
    assert.equal(value.calls.some(call => call.method === 'thread/resume'), false);
  } finally { value.controller.dispose(); }
});

test('another client ephemeral fork remains outside this sidebar event ownership', async () => {
  const value = fixture();
  try {
    const held = deferred<any>();
    value.overrides.set('thread/fork', () => held.promise);
    value.controller.prepare(selected);
    const sending = value.controller.send('解释');
    assert.deepEqual(value.emit('thread/started', { thread: { id: 'other-side', ephemeral: true, forkedFromId: 'parent' } }), [undefined]);
    assert.deepEqual(value.emit('item/agentMessage/delta', { threadId: 'other-side', turnId: 'other-turn', itemId: 'other-answer', delta: 'another client' }), [undefined]);
    held.resolve({ thread: { id: 'side', ephemeral: true, forkedFromId: 'parent' } });
    await sending;
    assert.equal(value.controller.state.items.some(item => item.id === 'other-answer'), false);
  } finally { value.controller.dispose(); }
});

function savedSidebarFixture() {
  const value = fixture();
  let turnCount = 0;
  value.overrides.set('thread/fork', input => ({ thread: { id: input.ephemeral ? 'side' : 'saved-sidebar',
    ephemeral: input.ephemeral, forkedFromId: 'parent', path: input.ephemeral ? null : '/test/saved.jsonl' } }));
  value.overrides.set('turn/start', input => ({ turn: { id: `side-${++turnCount}`, status: 'completed', items: [
    { id: `user-${turnCount}`, clientId: input.clientUserMessageId, type: 'userMessage', content: input.input },
    { id: `answer-${turnCount}`, type: 'agentMessage', text: `回答${turnCount}` },
  ] } }));
  return value;
}

test('a failed native injection retains its target branch, stays incomplete and retries without creating a second fork', async () => {
  const value = savedSidebarFixture();
  try {
    value.controller.prepare(selected); await value.controller.send('首次问题');
    let reject = true;
    value.overrides.set('thread/inject_items', () => { if (reject) { reject = false; throw Object.assign(new Error('Method not found'), { code: -32601 }); } return {}; });
    await assert.rejects(value.controller.saveBranch(), /Method not found/);
    assert.equal(value.controller.state.saveTargetThreadId, 'saved-sidebar');
    assert.equal(value.controller.state.savedThreadId, '', 'A partially created branch is not a completed save');
    assert.match(value.controller.state.error, /保存尚未完成/);
    assert.equal(await value.controller.saveBranch(), 'saved-sidebar');
    assert.equal(value.calls.filter(call => call.method === 'thread/fork' && !call.params.ephemeral).length, 1);
    assert.equal(value.calls.filter(call => call.method === 'thread/inject_items').length, 2);
    assert.equal(value.controller.state.savedThreadId, 'saved-sidebar');
  } finally { value.controller.dispose(); }
});

test('subsequent sidebar questions append only unsaved visible context to the same formal branch and invalidate the completed marker', async () => {
  const value = savedSidebarFixture();
  try {
    value.controller.prepare(selected); await value.controller.send('第一问'); await value.controller.saveBranch();
    const initial = value.calls.find(call => call.method === 'thread/inject_items')!.params.items[0].content[0].text;
    assert.match(initial, /第一问/); assert.match(initial, /回答1/);
    await value.controller.send('第二问');
    assert.equal(value.controller.state.savedThreadId, '');
    await value.controller.saveBranch();
    const injection = value.calls.filter(call => call.method === 'thread/inject_items').at(-1)!.params;
    assert.equal(injection.threadId, 'saved-sidebar');
    assert.match(injection.items[0].content[0].text, /第二问/); assert.match(injection.items[0].content[0].text, /回答2/);
    assert.doesNotMatch(injection.items[0].content[0].text, /第一问|回答1/);
    assert.equal(value.calls.filter(call => call.method === 'thread/fork' && !call.params.ephemeral).length, 1);
    await value.controller.saveBranch();
    assert.equal(value.calls.filter(call => call.method === 'thread/inject_items').length, 2);
    assert.equal(value.calls.filter(call => call.method === 'turn/start').length, 2, 'Saving never creates an inference');
  } finally { value.controller.dispose(); }
});

test('an idle selection without a turn id freezes the latest completed parent turn for initial and saved forks', async () => {
  const value = savedSidebarFixture();
  try {
    value.main.busy = false;
    value.controller.prepare({ ...selected, turnId: undefined }); await value.controller.send('引用回答');
    assert.deepEqual(value.controller.state.boundary, { lastTurnId: 'parent-turn' });
    value.main.turns.push({ id: 'new-parent-turn', status: 'completed', items: [] });
    await value.controller.saveBranch();
    assert.deepEqual(value.calls.filter(call => call.method === 'thread/fork').map(call => call.params.lastTurnId), ['parent-turn', 'parent-turn']);
  } finally { value.controller.dispose(); }
});

test('an unknown native fork outcome is protected across close/reopen and can recover only a verified readonly child branch', async () => {
  const value = savedSidebarFixture();
  try {
    value.controller.prepare(selected); await value.controller.send('必须保留的问答');
    value.overrides.set('thread/fork', input => {
      if (!input.ephemeral) throw Object.assign(new Error('Lost fork acknowledgement'), { uncertain: true });
      return { thread: { id: 'side', ephemeral: true } };
    });
    await assert.rejects(value.controller.saveBranch(), /Lost fork/);
    await assert.rejects(value.controller.saveBranch(), /不能重复创建/);
    await value.controller.close(); value.controller.prepare(selected); await value.controller.send('新的可见问答');
    await assert.rejects(value.controller.saveBranch(), /不能重复创建/);
    assert.equal(value.calls.filter(call => call.method === 'thread/fork' && !call.params.ephemeral).length, 1);
    value.overrides.set('thread/read', () => ({ thread: { id: 'wrong', forkedFromId: 'unrelated', ephemeral: false } }));
    await assert.rejects(value.controller.resumeSavedBranch('wrong'), /不是从当前父对话/);
    assert.equal(value.calls.some(call => call.method === 'thread/resume'), false);
    value.overrides.set('thread/read', () => ({ thread: { id: 'recovered', forkedFromId: 'parent', ephemeral: false, path: '/test/recovered.jsonl' } }));
    await value.controller.resumeSavedBranch('recovered');
    assert.equal(value.calls.some(call => call.method === 'thread/resume'), false, 'Recovery must not automatically continue an inherited goal');
    assert.deepEqual(value.calls.find(call => call.method === 'thread/settings/update')!.params,
      { threadId: 'recovered', sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
    const clearIndex = value.calls.findIndex(call => call.method === 'thread/goal/clear' && call.params.threadId === 'recovered');
    assert.ok(clearIndex >= 0 && clearIndex < value.calls.findIndex(call => call.method === 'thread/settings/update'));
    assert.equal(value.calls.filter(call => call.method === 'turn/start').length, 2, 'Recovery starts no inference');
    await value.controller.saveBranch();
    assert.equal(value.controller.state.savedThreadId, 'recovered');
    assert.equal(value.calls.filter(call => call.method === 'thread/fork' && !call.params.ephemeral).length, 1);
  } finally { value.controller.dispose(); }
});

test('unknown injected context must be positively present in native rollout before continuation, and is never appended twice', async () => {
  const value = savedSidebarFixture();
  try {
    value.controller.prepare(selected); await value.controller.send('未知追加');
    let rollout = '';
    value.overrides.set('thread/inject_items', () => { throw Object.assign(new Error('Lost append acknowledgement'), { uncertain: true }); });
    value.overrides.set('fs/readFile', () => ({ dataBase64: Buffer.from(rollout).toString('base64') }));
    await assert.rejects(value.controller.saveBranch(), /Lost append/);
    assert.equal(value.controller.state.saveUncertain, 'inject');
    await assert.rejects(value.controller.saveBranch(), /追加结果尚未确认/);
    assert.equal(value.calls.filter(call => call.method === 'thread/inject_items').length, 1);
    const appended = value.calls.find(call => call.method === 'thread/inject_items')!.params.items[0];
    rollout = JSON.stringify({ type: 'response_item', payload: appended }) + '\n';
    await value.controller.saveBranch();
    assert.equal(value.controller.state.saveUncertain, '');
    assert.equal(value.controller.state.savedThreadId, 'saved-sidebar');
    assert.equal(value.calls.filter(call => call.method === 'thread/inject_items').length, 1);
    assert.equal(value.calls.filter(call => call.method === 'thread/fork' && !call.params.ephemeral).length, 1);
  } finally { value.controller.dispose(); }
});

test('name update failures resume the same saved branch without appending an acknowledged transcript again', async () => {
  const value = savedSidebarFixture();
  try {
    value.controller.prepare(selected); await value.controller.send('已追加的问答');
    let reject = true;
    value.overrides.set('thread/name/set', () => { if (reject) { reject = false; throw new Error('Name projection unavailable'); } return {}; });
    await assert.rejects(value.controller.saveBranch(), /Name projection/);
    assert.equal(value.controller.state.savedThreadId, '');
    await value.controller.saveBranch();
    assert.equal(value.calls.filter(call => call.method === 'thread/inject_items').length, 1);
    assert.equal(value.calls.filter(call => call.method === 'thread/fork' && !call.params.ephemeral).length, 1);
  } finally { value.controller.dispose(); }
});

test('a failed durable pin remains an incomplete save and retries the same native branch without another injection', async () => {
  const value = savedSidebarFixture();
  const remembered: any[] = [];
  let fail = true;
  Object.assign(value.api, { rememberSideBranch: async (...args: any[]) => {
    remembered.push(args);
    if (fail) { fail = false; throw new Error('Preferences unavailable'); }
  } });
  try {
    value.controller.prepare(selected); await value.controller.send('需要持久保存的问答');
    await assert.rejects(value.controller.saveBranch(), /Preferences unavailable/);
    assert.equal(value.controller.state.savedThreadId, '');
    assert.equal(value.controller.state.saveTargetThreadId, 'saved-sidebar');
    await value.controller.saveBranch();
    assert.equal(value.controller.state.savedThreadId, 'saved-sidebar');
    assert.deepEqual(remembered, [
      ['local', 'saved-sidebar', '部署项目 · 侧边问答'],
      ['local', 'saved-sidebar', '部署项目 · 侧边问答'],
    ]);
    assert.equal(value.calls.filter(call => call.method === 'thread/inject_items').length, 1);
    assert.equal(value.calls.filter(call => call.method === 'thread/fork' && !call.params.ephemeral).length, 1);
    assert.equal(value.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { value.controller.dispose(); }
});
