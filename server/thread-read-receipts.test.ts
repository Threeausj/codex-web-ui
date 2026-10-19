import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ThreadReadReceipts, MAX_THREAD_READ_RECEIPT_BYTES } from './thread-read-receipts.js';
import { createServer } from './app.js';
import type { Transport } from './bridge.js';
import type { RpcMessage } from './types.js';
import {
  isThreadReadReceipt, isStoredThreadReadReceipt, MAX_THREAD_READ_RECEIPTS,
  MAX_THREAD_READ_TURN_IDS, type ThreadReadReceipt, type StoredThreadReadReceipt,
} from '../shared/thread-read-receipts.js';

const directory = () => fs.mkdtemp(path.join(os.tmpdir(), 'codex-thread-read-receipts-'));
const receipt = (turnId = 'turn-new', activityAt = 100, hostId = 'local', threadId = 'thread-one'): ThreadReadReceipt => ({ hostId, threadId, turnId, activityAt });
const stored = (turnIds = ['turn-new'], activityAt = 100, hostId = 'local', threadId = 'thread-one'): StoredThreadReadReceipt => ({ hostId, threadId, turnIds, activityAt });

test('concurrent old and new acknowledgements merge per host/thread and survive restart privately', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'thread-read-receipts.json');
    const journal = new ThreadReadReceipts(file); await journal.init();
    const events: StoredThreadReadReceipt[][] = [];
    const unsubscribe = journal.subscribe(updates => { events.push(updates); });
    await Promise.all([
      journal.acknowledge([receipt('turn-new', 200)]),
      journal.acknowledge([receipt('turn-old', 100)]),
      journal.acknowledge([receipt('remote-turn', 300, 'remote')]),
    ]);
    assert.deepEqual(journal.list(), [stored(['turn-old', 'turn-new'], 200), stored(['remote-turn'], 300, 'remote')]);
    assert.deepEqual(await journal.acknowledge([receipt('turn-old', 90)]), [stored(['turn-old', 'turn-new'], 200)]);
    assert.equal(events.length, 3, 'duplicate/older read receipts do not cause another write or broadcast');
    unsubscribe();
    await journal.acknowledge([receipt('turn-next', 205)]);
    assert.equal(events.length, 3);
    const restored = new ThreadReadReceipts(file); await restored.init();
    assert.deepEqual(restored.list(), journal.list());
    const copied = restored.list(); copied[0]!.turnIds.push('mutated');
    assert.deepEqual(restored.list(), journal.list());
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), []);
    assert.equal((await fs.readFile(file, 'utf8')).includes('readAt'), false, 'device wall-clock time is not persisted');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('acknowledgement turn history and journal capacity remain bounded', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'thread-read-receipts.json');
    const existing = Array.from({ length: MAX_THREAD_READ_RECEIPTS }, (_, i) => stored(['turn'], i, 'local', 'thread-' + i));
    await fs.writeFile(file, JSON.stringify({ version: 1, receipts: existing }));
    const journal = new ThreadReadReceipts(file); await journal.init();
    for (let i = 0; i < MAX_THREAD_READ_TURN_IDS + 3; ++i) await journal.acknowledge([receipt('turn-' + i, 5000 + i)]);
    assert.equal(journal.list().length, MAX_THREAD_READ_RECEIPTS);
    assert.equal(journal.list().some(entry => entry.threadId === 'thread-0'), false, 'old records are evicted');
    const latest = journal.list().find(entry => entry.threadId === 'thread-one')!;
    assert.deepEqual(latest.turnIds, Array.from({ length: MAX_THREAD_READ_TURN_IDS }, (_, i) => 'turn-' + (i + 3)));
    assert.equal(latest.activityAt, 5000 + MAX_THREAD_READ_TURN_IDS + 2);
    let lateEvents = 0; journal.subscribe(() => { ++lateEvents; });
    await journal.acknowledge([receipt('very-old-turn', 10)]);
    assert.deepEqual(journal.list().find(entry => entry.threadId === 'thread-one'), latest, 'late older acknowledgements cannot evict the newest turn');
    assert.equal(lateEvents, 0, 'a bounded no-op does not broadcast a duplicate');
    assert.ok((await fs.stat(file)).size <= MAX_THREAD_READ_RECEIPT_BYTES);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('receipt validation rejects extra fields, controls, excessive sizes and invalid Unix seconds', async () => {
  const root = await directory();
  try {
    const journal = new ThreadReadReceipts(path.join(root, 'thread-read-receipts.json')); await journal.init();
    for (const value of [null, {}, { ...receipt(), readAt: 999999999 }, { ...receipt(), hostId: '' },
      { ...receipt(), threadId: ' \n' }, { ...receipt(), turnId: 'bad\x7f' }, { ...receipt(), hostId: 'x'.repeat(257) },
      { ...receipt(), activityAt: -1 }, { ...receipt(), activityAt: NaN }, { ...receipt(), activityAt: Infinity },
      { ...receipt(), activityAt: Date.now() }, { ...receipt(), activityAt: '100' }]) {
      assert.equal(isThreadReadReceipt(value), false);
      assert.throws(() => journal.acknowledge([value]));
    }
    assert.throws(() => journal.acknowledge([]));
    assert.throws(() => journal.acknowledge(Array.from({ length: 51 }, () => receipt())));
    assert.equal(isThreadReadReceipt(receipt('turn', 100.5)), true);
    assert.equal(isStoredThreadReadReceipt({ ...stored(), turnIds: ['duplicate', 'duplicate'] }), false);
    assert.equal(isStoredThreadReadReceipt({ ...stored(), turnIds: Array.from({ length: 17 }, (_, i) => String(i)) }), false);
    assert.equal(isStoredThreadReadReceipt({ ...stored(), turnIds: [] }), false);
    assert.deepEqual(journal.list(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('byte pressure evicts older records while retaining every receipt in the current batch', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'thread-read-receipts.json');
    const turnIds = Array.from({ length: MAX_THREAD_READ_TURN_IDS }, (_, i) => String(i).padStart(2, '0') + 'x'.repeat(254));
    const sample = stored(turnIds, 100, 'local', 'thread-00000');
    const entryBytes = Buffer.byteLength(JSON.stringify(sample, null, 2)) + 4 * (turnIds.length + 7) + 2;
    const count = Math.floor((MAX_THREAD_READ_RECEIPT_BYTES - 64) / entryBytes);
    const existing = Array.from({ length: count }, (_, i) => stored(turnIds, 100, 'local', 'thread-' + String(i).padStart(5, '0')));
    await fs.writeFile(file, JSON.stringify({ version: 1, receipts: existing }, null, 2) + '\n');
    const journal = new ThreadReadReceipts(file); await journal.init();
    const batch = [receipt(turnIds[0], 100, 'local', 'thread-00000'),
      ...Array.from({ length: 49 }, (_, i) => receipt('new-' + i, 200, 'local', 'new-thread-' + i))];
    const result = await journal.acknowledge(batch);
    assert.equal(result.length, 50);
    assert.ok(journal.list().some(entry => entry.threadId === 'thread-00000'), 'an unchanged requested receipt is retained');
    assert.equal(journal.list().some(entry => entry.threadId === 'thread-00001'), false);
    assert.ok((await fs.stat(file)).size <= MAX_THREAD_READ_RECEIPT_BYTES);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failed writes publish no changes and damaged stored documents fail closed', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'thread-read-receipts.json');
    const journal = new ThreadReadReceipts(file); await journal.init();
    let events = 0; journal.subscribe(() => { ++events; });
    await fs.mkdir(file);
    await assert.rejects(journal.acknowledge([receipt()]));
    assert.deepEqual(journal.list(), []); assert.equal(events, 0);
    await fs.rm(file, { recursive: true });
    journal.subscribe(() => { throw new Error('broken listener'); });
    await journal.acknowledge([receipt()]);
    assert.equal(events, 1, 'the serialized queue recovers after a failed write');
    for (const document of [
      { version: 1, receipts: [stored(), stored()] },
      { version: 1, receipts: [{ ...stored(), body: 'private text' }] },
      { version: 1, receipts: [stored()], extra: true },
    ]) {
      const text = JSON.stringify(document); await fs.writeFile(file, text);
      await assert.rejects(new ThreadReadReceipts(file).init());
      assert.equal(await fs.readFile(file, 'utf8'), text, 'corrupt records are not overwritten');
    }
    await fs.writeFile(file, ' '.repeat(MAX_THREAD_READ_RECEIPT_BYTES + 1));
    await assert.rejects(new ThreadReadReceipts(file).init(), /容量上限/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const password = 'thread-read-receipt-test-password';
async function login(base: string) {
  const result = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(result.status, 200);
  const { csrfToken } = await result.json() as { csrfToken: string };
  return { cookie: result.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json', 'x-csrf-token': csrfToken };
}
async function serve(root: string, transportFactory: () => Transport = () => { throw new Error('Read acknowledgements must not start Codex'); }) {
  const app = await createServer({ dataDir: root, cwd: root, codexHome: path.join(root, 'codex'), password,
    secureCookie: false, serveStatic: false, bridgeOptions: { transportFactory } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: 'http://127.0.0.1:' + (app.server.address() as { port: number }).port };
}

test('HTTP receipts require auth and CSRF, validate entire batches, hide removed hosts and use no native Codex', async () => {
  const root = await directory(); const { app, base } = await serve(root);
  try {
    const headers = await login(base);
    const read = (extra = '', supplied = headers) => fetch(base + '/api/thread-read-receipts' + extra, { headers: supplied });
    const write = (receipts: unknown = [receipt()], supplied = headers, body?: unknown) => fetch(base + '/api/thread-read-receipts', {
      method: 'POST', headers: supplied, body: JSON.stringify(body ?? { receipts }),
    });
    assert.equal((await read('', {} as any)).status, 401);
    assert.equal((await write(undefined, { 'content-type': 'application/json' } as any)).status, 401);
    assert.equal((await write(undefined, { cookie: headers.cookie, 'content-type': 'application/json' } as any)).status, 403);
    assert.equal((await write(undefined, { ...headers, origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await write([receipt(), receipt('turn', 100, 'missing')])).status, 404);
    assert.deepEqual(await (await read()).json(), { receipts: [] });
    assert.equal((await write(undefined, headers, { receipts: [receipt()], readAt: 100 })).status, 400);
    assert.equal((await write([{ ...receipt(), text: 'not allowed' }])).status, 400);
    assert.equal((await write(Array.from({ length: 51 }, () => receipt()))).status, 400);
    assert.equal((await read('?unknown=yes')).status, 400);
    assert.deepEqual(await (await write()).json(), { receipts: [stored()] });
    const result = await read('?_request=refresh');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await result.json(), { receipts: [stored()] });
    await app.storage.setLocalEnabled(false);
    assert.deepEqual(await (await read()).json(), { receipts: [] });
    assert.equal((await write()).status, 404);
    const remote = await app.storage.addHost({ name: 'Remote', hostname: 'remote.example' });
    assert.equal((await write([receipt('remote-turn', 200, remote.id)])).status, 200);
    assert.deepEqual(await (await read()).json(), { receipts: [stored(['remote-turn'], 200, remote.id)] });
    await app.storage.setLocalEnabled(true);
    assert.deepEqual(await (await read()).json(), { receipts: [stored(), stored(['remote-turn'], 200, remote.id)] }, 'a temporarily disabled host keeps its private read history');
    assert.equal(app.bridges.size, 0);
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});

function trackingTransport(methods: string[]): Transport {
  const input = new PassThrough(); const output = new PassThrough();
  let buffer = '';
  input.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, at)) as RpcMessage; buffer = buffer.slice(at + 1);
      methods.push(message.method || '');
      if (message.id !== undefined) output.write(JSON.stringify({ id: message.id, result: { userAgent: 'read-receipt-test', codexHome: '/test' } }) + '\n');
    }
  });
  return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy(); } };
}
function nextFrame(ws: WebSocket, method: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('Timed out waiting for ' + method)); }, 5000);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.method !== method) return;
      clearTimeout(timer); ws.off('message', onMessage); resolve(frame);
    };
    ws.on('message', onMessage);
  });
}
async function connect(base: string, cookie: string, hostId: string, clientId: string) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/rpc?host=' + encodeURIComponent(hostId) + '&clientId=' + clientId,
    { headers: { cookie, origin: 'http://localhost:8787' } });
  const status = nextFrame(ws, 'bridge/status');
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await status;
  return ws;
}

