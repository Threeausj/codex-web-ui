import { WINDOWS_PRIVATE_ACL_HELPER } from './windows-security.js';
import type { RemoteUploadInput } from './uploads.js';

/** Restrict managed upload directories using NTFS DACLs, not chmod bits. */
export function windowsUploadSource(input: RemoteUploadInput) {
  const data = Buffer.from(JSON.stringify(input)).toString('base64');
  return `import os,json,base64,binascii,stat,re,csv,subprocess,ctypes
from ctypes import wintypes as w
p=json.loads(base64.b64decode('${data}'));created_directory=False;created_file=False;child=None;file=None
class UploadError(Exception):
 def __init__(self,code): self.code=code
def safe(n): return isinstance(n,str) and n not in ('','.','..') and not re.search(r'[<>:"/\\\\|?*\\x00-\\x1f]',n) and not n.endswith((' ','.'))
${WINDOWS_PRIVATE_ACL_HELPER}
def directory(path,secure=False):
 s=os.lstat(path)
 if not stat.S_ISDIR(s.st_mode) or getattr(s,'st_file_attributes',0)&0x400: raise UploadError('UNSAFE_DIRECTORY')
 try: owned=windows_owner(path)
 except OSError: raise UploadError('UNSAFE_DIRECTORY')
 if owned!=user_sid and not (owned=='S-1-5-32-544' and ctypes.windll.shell32.IsUserAnAdmin()): raise UploadError('UNSAFE_DIRECTORY')
 if secure:
  try: windows_private_acl(path,user_sid,True)
  except OSError: raise UploadError('UNSAFE_DIRECTORY')
try:
 action=p.get('action');cwd=p.get('cwd');uid=p.get('uploadId')
 if action not in ('prepare','write','cleanup') or not isinstance(cwd,str) or not os.path.isabs(cwd) or not re.fullmatch(r'[a-f0-9-]{36}',uid or ''): raise UploadError('INVALID_INPUT')
 user_sid=windows_current_sid()
 base=os.path.join(cwd,'.codex-web-uploads');child=os.path.join(base,uid)
 if action=='prepare':
  try: os.mkdir(base)
  except FileExistsError: pass
 directory(base,secure=action=='prepare')
 if action=='prepare':
  try: os.mkdir(child)
  except FileExistsError: raise UploadError('DIRECTORY_EXISTS')
  created_directory=True
 directory(child,secure=action=='prepare')
 if action=='write':
  if not safe(p.get('filename')): raise UploadError('INVALID_INPUT')
  value=base64.b64decode(p.get('dataBase64',''),validate=True)
  if len(value)>20*1024*1024: raise UploadError('INVALID_INPUT')
  file=os.path.join(child,p['filename']);fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_BINARY,0o600);created_file=True
  with os.fdopen(fd,'wb') as out: out.write(value);out.flush();os.fsync(out.fileno())
 elif action=='cleanup':
  names=p.get('filenames',[])
  if not isinstance(names,list) or len(names)>8 or not all(safe(n) for n in names): raise UploadError('INVALID_INPUT')
  for name in names:
   try: os.unlink(os.path.join(child,name))
   except FileNotFoundError: pass
  os.rmdir(child)
 print(json.dumps({'ok':True}))
except Exception as e:
 if created_file and file:
  try: os.unlink(file)
  except OSError: pass
 if created_directory and child:
  try: os.rmdir(child)
  except OSError: pass
 code=e.code if isinstance(e,UploadError) else 'NOT_WRITABLE' if isinstance(e,PermissionError) else 'FILE_EXISTS' if isinstance(e,FileExistsError) else 'WRITE_FAILED'
 print(json.dumps({'ok':True} if p.get('action')=='cleanup' and isinstance(e,FileNotFoundError) else {'ok':False,'code':code}))
`;
}
