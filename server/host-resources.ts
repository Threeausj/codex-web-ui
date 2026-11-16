import fs from 'node:fs/promises'
import path from 'node:path'
import type { Express } from 'express'
import { z } from 'zod'
import { Bridge, type ReleasedThread, type BridgeOptions } from './bridge.js'
import { sshKnownHostsArgs, sshPythonArgs, type SSHConnectionControl } from './ssh.js'
import { runHostPython } from './host-helper.js'
import { hostConnectionMode } from './connection-mode.js'
import { restartCodexDaemon } from './daemon.js'
import { writePrivateJson } from './storage.js'
import type { Host } from './types.js'

export type GpuProcess = { gpuIndex: number | null; gpuUuid: string; pid: number; name: string; user: string | null; memoryUsedBytes: number | null; elapsedSeconds: number | null; command: string | null }
export type GpuResources = { available: boolean; reason?: string; processes?: GpuProcess[]; processReason?: string; processesTruncated?: boolean; devices: { index: number; name: string; utilizationPercent: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; temperatureC: number | null; powerWatts: number | null }[] }
export type RawHostResources = {
  sampledAt: number; scope: 'host' | 'container'; cpu: { total: number | null; idle: number | null; load: number[]; cores: number | null }
  memory: { usedBytes: number | null; totalBytes: number | null }; network: { rxBytes: number | null; txBytes: number | null; interfaces: string[] }
  disk: { readBytes: number | null; writeBytes: number | null }; gpus: GpuResources
}
export type HostResources = {
  hostId: string; sampledAt: number; scope: 'host' | 'container'
  cpu: { usagePercent: number | null; load: number[]; cores: number | null }
  memory: { usedBytes: number | null; totalBytes: number | null; usagePercent: number | null }
  network: { rxBytesPerSecond: number | null; txBytesPerSecond: number | null; interfaces: string[] }
  disk: { readBytesPerSecond: number | null; writeBytesPerSecond: number | null }; gpus: GpuResources
  runtime: Bridge['runtime']
}

