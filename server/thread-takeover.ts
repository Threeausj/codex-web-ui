import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Express } from 'express'
import { z } from 'zod'
import type { Bridge } from './bridge.js'
import type { AuthenticatedRequest, Host } from './types.js'

type TakeoverBridge = Pick<Bridge, 'connect' | 'request' | 'codexHome'>
export type ThreadTakeoverOptions = {
  getBridge: (hostId: string) => Promise<TakeoverBridge>
  getHost: (hostId: string) => Host | undefined
}
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const scope = z.object({ hostId: z.string().min(1).max(128), threadId: uuid })
const snapshotSchema = z.object({
  pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/),
  uid: z.number().int().nonnegative(), executable: z.string().min(1).max(4096),
  device: z.string().regex(/^\d+:\d+$/), inode: z.string().regex(/^\d+$/),
  threads: z.array(uuid).min(1).max(10000),
}).strict()
type Snapshot = z.infer<typeof snapshotSchema>
type Challenge = { hostId: string; threadId: string; sessionId: string; expiresAt: number; snapshot: Snapshot; bridge: TakeoverBridge; codexHome?: string }
const CHALLENGE_TTL = 60_000
const failure = (message: string, status: number, code: string) => Object.assign(new Error(message), { status, code })

/** Runs on the selected workstation through its official command/exec API.
 * Codex's native locks are flock(file), not PID files. Never remove a lock file,
 * accept a browser-supplied PID, or signal a process discovered only by its name.
 * See codex-rs/rollout/src/writer_lock.rs in the official Codex source. */
