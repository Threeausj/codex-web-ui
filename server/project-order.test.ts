import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Storage } from './storage.js';
import { createServer } from './app.js';
import { orderProjects, projectOrderKey } from '../shared/project-order.js';
import type { Transport } from './bridge.js';
import type { RpcMessage } from './types.js';

const directory = () => fs.mkdtemp(path.join(os.tmpdir(), 'codex-project-order-'));
const identities = (projects: { hostId: string; path: string }[]) => projects.map(({ hostId, path }) => ({ hostId, path }));
async function setup(root: string) {
  const storage = new Storage(root, path.join(root, 'home'), '/workspace');
  await storage.init();
  const host = await storage.addHost({ name: 'NAS', hostname: 'nas.example' });
  await storage.addProject(host.id, '/workspace', 'NAS Workspace');
  await storage.addProject('local', '/workspace/second', 'Second');
  return { storage, host };
}

test('project identities distinguish matching paths and colons across hosts and keep new projects visible', () => {
  const projects = [{ hostId: 'local', path: '/a' }, { hostId: 'nas', path: '/a' }, { hostId: 'local', path: '/a:b' }];
  const order = [projects[2]!, projects[1]!, projects[1]!, { hostId: 'missing', path: '/gone' }];
  assert.deepEqual(orderProjects(projects, order), [projects[2], projects[1], projects[0]]);
  assert.deepEqual(projects.map(projectOrderKey), ['["local","/a"]', '["nas","/a"]', '["local","/a:b"]']);
});

test('project order persists privately without rewriting project settings or SSH configuration', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { storage } = await setup(root);
  const previousProjects = await fs.readFile(path.join(root, 'projects.json'), 'utf8');
  const previousHosts = await fs.readFile(path.join(root, 'hosts.json'), 'utf8');
  const requested = identities(await storage.projects()).reverse(), events: unknown[] = [];
  const unsubscribe = storage.subscribeProjectOrder(order => events.push(order));
  const result = await storage.reorderProjects({ projects: requested });
  assert.deepEqual(identities(result), requested); assert.deepEqual(events, [requested]);
  assert.equal(await fs.readFile(path.join(root, 'projects.json'), 'utf8'), previousProjects);
  assert.equal(await fs.readFile(path.join(root, 'hosts.json'), 'utf8'), previousHosts);
  assert.equal((await fs.stat(path.join(root, 'project-order.json'))).mode & 0o777, 0o600);
  const restored = new Storage(root, path.join(root, 'home'), '/workspace'); await restored.init();
  assert.deepEqual(identities(await restored.projects()), requested);
  unsubscribe(); await storage.reorderProjects({ projects: [...requested].reverse() });
  assert.equal(events.length, 1);
});

test('hidden local projects retain their slots and new projects append after a custom order', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { storage, host } = await setup(root);
  const before = identities(await storage.projects());
  await storage.reorderProjects({ projects: [before[2]!, before[1]!, before[0]!] });
  await storage.setLocalEnabled(false);
  await storage.reorderProjects({ projects: [{ hostId: host.id, path: '/workspace' }] });
  await storage.setLocalEnabled(true);
  assert.deepEqual(identities(await storage.projects()), [before[2], before[1], before[0]]);
  await storage.addProject(host.id, '/new', 'New');
  assert.deepEqual(identities(await storage.projects()), [before[2], before[1], before[0], { hostId: host.id, path: '/new' }]);
  await storage.removeProject(host.id, '/workspace');
  assert.deepEqual(identities(await storage.projects()), [before[2], before[0], { hostId: host.id, path: '/new' }]);
});

test('stale, missing, duplicate or injected project identities fail before updating order', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { storage } = await setup(root), before = identities(await storage.projects());
  for (const request of [{}, { projects: [before[0], before[0]] }, { projects: before, cwd: '/override' },
    { projects: [{ hostId: 'local', path: '/bad\npath' }] }, { projects: [{ hostId: 'local', path: 'relative' }] }])
    await assert.rejects(storage.reorderProjects(request));
  for (const projects of [[], before.slice(1), [...before, { hostId: 'local', path: '/missing' }]])
    await assert.rejects(storage.reorderProjects({ projects }), { status: 409 });
  assert.deepEqual(identities(await storage.projects()), before);
  assert.equal(await fs.access(path.join(root, 'project-order.json')).then(() => true, () => false), false);
});

test('failed atomic project-order writes preserve the old order and publish no event', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { storage } = await setup(root), before = identities(await storage.projects());
  let events = 0; storage.subscribeProjectOrder(() => { ++events });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (source: string, destination: string) => {
    if (destination === path.join(root, 'project-order.json')) throw new Error('Order disk failure');
    return rename(source, destination);
  });
  try {
    await assert.rejects(storage.reorderProjects({ projects: [...before].reverse() }), /Order disk failure/);
    assert.deepEqual(identities(await storage.projects()), before); assert.equal(events, 0);
    assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), []);
    t.mock.restoreAll(); await storage.reorderProjects({ projects: [...before].reverse() }); assert.equal(events, 1);
  } finally { t.mock.restoreAll(); }
});

test('a concurrent project addition invalidates a stale sort inside the shared mutation queue', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { storage } = await setup(root), before = identities(await storage.projects());
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (source: string, destination: string) => {
    if (destination === path.join(root, 'projects.json')) { entered(); await gate; }
    return rename(source, destination);
  });
  try {
    let events = 0; storage.subscribeProjectOrder(() => { ++events; });
    const addition = storage.addProject('local', '/concurrent', 'Concurrent');
    await blocked;
    const stale = assert.rejects(storage.reorderProjects({ projects: [...before].reverse() }), { status: 409 });
    release(); await Promise.all([addition, stale]);
    assert.equal(events, 0);
    assert.deepEqual(identities(await storage.projects()), [...before, { hostId: 'local', path: '/concurrent' }]);
  } finally { release(); t.mock.restoreAll(); }
});

