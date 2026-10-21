import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import express from 'express'
import { readBoundedHostFile, registerFileDownloads } from './file-download.js'
import { registerFiles } from './files.js'
import { createServer } from './app.js'
import type { Host } from './types.js'

const local: Host = { id: 'local', kind: 'local', name: 'Local' }
const remote: Host = { id: 'remote', kind: 'ssh', name: 'SSH', hostname: 'download.example', username: 'reader', port: 2222, identityFile: '/keys/reader key' }
async function fixture(options: Partial<Parameters<typeof registerFileDownloads>[1]> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-file-download-'))
  const app = express()
  const dependencies = { getHost: (id: string) => [local, remote].find(host => host.id === id), ...options }
  registerFileDownloads(app, dependencies)
  registerFiles(app, async () => { throw new Error('Large reads must never use native RPC') }, async (id, file, maximum) => readBoundedHostFile(dependencies.getHost(id)!, file, maximum, dependencies))
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.message }))
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const url = (file: string, host = 'local') => `${base}/api/hosts/${host}/download?path=${encodeURIComponent(file)}`
  return { directory, base, url, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }) } }
}
async function sparse(file: string, size: number) { const handle = await fs.open(file, 'w'); try { await handle.truncate(size) } finally { await handle.close() } }
async function eventually(check: () => Promise<boolean> | boolean, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!(await check())) { if (Date.now() >= deadline) assert.fail('Condition did not become true'); await new Promise(resolve => setTimeout(resolve, 20)) }
}

test('HTTP downloads preserve bytes and encode private UTF-8 filenames without a Blob or native RPC', async () => {
  const f = await fixture()
  try {
    const name = `数据 报告 '$(do-not-run)".zip`
    const file = path.join(f.directory, name)
    const bytes = Buffer.from([0x50, 0x4b, 0xff, 0x00, 0xc3, 0x28, 0x0a])
    await fs.writeFile(file, bytes)
    const response = await fetch(f.url(file))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), String(bytes.length))
    assert.equal(response.headers.get('content-type'), 'application/octet-stream')
    assert.match(response.headers.get('content-disposition')!, /attachment; filename=/)
    assert.match(response.headers.get('content-disposition')!, /filename\*=UTF-8''%E6%95%B0%E6%8D%AE/)
    assert.match(response.headers.get('content-disposition')!, /%27%24%28do-not-run%29%22\.zip$/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-accel-buffering'), 'no')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  } finally { await f.close() }
})

test('a sparse 1.17 GiB file remains downloadable by HEAD/range while preview rejects it before reading bytes', async () => {
  const f = await fixture()
  try {
    const file = path.join(f.directory, 'large.zip'); const size = Math.round(1.17 * 1024 ** 3)
    await sparse(file, size)
    const head = await fetch(f.url(file), { method: 'HEAD' })
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(size)); assert.equal((await head.arrayBuffer()).byteLength, 0)
    const partial = await fetch(f.url(file), { headers: { range: 'bytes=0-9' } })
    assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), `bytes 0-9/${size}`)
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), Buffer.alloc(10))
    const preview = await fetch(`${f.base}/api/hosts/local/files?path=${encodeURIComponent(file)}`)
    assert.equal(preview.status, 413); assert.match((await preview.json()).error, /8 MB.*下载/)
  } finally { await f.close() }
})

