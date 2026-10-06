import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Bridge } from './bridge.js'
import { createServer } from './app.js'

const local = { id: 'local', kind: 'local' as const, name: 'Local' }

async function writeEngine(file: string, version: string) {
  // A real executable/stdio transport tests installation replacement without
  // touching a user's Codex account or starting any model request.
  await fs.writeFile(file, `#!/usr/bin/env node\nconst readline = require('node:readline');\nreadline.createInterface({input: process.stdin}).on('line', line => {\n  const message = JSON.parse(line);\n  if (message.method === 'initialize') console.log(JSON.stringify({id: message.id, result: {userAgent: ${JSON.stringify(version)}}}));\n  else if (message.method === 'test/exit') { console.log(JSON.stringify({id: message.id, result: {}})); process.exit(0); }\n});\n`, { mode: 0o755 })
}

test('web service starts and remains configurable without a local Codex installation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-external-web-'))
  const password = 'external-codex-test-password'
  const origin = 'http://localhost:8787'
  const application = await createServer({
    cwd: directory, dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'home'),
    password, origins: [origin], secureCookie: false, serveStatic: false,
    bridgeOptions: { codexBin: path.join(directory, 'not-installed') },
  })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  try {
    assert.equal((await fetch(base + '/api/health')).status, 200)
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const bootstrap = await fetch(base + '/api/bootstrap', { headers: { cookie } })
    assert.equal(bootstrap.status, 200)
    assert.ok((await bootstrap.json()).hosts.some((host: { id: string }) => host.id === 'local'))
    const bridge = await application.getBridge('local')
    await assert.rejects(bridge.connect(), /未找到本机 Codex.*SSH.*CODEX_BIN/)
    assert.equal((await fetch(base + '/api/health')).status, 200)
    assert.equal((await fetch(base + '/api/hosts', { headers: { cookie } })).status, 200)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('a disconnected bridge resolves the installed executable again after installation or upgrade', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-external-upgrade-'))
  const executable = path.join(directory, 'codex')
  const bridge = new Bridge(local, { codexBin: executable, cwd: directory, codexHome: path.join(directory, 'home') })
  try {
    await assert.rejects(bridge.connect(), /未找到本机 Codex/)
    await writeEngine(executable, 'external-test-v1')
    await bridge.connect()
    assert.equal(bridge.userAgent, 'external-test-v1')
    // Existing app-server processes keep their version until their transport
    // ends. Atomic replacement inside a directory mount reaches the next spawn.
    const replacement = path.join(directory, 'codex.new')
    await writeEngine(replacement, 'external-test-v2')
    await fs.rename(replacement, executable)
    await bridge.request('test/exit')
    for (let i = 0; bridge.connected && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(bridge.connected, false)
    await bridge.connect()
    assert.equal(bridge.userAgent, 'external-test-v2')
  } finally { bridge.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('an unreadable or non-executable host installation reports the mount and permissions to fix', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-external-permissions-'))
  const executable = path.join(directory, 'codex')
  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
  const bridge = new Bridge(local, { codexBin: executable, cwd: directory })
  try { await assert.rejects(bridge.connect(), /无法执行本机 Codex.*CODEX_BIN.*读取\/执行权限/) }
  finally { bridge.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
