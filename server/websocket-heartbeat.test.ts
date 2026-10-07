import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { WebSocketHeartbeat } from './websocket-heartbeat.js'

class Socket extends EventEmitter {
  readyState = 1; pings = 0; closed = false
  ping() { this.pings++ }
  terminate() { this.closed = true; this.readyState = 3 }
  ws() { return this as unknown as WebSocket }
}
test('brief suspended-browser gaps keep their socket; silent dead peers expire and resumed pongs reset grace', () => {
  let now = 0
  const heartbeat = new WebSocketHeartbeat(120000, () => now)
  const resumed = new Socket(); const dead = new Socket()
  heartbeat.track(resumed.ws()); heartbeat.track(dead.ws())
  now = 60000; heartbeat.sweep([resumed.ws(), dead.ws()])
  assert.equal(resumed.closed, false); assert.equal(dead.closed, false)
  resumed.emit('pong')
  now = 120000; heartbeat.sweep([resumed.ws(), dead.ws()])
  assert.equal(resumed.closed, false); assert.equal(dead.closed, true)
  assert.equal(resumed.pings, 2)
  now = 180000; heartbeat.sweep([resumed.ws()]); assert.equal(resumed.closed, true)
})
