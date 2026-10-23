import type { DisplayItem } from './events';
import { asyncUserInputQuestions } from '../../shared/async-user-input';

export const RECENT_HISTORY_DETAIL_TURNS = 3;
export const COMMAND_OUTPUT_WINDOW = 128 * 1024;
export const RETAINED_COMMAND_OUTPUTS = 16;
const failed = (item: DisplayItem) => ['failed', 'declined', 'interrupted', 'cancelled'].includes(item.status) ||
  typeof item.exitCode === 'number' && item.exitCode !== 0;

/** Only reloadable intermediate history is disposable; accepted input and results are not. */
export function retainConversationHistory(items: DisplayItem[], turns: any[], protectedTurns: ReadonlySet<string> = new Set(), recent = RECENT_HISTORY_DETAIL_TURNS) {
  const groups = new Map<string, DisplayItem[]>();
  for (const item of items) if (item.turnId) {
    const group = groups.get(item.turnId) || [];
    group.push(item); groups.set(item.turnId, group);
  }
  const evicted = new Set<string>();
  const retained = new Map<string, Set<string>>();
  const nextTurns = turns.map((turn, index) => {
    if (index >= turns.length - recent || turn.status === 'inProgress' || protectedTurns.has(turn.id) || turn.historyBookmarkTarget)
      return turn;
    const content = groups.get(turn.id) || [];
    if (!content.length) return turn;
    const messages = content.filter(item => item.type === 'agentMessage');
    const final = messages.filter(item => item.phase === 'final_answer');
    const answers = new Set((final.length ? final : messages.filter(item => !item.phase).slice(-1)).map(item => item.id));
    const keep = content.filter(item => ['userMessage', 'contextCompaction', 'plan', 'threadGoal'].includes(item.type) ||
      answers.has(item.id) || failed(item) || item.pendingApproval != null || item.requestId != null ||
      asyncUserInputQuestions(item).length > 0);
    if (keep.length === content.length) return turn;
    evicted.add(turn.id); retained.set(turn.id, new Set(keep.map(item => item.id)));
    return { ...turn, items: keep, diff: undefined, historySummary: true, historyDetailsEvicted: true,
      historyItemsStarted: false, historyItemsCursor: null, historyItemIds: [], historyItemCursors: [] };
  });
  return { items: evicted.size ? items.filter(item => !item.turnId || !evicted.has(item.turnId) || retained.get(item.turnId)!.has(item.id)) : items,
    turns: evicted.size ? nextTurns : turns, evicted };
}

/** Materialize a bounded tail so a sliced V8 string cannot retain its huge parent. */
export function boundConversationOutputs(items: DisplayItem[], limit = COMMAND_OUTPUT_WINDOW) {
  let changed = false;
  const commands = items.filter(item => item.type === 'commandExecution');
  const recent = new Set(commands.slice(-RETAINED_COMMAND_OUTPUTS).map(item => item.id));
  const previousByTurn = new Map<string, string>();
  const next = items.map(item => {
    const previous = item.turnId ? previousByTurn.get(item.turnId) : undefined;
    if (item.turnId) previousByTurn.set(item.turnId, item.id);
    const window = recent.has(item.id) || ['inProgress', 'running'].includes(item.status) || failed(item) || item.pendingApproval != null || item.requestId != null ? limit : 0;
    if (item.type !== 'commandExecution' || typeof item.aggregatedOutput !== 'string' || item.aggregatedOutput.length <= window) return item;
    changed = true;
    const oldLength = Number.isFinite(item.outputWindowLength) ? item.outputWindowLength : item.aggregatedOutput.length;
    const total = Number.isFinite(item.outputTotalLength) ? item.outputTotalLength + Math.max(0, item.aggregatedOutput.length - oldLength) : item.aggregatedOutput.length;
    return { ...item, aggregatedOutput: window ? item.aggregatedOutput.slice(-window).split('').join('') : '', outputWindowLength: window,
      outputTotalLength: total, outputPreviousItemId: item.outputPreviousItemId ?? previous ?? null };
  });
  return changed ? next : items;
}
