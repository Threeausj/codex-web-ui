import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { createServer } from './app.js'
import type { Transport } from './bridge.js'

for (const compressed of [false, true]) test(`real ${compressed ? 'compressed' : 'uncompressed'} WebSockets deliver large history and ordered events to two clients`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-large-sync-'))
  const input = new PassThrough(), output = new PassThrough(), origin = 'http://fixture.example'
  const transports: Transport[] = [], nativeRequests: any[] = []
  let emitHistory: (() => void) | undefined, historyBytes = 0
  let buffer = ''
  input.on('data', raw => {
    buffer += raw.toString()
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
      nativeRequests.push(request)
      if (request.method === 'initialize') output.write(JSON.stringify({ id: request.id, result: {} }) + '\n')
      if (request.method === 'thread/turns/list') emitHistory = () => {
        const response = JSON.stringify({ id: request.id, result: { data: [
          { id: 'large-turn', status: 'completed', items: [
            { id: 'tool', type: 'commandExecution', aggregatedOutput: 'A recorded command output\n'.repeat(700000) },
          ] },
        ], nextCursor: null } })
        historyBytes = Buffer.byteLength(response); output.write(response + '\n')
        for (let sequence = 0; sequence < 40; sequence++) output.write(JSON.stringify({ method: 'item/agentMessage/delta',
          params: { threadId: 'large', itemId: 'answer', delta: String(sequence) } }) + '\n')
      }
    }
  })
  const application = await createServer({ dataDir: directory, password: 'large-history-fixture-password', origins: [origin], serveStatic: false,
    bridgeOptions: { transportFactory: () => { const transport = { input, output, events: new EventEmitter(), dispose() { input.destroy(); output.destroy() } }; transports.push(transport); return transport } } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  const sockets: WebSocket[] = []
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 10000
    while (!condition()) { if (Date.now() > deadline) throw new Error('Fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
  }
  try {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'large-history-fixture-password' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!, records: any[][] = [[], []]
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/rpc?clientId=history_reader_' + i,
        { headers: { origin, cookie }, perMessageDeflate: compressed })
      sockets.push(ws); ws.on('error', () => {}); ws.on('message', raw => records[i]!.push(JSON.parse(raw.toString())))
      await wait(() => records[i]!.some(frame => frame.method === 'bridge/status' && frame.params.connected))
      assert.equal(ws.extensions.includes('permessage-deflate'), compressed)
    }
    sockets[0]!.send(JSON.stringify({ id: 'history', method: 'thread/turns/list', params: { threadId: 'large', limit: 30 } }))
    await wait(() => !!emitHistory)
    sockets[0]!.pause()
    const wireBefore = (sockets[0] as any)._socket.bytesRead
    emitHistory!()
    await wait(() => records[1]!.filter(frame => frame.method === 'item/agentMessage/delta').length === 40)
    assert.equal(sockets[0]!.readyState, WebSocket.OPEN)
    assert.equal(sockets[1]!.readyState, WebSocket.OPEN)
    assert.equal(transports.length, 1)
    assert.ok(historyBytes > 16 * 1024 * 1024)
    assert.equal(records[1]!.some(frame => frame.id === 'history'), false)
    const bridge = await application.getBridge('local')
    if (!compressed) {
      assert.ok([...application.wss.clients].some(ws => ws.bufferedAmount > 8 * 1024 * 1024))
      assert.ok(bridge.diagnostics().browsers.queuedBytes > 0)
    }
    sockets[1]!.send(JSON.stringify({ id: 'live-ping', method: 'bridge/ping', params: {} }))
    await wait(() => records[1]!.some(frame => frame.id === 'live-ping'))
    sockets[0]!.resume()
    await wait(() => records[0]!.filter(frame => frame.method === 'item/agentMessage/delta').length === 40)
    assert.deepEqual(records[0]!.filter(frame => frame.method === 'item/agentMessage/delta').map(frame => frame.params.delta), Array.from({ length: 40 }, (_, i) => String(i)))
    assert.ok(records[0]!.findIndex(frame => frame.id === 'history') < records[0]!.findIndex(frame => frame.method === 'item/agentMessage/delta'))
    assert.equal(bridge.diagnostics().browsers.queuedBytes, 0)
    assert.deepEqual(bridge.diagnostics().browsers.failures, { send: 0, overflow: 0, timeout: 0 })
    const wireBytes = (sockets[0] as any)._socket.bytesRead - wireBefore
    if (compressed) assert.ok(wireBytes < historyBytes / 10)
    else assert.ok(wireBytes >= historyBytes)
    assert.equal(nativeRequests.some(request => request.method === 'turn/start' || request.method === 'thread/resume'), false)
  } finally { for (const socket of sockets) socket.terminate(); await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
