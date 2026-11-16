import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { powershellCommand, powershellLiteral, windowsBootstrap, windowsQuoteArgument } from './windows-shell.js';
import { hostPythonInput, remoteCodexCommand, sshPythonArgs, sshAppServerArgs } from './ssh.js';

function source(command:string) {
 const wrapper=command.includes(' -EncodedCommand ') ? Buffer.from(command.split(' -EncodedCommand ')[1]!, 'base64').toString('utf16le') : command;
 return gunzipSync(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(wrapper)![1]!, 'base64')).toString('utf8');
}
test('Windows launcher keeps Unicode and shell metacharacters inside encoded data below cmd limits', () => {
 const host={id:'windows',name:'Windows',kind:'ssh' as const,hostname:'host.test',platform:'windows' as const,cwd:'C:/中文 & 项目',codexPath:"C:/Program Files/O'Name/codex.exe"};
 const command=remoteCodexCommand(host,'proxy',true,true);
 assert.ok(command.length<8191);
 assert.match(command,/^if exist/);
 assert.ok(!command.includes(host.cwd));assert.ok(!command.includes(host.codexPath));
 const program=gunzipSync(Buffer.from(/b64decode\('([^']+)'\)/.exec(command)![1]!,'base64')).toString();
 const config=JSON.parse(Buffer.from(/p=json.loads\(base64.b64decode\('([^']+)'\)\)/.exec(program)![1]!,'base64').toString());
 assert.deepEqual(config,{command:host.codexPath,args:['app-server','proxy'],cwd:host.cwd,probeVersion:true});
 assert.equal(powershellLiteral("a'$(whoami)"),"'a''$(whoami)'");
 assert.equal(windowsQuoteArgument('C:\\a b\\'), '"C:\\a b\\\\"');
 assert.equal(source(powershellCommand(windowsBootstrap)),windowsBootstrap);
});

test('Windows fixed helpers are framed on stdin, preserve host pinning and reject unreliable persistent PowerShell transports', () => {
 const host={id:'windows',name:'Windows',kind:'ssh' as const,hostname:'host.test',platform:'windows' as const};
 const pin={file:'/test/pinned-key',hostKeyAlias:'fixed-host'};
 const args=sshPythonArgs(host,pin,{socketPath:'/test/control',windowsShell:'powershell'});
 assert.ok(args.includes('StrictHostKeyChecking=yes'));
 assert.ok(args.includes('HostKeyAlias=fixed-host'));
 const relay=source(args.at(-1)!);
 const encoded=/b64decode\(''([^']+)''\)/.exec(relay)![1]!;
 assert.match(gunzipSync(Buffer.from(encoded,'base64')).toString(),/sys.stdin.buffer.readline/);
 assert.equal(Buffer.from(hostPythonInput(host,'print("中文")').trim(),'base64').toString(), 'print("中文")');
 assert.equal(hostPythonInput({...host,platform:'posix'},'print(1)'), 'print(1)');
 assert.throws(()=>sshAppServerArgs(host,'spawn',false,pin,{socketPath:'/test/control',windowsShell:'powershell'}),/默认 PowerShell/);
 assert.ok(sshAppServerArgs(host,'spawn',false,pin,{socketPath:'/test/control',windowsShell:'cmd'}).at(-1)!.startsWith('if exist'));
});
