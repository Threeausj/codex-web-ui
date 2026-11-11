import { gzipSync } from 'node:zlib';
/** Keep paths out of SSH shell parsing and preserve native byte streams. The
 * compressed wrapper also stays below cmd.exe's command-length limit. */
export function powershellCommand(source: string) {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(powershellScript(source), 'utf16le').toString('base64')}`;
}
function powershellScript(source: string) {
  const compressed = gzipSync(Buffer.from(source)).toString('base64');
  return `$s=[IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}'));$g=[IO.Compression.GZipStream]::new($s,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);& ([scriptblock]::Create($r.ReadToEnd()))`;
}
export function powershellLiteral(value: string) { return `'${value.replace(/'/g, "''")}'`; }
export function windowsQuoteArgument(value: string) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
/** PowerShell's console host can consume subsequent stdin packets. Keep the
 * long-lived protocol and binary readers directly on native SSH handles. */
export function windowsPythonCommand(source: string, shell: 'cmd' | 'powershell' = 'cmd') {
  const encoded = gzipSync(Buffer.from(source)).toString('base64');
  const expression = `exec(__import__('gzip').decompress(__import__('base64').b64decode('${encoded}')))`;
  if (shell === 'powershell') return powershellScript(windowsBootstrap + '\n$python=Resolve-Python\n' +
    `Run-Native $python ${powershellLiteral(['-X', 'utf8', '-u', '-c', expression].map(windowsQuoteArgument).join(' '))}`);
  const program = `-X utf8 -u -c "${expression}"`;
  const bundled = '"%USERPROFILE%\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe"';
  return `if exist ${bundled} (${bundled} ${program}) else (python.exe ${program})`;
}
export function windowsCodexCommand(command: string, args: string[], cwd?: string, codexHome?: string, probeVersion = false, shell?: 'cmd' | 'powershell') {
  const config = Buffer.from(JSON.stringify({ command, args, cwd, codexHome, probeVersion })).toString('base64');
  return windowsPythonCommand(`import os,sys,base64,json,pathlib,shutil,subprocess
p=json.loads(base64.b64decode('${config}'))
home=pathlib.Path.home();local=pathlib.Path(os.environ.get('LOCALAPPDATA',home/'AppData'/'Local'))
config_home=pathlib.Path(p.get('codexHome') or os.environ.get('CODEX_HOME') or home/'.codex')
runtime=home/'.cache'/'codex-runtimes'/'codex-primary-runtime'
os.environ['PYTHONUTF8']='1';os.environ['PYTHONIOENCODING']='utf-8'
os.environ['PATH']=os.pathsep.join(str(directory) for directory in [runtime/'dependencies'/'node'/'bin',runtime/'dependencies'/'native'/'git'/'cmd'])+os.pathsep+os.environ.get('PATH','')
git=pathlib.Path(os.environ.get('ProgramFiles','C:/Program Files'))/'Git'/'cmd'
if git.is_dir(): os.environ['PATH']=str(git)+os.pathsep+os.environ['PATH']
exe=None
if p['command']!='codex': exe=shutil.which(p['command']) or (p['command'] if pathlib.Path(p['command']).is_file() else None)
else:
 exe=shutil.which('codex.exe')
 if not exe:
  for candidate in (local/'Programs'/'OpenAI'/'Codex'/'bin'/'codex.exe',config_home/'packages'/'standalone'/'current'/'bin'/'codex.exe',config_home/'packages'/'app-server-daemon'/'current'/'bin'/'codex.exe',home/'.local'/'bin'/'codex.exe'):
   if candidate.is_file(): exe=str(candidate);break
 if not exe:
  directory=local/'OpenAI'/'Codex'/'bin'
  candidates=sorted((file for file in directory.glob('*/codex.exe') if file.is_file()),key=lambda file:file.stat().st_mtime,reverse=True)
  if candidates: exe=str(candidates[0])
 if not exe:
  query="(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"
  result=subprocess.run(['powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-Command',query],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15)
  root=result.stdout.decode('utf-8','replace').strip()
  candidate=pathlib.Path(root)/'app'/'resources'/'codex.exe' if root else None
  if candidate and candidate.is_file(): exe=str(candidate)
 if not exe:
  candidate=local/'Programs'/'Codex++'/'resources'/'codex.exe'
  if candidate.is_file(): exe=str(candidate)
if not exe: sys.exit('Codex was not found in PATH or the installed desktop application')
if exe.lower().endswith('.cmd'): sys.exit('Configure the native codex.exe executable instead of a command wrapper')
if p.get('cwd'): os.chdir(p['cwd'])
if p.get('codexHome'): os.environ['CODEX_HOME']=p['codexHome']
if p['probeVersion']:
 result=subprocess.run([exe,'--version'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
 sys.stderr.write('__CODEX_WEB_VERSION__='+result.stdout.decode('utf-8','replace').strip()+'\\n');sys.stderr.flush()
# Windows execv starts another process and exits the SSH-owned parent. Keep
# this parent alive so OpenSSH does not tear down the new server's job/handles.
sys.exit(subprocess.call([exe]+p['args']))
`, shell);
}
export const windowsBootstrap = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$env:PYTHONUTF8='1'; $env:PYTHONIOENCODING='utf-8'
$runtime=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime'
$env:Path=(Join-Path $runtime 'dependencies\node\bin')+';'+$env:Path
function Resolve-Python {
 $bundled=Join-Path $runtime 'dependencies\python\python.exe'
 if(Test-Path -LiteralPath $bundled){return $bundled}
 foreach($name in @('python3.exe','python.exe')){$found=Get-Command $name -ErrorAction SilentlyContinue;if($found -and $found.Source -notmatch '\\Microsoft\\WindowsApps\\'){return $found.Source}}
 throw 'Python 3 was not found on this host'
}
function Run-Native([string]$file,[string]$arguments) {
 # Console streams in Windows PowerShell can block inside CopyToAsync before
 # returning a Task. Independent native threads preserve duplex RPC traffic.
 Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
public static class CodexWebNativeRelay {
 static Thread Pump(Stream input, Stream output, bool close) {
  var thread=new Thread(()=>{try{var bytes=new byte[16384];int count;while((count=input.Read(bytes,0,bytes.Length))>0){output.Write(bytes,0,count);output.Flush();}}catch(IOException){}catch(ObjectDisposedException){}finally{if(close)try{output.Close();}catch(IOException){}}});
  thread.IsBackground=true;thread.Start();return thread;
 }
 public static int Run(string file,string arguments) {
  var start=new ProcessStartInfo(file,arguments){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
  using(var process=Process.Start(start)) {
   Pump(Console.OpenStandardInput(),process.StandardInput.BaseStream,true);
   var output=Pump(process.StandardOutput.BaseStream,Console.OpenStandardOutput(),false);
   var error=Pump(process.StandardError.BaseStream,Console.OpenStandardError(),false);
   process.WaitForExit();output.Join();error.Join();return process.ExitCode;
  }
 }
}
'@
 exit [CodexWebNativeRelay]::Run($file,$arguments)
}
`;
