import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Host, RpcMessage } from './types.js';
import type { Bridge } from './bridge.js';

const cadence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(5).max(10080) }).strict(),
  z.object({ kind: z.literal('daily'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict(),
  z.object({ kind: z.literal('weekly'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), days: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).strict(),
]);
export const automationInput = z.object({
  name: z.string().trim().min(1).max(100), hostId: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value)),
  prompt: z.string().trim().min(1).max(16000), model: z.string().max(256), effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']),
  permission: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
  cadence, enabled: z.boolean(), maxRetries: z.number().int().min(0).max(3).default(1),
}).strict();
export type AutomationInput = z.infer<typeof automationInput>;
type Automation = AutomationInput & { id: string; createdAt: number; updatedAt: number; nextAt: number | null };
type Phase = 'queued' | 'connecting' | 'creating' | 'dispatching' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'needs_review';
export type AutomationRun = {
  id: string; automationId: string; scheduledAt: number; createdAt: number; updatedAt: number; finishedAt?: number;
  phase: Phase; attempt: number; retryAt?: number; threadId?: string; turnId?: string; clientId: string; engineId?: string;
  spec: AutomationInput; error?: string; logs: { at: number; text: string }[];
};
const active = (run: AutomationRun) => ['queued', 'connecting', 'creating', 'dispatching', 'running', 'waiting'].includes(run.phase);
const terminal = (run: AutomationRun) => !active(run);

