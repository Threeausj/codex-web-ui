import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'

const binary = process.env.CODEX_BIN || 'codex'
const hasCodex = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0

test('installed Codex accepts the app-server handshake and isolated read-only RPCs', {
  skip: !hasCodex,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-web-protocol-'))
  const filename = path.join(directory, 'protocol-smoke.txt')
  const contents = 'app-server 文件读取 smoke test\n'
  await writeFile(filename, contents)
  const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: path.join(directory, 'codex-home') }
  await mkdir(environment.CODEX_HOME!, { recursive: true })
  // The protocol check needs no account credentials or inference requests.
  delete environment.OPENAI_API_KEY
  delete environment.CODEX_API_KEY
  delete environment.ACCESS_TOKEN
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: directory,
    env: environment,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const reader = createInterface({ input: child.stdout })
  let requestId = 0
  const pending = new Map<number, {
    resolve: (value: any) => void
    reject: (reason: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
  }
  child.on('error', rejectPending)
  child.on('exit', (code) => rejectPending(new Error(`app-server exited: ${code}`)))
  reader.on('line', (line) => {
    let message: any
    try { message = JSON.parse(line) } catch { return }
    if (message.method && message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only smoke client' } })}\n`)
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timeout)
    if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`))
    else request.resolve(message.result)
  })
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const id = ++requestId
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`app-server timeout: ${method}`))
    }, 10_000)
    pending.set(id, { resolve, reject, timeout })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  try {
    const initialized = await rpc('initialize', {
      clientInfo: { name: 'codex_web_protocol_test', title: 'Codex Web protocol test', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    assert.equal(typeof initialized.userAgent, 'string')
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    const configuration = await rpc('config/read', { cwd: directory, includeLayers: true })
    assert.equal(typeof configuration.config, 'object')
    const models = await rpc('model/list', { limit: 100 })
    assert.ok(Array.isArray(models.data))
    const history = await rpc('thread/list', { limit: 10, modelProviders: [] })
    assert.deepEqual(history.data, [])
    assert.equal(history.nextCursor, null)
    const file = await rpc('fs/readFile', { path: filename })
    assert.equal(Buffer.from(file.dataBase64, 'base64').toString('utf8'), contents)
    const listing = await rpc('fs/readDirectory', { path: directory })
    assert.ok(listing.entries.some((entry: { fileName: string }) => entry.fileName === 'protocol-smoke.txt'))
  } finally {
    rejectPending(new Error('Protocol test ended'))
    reader.close()
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000)
      child.once('exit', () => { clearTimeout(force); resolve() })
    })
    await rm(directory, { recursive: true, force: true })
  }
})
