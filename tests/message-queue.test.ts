import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, reactive } from 'vue';
import { editedQueueInput, queuedText, useMessageQueue } from '../src/lib/message-queue';

const fields: Record<string, string[]> = {
  add: ['threadId', 'input', 'clientUserMessageId'], list: ['threadId', 'limit', 'cursor'],
  update: ['threadId', 'queuedSubmissionId', 'input'], delete: ['threadId', 'queuedSubmissionId'],
  reorder: ['threadId', 'queuedSubmissionIds'], start: ['threadId', 'queuedSubmissionId'],
};
const entry = (id: string, text = id) => ({ id, clientUserMessageId: `client-${id}`, input: [{ type: 'text' as const, text, text_elements: [] }] });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: any) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); }
function fixture(options: { capability?: any } = {}) {
  const main = reactive<any>({ authenticated: true, connected: true, hostId: 'local', activeThread: { id: 'thread' },
    threadReady: true, busy: true, permission: 'danger-full-access', items: [], online: true });
  const identity = { authenticationGeneration: 1, engineId: 'engine-a' };
  const methods = Object.fromEntries(Object.entries(fields).map(([key, params]) => [`thread/queue/${key}`, { available: true, params, required: params.filter(value => !['limit', 'cursor', 'queuedSubmissionId'].includes(value)) }]));
  let capability: any = options.capability || { status: 'known', checkedAt: 1, methods };
  const callbacks = new Set<(host: string, event: any) => void>();
  const calls: any[] = [];
  const overrides = new Map<string, (params: any) => any>();
  let items: any[] = [];
  const accepted: any[] = [];
  const api = {
    runtimeIdentity: () => ({ ...identity }),
    requestHttp: async (path: string) => { calls.push({ method: 'capability', path }); return capability; },
    subscribeProtocol: (callback: any) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    async sideChatRpc(host: string, method: string, params: any) {
      calls.push({ host, method, params });
      if (overrides.has(method)) return overrides.get(method)!(params);
      if (method === 'thread/queue/list') return { data: items, nextCursor: null };
      if (method === 'thread/queue/add') { const item = { ...entry(`q${items.length}`), input: params.input, clientUserMessageId: params.clientUserMessageId }; items = [...items, item]; return { queuedSubmission: item }; }
      if (method === 'thread/queue/update') { items = items.map(item => item.id === params.queuedSubmissionId ? { ...item, input: params.input } : item); return { queuedSubmission: items.find(item => item.id === params.queuedSubmissionId) }; }
      if (method === 'thread/queue/reorder') { items = params.queuedSubmissionIds.map((id: string) => items.find(item => item.id === id)); return {}; }
      if (method === 'thread/queue/delete') { items = items.filter(item => item.id !== params.queuedSubmissionId); return {}; }
      return { turn: { id: 'queued-turn', status: 'inProgress', items: [] } };
    },
    acceptQueuedTurn: (...args: any[]) => accepted.push(args),
  };
  const controller = useMessageQueue(api, main);
  return { main, identity, calls, overrides, accepted, controller,
    setItems(value: any[]) { items = value; }, setCapability(value: any) { capability = value; },
    emit(method: string, params: any) { for (const callback of callbacks) callback(main.hostId, { method, params }); },
  };
}

