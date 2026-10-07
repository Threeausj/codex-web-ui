import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutomationService, nextAutomationAt, type AutomationInput } from './automations.js';
const host = { id: 'local', name: 'Fixture', kind: 'local' as const };
const spec: AutomationInput = { name: 'Review', hostId: 'local', cwd: '/fixture', prompt: 'Review the project', model: 'fixture', effort: 'high', permission: 'read-only', timezone: 'Asia/Shanghai', cadence: { kind: 'interval', minutes: 5 }, enabled: true, maxRetries: 1 };
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-automation-'));
  let clock = Date.parse('2026-10-08T00:00:00Z'); const calls: any[] = []; let count = 0; let failure: any;
  const bridge: any = { paused: false, runtime: { engineId: 'fixture-engine' }, connect: async () => { if (failure?.connecting) throw new Error('offline'); }, request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/start') { if (failure) throw failure; return { thread: { id: `thread-${++count}` } }; }
    if (method === 'turn/start') return { turn: { id: `turn-${count}`, status: 'inProgress' } };
    if (method === 'thread/read') return { thread: { turns: [{ id: `turn-${count}`, status: 'completed' }] } };
    return {};
  } };
  const dependencies = { getBridge: async () => bridge, getHost: (id: string) => id === 'local' ? host : undefined, now: () => clock };
  let service = new AutomationService(directory, dependencies); await service.initialize(false);
  const settle = async () => {
    const deadline = Date.now() + 10000;
    for (;;) {
      await (service as any).writes;
      if (!(service as any).ticking) {
        await Promise.all((service as any).operations.values());
        await (service as any).writes;
        if (!(service as any).ticking && !(service as any).operations.size) return;
      }
      assert.ok(Date.now() < deadline, 'Automation fixture did not become idle');
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  return { directory, calls, bridge, service, settle, setFailure: (value: any) => { failure = value; }, advance: (ms: number) => { clock += ms; }, clock: () => clock,
    async restart() { await service.close(); service = new AutomationService(directory, dependencies); await service.initialize(false); return service; },
    async close() { await service.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
test('calendar recurrence honors timezones, weekdays and a repeated DST hour only once', () => {
  assert.equal(new Date(nextAutomationAt({ cadence: { kind: 'daily', hour: 9, minute: 0 }, timezone: 'Asia/Shanghai' }, Date.parse('2026-10-08T00:00:00Z'))).toISOString(), '2026-10-08T01:00:00.000Z');
  assert.equal(new Date(nextAutomationAt({ cadence: { kind: 'weekly', hour: 9, minute: 0, days: [1] }, timezone: 'Asia/Shanghai' }, Date.parse('2026-10-08T00:00:00Z'))).toISOString(), '2026-10-12T01:00:00.000Z');
  assert.equal(new Date(nextAutomationAt({ cadence: { kind: 'daily', hour: 1, minute: 30 }, timezone: 'America/New_York' }, Date.parse('2026-11-01T05:30:00Z'))).toISOString(), '2026-11-02T06:30:00.000Z');
});
test('scheduled execution is durable, independent of browser sockets and does not overlap or replay missed occurrences', async () => {
  const f = await fixture(); try {
    const task = await f.service.put(spec); f.advance(30 * 60000); await f.service.tick(); await f.settle();
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
    const run = f.service.list().runs[0]!; assert.equal(run.phase, 'running'); assert.equal(run.threadId, 'thread-1');
    assert.equal(f.calls.find(call => call.method === 'turn/start').params.approvalPolicy, 'never');
    assert.equal(f.calls.find(call => call.method === 'turn/start').params.sandboxPolicy.type, 'readOnly');
    f.advance(5 * 60000); await f.service.tick(); await f.settle(); assert.equal(f.service.list().runs.length, 1);
    f.service.observe(host, { method: 'turn/completed', params: { threadId: 'child-thread', turn: { id: 'child', status: 'completed' } } }); assert.equal(f.service.list().runs[0]!.phase, 'running');
    f.service.observe(host, { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }); await f.service.close();
    assert.equal(f.service.list().runs[0]!.phase, 'completed');
    assert.equal((await fs.stat(path.join(f.directory, 'automations.json'))).mode & 0o777, 0o600);
    assert.equal(task.nextAt, Date.parse('2026-10-08T00:05:00Z'));
  } finally { await f.close(); }
});
test('lost native creation acknowledgement blocks automatic duplicates across a service restart', async () => {
  const f = await fixture(); try {
    await f.service.put(spec); f.setFailure(Object.assign(new Error('lost ACK'), { uncertain: true })); f.advance(5 * 60000); await f.service.tick(); await f.settle();
    assert.equal(f.service.list().runs[0]!.phase, 'needs_review');
    const restarted = await f.restart(); f.advance(30 * 60000); await restarted.tick(); await f.settle();
    assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
    await assert.rejects(restarted.retry(restarted.list().runs[0]!.id), /已确认失败/);
  } finally { await f.close(); }
});
test('pre-dispatch connection failures recover using bounded retries; paused schedules stay dormant', async () => {
  const f = await fixture(); try {
    const task = await f.service.put({ ...spec, enabled: false }); f.advance(30 * 60000); await f.service.tick(); assert.equal(f.calls.length, 0);
    f.setFailure({ connecting: true }); await f.service.runNow(task.id); await f.settle(); assert.equal(f.service.list().runs[0]!.phase, 'failed');
    f.setFailure(null); f.advance(30000); await f.service.tick(); await f.settle(); assert.equal(f.service.list().runs[0]!.phase, 'running'); assert.equal(f.service.list().runs[0]!.attempt, 2);
  } finally { await f.close(); }
});
test('restarted known native turns require read-only reconciliation instead of reacquiring a writer or repeating inference', async () => {
  const f = await fixture(); try {
    const task = await f.service.put(spec); await f.service.runNow(task.id); await f.settle(); const id = f.service.list().runs[0]!.id;
    const restarted = await f.restart(); assert.equal(restarted.list().runs[0]!.phase, 'needs_review');
    await restarted.reconcile(id); assert.equal(restarted.list().runs[0]!.phase, 'completed');
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, 0);
  } finally { await f.close(); }
});

test('deleting a task cancels its persisted connection retry even after restart', async () => {
  const f = await fixture(); try {
    const task = await f.service.put(spec); f.setFailure({ connecting: true });
    await f.service.runNow(task.id); await f.settle(); assert.ok(f.service.list().runs[0]!.retryAt);
    await f.service.remove(task.id); const restarted = await f.restart(); f.setFailure(null); f.advance(600000);
    await restarted.tick(); await f.settle();
    assert.equal(restarted.list().tasks.length, 0); assert.equal(restarted.list().runs[0]!.retryAt, undefined);
    assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 0);
  } finally { await f.close(); }
});

test('shutdown during a native fork receipt retains its ID and never dispatches a turn afterwards', async () => {
  const f = await fixture(); let resolve!: (value: any) => void; let started!: () => void;
  const pending = new Promise<void>(yes => { started = yes; });
  const request = f.bridge.request;
  f.bridge.request = async (method: string, params: any) => {
    if (method === 'thread/start') { f.calls.push({ method, params }); started(); return new Promise(yes => { resolve = yes; }); }
    return request(method, params);
  };
  try {
    const task = await f.service.put(spec); await f.service.runNow(task.id); await pending;
    await f.service.close(); resolve({ thread: { id: 'late-formal' } }); await f.settle();
    assert.equal(f.service.list().runs[0]!.phase, 'needs_review'); assert.equal(f.service.list().runs[0]!.threadId, 'late-formal');
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 0);
    const restarted = await f.restart(); f.advance(600000); await restarted.tick(); await f.settle();
    assert.equal(restarted.list().runs[0]!.threadId, 'late-formal');
    assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
  } finally { await f.close(); }
});

test('automation HTTP controls enforce login, CSRF and input limits and persist disabled tasks without launching Codex', async () => {
  const { createServer } = await import('./app.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-automation-http-'));
  const origin = 'http://127.0.0.1:8787';
  let launches = 0;
  const options = { cwd: directory, dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'codex'), password: 'isolated-automation-password', origins: [origin], secureCookie: false, serveStatic: false,
    bridgeOptions: { transportFactory: () => { launches++; throw new Error('This test must never launch Codex'); } } };
  let app = await createServer(options);
  const listen = async () => { await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(app.server.address() as any).port}`; };
  try {
    let base = await listen();
    const input = { ...spec, cwd: directory, enabled: false };
    assert.equal((await fetch(base + '/api/automations')).status, 401);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: options.password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await login.json();
    const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken };
    const post = (value: unknown, auth = headers) => fetch(base + '/api/automations', { method: 'POST', headers: auth, body: JSON.stringify(value) });
    assert.equal((await post(input, { ...headers, 'x-csrf-token': '' })).status, 403);
    assert.equal((await post(input, { ...headers, origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await post({ ...input, cadence: { kind: 'interval', minutes: 1 } })).status, 400);
    const created = await post(input); assert.equal(created.status, 201); const task = await created.json();
    assert.equal(task.enabled, false); assert.equal(task.nextAt, null);
    assert.equal((await fs.stat(path.join(options.dataDir, 'automations.json'))).mode & 0o777, 0o600);
    await app.close(); app = await createServer(options); base = await listen();
    const response = await fetch(base + '/api/automations', { headers: { cookie } });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
    const restored = await response.json(); assert.equal(restored.tasks[0].id, task.id); assert.deepEqual(restored.runs, []);
    assert.equal((await fetch(base + '/api/automations/' + task.id, { method: 'DELETE', headers })).status, 200);
    assert.equal(launches, 0);
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
