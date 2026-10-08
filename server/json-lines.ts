/** Collect each JSONL frame once, with a byte limit independent of chunk boundaries. */
export class JsonLineReader {
  private parts: Buffer[] = []
  private bytes = 0
  constructor(private readonly receive: (line: string) => boolean | void, private readonly maxBytes = 64 * 1024 * 1024) {}

  write(chunk: Buffer) {
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      this.bytes += part.length
      if (this.bytes > this.maxBytes) {
        this.parts = []; this.bytes = 0
        throw new RangeError(`App-server frame exceeds the ${this.maxBytes} byte limit`)
      }
      if (part.length) this.parts.push(part)
      if (newline < 0) return
      const line = (this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.bytes)).toString('utf8').trim()
      this.parts = []; this.bytes = 0
      if (line && this.receive(line) === false) return
      offset = newline + 1
    }
  }
}