/** Fixed, read-only Linux counters. GPU failure is isolated from CPU/RAM/I/O. */
export const HOST_RESOURCE_HELPER = String.raw`
import csv,io,json,os,pathlib,shutil,subprocess,time
P=pathlib.Path('/proc')
def read(name):
    try: return (P/name).read_text()
    except (OSError,ValueError): return ''
cpu={'total':None,'idle':None,'load':[],'cores':os.cpu_count()}
try:
    values=[int(x) for x in read('stat').splitlines()[0].split()[1:9]]
    cpu.update(total=sum(values),idle=values[3]+values[4])
except (ValueError,IndexError): pass
try: cpu['load']=[float(x) for x in read('loadavg').split()[:3]]
except ValueError: pass
memory={'usedBytes':None,'totalBytes':None}
try:
    entries={line.split(':',1)[0]:int(line.split()[1])*1024 for line in read('meminfo').splitlines() if ':' in line}
    total=entries['MemTotal']; available=entries.get('MemAvailable')
    if available is None: available=sum(entries.get(key,0) for key in ['MemFree','Buffers','Cached'])
    memory.update(totalBytes=total,usedBytes=max(0,total-available))
except (ValueError,KeyError,IndexError): pass
network={'rxBytes':None,'txBytes':None,'interfaces':[]}
try:
    interfaces=[]
    for line in read('net/dev').splitlines()[2:]:
        name,data=line.split(':',1); name=name.strip(); fields=data.split()
        if name=='lo' or name.startswith(('veth','docker','br-','virbr')): continue
        interfaces.append((name,int(fields[0]),int(fields[8])))
    if interfaces:
        network={'rxBytes':sum(x[1] for x in interfaces),'txBytes':sum(x[2] for x in interfaces),'interfaces':[x[0] for x in interfaces]}
except (ValueError,IndexError): pass
disk={'readBytes':None,'writeBytes':None}
try:
    counters=[]
    for line in read('diskstats').splitlines():
        f=line.split(); name=f[2]
        # Partitions and device-mapper duplicate their underlying physical I/O.
        if (pathlib.Path('/sys/block')/name).exists() and not name.startswith(('loop','ram','dm-','md')):
            counters.append((int(f[5])*512,int(f[9])*512))
    if counters: disk={'readBytes':sum(x[0] for x in counters),'writeBytes':sum(x[1] for x in counters)}
except (ValueError,IndexError): pass
gpus={'available':False,'reason':'未检测到 NVIDIA 显卡或 nvidia-smi；其他显卡暂不支持','devices':[]}
def number(value):
    try:
        result=float(value.strip()); return result if result>=0 and result<float('inf') else None
    except ValueError: return None
if shutil.which('nvidia-smi'):
    try:
        result=subprocess.run(['nvidia-smi','--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=2)
        if result.returncode: gpus['reason']='NVIDIA 驱动不可用或当前用户无读取权限'
        elif len(result.stdout)>32768: gpus['reason']='显卡返回数据超出限制'
        else:
            devices=[]
            for row in csv.reader(io.StringIO(result.stdout)):
                if len(row)!=7: raise ValueError('Invalid GPU row')
                index=number(row[0])
                if index is None or int(index)!=index: raise ValueError('Invalid GPU index')
                used=number(row[3]); total=number(row[4])
                devices.append({'index':int(index),'name':row[1].strip()[:200],'utilizationPercent':number(row[2]),'memoryUsedBytes':None if used is None else used*1048576,'memoryTotalBytes':None if total is None else total*1048576,'temperatureC':number(row[5]),'powerWatts':number(row[6])})
                if len(devices)>64: raise ValueError('Too many GPUs')
            if devices: gpus={'available':True,'devices':devices}
            else: gpus['reason']='未检测到可读取的 NVIDIA 显卡'
    except subprocess.TimeoutExpired: gpus['reason']='显卡状态读取超时'
    except (OSError,ValueError,csv.Error): gpus['reason']='显卡状态返回格式不可识别'
# A process query is independent from board telemetry: an old driver or
# inaccessible /proc must never hide otherwise valid GPU utilization.
if gpus['available']:
    gpus['processes']=[]
    try:
        import pwd
        def text_limit(value,limit): return value.encode('utf-16-le','surrogatepass')[:limit*2].decode('utf-16-le','ignore')
        mapping={}
        index_result=subprocess.run(['nvidia-smi','--query-gpu=uuid,index','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=1.5)
        if index_result.returncode==0 and len(index_result.stdout)<=32768:
            for row in csv.reader(io.StringIO(index_result.stdout)):
                if len(row)==2 and row[1].strip().isdigit(): mapping[row[0].strip()]=int(row[1])
        processes=subprocess.run(['nvidia-smi','--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=1.5)
        if processes.returncode: gpus['processReason']='驱动不支持进程查询或当前用户无读取权限'
        elif len(processes.stdout)>262144: gpus['processReason']='GPU 进程列表超出读取上限'
        else:
            boot=None
            try: boot=int(next(line.split()[1] for line in read('stat').splitlines() if line.startswith('btime ')))
            except (ValueError,IndexError,StopIteration): pass
            clock=float(os.sysconf('SC_CLK_TCK'))
            seen=set()
            for row in csv.reader(io.StringIO(processes.stdout)):
                if len(row)!=4 or not row[1].strip().isdigit(): raise ValueError('Invalid GPU process')
                gpu=text_limit(row[0].strip(),120); pid=int(row[1].strip())
                if pid<=0 or (gpu,pid) in seen: continue
                seen.add((gpu,pid))
                if len(gpus['processes'])>=128:
                    gpus['processesTruncated']=True; break
                process={'gpuIndex':mapping.get(gpu),'gpuUuid':gpu,'pid':pid,'name':text_limit(row[2].strip(),256),'user':None,'memoryUsedBytes':None,'elapsedSeconds':None,'command':None}
                used=number(row[3]); process['memoryUsedBytes']=None if used is None else used*1048576
                proc=P/str(pid)
                try:
                    uid=proc.stat().st_uid
                    try: process['user']=text_limit(pwd.getpwuid(uid).pw_name,100)
                    except KeyError: process['user']=str(uid)
                    with proc.joinpath('cmdline').open('rb') as command_file: command=command_file.read(2048)
                    process['command']=text_limit(' '.join(command.decode('utf-8','replace').split('\0')).strip(),512) or None
                    stat=proc.joinpath('stat').read_text().rsplit(')',1)[1].split()
                    if boot is not None: process['elapsedSeconds']=max(0,time.time()-boot-float(stat[19])/clock)
                except (OSError,ValueError,IndexError): pass
                gpus['processes'].append(process)
    except subprocess.TimeoutExpired: gpus['processReason']='GPU 进程查询超时，显卡汇总仍然有效'
    except (OSError,ValueError,csv.Error): gpus['processReason']='GPU 进程数据格式不可识别，显卡汇总仍然有效'
scope='container' if pathlib.Path('/.dockerenv').exists() or any(x in read('1/cgroup') for x in ['docker','kubepods','containerd','lxc']) else 'host'
if scope=='container':
    # /proc CPU/RAM/disk counters may describe the whole host. Prefer the
    # current cgroup; unavailable scoped counters remain unknown.
    C=pathlib.Path('/sys/fs/cgroup')
    cpu.update(total=None,idle=None,load=[])
    memory={'usedBytes':None,'totalBytes':None}; disk={'readBytes':None,'writeBytes':None}
    try:
        usage={line.split()[0]:int(line.split()[1]) for line in C.joinpath('cpu.stat').read_text().splitlines()}['usage_usec']
        capacity=float(os.cpu_count() or 1)
        quota,period=C.joinpath('cpu.max').read_text().split()
        if quota!='max': capacity=min(capacity,int(quota)/int(period))
        try:
            ranges=C.joinpath('cpuset.cpus.effective').read_text().strip().split(',')
            count=sum((int(part.split('-')[1])-int(part.split('-')[0])+1) if '-' in part else 1 for part in ranges if part)
            if count: capacity=min(capacity,count)
        except (OSError,ValueError,IndexError): pass
        total=time.monotonic()*capacity*1000000
        cpu.update(total=total,idle=max(0,total-usage),cores=capacity)
    except (OSError,ValueError,KeyError,ZeroDivisionError): pass
    try:
        used=int(C.joinpath('memory.current').read_text()); maximum=C.joinpath('memory.max').read_text().strip()
        total=entries.get('MemTotal') if maximum=='max' else int(maximum)
        memory={'usedBytes':used,'totalBytes':total}
    except (OSError,ValueError,NameError): pass
    try:
        rows=[]
        for line in C.joinpath('io.stat').read_text().splitlines():
            values=dict(field.split('=',1) for field in line.split()[1:])
            rows.append((int(values.get('rbytes',0)),int(values.get('wbytes',0))))
        if rows: disk={'readBytes':sum(x[0] for x in rows),'writeBytes':sum(x[1] for x in rows)}
    except (OSError,ValueError): pass
print(json.dumps({'sampledAt':int(time.time()*1000),'scope':scope,'cpu':cpu,'memory':memory,'network':network,'disk':disk,'gpus':gpus},allow_nan=False,separators=(',',':')))
`