export const THREAD_WRITER_HELPER = String.raw`
import errno, fcntl, json, os, re, signal, stat, sys, time

class Refused(Exception):
    def __init__(self, code): self.code = code

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

def refuse(code): raise Refused(code)

def identity(pid):
    try:
        fields = open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()
        state, parent, start = fields[0], int(fields[1]), fields[19]
        uid = os.stat('/proc/%d' % pid).st_uid
        uids = next(line.split()[1:] for line in open('/proc/%d/status' % pid) if line.startswith('Uid:'))
        exe = os.readlink('/proc/%d/exe' % pid)
        comm = open('/proc/%d/comm' % pid).read().strip()
    except FileNotFoundError: refuse('writer_changed')
    if state == 'Z': refuse('writer_changed')
    if uid != os.geteuid() or len(uids) != 4 or any(int(value) != os.geteuid() for value in uids): refuse('writer_permissions')
    if comm != 'codex' or os.path.basename(exe.removesuffix(' (deleted)')) != 'codex':
        refuse('writer_not_codex')
    return {'pid': pid, 'startTime': start, 'uid': uid, 'executable': exe}

def ancestors():
    values = set()
    pid = os.getpid()
    for _ in range(64):
        if pid <= 1 or pid in values: break
        values.add(pid)
        try: pid = int(open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()[1])
        except (FileNotFoundError, ValueError): break
    return values

def file_key(info):
    return (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)

def flock_record(line):
    fields = line.split()
    if fields and fields[0] == 'lock:': fields = fields[1:]
    if len(fields) != 8 or fields[1:4] != ['FLOCK', 'ADVISORY', 'WRITE'] or fields[6:] != ['0', 'EOF']: return None
    try:
        major, minor, inode = fields[5].split(':')
        key = (int(major, 16), int(minor, 16), int(inode))
        pid = int(fields[4])
    except ValueError: refuse('writer_unidentified')
    return (key, pid) if pid > 1 else None

def descriptor_owners(pid, records):
    owners = {}
    try: descriptors = os.listdir('/proc/%d/fd' % pid)
    except (FileNotFoundError, PermissionError): return owners
    if len(descriptors) > 10000: refuse('writer_too_many_locks')
    for descriptor in descriptors:
        file_path = '/proc/%d/fd/%s' % (pid, descriptor)
        try:
            info = os.stat(file_path)
            if not stat.S_ISREG(info.st_mode): continue
            with open('/proc/%d/fdinfo/%s' % (pid, descriptor)) as stream:
                locks = [flock_record(line) for line in stream if line.startswith('lock:')]
            # A descriptor may close and be reused while /proc is being read.
            # Verify its file identity on both sides of the fdinfo snapshot.
            if file_key(os.stat(file_path)) != file_key(info): continue
        except (FileNotFoundError, PermissionError): continue
        for record in locks:
            if record is not None and record[1] == pid and record in records:
                owners.setdefault(file_key(info), set()).add(pid)
    return owners

def flock_owners(target_key):
    records = set()
    for line in open('/proc/locks'):
        record = flock_record(line)
        if record is not None: records.add(record)
    if len(records) > 10000: refuse('writer_too_many_locks')
    owners = {}
    # Overlay mounts and some subvolumes expose a different st_dev (and may
    # translate inode numbers) from the native lock's backing filesystem.
    # Global locks nominate candidates only. A holder's real FD stat must match
    # the complete target device/inode, and that same FD's kernel fdinfo must
    # prove its exclusive flock ownership. Never identify a holder by inode alone.
    candidates = {pid for key, pid in records}
    preferred = {pid for key, pid in records if key[2] == target_key[2]}
    for pid in sorted(candidates, key=lambda value: value not in preferred):
        for key, pids in descriptor_owners(pid, records).items():
            owners.setdefault(key, set()).update(pids)
    return owners

def open_lock(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        refuse('writer_invalid_lock')
    return fd

def locked(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    except BlockingIOError: return True

def inspect(directory, thread):
    try: fd = open_lock(directory, thread + '.lock')
    except FileNotFoundError: return None
    try:
        if not locked(fd): return None
        info = os.fstat(fd)
        owners = flock_owners(file_key(info))
        pids = owners.get(file_key(info), set())
        # /proc/locks filters owners outside this PID namespace. A lock can be
        # busy even though its host owner cannot safely be signalled here.
        if len(pids) != 1 or next(iter(pids)) <= 1: refuse('writer_unidentified')
        pid = next(iter(pids))
        if pid in ancestors(): refuse('writer_bridge_owner')
        result = identity(pid)
        names = os.listdir(directory)
        if len(names) > 10000: refuse('writer_too_many_locks')
        threads = []
        for name in names:
            try: entry = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError: refuse('writer_changed')
            if pid not in owners.get(file_key(entry), set()): continue
            if name == '.coordination.lock': refuse('writer_busy')
            if not name.endswith('.lock') or not UUID.fullmatch(name[:-5]) or not stat.S_ISREG(entry.st_mode):
                refuse('writer_invalid_lock')
            threads.append(name[:-5])
        if thread not in threads: refuse('writer_changed')
        result.update(device='%d:%d' % (os.major(info.st_dev), os.minor(info.st_dev)),
                      inode=str(info.st_ino), threads=sorted(threads))
        return result
    finally: os.close(fd)

def coordinate(directory):
    try: fd = open_lock(directory, '.coordination.lock')
    except FileNotFoundError: refuse('writer_invalid_lock')
    try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        refuse('writer_busy')
    return fd

def verify(directory, thread, expected):
    current = inspect(directory, thread)
    if current is None: return False
    if current != expected: refuse('writer_changed')
    return True

def signal_owner(directory, thread, expected, sig, pidfd):
    # Coordination prevents Codex adding/removing thread owners between the
    # complete affected-thread check and this signal. Release immediately so
    # the terminated process can clean up normally; never delete its files.
    guard = coordinate(directory)
    try:
        if not verify(directory, thread, expected): return False
        if pidfd is not None: signal.pidfd_send_signal(pidfd, sig)
        else:
            # Compatibility for older NAS kernels. Recheck PID identity and
            # lock ownership before every signal, never follow a replacement.
            if not verify(directory, thread, expected): return False
            os.kill(expected['pid'], sig)
        return True
    except ProcessLookupError: return False
    finally: os.close(guard)

def await_release(directory, thread, expected, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try: fd = open_lock(directory, thread + '.lock')
        except FileNotFoundError: return True
        try:
            info = os.fstat(fd)
            if '%d:%d' % (os.major(info.st_dev), os.minor(info.st_dev)) != expected['device'] or str(info.st_ino) != expected['inode']:
                refuse('writer_changed')
            if not locked(fd): return True
            owners = flock_owners(file_key(info)).get(file_key(info), set())
            if owners != {expected['pid']}:
                # The original process can exit between the busy probe and its
                # FD scan. Recheck the real flock before treating an empty scan
                # as failure, and allow a bounded wait while /proc is changing.
                # A verified replacement owner always cancels this takeover;
                # later signals still require the complete original identity.
                if owners: refuse('writer_changed')
                if not locked(fd): return True
        finally: os.close(fd)
        time.sleep(0.05)
    return False

def main():
    if sys.platform != 'linux': refuse('writer_platform')
    mode, thread, configured_home = sys.argv[1:4]
    if mode not in ('inspect', 'takeover') or not UUID.fullmatch(thread): refuse('writer_invalid_request')
    home = configured_home or os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex')
    if not os.path.isabs(home): refuse('writer_invalid_lock')
    try:
        directory = os.open(os.path.join(os.path.realpath(home), 'thread-writer-locks'),
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError: return {'ok': True, 'locked': False, 'released': True, 'terminated': False}
    try:
        current = inspect(directory, thread)
        if mode == 'inspect': return {'ok': True, 'locked': current is not None, 'snapshot': current}
        expected = json.loads(sys.argv[4])
        if current is None: return {'ok': True, 'released': True, 'terminated': False}
        if current != expected: refuse('writer_changed')
        pidfd = None
        if hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'):
            try: pidfd = os.pidfd_open(expected['pid'])
            except OSError as error:
                if error.errno not in (errno.ENOSYS, errno.EINVAL): raise
        try:
            terminated = signal_owner(directory, thread, expected, signal.SIGTERM, pidfd)
            if await_release(directory, thread, expected, 1.5):
                return {'ok': True, 'released': True, 'terminated': terminated}
            terminated = signal_owner(directory, thread, expected, signal.SIGKILL, pidfd) or terminated
            if not await_release(directory, thread, expected, 1.0): refuse('writer_timeout')
            return {'ok': True, 'released': True, 'terminated': terminated}
        finally:
            if pidfd is not None: os.close(pidfd)
    finally: os.close(directory)

try: print(json.dumps(main(), separators=(',', ':')))
except Refused as error: print(json.dumps({'ok': False, 'code': error.code}))
except PermissionError: print(json.dumps({'ok': False, 'code': 'writer_permissions'}))
except OSError: print(json.dumps({'ok': False, 'code': 'writer_unidentified'}))
except (ValueError, KeyError, IndexError, StopIteration): print(json.dumps({'ok': False, 'code': 'writer_invalid_lock'}))
`

