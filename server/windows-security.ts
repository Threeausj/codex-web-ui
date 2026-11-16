/** Native NTFS permissions for managed files. chmod does not restrict Windows
 * DACLs; protected, SID-only ACLs also work for that user's unelevated daemon. */
export const WINDOWS_PRIVATE_ACL_HELPER = String.raw`
import ctypes,csv,subprocess,re
from ctypes import wintypes as w
adv=ctypes.WinDLL('advapi32',use_last_error=True);kernel=ctypes.WinDLL('kernel32',use_last_error=True)
adv.GetNamedSecurityInfoW.argtypes=[w.LPWSTR,w.DWORD,w.DWORD,ctypes.POINTER(ctypes.c_void_p),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.POINTER(ctypes.c_void_p)]
adv.ConvertSidToStringSidW.argtypes=[ctypes.c_void_p,ctypes.POINTER(w.LPWSTR)]
adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes=[w.LPCWSTR,w.DWORD,ctypes.POINTER(ctypes.c_void_p),ctypes.c_void_p]
adv.GetSecurityDescriptorDacl.argtypes=[ctypes.c_void_p,ctypes.POINTER(w.BOOL),ctypes.POINTER(ctypes.c_void_p),ctypes.POINTER(w.BOOL)]
adv.SetNamedSecurityInfoW.argtypes=[w.LPWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p]
kernel.LocalFree.argtypes=[ctypes.c_void_p]
def windows_current_sid():
 record=subprocess.run(['whoami','/user','/fo','csv','/nh'],capture_output=True,text=True,timeout=5)
 rows=list(csv.reader(record.stdout.splitlines()));sid=rows[0][-1] if rows else ''
 if record.returncode or not re.fullmatch(r'S-1-[0-9-]+',sid): raise OSError('Cannot identify file owner')
 return sid
def windows_owner(path):
 sid=ctypes.c_void_p();sd=ctypes.c_void_p();text=w.LPWSTR()
 if adv.GetNamedSecurityInfoW(path,1,1,ctypes.byref(sid),None,None,None,ctypes.byref(sd)): raise OSError('Cannot verify file owner')
 try:
  if not adv.ConvertSidToStringSidW(sid,ctypes.byref(text)): raise OSError('Cannot identify file owner')
  try: return text.value
  finally: kernel.LocalFree(text)
 finally: kernel.LocalFree(sd)
def windows_private_acl(path,sid,directory=False):
 if not re.fullmatch(r'S-1-[0-9-]+',sid): raise OSError('Invalid file owner')
 sd=ctypes.c_void_p();dacl=ctypes.c_void_p();present=w.BOOL();defaulted=w.BOOL()
 descriptor='D:P(A;'+('OICI' if directory else '')+';FA;;;'+sid+')'
 if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor,1,ctypes.byref(sd),None): raise OSError('Cannot secure file')
 try:
  if not adv.GetSecurityDescriptorDacl(sd,ctypes.byref(present),ctypes.byref(dacl),ctypes.byref(defaulted)) or adv.SetNamedSecurityInfoW(path,1,0x80000004,None,None,dacl,None): raise OSError('Cannot secure file')
 finally: kernel.LocalFree(sd)
`;
