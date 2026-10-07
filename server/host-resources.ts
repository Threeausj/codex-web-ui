import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Express } from 'express'
import { z } from 'zod'
import { Bridge, type BridgeOptions } from './bridge.js'
import { shellQuote, sshKnownHostsArgs } from './ssh.js'
import { writePrivateJson } from './storage.js'
import type { Host } from './types.js'

export type GpuResources = { available: boolean; reason?: string; devices: { index: number; name: string; utilizationPercent: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; temperatureC: number | null; powerWatts: number | null }[] }
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
export function resourceSshArgs(host: Host, pin?: Parameters<typeof sshKnownHostsArgs>[0]) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR', ...sshKnownHostsArgs(pin)]
  if (host.port) args.push('-p', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  args.push('--', `${host.username ? `${host.username}@` : ''}${host.hostname}`, `exec /bin/sh -c ${shellQuote('exec python3 -')}`)
  return args
}

export async function collectHostResources(host: Host, options: BridgeOptions = {}): Promise<RawHostResources> {
  const pin = host.kind === 'ssh' ? await options.resolveSshHostKeyPin?.(host) ?? options.sshHostKeyPin : undefined
  const executable = host.kind === 'ssh' ? 'ssh' : 'python3'
  const args = host.kind === 'ssh' ? resourceSshArgs(host, pin) : ['-']
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let finished = false; let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 11_000); timer.unref()
    const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); if (error) reject(error); else { try { resolve(parseRawResources(JSON.parse(stdout))) } catch { reject(new Error('主机资源返回格式不可识别')) } } }
    child.on('error', () => finish(new Error(host.kind === 'ssh' ? '无法启动资源采集 SSH，请检查服务端 SSH 安装' : '资源采集需要 Linux 和 Python 3')))
    child.stdin.on('error', () => {})
    child.stdout.on('data', data => { stdout += data.toString(); if (stdout.length > 96 * 1024) { child.kill('SIGKILL'); finish(new Error('主机资源返回数据超出限制')) } })
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2048) })
    child.on('close', code => {
      if (code !== 0) finish(new Error(timedOut ? '主机资源采集超时' : /host key|identification has changed/i.test(stderr) ? '请在服务器设置中确认并信任 SSH 主机指纹' : /python3.*not found/i.test(stderr) ? '资源采集需要目标主机安装 Python 3' : '无法读取主机资源，请检查 Linux、SSH 连接及账户权限'))
      else finish()
    })
    child.stdin.end(HOST_RESOURCE_HELPER)
  })
}

const nullableCounter = z.number().finite().nonnegative().nullable()
const rawSchema = z.object({
  sampledAt: z.number().finite().nonnegative(), scope: z.enum(['host', 'container']),
  cpu: z.object({ total: nullableCounter, idle: nullableCounter, load: z.array(z.number().finite().nonnegative()).max(3), cores: nullableCounter }),
  memory: z.object({ usedBytes: nullableCounter, totalBytes: nullableCounter }),
  network: z.object({ rxBytes: nullableCounter, txBytes: nullableCounter, interfaces: z.array(z.string().max(100)).max(1000) }),
  disk: z.object({ readBytes: nullableCounter, writeBytes: nullableCounter }),
  gpus: z.object({ available: z.boolean(), reason: z.string().max(300).optional(), devices: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string().max(200), utilizationPercent: nullableCounter, memoryUsedBytes: nullableCounter, memoryTotalBytes: nullableCounter, temperatureC: nullableCounter, powerWatts: nullableCounter })).max(64) }),
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

export async function readRuntimePausedHosts(dataDir: string) {
  try { return new Set(z.object({ pausedHostIds: z.array(z.string().min(1).max(200)).max(1000) }).parse(JSON.parse(await fs.readFile(path.join(dataDir, 'runtime-state.json'), 'utf8'))).pausedHostIds) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set<string>(); throw error }
}

type Dependencies = {
  getHost: (id: string) => Host | undefined; getBridge: (id: string) => Promise<Bridge>; getExistingBridge: (id: string) => Bridge | undefined
  pausedHosts: Set<string>; dataDir: string; bridgeOptions?: BridgeOptions; collect?: (host: Host) => Promise<RawHostResources>; now?: () => number
}

export function registerHostResources(app: Express, dependencies: Dependencies) {
  const cache = new Map<string, { raw?: RawHostResources; value?: ReturnType<typeof resourceRates>; at?: number; inFlight?: Promise<ReturnType<typeof resourceRates>>; host?: Host }>()
  const ownedPids = new WeakMap<Bridge, { transportPid?: number; startedAt?: number; pid?: number; attempted: boolean }>()
  let mutations: Promise<unknown> = Promise.resolve()
  const now = dependencies.now || Date.now
  const getHost = (id: string) => { const host = dependencies.getHost(id); if (!host) throw Object.assign(new Error('Host not found'), { status: 404 }); return host }
  const runtime = async (host: Host, probe = true) => {
    const bridge = dependencies.getExistingBridge(host.id)
    if (!bridge) return { connected: false, paused: dependencies.pausedHosts.has(host.id), managed: dependencies.bridgeOptions?.mode !== 'proxy', mode: host.kind === 'ssh' ? 'ssh' : dependencies.bridgeOptions?.mode || 'spawn', loadedThreadCount: 0, activeThreadCount: 0, activeProcesses: [], processes: [] }
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
    return { ...current, ...(current.connected && owned?.pid ? { pid: owned.pid } : {}), processes }
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
  app.post('/api/hosts/:id/runtime/close', (req, res, next) => {
    void (async () => {
      const host = getHost(String(req.params.id)); z.object({ confirmed: z.literal(true) }).strict().parse(req.body)
      const operation = mutations.then(async () => {
        const previous = dependencies.pausedHosts.has(host.id)
        dependencies.pausedHosts.add(host.id)
        try { await writePrivateJson(path.join(dependencies.dataDir, 'runtime-state.json'), { pausedHostIds: [...dependencies.pausedHosts] }) }
        catch (error) { if (!previous) dependencies.pausedHosts.delete(host.id); throw error }
        const bridge = dependencies.getExistingBridge(host.id)
        await bridge?.pause()
        return { ok: true, runtime: await runtime(host, false) }
      })
      mutations = operation.catch(() => {}); res.json(await operation)
    })().catch(next)
  })
  app.post('/api/hosts/:id/runtime/resume', (req, res, next) => {
    void (async () => {
      const host = getHost(String(req.params.id)); z.object({}).strict().parse(req.body)
      const operation = mutations.then(async () => {
        const bridge = await dependencies.getBridge(host.id)
        try { await bridge.resume() }
        catch (error) { await bridge.pause(); throw error }
        dependencies.pausedHosts.delete(host.id)
        try { await writePrivateJson(path.join(dependencies.dataDir, 'runtime-state.json'), { pausedHostIds: [...dependencies.pausedHosts] }) }
        catch (error) { dependencies.pausedHosts.add(host.id); await bridge.pause(); throw error }
        return { ok: true, runtime: await runtime(host, false) }
      })
      mutations = operation.catch(() => {}); res.json(await operation)
    })().catch(next)
  })
}