const messages: Record<string, { status: number; message: string }> = {
  writer_unidentified: { status: 409, message: '无法安全识别占用进程。若本机运行在 Docker 中，请改用 SSH 连接 NAS 后强制进入。' },
  writer_permissions: { status: 403, message: '无法读取或终止占用进程，请使用与该 Codex 进程相同的系统用户连接。' },
  writer_not_codex: { status: 409, message: '占用进程无法确认为 Codex，已取消强制进入。' },
  writer_bridge_owner: { status: 409, message: '会话由当前 Web 服务连接的 Codex 进程占用，不能终止自身连接；请重试打开会话。' },
  writer_platform: { status: 409, message: '强制进入目前支持 Linux 本机或 SSH 主机，请先在占用的客户端关闭会话。' },
  writer_changed: { status: 409, message: '占用进程或受影响的会话已变化，请重新确认强制进入。' },
  writer_invalid_lock: { status: 409, message: '无法安全验证 Codex 会话锁，已取消强制进入。' },
  writer_busy: { status: 409, message: 'Codex 正在变更会话锁，请稍后重试强制进入。' },
  writer_too_many_locks: { status: 409, message: '会话锁数量超过安全检查上限，请先在占用客户端关闭会话。' },
  writer_timeout: { status: 504, message: '终止占用进程后会话锁仍未释放，请稍后重试。' },
}

async function execute(bridge: TakeoverBridge, mode: 'inspect' | 'takeover', threadId: string, snapshot?: Snapshot) {
  await bridge.connect()
  const home = bridge.codexHome || ''
  if (home && (!path.posix.isAbsolute(home) || /[\x00-\x1f\x7f]/.test(home))) throw failure('目标主机返回的 Codex 目录无效。', 502, 'writer_invalid_home')
  const result = await bridge.request('command/exec', {
    command: ['python3', '-c', THREAD_WRITER_HELPER, mode, threadId, home, ...(snapshot ? [JSON.stringify(snapshot)] : [])],
    timeoutMs: 10_000, outputBytesCap: 512 * 1024,
    // Clicking and confirming takeover explicitly authorizes this fixed process
    // control operation; it does not change the conversation's permission mode.
    sandboxPolicy: { type: 'dangerFullAccess' },
  }, 15_000) as { exitCode?: number; stdout?: string; stderr?: string }
  if (result.exitCode !== 0 || typeof result.stdout !== 'string') throw failure('目标主机无法运行安全接管检查，请确认已安装 Python 3.9 或更新版本。', 502, 'writer_helper_unavailable')
  let value: { ok?: boolean; locked?: boolean; snapshot?: unknown; released?: boolean; terminated?: boolean; code?: string }
  try { value = JSON.parse(result.stdout) } catch { throw failure('目标主机返回的会话锁信息无效。', 502, 'writer_invalid_response') }
  if (value?.ok !== true) {
    const code = typeof value?.code === 'string' ? value.code : 'writer_invalid_response'
    const detail = messages[code] || { status: 502, message: '无法安全验证目标主机上的会话占用进程。' }
    throw failure(detail.message, detail.status, code)
  }
  if (mode === 'inspect') {
    if (value.locked === false) return { locked: false as const }
    const parsed = snapshotSchema.safeParse(value.snapshot)
    if (value.locked !== true || !parsed.success || !parsed.data.threads.includes(threadId)) throw failure('目标主机返回的会话占用信息无效。', 502, 'writer_invalid_response')
    return { locked: true as const, snapshot: parsed.data }
  }
  if (value.released !== true || typeof value.terminated !== 'boolean') throw failure('目标主机未确认会话锁已释放。', 502, 'writer_invalid_response')
  return { released: true as const, terminated: value.terminated }
}

