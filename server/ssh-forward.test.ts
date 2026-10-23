import assert from 'node:assert/strict';
import test from 'node:test';
import { openSshForward } from './ssh-forward.js';
import type { Host } from './types.js';

const host: Host = { id: 'ssh-forward', name: 'Isolated host', kind: 'ssh', hostname: 'example.invalid', username: 'reader' };
const pin = { file: '/private/known_hosts', hostKeyAlias: 'pinned-host' };
function fixture() {
  let releases = 0, acquisitions = 0, close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const calls: string[][] = [];
  const pool = { async acquire(value: Host, trust?: typeof pin) { acquisitions++; assert.equal(value, host); assert.equal(trust, pin); return { control: { socketPath: '/private/socket' }, closed, release() { releases++; } }; } };
  return { pool, calls, close, get releases() { return releases; }, get acquisitions() { return acquisitions; }, run: async (args: string[]) => { calls.push(args); } };
}

test('SSH forward explicitly creates/cancels one mux binding and releases its lease exactly once', async () => {
  const f = fixture();
  const forward = await openSshForward(host, pin, 44321, 5173, f);
  assert.equal(forward.localPort, 44321); assert.equal(f.releases, 0);
  assert.deepEqual(f.calls[0], ['-O', 'forward', '-S', '/private/socket', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:44321:127.0.0.1:5173', '--', 'reader@example.invalid']);
  await Promise.all([forward.release(), forward.release()]);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]![1], 'cancel');
  assert.equal(f.calls[1]![f.calls[1]!.indexOf('-L') + 1], '127.0.0.1:44321:127.0.0.1:5173');
  assert.equal(f.releases, 1);
  assert.ok(!f.calls.flat().includes('exit'), 'Closing a preview must never stop the shared master');
});

test('failed or timed-out opening cancels the exact uncertain forward and cannot leak a lease or reservation', async () => {
  const f = fixture();
  await assert.rejects(openSshForward(host, pin, 44322, 5173, { ...f, run: async args => { f.calls.push(args); throw new Error('mux timeout'); } }), /端口转发失败/);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]![1], 'cancel'); assert.equal(f.releases, 1);
  const next = await openSshForward(host, pin, 44322, 5173, f); await next.release();
  assert.equal(f.releases, 2);
});

test('a master closing releases only its preview lease without trying to terminate other channels', async () => {
  const f = fixture(), forward = await openSshForward(host, pin, 44323, 5173, f);
  f.close(); await forward.closed; await Promise.resolve();
  assert.equal(f.releases, 1);
  assert.equal(f.calls.length, 1, 'A closed master already removed its listener');
  await forward.release(); assert.equal(f.releases, 1);
});

test('duplicate local bindings are rejected before acquiring a second lease, and bad ports never reach SSH', async () => {
  const f = fixture(), first = await openSshForward(host, pin, 44324, 5173, f);
  await assert.rejects(openSshForward(host, pin, 44324, 5173, f), /正在使用/);
  assert.equal(f.acquisitions, 1);
  for (const [local, remote] of [[80, 5173], [44324, 22], [44324.5, 5173], [44324, 65536]])
    await assert.rejects(openSshForward(host, pin, local!, remote!, f), /Invalid SSH/);
  assert.equal(f.acquisitions, 1);
  await first.release();
});
