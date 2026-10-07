import type { Express } from 'express'
import { z } from 'zod'
import type { Bridge, BridgeOptions } from './bridge.js'
import type { Host } from './types.js'
import type { ThreadTokenUsage } from './context-types.js'
import { runHostPython } from './host-helper.js'

type Context = { tokenUsage: ThreadTokenUsage | null; compacting: boolean }
type Dependencies = {
  getHost: (id: string) => Host | undefined
  getBridge: (id: string) => Promise<Pick<Bridge, 'request' | 'threadContext'>>
  bridgeOptions?: BridgeOptions
  readRollout?: (host: Host, path: string) => Promise<ThreadTokenUsage | null>
}
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)

export function parseRolloutTokenUsage(value: unknown): ThreadTokenUsage | null {
  if (!value || typeof value !== 'object') return null
  const info = value as any
  const breakdown = (raw: any) => {
    if (!raw || typeof raw !== 'object') return null
    const fields = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'] as const
    const wire = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
    const result = {} as ThreadTokenUsage['last']
    for (let index = 0; index < fields.length; index++) {
      const count = raw[wire[index]!] ?? raw[fields[index]!] ?? (fields[index] === 'totalTokens' ? undefined : 0)
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null
      result[fields[index]!] = count
    }
    return result
  }
  const last = breakdown(info.last_token_usage ?? info.last)
  const total = breakdown(info.total_token_usage ?? info.total) ?? last
  const window = info.model_context_window ?? info.modelContextWindow ?? null
  if (!last || !total || window !== null && (typeof window !== 'number' || !Number.isSafeInteger(window) || window <= 0)) return null
  return { last, total, modelContextWindow: window }
}

/** Read a bounded tail, ignoring partial writes and returning only token counters. */
export function rolloutContextHelper(filename: string): string {
  if (!filename.startsWith('/') || !filename.endsWith('.jsonl') || filename.length > 4096 || /[\x00-\x1f\x7f]/.test(filename)) throw new Error('无效的 Codex 会话记录路径')
  const encoded = Buffer.from(filename).toString('base64')
  return `import base64,json,os,stat\nfilename=base64.b64decode('${encoded}').decode('utf-8')\n` + String.raw`
result=None
try:
    fd=os.open(filename,os.O_RDONLY|os.O_NONBLOCK|getattr(os,'O_NOFOLLOW',0))
    with os.fdopen(fd,'rb') as source:
        metadata=os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode): raise ValueError('Not a regular rollout')
        start=max(0,metadata.st_size-8*1024*1024)
        source.seek(start)
        lines=source.read(8*1024*1024).splitlines()
        if start and lines: lines=lines[1:]
        for line in reversed(lines):
            try:
                record=json.loads(line)
                event=record.get('payload',{})
                if record.get('type')=='event_msg' and event.get('type')=='token_count' and isinstance(event.get('info'),dict):
                    info=event['info']
                    last=info.get('last_token_usage')
                    if not isinstance(last,dict): continue
                    count=last.get('total_tokens')
                    if type(count) is not int or not 0<=count<=9007199254740991: continue
                    # Do not expose unrelated event text, rate limits, paths or credentials.
                    if result is None:
                        result={key:info.get(key) for key in ['last_token_usage','total_token_usage','model_context_window']}
                    window=info.get('model_context_window')
                    if type(window) is int and 0<window<=9007199254740991:
                        result['model_context_window']=window
                        break
            except (ValueError,TypeError,AttributeError): pass
except (OSError,ValueError): pass
print(json.dumps(result,allow_nan=False,separators=(',',':')))
`
}

export function registerThreadContext(app: Express, deps: Dependencies) {
  const fallback = new Map<string, { expiresAt: number; value: ThreadTokenUsage | null }>()
  const pending = new Map<string, Promise<ThreadTokenUsage | null>>()
  app.get('/api/hosts/:hostId/threads/:threadId/context', (req, res, next) => {
    void (async () => {
      const hostId = identifier.parse(req.params.hostId)
      const threadId = identifier.parse(req.params.threadId)
      const host = deps.getHost(hostId)
      if (!host) throw Object.assign(new Error('主机不存在'), { status: 404 })
      const bridge = await deps.getBridge(hostId)
      const context = bridge.threadContext(threadId)
      if (context.tokenUsage?.modelContextWindow) { res.json(context); return }
      const key = JSON.stringify([hostId, threadId])
      let value = fallback.get(key)
      if (!value || value.expiresAt <= Date.now()) {
        let read = pending.get(key)
        if (!read) {
          read = (async () => {
            const result = await bridge.request('thread/read', { threadId, includeTurns: false }, 10000) as { thread?: { id?: string; path?: string | null } }
            if (result.thread?.id !== threadId) throw Object.assign(new Error('会话不存在'), { status: 404 })
            if (!result.thread.path) return null
            return deps.readRollout ? deps.readRollout(host, result.thread.path)
              : parseRolloutTokenUsage(JSON.parse(await runHostPython(host, rolloutContextHelper(result.thread.path), deps.bridgeOptions)))
          })().finally(() => { pending.delete(key) })
          pending.set(key, read)
        }
        const tokenUsage = await read
        value = { expiresAt: Date.now() + 5000, value: tokenUsage }
        fallback.set(key, value)
        if (fallback.size > 500) fallback.delete(fallback.keys().next().value!)
      }
      const latest = bridge.threadContext(threadId)
      const tokenUsage = latest.tokenUsage ? { ...latest.tokenUsage, modelContextWindow: latest.tokenUsage.modelContextWindow ?? value.value?.modelContextWindow ?? null } : value.value
      res.json({ tokenUsage, compacting: latest.compacting } satisfies Context)
    })().catch(next)
  })
}
