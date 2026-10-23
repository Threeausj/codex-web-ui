import fs, { constants } from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Express } from 'express'
import { z } from 'zod'
import type { BridgeOptions } from './bridge.js'
import { resourceSshArgs } from './host-resources.js'
import { sharedSshPool } from './ssh-pool.js'
import type { Host } from './types.js'

const absolutePath = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\x00-\x1f\x7f\\]/.test(value), '需要绝对文件路径').transform(value => path.posix.normalize(value))
type ByteRange = { start?: number; end?: number; suffix?: number }
type FileOptions = {
  bridgeOptions?: BridgeOptions
  /** Isolated subprocess injection for protocol tests; never supplied by HTTP. */
  spawnSSH?: (args: string[]) => ChildProcessWithoutNullStreams
}
type Transfer = { size: number; start: number; end: number; partial: boolean; unsatisfiable: boolean; stream: Readable; close(): void }
class FileTransferError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}
const tooLarge = () => new FileTransferError('文件超过 8 MB，可从所在目录下载', 413)
const cancelled = () => new FileTransferError('下载已取消', 499)
function fileError(error: unknown): FileTransferError {
  if (error instanceof FileTransferError) return error
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FileTransferError('文件不存在或已移动', 404)
  if (code === 'EACCES' || code === 'EPERM') return new FileTransferError('当前账户无权读取此文件', 403)
  return new FileTransferError('无法下载文件，请检查主机连接及文件权限')
}
function parseRange(value: string | undefined): ByteRange | undefined {
  if (!value) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) throw new FileTransferError('不支持此下载范围，请重新下载', 416)
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) throw new FileTransferError('下载范围无效', 416)
  return first === undefined ? { suffix: last } : { start: first, end: last }
}
function boundaries(size: number, range?: ByteRange) {
  let start = 0; let end = size - 1
  if (range) {
    if (range.suffix !== undefined) start = Math.max(0, size - range.suffix)
    else { start = range.start!; if (range.end !== undefined) end = Math.min(end, range.end) }
  }
  return { start, end, partial: !!range, unsatisfiable: !!range && (!size || start > end || start >= size) }
}

/** Paths travel in a literal Base64 JSON value in fixed Python source, never in
 * the SSH shell command. A bounded header precedes raw bytes on the same fd. */
export function remoteFileDownloadSource(file: string, range: ByteRange | undefined, head: boolean, maximum?: number) {
  const payload = Buffer.from(JSON.stringify({ path: file, range, head, maximum })).toString('base64')
  return String.raw`
import base64,json,os,stat,sys
p=json.loads(base64.b64decode('${payload}'))
out=sys.stdout.buffer
fd=None
def header(value):
    out.write((json.dumps(value,separators=(',',':'))+'\n').encode('utf-8'))
    out.flush()
try:
    fd=os.open(p['path'],os.O_RDONLY|os.O_NONBLOCK)
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        header({'error':'NOT_REGULAR'})
    elif info.st_size>9007199254740991:
        header({'error':'READ_FAILED'})
    elif p.get('maximum') is not None and info.st_size>p['maximum']:
        header({'error':'TOO_LARGE'})
    else:
        size=info.st_size
        start=0
        end=size-1
        r=p.get('range')
        if r is not None:
            if r.get('suffix') is not None: start=max(0,size-r['suffix'])
            else:
                start=r['start']
                if r.get('end') is not None: end=min(end,r['end'])
        bad=r is not None and (not size or start>end or start>=size)
        header({'size':size,'start':start,'end':end,'partial':r is not None,'unsatisfiable':bad})
        if not p['head'] and not bad:
            os.lseek(fd,start,os.SEEK_SET)
            remaining=end-start+1
            while remaining>0:
                chunk=os.read(fd,min(65536,remaining))
                if not chunk: raise OSError('File changed during download')
                out.write(chunk)
                remaining-=len(chunk)
            out.flush()
except (BrokenPipeError,ConnectionResetError):
    os._exit(0)
except Exception as error:
    # Before a header, report only a stable code. After a header, a non-zero
    # exit makes the HTTP stream fail instead of appending an error to bytes.
    code='NOT_FOUND' if isinstance(error,(FileNotFoundError,NotADirectoryError)) else 'FORBIDDEN' if isinstance(error,PermissionError) else 'READ_FAILED'
    if fd is None: header({'error':code})
    else: sys.exit(1)
finally:
    if fd is not None: os.close(fd)
`
}

