import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { Auth } from './auth.js';
import { PushService } from './push.js';
import { TmuxMonitorService, registerTmuxMonitors, tmuxMonitorUrl } from './tmux-monitors.js';
import { TMUX_MONITOR_HELPER, tmuxMonitorReadingSchema } from './tmux-monitor-reader.js';
import type { Host } from './types.js';
import type { TmuxMonitorPane } from '../shared/tmux-monitors.js';

const host: Host = { id: 'local', name: '本机', kind: 'local' };
const remote: Host = { id: 'ssh-fixture', name: '训练服务器', kind: 'ssh', hostname: 'example.invalid' };
function pane(values: Partial<TmuxMonitorPane> = {}): TmuxMonitorPane {
  return { serverPid: 500, sessionId: '$1', sessionCreatedAt: 100, sessionName: '训练-中文', windowId: '@1', windowIndex: 0, windowName: 'train', paneId: '%1', paneIndex: 0, command: 'python', cwd: '/workspace/train', active: true, dead: false, exitCode: null, jobKey: '700:123:python', ...values };
}
async function fixture(t: { after: (fn: () => unknown) => void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tmux-monitor-'));
  let time = 1000, fail = false, unavailable = false;
  const hosts = new Map([[host.id, host], [remote.id, remote]]);
  const panes = new Map([[host.id, [pane()]], [remote.id, [pane({ paneId: '%2', sessionName: '远程训练' })]]]);
  const notices: any[] = [];
  let failNotice = false;
  let reads = 0;
  const deps = { getHost: (id: string) => hosts.get(id), now: () => ++time, autoStart: false,
    collect: async (selected: Host) => {
      ++reads;
      if (fail) throw new Error('SSH 连接暂时中断');
      return unavailable ? { available: false, reason: 'tmux 暂不可用', panes: [] } : { available: true, panes: structuredClone(panes.get(selected.id) || []) };
    },
    notify: async (_host: Host, value: unknown) => { if (failNotice) throw new Error('投递失败'); notices.push(value); },
  };
  const service = new TmuxMonitorService(directory, deps); await service.initialize();
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, deps, directory, hosts, panes, notices, set fail(value: boolean) { fail = value; }, set unavailable(value: boolean) { unavailable = value; }, set failNotice(value: boolean) { failNotice = value; }, get reads() { return reads; } };
}

test('once monitor records a return to shell once, preserves exact target and never changes the remote process', async t => {
  const f = await fixture(t);
  const created = await f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'once', threadId: 'thread-existing' });
  assert.equal(created.status, 'running'); assert.equal(created.run, 1);
  await f.service.tick(); assert.equal(f.notices.length, 0);
  f.panes.set('local', [pane({ active: false, jobKey: null, command: 'bash' })]);
  await Promise.all([f.service.tick(), f.service.tick()]);
  const value = f.service.get();
  assert.equal(value.monitors[0]!.status, 'completed');
  assert.equal(value.history.length, 1); assert.equal(value.history[0]!.outcome, 'returned-to-shell');
  assert.equal(value.history[0]!.exitCode, null, 'Shell return must not invent a successful exit status');
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].kind, 'completed');
  assert.equal(f.notices[0].url, '/?host=local&tmuxSession=%241&tmuxPane=%251&thread=thread-existing');
  await f.service.tick(); assert.equal(f.notices.length, 1);
  assert.equal((await fs.stat(path.join(f.directory, 'tmux-monitors.json'))).mode & 0o777, 0o600);
});

test('permanent monitors wait for new work and notify once per foreground job across hosts', async t => {
  const f = await fixture(t);
  f.panes.set('local', [pane({ active: false, jobKey: null, command: 'bash' })]);
  await f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'permanent' });
  await f.service.create({ hostId: remote.id, sessionId: '$1', paneId: '%2', mode: 'once' });
  await f.service.tick(); assert.equal(f.notices.length, 0);
  f.panes.set('local', [pane()]);
  await f.service.tick();
  f.panes.set('local', [pane({ jobKey: '800:999:python' })]);
  f.panes.set(remote.id, [pane({ paneId: '%2', sessionName: '远程训练', active: false, jobKey: null, dead: true, exitCode: 137 })]);
  await f.service.tick();
  assert.equal(f.notices.length, 2);
  assert.equal(f.service.get().history.find(event => event.hostId === remote.id)!.outcome, 'failed');
  assert.equal(f.service.get().monitors.find(monitor => monitor.hostId === 'local')!.run, 2);
  assert.equal(f.service.get().monitors.find(monitor => monitor.hostId === 'local')!.status, 'running');
  f.panes.set('local', []);
  await f.service.tick();
  assert.equal(f.service.get().history.filter(event => event.hostId === 'local').length, 2);
  await f.service.tick(); assert.equal(f.notices.length, 3);
  f.panes.set('local', [pane({ serverPid: 501, sessionCreatedAt: 200, sessionId: '$2', paneId: '%9', jobKey: '900:new:python' })]);
  await f.service.tick();
  assert.equal(f.service.get().monitors.find(monitor => monitor.hostId === 'local')!.paneId, '%9');
  assert.equal(f.service.get().monitors.find(monitor => monitor.hostId === 'local')!.run, 3);
});

