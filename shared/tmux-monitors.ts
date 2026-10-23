export type TmuxMonitorMode = 'once' | 'permanent';
export type TmuxMonitorOutcome = 'returned-to-shell' | 'exited' | 'failed' | 'pane-closed' | 'replaced';
export type TmuxMonitorPane = {
  serverPid: number;
  sessionId: string;
  sessionName: string;
  sessionCreatedAt: number;
  windowId: string;
  windowIndex: number;
  windowName: string;
  paneId: string;
  paneIndex: number;
  command: string;
  cwd: string;
  active: boolean;
  dead: boolean;
  exitCode: number | null;
  jobKey: string | null;
};
export type TmuxMonitor = {
  id: string;
  hostId: string;
  hostName: string;
  sessionName: string;
  sessionCreatedAt: number;
  serverPid: number;
  sessionId: string;
  windowId: string;
  windowIndex: number;
  paneId: string;
  paneIndex: number;
  cwd: string;
  mode: TmuxMonitorMode;
  threadId?: string;
  status: 'waiting' | 'running' | 'disconnected' | 'completed' | 'paused';
  command: string;
  jobKey: string | null;
  run: number;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  error?: string;
};
export type TmuxMonitorEvent = {
  id: string;
  monitorId: string;
  hostId: string;
  hostName: string;
  sessionName: string;
  sessionId: string;
  paneId: string;
  cwd: string;
  command: string;
  at: number;
  outcome: TmuxMonitorOutcome;
  exitCode: number | null;
  threadId?: string;
  notification: 'pending' | 'queued';
};
export type TmuxMonitorHost = {
  hostId: string;
  hostName: string;
  sampledAt: number;
  available: boolean;
  reason?: string;
  panes: TmuxMonitorPane[];
};
export type TmuxMonitorSnapshot = {
  monitors: TmuxMonitor[];
  history: TmuxMonitorEvent[];
  hosts: TmuxMonitorHost[];
};

export const tmuxOutcomeLabel = (outcome: TmuxMonitorOutcome) => ({
  'returned-to-shell': '任务已返回 Shell',
  exited: '进程已退出',
  failed: '进程异常退出',
  'pane-closed': '窗格已关闭',
  replaced: '上一次任务已结束',
})[outcome];
