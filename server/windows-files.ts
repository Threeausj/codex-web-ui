/** Windows rename is atomic and refuses an existing destination. */
export function windowsFileEntryScript(input: unknown) {
  const data = Buffer.from(JSON.stringify(input)).toString('base64');
  return `import os,json,base64,stat,hashlib,shutil,re
p=json.loads(base64.b64decode('${data}'))
def token(s): return hashlib.sha256(json.dumps([s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns],separators=(',',':')).encode()).hexdigest()
def valid(n):
 return isinstance(n,str) and n not in ('','.','..') and not re.search(r'[<>:"/\\\\|?*\\x00-\\x1f]',n) and not n.endswith((' ','.')) and not re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?',n)
try:
 n=p['name'];op=p['operation']
 if not valid(n) or op=='rename' and not valid(p.get('newName')): raise RuntimeError('INVALID_NAME')
 if not os.path.isdir(p['directory']): raise NotADirectoryError()
 file=os.path.join(p['directory'],n)
 if op=='createFile':
  fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_BINARY,0o600);os.close(fd)
 elif op=='createDirectory': os.mkdir(file)
 else:
  s=os.lstat(file)
  if op!='inspect' and token(s)!=p['expectedVersion']: raise RuntimeError('CONFLICT')
  if op=='rename':
   target=os.path.join(p['directory'],p['newName']);os.rename(file,target);file=target
  elif op=='delete':
   if stat.S_ISDIR(s.st_mode):
    if getattr(s,'st_file_attributes',0)&0x400: os.rmdir(file)
    else: shutil.rmtree(file)
   else: os.unlink(file)
 if op!='delete':
  s=os.lstat(file);result={'ok':True,'version':token(s),'isDirectory':stat.S_ISDIR(s.st_mode),'isSymlink':bool(getattr(s,'st_file_attributes',0)&0x400)}
 else: result={'ok':True,'isDirectory':stat.S_ISDIR(s.st_mode)}
except Exception as e:
 code=str(e) if str(e) in ('CONFLICT','INVALID_NAME') else 'EXISTS' if isinstance(e,FileExistsError) else 'MISSING' if isinstance(e,FileNotFoundError) else 'PERMISSION' if isinstance(e,PermissionError) else 'NOT_DIRECTORY' if isinstance(e,NotADirectoryError) else 'FAILED'
 result={'ok':False,'code':code}
print(json.dumps(result,separators=(',',':')))
`;
}
