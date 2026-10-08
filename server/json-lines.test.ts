import test from 'node:test'
import assert from 'node:assert/strict'
import { JsonLineReader } from './json-lines.js'

test('multibyte JSON frames survive every byte boundary and blank CRLF lines are ignored', () => {
  const messages: unknown[] = []
  const reader = new JsonLineReader(line => { messages.push(JSON.parse(line)) })
  const source = Buffer.from('\r\n' + JSON.stringify({ text: '中文和图像 🖼️', path: '/示例' }) + '\r\n\n' + JSON.stringify({ id: 2 }) + '\n')
  for (const byte of source) reader.write(Buffer.from([byte]))
  assert.deepEqual(messages, [{ text: '中文和图像 🖼️', path: '/示例' }, { id: 2 }])
})

test('a large fragmented history response is assembled once and trailing events retain their order', () => {
  const messages: any[] = []
  const reader = new JsonLineReader(line => { messages.push(JSON.parse(line)) })
  const response = { id: 1, result: { output: 'x'.repeat(16 * 1024 * 1024) } }
  const source = Buffer.from(JSON.stringify(response) + '\n' + JSON.stringify({ method: 'event', params: { sequence: 1 } }) + '\n')
  for (let offset = 0; offset < source.length; offset += 4096) reader.write(source.subarray(offset, offset + 4096))
  assert.equal(messages.length, 2)
  assert.equal(messages[0].result.output.length, response.result.output.length)
  assert.equal(messages[1].params.sequence, 1)
})

test('frame limits apply separately to each line, even when an entire batch exceeds the limit', () => {
  const messages: any[] = []
  const reader = new JsonLineReader(line => { messages.push(JSON.parse(line)) }, 16)
  reader.write(Buffer.from('{"id":1}\n{"id":2}\n{"id":3}\n'))
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }, { id: 3 }])
  reader.write(Buffer.from('12345678'))
  assert.throws(() => reader.write(Buffer.from('123456789')), /frame exceeds/)
  reader.write(Buffer.from('{"id":4}\n'))
  assert.deepEqual(messages.at(-1), { id: 4 })
})

test('oversized multibyte lines are rejected by raw byte count and processing stops when the owner disconnects', () => {
  const reader = new JsonLineReader(() => {}, 5)
  assert.throws(() => reader.write(Buffer.from('中文\n')), /frame exceeds/)
  const received: string[] = []
  const stopped = new JsonLineReader(line => { received.push(line); return false })
  stopped.write(Buffer.from('first\nsecond\n'))
  assert.deepEqual(received, ['first'])
})
