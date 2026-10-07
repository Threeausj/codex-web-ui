import type { BridgeOptions } from './bridge.js'
import { runHostPython } from './host-helper.js'
import type { Host } from './types.js'

export const nativeMethods = [
  'thread/queue/add', 'thread/queue/list', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/reorder', 'thread/queue/start',
  'skills/config/write', 'mcpServer/oauth/login', 'config/mcpServer/reload', 'mcpServerStatus/list',
  'thread/start', 'turn/start', 'thread/settings/update',
] as const
export type NativeMethod = typeof nativeMethods[number]
export type NativeMethodCapability = { available: boolean; params: string[]; required: string[] }
export type NativeCapabilities = { status: 'known' | 'unknown'; checkedAt: number; methods: Partial<Record<NativeMethod, NativeMethodCapability>>; checkedCliVersion?: string; reason?: 'proxy_runtime' | 'runtime_version_unknown' | 'runtime_version_mismatch' | 'schema_unavailable' }
export type NativeIdentity = { engineId?: string | null; userAgent?: string | null; connectionMode?: string }
export type NativeCapabilitiesOptions = { bridgeOptions?: BridgeOptions; now?: () => number; collect?: (host: Host) => Promise<unknown> }

function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/
export function nativeRuntimeVersion(userAgent?: string | null) {
  return typeof userAgent === 'string' ? /^[A-Za-z0-9_.-]+\/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/.exec(userAgent)?.[1] : undefined
}
/** All discovery output is protocol metadata, never raw config/schema/credentials. */
export function parseNativeCapabilities(raw: unknown, checkedAt: number): NativeCapabilities {
  const input = object(raw)
  if (input?.status !== 'known' || !object(input.methods)) return { status: 'unknown', checkedAt, methods: {} }
  const methods: NativeCapabilities['methods'] = {}
  for (const method of nativeMethods) {
    const candidate = object(object(input.methods)?.[method])
    if (!candidate || typeof candidate.available !== 'boolean' || !Array.isArray(candidate.params) || !Array.isArray(candidate.required)) return { status: 'unknown', checkedAt, methods: {} }
    const fields = (values: unknown[]) => values.length <= 128 && values.every(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value))
    if (!fields(candidate.params) || !fields(candidate.required)) return { status: 'unknown', checkedAt, methods: {} }
    methods[method] = { available: candidate.available, params: [...new Set(candidate.params as string[])].sort(), required: [...new Set(candidate.required as string[])].sort() }
  }
  return { status: 'known', checkedAt, methods, ...(typeof input.checkedCliVersion === 'string' && input.checkedCliVersion.length <= 60 && versionPattern.test(input.checkedCliVersion) ? { checkedCliVersion: input.checkedCliVersion } : {}) }
}

