import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import express from 'express'
import { Auth } from './auth.js'
import { Bridge, type Transport } from './bridge.js'
import { registerThreadTakeover, THREAD_WRITER_HELPER } from './thread-takeover.js'

const thread = '00000000-0000-4000-8000-000000000001'
const otherThread = '00000000-0000-4000-8000-000000000002'
const python = spawnSync('python3', ['-c', 'import json,sys; print(json.dumps([sys.executable,sys.prefix]))'], { encoding: 'utf8' })
const canRunHelper = process.platform === 'linux' && python.status === 0
const runHelper = (home: string, mode = 'inspect', snapshot?: unknown, script = THREAD_WRITER_HELPER) => {
  const result = spawnSync('python3', ['-c', script, mode, thread, home, ...(snapshot ? [JSON.stringify(snapshot)] : [])], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr || String(result.error))
  return JSON.parse(result.stdout)
}

async function holder(t: import('node:test').TestContext, options: { codex?: boolean; threads?: string[]; ignoreTerm?: boolean; waitForProbeOnTerm?: boolean; sharedHome?: string; readyBeforeLock?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-takeover-lock-'))
  const home = options.sharedHome || path.join(directory, 'home')
  const locks = path.join(home, 'thread-writer-locks')
  await fs.mkdir(locks, { recursive: true })
  await fs.writeFile(path.join(locks, '.coordination.lock'), '')
  const [executable, prefix] = JSON.parse(python.stdout)
  const binary = options.codex === false ? executable : path.join(directory, 'codex')
  if (options.codex !== false) { await fs.copyFile(executable, binary); await fs.chmod(binary, 0o700) }
  const child = spawn(binary, ['-c', String.raw`
import fcntl,json,os,signal,sys,time
if sys.argv[2] == 'ignore': signal.signal(signal.SIGTERM, signal.SIG_IGN)
if sys.argv[2] == 'wait-probe':
    def release_after_probe(signum, frame):
        while not os.path.exists(os.path.join(sys.argv[1],'release-after-probe')): time.sleep(0.01)
        sys.exit(0)
    signal.signal(signal.SIGTERM, release_after_probe)
files=[]
if sys.argv[4] == 'before-lock': print('ready',flush=True)
def add(thread):
    file=open(os.path.join(sys.argv[1],thread+'.lock'),'a+')
    fcntl.flock(file,fcntl.LOCK_EX)
    files.append(file)
for thread in json.loads(sys.argv[3]): add(thread)
print('acquired' if sys.argv[4] == 'before-lock' else 'ready',flush=True)
for line in sys.stdin:
    add(line.strip())
    print('added',flush=True)
`, locks, options.waitForProbeOnTerm ? 'wait-probe' : options.ignoreTerm ? 'ignore' : 'normal', JSON.stringify(options.threads || [thread]), options.readyBeforeLock ? 'before-lock' : 'after-lock'], { env: { ...process.env, PYTHONHOME: prefix }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  await once(child.stdout, 'data')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { child, home, locks, addThread: async () => { child.stdin.write(`${otherThread}\n`); await once(child.stdout, 'data') } }
}

async function endpoint(t: import('node:test').TestContext, bridge: Pick<Bridge, 'request' | 'connect' | 'codexHome'>) {
  const origin = 'http://localhost:8787'
  const auth = new Auth('takeover-test-password', new Set([origin]))
  const app = express()
  app.use(express.json())
  app.post('/api/auth/login', auth.login)
  app.use('/api', auth.requireAuth, auth.requireCsrf)
  registerThreadTakeover(app, { getBridge: async () => bridge, getHost: id => ['local', 'remote'].includes(id) ? { id, name: id, kind: id === 'remote' ? 'ssh' : 'local' } : undefined })
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const login = async () => {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'takeover-test-password' }) })
    const { csrfToken } = await response.json()
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': csrfToken }
  }
  const headers = await login()
  const post = (suffix: string, body: unknown = {}, custom: Record<string, string> = headers, host = 'local', id = thread) => fetch(`${base}/api/threads/${host}/${id}/takeover${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...custom }, body: JSON.stringify(body) })
  return { post, headers, login }
}

function helperBridge(home: string) {
  return { codexHome: home, connect: async () => {}, request: async (method: string, params: any) => {
    if (method === 'thread/resume') { assert.equal(params.excludeTurns, true); return { thread: { id: params.threadId } } }
    assert.equal(method, 'command/exec')
    assert.deepEqual(params.sandboxPolicy, { type: 'dangerFullAccess' })
    assert.equal(params.timeoutMs, 10_000)
    assert.equal(params.command[0], 'python3')
    const result = spawnSync(params.command[0], params.command.slice(1), { encoding: 'utf8', timeout: 11_000 })
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
  } }
}

test('takeover requires authentication, CSRF and a confirmed owner challenge bound to session, host and thread', { skip: !canRunHelper }, async t => {
  const fixture = await holder(t, { threads: [thread, otherThread] })
  const api = await endpoint(t, helperBridge(fixture.home))
  assert.equal((await api.post('/inspect', {}, {})).status, 401)
  assert.equal((await api.post('/inspect', {}, { cookie: api.headers.cookie })).status, 403)
  assert.equal((await api.post('/inspect', {}, api.headers, 'missing')).status, 404)
  const response = await api.post('/inspect')
  assert.equal(response.status, 200)
  const inspection = await response.json()
  assert.equal(inspection.owner.pid, fixture.child.pid)
  assert.equal(inspection.owner.affectedThreadCount, 2)
  assert.equal(inspection.locked, true)
  const body = { confirmed: true, challenge: inspection.challenge }
  assert.equal((await api.post('', { ...body, confirmed: false })).status, 400)
  assert.equal((await api.post('', body, await api.login())).status, 409)
  assert.equal((await api.post('', body, api.headers, 'remote')).status, 409)
  assert.equal((await api.post('', body, api.headers, 'local', otherThread)).status, 409)
  assert.equal(fixture.child.signalCode, null)
  assert.equal((await api.post('', body)).status, 200)
  assert.equal((await api.post('', body)).status, 409)
  assert.equal(runHelper(fixture.home).locked, false)
  // Releasing ownership does not truncate or remove the conversation's lock file.
  assert.equal((await fs.stat(path.join(fixture.locks, `${thread}.lock`))).size, 0)
})

test('an expired confirmation and newly affected threads cancel takeover without signalling the owner', { skip: !canRunHelper }, async t => {
  const fixture = await holder(t)
  const api = await endpoint(t, helperBridge(fixture.home))
  const expired = await (await api.post('/inspect')).json()
  const original = Date.now
  Date.now = () => original() + 61_000
  try { assert.equal((await api.post('', { confirmed: true, challenge: expired.challenge })).status, 409) }
  finally { Date.now = original }
  const inspection = await (await api.post('/inspect')).json()
  await fixture.addThread()
  const changed = await api.post('', { confirmed: true, challenge: inspection.challenge })
  assert.equal(changed.status, 409)
  assert.equal((await changed.json()).code, 'writer_changed')
  assert.equal(fixture.child.signalCode, null)
  assert.equal(runHelper(fixture.home).snapshot.threads.length, 2)
})

test('native flock probing rejects non-Codex owners, changed PID start time and symlink locks without signalling', { skip: !canRunHelper }, async t => {
  const nonCodex = await holder(t, { codex: false })
  assert.equal(runHelper(nonCodex.home).code, 'writer_not_codex')
  assert.equal(nonCodex.child.signalCode, null)
  const fixture = await holder(t)
  const inspection = runHelper(fixture.home)
  assert.equal(runHelper(fixture.home, 'takeover', { ...inspection.snapshot, startTime: String(BigInt(inspection.snapshot.startTime) + 1n) }).code, 'writer_changed')
  assert.equal(fixture.child.signalCode, null)
  await fs.rename(path.join(fixture.locks, `${thread}.lock`), path.join(fixture.locks, 'original.lock'))
  await fs.symlink('original.lock', path.join(fixture.locks, `${thread}.lock`))
  assert.equal(runHelper(fixture.home).ok, false)
  assert.equal(fixture.child.signalCode, null)
})

test('older NAS kernel fallback revalidates and escalates only the exact synthetic Codex owner', { skip: !canRunHelper }, async t => {
  const fixture = await holder(t, { ignoreTerm: true })
  const script = THREAD_WRITER_HELPER.replace("if hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'):", 'if False:')
  const inspection = runHelper(fixture.home)
  const result = runHelper(fixture.home, 'takeover', inspection.snapshot, script)
  assert.deepEqual(result, { ok: true, released: true, terminated: true })
  assert.equal(runHelper(fixture.home).locked, false)
})

test('filesystem lock device and inode translations still require exact FD identity and preserve the complete affected thread set', { skip: !canRunHelper }, async t => {
  const fixture = await holder(t, { threads: [thread, otherThread], ignoreTerm: true })
  // Simulate the kernel's backing-file identity differing from the visible
  // overlay stat. Both /proc/locks and native fdinfo still describe the same
  // kernel lock, while actual FD stat remains the original visible identity.
  const translated = THREAD_WRITER_HELPER.replace(
    'key = (int(major, 16), int(minor, 16), int(inode))',
    'key = (int(major, 16), int(minor, 16) + 1, int(inode) + 1000000)',
  )
  const inspected = runHelper(fixture.home, 'inspect', undefined, translated)
  const actual = await fs.stat(path.join(fixture.locks, `${thread}.lock`))
  assert.equal(inspected.ok, true)
  assert.equal(inspected.snapshot.pid, fixture.child.pid)
  assert.equal(inspected.snapshot.inode, String(actual.ino))
  assert.deepEqual(inspected.snapshot.threads, [thread, otherThread])
  // Exercise this same verified mapping before TERM/KILL and while waiting for
  // release, using only the synthetic owner created for this test.
  assert.deepEqual(runHelper(fixture.home, 'takeover', inspected.snapshot, translated), { ok: true, released: true, terminated: true })
})

test('a writer exiting between the busy flock probe and FD scan releases normally without a false owner-change failure', { skip: !canRunHelper }, async t => {
  const fixture = await holder(t, { waitForProbeOnTerm: true })
  const inspected = runHelper(fixture.home)
  const raced = THREAD_WRITER_HELPER.replace('try: print(json.dumps(main(),', String.raw`
original_owners = flock_owners
wait_scans = 0
def exit_between_probe_and_scan(key):
    global wait_scans
    if sys._getframe(1).f_code.co_name != 'await_release': return original_owners(key)
    wait_scans += 1
    if wait_scans == 1:
        # The genuine writer still owns the native flock and waits for our
        # marker. An indeterminate FD scan alone must not authorize a signal.
        return {}
    open(os.path.join(sys.argv[3],'thread-writer-locks','release-after-probe'),'w').close()
    fd = os.open(os.path.join(sys.argv[3],'thread-writer-locks',sys.argv[2]+'.lock'),os.O_RDONLY)
    try:
        deadline = time.monotonic() + 1
        while locked(fd) and time.monotonic() < deadline: time.sleep(0.01)
        if locked(fd): refuse('writer_timeout')
    finally: os.close(fd)
    # Now the process has actually exited after await_release's busy check;
    # its disappeared FD ownership must cause another native release probe.
    return original_owners(key)
flock_owners = exit_between_probe_and_scan
try: print(json.dumps(main(),`)
  assert.deepEqual(runHelper(fixture.home, 'takeover', inspected.snapshot, raced), { ok: true, released: true, terminated: true })
  await fs.access(path.join(fixture.locks, 'release-after-probe'))
  assert.equal(runHelper(fixture.home).locked, false)
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) await once(fixture.child, 'exit')
  assert.equal(fixture.child.exitCode, 0)
  assert.equal(fixture.child.signalCode, null)
})

test('a real replacement writer acquiring the released native flock during the wait is never followed or signalled', { skip: !canRunHelper }, async t => {
  const original = await holder(t, { waitForProbeOnTerm: true })
  const inspected = runHelper(original.home)
  const replacement = await holder(t, { sharedHome: original.home, readyBeforeLock: true })
  const raced = THREAD_WRITER_HELPER.replace('try: print(json.dumps(main(),', `
original_owners = flock_owners
def replace_after_busy_probe(key):
    if sys._getframe(1).f_code.co_name != 'await_release': return original_owners(key)
    open(os.path.join(sys.argv[3],'thread-writer-locks','release-after-probe'),'w').close()
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        owners = original_owners(key)
        if owners.get(key) == {${replacement.child.pid}}: return owners
        time.sleep(0.01)
    refuse('writer_timeout')
flock_owners = replace_after_busy_probe
try: print(json.dumps(main(),`)
  assert.deepEqual(runHelper(original.home, 'takeover', inspected.snapshot, raced), { ok: false, code: 'writer_changed' })
  assert.equal(runHelper(original.home).snapshot.pid, replacement.child.pid)
  assert.equal(replacement.child.signalCode, null)
  if (original.child.exitCode === null && original.child.signalCode === null) await once(original.child, 'exit')
  assert.equal(original.child.exitCode, 0)
  assert.equal(original.child.signalCode, null)
})

test('global flock candidates cannot identify a writer through same-inode different-device descriptors or unproven fdinfo', { skip: !canRunHelper }, async t => {
  const fixture = await holder(t)
  const wrongDevice = THREAD_WRITER_HELPER.replace('try: print(json.dumps(main(),', String.raw`
from types import SimpleNamespace
original_stat = os.stat
def descriptor_device_collision(path, *args, **kwargs):
    info = original_stat(path, *args, **kwargs)
    if isinstance(path, str) and path.startswith('/proc/') and '/fd/' in path:
        return SimpleNamespace(st_dev=info.st_dev + 1, st_ino=info.st_ino, st_mode=info.st_mode)
    return info
os.stat = descriptor_device_collision
try: print(json.dumps(main(),`)
  assert.equal(runHelper(fixture.home, 'inspect', undefined, wrongDevice).code, 'writer_unidentified')
  for (const replacement of [
    "locks = [flock_record(line.replace('FLOCK', 'POSIX')) for line in stream if line.startswith('lock:')]",
    "locks = [(record[0], record[1] + 1000000) if record else None for record in [flock_record(line) for line in stream if line.startswith('lock:')]]",
  ]) {
    const unproven = THREAD_WRITER_HELPER.replace("locks = [flock_record(line) for line in stream if line.startswith('lock:')]", replacement)
    assert.equal(runHelper(fixture.home, 'inspect', undefined, unproven).code, 'writer_unidentified')
  }
  assert.equal(fixture.child.signalCode, null)
  assert.equal(runHelper(fixture.home).snapshot.pid, fixture.child.pid)
})

const codexBin = process.env.CODEX_BIN || 'codex'
const hasCodex = canRunHelper && spawnSync(codexBin, ['--version'], { stdio: 'ignore' }).status === 0
test('isolated real Codex writer conflict can be inspected, terminated and resumed with its persisted history intact and no model turn', { skip: !hasCodex, timeout: 30_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-takeover-'))
  const home = path.join(directory, 'home')
  await fs.mkdir(home)
  await fs.writeFile(path.join(home, 'config.toml'), 'model = "offline-test"\nmodel_provider = "offline-test"\n[model_providers.offline-test]\nname = "Isolated offline test"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n')
  const children: ChildProcessWithoutNullStreams[] = []
  const env = { ...process.env, CODEX_HOME: home }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ACCESS_TOKEN']) delete env[key as keyof typeof env]
  const makeBridge = () => new Bridge({ id: 'local', name: 'Isolated fixture', kind: 'local' }, { transportFactory: (): Transport => {
    const child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    child.stderr.resume()
    const events = new EventEmitter()
    child.on('error', error => events.emit('transportError', error))
    child.on('close', () => events.emit('transportClose', new Error('Isolated app-server closed')))
    return { input: child.stdin, output: child.stdout, events, dispose: () => { child.stdin.end(); child.kill('SIGTERM') } }
  } })
  const owner = makeBridge()
  const requester = makeBridge()
  t.after(async () => {
    owner.close(); requester.close()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const force = setTimeout(() => child.kill('SIGKILL'), 1500)
      await once(child, 'exit')
      clearTimeout(force)
    }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const created = await owner.request('thread/start', { cwd: directory, sandbox: 'danger-full-access', approvalPolicy: 'never', historyMode: 'paginated' }) as { thread: { id: string; path: string } }
  const id = created.thread.id
  await owner.request('thread/name/set', { threadId: id, name: 'Isolated takeover history' })
  await owner.request('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Isolated takeover fixture history' }] }] })
  assert.match(await fs.readFile(created.thread.path, 'utf8'), /Isolated takeover fixture history/)
  const resume = { threadId: id, cwd: directory, sandbox: 'danger-full-access', approvalPolicy: 'never', excludeTurns: true }
  await assert.rejects(requester.request('thread/resume', resume), /already has an active writer/)
  const api = await endpoint(t, requester)
  const inspectionResponse = await api.post('/inspect', {}, api.headers, 'local', id)
  assert.equal(inspectionResponse.status, 200, JSON.stringify(await inspectionResponse.clone().json()))
  const inspection = await inspectionResponse.json()
  // The npm Codex launcher is Node and starts the actual Rust writer as its
  // child. Verify the discovered owner belongs to this isolated test process.
  const ownerStat = await fs.readFile(`/proc/${inspection.owner.pid}/stat`, 'utf8')
  const ownerParent = Number(ownerStat.slice(ownerStat.lastIndexOf(')') + 1).trim().split(/\s+/)[1])
  assert.ok(inspection.owner.pid === children[0]!.pid || ownerParent === children[0]!.pid)
  assert.equal(inspection.owner.affectedThreadCount, 1)
  const takeover = await api.post('', { confirmed: true, challenge: inspection.challenge }, api.headers, 'local', id)
  assert.equal(takeover.status, 200, JSON.stringify(await takeover.clone().json()))
  const resumed = await requester.request('thread/resume', resume) as { thread: { id: string; name: string; turns: unknown[] } }
  assert.equal(resumed.thread.id, id)
  assert.equal(resumed.thread.name, 'Isolated takeover history')
  assert.deepEqual(resumed.thread.turns, [])
  assert.match(await fs.readFile(created.thread.path, 'utf8'), /Isolated takeover fixture history/)
  // A second inspection cannot target the Web bridge now owning the thread.
  const ownWriter = await api.post('/inspect', {}, api.headers, 'local', id)
  assert.equal(ownWriter.status, 409)
  assert.equal((await ownWriter.json()).code, 'writer_bridge_owner')
})