async function localFile(file: string, range: ByteRange | undefined, head: boolean, maximum: number | undefined, signal?: AbortSignal): Promise<Transfer> {
  if (signal?.aborted) throw cancelled()
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new FileTransferError('只能下载普通文件，请选择目录中的文件', 400)
    if (!Number.isSafeInteger(info.size)) throw new FileTransferError('无法读取文件大小')
    if (maximum !== undefined && info.size > maximum) throw tooLarge()
    if (signal?.aborted) throw cancelled()
    const bounds = boundaries(info.size, range)
    if (head || bounds.unsatisfiable || !info.size) {
      await handle.close()
      return { size: info.size, ...bounds, stream: Readable.from([]), close() {} }
    }
    const stream = handle.createReadStream({ start: bounds.start, end: bounds.end, autoClose: true })
    return { size: info.size, ...bounds, stream, close: () => stream.destroy() }
  } catch (error) { await handle.close().catch(() => {}); throw fileError(error) }
}

async function remoteFile(host: Host, file: string, range: ByteRange | undefined, head: boolean, maximum: number | undefined, options: FileOptions, signal?: AbortSignal): Promise<Transfer> {
  const pin = await options.bridgeOptions?.resolveSshHostKeyPin?.(host) ?? options.bridgeOptions?.sshHostKeyPin
  if (signal?.aborted) throw cancelled()
  const lease = options.spawnSSH ? undefined : await (options.bridgeOptions?.sshPool || sharedSshPool).acquire(host, pin)
  if (signal?.aborted) { lease?.release(); throw cancelled() }
  const args = resourceSshArgs(host, pin, lease?.control)
  let child: ChildProcessWithoutNullStreams
  try { child = options.spawnSSH?.(args) ?? spawn('ssh', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch (error) { lease?.release(); throw error }
  child.once('close', () => lease?.release())
  child.once('error', () => lease?.release())
  const stop = () => { child.stdout.destroy(); child.stdin.destroy(); child.kill('SIGKILL') }
  signal?.addEventListener('abort', stop, { once: true })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048) })
  child.stdin.on('error', () => {})
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new FileTransferError('无法启动文件下载 SSH')))
    child.once('close', code => {
      signal?.removeEventListener('abort', stop)
      if (code === 0) resolve()
      else reject(signal?.aborted ? cancelled() : new FileTransferError(/host key|identification has changed/i.test(stderr) ? '请确认并信任 SSH 主机指纹后重试' : /python3.*(?:not found|No such file)/i.test(stderr) ? '远程文件查看和下载需要 Python 3，请安装并确保 SSH 可执行 python3' : '远程文件传输中断，请检查 SSH 连接后重试'))
    })
  })
  // Rejections are also awaited by the body generator; keep an early SSH exit
  // from becoming an unhandled rejection while its bounded header is parsed.
  void exited.catch(() => {})
  child.stdin.end(remoteFileDownloadSource(file, range, head, maximum))
  const iterator = child.stdout[Symbol.asyncIterator]()
  let header = Buffer.alloc(0)
  let remainder = Buffer.alloc(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const metadata = await Promise.race([
      (async () => {
        while (true) {
          const next = await iterator.next()
          if (next.done) { await exited; throw new FileTransferError('远程文件返回格式不正确') }
          const chunk = Buffer.from(next.value)
          const newline = chunk.indexOf(10)
          const prefix = newline === -1 ? chunk : chunk.subarray(0, newline)
          if (header.length + prefix.length > 4096) throw new FileTransferError('远程文件返回格式不正确')
          header = Buffer.concat([header, prefix])
          if (newline !== -1) { remainder = chunk.subarray(newline + 1); return JSON.parse(header.toString('utf8')) }
        }
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { stop(); reject(new FileTransferError('读取远程文件信息超时，请重试', 504)) }, 15000); timer.unref() }),
    ])
    clearTimeout(timer)
    if (metadata.error) {
      if (metadata.error === 'TOO_LARGE') throw tooLarge()
      if (metadata.error === 'NOT_FOUND') throw new FileTransferError('文件不存在或已移动', 404)
      if (metadata.error === 'FORBIDDEN') throw new FileTransferError('当前账户无权读取此文件', 403)
      if (metadata.error === 'NOT_REGULAR') throw new FileTransferError('只能下载普通文件，请选择目录中的文件', 400)
      throw new FileTransferError('无法读取远程文件')
    }
    const parsed = z.object({ size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), start: z.number().int().nonnegative(), end: z.number().int().min(-1), partial: z.boolean(), unsatisfiable: z.boolean() }).strict().parse(metadata)
    const expected = boundaries(parsed.size, range)
    if (JSON.stringify(expected) !== JSON.stringify({ start: parsed.start, end: parsed.end, partial: parsed.partial, unsatisfiable: parsed.unsatisfiable })) throw new FileTransferError('远程文件返回范围不正确')
    const stream = Readable.from((async function* () {
      if (remainder.length) yield remainder
      while (true) { const next = await iterator.next(); if (next.done) break; yield next.value }
      await exited
    })())
    return { ...parsed, stream, close: stop }
  } catch (error) { clearTimeout(timer); stop(); throw fileError(error) }
}

