import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import type { ConfigRequirements } from '../shared/protocol/v2/ConfigRequirements.js'
import type { SandboxPolicy } from '../shared/protocol/v2/SandboxPolicy.js'
import { DEFAULT_PERMISSION_PROFILES } from '../src/lib/configuration.js'
import { captureForkPermissionInheritance, explicitWebPermissionSelection, resolveForkPermissionInheritance, resolveResumePermissionOverrides, restoreRuntimePermissionPolicy } from '../src/lib/resume-permissions.js'

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

test('native profile provenance and review routing remain isolated from Web presets and mutable responses', () => {
  const response = reactive({
    sandbox: { type: 'workspaceWrite' as const, writableRoots: ['/srv/project', '/approved/data'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: false },
    approvalPolicy: 'on-request' as const,
    activePermissionProfile: { id: 'web-workspace', extends: 'project-denials' },
    approvalsReviewer: 'guardian_subagent' as const,
  })
  const restored = restoreRuntimePermissionPolicy(response)!
  assert.deepEqual(restored.activePermissionProfile, { id: 'web-workspace', extends: 'project-denials' })
  assert.equal(restored.approvalsReviewer, 'guardian_subagent')
  assert.notEqual(restored.activePermissionProfile, response.activePermissionProfile)
  response.activePermissionProfile.extends = 'changed-after-response'
  assert.equal(restored.activePermissionProfile?.extends, 'project-denials')
  const copied = restoreRuntimePermissionPolicy({}, restored)!
  assert.deepEqual(copied, restored)
  assert.notEqual(copied.activePermissionProfile, restored.activePermissionProfile)
  const cleared = restoreRuntimePermissionPolicy({ activePermissionProfile: null, approvalsReviewer: 'user' }, restored)!
  assert.equal(cleared.activePermissionProfile, null)
  assert.equal(cleared.approvalsReviewer, 'user')
  // A fresh legacy projection does not prove that an earlier named profile is
  // still active, even when both project to the same broad sandbox type.
  assert.equal(restoreRuntimePermissionPolicy({ sandbox: response.sandbox }, restored)?.activePermissionProfile, undefined)
})

test('an acknowledged fork retains native grants instead of replaying its unchanged global defaults', () => {
  const preferences = { defaultPermission: 'danger-full-access', defaultPermissionExplicit: true }
  const sandbox: SandboxPolicy = { type: 'workspaceWrite', writableRoots: ['/project', '/approved/data'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
  const approvalPolicy = { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: true, mcp_elicitations: false } }
  const inheritance = captureForkPermissionInheritance({ sandbox, approvalPolicy,
    activePermissionProfile: { id: 'project-reviewed', extends: ':workspace' }, approvalsReviewer: 'auto_review' }, preferences)!
  const inherited = resolveForkPermissionInheritance(inheritance, preferences)
  assert.equal(inherited.selection, null)
  assert.deepEqual(resolveResumePermissionOverrides(inherited.selection), {})
  assert.deepEqual(inherited.inheritedPolicy, {
    sandboxPolicy: sandbox, approvalPolicy, source: 'native',
    activePermissionProfile: { id: 'project-reviewed', extends: ':workspace' }, approvalsReviewer: 'auto_review',
  })
  sandbox.writableRoots.length = 0
  assert.deepEqual((inherited.inheritedPolicy!.sandboxPolicy as Extract<SandboxPolicy, { type: 'workspaceWrite' }>).writableRoots, ['/project', '/approved/data'])
  assert.notEqual(inherited.inheritedPolicy, inheritance.policy)
  assert.notEqual(inherited.inheritedPolicy!.activePermissionProfile, inheritance.policy.activePermissionProfile)
})

test('pending source restrictions survive forking a running writer and deliberate child choices take precedence', () => {
  const preferences = { defaultPermission: 'danger-full-access', defaultPermissionExplicit: true }
  const pending = { mode: 'read-only' as const, profileId: '' }
  const inheritance = captureForkPermissionInheritance({ sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' }, preferences, pending)!
  const inherited = resolveForkPermissionInheritance(inheritance, preferences)
  assert.deepEqual(inherited.selection, pending)
  assert.equal(inherited.inheritedPolicy, null)
  assert.deepEqual(resolveResumePermissionOverrides(inherited.selection), { sandbox: 'read-only', approvalPolicy: 'on-request' })
  assert.notEqual(inherited.selection, inheritance.pendingSelection)
  assert.deepEqual(resolveForkPermissionInheritance(inheritance, preferences, { mode: 'workspace-write', profileId: '' }).selection,
    { mode: 'workspace-write', profileId: '' })
  assert.deepEqual(resolveForkPermissionInheritance(inheritance, { ...preferences, defaultPermission: 'workspace-write' }).selection,
    { mode: 'workspace-write', profileId: '' })
})

test('new global restrictions supersede fork inheritance without treating cosmetic profile edits as permission changes', () => {
  const selected = { id: 'project-default', name: 'Project', sandboxMode: 'workspace-write' as const, approvalPolicy: 'on-request' as const, networkAccess: false }
  const unrelated = { ...selected, id: 'other', name: 'Other' }
  const preferences = { defaultPermission: 'workspace-write', defaultPermissionExplicit: true, activePermissionProfileId: selected.id, permissionProfiles: [selected, unrelated] }
  const inheritance = captureForkPermissionInheritance({ sandbox: { type: 'workspaceWrite', writableRoots: ['/approved'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, approvalPolicy: 'untrusted' }, preferences)!
  assert.equal(resolveForkPermissionInheritance(inheritance, { ...preferences, permissionProfiles: [{ ...selected, name: 'Renamed' }, { ...unrelated, networkAccess: true }] }).selection, null)
  assert.equal(resolveForkPermissionInheritance(inheritance, { ...preferences, defaultPermission: 'danger-full-access' }).selection, null)
  const restricted = resolveForkPermissionInheritance(inheritance, { ...preferences, defaultPermission: 'read-only', activePermissionProfileId: '' })
  assert.deepEqual(restricted.selection, { mode: 'read-only', profileId: '' })
  assert.equal(restricted.inheritedPolicy, null)
  const changedProfile = resolveForkPermissionInheritance(inheritance, { ...preferences, permissionProfiles: [{ ...selected, approvalPolicy: 'untrusted' }] })
  assert.deepEqual(changedProfile.selection, { mode: 'workspace-write', profileId: selected.id })
  assert.equal(changedProfile.inheritedPolicy, null)
})

test('legacy fork responses without an effective policy retain explicit global safety settings', () => {
  const preferences = { defaultPermission: 'read-only', defaultPermissionExplicit: true }
  const inheritance = captureForkPermissionInheritance({}, preferences)
  assert.equal(inheritance, null)
  assert.deepEqual(resolveForkPermissionInheritance(inheritance, preferences), {
    selection: { mode: 'read-only', profileId: '' }, inheritedPolicy: null,
  })
  assert.deepEqual(resolveResumePermissionOverrides(resolveForkPermissionInheritance(inheritance, preferences).selection), {
    sandbox: 'read-only', approvalPolicy: 'on-request',
  })
})
