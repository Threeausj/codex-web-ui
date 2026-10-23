export type PushTarget = { hostId: string; threadId?: string; tmuxSession?: string; tmuxPane?: string };

/** Notification links select existing chats/panes; never send input or approve work. */
export function pushTarget(value: unknown): PushTarget | null {
  if (!value || typeof value !== "object") return null;
  const { hostId, threadId, tmuxSession, tmuxPane } = value as Record<string, unknown>;
  const valid = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  if (!valid(hostId)) return null;
  const thread = valid(threadId) ? threadId : undefined;
  if (typeof tmuxSession === "string" && /^\$\d{1,13}$/.test(tmuxSession)) {
    if (tmuxPane != null && tmuxPane !== "" && (typeof tmuxPane !== "string" || !/^%\d{1,13}$/.test(tmuxPane))) return null;
    return { hostId, ...(thread ? { threadId: thread } : {}), tmuxSession,
      ...(typeof tmuxPane === "string" && tmuxPane ? { tmuxPane } : {}) };
  }
  return thread ? { hostId, threadId: thread } : null;
}

export function pushTargetFromUrl(url: URL): PushTarget | null {
  return pushTarget({ hostId: url.searchParams.get("host"), threadId: url.searchParams.get("thread"),
    tmuxSession: url.searchParams.get("tmuxSession"), tmuxPane: url.searchParams.get("tmuxPane") });
}
