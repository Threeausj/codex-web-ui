import type { AskForApproval } from '../../shared/protocol/v2/AskForApproval'
import type { JsonValue } from '../../shared/protocol/serde_json/JsonValue'
import type { ConfigRequirements } from '../../shared/protocol/v2/ConfigRequirements'
import type { SandboxMode } from '../../shared/protocol/v2/SandboxMode'
import type { SandboxPolicy } from '../../shared/protocol/v2/SandboxPolicy'
import type { ActivePermissionProfile } from '../../shared/protocol/v2/ActivePermissionProfile'
import type { ApprovalsReviewer } from '../../shared/protocol/v2/ApprovalsReviewer'
import { availablePermissionProfiles, resolveWebPermissionSelection, type WebPermissionProfile } from './configuration'

type PermissionPreferences = {
  defaultPermission?: string
  defaultPermissionExplicit?: boolean
  activePermissionProfileId?: string
  permissionProfiles?: unknown
}
export type ExplicitWebPermissionSelection = { mode: SandboxMode; profileId: string }
export type RuntimePermissionPolicy = {
  sandboxPolicy: SandboxPolicy
  approvalPolicy: AskForApproval
  source?: 'native' | 'web'
  // Native profile provenance is separate from user-created Web presets. The
  // legacy sandbox projection cannot represent every saved grant or denial.
  activePermissionProfile?: ActivePermissionProfile | null
  approvalsReviewer?: ApprovalsReviewer | null
}
export type RuntimePermissionResponse = {
  sandbox?: SandboxPolicy | null
  approvalPolicy?: AskForApproval | null
  activePermissionProfile?: ActivePermissionProfile | null
  approvalsReviewer?: ApprovalsReviewer | null
}
export type ForkPermissionInheritance = {
  policy: RuntimePermissionPolicy
  defaultsFingerprint: string
  pendingSelection: ExplicitWebPermissionSelection | null
}

// These are JSON protocol fields. Existing UI policies can be Vue proxies;
// structuredClone rejects them when a read-only refresh reuses the same writer.
const copyPolicy = (policy: RuntimePermissionPolicy): RuntimePermissionPolicy => JSON.parse(JSON.stringify(policy))

/** A built-in UI fallback is not a user override of the native thread's permissions. */
export function explicitWebPermissionSelection(
  preferences: PermissionPreferences,
  selected?: { mode: string; profileId: string } | null,
): ExplicitWebPermissionSelection | null {
  const profileId = selected?.profileId ?? preferences.activePermissionProfileId ?? ''
  const profile = availablePermissionProfiles(preferences.permissionProfiles).find(entry => entry.id === profileId)
  const explicitDefault = preferences.defaultPermissionExplicit === true ||
    // An older server has no provenance flag: retain its existing Web semantics.
    preferences.defaultPermissionExplicit === undefined && preferences.defaultPermission !== undefined
  if (!selected && !profile && !explicitDefault) return null
  const mode = profile?.sandboxMode ?? selected?.mode ?? preferences.defaultPermission ?? 'workspace-write'
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw new Error('网页权限选择无效，请重新选择权限')
  return { mode: mode as SandboxMode, profileId: profile?.id ?? '' }
}

/** Omission preserves native saved permissions and acknowledged session grants. */
export function resolveResumePermissionOverrides(
  selection: ExplicitWebPermissionSelection | null,
  context: { profile?: WebPermissionProfile | null; cwd?: string; requirements?: ConfigRequirements | null } = {},
): { sandbox?: SandboxMode; approvalPolicy?: AskForApproval; config?: Record<string, JsonValue> } {
  if (!selection) return {}
  const resolved = resolveWebPermissionSelection(selection.mode, context)
  const policy = resolved.sandboxPolicy
  return {
    sandbox: resolved.sandbox,
    approvalPolicy: resolved.approvalPolicy,
    ...(policy.type === 'workspaceWrite' ? { config: { sandbox_workspace_write: {
      writable_roots: policy.writableRoots,
      network_access: policy.networkAccess,
      exclude_tmpdir_env_var: policy.excludeTmpdirEnvVar,
      exclude_slash_tmp: policy.excludeSlashTmp,
    } } } : {}),
  }
}

