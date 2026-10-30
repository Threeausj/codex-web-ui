import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Host, RpcMessage } from './types.js'
import { DaemonSessions } from './daemon-sessions.js'

const host: Host = { id: 'ssh-daemon-a', kind: 'ssh', name: 'Daemon A', hostname: 'a.invalid', username: 'user', connectionMode: 'daemon' }
const second: Host = { ...host, id: 'ssh-daemon-b', hostname: 'b.invalid' }
const reply = (threadId: string, extra = {}): RpcMessage => ({ id: 1, result: { thread: { id: threadId, ephemeral: false, ...extra } } })
const accepted = (threadId: string): RpcMessage => ({ method: 'bridge/thread/changed', params: { method: 'turn/start', threadId, request: { input: [{ text: 'private user prompt' }] }, result: { turnId: 'turn' } } })

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-daemon-sessions-'))
  let clock = 1_000_000_000
  const options = { now: () => clock }
  const sessions = new DaemonSessions(directory, options)
  await sessions.init()
  return { directory, options, sessions, advance: (ms: number) => { clock += ms },
    read: async () => JSON.parse(await fs.readFile(sessions.file, 'utf8')) }
}

test('accepted daemon sessions survive a Web replacement without persisting prompts, requests or host credentials', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await f.sessions.observe(host, reply('one'), 'thread/start')
  await f.sessions.observe(host, accepted('two'))
  await f.sessions.observe(second, reply('one'), 'thread/resume')
  assert.deepEqual(await f.sessions.threadIds(host), ['one', 'two'])
  assert.deepEqual(await f.sessions.threadIds(second), ['one'])
  await f.sessions.close()
  const recovered = new DaemonSessions(f.directory, f.options); await recovered.init()
  assert.deepEqual(await recovered.threadIds(host), ['one', 'two'])
  const text = await fs.readFile(recovered.file, 'utf8')
  assert.ok(!text.includes('private user prompt') && !text.includes('input') && !text.includes('a.invalid') && !text.includes('username') && !text.includes('turnId'))
  assert.equal((await fs.stat(recovered.file)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700)
  await recovered.close()
})

test('metadata replies, native starts and accepted steering merge serially without duplicate IDs', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await Promise.all([
    f.sessions.observe(host, reply('one'), 'thread/start'),
    f.sessions.observe(host, reply('two'), 'thread/resume'),
    f.sessions.observe(host, reply('three'), 'thread/fork'),
    f.sessions.observe(host, { method: 'thread/started', params: { thread: { id: 'four', ephemeral: false } } }),
    f.sessions.observe(host, { method: 'bridge/thread/changed', params: { method: 'turn/steer', threadId: 'two' } }),
  ])
  assert.deepEqual(new Set(await f.sessions.threadIds(host)), new Set(['one', 'two', 'three', 'four']))
  assert.equal((await f.read()).sessions.length, 4)
  await f.sessions.close()
})

test('changing the remote endpoint or launch identity cannot restore the previous host sessions', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await f.sessions.observe(host, reply('original'), 'thread/start')
  assert.deepEqual(await f.sessions.threadIds({ ...host, name: 'Renamed label' }), ['original'])
  for (const fields of [{ hostname: 'changed.invalid' }, { username: 'other' }, { port: 2200 }, { identityFile: '/private/changed-key' }, { codexPath: '/opt/other/codex' }, { cwd: '/other' }, { kind: 'local' as const }])
    assert.deepEqual(await f.sessions.threadIds({ ...host, ...fields }), [])
  const changed = { ...host, hostname: 'changed.invalid' }
  await f.sessions.observe(changed, reply('new-endpoint'), 'thread/start')
  assert.deepEqual(await f.sessions.threadIds(host), [])
  assert.deepEqual(await f.sessions.threadIds(changed), ['new-endpoint'])
  await f.sessions.close()
})

test('SSH credential changes get a separate recovery identity while key paths remain private', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  const original = { ...host, identityFile: '/private/original-account-key' }
  const changed = { ...host, identityFile: '/private/replacement-account-key' }
  await f.sessions.observe(original, reply('old-credential-context'), 'thread/start')
  assert.deepEqual(await f.sessions.threadIds(changed), [])
  await f.sessions.observe(changed, reply('new-credential-context'), 'thread/start')
  assert.deepEqual(await f.sessions.threadIds(original), [])
  assert.deepEqual(await f.sessions.threadIds(changed), ['new-credential-context'])
  const text = await fs.readFile(f.sessions.file, 'utf8')
  assert.ok(!text.includes(original.identityFile) && !text.includes(changed.identityFile))
  await f.sessions.close()
})

