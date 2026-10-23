import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createServer } from './app.js';
import { PromptPresets, MAX_PROMPT_PRESETS_BYTES, promptPresetInput } from './prompt-presets.js';
import { emptyPromptPresets, type PromptPresetInput, type PromptPresetsSnapshot } from '../shared/prompt-presets.js';
import type { Transport } from './bridge.js';
import type { RpcMessage } from './types.js';

const directory = () => fs.mkdtemp(path.join(os.tmpdir(), 'codex-prompt-presets-'));
const input = (overrides: Partial<PromptPresetInput> = {}): PromptPresetInput => ({
  name: 'Review', content: 'Review the current changes.\nCheck for regressions.', kind: 'prompt', expectedVersion: 0, ...overrides,
});
async function storeAt(root: string) {
  const store = new PromptPresets(path.join(root, 'prompt-presets.json')); await store.init(); return store;
}

test('ten empty slots are independent clones with stable slot numbers', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await storeAt(root), snapshot = store.get();
  assert.deepEqual(snapshot, emptyPromptPresets());
  assert.deepEqual(snapshot.presets.map(preset => preset.slot), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  snapshot.presets[0]!.name = 'Mutated'; snapshot.presets.pop(); snapshot.revision = 100;
  assert.deepEqual(store.get(), emptyPromptPresets());
  assert.equal(await fs.access(store.file).then(() => true, () => false), false);
});

test('prompt presets preserve content, trim names and persist privately across restart', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await storeAt(root), content = '  检查中文路径。\n\n```ts\nconst name = "示例";\n```\n  ';
  const result = await store.update(10, input({ name: '  中文审查  ', content }));
  assert.deepEqual(result.presets[9], { slot: 10, name: '中文审查', content, kind: 'prompt', version: 1 });
  assert.equal(result.revision, 1);
  assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  const restored = await storeAt(root); assert.deepEqual(restored.get(), result);
  const snapshot = restored.get(); snapshot.presets[9]!.content = 'Changed';
  assert.equal(restored.get().presets[9]!.content, content);
  assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), []);
});

test('concurrent edits to different slots survive while same-slot writes use compare-and-swap', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await storeAt(root);
  await Promise.all([store.update(1, input()), store.update(2, input({ name: 'Second' }))]);
  assert.equal(store.get().revision, 2);
  const writes = await Promise.allSettled([
    store.update(1, input({ name: 'First edit', expectedVersion: 1 })),
    store.update(1, input({ name: 'Stale edit', expectedVersion: 1 })),
  ]);
  assert.equal(writes[0]!.status, 'fulfilled'); assert.equal(writes[1]!.status, 'rejected');
  if (writes[1]!.status === 'rejected') assert.equal(writes[1].reason.code, 'PRESET_CONFLICT');
  assert.equal(store.get().presets[0]!.name, 'First edit');
  assert.equal(store.get().presets[1]!.name, 'Second'); assert.equal(store.get().revision, 3);
});

test('clearing a slot retains its version and prevents stale devices resurrecting it after restart', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await storeAt(root); await store.update(3, input());
  const result = await store.remove(3, { expectedVersion: 1 });
  assert.deepEqual(result.presets[2], { slot: 3, name: '', content: '', kind: 'prompt', version: 2 });
  const restored = await storeAt(root);
  await assert.rejects(restored.update(3, input({ expectedVersion: 1 })), { status: 409, code: 'PRESET_CONFLICT' });
  await assert.rejects(restored.remove(3, { expectedVersion: 1 }), { status: 409, code: 'PRESET_CONFLICT' });
  const final = await restored.update(3, input({ expectedVersion: 2 }));
  assert.equal(final.presets[2]!.version, 3); assert.equal(final.revision, 3);
});

test('strict inputs reject invalid slots, injected fields, empty text and oversized or multiline commands', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await storeAt(root);
  for (const slot of [0, 11, -1, 1.1, '1', NaN]) assert.throws(() => store.update(slot, input()));
  for (const fields of [
    { name: '' }, { name: '   ' }, { name: 'a'.repeat(81) }, { name: 'bad\nname' },
    { content: '  \n' }, { content: '\0' }, { content: 'a'.repeat(16001) }, { kind: 'shell' },
    { expectedVersion: -1 }, { expectedVersion: 0.5 }, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { slot: 2 }, { hostId: 'other' }, { kind: 'command', content: 'rm -rf /' },
    { kind: 'command', content: '/model\n/permissions never' }, { kind: 'command', content: '/model\r extra' },
    { kind: 'command', content: '/model ' + 'a'.repeat(2000) },
  ]) assert.equal(promptPresetInput.safeParse({ ...input(), ...fields }).success, false, JSON.stringify(fields).slice(0, 100));
  assert.throws(() => store.remove(1, {})); assert.throws(() => store.remove(1, { expectedVersion: 0, other: 1 }));
  assert.deepEqual(store.get(), emptyPromptPresets());
});

