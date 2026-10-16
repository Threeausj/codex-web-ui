import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Express, RequestHandler } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type { Bridge, BridgeOptions } from './bridge.js'
import { runHostPython } from './host-helper.js'
import type { Host } from './types.js'

export type RemoteUploadInput = {
  action: 'prepare' | 'write' | 'cleanup'
  cwd: string
  uploadId: string
  filename?: string
  dataBase64?: string
  filenames?: string[]
}

/** Only this fixed server-owned operation runs over SSH. Paths, names and bytes
 * travel as literal data on stdin, never as commands or model tool requests. */
export function remoteUploadSource(input: RemoteUploadInput): string {
  const payload = Buffer.from(JSON.stringify(input)).toString('base64')
  return String.raw`
import base64,binascii,errno,json,os,re,stat
p=json.loads(base64.b64decode('${payload}'))
fds=[]
base_fd=None
child_fd=None
created_directory=False
created_file=False
class UploadError(Exception):
    def __init__(self,code): self.code=code
def safe_name(value):
    return isinstance(value,str) and value not in ('','.','..') and '/' not in value and '\\' not in value and not any(ord(c)<32 or ord(c)==127 for c in value)
def directory(name,parent=None):
    try: fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    except OSError as error:
        if error.errno in (errno.ELOOP,errno.ENOTDIR): raise UploadError('UNSAFE_DIRECTORY')
        raise
    fds.append(fd)
    info=os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid(): raise UploadError('UNSAFE_DIRECTORY')
    return fd
def private(fd):
    if stat.S_IMODE(os.fstat(fd).st_mode)!=0o700: raise UploadError('UNSAFE_DIRECTORY')
def validate():
    if p.get('action') not in ('prepare','write','cleanup'): raise UploadError('INVALID_INPUT')
    cwd=p.get('cwd')
    if not isinstance(cwd,str) or not cwd.startswith('/') or len(cwd)>4096 or any(ord(c)<32 or ord(c)==127 for c in cwd): raise UploadError('INVALID_INPUT')
    if not isinstance(p.get('uploadId'),str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',p['uploadId']): raise UploadError('INVALID_INPUT')
    if p['action']=='write':
        if not safe_name(p.get('filename')) or not isinstance(p.get('dataBase64'),str) or len(p['dataBase64'])>27962028: raise UploadError('INVALID_INPUT')
    if p['action']=='cleanup':
        names=p.get('filenames',[])
        if not isinstance(names,list) or len(names)>8 or not all(safe_name(name) for name in names): raise UploadError('INVALID_INPUT')
try:
    validate()
    # Project paths may intentionally be symlinks. The managed upload base and
    # unique child must be real directories owned by the connected SSH user.
    parent_fd=os.open(p['cwd'],os.O_RDONLY|os.O_DIRECTORY)
    fds.append(parent_fd)
    if p['action']=='prepare':
        try: os.mkdir('.codex-web-uploads',0o700,dir_fd=parent_fd)
        except FileExistsError: pass
    base_fd=directory('.codex-web-uploads',parent_fd)
    if p['action']=='prepare': os.fchmod(base_fd,0o700)
    private(base_fd)
    if p['action']=='prepare':
        try: os.mkdir(p['uploadId'],0o700,dir_fd=base_fd)
        except FileExistsError: raise UploadError('DIRECTORY_EXISTS')
        created_directory=True
    child_fd=directory(p['uploadId'],base_fd)
    if p['action']=='prepare': os.fchmod(child_fd,0o700)
    private(child_fd)
    if p['action']=='write':
        try: data=base64.b64decode(p['dataBase64'],validate=True)
        except (binascii.Error,ValueError): raise UploadError('INVALID_INPUT')
        if len(data)>20*1024*1024: raise UploadError('INVALID_INPUT')
        try: fd=os.open(p['filename'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=child_fd)
        except FileExistsError: raise UploadError('FILE_EXISTS')
        created_file=True
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_nlink!=1: raise UploadError('UNSAFE_DIRECTORY')
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'wb') as out:
                fd=None
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
        finally:
            if fd is not None: os.close(fd)
    elif p['action']=='cleanup':
        for name in p.get('filenames',[]):
            try: os.unlink(name,dir_fd=child_fd)
            except FileNotFoundError: pass
        os.rmdir(p['uploadId'],dir_fd=base_fd)
    print(json.dumps({'ok':True}))
except Exception as error:
    # Remove only artifacts this invocation created. Never traverse or remove
    # the shared base, an existing UUID directory, or a linked destination.
    if created_file and child_fd is not None:
        try: os.unlink(p['filename'],dir_fd=child_fd)
        except OSError: pass
    if created_directory and base_fd is not None:
        try: os.rmdir(p['uploadId'],dir_fd=base_fd)
        except OSError: pass
    if p.get('action')=='cleanup' and isinstance(error,FileNotFoundError):
        print(json.dumps({'ok':True}))
    else:
        code=error.code if isinstance(error,UploadError) else 'NOT_WRITABLE' if isinstance(error,PermissionError) else 'INVALID_INPUT' if isinstance(error,(ValueError,UnicodeError)) else 'WRITE_FAILED'
        print(json.dumps({'ok':False,'code':code}))
finally:
    for fd in reversed(fds):
        try: os.close(fd)
        except OSError: pass
`
}

