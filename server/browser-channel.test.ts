import test from 'node:test'
import assert from 'node:assert/strict'
import type { WebSocket } from 'ws'
import { BrowserChannel } from './browser-channel.js'

function socket() {
  const frames: any[] = [], callbacks: ((error?: Error) => void)[] = []
  const ws = { readyState: 1, bufferedAmount: 0, send(data: string, callback: (error?: Error) => void) {
    frames.push(JSON.parse(data)); callbacks.push(callback); this.bufferedAmount = Buffer.byteLength(data)
  } }
  return { ws: ws as unknown as WebSocket, frames, finish(error?: Error) { ws.bufferedAmount = 0; callbacks.shift()!(error) } }
}

test('events wait for a 16 MiB history frame to drain without treating the frame as an overflowing queue', () => {
  const value = socket(), failures: string[] = []
  const channel = new BrowserChannel(value.ws, reason => failures.push(reason))
  try {
    channel.send({ id: 1, result: { output: 'x'.repeat(16 * 1024 * 1024) } })
    for (let sequence = 1; sequence <= 40; sequence++) channel.send({ method: 'item/agentMessage/delta', bridgeEventSequence: sequence })
    assert.equal(value.frames.length, 1)
    assert.equal(channel.diagnostics.queuedFrames, 40)
    assert.deepEqual(failures, [])
    for (let i = 0; i <= 40; i++) value.finish()
    assert.deepEqual(value.frames.slice(1).map(frame => frame.bridgeEventSequence), Array.from({ length: 40 }, (_, i) => i + 1))
    assert.deepEqual(channel.diagnostics, { queuedFrames: 0, queuedBytes: 0, sending: false })
  } finally { channel.close() }
})

test('a genuinely overflowing queue is discarded and late completion cannot send its pending events', () => {
  const value = socket(), failures: string[] = []
  const channel = new BrowserChannel(value.ws, reason => failures.push(reason), { bytes: 128, frames: 3, timeoutMs: 120000 })
  channel.send({ id: 1, result: 'large history'.repeat(100) })
  channel.send({ method: 'event', params: 'a'.repeat(80) })
  channel.send({ method: 'event', params: 'b'.repeat(80) })
  assert.deepEqual(failures, ['overflow'])
  value.finish()
  assert.equal(value.frames.length, 1)
  assert.equal(channel.diagnostics.queuedBytes, 0)
})

test('a stalled channel has a bounded lifetime while a timely drain cancels its timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stalled = socket(), failures: string[] = []
  const channel = new BrowserChannel(stalled.ws, reason => failures.push(reason), { bytes: 1024, frames: 10, timeoutMs: 120000 })
  channel.send({ id: 1, result: 'history' }); channel.send({ method: 'event' })
  t.mock.timers.tick(119999); assert.deepEqual(failures, [])
  t.mock.timers.tick(1); assert.deepEqual(failures, ['timeout'])
  stalled.finish(); assert.equal(stalled.frames.length, 1)
  const timely = socket(), errors: string[] = []
  const healthy = new BrowserChannel(timely.ws, reason => errors.push(reason), { bytes: 1024, frames: 10, timeoutMs: 120000 })
  healthy.send({ id: 2, result: 'history' }); timely.finish()
  t.mock.timers.tick(120000); assert.deepEqual(errors, [])
  healthy.close()
})

test('send callback failure closes just this channel and releases queued data', () => {
  const value = socket(), failures: string[] = []
  const channel = new BrowserChannel(value.ws, reason => failures.push(reason))
  channel.send({ id: 1, result: 'history' }); channel.send({ method: 'event' })
  value.finish(new Error('Transport failed'))
  assert.deepEqual(failures, ['send']); assert.equal(value.frames.length, 1)
  assert.equal(channel.diagnostics.queuedBytes, 0)
})