test('command presets accept slash commands as inert text, including quoted and Chinese arguments', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await storeAt(root);
  const content = '/model "provider/model" high';
  await store.update(1, input({ kind: 'command', content }));
  await store.update(2, input({ kind: 'command', content: '/review 检查 $HOME && echo test' }));
  assert.equal(store.get().presets[0]!.content, content); assert.equal(store.get().revision, 2);
  assert.equal(promptPresetInput.safeParse(input({ content: 'a'.repeat(16000) })).success, true);
  assert.equal(promptPresetInput.safeParse(input({ kind: 'command', content: '/x ' + 'a'.repeat(1997) })).success, true);
});

test('failed atomic writes preserve state and emit no event, and the queue remains usable', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await storeAt(root); await store.update(1, input());
  const before = store.get(), previousFile = await fs.readFile(store.file, 'utf8'), events: PromptPresetsSnapshot[] = [];
  store.subscribe(snapshot => { events.push(snapshot); });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (source: string, destination: string) => {
    if (destination === store.file) throw new Error('Preset disk failure');
    return rename(source, destination);
  });
  try {
    await assert.rejects(store.update(1, input({ expectedVersion: 1, name: 'Lost' })), /Preset disk failure/);
    assert.deepEqual(store.get(), before); assert.deepEqual(events, []);
    assert.equal(await fs.readFile(store.file, 'utf8'), previousFile);
    assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), []);
  } finally { t.mock.restoreAll(); }
  await store.update(2, input()); assert.equal(events.length, 1); assert.equal(store.get().revision, 2);
});

test('subscriber exceptions and mutable snapshots cannot change saved presets; unsubscribe stops events', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await storeAt(root); let events = 0;
  const unsubscribe = store.subscribe(snapshot => { ++events; snapshot.presets[0]!.name = 'Mutated'; throw new Error('Disconnected browser'); });
  const result = await store.update(1, input());
  assert.equal(result.presets[0]!.name, 'Review'); assert.equal(store.get().presets[0]!.name, 'Review');
  unsubscribe(); await store.remove(1, { expectedVersion: 1 }); assert.equal(events, 1);
});

test('invalid, oversized, duplicate or symlinked journals fail closed without overwriting saved data', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'prompt-presets.json');
  const fresh = { version: 1, ...emptyPromptPresets() };
  const duplicate = structuredClone(fresh); duplicate.presets[1]!.slot = 1;
  const revision = { ...fresh, revision: 2 };
  const unexpected = { ...fresh, hostId: 'injected' };
  for (const content of ['{not-json', JSON.stringify(duplicate), JSON.stringify(revision), JSON.stringify(unexpected), ' '.repeat(MAX_PROMPT_PRESETS_BYTES + 1)]) {
    await fs.writeFile(file, content); await assert.rejects(storeAt(root), /Unable to read prompt-presets.json/);
    assert.equal(await fs.readFile(file, 'utf8'), content);
  }
  await fs.rm(file); const target = path.join(root, 'other.json'); await fs.writeFile(target, JSON.stringify(fresh));
  await fs.symlink(target, file); await assert.rejects(storeAt(root), /Unable to read prompt-presets.json/);
  assert.equal(await fs.readFile(target, 'utf8'), JSON.stringify(fresh));
});

const password = 'prompt-presets-test-password-123';
async function login(base: string) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const { csrfToken } = await response.json() as { csrfToken: string };
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json', 'x-csrf-token': csrfToken };
}
function transport(methods: string[]): Transport {
  const input = new PassThrough(), output = new PassThrough(); let buffer = '';
  input.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, index)) as RpcMessage;
      buffer = buffer.slice(index + 1); methods.push(message.method || '');
      if (message.id !== undefined) output.write(JSON.stringify({ id: message.id, result: { userAgent: 'prompt-presets-test', codexHome: '/test' } }) + '\n');
    }
  });
  return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy(); } };
}
async function serve(root: string, transportFactory: () => Transport = () => { throw new Error('Preset editing must not start Codex'); }) {
  const app = await createServer({ dataDir: root, cwd: root, codexHome: path.join(root, 'home'), password, secureCookie: false, serveStatic: false, bridgeOptions: { transportFactory } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: 'http://127.0.0.1:' + (app.server.address() as { port: number }).port };
}
function nextFrame(ws: WebSocket, method: string, accepts: (frame: any) => boolean = () => true): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('Timed out waiting for ' + method)); }, 5000);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.method !== method || method === 'bridge/status' && !frame.params?.connected || !accepts(frame)) return;
      clearTimeout(timer); ws.off('message', onMessage); resolve(frame);
    };
    ws.on('message', onMessage);
  });
}