test('spawn and manual proxy sessions never enter the daemon recovery journal', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  for (const connectionMode of ['spawn', 'proxy', undefined] as const) {
    await f.sessions.observe({ ...host, connectionMode }, reply('ignored'), 'thread/start')
    assert.deepEqual(await f.sessions.threadIds({ ...host, connectionMode }), [])
  }
  await assert.rejects(fs.access(f.sessions.file), { code: 'ENOENT' })
  await f.sessions.close()
})

test('the configured local Codex home and executable identify local sessions without changing remote identities', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await f.sessions.close()
  const local: Host = { id: 'local', kind: 'local', name: 'Local', connectionMode: 'daemon' }
  const firstIdentity = JSON.stringify(['/private/home-a', '/opt/codex-a', '/workspace'])
  const secondIdentity = JSON.stringify(['/private/home-b', '/opt/codex-b', '/workspace'])
  const original = new DaemonSessions(f.directory, { ...f.options, localIdentity: firstIdentity })
  await original.observe(local, reply('local-from-a'), 'thread/start')
  await original.observe(host, reply('remote-kept'), 'thread/start')
  await original.close()
  const replacement = new DaemonSessions(f.directory, { ...f.options, localIdentity: secondIdentity })
  assert.deepEqual(await replacement.threadIds(local), [])
  assert.deepEqual(await replacement.threadIds(host), ['remote-kept'])
  await replacement.observe(local, reply('local-from-b'), 'thread/start')
  assert.deepEqual(await replacement.threadIds(local), ['local-from-b'])
  const text = await fs.readFile(replacement.file, 'utf8')
  assert.ok(!text.includes('/private/home') && !text.includes('/opt/codex') && !text.includes('/workspace'))
  await replacement.close()
})

test('ephemeral and hidden title sessions stay excluded even when accepted turn events arrive later', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await f.sessions.observe(host, reply('side', { ephemeral: true }), 'thread/fork')
  await f.sessions.observe(host, accepted('side'))
  await f.sessions.observe(host, reply('title', { threadSource: 'thread_title' }), 'thread/start')
  await f.sessions.observe(host, accepted('title'))
  // If native metadata follows the acceptance event, it must remove that hint.
  await f.sessions.observe(host, accepted('late-meta'))
  await f.sessions.observe(host, { method: 'thread/started', params: { thread: { id: 'late-meta', ephemeral: true } } })
  assert.deepEqual(await f.sessions.threadIds(host), [])
  await f.sessions.close()
})

test('archive and delete notifications remove only the current host identity and persist removal', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await f.sessions.observe(host, reply('archived'), 'thread/start')
  await f.sessions.observe(host, reply('deleted'), 'thread/start')
  await f.sessions.observe(second, reply('deleted'), 'thread/start')
  await f.sessions.observe(host, { method: 'thread/archived', params: { threadId: 'archived' } })
  await f.sessions.observe(host, { method: 'thread/deleted', params: { threadId: 'deleted' } })
  await f.sessions.close()
  const recovered = new DaemonSessions(f.directory, f.options)
  assert.deepEqual(await recovered.threadIds(host), [])
  assert.deepEqual(await recovered.threadIds(second), ['deleted'])
  await recovered.close()
})

test('forgetting a host wins over queued and late metadata from its replaced bridge', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  const previous = f.sessions.observe(host, reply('before-delete'), 'thread/start')
  const removed = f.sessions.forgetHost(host.id)
  await f.sessions.observe(host, accepted('after-delete'))
  await Promise.all([previous, removed])
  assert.deepEqual(await f.sessions.threadIds(host), [])
  assert.deepEqual((await f.read()).sessions, [])
  await f.sessions.close()
})

test('recovery hints expire after seven days and new activity renews their lifetime', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await f.sessions.observe(host, reply('old'), 'thread/start')
  await f.sessions.observe(host, reply('renewed'), 'thread/start')
  f.advance(6 * 24 * 60 * 60 * 1000)
  await f.sessions.observe(host, accepted('renewed'))
  f.advance(2 * 24 * 60 * 60 * 1000)
  assert.deepEqual(await f.sessions.threadIds(host), ['renewed'])
  await f.sessions.close()
  const restored = new DaemonSessions(f.directory, f.options)
  assert.deepEqual(await restored.threadIds(host), ['renewed'])
  await restored.close()
})

