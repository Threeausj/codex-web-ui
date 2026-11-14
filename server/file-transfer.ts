import { WINDOWS_PRIVATE_ACL_HELPER } from './windows-security.js';

/** Publish complete copies/uploads atomically without replacing existing items.
 * POSIX operations use directory descriptors (including macOS, which cannot
 * resolve children through /dev/fd). Symlinks are copied, never traversed. */
export function fileTransferScript(input: unknown) {
  const payload = Buffer.from(JSON.stringify(input)).toString('base64');
  const security = Buffer.from(WINDOWS_PRIVATE_ACL_HELPER).toString('base64');
  return String.raw`import os,sys,json,base64,stat,hashlib,ctypes,errno,tempfile,shutil,time,uuid
p=json.loads(base64.b64decode('${payload}'));stage=None;stage_fd=None;destination_fd=None;fds=[];locks=[];locked_dirs=set();started=time.monotonic();count=0
class Failure(Exception): pass
def token(s): return hashlib.sha256(json.dumps([s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns],separators=(',',':')).encode()).hexdigest()
def valid(n):
 if not isinstance(n,str) or n in ('','.','..') or '/' in n or '\\' in n or any(ord(c)<32 or 127<=ord(c)<=159 for c in n): return False
 if os.name=='nt':
  import re
  return not re.search(r'[<>:"|?*]',n) and not n.endswith((' ','.')) and not re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',n)
 return True
def budget():
 global count
 count+=1
 if count>20000 or time.monotonic()-started>90: raise Failure('LIMIT')
def rename(source,target,src_fd=None,dst_fd=None):
 if os.name=='nt': os.rename(source,target);return
 libc=ctypes.CDLL(None,use_errno=True)
 if hasattr(libc,'renameat2'): name='renameat2';flag=1
 elif sys.platform=='darwin' and hasattr(libc,'renameatx_np'): name='renameatx_np';flag=4
 else: raise Failure('UNSUPPORTED_RENAME')
 f=getattr(libc,name);f.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];f.restype=ctypes.c_int
 atcwd=-2 if sys.platform=='darwin' else -100
 if f(src_fd if src_fd is not None else atcwd,os.fsencode(source),dst_fd if dst_fd is not None else atcwd,os.fsencode(target),flag):
  code=ctypes.get_errno();raise OSError(code,os.strerror(code))
def copy_bytes(fd,out,before):
 opened=os.fstat(fd)
 # Python 3.12 on NTFS reports creation time through lstat().st_ctime but
 # change time through fstat().st_ctime after a rename. Compare stable identity
 # across those APIs, then use fstat-to-fstat (including ctime) during copying.
 def identity(s): return [s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns]
 if (identity(opened)!=identity(before) if os.name=='nt' else token(opened)!=token(before)): raise Failure('CONFLICT')
 with os.fdopen(fd,'rb',closefd=False) as src:
  while True:
   if time.monotonic()-started>90: raise Failure('LIMIT')
   data=src.read(1048576)
   if not data: break
   out.write(data)
  out.flush();os.fsync(out.fileno())
 if token(os.fstat(fd))!=token(opened): raise Failure('CONFLICT')
def copy_at(parent,name,target_parent,target_name,depth=0):
 budget()
 if depth>64: raise Failure('LIMIT')
 before=os.stat(name,dir_fd=parent,follow_symlinks=False)
 if stat.S_ISLNK(before.st_mode): os.symlink(os.readlink(name,dir_fd=parent),target_name,dir_fd=target_parent)
 elif stat.S_ISDIR(before.st_mode):
  source=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
  try:
   if token(os.fstat(source))!=token(before): raise Failure('CONFLICT')
   os.mkdir(target_name,0o700,dir_fd=target_parent)
   target=os.open(target_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=target_parent)
   try:
    for child in os.listdir(source): copy_at(source,child,target,child,depth+1)
    if token(os.fstat(source))!=token(before): raise Failure('CONFLICT')
    os.fchmod(target,stat.S_IMODE(before.st_mode)&0o777)
   finally: os.close(target)
  finally: os.close(source)
 elif stat.S_ISREG(before.st_mode):
  source=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
  try:
   target=os.open(target_name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=target_parent)
   with os.fdopen(target,'wb') as out:
    copy_bytes(source,out,before);os.fchmod(out.fileno(),stat.S_IMODE(before.st_mode)&0o777)
  finally: os.close(source)
 else: raise Failure('UNSUPPORTED_ENTRY')
 if token(os.stat(name,dir_fd=parent,follow_symlinks=False))!=token(before): raise Failure('CONFLICT')
def lock_windows_directory(directory):
 # Refuse reparse points and hold ancestors without FILE_SHARE_DELETE so a
 # junction/rename cannot redirect a recursive walk while it is in progress.
 from ctypes import wintypes
 kernel=ctypes.WinDLL('kernel32',use_last_error=True)
 kernel.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
 kernel.CreateFileW.restype=wintypes.HANDLE
 current=os.path.abspath(directory);ancestors=[]
 while True:
  ancestors.append(current);parent=os.path.dirname(current)
  if parent==current: break
  current=parent
 for current in reversed(ancestors):
  key=os.path.normcase(current)
  if key in locked_dirs: continue
  handle=kernel.CreateFileW(current,0,3,None,3,0x02200000,None)
  if handle==ctypes.c_void_p(-1).value: raise PermissionError()
  locks.append(handle)
  if getattr(os.lstat(current),'st_file_attributes',0)&0x400: raise Failure('UNSUPPORTED_ENTRY')
  locked_dirs.add(key)
def copy_windows(source,target,depth=0):
 budget()
 if depth>64: raise Failure('LIMIT')
 before=os.lstat(source)
 if getattr(before,'st_file_attributes',0)&0x400: raise Failure('UNSUPPORTED_ENTRY')
 if stat.S_ISDIR(before.st_mode):
  lock_windows_directory(source)
  if token(os.lstat(source))!=token(before): raise Failure('CONFLICT')
  os.mkdir(target,0o700)
  for name in os.listdir(source): copy_windows(os.path.join(source,name),os.path.join(target,name),depth+1)
 elif stat.S_ISREG(before.st_mode):
  fd=os.open(source,os.O_RDONLY|os.O_BINARY)
  try:
   with open(target,'xb') as out: copy_bytes(fd,out,before)
  finally: os.close(fd)
 else: raise Failure('UNSUPPORTED_ENTRY')
 if token(os.lstat(source))!=token(before): raise Failure('CONFLICT')
 os.chmod(target,stat.S_IMODE(before.st_mode)&0o777)
def remove_at(parent,name):
 s=os.stat(name,dir_fd=parent,follow_symlinks=False)
 if not stat.S_ISDIR(s.st_mode): os.unlink(name,dir_fd=parent);return
 fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
 try:
  os.fchmod(fd,0o700)
  for child in os.listdir(fd): remove_at(fd,child)
 finally: os.close(fd)
 os.rmdir(name,dir_fd=parent)
def cleanup_error(fn,path,exc):
 os.chmod(path,stat.S_IWRITE|stat.S_IREAD|stat.S_IEXEC);fn(path)
try:
 if not valid(p.get('name')) or p.get('newName') is not None and not valid(p['newName']): raise Failure('INVALID_NAME')
 dest_dir=os.path.realpath(p['directory']);op=p['operation'];name=p.get('newName') or p['name']
 if not os.path.isdir(dest_dir): raise NotADirectoryError()
 if os.name=='nt': lock_windows_directory(dest_dir)
 else: destination_fd=os.open(dest_dir,os.O_RDONLY|os.O_DIRECTORY);fds.append(destination_fd)
 target=os.path.join(dest_dir,name) if os.name=='nt' else name
 if os.name=='nt': exists=os.path.lexists(target)
 else:
  try: os.stat(target,dir_fd=destination_fd,follow_symlinks=False);exists=True
  except FileNotFoundError: exists=False
 if exists: raise FileExistsError()
 if op in ('copy','move'):
  source_dir=os.path.realpath(p['sourceDirectory']);source=os.path.join(source_dir,p['name'])
  before=os.lstat(source)
  if token(before)!=p['expectedVersion']: raise Failure('CONFLICT')
  actual_source=os.path.normcase(os.path.abspath(source));actual_target=os.path.normcase(os.path.join(dest_dir,name))
  try: inside=os.path.commonpath([actual_source,actual_target])==actual_source
  except ValueError: inside=False
  if actual_source==actual_target or stat.S_ISDIR(before.st_mode) and inside: raise Failure('RECURSIVE')
  source_fd=None
  if os.name=='nt': lock_windows_directory(source_dir)
  else:
   source_fd=os.open(source_dir,os.O_RDONLY|os.O_DIRECTORY);fds.append(source_fd);source=p['name']
  current=os.lstat(source) if os.name=='nt' else os.stat(source,dir_fd=source_fd,follow_symlinks=False)
  if token(current)!=token(before): raise Failure('CONFLICT')
  if op=='move': rename(source,target,source_fd,destination_fd)
  else:
   if os.name=='nt':
    stage=tempfile.mkdtemp(prefix='.codex-web-copy-',dir=dest_dir)
    exec(base64.b64decode('${security}'));windows_private_acl(stage,windows_current_sid(),True)
    temporary=os.path.join(stage,'entry');copy_windows(source,temporary)
    if token(os.lstat(source))!=p['expectedVersion']: raise Failure('CONFLICT')
    rename(temporary,target)
   else:
    stage='.codex-web-copy-'+uuid.uuid4().hex;os.mkdir(stage,0o700,dir_fd=destination_fd)
    stage_fd=os.open(stage,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=destination_fd)
    copy_at(source_fd,source,stage_fd,'entry')
    if token(os.stat(source,dir_fd=source_fd,follow_symlinks=False))!=p['expectedVersion']: raise Failure('CONFLICT')
    rename('entry',target,stage_fd,destination_fd)
 elif op=='upload':
  if os.name=='nt':
   stage=tempfile.mkdtemp(prefix='.codex-web-upload-',dir=dest_dir)
   exec(base64.b64decode('${security}'));windows_private_acl(stage,windows_current_sid(),True)
   temporary=os.path.join(stage,'entry')
  else:
   stage='.codex-web-upload-'+uuid.uuid4().hex;os.mkdir(stage,0o700,dir_fd=destination_fd)
   stage_fd=os.open(stage,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=destination_fd);temporary='entry'
  digest=hashlib.sha256();remaining=p['size']
  fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_BINARY',0),0o600,**({'dir_fd':stage_fd} if os.name!='nt' else {}))
  with os.fdopen(fd,'wb') as out:
   while remaining:
    if time.monotonic()-started>90: raise Failure('LIMIT')
    chunk=sys.stdin.buffer.read(min(1048576,remaining))
    if not chunk: raise Failure('INCOMPLETE_UPLOAD')
    digest.update(chunk);out.write(chunk);remaining-=len(chunk)
   out.flush();os.fsync(out.fileno())
  if digest.hexdigest()!=p['sha256']: raise Failure('INCOMPLETE_UPLOAD')
  rename(temporary,target,stage_fd,destination_fd)
 else: raise Failure('INVALID_INPUT')
 s=os.lstat(target) if os.name=='nt' else os.stat(target,dir_fd=destination_fd,follow_symlinks=False)
 result={'ok':True,'isDirectory':stat.S_ISDIR(s.st_mode),'version':token(s)}
except Exception as error:
 code=str(error) if isinstance(error,Failure) else 'EXISTS' if isinstance(error,FileExistsError) else 'MISSING' if isinstance(error,FileNotFoundError) else 'PERMISSION' if isinstance(error,PermissionError) else 'NOT_DIRECTORY' if isinstance(error,NotADirectoryError) else 'CROSS_DEVICE' if isinstance(error,OSError) and error.errno==errno.EXDEV else 'FAILED'
 result={'ok':False,'code':code}
finally:
 if stage_fd is not None: os.close(stage_fd)
 if stage is not None:
  try:
   if os.name=='nt': shutil.rmtree(stage,onerror=cleanup_error)
   else: remove_at(destination_fd,stage)
  except OSError: pass
 for fd in reversed(fds): os.close(fd)
 if locks:
  kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.CloseHandle.argtypes=[ctypes.c_void_p]
  for handle in reversed(locks): kernel.CloseHandle(handle)
print(json.dumps(result,separators=(',',':')))
`;
}
