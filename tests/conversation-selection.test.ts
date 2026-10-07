import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationSelectionKey, formatConversationQuote, MAX_CONVERSATION_SELECTION, normalizeConversationSelection } from '../src/lib/conversation-selection';

test('conversation quotations are bounded plain text with valid scoped identifiers', () => {
  const source = normalizeConversationSelection({ hostId: 'nas', threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', threadName: ' 修复 Git ', text: '  第一行\r\n第二行\u0000\n  ' });
  assert.deepEqual(source, { hostId: 'nas', threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', threadName: '修复 Git', text: '第一行\n第二行' });
  assert.equal(formatConversationQuote(source!), '[引用对话：修复 Git]\n> 第一行\n> 第二行');
  const markup = normalizeConversationSelection({ hostId: 'nas', threadId: 'thread-1', text: '<img src=x onerror=alert(1)>\n# quoted' });
  assert.equal(formatConversationQuote(markup!), '[引用对话：thread-1]\n> <img src=x onerror=alert(1)>\n> # quoted');
});

test('missing scope, empty or oversized selections cannot enter a conversation', () => {
  for (const input of [null, {}, { hostId: 'nas', text: 'hello' }, { hostId: 'nas\n', threadId: 'one', text: 'hello' }, { hostId: 'nas', threadId: 'one', text: ' \n ' }, { hostId: 'nas', threadId: 'one', text: 'x'.repeat(MAX_CONVERSATION_SELECTION + 1) }, { hostId: 'nas', threadId: 'one', text: ['hello'] }]) assert.equal(normalizeConversationSelection(input), null);
  assert.equal(normalizeConversationSelection({ hostId: 'nas', threadId: 'one', text: 'x'.repeat(MAX_CONVERSATION_SELECTION) })?.text.length, MAX_CONVERSATION_SELECTION);
  assert.equal(formatConversationQuote({ hostId: '', threadId: 'one', text: 'hello' }), '');
});

test('quote scopes include the complete text and cannot collide through delimiters', () => {
  const source = { hostId: 'nas', threadId: 'one', itemId: 'two', text: 'quoted' };
  assert.notEqual(conversationSelectionKey(source), conversationSelectionKey({ ...source, hostId: 'other' }));
  assert.notEqual(conversationSelectionKey(source), conversationSelectionKey({ ...source, text: 'another' }));
  assert.notEqual(conversationSelectionKey({ ...source, threadId: 'one|two', itemId: 'three' }), conversationSelectionKey({ ...source, threadId: 'one', itemId: 'two|three' }));
  assert.equal(conversationSelectionKey(null), '');
});
