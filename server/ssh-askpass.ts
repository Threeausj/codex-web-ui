import { createServer, type Socket } from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

// Only an opaque socket address and capability reach the child environment.
// The password stays in this process and is delivered over a private socket;
// it never becomes a command argument, environment value or temporary file.
const helper = `#!/usr/bin/env node
const net = require('node:net');
const socket = net.connect(process.env.CODEX_WEB_SSH_ASKPASS_SOCKET);
socket.setTimeout(3000, () => socket.destroy());
socket.on('connect', () => socket.end(JSON.stringify({ token: process.env.CODEX_WEB_SSH_ASKPASS_TOKEN, prompt: process.argv[2] || '' }) + '\\n'));
let response = '';
socket.on('data', chunk => { response += chunk; if (response.length > 8192) socket.destroy(); });
socket.on('end', () => { if (response) { process.stdout.write(response); } else process.exitCode = 1; });
socket.on('error', () => { process.exitCode = 1; });
`

export async function createSshAskpass(password: string, parent: string) {
  if (!password || password.length > 1024 || /[\0\r\n]/.test(password)) throw new Error('SSH 密码无效，请重新输入')
  const directory = await fs.mkdtemp(path.join(parent, 'p-'))
  await fs.chmod(directory, 0o700)
  const executable = path.join(directory, 'askpass.cjs')
  const socketPath = path.join(directory, 's')
  const token = randomBytes(32).toString('hex')
  const clients = new Set<Socket>()
  let attempts = 0, disposed = false
  const server = createServer({ allowHalfOpen: true }, socket => {
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
    socket.setTimeout(3000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    let request = '', handled = false
    socket.on('data', chunk => {
      if (handled) return
      request += chunk.toString()
      if (request.length > 4096) { socket.destroy(); return }
      if (!request.includes('\n')) return
      handled = true
      try {
        const value = JSON.parse(request)
        const supplied = typeof value.token === 'string' ? Buffer.from(value.token) : Buffer.alloc(0)
        const expected = Buffer.from(token)
        // SSH runs with a fixed C locale. Refuse host trust, key passphrases,
        // one-time codes and arbitrary keyboard-interactive challenges.
        const passwordPrompt = typeof value.prompt === 'string' &&
          /(?:^|\s|')password\s*:\s*$/i.test(value.prompt) && !/passphrase|verification|one.time|\botp\b/i.test(value.prompt)
        if (disposed || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || !passwordPrompt || attempts >= 1) {
          socket.end(); return
        }
        ++attempts
        socket.end(password + '\n')
      } catch { socket.destroy() }
    })
  })
  const dispose = async () => {
    if (disposed) return
    disposed = true
    password = ''
    for (const client of clients) client.destroy()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    await fs.writeFile(executable, helper, { mode: 0o700, flag: 'wx' })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve() })
    })
    await fs.chmod(socketPath, 0o600)
    return { env: { SSH_ASKPASS: executable, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'codex-web-ssh',
      CODEX_WEB_SSH_ASKPASS_SOCKET: socketPath, CODEX_WEB_SSH_ASKPASS_TOKEN: token }, dispose }
  } catch {
    await dispose()
    throw new Error('无法准备 SSH 密码认证，请重试')
  }
}
