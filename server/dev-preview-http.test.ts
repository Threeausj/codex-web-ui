import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from './app.js'

const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))

test('preview streams unmodified bodies and isolates cookie/bearer auth from Codex and other tickets', { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-preview-http-'))
  const observed: { body: string; cookie?: string; authorization?: string; custom?: string; host?: string }[] = []
  const development = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    observed.push({ body, cookie: req.headers.cookie, authorization: req.headers.authorization, custom: req.headers['x-app-token'] as string, host: req.headers.host })
    if (req.url === '/truncated') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '100000' }); res.write('partial')
      setImmediate(() => res.destroy()); return
    }
    if (req.url === '/malformed-redirect') { res.writeHead(302, { Location: 'http://[' }); res.end(); return }
    if (req.url === '/api/login') res.setHeader('Set-Cookie', ['app_session=preview-only; HttpOnly; Path=/api', 'outside=bad; Domain=example.com'])
    if (req.url === '/download') { res.setHeader('Content-Range', 'bytes 0-2/10'); res.setHeader('Content-Disposition', 'attachment; filename="test.txt"'); res.statusCode = 206 }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ body, cookie: req.headers.cookie || null, authorization: req.headers.authorization || null, custom: req.headers['x-app-token'] || null }))
  })
  const targetPort = await listen(development)
  const app = await createServer({ cwd: directory, dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'codex'), password: 'preview-http-fixture-password', secureCookie: false, serveStatic: false })
  const origin = `http://127.0.0.1:${await listen(app.server)}`
  try {
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'preview-http-fixture-password' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!, { csrfToken } = await login.json() as { csrfToken: string }
    const auth = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken }
    const create = async (path = '/') => {
      const response = await fetch(origin + '/api/dev-previews', { method: 'POST', headers: auth, body: JSON.stringify({ port: targetPort, path }) })
      assert.equal(response.status, 201)
      return await response.json() as { id: string; url: string }
    }
    const ticket = await create(), base = origin + ticket.url.replace(/\/$/, '')
    const whitespaceJson = '{  "value" : "' + 'x'.repeat(90000) + '"  }\n'
    const forwarded = await fetch(base + '/api/login', { method: 'POST', headers: { ...auth, origin: 'null', authorization: 'Bearer app-token', 'x-app-token': 'custom-app-value' }, body: whitespaceJson })
    assert.equal(forwarded.status, 200)
    assert.equal(forwarded.headers.get('set-cookie'), null)
    assert.deepEqual(await forwarded.json(), { body: whitespaceJson, cookie: null, authorization: 'Bearer app-token', custom: 'custom-app-value' })
    assert.equal(observed.at(-1)!.host, `localhost:${targetPort}`)
    const me = await fetch(base + '/api/me', { headers: { cookie: 'codex_session=never-forward', authorization: 'Bearer codex-token', origin } })
    assert.deepEqual(await me.json(), { body: '', cookie: 'app_session=preview-only', authorization: null, custom: null })
    const other = await create()
    const isolated = await fetch(origin + other.url.replace(/\/$/, '') + '/api/me')
    assert.equal((await isolated.json() as any).cookie, null)
    const plain = 'not-json=1&encoded=%2F%2B'
    const form = await fetch(base + '/api/form', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' }, body: plain })
    assert.equal((await form.json() as any).body, plain)
    const cors = await fetch(base + '/api/me', { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-headers': 'Authorization, X-App-Token, Cookie, Host' } })
    assert.equal(cors.status, 204)
    assert.equal(cors.headers.get('access-control-allow-headers'), 'authorization, x-app-token')
    const download = await fetch(base + '/download')
    assert.equal(download.status, 206)
    assert.equal(download.headers.get('content-range'), 'bytes 0-2/10')
    assert.match(download.headers.get('content-disposition')!, /test\.txt/)
    await assert.rejects(async () => { const truncated = await fetch(base + '/truncated'); await truncated.arrayBuffer() })
    assert.equal((await fetch(origin + '/api/health')).status, 200, 'truncated upstream body must not crash the Web server')
    assert.equal((await fetch(base + '/malformed-redirect', { redirect: 'manual' })).status, 502)
    assert.equal((await fetch(origin + '/api/health')).status, 200, 'invalid upstream Location must not crash the Web server')
    const normalized = await create('/../api?test=1')
    assert.equal(normalized.url, `/api/dev-preview/${normalized.id}/api?test=1`)
    // Preserve the normal Codex API body limit.
    assert.equal((await fetch(origin + '/api/dev-previews', { method: 'POST', headers: auth, body: whitespaceJson })).status, 413)
    const unused = http.createServer(); const closedPort = await listen(unused); await new Promise<void>(resolve => unused.close(() => resolve()))
    const unavailable = await fetch(origin + '/api/dev-previews', { method: 'POST', headers: auth, body: JSON.stringify({ port: closedPort }) })
    assert.equal(unavailable.status, 502)
    assert.match((await unavailable.json() as any).error, /HTTP 服务已启动/)
  } finally {
    await app.close(); await new Promise<void>(resolve => development.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true })
  }
})