test('independent authenticated devices receive persisted receipts on sockets for different hosts', async () => {
  const root = await directory(); const methods: string[] = [];
  const { app, base } = await serve(root, () => trackingTransport(methods));
  try {
    const remote = await app.storage.addHost({ name: 'Remote', hostname: 'remote.example' });
    const first = await login(base); const second = await login(base);
    assert.notEqual(first.cookie, second.cookie);
    const a = await connect(base, first.cookie, 'local', 'first_device');
    const b = await connect(base, second.cookie, remote.id, 'second_device');
    await Promise.all([...app.bridges.values()].map(bridge => bridge.connect()));
    assert.deepEqual([...new Set(methods)].sort(), ['initialize', 'initialized']);
    const count = methods.length;
    const receivedA = nextFrame(a, 'bridge/thread-read-receipts');
    const receivedB = nextFrame(b, 'bridge/thread-read-receipts');
    const response = await fetch(base + '/api/thread-read-receipts', { method: 'POST', headers: first, body: JSON.stringify({ receipts: [receipt()] }) });
    assert.equal(response.status, 200);
    const expected = { method: 'bridge/thread-read-receipts', params: { receipts: [stored()] } };
    assert.deepEqual(await receivedA, expected); assert.deepEqual(await receivedB, expected);
    const saved = JSON.parse(await fs.readFile(path.join(root, 'thread-read-receipts.json'), 'utf8'));
    assert.deepEqual(saved.receipts, [stored()], 'notifications correspond to a durable acknowledgement');
    assert.equal(methods.length, count, 'read sync never issues thread/read or turn/model calls');
    const closed = new Promise<number>(resolve => b.once('close', resolve));
    assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers: second })).status, 200);
    assert.equal(await closed, 4003);
    const newFrame = nextFrame(a, 'bridge/thread-read-receipts');
    await app.threadReadReceipts.acknowledge([receipt('turn-next', 200)]);
    assert.deepEqual((await newFrame).params.receipts, [stored(['turn-new', 'turn-next'], 200)]);
    a.terminate();
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});
