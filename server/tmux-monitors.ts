import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Express, RequestHandler } from 'express';
import type { BridgeOptions } from './bridge.js';
import { writePrivateJson } from './storage.js';
import { collectTmuxMonitorPanes, tmuxMonitorPaneSchema, type TmuxMonitorReading } from './tmux-monitor-reader.js';
import type { Host } from './types.js';
import { tmuxOutcomeLabel, type TmuxMonitor, type TmuxMonitorEvent, type TmuxMonitorHost, type TmuxMonitorSnapshot } from '../shared/tmux-monitors.js';

const MAX_MONITORS = 64;
const MAX_HISTORY = 300;
const identifier = z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const threadId = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const createInput = z.object({
  hostId: identifier, sessionId: z.string().regex(/^\$\d{1,13}$/), paneId: z.string().regex(/^%\d{1,13}$/),
  mode: z.enum(['once', 'permanent']), threadId: threadId.optional(),
}).strict();
const patchInput = z.object({ paused: z.boolean() }).strict();
const timestamp = z.number().finite().nonnegative();
const monitorSchema = tmuxMonitorPaneSchema.pick({ serverPid: true, sessionId: true, sessionCreatedAt: true, sessionName: true, windowId: true, windowIndex: true, paneId: true, paneIndex: true, command: true, cwd: true, jobKey: true }).extend({
  id: z.string().uuid(), hostId: identifier, hostName: z.string().max(256), mode: z.enum(['once', 'permanent']), threadId: threadId.optional(),
  status: z.enum(['waiting', 'running', 'disconnected', 'completed', 'paused']), run: z.number().int().nonnegative().safe(),
  createdAt: timestamp, updatedAt: timestamp, lastCheckedAt: timestamp.nullable(), error: z.string().max(300).optional(),
}).strict();
const eventSchema = z.object({
  id: z.string().max(128), monitorId: z.string().uuid(), hostId: identifier, hostName: z.string().max(256),
  sessionName: z.string().max(256), sessionId: z.string().regex(/^\$\d{1,13}$/), paneId: z.string().regex(/^%\d{1,13}$/),
  command: z.string().max(256), cwd: z.string().max(4096), at: timestamp,
  outcome: z.enum(['returned-to-shell', 'exited', 'failed', 'pane-closed', 'replaced']), exitCode: z.number().int().nullable(),
  threadId: threadId.optional(), notification: z.enum(['pending', 'queued']),
}).strict();
const documentSchema = z.object({ version: z.literal(1), monitors: z.array(monitorSchema).max(MAX_MONITORS), history: z.array(eventSchema).max(MAX_HISTORY + MAX_MONITORS) }).strict()
  .refine(value => new Set(value.monitors.map(monitor => monitor.id)).size === value.monitors.length && new Set(value.history.map(event => event.id)).size === value.history.length, 'Duplicate tmux monitor identities');
const route = (handler: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next); };
const error = (message: string, status = 409) => Object.assign(new Error(message), { status });

export type TmuxMonitorDependencies = {
  getHost: (hostId: string) => Host | undefined;
  bridgeOptions?: BridgeOptions;
  collect?: (host: Host) => Promise<TmuxMonitorReading>;
  notify: (host: Host, notice: { id: string; title: string; body: string; kind: 'completed' | 'errors'; url: string; threadId?: string }) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  autoStart?: boolean;
};

export function tmuxMonitorUrl(event: Pick<TmuxMonitorEvent, 'hostId' | 'sessionId' | 'paneId' | 'threadId'>) {
  return '/?' + new URLSearchParams({ host: event.hostId, tmuxSession: event.sessionId, tmuxPane: event.paneId, ...(event.threadId ? { thread: event.threadId } : {}) });
}

