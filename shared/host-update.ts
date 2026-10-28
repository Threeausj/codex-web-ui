export type HostCodexUpdateOperation = {
  id: string; hostId: string;
  state: 'checking' | 'updating' | 'restarting' | 'completed' | 'failed';
  startedAt: number; updatedAt: number; finishedAt?: number;
  beforeVersion?: string; installedVersion?: string; runtimeVersion?: string;
  message?: string; error?: string;
};
export type HostCodexUpdateStatus = {
  command: 'codex update'; canUpdate: boolean; disabledReason?: string;
  runtimeVersion?: string; operation: HostCodexUpdateOperation | null;
};
export const activeCodexUpdate = (operation: HostCodexUpdateOperation | null | undefined) =>
  !!operation && ['checking', 'updating', 'restarting'].includes(operation.state);
