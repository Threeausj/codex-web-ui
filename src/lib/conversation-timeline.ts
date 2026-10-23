import type { ConversationBlock } from './presentation';
import { elapsedLabel, turnPresentation } from './presentation';
import { activityBatchSummary, type ActivityBlock } from './activity-presentation';
import type { DisplayItem } from './events';

export type PresentedBlock = ConversationBlock & Partial<ReturnType<typeof turnPresentation>>;
export type ConversationTimelineRow = {
  id: string; kind: 'item' | 'turn' | 'batch' | 'load' | 'error' | 'note' | 'empty';
  turnId?: string; item?: DisplayItem; items?: DisplayItem[]; label?: string; text?: string;
  running?: boolean; expanded?: boolean; activity?: boolean; output?: boolean; nested?: boolean;
  failed?: number; status?: string; hasMore?: boolean; loading?: boolean; error?: string;
};

/** Flat rows are essential: a single running Turn can contain thousands of tools. */
export function conversationTimelineRows(blocks: PresentedBlock[], options: {
  runningTurnId: string | null; expanded: ReadonlySet<string>; batchExpanded: (entry: Extract<ActivityBlock, { kind: 'batch' }>, running: boolean) => boolean;
  detailState: (turnId: string) => { loading: boolean; error: string } | undefined;
}) {
  const rows: ConversationTimelineRow[] = [];
  const message = (item: DisplayItem, turnId?: string, fields: Partial<ConversationTimelineRow> = {}) =>
    rows.push({ id: `item:${item.id}`, kind: 'item', turnId, item, ...fields });
  for (const block of blocks) {
    if (block.kind === 'message') { message(block.item); continue; }
    const running = block.id === options.runningTurnId;
    const expanded = options.expanded.has(block.id);
    const view = block.segments ? block as PresentedBlock & ReturnType<typeof turnPresentation> : { ...block, ...turnPresentation(block.items) };
    const state = options.detailState(block.id);
    if (block.turn?.historyBookmarkTarget) rows.push({ id: `fragment:${block.id}`, kind: 'note', turnId: block.id, text: '收藏所在历史片段' });
    for (const [segmentIndex, segment] of view.segments.entries()) {
      for (const item of segment.users) message(item, block.id, { running });
      const hasActivity = segmentIndex === 0 ? view.activity.length || block.turn?.historySummary || running || block.turn?.durationMs != null || block.turn?.completedAt != null || ['failed', 'interrupted'].includes(block.turn?.status) : segment.activity.length || segment.dividers.length && expanded;
      if (hasActivity) {
        if (segmentIndex === 0) rows.push({ id: `turn:${block.id}`, kind: 'turn', turnId: block.id, running, expanded,
          label: running ? '正在处理…' : `${block.turn?.status === 'failed' ? '执行失败 · ' : block.turn?.status === 'interrupted' ? '已停止 · ' : ''}${elapsedLabel(block.turn)}` });
        if (expanded) {
          if (segmentIndex === 0 && (state?.loading || state?.error)) rows.push({ id: `load-state:${block.id}`, kind: 'load', turnId: block.id, loading: state.loading, error: state.error });
          for (const entry of segment.dividers.length ? segment.timelineBlocks : segment.activityBlocks) {
            if (entry.kind === 'item') message(entry.item, block.id, { running, activity: true, output: segment.outputs.some(item => item.id === entry.id) });
            else {
              const summary = activityBatchSummary(entry.items), open = options.batchExpanded(entry, running);
              rows.push({ id: entry.id, kind: 'batch', turnId: block.id, items: entry.items, expanded: open, running,
                label: summary.label, status: summary.status, failed: summary.failed, activity: true });
              if (open) for (const item of entry.items) message(item, block.id, { running, activity: true, nested: true });
            }
          }
          if (segmentIndex === 0 && block.turn?.historySummary && !state?.loading && !state?.error)
            rows.push({ id: `load-more:${block.id}`, kind: 'load', turnId: block.id, hasMore: true,
              label: block.turn.historyItemsStarted ? '加载更多过程记录' : '加载过程记录' });
          if (segmentIndex === 0 && !view.activity.length && !block.turn?.historySummary && !state?.loading)
            rows.push({ id: `empty:${block.id}`, kind: 'empty', turnId: block.id, text: running ? '正在等待新的进展。' : '此轮没有额外的过程记录。' });
        }
      }
      if (!(segment.dividers.length && expanded)) for (const item of segment.outputs) message(item, block.id, { running, output: true });
    }
    if (block.turn?.error?.message) rows.push({ id: `error:${block.id}`, kind: 'error', turnId: block.id, text: block.turn.error.message });
  }
  return rows;
}

export function estimateConversationRow(row: ConversationTimelineRow | undefined) {
  if (!row || row.kind !== 'item') return row?.kind === 'turn' ? 56 : 44;
  const item = row.item!;
  if (!['userMessage', 'agentMessage', 'plan', 'reasoning'].includes(item.type)) return 45;
  const text = item.text || (item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
  const lines = typeof text === 'string' ? Math.max(text.split('\n').length, text.length / 85) : 1;
  const images = (item.content || []).filter((part: any) => ['localImage', 'image'].includes(part.type)).length;
  return Math.min(1500, Math.max(72, lines * 23 + 48 + images * 240));
}
