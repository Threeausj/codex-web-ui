export type MethodCapability = { available: boolean; params: string[]; required: string[] }
export type IntegrationCapabilities = { status: 'known' | 'unknown'; checkedAt: number; methods: Record<string, MethodCapability>; checkedCliVersion?: string; reason?: string }
export function methodAccepts(capabilities: IntegrationCapabilities | null, method: string, provided: string[]) {
  const definition = capabilities?.status === 'known' && capabilities.methods?.[method]
  return !!definition && definition.available === true && Array.isArray(definition.params) && Array.isArray(definition.required)
    && provided.every(field => definition.params.includes(field)) && definition.required.every(field => provided.includes(field))
}
export function safeAuthorizationUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return ''
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash || url.protocol !== 'https:') return ''
    return url.href
  } catch { return '' }
}
export function mcpRuntimeLabel(value: unknown) {
  return ({ notStarted: '未启动', starting: '正在连接', connected: '已连接', authenticationRequired: '需要登录', failed: '连接失败', cancelled: '已取消', disabled: '已禁用' } as Record<string, string>)[String(value)] || '状态未报告'
}
export function mcpAuthLabel(value: unknown) {
  return ({ unknown: '登录状态未知', unsupported: '无需 OAuth', notLoggedIn: '未登录', bearerToken: '使用主机令牌', oAuth: 'OAuth 已登录' } as Record<string, string>)[String(value)] || '登录状态未报告'
}
