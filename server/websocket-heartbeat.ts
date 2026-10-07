import type { WebSocket } from 'ws'

/** Android can pause browser JavaScript; a missing first pong isn't a dead engine. */
export class WebSocketHeartbeat {
  private lastPongs = new WeakMap<WebSocket, number>()
  constructor(private readonly graceMs = 120000, private readonly now = () => Date.now()) {}
  track(socket: WebSocket) {
    this.lastPongs.set(socket, this.now())
    socket.on('pong', () => { this.lastPongs.set(socket, this.now()) })
  }
  sweep(sockets: Iterable<WebSocket>) {
    const now = this.now()
    for (const socket of sockets) {
      if (socket.readyState !== 1) continue
      if (now - (this.lastPongs.get(socket) ?? now) >= this.graceMs) { socket.terminate(); continue }
      try { socket.ping() } catch { socket.terminate() }
    }
  }
}
