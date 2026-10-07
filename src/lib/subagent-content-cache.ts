export type SubagentContent = {
  thread: any
  turns: any[]
  cursor: string | null
  hydrated: boolean
  loading: boolean
  error: string
  fetchedAt: number
  retryAt: number
}

/** Pages and live snapshots can overlap, or omit items from an existing turn. */
export function mergeSubagentTurns(previous: any[], incoming: any[], prepend = false): any[] {
  const ordered = prepend ? [...incoming, ...previous] : [...previous, ...incoming]
  const turns = new Map<string, any>()
  for (const turn of ordered) if (turn?.id && !turns.has(turn.id)) turns.set(turn.id, turn)
  // Incoming fields always win, including an updated outcome on an older page.
  for (const turn of incoming) {
    if (!turn?.id) continue
    const old = previous.find(candidate => candidate.id === turn.id)
    const items = new Map<string, any>((old?.items || []).map((item: any) => [item.id, item]))
    for (const item of turn.items || []) items.set(item.id, { ...items.get(item.id), ...item })
    const fields = Object.fromEntries(Object.entries(turn).filter(([, value]) => value !== undefined))
    turns.set(turn.id, { ...old, ...fields, items: [...items.values()] })
  }
  return [...turns.values()]
}

type ReadResult = { thread?: any; turns?: any[]; nextCursor?: string | null }
type Snapshot = { thread?: any; turns?: any[] }
type Flight = { id: string; earlier: boolean; epoch: number; resolve: () => void; promise: Promise<void> }

/** Browser-memory-only, scoped to one authenticated host and parent. Reading
 * child history never resumes its thread or acquires the child writer. */
export class SubagentContentCache {
  readonly entries = new Map<string, SubagentContent>()
  private epoch = 0
  private running = 0
  private queue: Flight[] = []
  private flights = new Map<string, Flight>()
  constructor(
    private read: (id: string, cursor?: string | null) => Promise<ReadResult>,
    private changed: () => void,
    private snapshot: (id: string) => Snapshot | undefined = () => undefined,
    private concurrency = 3,
  ) {}

  private entry(id: string): SubagentContent {
    if (!this.entries.has(id)) this.entries.set(id, {
      thread: null, turns: [], cursor: null, hydrated: false, loading: false,
      error: '', fetchedAt: 0, retryAt: 0,
    })
    return this.entries.get(id)!
  }

  reset(clear = true) {
    ++this.epoch
    for (const flight of this.flights.values()) flight.resolve()
    this.flights.clear()
    this.queue = []
    if (clear) this.entries.clear()
    else for (const entry of this.entries.values()) entry.loading = false
    this.changed()
  }

  live(id: string) {
    const snapshot = this.snapshot(id)
    if (!snapshot?.turns?.length) return
    const entry = this.entry(id)
    entry.thread = snapshot.thread ? { ...entry.thread, ...snapshot.thread } : entry.thread
    entry.turns = mergeSubagentTurns(entry.turns, snapshot.turns)
    this.changed()
  }

  request(id: string, { force = false, earlier = false } = {}): Promise<void> {
    if (this.flights.has(id)) return this.flights.get(id)!.promise
    const entry = this.entry(id)
    if ((!force && entry.hydrated) || (!force && entry.retryAt > Date.now()) || (earlier && !entry.cursor))
      return Promise.resolve()
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    const flight = { id, earlier, epoch: this.epoch, resolve, promise }
    this.flights.set(id, flight)
    this.queue.push(flight)
    entry.loading = true
    entry.error = ''
    this.changed()
    this.drain()
    return promise
  }

  private drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const flight = this.queue.shift()!
      ++this.running
      void this.run(flight)
    }
  }

  private async run(flight: Flight) {
    const current = () => flight.epoch === this.epoch && this.flights.get(flight.id) === flight
    const entry = this.entry(flight.id)
    try {
      const result = await this.read(flight.id, flight.earlier ? entry.cursor : undefined)
      if (!current()) return
      entry.thread = result.thread || entry.thread
      entry.turns = mergeSubagentTurns(entry.turns, Array.isArray(result.turns) ? result.turns : [], flight.earlier)
      // Refreshing the newest page must preserve the cursor after loading older pages.
      if (flight.earlier || !entry.hydrated) entry.cursor = result.nextCursor || null
      entry.hydrated = true
      entry.fetchedAt = Date.now()
      entry.retryAt = 0
      const snapshot = this.snapshot(flight.id)
      if (snapshot?.turns?.length) entry.turns = mergeSubagentTurns(entry.turns, snapshot.turns)
    } catch (cause: any) {
      if (current()) {
        entry.error = cause?.message || '无法读取子智能体对话'
        entry.retryAt = Date.now() + 15_000
      }
    } finally {
      --this.running
      if (current()) {
        entry.loading = false
        this.flights.delete(flight.id)
        this.changed()
      }
      flight.resolve()
      this.drain()
    }
  }
}