/** Durable job transitions are committed before publishing notifications. */
export class TmuxMonitorService {
  private monitors: TmuxMonitor[] = [];
  private history: TmuxMonitorEvent[] = [];
  private hosts = new Map<string, TmuxMonitorHost>();
  private queue: Promise<unknown> = Promise.resolve();
  private sampling = new Map<string, Promise<TmuxMonitorHost>>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking?: Promise<void>;
  private closed = false;
  private started: boolean;
  private readonly now: () => number;
  private readonly file: string;
  private readonly collect: (host: Host) => Promise<TmuxMonitorReading>;
  constructor(dataDir: string, private readonly deps: TmuxMonitorDependencies) {
    this.file = path.join(dataDir, 'tmux-monitors.json');
    this.now = deps.now || Date.now;
    this.collect = deps.collect || (host => collectTmuxMonitorPanes(host, deps.bridgeOptions));
    this.started = deps.autoStart !== false;
  }
  async initialize() {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid tmux monitor journal');
      const document = documentSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      this.monitors = document.monitors; this.history = document.history;
      await fs.chmod(this.file, 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read tmux-monitors.json; restore the saved monitor journal before restarting', { cause });
    }
    this.schedule(0);
  }
  get(): TmuxMonitorSnapshot {
    return structuredClone({ monitors: this.monitors, history: this.history, hosts: [...this.hosts.values()] });
  }
  private exclusive<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  private async commit(monitors: TmuxMonitor[], history: TmuxMonitorEvent[]) {
    // Retain every not-yet-queued notice while bounding already delivered history.
    const pending = history.filter(event => event.notification === 'pending');
    if (pending.length > MAX_MONITORS) throw error('待发送的任务通知过多，请检查通知连接后重试');
    const retained = new Set([...pending, ...history.filter(event => event.notification === 'queued').slice(-MAX_HISTORY)].map(event => event.id));
    const nextHistory = history.filter(event => retained.has(event.id));
    await writePrivateJson(this.file, { version: 1, monitors, history: nextHistory });
    this.monitors = monitors; this.history = nextHistory;
  }
  private schedule(delay = this.deps.pollIntervalMs ?? 5000) {
    if (this.closed || !this.started || this.timer || !this.monitors.some(monitor => !['paused', 'completed'].includes(monitor.status)) && !this.history.some(event => event.notification === 'pending')) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().catch(() => {}).finally(() => this.schedule()); }, delay);
    this.timer.unref();
  }
  start() { if (!this.closed) { this.started = true; this.schedule(0); } }
  async discover(hostId: string): Promise<TmuxMonitorHost> {
    const host = this.deps.getHost(hostId);
    if (!host) throw error('主机已不存在，请刷新列表', 404);
    const existing = this.sampling.get(hostId);
    if (existing) return existing;
    const operation = (async () => {
      const reading = await this.collect(host);
      if (this.deps.getHost(hostId) !== host) throw error('主机配置已变化，请重新读取');
      const value = { hostId, hostName: host.name, sampledAt: this.now(), ...reading };
      this.hosts.set(hostId, value);
      while (this.hosts.size > 32) this.hosts.delete(this.hosts.keys().next().value!);
      return structuredClone(value);
    })();
    this.sampling.set(hostId, operation);
    try { return await operation; } finally { if (this.sampling.get(hostId) === operation) this.sampling.delete(hostId); }
  }
  async create(raw: unknown) {
    const input = createInput.parse(raw);
    const host = this.deps.getHost(input.hostId);
    if (!host) throw error('主机已不存在，请刷新列表', 404);
    const discovered = await this.discover(input.hostId);
    const pane = discovered.panes.find(pane => pane.sessionId === input.sessionId && pane.paneId === input.paneId);
    if (!discovered.available || !pane || pane.dead) throw error(discovered.reason || '窗格已结束，请刷新后选择正在运行的任务或 Shell');
    return this.exclusive(async () => {
      if (this.deps.getHost(input.hostId) !== host) throw error('主机配置已变化，请重新选择');
      if (this.monitors.length >= MAX_MONITORS) throw error('最多保存 64 个监控，请先删除不再需要的监控');
      if (this.monitors.some(monitor => monitor.hostId === input.hostId && monitor.serverPid === pane.serverPid && monitor.sessionCreatedAt === pane.sessionCreatedAt && monitor.paneId === pane.paneId && !['paused', 'completed'].includes(monitor.status))) throw error('此窗格已有活动监控');
      const at = this.now();
      const monitor: TmuxMonitor = { id: randomUUID(), hostId: host.id, hostName: host.name, sessionName: pane.sessionName,
        serverPid: pane.serverPid, sessionId: pane.sessionId, sessionCreatedAt: pane.sessionCreatedAt, windowId: pane.windowId, windowIndex: pane.windowIndex,
        paneId: pane.paneId, paneIndex: pane.paneIndex, cwd: pane.cwd, mode: input.mode,
        ...(input.threadId ? { threadId: input.threadId } : {}), status: pane.active ? 'running' : 'waiting',
        command: pane.command, jobKey: pane.jobKey, run: pane.active ? 1 : 0, createdAt: at, updatedAt: at, lastCheckedAt: at };
      await this.commit([...this.monitors, monitor], this.history);
      this.schedule(); return structuredClone(monitor);
    });
  }
  async pause(id: string, raw: unknown) {
    const { paused } = patchInput.parse(raw);
    return this.exclusive(async () => {
      const value = this.monitors.find(monitor => monitor.id === id);
      if (!value) throw error('监控已不存在', 404);
      if (value.status === 'completed') throw error('此单次监控已完成，请重新添加监控');
      if (!paused && this.monitors.some(monitor => monitor.id !== id && monitor.hostId === value.hostId &&
        monitor.serverPid === value.serverPid && monitor.paneId === value.paneId && !['paused', 'completed'].includes(monitor.status)))
        throw error('此窗格已有其他活动监控');
      const next = { ...value, status: paused ? 'paused' as const : 'waiting' as const, jobKey: null, updatedAt: this.now(), error: undefined };
      await this.commit(this.monitors.map(monitor => monitor.id === id ? next : monitor), this.history);
      this.schedule(); return structuredClone(next);
    });
  }
  async remove(id: string) {
    return this.exclusive(async () => {
      if (!this.monitors.some(monitor => monitor.id === id)) throw error('监控已不存在', 404);
      await this.commit(this.monitors.filter(monitor => monitor.id !== id), this.history);
    });
  }
  async clearHistory() {
    return this.exclusive(async () => { await this.commit(this.monitors, this.history.filter(event => event.notification === 'pending')); });
  }
  private event(monitor: TmuxMonitor, outcome: TmuxMonitorEvent['outcome'], exitCode: number | null): TmuxMonitorEvent {
    return { id: `tmux:${monitor.id}:${monitor.run}`, monitorId: monitor.id, hostId: monitor.hostId, hostName: monitor.hostName,
      sessionName: monitor.sessionName, sessionId: monitor.sessionId, paneId: monitor.paneId, cwd: monitor.cwd,
      command: monitor.command, at: this.now(), outcome, exitCode, ...(monitor.threadId ? { threadId: monitor.threadId } : {}), notification: 'pending' };
  }
  private async applyReading(hostId: string, reading: TmuxMonitorHost) {
    if (!reading.available) throw error(reading.reason || '此主机的 tmux 暂不可用');
    await this.exclusive(async () => {
      const next = structuredClone(this.monitors), events = [...this.history];
      let changed = false;
      for (const monitor of next) {
        if (monitor.hostId !== hostId || ['paused', 'completed'].includes(monitor.status)) continue;
        monitor.lastCheckedAt = this.now();
        const sameInstance = (pane: typeof reading.panes[number]) => pane.serverPid === monitor.serverPid && pane.sessionCreatedAt === monitor.sessionCreatedAt;
        const exact = reading.panes.find(pane => sameInstance(pane) && pane.sessionId === monitor.sessionId && pane.paneId === monitor.paneId);
        const pane = exact || (monitor.mode === 'permanent' ? reading.panes.find(pane => pane.sessionName === monitor.sessionName && pane.windowIndex === monitor.windowIndex && pane.paneIndex === monitor.paneIndex) : undefined);
        const wasRunning = monitor.jobKey !== null;
        const identityChanged = !!pane && (!sameInstance(pane) || pane.paneId !== monitor.paneId);
        const completed = wasRunning && (!pane || pane.dead || !pane.active || identityChanged || pane.jobKey !== monitor.jobKey);
        if (completed) {
          const outcome = !pane || identityChanged ? 'pane-closed' : pane.dead ? pane.exitCode !== null && pane.exitCode !== 0 ? 'failed' : 'exited' : !pane.active ? 'returned-to-shell' : 'replaced';
          const event = this.event(monitor, outcome, pane?.dead && !identityChanged ? pane.exitCode : null);
          if (!events.some(previous => previous.id === event.id)) events.push(event);
          monitor.jobKey = null; monitor.status = monitor.mode === 'once' ? 'completed' : 'waiting'; changed = true;
        }
        if (monitor.status === 'completed') { monitor.updatedAt = this.now(); delete monitor.error; continue; }
        if (pane && !pane.dead) {
          if (pane.active && monitor.jobKey !== pane.jobKey) { monitor.run++; monitor.jobKey = pane.jobKey; changed = true; }
          const status = pane.active ? 'running' : 'waiting';
          if (monitor.status !== status || monitor.command !== pane.command || monitor.error) changed = true;
          monitor.status = status; monitor.command = pane.command; monitor.cwd = pane.cwd;
          monitor.serverPid = pane.serverPid; monitor.sessionCreatedAt = pane.sessionCreatedAt; monitor.sessionId = pane.sessionId;
          monitor.windowId = pane.windowId; monitor.paneId = pane.paneId; delete monitor.error;
        } else {
          if (monitor.status !== 'waiting' || monitor.error) changed = true;
          monitor.status = 'waiting'; delete monitor.error;
        }
        if (changed) monitor.updatedAt = this.now();
      }
      if (changed) await this.commit(next, events);
      else this.monitors = next; // Timestamp-only observations do not rewrite the disk journal.
    });
  }
  private async recordFailure(hostId: string, cause: unknown) {
    const message = (cause instanceof Error ? cause.message : '读取 tmux 失败').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
    await this.exclusive(async () => {
      let changed = false;
      const next = this.monitors.map(monitor => {
        if (monitor.hostId !== hostId || ['paused', 'completed'].includes(monitor.status)) return monitor;
        if (monitor.status !== 'disconnected' || monitor.error !== message) changed = true;
        return { ...monitor, status: 'disconnected' as const, error: message, lastCheckedAt: this.now(), updatedAt: this.now() };
      });
      if (changed) await this.commit(next, this.history);
    });
  }
  private async deliver() {
    for (const event of [...this.history].filter(event => event.notification === 'pending')) {
      if (this.closed) break;
      const host = this.deps.getHost(event.hostId);
      if (!host) continue;
      try {
        await this.deps.notify(host, { id: event.id, title: `${event.hostName} · Tmux ${event.sessionName}`,
          body: `${event.command || '任务'}：${tmuxOutcomeLabel(event.outcome)}${event.exitCode === null ? '' : `（退出码 ${event.exitCode}）`}`,
          kind: event.outcome === 'failed' ? 'errors' : 'completed', url: tmuxMonitorUrl(event), ...(event.threadId ? { threadId: event.threadId } : {}) });
        await this.exclusive(async () => { await this.commit(this.monitors, this.history.map(value => value.id === event.id ? { ...value, notification: 'queued' as const } : value)); });
      } catch { /* Keep the durable event pending; the next tick retries with the same id. */ }
    }
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const operation = (async () => {
      const hosts = [...new Set(this.monitors.filter(monitor => !['paused', 'completed'].includes(monitor.status)).map(monitor => monitor.hostId))];
      // Different hosts may run concurrently; each host transport serializes background readers.
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, hosts.length) }, async () => {
        while (cursor < hosts.length) {
          const hostId = hosts[cursor++]!;
          try { await this.applyReading(hostId, await this.discover(hostId)); }
          catch (cause) { await this.recordFailure(hostId, cause); }
        }
      }));
      await this.deliver();
    })();
    this.ticking = operation;
    return operation.finally(() => { if (this.ticking === operation) this.ticking = undefined; });
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    await this.ticking; await this.queue;
  }
}

/** Authentication and CSRF middleware are installed by createApp before these routes. */
export async function registerTmuxMonitors(app: Express, dataDir: string, deps: TmuxMonitorDependencies) {
  const service = new TmuxMonitorService(dataDir, deps); await service.initialize();
  app.get('/api/tmux-monitors', (_req, res) => res.json(service.get()));
  app.post('/api/tmux-monitors/discover', route(async (req, res) => { const { hostId } = z.object({ hostId: identifier }).strict().parse(req.body); res.json(await service.discover(hostId)); }));
  app.post('/api/tmux-monitors', route(async (req, res) => res.status(201).json(await service.create(req.body))));
  app.patch('/api/tmux-monitors/:id', route(async (req, res) => res.json(await service.pause(z.string().uuid().parse(req.params.id), req.body))));
  app.delete('/api/tmux-monitors/history', route(async (_req, res) => { await service.clearHistory(); res.json({ ok: true }); }));
  app.delete('/api/tmux-monitors/:id', route(async (req, res) => { await service.remove(z.string().uuid().parse(req.params.id)); res.json({ ok: true }); }));
  return service;
}