/** CLI code generation uses an isolated temporary home and never starts app-server. */
export function nativeCapabilitiesReader(host: Host, options: BridgeOptions = {}) {
  const config = JSON.stringify({ executable: host.kind === 'ssh' ? host.codexPath?.trim() || 'codex' : options.codexBin || 'codex', remote: host.kind === 'ssh', methods: nativeMethods })
  return String.raw`
import json,os,pathlib,re,shlex,subprocess,tempfile
config=json.loads(${JSON.stringify(config)})
result={'status':'unknown','methods':{}}
try:
    with tempfile.TemporaryDirectory(prefix='codex-web-schema-') as directory:
        root=pathlib.Path(directory); home=root/'home'; home.mkdir(mode=0o700)
        env=dict(os.environ); env['CODEX_HOME']=str(home)
        def command(arguments):
            args=[config['executable']]+arguments
            if config['remote']:
                # Reapply the temporary home after login profiles, which may
                # export their own CODEX_HOME. Profiles supply only CLI PATH.
                launcher='cd '+shlex.quote(directory)+' && exec '+ ' '.join(shlex.quote(arg) for arg in ['/usr/bin/env','CODEX_HOME='+str(home)]+args)
                args=[env.get('SHELL') or '/bin/sh','-ilc',launcher]
            return args
        version_file=root/'version.txt'
        with version_file.open('w') as output:
            version_process=subprocess.run(command(['--version']),cwd=directory,env=env,stdout=output,stderr=subprocess.DEVNULL,timeout=3)
        if version_process.returncode or version_file.stat().st_size>16384: raise ValueError('Unknown CLI version')
        match=re.search(r'^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\s*$',version_file.read_text(),re.M)
        if not match: raise ValueError('Unknown CLI version')
        cli_version=match.group(1)
        args=command(['app-server','generate-json-schema','--experimental','--out',str(root/'schema')])
        process=subprocess.run(args,cwd=directory,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=12)
        target=root/'schema'/'ClientRequest.json'
        if process.returncode==0 and target.is_file() and target.stat().st_size<=16*1024*1024:
            schema=json.loads(target.read_text()); definitions=schema.get('definitions',schema.get('$defs',{}))
            methods={name:{'available':False,'params':[],'required':[]} for name in config['methods']}
            def resolve(value):
                seen=set()
                while isinstance(value,dict) and '$ref' in value:
                    ref=value['$ref']
                    if ref in seen or not ref.startswith(('#/definitions/','#/$defs/')): return None
                    seen.add(ref); value=definitions.get(ref.split('/')[-1])
                return value
            entries=schema.get('oneOf')
            if not isinstance(entries,list) or not entries: raise ValueError('Unknown request schema')
            for entry in entries:
                entry=resolve(entry)
                if not isinstance(entry,dict): continue
                properties=entry.get('properties',{}); selector=resolve(properties.get('method',{}))
                names=selector.get('enum',[selector.get('const')]) if isinstance(selector,dict) else []
                for name in names:
                    if name not in methods: continue
                    params=resolve(properties.get('params',{}))
                    if not isinstance(params,dict): raise ValueError('Unknown params schema')
                    if params.get('type')=='null' or 'params' not in properties:
                        methods[name]={'available':True,'params':[],'required':[]}
                    elif isinstance(params.get('properties'),dict) and params.get('type')=='object':
                        methods[name]={'available':True,'params':list(params['properties']),'required':params.get('required',[])}
                    else: raise ValueError('Unknown params schema')
            result={'status':'known','methods':methods,'checkedCliVersion':cli_version}
except (OSError,ValueError,TypeError,subprocess.SubprocessError): pass
print(json.dumps(result))
`
}

export class NativeCapabilitiesService {
  private cache = new Map<string, { identity: string; at: number; value?: NativeCapabilities; pending?: Promise<NativeCapabilities> }>()
  private readonly now: () => number
  constructor(private readonly options: NativeCapabilitiesOptions = {}) { this.now = options.now || Date.now }
  read(host: Host, native: NativeIdentity = {}): Promise<NativeCapabilities> {
    if (native.connectionMode === 'proxy' || this.options.bridgeOptions?.mode === 'proxy') return Promise.resolve({ status: 'unknown', checkedAt: this.now(), methods: {}, reason: 'proxy_runtime' })
    const runtimeVersion = nativeRuntimeVersion(native.userAgent)
    if (!runtimeVersion) return Promise.resolve({ status: 'unknown', checkedAt: this.now(), methods: {}, reason: 'runtime_version_unknown' })
    const identity = JSON.stringify([native.engineId, native.userAgent, native.connectionMode, host.kind, host.codexPath, this.options.bridgeOptions?.codexBin])
    const previous = this.cache.get(host.id)
    if (previous?.identity === identity) {
      if (previous.pending) return previous.pending.then(value => structuredClone(value))
      if (previous.value && this.now() - previous.at < (previous.value.status === 'known' ? 5 * 60 * 1000 : 15000)) return Promise.resolve(structuredClone(previous.value))
    }
    const entry: { identity: string; at: number; value?: NativeCapabilities; pending?: Promise<NativeCapabilities> } = { identity, at: this.now() }
    this.cache.delete(host.id); this.cache.set(host.id, entry)
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!)
    entry.pending = (async () => {
      let value: NativeCapabilities
      try {
        const raw = this.options.collect ? await this.options.collect(host) : JSON.parse(await runHostPython(host, nativeCapabilitiesReader(host, this.options.bridgeOptions), this.options.bridgeOptions, { timeoutMs: 16000, maxOutputBytes: 32768 }))
        value = parseNativeCapabilities(raw, this.now())
        if (value.status === 'known' && value.checkedCliVersion !== runtimeVersion) value = { status: 'unknown', checkedAt: this.now(), methods: {}, ...(value.checkedCliVersion ? { checkedCliVersion: value.checkedCliVersion } : {}), reason: value.checkedCliVersion ? 'runtime_version_mismatch' : 'runtime_version_unknown' }
        else if (value.status === 'unknown') value.reason = 'schema_unavailable'
      } catch { value = { status: 'unknown', checkedAt: this.now(), methods: {}, reason: 'schema_unavailable' } }
      entry.value = value; entry.at = this.now(); entry.pending = undefined
      return structuredClone(value)
    })()
    return entry.pending
  }
}
