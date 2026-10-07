import type { DisplayItem } from './events';

/** Only the public summary is suitable for the conversation UI. */
export function publicReasoningSummary(item: DisplayItem): string {
  return (Array.isArray(item.summary) ? item.summary : [])
    .filter((part): part is string => typeof part === 'string' && !!part.trim())
    .join('\n\n');
}

export type ActivityBlock =
  | { kind: 'item'; id: string; item: DisplayItem }
  | { kind: 'batch'; id: string; items: DisplayItem[] };

const operationTypes = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageView',
  'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'hookPrompt',
  'functionCallOutput', 'sleep',
]);

/** Use the original order so an output/divider also ends an operation batch.
 * Empty reasoning is invisible and must not leave an artificial boundary. */
export function activityBlocks(items: DisplayItem[], activity: DisplayItem[]): ActivityBlock[] {
  const visible = new Set(activity.map(item => item.id));
  const blocks: ActivityBlock[] = [];
  let batch: Extract<ActivityBlock, { kind: 'batch' }> | undefined;
  for (const item of items) {
    if (item.type === 'reasoning' && !publicReasoningSummary(item)) continue;
    if (!visible.has(item.id)) { batch = undefined; continue; }
    if (!operationTypes.has(item.type)) {
      blocks.push({ kind: 'item', id: item.id, item });
      batch = undefined;
      continue;
    }
    if (!batch || batch.items[0].turnId !== item.turnId) {
      batch = { kind: 'batch', id: `activity:${item.id}`, items: [] };
      blocks.push(batch);
    }
    batch.items.push(item);
  }
  return blocks;
}

export function activityBatchSummary(items: DisplayItem[]) {
  const counts = new Map<string, number>();
  const add = (kind: string, count = 1) => counts.set(kind, (counts.get(kind) || 0) + count);
  let running = 0;
  let failed = 0;
  let interrupted = 0;
  for (const item of items) {
    if (item.status === 'failed' || item.status === 'declined' ||
        (item.exitCode != null && item.exitCode !== 0)) failed++;
    else if (['inProgress', 'running'].includes(item.status)) running++;
    else if (['interrupted', 'cancelled'].includes(item.status)) interrupted++;
    if (item.type === 'commandExecution') {
      const reads = (Array.isArray(item.commandActions) ? item.commandActions : [])
        .filter((action: any) => action.type === 'read');
      add(reads.length ? 'read' : 'command', reads.length || 1);
    } else if (item.type === 'fileChange') add('file', item.changes?.length || 1);
    else if (item.type === 'webSearch') add('search');
    else if (item.type === 'imageView') add('image');
    else if (item.type === 'imageGeneration') add('imageGeneration');
    else if (['collabAgentToolCall', 'subAgentActivity'].includes(item.type)) add('collaboration');
    else add('tool');
  }
  const labels: Record<string, (count: number) => string> = {
    read: count => `读取 ${count} 个文件`,
    command: count => `运行 ${count} 条命令`,
    file: count => `修改 ${count} 个文件`,
    search: count => `搜索 ${count} 次网页`,
    image: count => `查看 ${count} 张图片`,
    imageGeneration: count => `生成 ${count} 张图片`,
    collaboration: count => `协作 ${count} 次`,
    tool: count => `调用 ${count} 次工具`,
  };
  const status = [
    running && `${running} 项运行中`,
    failed && `${failed} 项失败`,
    interrupted && `${interrupted} 项已停止`,
  ].filter(Boolean).join(' · ');
  return {
    label: `${running ? '正在' : '已'}${[...counts].map(([kind, count]) => labels[kind](count)).join('、')}`,
    status,
    running,
    failed,
    interrupted,
  };
}