test('temporary SSH and unavailable tmux never masquerade as completed jobs and restart recovers armed work', async t => {
  const f = await fixture(t);
  await f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'once' });
  f.fail = true; await f.service.tick();
  assert.equal(f.service.get().monitors[0]!.status, 'disconnected');
  assert.equal(f.service.get().monitors[0]!.jobKey, '700:123:python');
  assert.equal(f.notices.length, 0);
  f.fail = false; f.unavailable = true; await f.service.tick();
  assert.equal(f.notices.length, 0);
  f.unavailable = false;
  await f.service.close();
  const restored = new TmuxMonitorService(f.directory, f.deps); await restored.initialize();
  t.after(() => restored.close());
  assert.equal(restored.get().monitors[0]!.jobKey, '700:123:python');
  await restored.tick(); assert.equal(restored.get().monitors[0]!.status, 'running');
  assert.equal(f.notices.length, 0);
  f.panes.set('local', [pane({ active: false, jobKey: null, command: 'bash' })]);
  await restored.tick(); assert.equal(f.notices.length, 1);
});

test('pending notification keeps its durable event identity on restart and retries without a duplicate completion', async t => {
  const f = await fixture(t);
  await f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'once' });
  f.failNotice = true; f.panes.set('local', []); await f.service.tick();
  const event = f.service.get().history[0]!;
  assert.equal(event.notification, 'pending');
  await f.service.clearHistory(); assert.equal(f.service.get().history.length, 1, 'Pending deliveries cannot be discarded as history');
  await f.service.close();
  f.failNotice = false;
  const restored = new TmuxMonitorService(f.directory, f.deps); await restored.initialize(); t.after(() => restored.close());
  await restored.tick(); await restored.tick();
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].id, event.id);
  assert.equal(restored.get().history[0]!.notification, 'queued');
});

test('a committed push survives a failed tmux acknowledgement write and does not resend after monitor restart', async t => {
  const f = await fixture(t), keys = createECDH('prime256v1'); keys.generateKeys();
  let sends = 0, failAck = true;
  const push = await PushService.create(f.directory, new Set(), { sendNotification: async () => { sends++; } });
  t.after(() => push.close());
  await push.subscribe('phone', { endpoint: 'https://fcm.googleapis.com/push/tmux-ack-fixture', expirationTime: null,
    keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
  const file = path.join(f.directory, 'tmux-monitors.json'), backup = path.join(f.directory, 'tmux-before-ack.json');
  f.deps.notify = async (host, notice) => {
    await push.notifyExternal(host, notice as Parameters<PushService['notifyExternal']>[1]);
    if (failAck) { failAck = false; await fs.rename(file, backup); await fs.mkdir(file); }
  };
  await f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'once' });
  f.panes.set('local', []); await f.service.tick(); await push.flush();
  assert.equal(sends, 1); assert.equal(f.service.get().history[0]!.notification, 'pending');
  await f.service.close(); await fs.rmdir(file); await fs.rename(backup, file);
  const restored = new TmuxMonitorService(f.directory, f.deps); await restored.initialize(); t.after(() => restored.close());
  await restored.tick(); await push.flush();
  assert.equal(sends, 1); assert.equal(restored.get().history[0]!.notification, 'queued');
});

test('server-owned monitoring continues without a browser, route request, or Codex connection', async t => {
  const f = await fixture(t);
  const service = new TmuxMonitorService(f.directory, { ...f.deps, autoStart: true, pollIntervalMs: 10 });
  await service.initialize(); t.after(() => service.close());
  await service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'once' });
  f.panes.set('local', [pane({ active: false, command: 'bash', jobKey: null })]);
  const deadline = Date.now() + 2000;
  while (!f.notices.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.notices.length, 1);
  assert.equal(service.get().monitors[0]!.status, 'completed');
});

test('a pipeline command label change within one foreground group is not a completed task', async t => {
  const f = await fixture(t);
  f.panes.set('local', [pane({ jobKey: 'pgrp:700' })]);
  await f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'once' });
  f.panes.set('local', [pane({ jobKey: 'pgrp:700', command: 'tee' })]);
  await f.service.tick();
  assert.equal(f.service.get().monitors[0]!.status, 'running');
  assert.equal(f.notices.length, 0);
  f.panes.set('local', [pane({ jobKey: null, active: false, command: 'bash' })]);
  await f.service.tick();
  assert.equal(f.notices.length, 1);
});

