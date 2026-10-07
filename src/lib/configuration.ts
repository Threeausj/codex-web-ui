import type { ConfigLayerSource } from '../../shared/protocol/v2/ConfigLayerSource'
import type { ConfigReadResponse } from '../../shared/protocol/v2/ConfigReadResponse'
import type { ConfigRequirements } from '../../shared/protocol/v2/ConfigRequirements'
import type { SandboxMode } from '../../shared/protocol/v2/SandboxMode'
import type { SandboxPolicy } from '../../shared/protocol/v2/SandboxPolicy'

export type WebApprovalPolicy = 'untrusted' | 'on-request' | 'never'
/** Web presets resolve to documented per-thread/per-turn fields, not native profile ids. */
export interface WebPermissionProfile {
  id: string
  name: string
  sandboxMode: SandboxMode
  approvalPolicy: WebApprovalPolicy
  networkAccess: boolean
}

export const DEFAULT_PERMISSION_PROFILES: WebPermissionProfile[] = [
  { id: 'web-read-only', name: '只读分析', sandboxMode: 'read-only', approvalPolicy: 'on-request', networkAccess: false },
  { id: 'web-workspace', name: '工作区开发', sandboxMode: 'workspace-write', approvalPolicy: 'on-request', networkAccess: false },
  { id: 'web-full-access', name: '完全访问', sandboxMode: 'danger-full-access', approvalPolicy: 'never', networkAccess: true },
]

const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access']
const approvalPolicies = ['untrusted', 'on-request', 'never']

export function validatePermissionProfile(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['权限预设须为对象']
  const profile = value as Record<string, unknown>
  const errors: string[] = []
  if (typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.id)) errors.push('预设标识只能包含字母、数字、下划线和连字符')
  if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.trim().length > 60) errors.push('名称须为 1–60 个字符')
  if (!sandboxModes.includes(String(profile.sandboxMode))) errors.push('请选择受支持的沙箱权限')
  if (!approvalPolicies.includes(String(profile.approvalPolicy))) errors.push('请选择受支持的审批策略')
  if (typeof profile.networkAccess !== 'boolean') errors.push('网络访问须为布尔值')
  if (profile.sandboxMode === 'danger-full-access' && profile.networkAccess !== true) errors.push('完全访问模式不限制网络，不能声明禁用网络')
  return errors
}

export function availablePermissionProfiles(saved?: unknown): WebPermissionProfile[] {
  if (!Array.isArray(saved)) return DEFAULT_PERMISSION_PROFILES.map(profile => ({ ...profile }))
  const seen = new Set<string>()
  return saved.filter((value): value is WebPermissionProfile => {
    if (validatePermissionProfile(value).length || seen.has(value.id)) return false
    seen.add(value.id)
    return true
  }).map(profile => ({ ...profile }))
}

export function permissionProfileProblems(profile: WebPermissionProfile, requirements?: ConfigRequirements | null): string[] {
  const errors = validatePermissionProfile(profile)
  if (requirements?.allowedSandboxModes && !requirements.allowedSandboxModes.includes(profile.sandboxMode)) errors.push('当前主机的管理策略不允许此沙箱权限')
  if (requirements?.allowedApprovalPolicies && !requirements.allowedApprovalPolicies.some(policy => policy === profile.approvalPolicy)) errors.push('当前主机的管理策略不允许此审批策略')
  return errors
}