/** One occurrence per local calendar date, including daylight-saving transitions. */
export function nextAutomationAt(spec: Pick<AutomationInput, 'cadence' | 'timezone'>, after: number): number {
  if (spec.cadence.kind === 'interval') return after + spec.cadence.minutes * 60000;
  const format = new Intl.DateTimeFormat('en-US', { timeZone: spec.timezone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fields = (at: number) => Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
  const before = fields(after), previousDay = `${before.year}-${before.month}-${before.day}`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let at = Math.floor(after / 60000) * 60000 + 60000, end = after + 9 * 86400000; at <= end; at += 60000) {
    const local = fields(at);
    if (Number(local.hour) !== spec.cadence.hour || Number(local.minute) !== spec.cadence.minute) continue;
    if (spec.cadence.kind === 'weekly' && !spec.cadence.days.includes(days.indexOf(local.weekday!))) continue;
    // On a repeated DST hour, do not schedule the same wall-clock minute twice.
    if (`${local.year}-${local.month}-${local.day}` === previousDay && (Number(before.hour) * 60 + Number(before.minute)) >= spec.cadence.hour * 60 + spec.cadence.minute) continue;
    return at;
  }
  throw new Error('无法计算下一次执行时间');
}

type Dependencies = { getBridge(hostId: string): Promise<Bridge>; getHost(hostId: string): Host | undefined; now?: () => number };
export class AutomationService {
  private tasks: Automation[] = [];
  private runs: AutomationRun[] = [];
  private writes: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private closed = false;
  private operations = new Map<string, Promise<void>>();
  private readonly file: string;
  private readonly now: () => number;
  error = '';
  constructor(dataDir: string, private dependencies: Dependencies) { this.file = path.join(dataDir, 'automations.json'); this.now = dependencies.now || Date.now; }
  async initialize(start = true) {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.tasks) || saved.tasks.length > 50 || !Array.isArray(saved.runs) || saved.runs.length > 1000) throw new Error('Invalid automation journal');
      this.tasks = saved.tasks.map((entry: any) => {
        const { id, createdAt, updatedAt, nextAt, ...input } = entry;
        if (!z.string().uuid().safeParse(id).success || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || nextAt !== null && !Number.isFinite(nextAt)) throw new Error('Invalid automation');
        return { ...automationInput.parse(input), id, createdAt, updatedAt, nextAt };
      });
      this.runs = saved.runs.map((entry: any) => {
        if (!z.string().uuid().safeParse(entry.id).success || !z.string().uuid().safeParse(entry.clientId).success || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.scheduledAt) || !Array.isArray(entry.logs) || entry.logs.length > 100 || !['queued','connecting','creating','dispatching','running','waiting','completed','failed','interrupted','needs_review'].includes(entry.phase)) throw new Error('Invalid automation run');
        return { ...entry, spec: automationInput.parse(entry.spec) } as AutomationRun;
      });
      // A new Web process cannot prove ownership of the previous native writer.
      // Preserve known IDs for read-only reconciliation; never resend blindly.
      for (const run of this.runs.filter(active)) {
        if (['queued', 'connecting'].includes(run.phase)) run.phase = 'queued';
        else { this.note(run, 'needs_review', '服务重启，原生执行结果需要核对；不会重复提交'); run.retryAt = undefined; }
      }
      await this.save();
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取自动化执行记录，请检查数据目录'); }
    if (start) { this.timer = setInterval(() => { void this.tick().catch(cause => { this.error = (cause as Error).message; }); }, 10000); this.timer.unref(); }
  }
  list() { return { tasks: structuredClone(this.tasks), runs: structuredClone(this.runs.slice(-300).reverse()), error: this.error }; }
  private save() {
    const snapshot = JSON.stringify({ version: 1, tasks: this.tasks, runs: this.runs });
    const operation = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, this.file); await fs.chmod(this.file, 0o600); }
      finally { await fs.rm(temporary, { force: true }); }
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  async put(input: unknown, id?: string) {
    const spec = automationInput.parse(input);
    if (!this.dependencies.getHost(spec.hostId)) throw Object.assign(new Error('主机不存在'), { status: 404 });
    const previous = id ? this.tasks.find(task => task.id === id) : undefined;
    if (id && !previous) throw Object.assign(new Error('自动化不存在'), { status: 404 });
    if (!id && this.tasks.length >= 50) throw Object.assign(new Error('最多保存 50 个自动化'), { status: 409 });
    const task: Automation = { ...spec, id: id || randomUUID(), createdAt: previous?.createdAt || this.now(), updatedAt: this.now(), nextAt: spec.enabled ? nextAutomationAt(spec, this.now()) : null };
    const before = this.tasks; this.tasks = previous ? this.tasks.map(entry => entry.id === id ? task : entry) : [...this.tasks, task];
    try { await this.save(); } catch (cause) { this.tasks = before; throw cause; } return structuredClone(task);
  }
  async remove(id: string) {
    if (this.runs.some(run => run.automationId === id && active(run))) throw Object.assign(new Error('请先停止正在执行的自动化'), { status: 409 });
    if (!this.tasks.some(task => task.id === id)) throw Object.assign(new Error('自动化不存在'), { status: 404 });
    const retries = this.runs.filter(run => run.automationId === id && run.retryAt).map(run => ({ run, retryAt: run.retryAt }));
    for (const { run } of retries) run.retryAt = undefined;
    const before = this.tasks; this.tasks = this.tasks.filter(task => task.id !== id);
    try { await this.save(); } catch (cause) { this.tasks = before; for (const { run, retryAt } of retries) run.retryAt = retryAt; throw cause; }
  }
  private note(run: AutomationRun, phase: Phase, text: string) {
    run.phase = phase; run.updatedAt = this.now(); run.logs.push({ at: this.now(), text: text.slice(0, 1000) });
    if (run.logs.length > 100) run.logs.splice(0, run.logs.length - 100);
    if (terminal(run)) run.finishedAt = this.now();
    else delete run.finishedAt;
  }
  private async enqueue(task: Automation, occurrence: number) {
    if (this.runs.some(run => run.automationId === task.id && (active(run) || run.retryAt || run.phase === 'needs_review'))) throw Object.assign(new Error('此自动化仍在执行或等待结果核对'), { status: 409 });
    if (this.runs.filter(run => !terminal(run)).length >= 20) throw Object.assign(new Error('自动化等待队列已满'), { status: 409 });
    const { id, createdAt, updatedAt, nextAt, ...spec } = task;
    const run: AutomationRun = { id: randomUUID(), automationId: id, scheduledAt: occurrence, createdAt: this.now(), updatedAt: this.now(), phase: 'queued', attempt: 0, clientId: randomUUID(), spec, logs: [{ at: this.now(), text: '执行已持久化入队' }] };
    const before = [...this.runs]; this.runs.push(run);
    while (this.runs.length > 1000) { const index = this.runs.findIndex(entry => terminal(entry) && entry.phase !== 'needs_review'); if (index < 0) throw new Error('执行记录容量不足'); this.runs.splice(index, 1); }
    try { await this.save(); } catch (cause) { this.runs = before; throw cause; }
    return run;
  }
  async runNow(id: string) {
    const task = this.tasks.find(task => task.id === id); if (!task) throw Object.assign(new Error('自动化不存在'), { status: 404 });
    const run = await this.enqueue(task, this.now()); void this.tick().catch(() => {}); return structuredClone(run);
  }
  async tick() {
    if (this.closed || this.ticking) return; this.ticking = true;
    try {
      for (const task of this.tasks) if (task.enabled && task.nextAt != null && task.nextAt <= this.now()) {
        const occurrence = task.nextAt;
        if (!this.runs.some(run => run.automationId === task.id && (active(run) || run.retryAt || run.phase === 'needs_review'))) await this.enqueue(task, occurrence);
        task.nextAt = nextAutomationAt(task, this.now()); await this.save();
      }
      for (const run of this.runs) {
        if (this.closed) return;
        if (run.phase === 'failed' && run.retryAt && run.retryAt <= this.now()) { run.retryAt = undefined; this.note(run, 'queued', '执行前的连接失败，按配置重试'); await this.save(); }
        if (run.phase !== 'queued' || this.operations.size >= 2) continue;
        if (this.runs.some(other => other !== run && other.spec.hostId === run.spec.hostId && ['connecting','creating','dispatching','running','waiting'].includes(other.phase))) continue;
        this.note(run, 'connecting', '正在连接主机'); await this.save();
        if (this.closed) return;
        const operation = this.execute(run).catch(cause => { this.error = (cause as Error).message; }).finally(() => this.operations.delete(run.id));
        this.operations.set(run.id, operation);
      }
    } finally { this.ticking = false; }
  }
  private async execute(run: AutomationRun) {
    let bridge: Bridge | undefined;
    try {
      run.attempt++; await this.save(); bridge = await this.dependencies.getBridge(run.spec.hostId);
      if (this.closed) return;
      if (bridge.paused) throw new Error('主机 Web Codex 已暂停，请在资源管理中恢复连接');
      await bridge.connect();
      if (this.closed) return;
      run.engineId = bridge.runtime.engineId;
      this.note(run, 'creating', '正在创建独立执行会话'); await this.save();
      if (this.closed) return;
      const result = await bridge.request('thread/start', { cwd: run.spec.cwd, model: run.spec.model || undefined, sandbox: run.spec.permission, approvalPolicy: 'never', historyMode: 'paginated' }, 30000) as any;
      if (!result?.thread?.id || result.thread.ephemeral) throw new Error('Codex 未返回正式会话 ID');
      run.threadId = result.thread.id; await this.save();
      if (this.closed) return;
      await bridge.request('thread/name/set', { threadId: run.threadId, name: `${run.spec.name} · ${new Date(run.scheduledAt).toLocaleString('zh-CN', { timeZone: run.spec.timezone })}` }, 15000);
      if (this.closed) return;
      this.note(run, 'dispatching', '会话已创建，正在提交任务'); await this.save();
      if (this.closed) return;
      const sandboxPolicy = run.spec.permission === 'danger-full-access' ? { type: 'dangerFullAccess' } : run.spec.permission === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [run.spec.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
      const started = await bridge.request('turn/start', { threadId: run.threadId, input: [{ type: 'text', text: run.spec.prompt, text_elements: [] }], clientUserMessageId: run.clientId, cwd: run.spec.cwd, model: run.spec.model || undefined, effort: run.spec.effort, sandboxPolicy, approvalPolicy: 'never' }, 30000) as any;
      if (started?.turn?.id) run.turnId = started.turn.id;
      // Native completion can arrive before the RPC acknowledgement.
      if (run.phase === 'dispatching') this.note(run, 'running', '任务正在运行');
      await this.save();
    } catch (cause: any) {
      const message = cause?.message || '执行失败'; run.error = String(message).slice(0, 1000);
      if (this.closed) { await this.save(); return; }
      const phase = run.phase;
      if (['creating','dispatching'].includes(phase) && !Number.isInteger(cause?.rpc?.code)) {
        this.note(run, 'needs_review', '原生提交结果未确认，已停止自动重试，请核对执行会话');
      } else {
        this.note(run, 'failed', `执行失败：${run.error}`);
        if (phase === 'connecting' && run.attempt <= run.spec.maxRetries) run.retryAt = this.now() + Math.min(300000, 30000 * 2 ** (run.attempt - 1));
      }
      await this.save();
    }
  }
  observe(host: Host, message: RpcMessage) {
    if (this.closed) return;
    const p = message.params as any; if (!p?.threadId) return;
    const run = this.runs.find(entry => entry.spec.hostId === host.id && entry.threadId === p.threadId && active(entry));
    if (!run) return;
    if (message.method === 'turn/started') { run.turnId = p.turn?.id; this.note(run, 'running', 'Codex 已开始执行'); }
    else if (message.method === 'turn/completed' && (!run.turnId || run.turnId === p.turn?.id)) {
      run.turnId = p.turn?.id; run.error = p.turn?.error?.message?.slice(0, 1000);
      this.note(run, p.turn?.status === 'completed' ? 'completed' : p.turn?.status === 'interrupted' ? 'interrupted' : 'failed', p.turn?.status === 'completed' ? '任务执行完成' : `任务结束：${p.turn?.status || 'failed'}`);
    } else if (message.id !== undefined && message.method) this.note(run, 'waiting', '等待输入或审批，请打开执行会话处理');
    else if (message.method === 'thread/closed') this.note(run, 'needs_review', '原生会话已关闭，请核对执行结果');
    else return;
    void this.save().catch(cause => { this.error = (cause as Error).message; });
  }
  async reconcile(id: string) {
    const run = this.runs.find(entry => entry.id === id); if (!run || run.phase !== 'needs_review' || !run.threadId) throw Object.assign(new Error('此记录没有可核对的原生会话 ID'), { status: 409 });
    const bridge = await this.dependencies.getBridge(run.spec.hostId);
    const result = await bridge.request('thread/read', { threadId: run.threadId, includeTurns: true }, 15000) as any;
    const turn = result.thread?.turns?.find((entry: any) => entry.id === run.turnId || entry.items?.some((item: any) => item.clientUserMessageId === run.clientId || item.id === run.clientId));
    if (!turn) throw Object.assign(new Error('仍无法确认原提交；请打开执行会话核对，不会自动重发'), { status: 409 });
    run.turnId = turn.id;
    if (['completed','failed','interrupted'].includes(turn.status)) this.note(run, turn.status, '已从原生历史确认执行结果');
    else this.note(run, 'needs_review', '原生历史仍显示执行中，请打开会话核对写入者');
    await this.save(); return structuredClone(run);
  }
  async retry(id: string) {
    const run = this.runs.find(entry => entry.id === id);
    if (!run || !['failed', 'interrupted'].includes(run.phase)) throw Object.assign(new Error('仅已确认失败或中断的执行可以重试'), { status: 409 });
    const task = this.tasks.find(task => task.id === run.automationId); if (!task) throw new Error('自动化已删除');
    run.retryAt = undefined; await this.save(); return this.runNow(task.id);
  }
  async cancel(id: string) {
    const run = this.runs.find(entry => entry.id === id); if (!run || !active(run)) throw Object.assign(new Error('执行已结束'), { status: 409 });
    if (run.phase === 'queued') { this.note(run, 'interrupted', '用户取消等待执行'); await this.save(); return; }
    if (!run.threadId || !run.turnId) throw Object.assign(new Error('正在提交原生操作，请等回执后停止'), { status: 409 });
    const bridge = await this.dependencies.getBridge(run.spec.hostId);
    if (bridge.runtime.engineId !== run.engineId) throw Object.assign(new Error('原生连接已变更，请先核对执行结果'), { status: 409 });
    await bridge.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }, 15000);
  }
  async close() {
    if (this.closed) { await this.writes; return; }
    this.closed = true; clearInterval(this.timer);
    for (const run of this.runs.filter(active)) {
      if (['queued', 'connecting'].includes(run.phase)) this.note(run, 'queued', '服务停止；尚未提交的执行将在启动后继续');
      else this.note(run, 'needs_review', '服务停止，保留原生会话 ID 等待核对；不会重复提交');
    }
    await this.save();
  }
}

export function registerAutomations(app: Express, service: AutomationService) {
  const route = (operation: (req: any, res: any) => Promise<unknown>) => (req: any, res: any, next: any) => { void operation(req, res).catch(next); };
  app.get('/api/automations', (_req, res) => res.json(service.list()));
  app.post('/api/automations', route(async (req, res) => res.status(201).json(await service.put(req.body))));
  app.put('/api/automations/:id', route(async (req, res) => res.json(await service.put(req.body, String(req.params.id)))));
  app.delete('/api/automations/:id', route(async (req, res) => { await service.remove(String(req.params.id)); res.json({ ok: true }); }));
  app.post('/api/automations/:id/run', route(async (req, res) => res.status(202).json(await service.runNow(String(req.params.id)))));
  app.post('/api/automation-runs/:id/:action', route(async (req, res) => {
    const action = req.params.action, id = String(req.params.id);
    if (action === 'retry') res.status(202).json(await service.retry(id));
    else if (action === 'reconcile') res.json(await service.reconcile(id));
    else if (action === 'cancel') { await service.cancel(id); res.json({ ok: true }); }
    else throw Object.assign(new Error('Unknown action'), { status: 404 });
  }));
}
