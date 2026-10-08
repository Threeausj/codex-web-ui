import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Storage, writePrivateJson } from './storage.js'

test('deleting a host cannot overwrite concurrent project saves or create an orphan project', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-storage-race-'))
  const storage = new Storage(directory, path.join(directory, 'home'), '/workspace')
  await storage.init()
  const deleted = await storage.addHost({ name: 'Delete me', hostname: 'deleted.example' })
  const retained = await storage.addHost({ name: 'Retain me', hostname: 'retained.example' })
  await storage.addProject(deleted.id, '/old')
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const blocked = new Promise<void>(resolve => { entered = resolve })
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: string, target: string) => {
    if (target === path.join(directory, 'hosts.json')) { entered(); await gate }
    return rename(source, target)
  })
  try {
    const deletion = storage.deleteHost(deleted.id)
    await blocked
    const otherProject = storage.addProject(retained.id, '/new', 'New project')
    const orphan = assert.rejects(storage.addProject(deleted.id, '/too-late'), { status: 404 })
    release()
    await Promise.all([deletion, otherProject, orphan])
    for (const value of [storage, new Storage(directory, path.join(directory, 'home'), '/workspace')]) {
      if (value !== storage) await value.init()
      assert.equal(value.host(deleted.id), undefined)
      const projects = await value.projects()
      assert.equal(projects.find(project => project.hostId === retained.id)?.name, 'New project')
      assert.equal(projects.some(project => project.hostId === deleted.id), false)
    }
  } finally { release(); t.mock.restoreAll(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('failed host deletion restores project metadata and the write queue remains usable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-storage-rollback-'))
  const storage = new Storage(directory, path.join(directory, 'home'), '/workspace')
  await storage.init()
  const host = await storage.addHost({ name: 'Keep me', hostname: 'keep.example' })
  await storage.addProject(host.id, '/keep', 'Keep project')
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: string, target: string) => {
    if (target === path.join(directory, 'hosts.json')) throw new Error('Disk failure')
    return rename(source, target)
  })
  try {
    await assert.rejects(storage.deleteHost(host.id), /Disk failure/)
    t.mock.restoreAll()
    await storage.updateProject(host.id, '/keep', { name: 'Updated after failure' })
    const restored = new Storage(directory, path.join(directory, 'home'), '/workspace')
    await restored.init()
    assert.ok(restored.host(host.id))
    assert.equal((await restored.projects()).find(project => project.hostId === host.id)?.name, 'Updated after failure')
    assert.equal((await fs.readdir(directory)).some(file => file.endsWith('.tmp')), false)
  } finally { t.mock.restoreAll(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('failed private JSON replacement removes temporary secrets and preserves the previous file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-private-write-'))
  const target = path.join(directory, 'private.json')
  await writePrivateJson(target, { version: 'original' })
  t.mock.method(fs, 'rename', async () => { throw new Error('Rename failed') })
  try {
    await assert.rejects(writePrivateJson(target, { version: 'secret new value' }), /Rename failed/)
    assert.deepEqual(await fs.readdir(directory), ['private.json'])
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { version: 'original' })
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600)
  } finally { t.mock.restoreAll(); await fs.rm(directory, { recursive: true, force: true }) }
})
