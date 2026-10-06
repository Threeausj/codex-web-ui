import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { createServer } from './app.js'
import type { RpcMessage } from './types.js'
import type { Transport } from './bridge.js'

function filesystemTransport(): Transport {
  const input = new PassThrough(); const output = new PassThrough()
  let buffer = ''
  const respond = async (message: RpcMessage) => {
    if (!message.id) return
    const params = message.params as { path: string; dataBase64: string }
    try {
      let result: unknown = {}
      if (message.method === 'initialize') result = { userAgent: 'test', codexHome: '/codex' }
      else if (message.method === 'fs/getMetadata') {
        const [stat, lstat] = await Promise.all([fs.stat(params.path), fs.lstat(params.path)])
        result = { isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymlink: lstat.isSymbolicLink() }
      } else if (message.method === 'fs/readFile') result = { dataBase64: (await fs.readFile(params.path)).toString('base64') }
      else if (message.method === 'fs/writeFile') await fs.writeFile(params.path, Buffer.from(params.dataBase64, 'base64'))
      output.write(`${JSON.stringify({ id: message.id, result })}\n`)
    } catch (error) { output.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: (error as Error).message } })}\n`) }
  }
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      void respond(JSON.parse(line))
    }
  })
  return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }
}

test('frontend assets can live separately from the mounted workspace without serving workspace files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-static-test-'))
  const cwd = path.join(directory, 'workspace')
  const assets = path.join(directory, 'assets')
  await fs.mkdir(cwd)
  await fs.mkdir(assets)
  await fs.writeFile(path.join(assets, 'index.html'), '<h1>Packaged frontend</h1>')
  await fs.writeFile(path.join(assets, 'app.js'), 'window.packagedFrontend = true;')
  await fs.writeFile(path.join(cwd, 'private.txt'), 'Workspace content')
  const application = await createServer({ cwd, staticDir: assets, dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'codex'), password: 'static-test-password-123', bridgeOptions: { transportFactory: () => filesystemTransport() } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  try {
    const index = await fetch(base, { headers: { accept: 'text/html' } })
    assert.equal(index.status, 200)
    assert.equal(await index.text(), '<h1>Packaged frontend</h1>')
    assert.equal(await (await fetch(base + '/app.js')).text(), 'window.packagedFrontend = true;')
    assert.equal((await fetch(base + '/private.txt', { headers: { accept: 'text/plain' } })).status, 404)
    assert.equal((await fetch(base + '/api/bootstrap')).status, 401)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('preview tickets serve sandboxed assets, reject escape/symlinks and expire after logout', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-preview-test-'))
  const project = path.join(directory, 'project'); await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'index.html'), '<link rel="stylesheet" href="styles.css"><h1>Preview</h1>')
  await fs.writeFile(path.join(project, 'styles.css'), 'h1 { color: red }')
  await fs.writeFile(path.join(directory, 'private.txt'), 'outside root')
  await fs.symlink(path.join(directory, 'private.txt'), path.join(project, 'escape.txt'))
  const application = await createServer({ cwd: directory, dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'codex'), password: 'preview-test-password-123', secureCookie: false, serveStatic: false, bridgeOptions: { transportFactory: () => filesystemTransport() } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const port = (application.server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  const initial = `/api/preview?host=local&path=${encodeURIComponent(path.join(project, 'index.html'))}`
  try {
    assert.equal((await fetch(base + initial, { redirect: 'manual' })).status, 401)
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' }, body: JSON.stringify({ password: 'preview-test-password-123' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const session = await login.json() as { csrfToken: string }
    const ticketResponse = await fetch(base + initial, { headers: { cookie }, redirect: 'manual' })
    assert.equal(ticketResponse.status, 302)
    const ticketPath = ticketResponse.headers.get('location')!
    const assetBase = ticketPath.slice(0, ticketPath.lastIndexOf('/') + 1)
    // A sandboxed iframe has an opaque origin, so its assets cannot rely on SameSite cookies.
    const document = await fetch(base + ticketPath)
    assert.equal(document.status, 200)
    assert.match(await document.text(), /<h1>Preview<\/h1>/)
    const csp = document.headers.get('content-security-policy')!
    assert.match(csp, /sandbox allow-scripts/)
    assert.ok(!csp.includes('allow-same-origin'))
    const stylesheet = await fetch(base + assetBase + 'styles.css')
    assert.equal(stylesheet.status, 200)
    assert.equal(await stylesheet.text(), 'h1 { color: red }')
    assert.equal((await fetch(base + assetBase + '%2e%2e%2Fprivate.txt')).status, 403)
    assert.equal((await fetch(base + assetBase + 'escape.txt')).status, 403)
    assert.equal((await fetch(base + '/api/preview-files/not-a-ticket/index.html')).status, 403)
    const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie, 'x-csrf-token': session.csrfToken, origin: 'http://localhost:8787' } })
    assert.equal(logout.status, 200)
    assert.equal((await fetch(base + assetBase + 'styles.css')).status, 403)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('WebSocket upgrades require a trusted origin and authenticated cookie', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ws-test-'))
  const application = await createServer({ dataDir: directory, password: 'websocket-test-password-123', secureCookie: false, serveStatic: false, bridgeOptions: { transportFactory: () => filesystemTransport() } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const port = (application.server.address() as { port: number }).port
  const url = `ws://127.0.0.1:${port}/api/rpc?clientId=test_browser`
  const attempt = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!) })
    ws.on('open', () => { ws.terminate(); resolve(101) })
    ws.on('error', error => { if (!error.message.includes('before the connection was established')) reject(error) })
  })
  try {
    assert.equal(await attempt({ origin: 'https://attacker.invalid' }), 403)
    assert.equal(await attempt({ origin: 'http://localhost:8787' }), 401)
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'websocket-test-password-123' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    assert.equal(await attempt({ origin: 'http://localhost:8787', cookie }), 101)
    const { csrfToken } = await login.json() as { csrfToken: string }
    const active = new WebSocket(url, { headers: { origin: 'http://localhost:8787', cookie } })
    await new Promise<void>((resolve, reject) => { active.once('open', resolve); active.once('error', reject) })
    const closed = new Promise<number>(resolve => active.once('close', code => resolve(code)))
    await fetch(`http://127.0.0.1:${port}/api/auth/logout`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken } })
    assert.equal(await closed, 4003)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