const OWNED_PID_HELPER = String.raw`
import json,os,pathlib
pid=os.getppid(); result={}
for _ in range(24):
    if pid<2: break
    try:
        p=pathlib.Path('/proc')/str(pid)
        stat=p.joinpath('stat').read_text().rsplit(')',1)[1].split()
        if p.stat().st_uid!=os.geteuid(): break
        if p.joinpath('comm').read_text().strip()=='codex' and b'app-server' in p.joinpath('cmdline').read_bytes().split(b'\0'):
            result={'pid':pid}; break
        pid=int(stat[1])
    except (OSError,ValueError,IndexError): break
print(json.dumps(result))
`

/** Reuse the pinned-host policy; stdin carries code rather than shell expansion. */
export function resourceSshArgs(host: Host, pin?: Parameters<typeof sshKnownHostsArgs>[0], control?: SSHConnectionControl) {
  return sshPythonArgs(host, pin, control)
}

export async function collectHostResources(host: Host, options: BridgeOptions = {}): Promise<RawHostResources> {
  try {
    return parseRawResources(JSON.parse(await runHostPython(host, HOST_RESOURCE_HELPER, options,
      { timeoutMs: 11000, maxOutputBytes: 256 * 1024, background: true })))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('主机资源返回格式不可识别')
    throw error
  }
}