test('the global ID limit evicts old metadata without dropping the most recently accepted session', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await f.sessions.observe(host, reply('seed'), 'thread/start')
  const entry = (await f.read()).sessions[0]
  await f.sessions.close()
  const sessions = Array.from({ length: 1024 }, (_, index) => ({ ...entry, threadId: `thread-${index}`, seenAt: entry.seenAt + index }))
  await fs.writeFile(f.sessions.file, JSON.stringify({ version: 1, sessions }))
  f.advance(2000)
  const restored = new DaemonSessions(f.directory, f.options); await restored.init()
  await restored.observe(host, accepted('newest'))
  const ids = await restored.threadIds(host)
  assert.equal(ids.length, 1024); assert.ok(ids.includes('newest')); assert.ok(!ids.includes('thread-0'))
  assert.ok((await fs.stat(restored.file)).size <= 1024 * 1024)
  await restored.close()
})

test('a failed metadata write never rejects an already accepted turn and can recover on the next write', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await fs.mkdir(f.sessions.file)
  await assert.doesNotReject(Promise.resolve(f.sessions.observe(host, accepted('accepted-before-disk-failure'))))
  assert.ok(f.sessions.persistenceError)
  assert.deepEqual(await f.sessions.threadIds(host), ['accepted-before-disk-failure'])
  await fs.rmdir(f.sessions.file)
  await f.sessions.observe(host, accepted('second-accepted'))
  assert.equal(f.sessions.persistenceError, undefined)
  await f.sessions.close()
  const restored = new DaemonSessions(f.directory, f.options)
  assert.deepEqual(await restored.threadIds(host), ['accepted-before-disk-failure', 'second-accepted'])
  await restored.close()
})

test('the serialized byte limit also bounds journals containing long Unicode identifiers', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  const longHost = { ...host, id: 'host-' + 'a'.repeat(240) }
  await f.sessions.observe(longHost, reply('seed'), 'thread/start')
  const entry = (await f.read()).sessions[0]
  await f.sessions.close()
  const sessions: any[] = []
  for (let index = 0; index < 1024; index++) {
    const next = [...sessions, { ...entry, threadId: '字'.repeat(252) + index, seenAt: entry.seenAt + index }]
    if (Buffer.byteLength(JSON.stringify({ version: 1, sessions: next }, null, 2) + '\n') > 1024 * 1024) break
    sessions.push(next.at(-1))
  }
  assert.ok(sessions.length < 1024 && sessions.length > 0)
  await fs.writeFile(f.sessions.file, JSON.stringify({ version: 1, sessions }, null, 2) + '\n')
  f.advance(2000)
  const restored = new DaemonSessions(f.directory, f.options); await restored.init()
  await restored.observe(longHost, accepted('字'.repeat(248) + '-latest'))
  assert.ok((await fs.stat(restored.file)).size <= 1024 * 1024)
  assert.ok((await restored.threadIds(longHost)).includes('字'.repeat(248) + '-latest'))
  await restored.close()
})

test('shutdown flushes accepted metadata and reports a remaining storage failure without replaying input', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await fs.mkdir(f.sessions.file)
  void f.sessions.observe(host, accepted('one'))
  await assert.rejects(f.sessions.close(), /未能保存/)
  await f.sessions.observe(host, accepted('after-close'))
  assert.deepEqual(await f.sessions.threadIds(host), [])
})

test('invalid, duplicate, oversized and symlink journals fail clearly without being overwritten', async t => {
  for (const content of ['private secret: invalid json', JSON.stringify({ version: 2, sessions: [] }), JSON.stringify({ version: 1, sessions: [], secret: 'private secret' }), ' '.repeat(1024 * 1024 + 1)]) {
    const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
    await fs.writeFile(f.sessions.file, content)
    const restored = new DaemonSessions(f.directory, f.options)
    await assert.rejects(restored.init(), (error: Error) => /Daemon 会话恢复记录/.test(error.message) && !error.message.includes('private secret'))
    assert.equal(await fs.readFile(f.sessions.file, 'utf8'), content)
  }
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await f.sessions.observe(host, reply('one'), 'thread/start')
  const document = await f.read(); document.sessions.push(document.sessions[0])
  await fs.writeFile(f.sessions.file, JSON.stringify(document))
  await assert.rejects(new DaemonSessions(f.directory, f.options).init(), /重复身份/)
  const target = path.join(f.directory, 'other.json'); await fs.rename(f.sessions.file, target); await fs.symlink(target, f.sessions.file)
  await assert.rejects(new DaemonSessions(f.directory, f.options).init(), /无法读取/)
})