const password = 'project-order-test-password-123';
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
      if (message.id !== undefined) output.write(JSON.stringify({ id: message.id, result: { userAgent: 'project-order-test', codexHome: '/test' } }) + '\n');
    }
  });
  return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy(); } };
}
async function serve(root: string, transportFactory: () => Transport = () => { throw new Error('Sorting must not start Codex'); }) {
  const app = await createServer({ dataDir: root, cwd: root, codexHome: path.join(root, 'home'), password, secureCookie: false, serveStatic: false, bridgeOptions: { transportFactory } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: 'http://127.0.0.1:' + (app.server.address() as { port: number }).port };
}
function nextFrame(ws: WebSocket, method: string, accepts: (frame: any) => boolean = () => true): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('Timed out waiting for ' + method)); }, 5000);
    const onMessage = (data: WebSocket.RawData) => { const frame = JSON.parse(data.toString()); if (frame.method !== method || method === 'bridge/status' && !frame.params?.connected || !accepts(frame)) return; clearTimeout(timer); ws.off('message', onMessage); resolve(frame); };
    ws.on('message', onMessage);
  });
}

test('project order HTTP route enforces auth, CSRF and full inventory without starting Codex', async t => {
  const root = await directory(), { app, base } = await serve(root);
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const headers = await login(base), projects = identities(await app.storage.projects());
  const write = (body: unknown, supplied = headers) => fetch(base + '/api/projects/order', { method: 'PATCH', headers: supplied, body: JSON.stringify(body) });
  assert.equal((await write({ projects }, { 'content-type': 'application/json' } as any)).status, 401);
  assert.equal((await write({ projects }, { cookie: headers.cookie, 'content-type': 'application/json' } as any)).status, 403);
  assert.equal((await write({ projects }, { ...headers, origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await write({ projects, cwd: '/injected' })).status, 400);
  assert.equal((await write({ projects: [] })).status, 409);
  const result = await write({ projects }); assert.equal(result.status, 200);
  assert.deepEqual(identities((await result.json() as any).projects), projects);
  assert.equal(app.bridges.size, 0);
});

test('shared project order reaches devices on different hosts without native RPC or transport resets', async t => {
  const root = await directory(), methods: string[] = [];
  const { app, base } = await serve(root, () => transport(methods));
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const remote = await app.storage.addHost({ name: 'NAS', hostname: 'nas.example' });
  await app.storage.addProject(remote.id, '/workspace', 'NAS Workspace');
  const headers = await login(base), sockets: WebSocket[] = [];
  t.after(() => sockets.forEach(socket => socket.terminate()));
  for (const hostId of ['local', remote.id]) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + `/api/rpc?host=${hostId}&clientId=device_${sockets.length}`, { headers: { cookie: headers.cookie, origin: 'http://localhost:8787' } });
    sockets.push(ws); await nextFrame(ws, 'bridge/status');
  }
  const before = [...methods], requests = identities(await app.storage.projects()).reverse();
  const messages = sockets.map(socket => nextFrame(socket, 'bridge/project-order/changed', frame => JSON.stringify(frame.params?.projects) === JSON.stringify(requests)));
  const response = await fetch(base + '/api/projects/order', { method: 'PATCH', headers, body: JSON.stringify({ projects: requests }) });
  assert.equal(response.status, 200);
  for (const frame of await Promise.all(messages)) assert.deepEqual(frame.params, { projects: requests });
  assert.deepEqual(methods, before); assert.ok(sockets.every(socket => socket.readyState === WebSocket.OPEN));
});

test('a reconnected browser receives the current project order after missing an offline change without restarting Codex', async t => {
  const root = await directory(), methods: string[] = []; let transports = 0;
  const { app, base } = await serve(root, () => { ++transports; return transport(methods); });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  await app.storage.addProject('local', '/workspace/second', 'Second');
  const headers = await login(base), sockets: WebSocket[] = [];
  t.after(() => sockets.forEach(socket => socket.terminate()));
  const initialOrder = identities(await app.storage.projects());
  const connect = async (expected: typeof initialOrder) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/rpc?host=local&clientId=reconnecting_device',
      { headers: { cookie: headers.cookie, origin: 'http://localhost:8787' } });
    sockets.push(ws);
    const snapshot = nextFrame(ws, 'bridge/project-order/changed', frame => JSON.stringify(frame.params?.projects) === JSON.stringify(expected));
    await Promise.all([nextFrame(ws, 'bridge/status'), snapshot]);
    return ws;
  };
  const first = await connect(initialOrder);
  const before = [...methods], native = app.bridges.get('local'), beforeTransports = transports;
  await new Promise<void>(resolve => { first.once('close', () => resolve()); first.close(); });
  const changed = [...initialOrder].reverse();
  const response = await fetch(base + '/api/projects/order', { method: 'PATCH', headers, body: JSON.stringify({ projects: changed }) });
  assert.equal(response.status, 200);
  const second = await connect(changed);
  assert.equal(second.readyState, WebSocket.OPEN);
  assert.equal(app.bridges.get('local'), native);
  assert.equal(transports, beforeTransports);
  assert.deepEqual(methods, before);
});
