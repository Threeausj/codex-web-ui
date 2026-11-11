import type { Host } from './types.js'
import type { SSHHostKeyPin } from './ssh-host-keys.js'
import { windowsPythonCommand, windowsCodexCommand } from './windows-shell.js'

/** Only the server-owned pool may supply an application-private control socket. */
export type SSHConnectionControl = { socketPath: string; windowsShell?: 'cmd' | 'powershell' }

export function shellQuote(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'` }

/** Process-only override: allow structured questions in regular conversations. */
export function codexAppServerArgs(mode: 'spawn' | 'proxy' = 'spawn', socketPath?: string, daemonManaged = false) {
  return [...(mode === 'proxy' && daemonManaged ? [] : ['-c', 'features.default_mode_request_user_input=true']), 'app-server',
    ...(mode === 'proxy' ? ['proxy', ...(socketPath ? ['--sock', socketPath] : [])] : ['--listen', 'stdio://'])]
}

export type CodexDaemonAction = 'start' | 'version' | 'restart' | 'update'

/** Lifecycle commands are fixed by the service, never supplied by HTTP input.
 * CLI 0.165 ignores -c on daemon start/update, while restart persists feature
 * overrides for every daemon client. Web-only features belong on thread config. */
export function codexDaemonArgs(action: CodexDaemonAction) {
  if (!['start', 'version', 'restart', 'update'].includes(action)) throw new Error('Unsupported Codex daemon action')
  return ['app-server', 'daemon', action, ...(action === 'update' ? ['--from-cli', '--yes'] : [])]
}

/**
 * SSH starts a non-interactive shell whose PATH often misses nvm, mise or npm
 * installs. Let the account's interactive login shell initialize its environment
 * first, then start a POSIX launcher with the resulting PATH. Its startup output
 * goes to stderr; fd 3 temporarily preserves the app-server protocol stdout.
 */
export function remoteCodexCommand(host: Host, mode: 'spawn' | 'proxy' = 'spawn', probeVersion = false, daemonManaged = false, windowsShell?: SSHConnectionControl['windowsShell']) {
  return remoteCodexLaunch(host, codexAppServerArgs(mode, undefined, daemonManaged), probeVersion, undefined, windowsShell)
}

/** The official daemon owns its lifetime; this command only starts/queries it.
 * It deliberately never installs OS services or stops an existing daemon. */
export function remoteCodexDaemonCommand(host: Host, action: CodexDaemonAction, codexHome?: string, windowsShell?: SSHConnectionControl['windowsShell']) {
  return remoteCodexLaunch(host, codexDaemonArgs(action), false, codexHome, windowsShell)
}

function remoteCodexLaunch(host: Host, args: string[], probeVersion: boolean, codexHome?: string, windowsShell?: SSHConnectionControl['windowsShell']) {
  const command = host.codexPath?.trim() || 'codex'
  if (host.platform === 'windows') return windowsCodexCommand(command, args, host.cwd, codexHome, probeVersion, windowsShell)
  const launch = [
    ...(host.cwd ? [`cd ${shellQuote(host.cwd)} || exit 126`] : []),
    `codex_bin=${shellQuote(command)}`,
    'codex_bin=$(command -v "$codex_bin" 2>/dev/null) || { printf "%s\\n" "Codex was not found in the remote login-shell PATH" >&2; exit 127; }',
    ...(probeVersion ? ['printf "%s" "__CODEX_WEB_VERSION__=" >&2', '"$codex_bin" --version >&2 || exit $?'] : []),
    `exec ${codexHome ? `env ${shellQuote(`CODEX_HOME=${codexHome}`)} ` : ''}"$codex_bin" ${args.map(shellQuote).join(' ')}`,
  ].join('\n')
  // The command executed by the user's shell is deliberately just exec + sh;
  // the launcher itself also works when the login shell is fish.
  // Interactive bash can mark inherited extra descriptors close-on-exec.
  // Restore standard stdout in that shell, before exec crosses into /bin/sh.
  const interactiveCommand = `exec /bin/sh -c ${shellQuote(launch)} 1>&3 3>&-`
  const bootstrap = `login_shell=\${SHELL:-/bin/sh}\nexec "$login_shell" -ilc ${shellQuote(interactiveCommand)} 3>&1 1>&2`
  return `exec /bin/sh -c ${shellQuote(bootstrap)}`
}

/** Once an endpoint is pinned in the app, older external keys cannot also pass. */
export function sshKnownHostsArgs(pin?: SSHHostKeyPin, control?: SSHConnectionControl) {
  const multiplex = control
    ? ['-o', `ControlPath=${control.socketPath}`, '-o', 'ControlMaster=no', '-o', 'ControlPersist=no']
    : ['-o', 'ControlPath=none', '-o', 'ControlMaster=no', '-o', 'ControlPersist=no']
  if (!pin) return multiplex
  const file = pin.file
  const quoted = `"${file.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return ['-o', `UserKnownHostsFile=${quoted}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'KnownHostsCommand=none',
    '-o', 'VerifyHostKeyDNS=no', '-o', 'NoHostAuthenticationForLocalhost=no', '-o', 'UpdateHostKeys=no',
    ...multiplex,
    '-o', `HostKeyAlias=${pin.hostKeyAlias}`]
}

