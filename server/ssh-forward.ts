import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sharedSshPool, type SSHConnectionLease, type SshConnectionPool } from './ssh-pool.js';
import type { SSHHostKeyPin } from './ssh-host-keys.js';
import type { Host } from './types.js';

const execute = promisify(execFile);
const reservations = new Map<number, symbol>();
export type SSHForward = { localPort: number; closed?: Promise<void>; release(): Promise<void> };
type ForwardDependencies = {
  pool?: Pick<SshConnectionPool, 'acquire'>;
  /** Test hook; production uses the local OpenSSH mux command only. */
  run?: (args: string[]) => Promise<void>;
};
const port = (value: number) => Number.isInteger(value) && value >= 1024 && value <= 65535;

/**
 * OpenSSH -N -L exits successfully once a shared master owns the listener.
 * Own the forward explicitly instead: -O forward creates one listener, and
 * -O cancel removes exactly that listener without closing RPC/other channels.
 */
export async function openSshForward(host: Host, pin: SSHHostKeyPin | undefined, localPort: number, targetPort: number, dependencies: ForwardDependencies = {}): Promise<SSHForward> {
  if (host.kind !== 'ssh' || !host.hostname || !port(localPort) || !port(targetPort)) throw new Error('Invalid SSH forwarding target');
  if (reservations.has(localPort)) throw new Error('SSH 本地转发端口正在使用，请重试');
  const token = Symbol('ssh-forward'); reservations.set(localPort, token);
  let lease: SSHConnectionLease;
  try { lease = await (dependencies.pool || sharedSshPool).acquire(host, pin); }
  catch (cause) { if (reservations.get(localPort) === token) reservations.delete(localPort); throw cause; }
  const binding = `127.0.0.1:${localPort}:127.0.0.1:${targetPort}`;
  const destination = `${host.username ? `${host.username}@` : ''}${host.hostname}`;
  const run = dependencies.run || (async (args: string[]) => {
    await execute('ssh', args, { timeout: 8000, maxBuffer: 16384, encoding: 'utf8', windowsHide: true });
  });
  const args = (operation: 'forward' | 'cancel') => ['-O', operation, '-S', lease.control.socketPath,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-L', binding, '--', destination];
  let releasing: Promise<void> | undefined;
  let masterClosed = false;
  const release = () => releasing ||= (async () => {
    try { if (!masterClosed) await run(args('cancel')); } catch { /* A closed master already discarded all its listeners. */ }
    finally { lease.release(); if (reservations.get(localPort) === token) reservations.delete(localPort); }
  })();
  void lease.closed?.then(() => { masterClosed = true; void release(); });
  try { await run(args('forward')); }
  catch (cause) {
    // A timed-out mux command may already have opened the listener. Cancel the
    // exact binding before releasing its lease; never issue -O exit here.
    await release();
    throw new Error('SSH 端口转发失败，请确认远端允许 TCP 转发并重试', { cause });
  }
  return { localPort, release, closed: lease.closed };
}
