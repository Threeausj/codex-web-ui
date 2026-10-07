import type { DisplayItem } from "./events";
import { activityBlocks, publicReasoningSummary } from './activity-presentation';

export type ConversationBlock =
  | { kind: "message"; id: string; item: DisplayItem }
  | { kind: "turn"; id: string; items: DisplayItem[]; turn?: any };

/** Group process items without losing the authoritative per-turn history. */
export function conversationBlocks(
  items: DisplayItem[],
  turns: any[],
): ConversationBlock[] {
  const metadata = new Map(turns.map((turn) => [turn.id, turn]));
  const order = new Map(turns.map((turn, index) => [turn.id, index]));
  const groups = new Map<
    string,
    Extract<ConversationBlock, { kind: "turn" }>
  >();
  const blocks: ConversationBlock[] = [];
  const insertTurn = (block: Extract<ConversationBlock, { kind: "turn" }>) => {
    const position = order.get(block.id);
    const following = position == null ? -1 : blocks.findIndex((entry) =>
      entry.kind === "turn" && (order.get(entry.id) ?? -1) > position);
    if (following < 0) blocks.push(block);
    else blocks.splice(following, 0, block);
  };
  for (const item of items) {
    if (
      !item.turnId &&
      ["userMessage", "agentMessage", "contextCompaction"].includes(item.type)
    ) {
      blocks.push({ kind: "message", id: item.id, item });
      continue;
    }
    const id = item.turnId || `unassigned:${item.id}`;
    let block = groups.get(id);
    if (!block) {
      block = { kind: "turn", id, items: [], turn: metadata.get(id) };
      groups.set(id, block);
      insertTurn(block);
    }
    block.items.push(item);
  }
  // Failed or interrupted work may end before its first item is persisted.
  // Keep its status and error visible in chronological turn order.
  for (const turn of turns) {
    if (
      groups.has(turn.id) ||
      !["failed", "interrupted", "inProgress"].includes(turn.status)
    )
      continue;
    const block: Extract<ConversationBlock, { kind: "turn" }> = {
      kind: "turn",
      id: turn.id,
      items: [],
      turn,
    };
    insertTurn(block);
  }
  return blocks;
}

/** Providers may omit phase. In that case keep their last answer visible,
 * while explicit commentary is always retained in the activity disclosure. */
export function turnPresentation(items: DisplayItem[]) {
  const users = items.filter((item) => item.type === "userMessage");
  const messages = items.filter((item) => item.type === "agentMessage");
  const explicit = messages.filter((item) => item.phase === "final_answer");
  const legacy = messages.filter((item) => !item.phase);
  const answers = (explicit.length ? explicit : legacy.slice(-1)).filter(
    (item) => typeof item.text === "string" && !!item.text.trim(),
  );
  const visible = new Set([...users, ...answers].map((item) => item.id));
  const dividers = items.filter((item) => item.type === "contextCompaction");
  const answerIds = new Set(answers.map((item) => item.id));
  // Compaction can happen before a reply in the same turn. Preserve that
  // position instead of moving every divider behind the final answer.
  const outputs = items.filter((item) => answerIds.has(item.id) || item.type === "contextCompaction");
  const activity = items.filter(
    (item) => !visible.has(item.id) && item.type !== "contextCompaction" &&
      (item.type !== 'reasoning' || !!publicReasoningSummary(item)),
  );
  return { users, answers, activity, activityBlocks: activityBlocks(items, activity), dividers, outputs };
}

export function elapsedLabel(turn: any) {
  const duration =
    Number.isFinite(turn?.durationMs) && turn.durationMs >= 0
      ? turn.durationMs
      : Number.isFinite(turn?.completedAt) &&
          Number.isFinite(turn?.startedAt) &&
          turn.completedAt >= turn.startedAt
        ? (turn.completedAt - turn.startedAt) * 1000
        : null;
  if (duration === null) return "工作过程";
  const seconds = Math.max(1, Math.round(duration / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `用时 ${hours ? `${hours} 小时 ` : ""}${minutes % 60 ? `${minutes % 60} 分钟 ` : ""}${seconds % 60 || !minutes ? `${seconds % 60 || 60} 秒` : ""}`.trim();
}