/** Register after the common authentication, origin, and CSRF middleware. */
export function registerThreadTakeover(app: Express, options: ThreadTakeoverOptions) {
  const challenges = new Map<string, Challenge>()
  const prune = () => {
    for (const [token, challenge] of challenges) if (challenge.expiresAt <= Date.now()) challenges.delete(token)
    while (challenges.size >= 1000) challenges.delete(challenges.keys().next().value!)
  }
  const route = (mode: 'inspect' | 'takeover') => (req: AuthenticatedRequest, res: import('express').Response) => {
    void (async () => {
      const { hostId, threadId } = scope.parse(req.params)
      if (!req.session) throw failure('请重新登录后操作。', 401, 'unauthenticated')
      if (!options.getHost(hostId)) throw failure('主机不存在，请刷新主机列表。', 404, 'host_missing')
      if (mode === 'inspect') {
        z.object({}).strict().parse(req.body)
        const bridge = await options.getBridge(hostId)
        const result = await execute(bridge, 'inspect', threadId)
        if (!result.locked) { res.json({ locked: false }); return }
        prune()
        const challenge = randomBytes(32).toString('base64url')
        const expiresAt = Date.now() + CHALLENGE_TTL
        challenges.set(challenge, { hostId, threadId, sessionId: req.session.id, expiresAt, snapshot: result.snapshot, bridge, codexHome: bridge.codexHome })
        res.json({ locked: true, owner: { pid: result.snapshot.pid, affectedThreadCount: result.snapshot.threads.length }, challenge, expiresAt })
        return
      }
      const body = z.object({ confirmed: z.literal(true), challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(req.body)
      const challenge = challenges.get(body.challenge)
      if (!challenge || challenge.expiresAt <= Date.now() || challenge.sessionId !== req.session.id || challenge.hostId !== hostId || challenge.threadId !== threadId) throw failure('强制进入确认已失效，请重新检查并确认。', 409, 'writer_confirmation_expired')
      // Consume before any await: duplicate browser requests cannot signal twice.
      challenges.delete(body.challenge)
      const bridge = await options.getBridge(hostId)
      if (bridge !== challenge.bridge || bridge.codexHome !== challenge.codexHome) throw failure('目标主机连接已变化，请重新检查并确认强制进入。', 409, 'writer_changed')
      const result = await execute(bridge, 'takeover', threadId, challenge.snapshot)
      try {
        // Acquire the released writer immediately; the browser's following
        // resume joins this same app-server rather than leaving a round trip
        // for an auto-restarting desktop client to reclaim the thread.
        await bridge.request('thread/resume', { threadId, excludeTurns: true, config: { 'features.default_mode_request_user_input': true } }, 45_000)
      } catch (cause) {
        if (/already has an active writer/i.test(cause instanceof Error ? cause.message : String(cause))) throw failure('原占用进程已结束，但会话已被重新占用，请重新检查并确认。', 409, 'writer_reclaimed')
        throw failure('占用已解除，但重新打开会话失败，请重试打开会话。', 502, 'writer_resume_failed')
      }
      res.json({ ok: true, threadId, resumed: true, ...result })
    })().catch((error: unknown) => {
      if (error instanceof z.ZodError) { res.status(400).json({ error: '强制进入参数无效，请重新检查并确认。', code: 'writer_invalid_request' }); return }
      const value = error as { status?: number; code?: string; message?: string }
      if (value.status && value.code) { res.status(value.status).json({ error: value.message, code: value.code }); return }
      res.status(502).json({ error: '无法连接目标主机进行会话接管，请检查连接后重试。', code: 'writer_connection_failed' })
    })
  }
  app.post('/api/threads/:hostId/:threadId/takeover/inspect', route('inspect'))
  app.post('/api/threads/:hostId/:threadId/takeover', route('takeover'))
}
