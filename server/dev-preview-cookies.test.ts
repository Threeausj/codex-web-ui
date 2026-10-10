import test from 'node:test'
import assert from 'node:assert/strict'
import { PreviewCookies } from './dev-preview-cookies.js'

test('preview cookies isolate authentication by ticket, enforce paths and expire sessions', () => {
  const one = new PreviewCookies(), two = new PreviewCookies()
  one.receive(['app=first; HttpOnly; Path=/api; SameSite=Lax', 'theme=dark; Path=/; Domain=localhost', 'external=secret; Domain=example.com'], '/api/login', 1000)
  assert.equal(one.header('/api/me', 1000), 'app=first; theme=dark')
  assert.equal(one.header('/apix', 1000), 'theme=dark')
  assert.equal(two.header('/api/me', 1000), '')
  one.receive(['app=next; Path=/api; Max-Age=1', 'theme=; Path=/; Max-Age=0'], '/api/login', 1000)
  assert.equal(one.header('/api/me', 1500), 'app=next')
  assert.equal(one.header('/api/me', 2001), '')
  one.receive(['default=x', 'invalid name=x', 'bad=first\r\nsecond'], '/api/auth/login', 2000)
  assert.equal(one.header('/api/auth/me', 2000), 'default=x')
  assert.equal(one.header('/api/me', 2000), '')
})

test('preview cookies give Max-Age precedence and keep an upper bound on upstream state', () => {
  const jar = new PreviewCookies()
  jar.receive(['app=ok; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=5'], '/', 1000)
  assert.equal(jar.header('/', 1001), 'app=ok')
  for (let i = 0; i < 200; i++) jar.receive([`c${i}=x; Path=/`], '/', 2000)
  assert.equal(jar.header('/', 2001).split('; ').length, 128)
})
