import test from 'node:test'
import assert from 'node:assert/strict'
import express, { type ErrorRequestHandler } from 'express'
import http from 'node:http'
import { z } from 'zod'
import { Auth } from './auth.js'
import { registerPersistentTerminal } from './persistent-terminal.js'
import type { Bridge } from './bridge.js'

async function fixture() {
  const requests: any[] = []
  let failure = false
  const auth = new Auth('persistent-shell-test-password', new Set(['http://localhost:8787']), false)
  const app = express()
  app.use(express.json())
  app.post('/api/auth/login', auth.login)
  registerPersistentTerminal(app, {
    requireAuth: auth.requireAuth, requireCsrf: auth.requireCsrf,
    getHost: id => id === 'local' ? { id, name: 'Test', kind: 'local' } : undefined,
    getBridge: async () => ({ request: async (method: string, params: any) => {
      requests.push({ method, params })
      if (method === 'fs/getMetadata') return { isDirectory: true }
      return failure ? { exitCode: 1, stdout: '', stderr: 'bwrap: No permissions to create a new namespace' } : { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' }
    } }) as unknown as Bridge,
  })
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error instanceof z.ZodError ? 400 : 500).json({ error: error.message }) }
  app.use(errors)
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'persistent-shell-test-password' }) })
  const { csrfToken } = await login.json() as { csrfToken: string }
  const headers = { 'content-type': 'application/json', origin: 'http://localhost:8787', cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': csrfToken }
  return { requests, fail: () => { failure = true }, post: (body: any, custom = headers) => fetch(base + '/api/terminal-sessions/prepare', { method: 'POST', headers: custom, body: JSON.stringify(body) }), headers, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

test('persistent shell discovery honors explicitly selected permissions and defaults safely', async () => {
  const f = await fixture()
  try {
    for (const permission of [undefined, 'read-only', 'workspace-write', 'danger-full-access']) {
      const response = await f.post({ cwd: '/workspace', ...(permission ? { permission } : {}) })
      assert.equal(response.status, 200)
      const result = await response.json() as any
      assert.equal(result.available, true)
      assert.deepEqual(result.command, ['/usr/bin/tmux', 'new-session', '-A', '-s', result.sessionName, '-c', '/workspace'])
      const request = f.requests.at(-1)
      assert.deepEqual(request.params.command, ['/bin/sh', '-c', 'command -v tmux'])
      assert.equal(request.params.sandboxPolicy.type, permission === 'danger-full-access' ? 'dangerFullAccess' : permission === 'workspace-write' ? 'workspaceWrite' : 'readOnly')
      if (permission === 'workspace-write') assert.deepEqual(request.params.sandboxPolicy.writableRoots, ['/workspace'])
    }
  } finally { await f.close() }
})

test('persistent shell preparation rejects unauthorized, CSRF-invalid and invalid permission inputs before executing', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.post({ cwd: '/workspace' }, { ...f.headers, cookie: '' })).status, 401)
    assert.equal((await f.post({ cwd: '/workspace' }, { ...f.headers, 'x-csrf-token': '' })).status, 403)
    assert.equal((await f.post({ cwd: '/workspace', permission: 'root' })).status, 400)
    assert.equal(f.requests.length, 0)
  } finally { await f.close() }
})

test('namespace-blocked tmux discovery reports the actual cause without retrying with broader permissions', async () => {
  const f = await fixture()
  f.fail()
  try {
    const response = await f.post({ cwd: '/workspace', permission: 'workspace-write' })
    const result = await response.json() as any
    assert.equal(response.status, 200)
    assert.equal(result.available, false)
    assert.match(result.reason, /namespace/)
    assert.ok(!result.reason.includes('未检测到'))
    assert.equal(f.requests.filter(request => request.method === 'command/exec').length, 1)
    assert.equal(f.requests.at(-1).params.sandboxPolicy.type, 'workspaceWrite')
  } finally { await f.close() }
})
