export type Pin = {
  kind: "project" | "thread";
  hostId: string;
  id: string;
  label?: string;
};
export function projectKey(hostId: string, path: string) {
  return `project:${hostId}:${path}`;
}
export function matchesProject(
  thread: { cwd?: string; hostId?: string },
  project: { path: string; rootPaths?: string[]; hostId?: string },
) {
  if (thread.hostId && project.hostId && thread.hostId !== project.hostId)
    return false;
  const cwd = thread.cwd?.replace(/\/$/, "");
  return [project.path, ...(project.rootPaths || [])].some(
    (root) => root.replace(/\/$/, "") === cwd,
  );
}
type ThreadActivity = { recencyAt?: number | null; createdAt?: number };
function timestampSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value >= 1e12
      ? value / 1000
      : value
    : 0;
}
/** updatedAt also changes on resume/configuration writes. Only content recency
 * (or creation for a thread without content) belongs in the chat navigation. */
export function threadActivityAt(thread: ThreadActivity): number {
  return timestampSeconds(thread.recencyAt) || timestampSeconds(thread.createdAt);
}
export function turnActivityAt(turn: {
  startedAt?: number | null;
  completedAt?: number | null;
}): number {
  return Math.max(
    timestampSeconds(turn.startedAt),
    timestampSeconds(turn.completedAt),
  );
}
/** Legacy servers may not expose recencyAt. Derive it from their latest turn
 * instead of treating a metadata write as a new message. */
export function historyActivityAt(
  thread: ThreadActivity,
  turns: { startedAt?: number | null; completedAt?: number | null }[],
  previous?: number,
): number {
  return (
    timestampSeconds(thread.recencyAt) ||
    Math.max(timestampSeconds(previous), ...turns.map(turnActivityAt)) ||
    timestampSeconds(thread.createdAt)
  );
}
export function sortedThreads<T extends ThreadActivity>(threads: T[]): T[] {
  return [...threads].sort((a, b) => threadActivityAt(b) - threadActivityAt(a));
}
export function threadLabel(thread: {
  name?: string;
  preview?: string;
  id: string;
}) {
  return thread.name || thread.preview || "未命名对话";
}
export function isPinned(
  pins: Pin[],
  hostId: string,
  kind: Pin["kind"],
  id: string,
) {
  return pins.some(
    (pin) => pin.hostId === hostId && pin.kind === kind && pin.id === id,
  );
}
export function togglePin(pins: Pin[], pin: Pin): Pin[] {
  return isPinned(pins, pin.hostId, pin.kind, pin.id)
    ? pins.filter(
        (item) =>
          item.hostId !== pin.hostId ||
          item.kind !== pin.kind ||
          item.id !== pin.id,
      )
    : [...pins, pin];
}
export function exportThreadMarkdown(thread: any, turns: any[]) {
  const lines = [
    `# ${threadLabel(thread)}`,
    "",
    `项目：${thread.cwd || ""}`,
    `会话：${thread.id}`,
    "",
  ];
  for (const turn of turns)
    for (const item of turn.items || []) {
      if (item.type === "userMessage")
        lines.push(
          "## 用户",
          "",
          (item.content || [])
            .map((input: any) =>
              input.type === "text"
                ? input.text
                : input.type === "localImage"
                  ? `图片：${input.path}`
                  : input.type === "image"
                    ? `图片：${input.url}`
                    : input.name || "",
            )
            .filter(Boolean)
            .join("\n"),
          "",
        );
      else if (item.type === "agentMessage")
        lines.push("## Codex", "", item.text || "", "");
      else if (item.type === "commandExecution")
        lines.push(
          "### 命令",
          "",
          "```sh",
          item.command || "",
          "```",
          "",
          "```text",
          item.aggregatedOutput || "",
          "```",
          "",
        );
      else if (item.type === "fileChange")
        for (const change of item.changes || [])
          lines.push(
            `### ${change.path}`,
            "",
            "```diff",
            change.diff || "",
            "```",
            "",
          );
    }
  return lines.join("\n");
}
