import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from './app.js';
import type { Host, RpcMessage } from './types.js';
import type { Transport } from './bridge.js';
import { asyncQuestionReplyText } from '../shared/async-question-reply.js';

const question = { type: 'agentMessage', id: 'async-question', delivery: 'async', phase: 'final_answer', text: 'Which approach?', questions: [{ title: 'Which approach?', options: ['One', 'Two'] }] };
function native(host: Host) {
  const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter();
  const requests: RpcMessage[] = [], held = new Map<string, () => void>();
  const state: {
    status: string; turns: any[]; items: any[]; hold: boolean; disconnect?: boolean;
    failure?: NonNullable<RpcMessage['error']>; mutationCount: number; pages?: (cursor: unknown, turnId?: string) => unknown;
  } = { status: 'idle', turns: [{ id: 'question-turn', status: 'completed', items: [structuredClone(question)] }], items: [{ turnId: 'question-turn', item: structuredClone(question) }], hold: false, mutationCount: 0 };
  let buffer = '';
  const receive = (message: RpcMessage) => output.write(JSON.stringify(message) + '\n');
  input.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, index)) as RpcMessage;
      buffer = buffer.slice(index + 1); requests.push(request);
      if (request.id === undefined || !request.method) continue;
      const params = request.params as any;
      let result: unknown = {};
      if (request.method === 'initialize') result = { userAgent: 'async-question-test:' + host.id };
      if (request.method === 'thread/items/list') {
        const records = new Map(state.items.filter(entry => entry.turnId === params.turnId).map(entry => [entry.item.id, entry]));
        for (const item of state.turns.find(turn => turn.id === params.turnId)?.fullItems || state.turns.find(turn => turn.id === params.turnId)?.items || [])
          if (!records.has(item.id)) records.set(item.id, { turnId: params.turnId, item });
        result = state.pages?.(params.cursor, params.turnId) || { data: [...records.values()], nextCursor: null };
      }
      if (request.method === 'thread/turns/list') result = { data: state.turns, nextCursor: null };
      if (request.method === 'thread/read') result = { thread: { id: params.threadId, status: { type: state.status }, source: 'cli' } };
      if (['turn/start', 'turn/steer'].includes(request.method)) {
        state.mutationCount++;
        const respond = () => {
          if (state.disconnect) { events.emit('transportClose', new Error('Connection closed before acknowledgement')); return; }
          if (state.failure) { receive({ id: request.id, error: state.failure }); return; }
          const turnId = request.method === 'turn/steer' ? params.expectedTurnId : 'new-answer-turn';
          const user = { type: 'userMessage', id: 'native-user-' + state.mutationCount, clientId: params.clientUserMessageId, content: params.input };
          state.turns.unshift({ id: turnId, status: 'inProgress', items: [user] }); state.status = 'active';
          receive({ id: request.id, result: request.method === 'turn/steer' ? { turnId } : { turn: { id: turnId, status: 'inProgress', items: [user] } } });
        };
        if (state.hold) held.set(String(request.id), respond); else queueMicrotask(respond);
      } else queueMicrotask(() => receive({ id: request.id, result }));
    }
  });
  const transport: Transport = { input, output, events, dispose() { input.destroy(); output.destroy(); } };
  return { transport, requests, held, state, receive };
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-async-question-answer-'));
  const peers = new Map<string, ReturnType<typeof native>>();
  const password = 'async-question-answer-test-password-123';
  const application = await createServer({ dataDir: directory, codexHome: path.join(directory, 'codex'), cwd: directory, password, secureCookie: false, serveStatic: false,
    bridgeOptions: { transportFactory: host => { const peer = native(host); peers.set(host.id, peer); return peer.transport; } },
    pushOptions: { sendNotification: async () => { throw new Error('Unexpected notification in isolated answer test'); } },
  });
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (application.server.address() as { port: number }).port;
  const login = async () => {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await response.json() as { csrfToken: string };
    return { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken };
  };
  const headers = await login();
  const request = (body: unknown = { turnId: 'question-turn', answers: ['One'] }, options: { hostId?: string; threadId?: string; itemId?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${base}/api/threads/${encodeURIComponent(options.hostId || 'local')}/${encodeURIComponent(options.threadId || 'thread')}/async-questions/${encodeURIComponent(options.itemId || question.id)}/answer`, { method: 'POST', headers: options.headers || headers, body: JSON.stringify(body) });
  const status = (override = { cookie: headers.cookie }, query = '?turnId=question-turn') =>
    fetch(`${base}/api/threads/local/thread/async-questions/${question.id}/status${query}`, { headers: override });
  const connect = async (hostId = 'local') => { const bridge = await application.getBridge(hostId); await bridge.connect(); return peers.get(hostId)!; };
  return { application, peers, headers, login, request, status, connect, close: async () => { await application.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('async answer endpoint validates auth, CSRF and fields before touching a native host', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(undefined, { headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal((await f.request(undefined, { headers: { 'content-type': 'application/json', cookie: f.headers.cookie } })).status, 403);
    assert.equal((await f.request(undefined, { headers: { ...f.headers, origin: 'https://attacker.invalid' } })).status, 403);
    for (const body of [{ turnId: '', answers: ['One'] }, { turnId: 'question-turn', answers: [] }, { turnId: 'question-turn', answers: [' '] }, { turnId: 'question-turn', answers: ['x'.repeat(16001)] }, { turnId: 'question-turn', answers: ['One'], title: 'Forged title' }, { turnId: 'question-turn', answers: ['One'], sandboxPolicy: { type: 'dangerFullAccess' } }])
      assert.equal((await f.request(body)).status, 400);
    assert.equal(f.application.bridges.size, 0);
    assert.equal((await f.request(undefined, { hostId: 'unknown' })).status, 404);
  } finally { await f.close(); }
});

test('idle replies use the verified native question and inherit thread settings, with a stable accepted receipt', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect();
    const response = await f.request({ turnId: 'question-turn', answers: ['Custom <answer>'] });
    assert.equal(response.status, 200);
    const receipt = await response.json() as any;
    assert.equal(receipt.accepted, true); assert.equal(receipt.turn.id, 'new-answer-turn');
    const write = peer.requests.find(request => request.method === 'turn/start')!;
    assert.deepEqual(Object.keys(write.params as any).sort(), ['clientUserMessageId', 'input', 'threadId']);
    assert.equal((write.params as any).input[0].text, asyncQuestionReplyText(question, ['Custom <answer>']));
    assert.equal((write.params as any).clientUserMessageId, receipt.clientUserMessageId);
    assert.deepEqual(await (await f.request()).json(), receipt);
    assert.equal(peer.state.mutationCount, 1);
  } finally { await f.close(); }
});

test('active replies steer the latest native turn, even when the question was emitted in an older turn', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect(); peer.state.status = 'active'; peer.state.turns.unshift({ id: 'new-running-turn', status: 'inProgress', items: [] });
    const response = await f.request(); assert.equal(response.status, 200);
    assert.equal((await response.json() as any).turnId, 'new-running-turn');
    const write = peer.requests.find(request => request.method === 'turn/steer')!;
    assert.equal((write.params as any).expectedTurnId, 'new-running-turn');
    assert.equal(peer.requests.some(request => request.method === 'turn/start'), false);
  } finally { await f.close(); }
});

test('two authenticated Web clients share an in-flight answer and cannot submit competing answers twice', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect(); peer.state.hold = true;
    const secondHeaders = await f.login();
    const first = f.request({ turnId: 'question-turn', answers: ['One'] });
    const waitUntil = Date.now() + 3000;
    while (!peer.held.size) {
      if (Date.now() >= waitUntil) throw new Error('Native answer was not submitted');
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const second = f.request({ turnId: 'question-turn', answers: ['Two'] }, { headers: secondHeaders });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(peer.state.mutationCount, 1);
    peer.held.values().next().value!();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.status, 200); assert.equal(right.status, 200);
    assert.deepEqual(await left.json(), await right.json()); assert.equal(peer.state.mutationCount, 1);
  } finally { await f.close(); }
});

test('missing or malformed native questions, wrong answer counts and stale history never submit input', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect();
    assert.equal((await f.request(undefined, { itemId: 'forged-id' })).status, 404);
    peer.state.items[0].item.delivery = null;
    assert.equal((await f.request()).status, 409); peer.state.items[0].item.delivery = 'async';
    assert.equal((await f.request({ turnId: 'question-turn', answers: ['One', 'Two'] })).status, 400);
    peer.state.turns = [{ id: 'unrelated-latest-turn', status: 'completed', items: [] }];
    assert.equal((await f.request()).status, 409);
    peer.state.turns = [{ id: 'question-turn', status: 'inProgress', items: [question] }];
    assert.equal((await f.request()).status, 409);
    assert.equal(peer.state.mutationCount, 0);
  } finally { await f.close(); }
});

test('verified historical answers acknowledge immediately without opening another turn', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect();
    peer.state.turns.unshift({ id: 'previous-answer', status: 'completed', items: [{ type: 'userMessage', id: 'persisted-answer', content: [{ type: 'text', text: asyncQuestionReplyText(question, ['Two']) }] }] });
    const response = await f.request(); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, alreadyAnswered: true });
    assert.equal(peer.state.mutationCount, 0);
  } finally { await f.close(); }
});

test('uncertain native acknowledgement keeps its claim until verified history confirms the answer', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect(); peer.state.failure = { code: -32000, message: 'Lost connection', data: { uncertain: true } };
    let response = await f.request(); assert.equal(response.status, 409); assert.equal((await response.json() as any).code, 'async_answer_uncertain');
    peer.state.failure = undefined;
    response = await f.request(); assert.equal(response.status, 409); assert.equal(peer.state.mutationCount, 1);
    const input = (peer.requests.find(request => request.method === 'turn/start')!.params as any).input;
    peer.state.turns.unshift({ id: 'accepted-with-lost-ack', status: 'completed', items: [{ type: 'userMessage', id: 'recovered', content: input }] });
    response = await f.request(); assert.equal(response.status, 200); assert.equal((await response.json() as any).alreadyAnswered, true);
    assert.equal(peer.state.mutationCount, 1);
  } finally { await f.close(); }
});

test('definite native turn conflicts are not retried automatically and remain retryable after synchronization', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect(); peer.state.status = 'active'; peer.state.turns.unshift({ id: 'running-old', status: 'inProgress', items: [] });
    peer.state.failure = { code: -32602, message: 'expected active turn id running-old but found running-new' };
    assert.equal((await f.request()).status, 502); assert.equal(peer.state.mutationCount, 1);
    peer.state.failure = undefined; peer.state.turns[0].id = 'running-new';
    assert.equal((await f.request()).status, 200); assert.equal(peer.state.mutationCount, 2);
    const writes = peer.requests.filter(request => request.method === 'turn/steer');
    assert.deepEqual(writes.map(request => (request.params as any).expectedTurnId), ['running-old', 'running-new']);
  } finally { await f.close(); }
});

test('a transport disconnect after dispatch cannot cause a repeated answer when the host reconnects', async () => {
  const f = await fixture();
  try {
    const firstPeer = await f.connect(); firstPeer.state.disconnect = true;
    let response = await f.request(); assert.equal(response.status, 409); assert.equal((await response.json() as any).code, 'async_answer_uncertain');
    assert.equal(firstPeer.state.mutationCount, 1);
    response = await f.request(); assert.equal(response.status, 409);
    const reconnectedPeer = f.peers.get('local')!;
    assert.notEqual(reconnectedPeer, firstPeer); assert.equal(reconnectedPeer.state.mutationCount, 0);
    reconnectedPeer.state.turns.unshift({ id: 'recovered-answer', status: 'completed', items: [{ type: 'userMessage', id: 'persisted', content: (firstPeer.requests.find(request => request.method === 'turn/start')!.params as any).input }] });
    response = await f.request(); assert.equal(response.status, 200); assert.equal((await response.json() as any).alreadyAnswered, true);
    assert.equal(reconnectedPeer.state.mutationCount, 0);
  } finally { await f.close(); }
});

test('matching question IDs remain isolated across hosts and pagination verifies the original item', async () => {
  const f = await fixture();
  try {
    const remote = await f.application.storage.addHost({ name: 'Isolated remote', hostname: 'example.invalid' });
    const localPeer = await f.connect(), remotePeer = await f.connect(remote.id);
    localPeer.state.pages = cursor => cursor === null ? { data: [], nextCursor: 'next' } : { data: localPeer.state.items, nextCursor: null };
    assert.equal((await f.request()).status, 200);
    assert.equal((await f.request(undefined, { hostId: remote.id })).status, 200);
    assert.equal(localPeer.state.mutationCount, 1); assert.equal(remotePeer.state.mutationCount, 1);
    assert.deepEqual(localPeer.requests.filter(request => request.method === 'thread/items/list').map(request => (request.params as any).cursor), [null, 'next', null, 'next']);
  } finally { await f.close(); }
});

test('pagination cycles and oversized native reply envelopes fail before any model submission', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect();
    peer.state.pages = () => ({ data: [], nextCursor: 'repeated-cursor' });
    assert.equal((await f.request()).status, 409);
    assert.equal(peer.requests.filter(request => request.method === 'thread/items/list').length, 2);
    peer.state.pages = undefined;
    peer.state.items[0].item.questions[0].title = 'x'.repeat(2000);
    assert.equal((await f.request({ turnId: 'question-turn', answers: ['中'.repeat(16000)] })).status, 400);
    assert.equal(peer.state.mutationCount, 0);
  } finally { await f.close(); }
});

test('summary omissions cannot hide a persisted steering reply and cause the async question to be answered twice', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect();
    const initial = { type: 'userMessage', id: 'initial', content: [{ type: 'text', text: 'Initial task' }] };
    const reply = { type: 'userMessage', id: 'steering-answer', content: [{ type: 'text', text: asyncQuestionReplyText(question, ['Two']) }] };
    peer.state.status = 'active';
    peer.state.turns.unshift({ id: 'running-turn', status: 'inProgress', items: [initial], fullItems: [initial, reply] });
    const response = await f.request(); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, alreadyAnswered: true });
    assert.equal(peer.state.mutationCount, 0);
    assert.ok(peer.requests.some(request => request.method === 'thread/items/list' && (request.params as any).turnId === 'running-turn'));
  } finally { await f.close(); }
});

test('an uncertain answer unlocks from full item history even when the latest native summary omitted its steering input', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect(); peer.state.status = 'active';
    peer.state.turns.unshift({ id: 'running-turn', status: 'inProgress', items: [] });
    peer.state.failure = { code: -32000, message: 'Lost acknowledgement', data: { uncertain: true } };
    assert.equal((await f.request()).status, 409);
    peer.state.failure = undefined;
    const input = (peer.requests.find(request => request.method === 'turn/steer')!.params as any).input;
    peer.state.turns[0].fullItems = [{ type: 'userMessage', id: 'lost-ack-steer', content: input }];
    const response = await f.request(); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, alreadyAnswered: true });
    assert.equal(peer.state.mutationCount, 1);
  } finally { await f.close(); }
});

test('unverifiable full item histories fail closed rather than treating omitted inputs as unanswered', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect(); peer.state.status = 'active';
    peer.state.turns.unshift({ id: 'running-turn', status: 'inProgress', items: [] });
    peer.state.pages = (cursor, turnId) => turnId === 'question-turn' ? { data: peer.state.items, nextCursor: null } : { data: [], nextCursor: String(Number(cursor || '0') + 1) };
    const response = await f.request(); assert.equal(response.status, 409);
    assert.equal((await response.json() as any).code, 'async_question_history_limit');
    assert.equal(peer.state.mutationCount, 0);
  } finally { await f.close(); }
});

test('async answer status is authenticated and read only, with strict query validation and no CSRF requirement', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.status({} as any)).status, 401);
    assert.equal((await f.status(undefined, '?turnId=')).status, 400);
    assert.equal((await f.status(undefined, '?turnId=question-turn&answer=Forged')).status, 400);
    assert.equal(f.application.bridges.size, 0);
    const response = await f.status(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { answered: false });
    const cacheBusted = await f.status(undefined, '?turnId=question-turn&_request=6b3e0409-c550-4a0a-bc85-f08e014094ed');
    assert.equal(cacheBusted.status, 200); assert.deepEqual(await cacheBusted.json(), { answered: false });
    assert.equal((await f.status(undefined, '?turnId=question-turn&_request=' + 'x'.repeat(257))).status, 400);
    assert.equal(f.peers.get('local')!.state.mutationCount, 0);
  } finally { await f.close(); }
});

test('read-only status finds native steering answers omitted from summaries without exposing their content', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect(); peer.state.status = 'active';
    peer.state.turns.unshift({ id: 'current', status: 'inProgress', items: [], fullItems: [{ type: 'userMessage', id: 'answer', content: [{ type: 'text', text: asyncQuestionReplyText(question, ['Private answer']) }] }] });
    const response = await f.status(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { answered: true });
    assert.equal(peer.state.mutationCount, 0);
  } finally { await f.close(); }
});

test('checking an uncertain answer status cannot release its claim or dispatch another turn', async () => {
  const f = await fixture();
  try {
    const peer = await f.connect(); peer.state.failure = { code: -32000, message: 'Lost acknowledgement', data: { uncertain: true } };
    assert.equal((await f.request()).status, 409); peer.state.failure = undefined;
    const status = await f.status(); assert.equal(status.status, 200); assert.deepEqual(await status.json(), { answered: false });
    assert.equal((await f.request()).status, 409); assert.equal(peer.state.mutationCount, 1);
  } finally { await f.close(); }
});
