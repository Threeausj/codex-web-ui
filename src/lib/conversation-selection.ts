/** A plain-text quotation from one message in the currently visible thread. */
export type ConversationSelectionSource = {
  hostId: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  threadName?: string;
  text: string;
};

export const MAX_CONVERSATION_SELECTION = 16_000;
const ignoredSelectionElements = 'button,input,textarea,select,[contenteditable="true"],[data-selection-ignore]';

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
    ? value : undefined;
}

/** Never accept markup or unbounded clipboard data as a selection payload. */
export function normalizeConversationSelection(value: unknown): ConversationSelectionSource | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<ConversationSelectionSource>;
  const hostId = identifier(input.hostId);
  const threadId = identifier(input.threadId);
  if (!hostId || !threadId || typeof input.text !== 'string' || input.text.length > MAX_CONVERSATION_SELECTION) return null;
  const text = input.text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (!text) return null;
  const result: ConversationSelectionSource = { hostId, threadId, text };
  const turnId = identifier(input.turnId);
  const itemId = identifier(input.itemId);
  if (turnId) result.turnId = turnId;
  if (itemId) result.itemId = itemId;
  if (typeof input.threadName === 'string' && input.threadName.trim()) result.threadName = input.threadName.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160);
  return result;
}

/** Mark only rendered message bodies with data-selection-item-id. */
export function captureConversationSelection(
  container: HTMLElement,
  selection: Selection | null,
  context: { hostId: string; threadId?: string; threadName?: string },
): ConversationSelectionSource | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !context.threadId) return null;
  const range = selection.getRangeAt(0);
  const start = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
  const end = range.endContainer.nodeType === 1 ? range.endContainer as Element : range.endContainer.parentElement;
  if (!start || !end || !container.contains(start) || !container.contains(end)) return null;
  if (start.closest(ignoredSelectionElements) || end.closest(ignoredSelectionElements)) return null;
  const body = start.closest<HTMLElement>('[data-selection-item-id]');
  if (!body || end.closest('[data-selection-item-id]') !== body) return null;
  for (const ignored of body.querySelectorAll(ignoredSelectionElements)) {
    if (range.intersectsNode(ignored)) return null;
  }
  return normalizeConversationSelection({
    ...context,
    itemId: body.dataset.selectionItemId,
    turnId: body.dataset.selectionTurnId || body.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId,
    text: selection.toString(),
  });
}

/** Composer quotations remain plain text; each line is explicitly quoted. */
export function formatConversationQuote(source: ConversationSelectionSource): string {
  const normalized = normalizeConversationSelection(source);
  if (!normalized) return '';
  return `[引用对话：${normalized.threadName || normalized.threadId}]\n` + normalized.text.split('\n').map(line => `> ${line}`).join('\n');
}

export function conversationSelectionKey(source: ConversationSelectionSource | null | undefined): string {
  return source ? JSON.stringify([source.hostId, source.threadId, source.turnId || '', source.itemId || '', source.text]) : '';
}
