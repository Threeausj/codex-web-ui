import { Duplex, PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import WebSocket, { createWebSocketStream } from 'ws'
import type { Transport } from './bridge.js'

/**
 * `codex app-server proxy` relays raw stdio bytes to the daemon's WebSocket
 * control socket. Upgrade and frame those bytes; expose JSONL to the bridge.
 * The custom connection stays on the supplied pipes and never opens TCP.
 */
export function webSocketProxyTransport(raw: Transport): Transport {
  const events = new EventEmitter()
  const output = new PassThrough()
  const socket = Duplex.from({ readable: raw.output, writable: raw.input })
  const websocket = new WebSocket('ws://localhost/', {
    createConnection: () => socket as any,
    handshakeTimeout: 15_000,
    maxPayload: 64 * 1024 * 1024,
    perMessageDeflate: false,
  })
  // Preserve string writes: otherwise Node converts JSON into Buffer and ws
  // emits binary frames, which the app-server text protocol does not process.
  const input = createWebSocketStream(websocket, { decodeStrings: false })
  let disposed = false
  const error = (cause: Error) => { if (!disposed) events.emit('transportError', cause) }
  input.on('data', chunk => { output.write(chunk); output.write('\n') })
  input.on('error', error)
  output.on('error', error)
  raw.events.on('transportError', error)
  raw.events.on('transportClose', cause => { if (!disposed) events.emit('transportClose', cause) })
  websocket.on('close', (code, reason) => { if (!disposed) events.emit('transportClose', new Error(`App-server proxy WebSocket closed (${code}${reason.length ? `: ${reason.toString()}` : ''})`)) })
  const transport: Transport = {
    input,
    output,
    events,
    maxFrameBytes: 64 * 1024 * 1024,
    dispose() {
      if (disposed) return
      disposed = true
      websocket.terminate(); input.destroy(); output.destroy(); socket.destroy(); raw.dispose()
    },
  }
  websocket.on('upgrade', response => {
    const advertised = Number(response.headers['x-codex-websocket-max-unfragmented-message-bytes'])
    if (Number.isSafeInteger(advertised) && advertised > 0) transport.maxFrameBytes = Math.min(transport.maxFrameBytes!, advertised)
  })
  return transport
}