const nullableCounter = z.number().finite().nonnegative().nullable()
const rawSchema = z.object({
  sampledAt: z.number().finite().nonnegative(), scope: z.enum(['host', 'container']),
  cpu: z.object({ total: nullableCounter, idle: nullableCounter, load: z.array(z.number().finite().nonnegative()).max(3), cores: nullableCounter }),
  memory: z.object({ usedBytes: nullableCounter, totalBytes: nullableCounter }),
  network: z.object({ rxBytes: nullableCounter, txBytes: nullableCounter, interfaces: z.array(z.string().max(100)).max(1000) }),
  disk: z.object({ readBytes: nullableCounter, writeBytes: nullableCounter }),
  gpus: z.object({ available: z.boolean(), reason: z.string().max(300).optional(),
    processes: z.array(z.object({ gpuIndex: z.number().int().nonnegative().nullable(), gpuUuid: z.string().max(120), pid: z.number().int().positive().safe(), name: z.string().max(256), user: z.string().max(100).nullable(), memoryUsedBytes: nullableCounter, elapsedSeconds: nullableCounter, command: z.string().max(512).nullable() })).max(128).optional(),
    processReason: z.string().max(300).optional(), processesTruncated: z.boolean().optional(), devices: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string().max(200), utilizationPercent: nullableCounter, memoryUsedBytes: nullableCounter, memoryTotalBytes: nullableCounter, temperatureC: nullableCounter, powerWatts: nullableCounter })).max(64) }),
})
export const parseRawResources = (value: unknown): RawHostResources => rawSchema.parse(value)

export function resourceRates(hostId: string, next: RawHostResources, previous?: RawHostResources) {
  const seconds = previous ? (next.sampledAt - previous.sampledAt) / 1000 : 0
  const rate = (current: number | null, old?: number | null) => seconds > 0 && current !== null && old != null && current >= old ? (current - old) / seconds : null
  const total = next.cpu.total; const idle = next.cpu.idle
  const deltaTotal = total !== null && previous?.cpu.total != null ? total - previous.cpu.total : 0
  const deltaIdle = idle !== null && previous?.cpu.idle != null ? idle - previous.cpu.idle : -1
  return { hostId, sampledAt: next.sampledAt, scope: next.scope,
    cpu: { usagePercent: seconds > 0 && deltaTotal > 0 && deltaIdle >= 0 && deltaIdle <= deltaTotal ? 100 * (1 - deltaIdle / deltaTotal) : null, load: next.cpu.load, cores: next.cpu.cores },
    memory: { ...next.memory, usagePercent: next.memory.totalBytes && next.memory.usedBytes !== null ? 100 * next.memory.usedBytes / next.memory.totalBytes : null },
    network: { rxBytesPerSecond: rate(next.network.rxBytes, previous?.network.rxBytes), txBytesPerSecond: rate(next.network.txBytes, previous?.network.txBytes), interfaces: next.network.interfaces },
    disk: { readBytesPerSecond: rate(next.disk.readBytes, previous?.disk.readBytes), writeBytesPerSecond: rate(next.disk.writeBytes, previous?.disk.writeBytes) }, gpus: next.gpus,
  }
}

