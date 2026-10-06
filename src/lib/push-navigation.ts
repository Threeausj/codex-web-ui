export type PushTarget = { hostId: string; threadId: string };

/** Notification links select existing chats; they never send input or approve work. */
export function pushTarget(value: unknown): PushTarget | null {
  if (!value || typeof value !== "object") return null;
  const { hostId, threadId } = value as Record<string, unknown>;
  const valid = (id: unknown): id is string =>
    typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  return valid(hostId) && valid(threadId) ? { hostId, threadId } : null;
}

export function pushTargetFromUrl(url: URL): PushTarget | null {
  return pushTarget({
    hostId: url.searchParams.get("host"),
    threadId: url.searchParams.get("thread"),
  });
}
