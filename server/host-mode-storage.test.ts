import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Storage, hostInput, hostUpdateInput } from './storage.js'

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-mode-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storage = new Storage(directory, path.join(directory, 'home'), '/workspace')
  await storage.init()
  return { directory, storage }
}

test('per-host runtime modes persist independently and partial edits preserve the chosen mode', async t => {
  const { directory, storage } = await fixture(t)
  const daemon = await storage.addHost({ name: 'Independent', hostname: 'build.example', connectionMode: 'daemon' })
  const attached = await storage.addHost({ name: 'External', hostname: 'desktop.example', connectionMode: 'proxy' })
  const spawned = await storage.addHost({ name: 'Managed child', hostname: 'legacy.example', connectionMode: 'spawn' })
  await Promise.all([
    storage.updateHost(daemon.id, { name: 'Renamed independent host' }),
    storage.updateHost(daemon.id, { cwd: '/build' }),
  ])
  const restored = new Storage(directory)
  await restored.init()
  assert.equal(restored.host(daemon.id)?.connectionMode, 'daemon')
  assert.equal(restored.host(daemon.id)?.cwd, '/build')
  assert.equal(restored.host(attached.id)?.connectionMode, 'proxy')
  assert.equal(restored.host(spawned.id)?.connectionMode, 'spawn')
  assert.equal((await fs.stat(path.join(directory, 'hosts.json'))).mode & 0o777, 0o600)
})

test('legacy host loading and unrelated edits do not opt existing hosts into an independent daemon', async t => {
  const { directory } = await fixture(t)
  const legacy = { id: 'ssh-12345678-1234-1234-1234-123456789abc', name: 'Existing', kind: 'ssh', hostname: 'old.example' }
  await fs.writeFile(path.join(directory, 'hosts.json'), JSON.stringify([legacy]), { mode: 0o600 })
  const storage = new Storage(directory)
  await storage.init()
  assert.deepEqual(storage.host(legacy.id), legacy)
  const renamed = await storage.updateHost(legacy.id, { name: 'Existing renamed' })
  assert.equal(renamed.connectionReset, false)
  assert.equal(Object.hasOwn(renamed.host, 'connectionMode'), false)
  const reloaded = new Storage(directory)
  await reloaded.init()
  assert.equal(Object.hasOwn(reloaded.host(legacy.id)!, 'connectionMode'), false)
})

test('changing the runtime mode resets the connection and explicit null restores inherited configuration', async t => {
  const { directory, storage } = await fixture(t)
  const host = await storage.addHost({ name: 'Build', hostname: 'host.example' })
  const selected = await storage.updateHost(host.id, { connectionMode: 'daemon' })
  assert.equal(selected.connectionReset, true)
  assert.equal(selected.host.connectionMode, 'daemon')
  assert.equal((await storage.updateHost(host.id, { connectionMode: 'daemon' })).connectionReset, false)
  const inherited = await storage.updateHost(host.id, { connectionMode: null })
  assert.equal(inherited.connectionReset, true)
  assert.equal(Object.hasOwn(inherited.host, 'connectionMode'), false)
  const reloaded = new Storage(directory)
  await reloaded.init()
  assert.equal(Object.hasOwn(reloaded.host(host.id)!, 'connectionMode'), false)
})

test('only supported runtime modes are accepted and inheritance can be requested without another edit', () => {
  for (const connectionMode of ['daemon', 'proxy', 'spawn'])
    assert.equal(hostInput.parse({ name: 'Host', hostname: 'host.example', connectionMode }).connectionMode, connectionMode)
  for (const connectionMode of ['inherit', 'auto', true, 1, {}, [], 'daemon --update'])
    assert.equal(hostInput.safeParse({ name: 'Host', hostname: 'host.example', connectionMode }).success, false)
  assert.deepEqual(hostUpdateInput.parse({ connectionMode: null }), { connectionMode: undefined })
  assert.deepEqual(hostUpdateInput.parse({ connectionMode: '' }), { connectionMode: undefined })
})

test('a failed runtime-mode save keeps the previous durable mode and leaves future edits usable', async t => {
  const { directory, storage } = await fixture(t)
  const host = await storage.addHost({ name: 'Host', hostname: 'host.example', connectionMode: 'spawn' })
  const rename = fs.rename.bind(fs)
  const mocked = t.mock.method(fs, 'rename', async (source: string, target: string) => {
    if (target === path.join(directory, 'hosts.json')) throw new Error('Disk unavailable')
    return rename(source, target)
  })
  await assert.rejects(storage.updateHost(host.id, { connectionMode: 'daemon' }), /Disk unavailable/)
  assert.equal(storage.host(host.id)?.connectionMode, 'spawn')
  mocked.mock.restore()
  assert.equal((await storage.updateHost(host.id, { name: 'Recovered' })).connectionReset, false)
  const restored = new Storage(directory)
  await restored.init()
  assert.equal(restored.host(host.id)?.connectionMode, 'spawn')
  assert.equal(restored.host(host.id)?.name, 'Recovered')
})
