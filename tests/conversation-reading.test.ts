import test from 'node:test';
import assert from 'node:assert/strict';
import { captureConversationReading, nearConversationBottom, restoreConversationReading } from '../src/lib/conversation-reading';
import { isReadingPosition } from '../src/lib/reading-positions';

function transcript(count = 20) {
  let reads = 0;
  const container = {
    scrollTop: 850, clientHeight: 300, scrollHeight: count * 100,
    getBoundingClientRect: () => ({ top: 50, bottom: 350 }),
    querySelectorAll: () => blocks,
  };
  const blocks = Array.from({ length: count }, (_, index) => ({
    dataset: { historyId: `block-${index}` }, top: index * 100,
    getBoundingClientRect() { reads++; return { top: this.top - container.scrollTop + 50, bottom: this.top - container.scrollTop + 150 }; },
  }));
  return { element: container as unknown as HTMLElement, blocks, reads: () => reads };
}

test('historical anchors retain the visible block and its relative offset across earlier layout changes', () => {
  const { element, blocks } = transcript();
  const position = captureConversationReading(element, false);
  assert.deepEqual(position, { top: 850, bottom: false, anchor: { historyId: 'block-8', offset: -50 } });
  for (const block of blocks) if (block.top >= 800) block.top += 300;
  restoreConversationReading(element, position);
  assert.equal(element.scrollTop, 1150);
  assert.deepEqual(captureConversationReading(element, false).anchor, position.anchor);
});

test('latest positions do not anchor to old text and missing historical blocks fall back to legacy pixel positions', () => {
  const { element } = transcript();
  assert.deepEqual(captureConversationReading(element, true), { top: 850, bottom: true });
  restoreConversationReading(element, { top: 275, bottom: false, anchor: { historyId: 'missing', offset: 10 } });
  assert.equal(element.scrollTop, 275);
  assert.equal(nearConversationBottom(element), false);
  element.scrollTop = element.scrollHeight - element.clientHeight;
  assert.equal(nearConversationBottom(element), true);
});

test('finding an anchor in large history needs logarithmic geometry reads', () => {
  const { element, reads } = transcript(10000);
  element.scrollTop = 800_000;
  assert.equal(captureConversationReading(element, false).anchor?.historyId, 'block-8000');
  assert.ok(reads() <= 17);
});

test('legacy reading positions remain compatible while malformed anchors are rejected', () => {
  assert.equal(isReadingPosition({ top: 100, bottom: false }), true);
  assert.equal(isReadingPosition({ top: 100, bottom: false, anchor: { historyId: 'turn-id', offset: -80 } }), true);
  for (const position of [null, { top: -1, bottom: false }, { top: 100, bottom: 'false' },
    { top: 100, bottom: false, anchor: { historyId: 'id', offset: Infinity } },
    { top: 100, bottom: false, anchor: { historyId: 'x'.repeat(513), offset: 0 } }]) assert.equal(isReadingPosition(position), false);
});