export async function readRuntimeReleasedThreads(dataDir: string) {
  try {
    const saved = z.object({ releasedThreads: z.array(z.object({ hostId: z.string().min(1).max(200), threadId: z.string().min(1).max(256), name: z.string().max(160), restoreThreadIds: z.array(z.string().min(1).max(256)).max(10000) })).max(10000).default([]) }).parse(JSON.parse(await fs.readFile(path.join(dataDir, 'runtime-state.json'), 'utf8')))
    const hosts = new Map<string, Map<string, ReleasedThread>>()
    for (const entry of saved.releasedThreads) { if (!hosts.has(entry.hostId)) hosts.set(entry.hostId, new Map()); hosts.get(entry.hostId)!.set(entry.threadId, { name: entry.name, restoreThreadIds: entry.restoreThreadIds }) }
    return hosts
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map<string, Map<string, ReleasedThread>>(); throw error }
}

export async function readRuntimePausedHosts(dataDir: string) {
  try { return new Set(z.object({ pausedHostIds: z.array(z.string().min(1).max(200)).max(1000) }).parse(JSON.parse(await fs.readFile(path.join(dataDir, 'runtime-state.json'), 'utf8'))).pausedHostIds) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set<string>(); throw error }
}

type Dependencies = {
  getHost: (id: string) => Host | undefined; getBridge: (id: string) => Promise<Bridge>; getExistingBridge: (id: string) => Bridge | undefined
  persistRuntime?: () => Promise<void>; releasedThreads?: Map<string, Map<string, ReleasedThread>>; pausedHosts: Set<string>; dataDir: string; bridgeOptions?: BridgeOptions; collect?: (host: Host) => Promise<RawHostResources>; now?: () => number
  withRuntimeMaintenance?: <T>(hostId: string, work: () => Promise<T>) => Promise<T>
  daemonRestart?: typeof restartCodexDaemon
}