test('pause or delete is metadata-only and cannot resume a completed monitor or create duplicate active targets', async t => {
  const f = await fixture(t);
  const first = await f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'once' });
  await assert.rejects(f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'permanent' }), /已有活动/);
  await f.service.pause(first.id, { paused: true });
  f.panes.set('local', []); await f.service.tick(); assert.equal(f.notices.length, 0);
  f.panes.set('local', [pane()]);
  const second = await f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'permanent' });
  await assert.rejects(f.service.pause(first.id, { paused: false }), /其他活动/);
  await f.service.remove(second.id);
  await f.service.pause(first.id, { paused: false }); await f.service.tick();
  f.panes.set('local', []); await f.service.tick();
  await assert.rejects(f.service.pause(first.id, { paused: true }), /已完成/);
  await f.service.remove(first.id); assert.equal(f.service.get().monitors.length, 0);
  assert.equal(f.service.get().history.length, 1);
});

test('journal write failures preserve armed state and corruption or symlinks fail closed', async t => {
  const f = await fixture(t);
  await f.service.create({ hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'once' });
  const file = path.join(f.directory, 'tmux-monitors.json'), saved = await fs.readFile(file);
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(f.service.pause(f.service.get().monitors[0]!.id, { paused: true }));
  assert.equal(f.service.get().monitors[0]!.status, 'running');
  await fs.rmdir(file); await fs.writeFile(file, '{invalid');
  await assert.rejects(new TmuxMonitorService(f.directory, f.deps).initialize(), /Unable to read/);
  await fs.unlink(file); const actual = path.join(f.directory, 'actual.json'); await fs.writeFile(actual, saved); await fs.symlink(actual, file);
  await assert.rejects(new TmuxMonitorService(f.directory, f.deps).initialize(), /Unable to read/);
});

test('monitor API requires auth and CSRF before any remote discovery and validates active pane membership', async t => {
  const f = await fixture(t), app = express(), origin = 'http://localhost:8787';
  const auth = new Auth('tmux-monitor-fixture-password', new Set([origin]));
  app.use(express.json()); app.post('/api/auth/login', auth.login); app.use('/api', auth.requireAuth, auth.requireCsrf);
  const service = await registerTmuxMonitors(app, f.directory, f.deps); t.after(() => service.close());
  app.use((cause: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(cause instanceof z.ZodError ? 400 : cause.status || 500).json({ error: cause.message }); });
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(base + '/api/tmux-monitors')).status, 401);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'tmux-monitor-fixture-password' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!, { csrfToken } = await login.json() as { csrfToken: string };
  const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken };
  const create = (body: any, custom = headers) => fetch(base + '/api/tmux-monitors', { method: 'POST', headers: custom, body: JSON.stringify(body) });
  const input = { hostId: 'local', sessionId: '$1', paneId: '%1', mode: 'once' };
  assert.equal((await create(input, { ...headers, 'x-csrf-token': '' })).status, 403); assert.equal(f.reads, 0);
  assert.equal((await create({ ...input, paneId: '%999' })).status, 409);
  assert.equal((await create({ ...input, mode: 'bad' })).status, 400);
  assert.equal((await create({ ...input, sessionId: '$(touch unsafe)' })).status, 400);
  assert.equal((await create(input)).status, 201);
  const list = await fetch(base + '/api/tmux-monitors', { headers });
  assert.equal((await list.json() as any).monitors.length, 1);
  const id = service.get().monitors[0]!.id;
  assert.equal((await fetch(base + '/api/tmux-monitors/' + id, { method: 'DELETE', headers })).status, 200);
});

test('fixed tmux reader preserves Unicode labels and detects foreground commands without interpreting output as shell code', async t => {
  const python = spawnSync('python3', ['--version']);
  if (python.status !== 0) { t.skip('Python 3 unavailable'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tmux-reader-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'tmux');
  await fs.writeFile(binary, `#!/bin/sh\nprintf '%s\\n' '500|$1|100|@1|0|%1|0|${process.pid}|0||训练%7C中文|train|python|/workspace/a%257Cb|/missing/tty' '500|$1|100|@1|0|%2|1|${process.pid}|0||训练%7C中文|shell|bash|/workspace|/missing/tty'\n`, { mode: 0o700 });
  const result = spawnSync('python3', ['-c', TMUX_MONITOR_HELPER], { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` }, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const value = tmuxMonitorReadingSchema.parse(JSON.parse(result.stdout));
  assert.equal(value.panes.length, 2); assert.equal(value.panes[0]!.sessionName, '训练|中文');
  assert.equal(value.panes[0]!.cwd, '/workspace/a%7Cb');
  assert.equal(value.panes[0]!.active, true); assert.ok(value.panes[0]!.jobKey);
  assert.equal(value.panes[1]!.active, false); assert.equal(value.panes[1]!.jobKey, null);
  assert.equal(tmuxMonitorUrl({ hostId: 'ssh-a', sessionId: '$1', paneId: '%2' }), '/?host=ssh-a&tmuxSession=%241&tmuxPane=%252');
});
