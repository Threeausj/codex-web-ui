import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { createServer } from './app.js'
import { rewriteDevelopmentResponse, sshForwardArgs } from './dev-preview.js'
import { persistentSessionName } from './persistent-terminal.js'
import { sshKnownHostsArgs } from './ssh.js'

const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))

test('development preview forwards loopback HTTP and WebSocket with isolation and revoked capabilities', { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dev-preview-'))
  const observed: { url: string; cookie?: string; authorization?: string; body?: string }[] = []
  const development = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    observed.push({ url: req.url!, cookie: req.headers.cookie, authorization: req.headers.authorization, body })
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.setHeader('Set-Cookie', 'upstream-auth=secret'); res.end('<html><head><link href="/styles.css" rel="stylesheet"><script type="module" src="/main.js"></script></head><body>Development</body></html>') }
    else if (req.url === '/main.js') { res.setHeader('Content-Type', 'application/javascript'); res.end('import "/src/app.ts"; fetch("/api/message");') }
    else if (req.url === '/styles.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{background:url(/logo.svg)}') }
    else if (req.url === '/redirect') { res.writeHead(302, { location: '/destination' }); res.end() }
    else if (req.url === '/external') { res.writeHead(302, { location: 'https://example.invalid/private' }); res.end() }
    else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url, body })) }
  })
  const upstreamWs = new WebSocketServer({ server: development })
  upstreamWs.on('connection', socket => socket.on('message', data => socket.send(data)))
  const targetPort = await listen(development)
  const application = await createServer({ cwd: directory, dataDir: path.join(directory, 'data'), password: 'development-preview-test-password', secureCookie: false, serveStatic: false })
  const appPort = await listen(application.server)
  const base = `http://127.0.0.1:${appPort}`
  const origin = 'http://localhost:8787'
  const body = JSON.stringify({ port: targetPort })
  let socket: WebSocket | undefined
  const upgrades = (url: string, origin: string) => new Promise<number>((resolve, reject) => {
    const client = new WebSocket(url, { headers: { origin } })
    client.on('open', () => { client.terminate(); resolve(101) })
    client.on('unexpected-response', (_req, response) => { response.resume(); client.terminate(); resolve(response.statusCode!) })
    client.on('error', error => { if (!error.message.includes('before the connection was established')) reject(error) })
  })
  try {
    assert.equal((await fetch(base + '/api/dev-previews', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401)
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'development-preview-test-password' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const { csrfToken } = await login.json() as { csrfToken: string }
    const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken }
    assert.equal((await fetch(base + '/api/dev-previews', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body })).status, 403)
    for (const bad of [{ port: 80 }, { port: targetPort, hostname: 'attacker.invalid' }, { port: appPort }, { port: targetPort, path: '//attacker.invalid' }]) {
      assert.equal((await fetch(base + '/api/dev-previews', { method: 'POST', headers, body: JSON.stringify(bad) })).status, 400)
    }
    const created = await fetch(base + '/api/dev-previews', { method: 'POST', headers, body })
    assert.equal(created.status, 201)
    const ticket = await created.json() as { id: string; url: string }
    const assetBase = ticket.url.replace(/\/$/, '')
    const document = await fetch(base + ticket.url, { headers: { cookie, authorization: 'Bearer do-not-forward' } })
    assert.equal(document.status, 200)
    assert.equal(document.headers.get('set-cookie'), null)
    assert.match(document.headers.get('content-security-policy')!, /sandbox allow-scripts/)
    assert.ok(!document.headers.get('content-security-policy')!.includes('allow-same-origin'))
    const html = await document.text()
    assert.match(html, /credentials:'omit'/)
    assert.ok(html.includes(`src="${assetBase}/main.js"`))
    assert.equal(observed[0]!.cookie, undefined)
    assert.equal(observed[0]!.authorization, undefined)
    const script = await fetch(base + assetBase + '/main.js')
    assert.ok((await script.text()).includes(`import "${assetBase}/src/app.ts"`))
    const stylesheet = await fetch(base + assetBase + '/styles.css')
    assert.ok((await stylesheet.text()).includes(`url(${assetBase}/logo.svg)`))
    const echo = await fetch(base + assetBase + '/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: '移动端' }) })
    assert.equal(echo.status, 200)
    assert.deepEqual(JSON.parse((await echo.json() as { body: string }).body), { hello: '移动端' })
    const redirect = await fetch(base + assetBase + '/redirect', { redirect: 'manual' })
    assert.equal(redirect.headers.get('location'), assetBase + '/destination')
    assert.equal((await fetch(base + assetBase + '/external', { redirect: 'manual' })).status, 502)
    assert.equal((await fetch(base + '/api/dev-preview/unknown/')).status, 403)
    assert.equal((await fetch(base + assetBase + '/echo', { headers: { origin: 'https://attacker.invalid' } })).status, 403)
    assert.equal((await fetch(base + assetBase + '/echo', { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })).status, 204)
    const wsUrl = `${base.replace(/^http/, 'ws')}${assetBase}/hmr?token=test`
    assert.equal(await upgrades(wsUrl, 'https://attacker.invalid'), 403)
    socket = new WebSocket(wsUrl, 'vite-hmr', { headers: { origin: 'null' } })
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    const echoed = new Promise<string>(resolve => socket!.once('message', data => resolve(data.toString())))
    socket.send('HMR 移动端 ✅')
    assert.equal(await echoed, 'HMR 移动端 ✅')
    const closed = new Promise<number>(resolve => socket!.once('close', code => resolve(code)))
    await fetch(base + '/api/auth/logout', { method: 'POST', headers })
    assert.equal(await closed, 4003)
    assert.equal((await fetch(base + assetBase + '/main.js')).status, 403)
    assert.equal(await upgrades(wsUrl, 'null'), 403)
  } finally {
    socket?.terminate(); await application.close()
    for (const client of upstreamWs.clients) client.terminate()
    upstreamWs.close()
    await new Promise<void>(resolve => development.close(() => resolve()))
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('SSH preview forwarding is loopback-only and rejects argument injection', () => {
  const args = sshForwardArgs({ id: 'ssh-test', kind: 'ssh', name: 'Test', hostname: 'example.invalid', username: 'user', port: 2222, identityFile: '/tmp/key with spaces' }, 43210, 5173)
  assert.ok(args.includes('127.0.0.1:43210:127.0.0.1:5173'))
  assert.ok(args.includes('ExitOnForwardFailure=yes'))
  assert.ok(args.includes('ServerAliveInterval=30'))
  assert.deepEqual(args.slice(-2), ['--', 'user@example.invalid'])
  assert.ok(args.includes('/tmp/key with spaces'))
  assert.throws(() => sshForwardArgs({ id: 'ssh-test', kind: 'ssh', name: 'Bad', hostname: '-oProxyCommand=touch /tmp/bad' }, 43210, 5173))
  assert.throws(() => sshForwardArgs({ id: 'ssh-test', kind: 'ssh', name: 'Bad', hostname: 'example.invalid', username: 'user;touch' }, 43210, 5173))
  assert.throws(() => sshForwardArgs({ id: 'ssh-test', kind: 'ssh', name: 'Bad', hostname: 'example.invalid' }, 43210, 80))
})

test('SSH preview forwarding pins managed keys with the same strict trust options and preserves SSH defaults for unmanaged hosts', () => {
  const host = { id: 'ssh-pinned', kind: 'ssh' as const, name: 'Pinned fixture', hostname: 'host.example.test', username: 'test', port: 2222, identityFile: '/fixture/key with spaces' }
  const unmanaged = sshForwardArgs(host, 43210, 5173)
  assert.deepEqual(unmanaged, [
    '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', '-o', 'TCPKeepAlive=yes',
    '-L', '127.0.0.1:43210:127.0.0.1:5173', '-p', '2222', '-i', '/fixture/key with spaces',
    '--', 'test@host.example.test',
  ])
  for (const file of ['/fixture/known hosts', '/fixture/"quoted"\\known_hosts', '/fixture/100%complete']) {
    const pin = { file, hostKeyAlias: '[host.example.test]:2222' }
    const managed = sshForwardArgs(host, 43210, 5173, pin)
    const trust = sshKnownHostsArgs(pin)
    const trustPosition = unmanaged.indexOf('-p')
    assert.deepEqual(managed, [...unmanaged.slice(0, trustPosition), ...trust, ...unmanaged.slice(trustPosition)])
    assert.equal(managed.filter(value => value === 'StrictHostKeyChecking=yes').length, 1)
    assert.ok(managed.includes('GlobalKnownHostsFile=/dev/null'))
    assert.ok(managed.includes('KnownHostsCommand=none'))
    assert.ok(managed.includes('HostKeyAlias=[host.example.test]:2222'))
    assert.ok(managed.includes('VerifyHostKeyDNS=no'))
    assert.ok(managed.includes('NoHostAuthenticationForLocalhost=no'))
    assert.ok(managed.includes('UpdateHostKeys=no'))
    assert.ok(managed.includes('ControlPath=none'))
    assert.ok(managed.includes('ControlMaster=no'))
    assert.ok(managed.includes('ControlPersist=no'))
    assert.ok(!managed.includes('StrictHostKeyChecking=no'))
    assert.ok(!managed.includes('StrictHostKeyChecking=accept-new'))
    assert.deepEqual(managed.slice(-2), ['--', 'test@host.example.test'])
  }
  assert.ok(!unmanaged.some(value => /^(?:UserKnownHostsFile|GlobalKnownHostsFile|KnownHostsCommand)=/.test(value)))
})

test('preview root assets and project tmux names remain scoped', () => {
  assert.equal(rewriteDevelopmentResponse('import "/src/main.ts"; import "//cdn.invalid/x.js";', 'application/javascript', '/api/dev-preview/ticket', 5173), 'import "/api/dev-preview/ticket/src/main.ts"; import "//cdn.invalid/x.js";')
  const name = persistentSessionName('ssh-1', '/项目/one;two')
  assert.match(name, /^codex-web-[a-f0-9]{24}$/)
  assert.equal(name, persistentSessionName('ssh-1', '/项目/one;two'))
  assert.notEqual(name, persistentSessionName('local', '/项目/one;two'))
})
