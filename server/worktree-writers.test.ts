import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { nativeWorktreeWriters } from './worktree-writers.js';

test('an external native writer blocks its worktree, including while Web has no active turn', { skip: process.platform !== 'linux' }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-writer-worktree-'));
  const directory = path.join(home, 'thread-writer-locks'); await fs.mkdir(directory);
  const id = '12345678-1234-1234-1234-123456789abc';
  const filename = path.join(directory, id + '.lock');
  const child = spawn('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()', filename], { stdio: ['pipe','pipe','pipe'] });
  await once(child.stdout!, 'data');
  const host = { id: 'local', kind: 'local' as const, name: 'Fixture' };
  const bridge: any = { codexHome: home, connect: async () => {}, request: async () => ({ thread: { cwd: '/fixture/tree' } }) };
  try {
    assert.deepEqual(await nativeWorktreeWriters(host, bridge, '/fixture/tree'), [id]);
    assert.deepEqual(await nativeWorktreeWriters(host, bridge, '/fixture/other'), []);
    const tree = path.join(home, 'tree'), alias = path.join(home, 'alias'); await fs.mkdir(tree); await fs.symlink(tree, alias);
    bridge.request = async () => ({ thread: { cwd: alias } });
    assert.deepEqual(await nativeWorktreeWriters(host, bridge, tree), [id], 'A symlink must not bypass native writer protection');
    bridge.request = async () => ({ thread: {} });
    await assert.rejects(nativeWorktreeWriters(host, bridge, '/fixture/tree'), /无法确认原生写入者/);
    bridge.request = async () => ({ thread: { cwd: '/fixture/tree' } });
    child.stdin!.end(); await once(child, 'close');
    assert.deepEqual(await nativeWorktreeWriters(host, bridge, '/fixture/tree'), []);
  } finally { child.stdin!.end(); await fs.rm(home, { recursive: true, force: true }); }
});