/** Preserve native grants as an isolated policy, including granular approval settings. */
export function restoreRuntimePermissionPolicy(
  response: RuntimePermissionResponse,
  fallback?: RuntimePermissionPolicy | null,
): RuntimePermissionPolicy | null {
  const provenance = {
    ...(Object.hasOwn(response, 'activePermissionProfile') ? { activePermissionProfile: response.activePermissionProfile } : {}),
    ...(Object.hasOwn(response, 'approvalsReviewer') ? { approvalsReviewer: response.approvalsReviewer } : {}),
  }
  if (!response.sandbox?.type) return fallback ? copyPolicy({ ...fallback, ...provenance }) : null
  const sandbox = response.sandbox
  // Legacy servers may omit fields on the built-in policies. Filling only
  // conservative defaults avoids synthesizing network or filesystem grants.
  let policy: SandboxPolicy
  if (sandbox.type === 'workspaceWrite') policy = {
    ...sandbox,
    writableRoots: sandbox.writableRoots ?? [], networkAccess: sandbox.networkAccess ?? false,
    excludeTmpdirEnvVar: sandbox.excludeTmpdirEnvVar ?? false, excludeSlashTmp: sandbox.excludeSlashTmp ?? false,
  }
  else if (sandbox.type === 'readOnly') policy = { ...sandbox, networkAccess: sandbox.networkAccess ?? false }
  else policy = sandbox
  return copyPolicy({
    sandboxPolicy: policy,
    approvalPolicy: response.approvalPolicy ??
      (fallback?.sandboxPolicy.type === sandbox.type ? fallback.approvalPolicy : null) ?? 'on-request',
    ...provenance,
  })
}

/** Only permission defaults that can affect a resume invalidate a fork's native
 * policy. Cosmetic profile edits and unrelated settings keep inherited grants. */
export function permissionDefaultsFingerprint(preferences: PermissionPreferences) {
  const profile = availablePermissionProfiles(preferences.permissionProfiles)
    .find(entry => entry.id === preferences.activePermissionProfileId)
  const explicitDefault = preferences.defaultPermissionExplicit === true ||
    preferences.defaultPermissionExplicit === undefined && preferences.defaultPermission !== undefined
  return JSON.stringify([
    !profile && explicitDefault ? preferences.defaultPermission ?? 'workspace-write' : null,
    profile ? [profile.id, profile.sandboxMode, profile.approvalPolicy, profile.networkAccess] : null,
  ])
}

/** A successful native fork is authoritative for the child's saved permissions.
 * Do not replay a global new-chat default immediately over that acknowledgement. */
export function captureForkPermissionInheritance(
  response: RuntimePermissionResponse,
  preferences: PermissionPreferences,
  pendingSourceSelection?: ExplicitWebPermissionSelection | null,
): ForkPermissionInheritance | null {
  const policy = restoreRuntimePermissionPolicy(response)
  if (!policy) return null
  return {
    policy: { ...policy, source: 'native' },
    defaultsFingerprint: permissionDefaultsFingerprint(preferences),
    pendingSelection: pendingSourceSelection ? { ...pendingSourceSelection } : null,
  }
}

/** A deliberate child choice or a later change to global defaults takes
 * precedence. A source choice not yet accepted by native must also survive a
 * fork, so snapshotting a running writer cannot broaden its intended policy. */
export function resolveForkPermissionInheritance(
  inheritance: ForkPermissionInheritance | null | undefined,
  preferences: PermissionPreferences,
  childSelection?: { mode: string; profileId: string } | null,
): { selection: ExplicitWebPermissionSelection | null; inheritedPolicy: RuntimePermissionPolicy | null } {
  if (childSelection || !inheritance || inheritance.defaultsFingerprint !== permissionDefaultsFingerprint(preferences))
    return { selection: explicitWebPermissionSelection(preferences, childSelection), inheritedPolicy: null }
  if (inheritance.pendingSelection)
    return { selection: { ...inheritance.pendingSelection }, inheritedPolicy: null }
  return { selection: null, inheritedPolicy: copyPolicy(inheritance.policy) }
}
