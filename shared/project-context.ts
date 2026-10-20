/** Durable, client-owned source classification supported by the native protocol. */
export const PROJECTLESS_THREAD_SOURCE = 'codex-web:no-project';

export function isProjectlessThread(thread: { projectId?: string | null; threadSource?: string | null } | null | undefined): boolean {
  // Moving the thread into a native project takes precedence over its origin.
  return !!thread && !thread.projectId && thread.threadSource === PROJECTLESS_THREAD_SOURCE;
}