test('single byte ranges, suffixes, empty files and unsatisfiable ranges have correct HTTP semantics', async () => {
  const f = await fixture()
  try {
    const file = path.join(f.directory, 'range.txt'); await fs.writeFile(file, '0123456789')
    for (const [range, expected] of [['bytes=2-4', '234'], ['bytes=7-', '789'], ['bytes=-3', '789'], ['bytes=8-99', '89']] as const) {
      const response = await fetch(f.url(file), { headers: { range } }); assert.equal(response.status, 206); assert.equal(await response.text(), expected)
    }
    for (const range of ['bytes=10-', 'bytes=3-1', 'bytes=-0']) {
      const response = await fetch(f.url(file), { headers: { range } }); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */10')
    }
    for (const range of ['bytes=0-1,4-5', 'bytes=--', 'bytes=9007199254740992-', 'bytes=-']) assert.equal((await fetch(f.url(file), { headers: { range } })).status, 416)
    const ifRange = await fetch(f.url(file), { headers: { range: 'bytes=1-2', 'if-range': 'unknown-validator' } }); assert.equal(ifRange.status, 200); assert.equal(await ifRange.text(), '0123456789')
    const empty = path.join(f.directory, 'empty.txt'); await fs.writeFile(empty, '')
    assert.equal((await fetch(f.url(empty))).headers.get('content-length'), '0')
    assert.equal((await fetch(f.url(empty), { headers: { range: 'bytes=0-' } })).status, 416)
  } finally { await f.close() }
})

test('downloads reject invalid paths, missing/disabled hosts, directories and FIFOs without hanging', async () => {
  const f = await fixture()
  try {
    for (const file of ['relative.txt', '/tmp/bad\nname', '/tmp/bad\u0000name', '/tmp/bad\\name']) assert.equal((await fetch(f.url(file))).status, 400)
    assert.equal((await fetch(f.url('/unused', 'disabled'))).status, 404)
    assert.equal((await fetch(f.url(path.join(f.directory, 'missing')))).status, 404)
    assert.equal((await fetch(f.url(f.directory))).status, 400)
    const fifo = path.join(f.directory, 'fifo')
    await new Promise<void>((resolve, reject) => { const child = spawn('mkfifo', [fifo]); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('mkfifo failed'))) })
    assert.equal((await fetch(f.url(fifo), { signal: AbortSignal.timeout(2000) })).status, 400)
  } finally { await f.close() }
})

test('remote files use the same framed stream and enforce pinned SSH identity without putting paths in shell arguments', async () => {
  const argumentsSeen: string[][] = []
  const f = await fixture({
    bridgeOptions: { resolveSshHostKeyPin: async host => { assert.equal(host.id, 'remote'); return { file: '/private/known hosts', hostKeyAlias: 'download-pinned' } } },
    spawnSSH: args => { argumentsSeen.push(args); return spawn('python3', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] }) },
  })
  try {
    const file = path.join(f.directory, `远程 ';$(touch SHOULD_NOT_EXIST).zip`)
    const bytes = Buffer.from([0x00, 0xff, 0x50, 0x4b, 0x00]); await fs.writeFile(file, bytes)
    const response = await fetch(f.url(file, 'remote')); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    assert.ok(argumentsSeen[0]!.includes('StrictHostKeyChecking=yes')); assert.ok(argumentsSeen[0]!.includes('HostKeyAlias=download-pinned'))
    assert.ok(argumentsSeen[0]!.includes('ControlMaster=no')); assert.ok(argumentsSeen[0]!.includes('/keys/reader key'))
    assert.ok(argumentsSeen[0]!.includes('reader@download.example')); assert.ok(argumentsSeen[0]!.includes('2222'))
    assert.ok(!argumentsSeen[0]!.some(arg => arg.includes(file)))
    const partial = await fetch(f.url(file, 'remote'), { headers: { range: 'bytes=-2' } }); assert.equal(partial.status, 206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(-2))
    const huge = path.join(f.directory, 'remote-large.zip'); await sparse(huge, 1200 * 1024 * 1024)
    const head = await fetch(f.url(huge, 'remote'), { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(1200 * 1024 * 1024))
    const preview = await fetch(`${f.base}/api/hosts/remote/files?path=${encodeURIComponent(huge)}`); assert.equal(preview.status, 413)
    const smallPreview = await fetch(`${f.base}/api/hosts/remote/files?path=${encodeURIComponent(file)}`); assert.equal(smallPreview.status, 200); assert.deepEqual(Buffer.from((await smallPreview.json()).dataBase64, 'base64'), bytes)
    const missing = await fetch(f.url(path.join(f.directory, 'missing'), 'remote')); assert.equal(missing.status, 404)
    assert.equal((await fetch(f.url(f.directory, 'remote'))).status, 400)
  } finally { await f.close() }
})

