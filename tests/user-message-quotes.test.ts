import test from 'node:test';
import assert from 'node:assert/strict';
import { formatConversationQuote } from '../src/lib/conversation-selection';
import { collapseUserMessageQuote, userMessageParts, userMessageQuotePreview } from '../src/lib/user-message-quotes';

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
