import assert from 'node:assert/strict'
import test from 'node:test'
import { availablePermissionProfiles, configEditRestriction, configLayerLabel, DEFAULT_PERMISSION_PROFILES, permissionProfileProblems, resolvePermissionProfile, resolveWebPermissionSelection, validatePermissionProfile } from '../src/lib/configuration.js'
import type { ConfigRequirements } from '../shared/protocol/v2/ConfigRequirements.js'

test('named Web profiles resolve to actual protocol sandbox fields without inventing native ids', () => {
  const profile = { ...DEFAULT_PERMISSION_PROFILES[1], id: 'web-online', name: '联网开发', networkAccess: true }
  const resolved = resolvePermissionProfile(profile, { cwd: '/srv/项目 one' })
  assert.deepEqual(resolved, {
    sandbox: 'workspace-write', approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/srv/项目 one'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  })
  assert.ok(!('permissions' in resolved))
  assert.deepEqual(resolvePermissionProfile(DEFAULT_PERMISSION_PROFILES[0]).sandboxPolicy, { type: 'readOnly', networkAccess: false })
  assert.deepEqual(resolvePermissionProfile(DEFAULT_PERMISSION_PROFILES[2]).sandboxPolicy, { type: 'dangerFullAccess' })
  assert.throws(() => resolvePermissionProfile(profile, { cwd: './project' }), /绝对路径/)
})

test('bare full access resolves never approvals while explicit named presets and managed requirements remain authoritative', () => {
  assert.deepEqual(resolveWebPermissionSelection('danger-full-access'), {
    sandbox: 'danger-full-access', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
  })
  const reviewedFullAccess = { ...DEFAULT_PERMISSION_PROFILES[2], approvalPolicy: 'on-request' as const }
  assert.equal(resolveWebPermissionSelection('danger-full-access', { profile: reviewedFullAccess }).approvalPolicy, 'on-request')
  assert.equal(resolveWebPermissionSelection('workspace-write', { profile: reviewedFullAccess, cwd: '/project' }).approvalPolicy, 'on-request')
  assert.throws(() => resolveWebPermissionSelection('danger-full-access', { requirements: { allowedApprovalPolicies: ['on-request'] } as ConfigRequirements }), /不允许此审批策略/)
  assert.deepEqual(resolveWebPermissionSelection('read-only').sandboxPolicy, { type: 'readOnly', networkAccess: false })
})

test('profiles enforce current schema and managed empty allow lists rather than treating them as unrestricted', () => {
  assert.ok(validatePermissionProfile({ ...DEFAULT_PERMISSION_PROFILES[1], approvalPolicy: 'on-failure' }).length)
  assert.ok(validatePermissionProfile({ ...DEFAULT_PERMISSION_PROFILES[2], networkAccess: false }).length)
  const restrictions = { allowedSandboxModes: ['read-only'], allowedApprovalPolicies: ['untrusted'] } as ConfigRequirements
  assert.equal(permissionProfileProblems(DEFAULT_PERMISSION_PROFILES[1], restrictions).length, 2)
  assert.throws(() => resolvePermissionProfile(DEFAULT_PERMISSION_PROFILES[0], { requirements: { allowedSandboxModes: [] } as unknown as ConfigRequirements }), /管理策略/)
  const untrusted = { ...DEFAULT_PERMISSION_PROFILES[0], approvalPolicy: 'untrusted' as const }
  assert.equal(permissionProfileProblems(untrusted, restrictions).length, 0)
})

test('saved presets stay isolated copies and invalid duplicate ids cannot silently replace another policy', () => {
  const defaults = availablePermissionProfiles()
  defaults[0].name = 'Changed in caller'
  assert.equal(DEFAULT_PERMISSION_PROFILES[0].name, '只读分析')
  const restored = availablePermissionProfiles([DEFAULT_PERMISSION_PROFILES[0], { ...DEFAULT_PERMISSION_PROFILES[0], name: 'Duplicate' }, { id: 'invalid' }, DEFAULT_PERMISSION_PROFILES[1]])
  assert.equal(restored.length, 2)
  assert.equal(restored[0].name, '只读分析')
  assert.deepEqual(availablePermissionProfiles([]), [])
})

test('configuration edits honor the closest effective managed origin and provider requirements', () => {
  const origins = {
    'model_providers': { name: { type: 'enterpriseManaged' as const, id: 'cloud-policy', name: '模型管理' }, version: 'managed-v1' },
    'model_providers.local': { name: { type: 'user' as const, file: '/home/a/.codex/config.toml', profile: null }, version: 'user-v1' },
  }
  assert.match(configEditRestriction('model_providers.remote.base_url', 'https://example.invalid', { origins })!, /管理员/)
  assert.equal(configEditRestriction('model_providers.local.base_url', 'http://localhost:8000', { origins }), null)
  const nestedOrigins = { 'model_providers.managed.base_url': origins.model_providers }
  assert.match(configEditRestriction('model_providers', {}, { origins: nestedOrigins })!, /包含管理员/)
  const requirements = { modelProvider: 'managed', allowedSandboxModes: ['read-only'], allowedApprovalPolicies: ['on-request'] } as ConfigRequirements
  assert.match(configEditRestriction('model_provider', 'unmanaged', null, requirements)!, /固定/)
  assert.equal(configEditRestriction('model_provider', 'managed', null, requirements), null)
  assert.match(configEditRestriction('sandbox_mode', 'danger-full-access', null, requirements)!, /不允许/)
  assert.equal(configEditRestriction('model', 'a-model', null, requirements), null)
  assert.equal(configLayerLabel({ type: 'user', file: '/home/a/.codex/research.config.toml', profile: 'research' }), '用户 / research · /home/a/.codex/research.config.toml')
})
