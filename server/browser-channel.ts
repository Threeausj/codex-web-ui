import type { WebSocket } from 'ws'
import type { RpcMessage } from './types.js'

/** Keep events behind a history response until that response has drained. */
export class BrowserChannel {
  private queue: { data: string; bytes: number }[] = []
  private queuedBytes = 0
  private sending = false
  private draining = false
  private closed = false
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly socket: WebSocket, private readonly failed: (reason: 'send' | 'overflow' | 'timeout') => void,
    private readonly limits = { bytes: 64 * 1024 * 1024, frames: 8192, timeoutMs: 120000 }) {}

  send(message: RpcMessage) {
    if (this.closed || this.socket.readyState !== 1) return
    const data = JSON.stringify(message)
    const bytes = Buffer.byteLength(data)
    // The in-flight frame belongs to ws. Bound the additional application
    // queue, allowing one native history frame on an otherwise idle channel.
    if ((this.sending || this.queue.length) &&
      (this.queuedBytes + bytes > this.limits.bytes || this.queue.length >= this.limits.frames)) {
      this.fail('overflow'); return
    }
    this.queue.push({ data, bytes }); this.queuedBytes += bytes
    this.drain()
  }

  get diagnostics() { return { queuedFrames: this.queue.length, queuedBytes: this.queuedBytes, sending: this.sending } }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.queue = []; this.queuedBytes = 0
  }

  private fail(reason: 'send' | 'overflow' | 'timeout') {
    if (this.closed) return
    this.close(); this.failed(reason)
  }

  private drain() {
    if (this.draining || this.closed) return
    this.draining = true
    try {
      // Test transports can complete synchronously; do not recurse per frame.
      while (!this.closed && !this.sending && this.queue.length) {
        const frame = this.queue.shift()!
        this.queuedBytes -= frame.bytes
        this.sending = true
        this.timer = setTimeout(() => this.fail('timeout'), this.limits.timeoutMs)
        this.timer.unref?.()
        try {
          this.socket.send(frame.data, error => {
            if (this.closed) return
            clearTimeout(this.timer)
            if (error) { this.fail('send'); return }
            this.sending = false
            this.drain()
          })
        } catch { this.fail('send') }
      }
    } finally { this.draining = false }
  }
}