test('slow download clients apply backpressure and abort kills only their own SSH child', async () => {
  let child: ChildProcessWithoutNullStreams | undefined
  let progress = ''
  let closed = false
  const f = await fixture({ spawnSSH: () => {
    const size = 128 * 1024 * 1024
    child = spawn(process.execPath, ['-e', `
      const fs=require('node:fs');let sent=0;const total=${size},chunk=Buffer.alloc(65536);process.stdin.resume();
      process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({size:total,start:0,end:total-1,partial:false,unsatisfiable:false})+'\\n');write()});
      function write(){while(sent<total){sent+=chunk.length;fs.writeFileSync(${JSON.stringify(progress)},String(sent));if(!process.stdout.write(chunk)){process.stdout.once('drain',write);return}}process.stdout.end()}
    `], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.once('close', () => { closed = true })
    return child
  } })
  try {
    progress = path.join(f.directory, 'progress')
    const client = await new Promise<http.IncomingMessage>((resolve, reject) => { const request = http.get(f.url('/remote/large.zip', 'remote'), response => { response.pause(); resolve(response) }); request.on('error', reject) })
    await eventually(async () => { try { return Number(await fs.readFile(progress, 'utf8')) >= 65536 } catch { return false } })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.ok(Number(await fs.readFile(progress, 'utf8')) < 32 * 1024 * 1024, 'SSH output must stop when HTTP client stops consuming')
    client.destroy()
    await eventually(() => closed)
    assert.ok(child?.killed, 'Cancelling this request must stop its own subprocess')
  } finally { child?.kill('SIGKILL'); await f.close() }
})

test('bounded remote metadata and SSH diagnostics never become downloaded bytes or leak stderr', async () => {
  for (const script of [`process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('x'.repeat(4097)+'\\n');setInterval(()=>{},1000)})`, `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('SECRET_KEY_DO_NOT_EXPOSE');process.exit(2)})`]) {
    let closed = false
    const f = await fixture({ spawnSSH: () => { const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] }); child.once('close', () => { closed = true }); return child } })
    try { const response = await fetch(f.url('/remote/file', 'remote')); assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /SECRET_KEY/); await eventually(() => closed) }
    finally { await f.close() }
  }
})

test('missing remote Python gives an actionable error without exposing SSH diagnostics', async () => {
  const f = await fixture({ spawnSSH: () => spawn(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('/bin/sh: python3: not found\\nPRIVATE_REMOTE_DETAIL');process.exit(127)})"], { stdio: ['pipe', 'pipe', 'pipe'] }) });
  try {
    const response = await fetch(f.url('/remote/file', 'remote'));
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.match(body, /Python 3/);
    assert.doesNotMatch(body, /PRIVATE_REMOTE_DETAIL/);
  } finally { await f.close(); }
});

test('the production download route requires a session and works for GET/HEAD without starting Codex', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-auth-download-'))
  const file = path.join(directory, 'private.txt'); await fs.writeFile(file, 'private download')
  let nativeSpawns = 0
  const application = await createServer({ cwd: directory, dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'codex'), password: 'isolated-download-password', serveStatic: false, bridgeOptions: { transportFactory: () => { nativeSpawns++; throw new Error('Must not start Codex for file download') } } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  const url = `${base}/api/hosts/local/download?path=${encodeURIComponent(file)}`
  try {
    assert.equal((await fetch(url)).status, 401)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' }, body: JSON.stringify({ password: 'isolated-download-password' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const head = await fetch(url, { method: 'HEAD', headers: { cookie } }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '16')
    const response = await fetch(url, { headers: { cookie } }); assert.equal(response.status, 200); assert.equal(await response.text(), 'private download')
    assert.equal(nativeSpawns, 0)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
