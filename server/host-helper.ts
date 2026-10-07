import { spawn } from 'node:child_process'
import type { BridgeOptions } from './bridge.js'
import { resourceSshArgs } from './host-resources.js'
import type { Host } from './types.js'

/** Execute a server-owned Python reader; request text never becomes shell code. */
export async function runHostPython(host: Host, source: string, options: BridgeOptions = {}, limits: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<string> {
  const pin = host.kind === 'ssh' ? await options.resolveSshHostKeyPin?.(host) ?? options.sshHostKeyPin : undefined
  const executable = host.kind === 'ssh' ? 'ssh' : 'python3'
  const args = host.kind === 'ssh' ? resourceSshArgs(host, pin) : ['-']
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0; let stderr = ''; let finished = false; let timedOut = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      if (error) reject(error); else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, limits.timeoutMs ?? 15000)
    timer.unref()
    child.on('error', () => finish(new Error(host.kind === 'ssh' ? '无法启动主机读取 SSH' : '主机读取需要 Python 3')))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (limits.maxOutputBytes ?? 32768)) { child.kill('SIGKILL'); finish(new Error('主机读取结果超出限制')); return }
      chunks.push(chunk)
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048) })
    child.on('close', code => {
      if (code === 0) finish()
      else finish(new Error(timedOut ? '主机读取超时' : /host key|identification has changed/i.test(stderr) ? '请确认并信任 SSH 主机指纹' : /python3.*not found/i.test(stderr) ? '目标主机需要 Python 3' : '无法读取主机数据，请检查 SSH 连接及账户权限'))
    })
    child.stdin.end(source)
  })
}