export function sshAppServerArgs(host: Host, mode: 'spawn' | 'proxy' = 'spawn', probeVersion = false, knownHostsFile?: SSHHostKeyPin, control?: SSHConnectionControl, daemonManaged = false) {
  if (host.platform === 'windows' && control?.windowsShell === 'powershell')
    throw new Error('Windows SSH 默认 PowerShell 会截留持续输入。请将 OpenSSH DefaultShell 设为 cmd.exe 后重试；网页终端仍使用 PowerShell。')
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', '-o', 'TCPKeepAlive=yes', '-o', 'LogLevel=ERROR']
  args.push(...sshKnownHostsArgs(knownHostsFile, control))
  if (host.port) args.push('-p', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  const destination = `${host.username ? `${host.username}@` : ''}${host.hostname}`
  args.push('--', destination, remoteCodexCommand(host, mode, probeVersion, daemonManaged, control?.windowsShell))
  return args
}

export function sshCodexDaemonArgs(host: Host, action: CodexDaemonAction, knownHostsFile?: SSHHostKeyPin, control?: SSHConnectionControl, codexHome?: string) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', '-o', 'LogLevel=ERROR', ...sshKnownHostsArgs(knownHostsFile, control)]
  if (host.port) args.push('-p', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  args.push('--', `${host.username ? `${host.username}@` : ''}${host.hostname}`, remoteCodexDaemonCommand(host, action, codexHome, control?.windowsShell))
  return args
}

/** Fixed server-owned readers use stdin and the same authenticated transport. */
export function sshPythonArgs(host: Host, pin?: SSHHostKeyPin, control?: SSHConnectionControl) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', '-o', 'LogLevel=ERROR', ...sshKnownHostsArgs(pin, control)]
  if (host.port) args.push('-p', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  const command = host.platform === 'windows' ? windowsPythonCommand(
    `import sys,os,pathlib\nhome=pathlib.Path.home();local=pathlib.Path(os.environ.get('LOCALAPPDATA',home/'AppData'/'Local'));bins=local/'OpenAI'/'Codex'/'bin';dependencies=home/'.cache'/'codex-runtimes'/'codex-primary-runtime'/'dependencies'\npaths=[home/'.codex'/'packages'/'standalone'/'current'/'bin',home/'.codex'/'packages'/'app-server-daemon'/'current'/'bin',local/'Programs'/'OpenAI'/'Codex'/'bin',dependencies/'node'/'bin',dependencies/'native'/'git'/'cmd',pathlib.Path(os.environ.get('ProgramFiles','C:/Program Files'))/'Git'/'cmd']\nif bins.is_dir(): paths+=sorted((p.parent for p in bins.glob('*/codex.exe') if p.is_file()),key=lambda p:p.stat().st_mtime,reverse=True)\nos.environ['PATH']=os.pathsep.join(str(p) for p in paths)+os.pathsep+os.environ.get('PATH','')\nimport base64;exec(base64.b64decode(sys.stdin.buffer.readline()))`
  , control?.windowsShell) : `exec /bin/sh -c ${shellQuote('exec python3 -')}`
  args.push('--', `${host.username ? `${host.username}@` : ''}${host.hostname}`, command)
  return args
}
/** Windows OpenSSH does not always propagate stdin EOF to native children. A
 * single Base64 line gives fixed Python helpers an explicit framing boundary. */
export function hostPythonInput(host: Host, source: string) { return host.platform === 'windows' ? Buffer.from(source).toString('base64') + '\n' : source; }