test('HTTP presets enforce auth, CSRF, strict slots and CAS, and bootstrap has all ten slots without a host connection', async t => {
  const root = await directory(), { app, base } = await serve(root);
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const headers = await login(base);
  const write = (slot: string, body: unknown, supplied = headers, method = 'PUT') => fetch(base + '/api/prompt-presets/' + slot, { method, headers: supplied, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/prompt-presets')).status, 401);
  assert.equal((await write('1', input(), { 'content-type': 'application/json' } as any)).status, 401);
  assert.equal((await write('1', input(), { cookie: headers.cookie, 'content-type': 'application/json' } as any)).status, 403);
  assert.equal((await write('1', input(), { ...headers, origin: 'https://attacker.invalid' })).status, 403);
  for (const slot of ['0', '11', '1.0', '01', 'NaN']) assert.equal((await write(slot, input())).status, 400);
  assert.equal((await write('1', { ...input(), hostId: 'other' })).status, 400);
  assert.equal((await write('1', { ...input(), kind: 'command', content: '/goal\nmore' })).status, 400);
  const response = await write('1', input()); assert.equal(response.status, 200);
  const snapshot = await response.json() as PromptPresetsSnapshot;
  assert.equal(snapshot.presets.length, 10); assert.equal(snapshot.revision, 1);
  const stale = await write('1', input()); assert.equal(stale.status, 409);
  assert.equal((await stale.json() as any).code, 'PRESET_CONFLICT');
  const beforeDelete = await write('1', { expectedVersion: 0 }, headers, 'DELETE'); assert.equal(beforeDelete.status, 409);
  const deleted = await write('1', { expectedVersion: 1 }, headers, 'DELETE'); assert.equal(deleted.status, 200);
  const snapshotAfterDelete = await deleted.json() as PromptPresetsSnapshot;
  assert.equal(snapshotAfterDelete.presets[0]!.version, 2); assert.equal(snapshotAfterDelete.presets[0]!.name, '');
  const listed = await fetch(base + '/api/prompt-presets', { headers }); assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await listed.json(), snapshotAfterDelete);
  const bootstrap = await fetch(base + '/api/bootstrap', { headers }); assert.deepEqual((await bootstrap.json() as any).promptPresets, snapshotAfterDelete);
  assert.equal(app.bridges.size, 0);
  await app.storage.setLocalEnabled(false);
  assert.equal((await write('2', input())).status, 200); assert.equal(app.bridges.size, 0);
});

test('preset changes reach devices connected to different hosts without native requests or transport resets', async t => {
  const root = await directory(), methods: string[] = [], { app, base } = await serve(root, () => transport(methods));
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const remote = await app.storage.addHost({ name: 'NAS', hostname: 'nas.example' });
  const headers = await login(base), sockets: WebSocket[] = [];
  t.after(() => sockets.forEach(socket => socket.terminate()));
  for (const hostId of ['local', remote.id]) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + `/api/rpc?host=${hostId}&clientId=preset_device_${sockets.length}`, { headers: { cookie: headers.cookie, origin: 'http://localhost:8787' } });
    sockets.push(ws);
    const initial = nextFrame(ws, 'bridge/prompt-presets/changed');
    await nextFrame(ws, 'bridge/status'); assert.deepEqual((await initial).params, emptyPromptPresets());
  }
  const before = [...methods], messages = sockets.map(socket => nextFrame(socket, 'bridge/prompt-presets/changed', frame => frame.params?.revision === 1));
  const response = await fetch(base + '/api/prompt-presets/5', { method: 'PUT', headers, body: JSON.stringify(input()) });
  const snapshot = await response.json();
  for (const frame of await Promise.all(messages)) assert.deepEqual(frame.params, snapshot);
  assert.deepEqual(methods, before); assert.ok(sockets.every(socket => socket.readyState === WebSocket.OPEN));
});

test('offline preset edits are sent before native replay when a browser reconnects, without restarting Codex', async t => {
  const root = await directory(), methods: string[] = []; let transports = 0;
  const { app, base } = await serve(root, () => { ++transports; return transport(methods); });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const headers = await login(base), sockets: WebSocket[] = [];
  t.after(() => sockets.forEach(socket => socket.terminate()));
  const connect = async (revision: number) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/rpc?host=local&clientId=preset_reconnecting_device',
      { headers: { cookie: headers.cookie, origin: 'http://localhost:8787' } });
    sockets.push(ws); const order: string[] = [];
    ws.on('message', data => { const frame = JSON.parse(data.toString()); order.push(frame.method); });
    const snapshot = nextFrame(ws, 'bridge/prompt-presets/changed', frame => frame.params?.revision === revision);
    await Promise.all([nextFrame(ws, 'bridge/status'), snapshot]);
    assert.equal(order[0], 'bridge/prompt-presets/changed');
    return ws;
  };
  const first = await connect(0), beforeTransports = transports, native = app.bridges.get('local');
  await new Promise<void>(resolve => { first.once('close', () => resolve()); first.close(); });
  const before = [...methods]; await app.promptPresets.update(1, input());
  const second = await connect(1); assert.equal(second.readyState, WebSocket.OPEN);
  assert.equal(transports, beforeTransports); assert.equal(app.bridges.get('local'), native); assert.deepEqual(methods, before);
});
