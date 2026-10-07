import test from 'node:test'
import assert from 'node:assert/strict'
import { methodAccepts, mcpRuntimeLabel, mcpAuthLabel, safeAuthorizationUrl } from '../src/lib/integration-capabilities.js'

test('integration controls require confirmed method and exact allowed and required request fields', () => {
  const value = { status: 'known' as const, checkedAt: 10, methods: { 'skills/config/write': { available: true, params: ['path', 'enabled'], required: ['enabled'] } } }
  assert.equal(methodAccepts(value, 'skills/config/write', ['path', 'enabled']), true)
  assert.equal(methodAccepts(value, 'skills/config/write', ['name', 'enabled']), false)
  assert.equal(methodAccepts(value, 'skills/config/write', ['path']), false)
  assert.equal(methodAccepts({ ...value, status: 'unknown' }, 'skills/config/write', ['path', 'enabled']), false)
  assert.equal(methodAccepts(value, 'unknown/new-method', []), false)
  assert.equal(methodAccepts(null, 'skills/config/write', ['path', 'enabled']), false)
})
test('OAuth authorization URLs are bounded safe links rather than script or credential URLs', () => {
  assert.equal(safeAuthorizationUrl('https://identity.example.com/authorize?state=fixture'), 'https://identity.example.com/authorize?state=fixture')
  for (const value of ['javascript:alert(1)', 'file:///secret', 'http://insecure.example.com/login', 'https://user:password@example.com/login', 'https://example.com/login#secret', '\nhttps://example.com/login', 1, null, `https://example.com/${'x'.repeat(8192)}`]) assert.equal(safeAuthorizationUrl(value), '')
})
test('MCP status labels use enums and never reflect arbitrary server error text', () => {
  assert.equal(mcpRuntimeLabel('connected'), '已连接'); assert.equal(mcpRuntimeLabel('authenticationRequired'), '需要登录')
  assert.equal(mcpAuthLabel('bearerToken'), '使用主机令牌'); assert.equal(mcpAuthLabel('oAuth'), 'OAuth 已登录')
  assert.equal(mcpRuntimeLabel('secret-token'), '状态未报告'); assert.equal(mcpAuthLabel('secret-token'), '登录状态未报告')
})