test('native queue creates no web inference and retains quotes, image paths and selected skills through editing', async () => {
  const f = fixture();
  try {
    await f.controller.checkCapabilities(); await settle();
    assert.equal(f.calls.find(call => call.method === 'capability').path, '/hosts/local/native-capabilities');
    const input: any = [{ type: 'text', text: '原任务', text_elements: [] }, { type: 'localImage', path: '/uploads/图.png' },
      { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' }, { type: 'text', text: '引用内容', text_elements: [] }];
    await f.controller.add(input, 'stable-client');
    assert.equal(f.controller.state.items[0].clientUserMessageId, 'stable-client');
    await f.controller.update('q0', '更新任务');
    assert.equal(queuedText(f.controller.state.items[0]), '更新任务');
    assert.deepEqual(f.controller.state.items[0].input.slice(1), input.slice(1));
    assert.equal(f.calls.some(call => call.method === 'turn/start' || call.method === 'turn/steer'), false);
    assert.deepEqual(editedQueueInput({ input: [{ type: 'localImage', path: '/x.png' }] }, '附图'),
      [{ type: 'text', text: '附图', text_elements: [] }, { type: 'localImage', path: '/x.png' }]);
  } finally { f.controller.dispose(); }
});

test('queue changes in another browser refresh the native order; stale in-flight list responses cannot overwrite them', async () => {
  const f = fixture();
  try {
    f.setItems([entry('first'), entry('second')]); await f.controller.checkCapabilities(); await settle();
    const delayed = deferred<any>();
    f.overrides.set('thread/queue/list', () => delayed.promise);
    const refresh = f.controller.refresh();
    f.setItems([entry('second'), entry('first')]);
    f.emit('thread/queue/changed', { threadId: 'thread' });
    delayed.resolve({ data: [entry('stale')], nextCursor: null }); await refresh;
    assert.equal(f.controller.state.items.some(item => item.id === 'stale'), false);
    f.overrides.delete('thread/queue/list');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.deepEqual(f.controller.state.items.map(item => item.id), ['second', 'first']);
    await f.controller.move('first', -1);
    assert.deepEqual(f.calls.findLast(call => call.method === 'thread/queue/reorder').params.queuedSubmissionIds, ['first', 'second']);
    await f.controller.remove('second');
    assert.deepEqual(f.controller.state.items.map(item => item.id), ['first']);
  } finally { f.controller.dispose(); }
});

test('unknown queue-add outcome is never blindly resent; a later native client id confirms acceptance', async () => {
  const f = fixture();
  try {
    await f.controller.checkCapabilities(); await settle();
    f.overrides.set('thread/queue/add', () => { throw Object.assign(new Error('Disconnected'), { uncertain: true }); });
    await assert.rejects(f.controller.add(entry('attempt').input, 'unknown-client'), /Disconnected/);
    assert.equal(f.controller.state.uncertain?.clientId, 'unknown-client');
    await assert.rejects(f.controller.add(entry('attempt').input, 'duplicate-client'), /尚未确认/);
    assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
    f.main.connected = false; await settle(); f.main.connected = true; await settle();
    assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
    f.setItems([{ ...entry('accepted'), clientUserMessageId: 'unknown-client' }]); await f.controller.refresh();
    assert.match(f.controller.state.notice, /已确认/);
    assert.equal(f.controller.canMutate.value, false, 'Keep the retained draft protected until explicitly reviewed');
    f.controller.acknowledgeUncertain(); assert.equal(f.controller.canMutate.value, true);
  } finally { f.controller.dispose(); }
});

test('an uncertain add already visible in the queue is accepted once, allowing the composer to clear its draft', async () => {
  const f = fixture();
  try {
    await f.controller.checkCapabilities(); await settle();
    f.overrides.set('thread/queue/add', params => {
      f.setItems([{ ...entry('accepted'), clientUserMessageId: params.clientUserMessageId }]);
      throw Object.assign(new Error('Acknowledgement lost'), { uncertain: true });
    });
    await f.controller.add(entry('attempt').input, 'confirmed-client');
    assert.equal(f.controller.state.uncertain, null);
    assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
  } finally { f.controller.dispose(); }
});

test('read-only, released writer and host switches prevent queue mutation; a late previous-host list is discarded', async () => {
  const f = fixture();
  try {
    await f.controller.checkCapabilities(); await settle();
    for (const [property, value] of [['permission', 'read-only'], ['threadReleased', true], ['threadConflict', { threadId: 'thread' }], ['switchingHost', true]] as const) {
      const previous = f.main[property]; f.main[property] = value; await settle();
      await assert.rejects(f.controller.add(entry('blocked').input, 'blocked'), /只读|释放|占用|同步/);
      f.main[property] = previous; await settle();
    }
    const delayed = deferred<any>(); f.overrides.set('thread/queue/list', params => params.threadId === 'thread' ? delayed.promise : { data: [], nextCursor: null });
    const refresh = f.controller.refresh();
    f.main.hostId = 'remote'; f.main.activeThread = { id: 'remote-thread' }; await nextTick();
    f.overrides.delete('thread/queue/list'); delayed.resolve({ data: [entry('private-local')], nextCursor: null });
    await refresh; await settle();
    assert.equal(f.controller.state.items.some(item => item.id === 'private-local'), false);
    assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);
  } finally { f.controller.dispose(); }
});

test('unsupported queue discovery is read-only; an upgraded engine reloads capabilities and paginated submissions', async () => {
  const f = fixture({ capability: { status: 'known', methods: {} } });
  try {
    await f.controller.checkCapabilities(); await settle();
    assert.equal(f.controller.state.status, 'unsupported');
    assert.equal(f.calls.filter(call => call.method?.startsWith('thread/queue')).length, 0);
    const methods = Object.fromEntries(Object.entries(fields).map(([key, params]) => [`thread/queue/${key}`, { available: true, params, required: ['threadId'] }]));
    f.setCapability({ status: 'known', methods });
    f.emit('bridge/status', { engineId: 'engine-b' }); f.identity.engineId = 'engine-b';
    f.overrides.set('thread/queue/list', params => params.cursor ? { data: [entry('page2')], nextCursor: null } : { data: [entry('page1')], nextCursor: 'next' });
    await settle(); await f.controller.checkCapabilities(); await settle();
    assert.equal(f.controller.state.status, 'supported');
    assert.deepEqual(f.controller.state.items.map(item => item.id), ['page1', 'page2']);
  } finally { f.controller.dispose(); }
});

test('queue/start cannot interrupt a busy task and preserves the accepted submission context when starting idle', async () => {
  const f = fixture();
  try {
    f.setItems([entry('later', '下一轮')]); await f.controller.checkCapabilities(); await settle();
    await assert.rejects(f.controller.start('later'), /正在运行/);
    assert.equal(f.calls.some(call => call.method === 'thread/queue/start'), false);
    f.main.busy = false;
    f.overrides.set('thread/queue/start', () => { f.setItems([]); f.emit('thread/queue/changed', { threadId: 'thread' }); return { turn: { id: 'native-start', status: 'completed', items: [] } }; });
    await f.controller.start('later');
    assert.deepEqual(f.accepted[0], ['thread', { id: 'native-start', status: 'completed', items: [] }, { input: entry('later', '下一轮').input, clientUserMessageId: 'client-later' }]);
    assert.equal(f.controller.state.items.length, 0);
  } finally { f.controller.dispose(); }
});

test('a native mutation acknowledgement immediately releases the composer while slow list reconciliation continues', async () => {
  const f = fixture();
  const delayed = deferred<any>();
  try {
    await f.controller.checkCapabilities(); await settle();
    f.overrides.set('thread/queue/list', () => delayed.promise);
    let accepted = false;
    const request = f.controller.add(entry('accepted').input, 'ack-client').then(() => { accepted = true; });
    await settle();
    assert.equal(accepted, true, 'A background queue read must never turn an accepted send into a 45-second blocked composer');
    assert.equal(f.controller.state.mutating, false);
    assert.equal(f.controller.state.items[0].clientUserMessageId, 'ack-client');
    delayed.resolve({ data: f.controller.state.items, nextCursor: null }); await request;
  } finally { delayed.resolve({ data: [], nextCursor: null }); f.controller.dispose(); }
});
