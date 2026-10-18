import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import type { ConfigRequirements } from '../shared/protocol/v2/ConfigRequirements.js'
import type { SandboxPolicy } from '../shared/protocol/v2/SandboxPolicy.js'
import { DEFAULT_PERMISSION_PROFILES } from '../src/lib/configuration.js'
import { explicitWebPermissionSelection, resolveResumePermissionOverrides, restoreRuntimePermissionPolicy } from '../src/lib/resume-permissions.js'

test('an unselected Web fallback omits overrides while legacy and explicit defaults retain their semantics', () => {
  assert.equal(explicitWebPermissionSelection({}), null)
  assert.equal(explicitWebPermissionSelection({ defaultPermission: 'workspace-write', defaultPermissionExplicit: false }), null)
  assert.deepEqual(explicitWebPermissionSelection({ defaultPermission: 'workspace-write' }), { mode: 'workspace-write', profileId: '' })
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    assert.deepEqual(explicitWebPermissionSelection({ defaultPermission: mode, defaultPermissionExplicit: true }), { mode, profileId: '' })
  }
  assert.deepEqual(resolveResumePermissionOverrides(null), {})
  assert.throws(() => explicitWebPermissionSelection({ defaultPermission: 'unknown', defaultPermissionExplicit: true }), /权限选择无效/)
})

test('conversation selections and explicit named Web profiles override a global default without inventing native profile ids', () => {
  const profile = { ...DEFAULT_PERMISSION_PROFILES[1], id: 'online', networkAccess: true }
  const preferences = { defaultPermission: 'danger-full-access', defaultPermissionExplicit: true, activePermissionProfileId: 'online', permissionProfiles: [profile] }
  assert.deepEqual(explicitWebPermissionSelection(preferences), { mode: 'workspace-write', profileId: 'online' })
  assert.deepEqual(explicitWebPermissionSelection(preferences, { mode: 'read-only', profileId: '' }), { mode: 'read-only', profileId: '' })
  const selection = explicitWebPermissionSelection(preferences)!
  const request = resolveResumePermissionOverrides(selection, { profile, cwd: '/srv/project' })
  assert.deepEqual(request, {
    sandbox: 'workspace-write', approvalPolicy: 'on-request',
    config: { sandbox_workspace_write: {
      writable_roots: ['/srv/project'], network_access: true,
      exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
    } },
  })
  assert.ok(!('permissions' in request))
})

test('explicit permissions are checked against managed requirements before any override is sent', () => {
  const selection = { mode: 'danger-full-access' as const, profileId: '' }
  assert.deepEqual(resolveResumePermissionOverrides(selection), { sandbox: 'danger-full-access', approvalPolicy: 'never' })
  assert.throws(() => resolveResumePermissionOverrides(selection, {
    requirements: { allowedSandboxModes: ['read-only'], allowedApprovalPolicies: ['on-request'] } as ConfigRequirements,
  }), /管理策略/)
  assert.throws(() => resolveResumePermissionOverrides({ mode: 'read-only', profileId: '' }, {
    requirements: { allowedApprovalPolicies: [] } as unknown as ConfigRequirements,
  }), /管理策略/)
})

test('a resumed policy retains saved network, writable roots and granular approvals without sharing mutable state', () => {
  const sandbox: SandboxPolicy = { type: 'workspaceWrite', writableRoots: ['/srv/project', '/srv/data'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
  const approvalPolicy = { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: true, mcp_elicitations: false } }
  const policy = restoreRuntimePermissionPolicy({ sandbox, approvalPolicy })!
  assert.deepEqual(policy, { sandboxPolicy: sandbox, approvalPolicy })
  assert.notEqual(policy.sandboxPolicy, sandbox)
  assert.notEqual(policy.approvalPolicy, approvalPolicy)
  if (policy.sandboxPolicy.type === 'workspaceWrite') policy.sandboxPolicy.writableRoots.length = 0
  assert.deepEqual(sandbox.writableRoots, ['/srv/project', '/srv/data'])
  assert.equal(restoreRuntimePermissionPolicy({ sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' })?.approvalPolicy, 'never')
  assert.deepEqual(restoreRuntimePermissionPolicy({ sandbox: { type: 'externalSandbox', networkAccess: 'restricted' }, approvalPolicy: 'untrusted' }), {
    sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' }, approvalPolicy: 'untrusted',
  })
})

test('old runtime responses use conservative missing fields and never inherit another sandbox grant', () => {
  assert.equal(restoreRuntimePermissionPolicy({}), null)
  const fallback = { sandboxPolicy: { type: 'dangerFullAccess' as const }, approvalPolicy: 'on-request' as const }
  assert.deepEqual(restoreRuntimePermissionPolicy({}, fallback), fallback)
  assert.notEqual(restoreRuntimePermissionPolicy({}, fallback), fallback)
  assert.deepEqual(restoreRuntimePermissionPolicy({ sandbox: { type: 'workspaceWrite' } as SandboxPolicy }), {
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, approvalPolicy: 'on-request',
  })
  assert.deepEqual(restoreRuntimePermissionPolicy({ sandbox: { type: 'readOnly' } as SandboxPolicy }, fallback), {
    sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request',
  })
  assert.equal(restoreRuntimePermissionPolicy({ sandbox: { type: 'readOnly' } as SandboxPolicy }, {
    sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never',
  })?.approvalPolicy, 'on-request')
})

test('writer-preserving refreshes can copy a Vue runtime policy without losing granular settings', () => {
  const policy = reactive({
    sandboxPolicy: { type: 'readOnly' as const, networkAccess: true },
    approvalPolicy: { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: true, mcp_elicitations: false } },
    source: 'native' as const,
  })
  const restored = restoreRuntimePermissionPolicy({}, policy)!
  assert.deepEqual(restored, policy)
  assert.notEqual(restored.sandboxPolicy, policy.sandboxPolicy)
  assert.notEqual(restored.approvalPolicy, policy.approvalPolicy)
  assert.deepEqual(restoreRuntimePermissionPolicy({ sandbox: policy.sandboxPolicy }, policy)?.approvalPolicy, policy.approvalPolicy)
})