const failures: Record<string, { status: number; message: string }> = {
  UNSAFE_DIRECTORY: { status: 409, message: '远程上传目录不是安全的私有目录，请检查项目下 .codex-web-uploads 的符号链接、所有者和权限。' },
  NOT_WRITABLE: { status: 403, message: '无法写入远程上传目录，请检查 SSH 账户对项目目录的写入权限。' },
  DIRECTORY_EXISTS: { status: 409, message: '本次上传目录已存在，请重新上传。' },
  FILE_EXISTS: { status: 409, message: '上传目标文件已存在，请重新上传。' },
  INVALID_INPUT: { status: 400, message: '上传路径或文件信息不正确，请重新选择文件。' },
  WRITE_FAILED: { status: 500, message: '远程文件上传失败，请检查目标主机的磁盘空间和目录权限后重试。' },
}

type Dependencies = {
  getHost(id: string): Host | undefined
  getBridge(id: string): Promise<Bridge>
  cwd: string
  dataDir: string
  bridgeOptions?: BridgeOptions
  runRemote?: (host: Host, source: string) => Promise<string>
}
const absolutePath = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value), '需要绝对项目路径')
const route = (handler: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next) }

export function registerUploads(app: Express, dependencies: Dependencies) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { files: 8, fileSize: 20 * 1024 * 1024, fields: 4, fieldSize: 8192 } })
  const execute = dependencies.runRemote ?? ((host: Host, source: string) => runHostPython(host, source, dependencies.bridgeOptions, { timeoutMs: 60000 }))
  const remote = async (host: Host, input: RemoteUploadInput) => {
    const output = await execute(host, remoteUploadSource(input))
    let result: { ok?: boolean; code?: string }
    try { result = JSON.parse(output) }
    catch { throw new Error('远程上传返回格式不正确，请检查 SSH 连接后重试。') }
    if (result?.ok === true) return
    const failure = failures[result?.code || ''] ?? failures.WRITE_FAILED!
    throw Object.assign(new Error(failure.message), { status: failure.status })
  }
  app.post('/api/uploads', upload.array('files', 8), route(async (req, res) => {
    const files = req.files as Express.Multer.File[] | undefined
    if (!files?.length) { res.status(400).json({ error: 'Select at least one file' }); return }
    const hostId = z.string().default('local').parse(req.body?.hostId)
    const host = dependencies.getHost(hostId)
    if (!host) { res.status(404).json({ error: 'Host not found' }); return }
    const uploadId = randomUUID()
    const uploadCwd = host.kind === 'local' ? dependencies.cwd : absolutePath.parse(req.body?.cwd || host.cwd)
    const baseDirectory = host.kind === 'local' ? path.join(dependencies.dataDir, 'uploads') : path.posix.join(uploadCwd, '.codex-web-uploads')
    const directory = path.posix.join(baseDirectory, uploadId)
    const entries = files.map((file, index) => {
      const name = path.posix.basename(file.originalname.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'upload'
      return { file, name, filename: `${index}-${name}` }
    })
    let prepared = false
    const written: string[] = []
    try {
      if (host.kind === 'local') {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        await fs.chmod(baseDirectory, 0o700)
        await fs.chmod(directory, 0o700)
      } else {
        await remote(host, { action: 'prepare', cwd: uploadCwd, uploadId })
        prepared = true
      }
      const bridge = host.kind === 'local' ? await dependencies.getBridge(hostId) : undefined
      const saved: { name: string; path: string; mime: string; size: number }[] = []
      for (const { file, name, filename } of entries) {
        const destination = path.posix.join(directory, filename)
        if (bridge) {
          await bridge.request('fs/writeFile', { path: destination, dataBase64: file.buffer.toString('base64') })
          await fs.chmod(destination, 0o600)
        } else {
          await remote(host, { action: 'write', cwd: uploadCwd, uploadId, filename, dataBase64: file.buffer.toString('base64') })
          written.push(filename)
        }
        saved.push({ name, path: destination, mime: file.mimetype, size: file.size })
      }
      res.status(201).json({ files: saved })
    } catch (error) {
      if (prepared) await remote(host, { action: 'cleanup', cwd: uploadCwd, uploadId, filenames: written }).catch(() => {})
      throw error
    }
  }))
}
