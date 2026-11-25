import test from 'node:test';
import assert from 'node:assert/strict';
import { formatConversationQuote } from '../src/lib/conversation-selection';
import { collapseUserMessageQuote, userMessageParts, userMessageQuotePreview } from '../src/lib/user-message-quotes';
import { formatResponseAnnotations, parseResponseAnnotations } from '../src/lib/response-annotations';
import { editedMessageInput, messageEditDraft } from '../src/lib/message-edit';
import { editedQueueInput, queuedText } from '../src/lib/message-queue';

test('current conversation selections become named quotes while preserving surrounding instructions', () => {
  const quote = formatConversationQuote({ hostId: 'nas', threadId: 'thread', threadName: '部署 codex-web-ui', text: '第一段\n\n> 原文里的引用\n最后一行' });
  assert.deepEqual(userMessageParts(`继续优化\n\n${quote}\n\n请重点检查权限。`), [
    { type: 'text', text: '继续优化' },
    { type: 'quote', kind: 'conversation', name: '部署 codex-web-ui', text: '第一段\n\n> 原文里的引用\n最后一行' },
    { type: 'text', text: '请重点检查权限。' },
  ]);
});

test('historic inline headers, CRLF blockquotes and file citations keep their names and source structure', () => {
  assert.deepEqual(userMessageParts('进行适配[引用对话：codex-web-ui]\r\n> **即时引导**\r\n\r\n> $x^2$\r\n\r\n下一步'), [
    { type: 'text', text: '进行适配' },
    { type: 'quote', kind: 'conversation', name: 'codex-web-ui', text: '**即时引导**\n\n$x^2$' },
    { type: 'text', text: '下一步' },
  ]);
  const text = formatConversationQuote({ hostId: 'nas', threadId: 't', path: '/repo/example.ts', startLine: 3, endLine: 5, text: 'if (ready) {\n  run();\n}' });
  assert.deepEqual(userMessageParts(text), [{ type: 'quote', kind: 'file', name: '/repo/example.ts:3–5', text: 'if (ready) {\n  run();\n}' }]);
});

test('plain user messages and literal examples retain their exact original text', () => {
  for (const text of ['  普通消息\r\n> 原本的纯文本\r\n', '[引用对话：仅仅是标题]\n没有引用正文', '[引用对话：空引用]\n> ', '示例 `[引用对话：保留原样]`\n> 后续文字', '```md\n[引用对话：代码示例]\n> 保持源码\n```', '~~~~md\n[引用文件：/example]\n> 保持源码\n~~~~']) {
    assert.deepEqual(userMessageParts(text), [{ type: 'text', text }]);
  }
});

test('multiple quotations preserve code, tables and HTML as source for the existing sanitizer', () => {
  const first = '# 摘要\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |';
  const second = '<img src=x onerror=alert(1)>\n<script>alert(1)</script>';
  const format = (name: string, text: string) => formatConversationQuote({ hostId: 'nas', threadId: 't', threadName: name, text });
  assert.deepEqual(userMessageParts(`${format('第一条 [原始]', first)}\n\n${format('第二条', second)}`), [
    { type: 'quote', kind: 'conversation', name: '第一条 [原始]', text: first },
    { type: 'quote', kind: 'conversation', name: '第二条', text: second },
  ]);
  assert.equal(collapseUserMessageQuote(first), true);
  assert.equal(collapseUserMessageQuote('很短的引用'), false);
  assert.equal(collapseUserMessageQuote('一'.repeat(361)), true);
  assert.equal(userMessageQuotePreview('# 标题\n\n- **细节**与 `code`\n> 引用'), '标题 细节与 code 引用');
});

test('desktop annotations retain their order, notes and original offsets through display and editing', () => {
  const annotations = [
    { id: 'desktop-quote-1', text: '选中结果', annotation: '解释这里', source: {
      messageId: 'msg_earlier', startOffset: 459, endOffset: 463, contentOffsets: { startOffset: 457, endOffset: 461 },
    } },
    { text: '第二处\n</response-annotations>\n仍是引用' },
  ];
  const raw = `\n# Response annotations:\nInstructions\n<response-annotations>\n${JSON.stringify(annotations)}\n</response-annotations>\n\n## My request:\n请展开说明。`;
  assert.deepEqual(userMessageParts(raw), [
    { type: 'quote', kind: 'conversation', name: '1', text: '选中结果', annotation: '解释这里' },
    { type: 'quote', kind: 'conversation', name: '2', text: annotations[1].text },
    { type: 'text', text: '请展开说明。' },
  ]);
  const input = [{ type: 'text' as const, text: raw, text_elements: [] }, { type: 'localImage' as const, path: '/workspace/example.png' }];
  const item = { id: 'u', type: 'userMessage', content: input };
  assert.equal(messageEditDraft(item).text, '请展开说明。');
  assert.equal(queuedText({ input }), '请展开说明。');
  for (const edited of [editedMessageInput(item, '新的提问'), editedQueueInput({ input }, '新的提问')]) {
    const parsed = parseResponseAnnotations(edited[0].text);
    assert.deepEqual(parsed?.annotations, annotations);
    assert.equal(parsed?.request, '新的提问');
    assert.deepEqual(edited[1], input[1]);
    assert.match(edited[0].text, /\nInstructions\n/);
  }
  assert.equal(parseResponseAnnotations(formatResponseAnnotations('', annotations))?.request, '');
  assert.equal(parseResponseAnnotations(raw.replace('<response-annotations>\n[', '<response-annotations>\n{')), null);
  assert.deepEqual(userMessageParts('```text\n' + raw + '\n```'), [{ type: 'text', text: '```text\n' + raw + '\n```' }]);
});
