import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import { Auth } from './auth.js'
import { hostInput } from './storage.js'

test('HTTP authentication requires password, protects mutations with CSRF and invalidates logout', async () => {
  const origin = 'http://localhost:8787'
  const auth = new Auth('test-password-at-least-12', new Set([origin]))
  const app = express()
  app.use(express.json({ limit: '64kb' }))
  app.get('/session', auth.session)
  app.post('/login', auth.login)
  app.post('/protected', auth.requireAuth, auth.requireCsrf, (_req, res) => res.json({ ok: true }))
  app.post('/logout', auth.requireAuth, auth.requireCsrf, auth.logout)
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const endpoint = `http://127.0.0.1:${address.port}`
  try {
    const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${endpoint}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) })
    assert.equal((await post('/protected', {})).status, 401)
    assert.equal((await post('/login', { password: 'wrong' })).status, 401)
    const login = await post('/login', { password: 'test-password-at-least-12' })
    assert.equal(login.status, 200)
    const cookieHeader = login.headers.get('set-cookie')!
    assert.match(cookieHeader, /HttpOnly/i); assert.match(cookieHeader, /SameSite=Strict/i)
    const cookie = cookieHeader.split(';')[0]!
    const { csrfToken } = await login.json() as { csrfToken: string }
    assert.equal((await post('/protected', {}, { cookie })).status, 403)
    assert.equal((await post('/protected', {}, { cookie, 'x-csrf-token': csrfToken, origin: 'https://attacker.invalid' })).status, 403)
    assert.equal((await post('/protected', {}, { cookie, 'x-csrf-token': csrfToken })).status, 200)
    const resumed = await fetch(`${endpoint}/session`, { headers: { cookie } })
    assert.equal((await resumed.json() as { csrfToken: string }).csrfToken, csrfToken)
    assert.equal((await post('/logout', {}, { cookie, 'x-csrf-token': csrfToken })).status, 200)
    assert.equal((await post('/protected', {}, { cookie, 'x-csrf-token': csrfToken })).status, 401)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('login rate limits apply before expensive password hashing', async () => {
  const auth = new Auth('test-password-at-least-12', new Set())
  let status = 0
  const response = { status(code: number) { status = code; return this }, json() { return this }, set() { return this } }
  for (let i = 0; i < 11; i++) auth.login({ body: { password: 'incorrect' }, headers: {}, ip: 'test-address', socket: {} } as never, response as never, () => {})
  assert.equal(status, 429)
})

test('SSH host fields reject argument injection, controls and relative identity paths', () => {
  const base = { name: 'Remote', hostname: 'example.com' }
  assert.ok(hostInput.safeParse({ ...base, username: 'developer', port: 22, identityFile: '/keys/key' }).success)
  for (const bad of [{ hostname: '-oProxyCommand=evil' }, { hostname: 'example.com; id' }, { username: '-oFoo' }, { identityFile: './key' }, { cwd: '/tmp\nexec evil' }]) assert.equal(hostInput.safeParse({ ...base, ...bad }).success, false)
})
