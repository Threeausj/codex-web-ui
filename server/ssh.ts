import type { Host } from './types.js'

export function shellQuote(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'` }

/** Process-only override: allow structured questions in regular conversations. */
export function codexAppServerArgs(mode: 'spawn' | 'proxy' = 'spawn', socketPath?: string) {
  return ['-c', 'features.default_mode_request_user_input=true', 'app-server',
    ...(mode === 'proxy' ? ['proxy', ...(socketPath ? ['--sock', socketPath] : [])] : ['--listen', 'stdio://'])]
}

/**
 * SSH starts a non-interactive shell whose PATH often misses nvm, mise or npm
 * installs. Let the account's interactive login shell initialize its environment
 * first, then start a POSIX launcher with the resulting PATH. Its startup output
 * goes to stderr; fd 3 is reserved for the app-server protocol stdout.
 */
export function remoteCodexCommand(host: Host, mode: 'spawn' | 'proxy' = 'spawn', probeVersion = false) {
  const command = host.codexPath?.trim() || 'codex'
  const launch = [
    'exec 1>&3 3>&-',
    ...(host.cwd ? [`cd ${shellQuote(host.cwd)} || exit 126`] : []),
    `codex_bin=${shellQuote(command)}`,
    'codex_bin=$(command -v "$codex_bin" 2>/dev/null) || { printf "%s\\n" "Codex was not found in the remote login-shell PATH" >&2; exit 127; }',
    ...(probeVersion ? ['printf "%s" "__CODEX_WEB_VERSION__=" >&2', '"$codex_bin" --version >&2 || exit $?'] : []),
    `exec "$codex_bin" ${codexAppServerArgs(mode).map(shellQuote).join(' ')}`,
  ].join('\n')
  // The command executed by the user's shell is deliberately just exec + sh;
  // the launcher itself also works when the login shell is fish.
  const interactiveCommand = `exec /bin/sh -c ${shellQuote(launch)}`
  const bootstrap = `login_shell=\${SHELL:-/bin/sh}\nexec "$login_shell" -ilc ${shellQuote(interactiveCommand)} 3>&1 1>&2`
  return `exec /bin/sh -c ${shellQuote(bootstrap)}`
}

export function sshAppServerArgs(host: Host, mode: 'spawn' | 'proxy' = 'spawn', probeVersion = false) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR']
  if (host.port) args.push('-p', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  const destination = `${host.username ? `${host.username}@` : ''}${host.hostname}`
  args.push('--', destination, remoteCodexCommand(host, mode, probeVersion))
  return args
}
