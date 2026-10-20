import type { ReadingPosition } from './reading-positions';

export function nearConversationBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 140;
}

/** Stable blocks survive fresh history, disclosure changes and responsive widths. */
export function captureConversationReading(element: HTMLElement, bottom: boolean): ReadingPosition {
  const position: ReadingPosition = { top: Math.max(0, element.scrollTop), bottom };
  if (bottom) return position;
  const viewport = element.getBoundingClientRect();
  const blocks = element.querySelectorAll<HTMLElement>('[data-history-id]');
  let low = 0, high = blocks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (blocks[middle]!.getBoundingClientRect().bottom <= viewport.top + 1) low = middle + 1;
    else high = middle;
  }
  const candidate = blocks[low];
  const anchor = candidate && candidate.getBoundingClientRect().top < viewport.bottom - 1 ? candidate : undefined;
  const historyId = anchor?.dataset.historyId;
  if (anchor && historyId && historyId.length <= 512)
    position.anchor = { historyId, offset: anchor.getBoundingClientRect().top - viewport.top };
  return position;
}

export function restoreConversationReading(element: HTMLElement, position: ReadingPosition) {
  const anchor = position.anchor && [...element.querySelectorAll<HTMLElement>('[data-history-id]')]
    .find(block => block.dataset.historyId === position.anchor!.historyId);
  element.scrollTop = anchor
    ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.anchor!.offset
    : position.top;
}