async function openHostFile(host: Host, file: string, range: ByteRange | undefined, head: boolean, maximum: number | undefined, options: FileOptions, signal?: AbortSignal) {
  try { return await (host.kind === 'local' ? localFile(file, range, head, maximum, signal) : remoteFile(host, file, range, head, maximum, options, signal)) }
  catch (error) { throw fileError(error) }
}

/** Preview/editor reads reject oversize files from fstat before reading bytes.
 * Downloads use the same descriptor/SSH pipeline without this preview limit. */
export async function readBoundedHostFile(host: Host, file: string, maximum: number, options: FileOptions = {}): Promise<Buffer> {
  const transfer = await openHostFile(host, absolutePath.parse(file), undefined, false, maximum, options)
  try {
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of transfer.stream) {
      const bytes = Buffer.from(chunk); size += bytes.length
      if (size > maximum) throw tooLarge()
      chunks.push(bytes)
    }
    if (size !== transfer.size) throw new FileTransferError('文件读取期间发生变化，请重新打开')
    return Buffer.concat(chunks, size)
  } finally { transfer.close() }
}

function attachment(file: string) {
  const name = path.posix.basename(file) || 'download'
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/** Registered behind session authentication and the application's CSRF guard.
 * Browser-managed HTTP streaming avoids Base64 RPC frame and browser Blob caps. */
export function registerFileDownloads(app: Express, dependencies: FileOptions & { getHost(id: string): Host | undefined }) {
  app.get('/api/hosts/:id/download', (req, res, next) => {
    const abort = new AbortController()
    const cancelledRequest = () => { if (!res.writableFinished) abort.abort() }
    res.once('close', cancelledRequest)
    void (async () => {
      const file = absolutePath.parse(req.query.path)
      const host = dependencies.getHost(String(req.params.id))
      if (!host) throw new FileTransferError('主机不存在或已停用', 404)
      const range = parseRange(req.headers['if-range'] ? undefined : req.headers.range)
      const transfer = await openHostFile(host, file, range, req.method === 'HEAD', undefined, dependencies, abort.signal)
      abort.signal.addEventListener('abort', transfer.close, { once: true })
      try {
        if (abort.signal.aborted) return
        res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': attachment(file), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer', 'X-Accel-Buffering': 'no' })
        if (transfer.unsatisfiable) { res.status(416).set('Content-Range', `bytes */${transfer.size}`).end(); return }
        res.status(transfer.partial ? 206 : 200).set('Content-Length', String(Math.max(0, transfer.end - transfer.start + 1)))
        if (transfer.partial) res.set('Content-Range', `bytes ${transfer.start}-${transfer.end}/${transfer.size}`)
        if (req.method === 'HEAD') res.end()
        else await pipeline(transfer.stream, res)
      } finally { abort.signal.removeEventListener('abort', transfer.close); transfer.close() }
    })().catch(error => {
      if (res.destroyed || abort.signal.aborted) return
      if (res.headersSent) res.destroy()
      else next(error instanceof z.ZodError ? Object.assign(new Error('需要有效的绝对文件路径'), { status: 400 }) : fileError(error))
    }).finally(() => res.removeListener('close', cancelledRequest))
  })
}