export function registerHostResources(app: Express, dependencies: Dependencies) {
  const cache = new Map<string, { raw?: RawHostResources; value?: ReturnType<typeof resourceRates>; at?: number; inFlight?: Promise<ReturnType<typeof resourceRates>>; host?: Host }>()
  const ownedPids = new WeakMap<Bridge, { transportPid?: number; startedAt?: number; pid?: number; attempted: boolean }>()
  let mutations: Promise<unknown> = Promise.resolve()
  const reconnections = new Map<string, Promise<unknown>>()
  const informationCache = new Map<string, { bridge: Bridge; engineId?: string; at: number; value?: unknown; inFlight?: Promise<unknown> }>()
  const now = dependencies.now || Date.now
  const maintain = <T>(hostId: string, work: () => Promise<T>): Promise<T> => dependencies.withRuntimeMaintenance ? dependencies.withRuntimeMaintenance(hostId, work) : work()
  const released = dependencies.releasedThreads || new Map<string, Map<string, ReleasedThread>>()
  const persist = dependencies.persistRuntime || (() => writePrivateJson(path.join(dependencies.dataDir, 'runtime-state.json'), { pausedHostIds: [...dependencies.pausedHosts], releasedThreads: [...released].flatMap(([hostId, threads]) => [...threads].map(([threadId, entry]) => ({ hostId, threadId, ...entry }))) }))
  const getHost = (id: string) => { const host = dependencies.getHost(id); if (!host) throw Object.assign(new Error('Host not found'), { status: 404 }); return host }
  const runtime = async (host: Host, probe = true) => {
    const bridge = dependencies.getExistingBridge(host.id)
    if (!bridge) return { connected: false, paused: dependencies.pausedHosts.has(host.id), managed: hostConnectionMode(host, dependencies.bridgeOptions) !== 'proxy', connectionMode: hostConnectionMode(host, dependencies.bridgeOptions), independentDaemon: hostConnectionMode(host, dependencies.bridgeOptions) !== 'spawn', mode: host.kind === 'ssh' ? 'ssh' : dependencies.bridgeOptions?.mode || 'spawn', loadedThreadCount: 0, activeThreadCount: 0, activeProcesses: [], processes: [], threads: [...(released.get(host.id) || [])].map(([id, entry]) => ({ id, name: entry.name, loaded: false, active: false, released: true, restoring: !!entry.restoreThreadIds.length })) }
    const info = bridge.runtime
    let owned = ownedPids.get(bridge)
    if (owned?.transportPid !== info.pid || owned?.startedAt !== info.startedAt) { owned = undefined; ownedPids.delete(bridge) }
    if (probe && info.connected && !info.paused && info.managed && !owned?.attempted) {
      owned = { transportPid: info.pid, startedAt: info.startedAt, attempted: true }; ownedPids.set(bridge, owned)
      try {
        const result = await bridge.request('command/exec', { command: ['python3', '-c', OWNED_PID_HELPER], timeoutMs: 3000, outputBytesCap: 1024, sandboxPolicy: { type: 'dangerFullAccess' } }, 4000) as { exitCode?: number; stdout?: string }
        const value = JSON.parse(result.stdout || '{}')
        if (result.exitCode === 0 && Number.isSafeInteger(value.pid) && value.pid > 1) owned.pid = value.pid
      } catch {}
    }
    const current = bridge.runtime
    const processes = [...current.processes]
    if (current.connected && owned?.pid && !processes.some(entry => entry.pid === owned!.pid)) processes.push({ pid: owned.pid, role: 'app-server', local: host.kind === 'local' })
    return { ...current, threads: current.threads.map(thread => ({ ...thread, pid: thread.loaded ? owned?.pid || thread.pid : undefined })), ...(current.connected && owned?.pid ? { pid: owned.pid } : {}), processes }
  }
  const sample = async (host: Host) => {
    let entry = cache.get(host.id)
    if (entry?.host !== host) { entry = { host }; cache.set(host.id, entry) }
    if (entry.value && entry.at !== undefined && now() - entry.at < 3000) return entry.value
    if (entry.inFlight) return entry.inFlight
    const current = entry
    current.inFlight = (async () => {
      const raw = parseRawResources(await (dependencies.collect || (host => collectHostResources(host, dependencies.bridgeOptions)))(host))
      const value = resourceRates(host.id, raw, current.raw)
      current.raw = raw; current.value = value; current.at = now()
      return value
    })().finally(() => { current.inFlight = undefined })
    return current.inFlight
  }
  app.get('/api/hosts/:id/resources', (req, res, next) => {
    void (async () => { const host = getHost(String(req.params.id)); const [value, info] = await Promise.all([sample(host), runtime(host)]); res.json({ ...value, runtime: info }) })().catch(next)
  })
  app.get('/api/hosts/:id/runtime/information', (req, res, next) => {
    void (async () => {
      const host = getHost(String(req.params.id)), bridge = dependencies.getExistingBridge(host.id)
      if (!bridge?.connected || bridge.paused) {
        informationCache.delete(host.id)
        const paused = bridge?.paused || dependencies.pausedHosts.has(host.id)
        res.json({ checkedAt: now(), runtime: { ...await runtime(host, false), userAgent: bridge?.userAgent || null }, models: [], config: { model: null, model_context_window: null, model_auto_compact_token_limit: null },
          ...(paused ? { canReconnect: false, reconnectDisabledReason: '此主机已暂停，请在资源管理中恢复连接' } : bridge?.reconnectStatus || { canReconnect: true, reconnectDisabledReason: null }) })
        return
      }
      const engineId = bridge.runtime.engineId
      let entry = informationCache.get(host.id)
      if (entry?.bridge !== bridge || entry.engineId !== engineId) { entry = { bridge, engineId, at: 0 }; informationCache.set(host.id, entry) }
      if (!entry.inFlight && (!entry.value || now() - entry.at >= 3000)) {
        const current = entry
        current.inFlight = (async () => {
          const models: Record<string, unknown>[] = [], seen = new Set<string>()
          let cursor: string | null = null
          do {
            const page = await bridge.request('model/list', { limit: 100, includeHidden: true, cursor }, 10000) as { data?: unknown; nextCursor?: unknown }
            if (!Array.isArray(page?.data) || page.nextCursor != null && typeof page.nextCursor !== 'string') throw new Error('Codex 返回的模型列表格式不正确')
            for (const model of page.data) {
              if (!model || typeof model !== 'object' || typeof model.id !== 'string' || typeof model.model !== 'string') throw new Error('Codex 返回的模型元数据格式不正确')
              models.push(Object.fromEntries(['id', 'model', 'upgrade', 'upgradeInfo', 'availabilityNux', 'displayName', 'description', 'modelSpecialty', 'hidden', 'supportedReasoningEfforts', 'defaultReasoningEffort', 'inputModalities', 'supportsPersonality', 'multiAgentVersion', 'additionalSpeedTiers', 'serviceTiers', 'defaultServiceTier', 'availableAccessPrograms', 'isDefault'].filter(key => Object.hasOwn(model, key)).map(key => [key, model[key]])))
            }
            cursor = page.nextCursor as string | null || null
            if (models.length > 10000 || cursor && seen.has(cursor)) throw new Error('Codex 模型列表无法完整读取')
            if (cursor) seen.add(cursor)
          } while (cursor)
          const response = await bridge.request('config/read', { includeLayers: false }, 10000) as { config?: Record<string, unknown> }
          if (!response?.config || typeof response.config !== 'object') throw new Error('Codex 未返回有效配置')
          if (!bridge.connected || bridge.runtime.engineId !== engineId) throw Object.assign(new Error('Codex 连接已改变，请重新刷新运行信息'), { status: 409 })
          const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
          const value = { checkedAt: now(), runtime: { ...await runtime(host, false), userAgent: bridge.userAgent || null }, models,
            config: { model: typeof response.config.model === 'string' ? response.config.model : null, model_context_window: positive(response.config.model_context_window), model_auto_compact_token_limit: positive(response.config.model_auto_compact_token_limit) } }
          current.value = value; current.at = now()
          return value
        })().finally(() => { current.inFlight = undefined })
      }
      const value = await entry.inFlight || entry.value
      if (!bridge.connected || bridge.runtime.engineId !== engineId) throw Object.assign(new Error('Codex 连接已改变，请重新刷新运行信息'), { status: 409 })
      res.json({ ...(value as object), runtime: { ...await runtime(host, false), userAgent: bridge.userAgent || null }, ...bridge.reconnectStatus,
        canRestartDaemon: bridge.options.daemonManaged === true && bridge.runtime.managed && bridge.maintenanceStatus.canReconnect,
        daemonRestartDisabledReason: bridge.options.daemonManaged === true && bridge.runtime.managed ? bridge.maintenanceStatus.reconnectDisabledReason : '此连接由其他客户端启动，请在原客户端管理或迁移为托管服务' })
    })().catch(next)
  })
  for (const action of ['close', 'resume'] as const) app.post(`/api/hosts/:id/runtime/threads/:threadId/${action}`, (req, res, next) => {
    void (async () => {
      const host = getHost(String(req.params.id)); const threadId = z.string().min(1).max(256).parse(req.params.threadId)
      if (action === 'close') z.object({ confirmed: z.literal(true) }).strict().parse(req.body)
      else z.object({}).strict().parse(req.body)
      const operation = mutations.then(() => maintain(host.id, async () => {
        const bridge = action === 'close' ? dependencies.getExistingBridge(host.id) : await dependencies.getBridge(host.id)
        if (!bridge) throw Object.assign(new Error('此会话没有由 Web 持有的连接'), { status: 404 })
        released.set(host.id, bridge.releasedThreads)
        if (action === 'close') await bridge.releaseThread(threadId, persist)
        else await bridge.reconnectThread(threadId, persist)
        return { ok: true, runtime: await runtime(host, false) }
      }))
      mutations = operation.catch(() => {}); res.json(await operation)
    })().catch(next)
  })
  app.post('/api/hosts/:id/runtime/close', (req, res, next) => {
    void (async () => {
      const host = getHost(String(req.params.id)); z.object({ confirmed: z.literal(true) }).strict().parse(req.body)
      const operation = mutations.then(() => maintain(host.id, async () => {
        const previous = dependencies.pausedHosts.has(host.id)
        dependencies.pausedHosts.add(host.id)
        try { await persist() }
        catch (error) { if (!previous) dependencies.pausedHosts.delete(host.id); throw error }
        const bridge = dependencies.getExistingBridge(host.id)
        await bridge?.pause()
        return { ok: true, runtime: await runtime(host, false) }
      }))
      mutations = operation.catch(() => {}); res.json(await operation)
    })().catch(next)
  })
  app.post('/api/hosts/:id/runtime/resume', (req, res, next) => {
    void (async () => {
      const host = getHost(String(req.params.id)); z.object({}).strict().parse(req.body)
      const operation = mutations.then(() => maintain(host.id, async () => {
        const bridge = await dependencies.getBridge(host.id)
        try { await bridge.resume() }
        catch (error) {
          // Maintenance refusal did not start a resume. Pausing here would
          // disconnect the updater's original transport and persist a state
          // which its successful restart could subsequently overwrite.
          if ((error as { code?: string }).code !== 'runtime_reconnecting') await bridge.pause()
          throw error
        }
        dependencies.pausedHosts.delete(host.id)
        try { await persist() }
        catch (error) { dependencies.pausedHosts.add(host.id); await bridge.pause(); throw error }
        return { ok: true, runtime: await runtime(host, false) }
      }))
      mutations = operation.catch(() => {}); res.json(await operation)
    })().catch(next)
  })
  for (const action of ['reconnect', 'daemon/restart'] as const) app.post(`/api/hosts/:id/runtime/${action}`, (req, res, next) => {
    void (async () => {
      const hostId = String(req.params.id); getHost(hostId)
      if (action === 'daemon/restart') z.object({ confirmed: z.literal(true) }).strict().parse(req.body)
      else z.object({}).strict().parse(req.body)
      const operationKey = `${hostId}:${action}`
      let operation = reconnections.get(operationKey)
      if (!operation) {
        const reconnect = async () => {
          // Resolve again after queued resource mutations: deleted or edited
          // hosts must not refresh an obsolete transport using old credentials.
          const host = getHost(hostId)
          if (dependencies.pausedHosts.has(hostId) || dependencies.getExistingBridge(hostId)?.paused)
            throw Object.assign(new Error('此主机已暂停，请在资源管理中恢复连接'), { status: 409, code: 'runtime_paused' })
          const bridge = await dependencies.getBridge(hostId)
          if (bridge.host !== host) throw Object.assign(new Error('主机配置已改变，请重新打开设置后重试'), { status: 409 })
          if (dependencies.pausedHosts.has(hostId) || bridge.paused)
            throw Object.assign(new Error('此主机已暂停，请在资源管理中恢复连接'), { status: 409, code: 'runtime_paused' })
          if (action === 'daemon/restart') {
            if (!bridge.options.daemonManaged) throw Object.assign(new Error('仅可重启此网页管理的独立 daemon'), { status: 409 })
            if (!bridge.runtime.managed) throw Object.assign(new Error('此 daemon 由其他客户端启动，请在原客户端重启或迁移为托管服务'), { status: 409 })
            await bridge.reconnect(async () => { await (dependencies.daemonRestart || restartCodexDaemon)(host, { ...bridge.options, daemonHome: bridge.codexHome }) }, { checkQueuedInputs: true })
          } else await bridge.reconnect()
          ownedPids.delete(bridge)
          informationCache.delete(hostId)
          return { ok: true, runtime: await runtime(host, false), userAgent: bridge.userAgent || null, codexHome: bridge.codexHome || null }
        }
        operation = mutations.then(() => dependencies.withRuntimeMaintenance ? dependencies.withRuntimeMaintenance(hostId, reconnect) : reconnect())
          .finally(() => { reconnections.delete(operationKey) })
        reconnections.set(operationKey, operation)
        mutations = operation.catch(() => {})
      }
      res.json(await operation)
    })().catch(next)
  })
}
