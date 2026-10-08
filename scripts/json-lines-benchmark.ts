// Manual isolated baseline comparison; not part of the timing-sensitive test suite.
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { JsonLineReader } from '../server/json-lines.js'

const source = Buffer.from(JSON.stringify({ id: 1, result: { text: 'x'.repeat(16 * 1024 * 1024) } }) + '\n')
function run(chunkBytes: number, improved: boolean) {
  let messages = 0, scannedBytes = 0
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const reader = new JsonLineReader(line => { JSON.parse(line); messages++ })
  const start = performance.now()
  for (let offset = 0; offset < source.length; offset += chunkBytes) {
    const chunk = source.subarray(offset, offset + chunkBytes)
    if (improved) { scannedBytes += chunk.length; reader.write(chunk); continue }
    buffer += decoder.write(chunk)
    scannedBytes += Buffer.byteLength(buffer)
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) { JSON.parse(line); messages++ }
    }
  }
  if (messages !== 1) throw new Error('Unexpected parsed frame count')
  return { ms: Math.round(performance.now() - start), scannedBytes }
}
for (const chunkBytes of [4096, 32768]) {
  for (const improved of [false, true]) {
    const results = Array.from({ length: 3 }, () => run(chunkBytes, improved))
    results.sort((a, b) => a.ms - b.ms)
    console.log(JSON.stringify({ parser: improved ? 'new' : 'old', chunkBytes, frameBytes: source.length, ...results[1] }))
  }
}