export function resolvePermissionProfile(profile: WebPermissionProfile, context: { cwd?: string; requirements?: ConfigRequirements | null } = {}): {
  sandbox: SandboxMode
  approvalPolicy: WebApprovalPolicy
  sandboxPolicy: SandboxPolicy
} {
  const errors = permissionProfileProblems(profile, context.requirements)
  if (errors.length) throw new Error(errors.join('；'))
  let sandboxPolicy: SandboxPolicy
  if (profile.sandboxMode === 'read-only') sandboxPolicy = { type: 'readOnly', networkAccess: profile.networkAccess }
  else if (profile.sandboxMode === 'danger-full-access') sandboxPolicy = { type: 'dangerFullAccess' }
  else {
    const cwd = context.cwd
    if (cwd && !/^(\/|[a-zA-Z]:[\\/])/.test(cwd)) throw new Error('工作区路径须为绝对路径')
    sandboxPolicy = { type: 'workspaceWrite', writableRoots: cwd ? [cwd] : [], networkAccess: profile.networkAccess, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }
  return { sandbox: profile.sandboxMode, approvalPolicy: profile.approvalPolicy, sandboxPolicy }
}

/** Bare Web modes are explicit choices; a desktop thread's saved approvals do not override them. */
export function resolveWebPermissionSelection(mode: SandboxMode, context: {
  profile?: WebPermissionProfile | null
  cwd?: string
  requirements?: ConfigRequirements | null
} = {}): ReturnType<typeof resolvePermissionProfile> {
  const profile = context.profile?.sandboxMode === mode ? context.profile : {
    id: 'web-selection', name: '网页权限', sandboxMode: mode,
    approvalPolicy: mode === 'danger-full-access' ? 'never' as const : 'on-request' as const,
    networkAccess: mode === 'danger-full-access',
  }
  return resolvePermissionProfile(profile, context)
}

export function configLayerLabel(source: ConfigLayerSource): string {
  switch (source.type) {
    case 'packagedDefaults': return `内置默认 · ${source.file}`
    case 'mdm': return `设备管理 · ${source.domain}/${source.key}`
    case 'system': return `系统 · ${source.file}`
    case 'enterpriseManaged': return `企业管理 · ${source.name || source.id}`
    case 'user': return `用户${source.profile ? ` / ${source.profile}` : ''} · ${source.file}`
    case 'project': return `项目 · ${source.dotCodexFolder}`
    case 'sessionFlags': return '启动参数'
    case 'legacyManagedConfigTomlFromFile': return `管理配置 · ${source.file}`
    case 'legacyManagedConfigTomlFromMdm': return '设备管理配置'
  }
}

export function isManagedConfigSource(source: ConfigLayerSource): boolean {
  return ['mdm', 'enterpriseManaged', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm'].includes(source.type)
}

/** A disabled layer is not an effective managed origin and must not block an unrelated user edit. */
export function configEditRestriction(keyPath: string, value: unknown, snapshot: Pick<ConfigReadResponse, 'origins'> | null | undefined, requirements?: ConfigRequirements | null): string | null {
  const originKey = Object.keys(snapshot?.origins || {}).filter(key => keyPath === key || keyPath.startsWith(`${key}.`)).sort((a, b) => b.length - a.length)[0]
  const origin = originKey ? snapshot?.origins[originKey] : undefined
  if (origin && isManagedConfigSource(origin.name)) return `${keyPath} 来自${configLayerLabel(origin.name)}，请联系管理员修改`
  const managedDescendant = Object.entries(snapshot?.origins || {}).find(([key, metadata]) => key.startsWith(`${keyPath}.`) && metadata && isManagedConfigSource(metadata.name))
  if (managedDescendant) return `${keyPath} 包含管理员维护的 ${managedDescendant[0]}，请分别修改可写配置项`
  if (!requirements) return null
  if (keyPath === 'model_provider' && requirements.modelProvider !== null && requirements.modelProvider !== undefined && value !== requirements.modelProvider) return `管理策略固定模型提供方为 ${requirements.modelProvider}`
  if ((keyPath === 'model_providers' || keyPath.startsWith('model_providers.')) && requirements.modelProviders != null) return '模型提供方定义由管理策略控制'
  if (keyPath === 'sandbox_mode' && requirements.allowedSandboxModes && !requirements.allowedSandboxModes.includes(value as SandboxMode)) return '管理策略不允许此沙箱权限'
  if (keyPath === 'approval_policy' && requirements.allowedApprovalPolicies && !requirements.allowedApprovalPolicies.some(policy => JSON.stringify(policy) === JSON.stringify(value))) return '管理策略不允许此审批策略'
  if (keyPath === 'permissions' && typeof value === 'string' && requirements.allowedPermissionProfiles && requirements.allowedPermissionProfiles[value] === false) return '管理策略不允许此原生权限预设'
  return null
}

export function describeApprovalPolicy(policy: WebApprovalPolicy): string {
  return { 'untrusted': '不可信命令先审批', 'on-request': '由 Codex 请求审批', 'never': '不询问审批' }[policy]
}

export function describeSandboxMode(mode: SandboxMode): string {
  return { 'read-only': '只读', 'workspace-write': '工作区写入', 'danger-full-access': '完全访问' }[mode]
}
