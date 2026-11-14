import type { Express } from 'express';
import { z } from 'zod';
import type { Host } from './types.js';
import type { BridgeOptions } from './bridge.js';
import { runHostPython } from './host-helper.js';
import { validFileEntryName, type FileEntryChange } from '../shared/file-entries.js';
import { isAbsoluteHostPath, normalizeHostPath, joinHostPath } from '../shared/host-path.js';
import { windowsFileEntryScript } from './windows-files.js';
import { fileTransferScript } from './file-transfer.js';

const directory = z.string().min(1).max(4096).refine(isAbsoluteHostPath).transform(normalizeHostPath);
const name = z.string().refine(validFileEntryName, '名称不能为空，且不能包含路径分隔符或控制字符');
const version = z.string().regex(/^[a-f0-9]{64}$/);
const inspect = z.object({ directory, name }).strict();
const mutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('createFile'), directory, name }).strict(),
  z.object({ operation: z.literal('createDirectory'), directory, name }).strict(),
  z.object({ operation: z.literal('rename'), directory, name, newName: name, expectedVersion: version }).strict(),
  z.object({ operation: z.literal('delete'), directory, name, expectedVersion: version, confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.enum(['copy', 'move']), directory, sourceDirectory: directory, name, newName: name, expectedVersion: version }).strict(),
]);
export function fileEntryScript(input: unknown) {
  const encoded = Buffer.from(JSON.stringify(input)).toString('base64');
  return `import os,sys,json,base64,stat,hashlib,ctypes,errno
p=json.loads(base64.b64decode('${encoded}'))
fd=None
def token(s):
 return hashlib.sha256(json.dumps([s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns],separators=(',',':')).encode()).hexdigest()
def remove_tree(parent,n):
 child=os.open(n,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
 try:
  for entry in os.listdir(child):
   s=os.stat(entry,dir_fd=child,follow_symlinks=False)
   if stat.S_ISDIR(s.st_mode): remove_tree(child,entry)
   else: os.unlink(entry,dir_fd=child)
 finally: os.close(child)
 os.rmdir(n,dir_fd=parent)
try:
 fd=os.open(p['directory'],os.O_RDONLY|os.O_DIRECTORY)
 n=p['name']; op=p['operation']
 if op=='createFile':
  item=os.open(n,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644,dir_fd=fd);os.close(item)
 elif op=='createDirectory': os.mkdir(n,0o755,dir_fd=fd)
 else:
  s=os.stat(n,dir_fd=fd,follow_symlinks=False)
  if op!='inspect' and token(s)!=p['expectedVersion']: raise RuntimeError('CONFLICT')
  if op=='rename':
   dst=p['newName'];libc=ctypes.CDLL(None,use_errno=True)
   if n==dst: pass
   elif hasattr(libc,'renameat2'):
    f=libc.renameat2;f.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];f.restype=ctypes.c_int
    if f(fd,os.fsencode(n),fd,os.fsencode(dst),1)!=0:
     e=ctypes.get_errno();raise OSError(e,os.strerror(e))
   elif sys.platform=='darwin' and hasattr(libc,'renameatx_np'):
    f=libc.renameatx_np;f.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];f.restype=ctypes.c_int
    if f(fd,os.fsencode(n),fd,os.fsencode(dst),4)!=0:
     e=ctypes.get_errno();raise OSError(e,os.strerror(e))
   else: raise RuntimeError('UNSUPPORTED_RENAME')
   n=dst
  elif op=='delete':
   if stat.S_ISDIR(s.st_mode): remove_tree(fd,n)
   else: os.unlink(n,dir_fd=fd)
 if op!='delete':
  s=os.stat(n,dir_fd=fd,follow_symlinks=False)
  result={'ok':True,'version':token(s),'isDirectory':stat.S_ISDIR(s.st_mode),'isSymlink':stat.S_ISLNK(s.st_mode)}
 else: result={'ok':True,'isDirectory':stat.S_ISDIR(s.st_mode)}
except Exception as e:
 code='CONFLICT' if str(e)=='CONFLICT' else 'UNSUPPORTED_RENAME' if str(e)=='UNSUPPORTED_RENAME' else 'EXISTS' if isinstance(e,FileExistsError) else 'MISSING' if isinstance(e,FileNotFoundError) else 'PERMISSION' if isinstance(e,PermissionError) else 'NOT_DIRECTORY' if isinstance(e,NotADirectoryError) else 'FAILED'
 result={'ok':False,'code':code}
finally:
 if fd is not None: os.close(fd)
print(json.dumps(result,separators=(',',':')))
`;
}
export const fileEntryFailures: Record<string, { status: number; error: string }> = {
  RECURSIVE: { status: 400, error: '不能将文件夹复制或移动到自身或其子目录。' },
  CROSS_DEVICE: { status: 409, error: '源和目标位于不同文件系统；请先复制，核对完成后再删除源文件。原文件已保留。' },
  LIMIT: { status: 413, error: '文件操作超出时间或条目上限，请缩小范围后重试；原文件已保留。' },
  UNSUPPORTED_ENTRY: { status: 400, error: '此项包含特殊文件或 Windows 链接，无法安全复制；请使用主机文件管理器处理。' },
  INCOMPLETE_UPLOAD: { status: 400, error: '上传内容不完整或校验失败，目标文件未发布，请重试。' },
  INVALID_NAME: { status: 400, error: '此名称不适用于 Windows，请避免保留设备名、特殊字符以及结尾的空格或句点。' },
  EXISTS: { status: 409, error: '同名文件或文件夹已存在，请使用其他名称。' },
  MISSING: { status: 404, error: '文件或目录已不存在，请刷新列表后重试。' },
  CONFLICT: { status: 409, error: '文件或目录已被其他程序修改，请刷新后重新操作。' },
  PERMISSION: { status: 403, error: '没有权限修改此目录，请检查目标主机的文件权限。' },
  NOT_DIRECTORY: { status: 400, error: '父路径不是文件夹，请重新选择目录。' },
  UNSUPPORTED_RENAME: { status: 501, error: '目标系统暂不支持安全重命名，原文件未被覆盖。' },
  FAILED: { status: 502, error: '文件操作未完成，请刷新目录并检查主机连接和文件权限。' },
};
type Dependencies = { getHost: (id: string) => Host | undefined; bridgeOptions?: BridgeOptions; run?: (host: Host, source: string) => Promise<string> };
export function registerFileEntries(app: Express, dependencies: Dependencies) {
  const operations = new Map<string, Promise<unknown>>();
  const route = (schema: typeof inspect | typeof mutation, inspection: boolean) => (req: any, res: any, next: any) => {
    void (async () => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: '文件操作参数无效，请检查名称、目录和确认信息。' }); return; }
      const hostId = String(req.params.id), host = dependencies.getHost(hostId);
      if (!host) { res.status(404).json({ error: '主机不存在或已停用' }); return; }
      const fields = parsed.data;
      const input = { ...fields, ...(inspection ? { operation: 'inspect' } : {}) };
      const key = JSON.stringify([hostId, host.platform === 'windows' ? fields.directory.toLowerCase() : fields.directory]);
      const work = (operations.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
        if (dependencies.getHost(hostId) !== host) throw Object.assign(new Error('主机配置已变化，请重新操作。'), { status: 409 });
        const transfer = 'operation' in input && typeof input.operation === 'string' && ['copy', 'move'].includes(input.operation);
        const script = transfer ? fileTransferScript(input) : host.platform === 'windows' ? windowsFileEntryScript(input) : fileEntryScript(input);
        const result = JSON.parse(await (dependencies.run ? dependencies.run(host, script) : runHostPython(host, script, dependencies.bridgeOptions, { timeoutMs: transfer ? 110000 : 45000 })));
        if (result.ok !== true) { const failure = fileEntryFailures[result.code] || fileEntryFailures.FAILED!; res.status(failure.status).json({ error: failure.error, code: result.code }); return; }
        if (inspection) { res.json({ version: result.version, isDirectory: result.isDirectory, isSymlink: result.isSymlink }); return; }
        const operation = (fields as z.infer<typeof mutation>).operation;
        const source = joinHostPath((fields as any).sourceDirectory || fields.directory, fields.name);
        const target = ['rename', 'copy', 'move'].includes(operation) ? joinHostPath(fields.directory, (fields as any).newName) : source;
        res.json({ hostId, directory: fields.directory, operation, path: target,
          ...(['rename', 'delete', 'move'].includes(operation) ? { previousPath: source } : {}), isDirectory: result.isDirectory } satisfies FileEntryChange);
      });
      operations.set(key, work);
      try { await work; } finally { if (operations.get(key) === work) operations.delete(key); }
    })().catch(next);
  };
  app.post('/api/hosts/:id/file-entries/inspect', route(inspect, true));
  app.post('/api/hosts/:id/file-entries', route(mutation, false));
}
