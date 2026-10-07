import { test, expect } from './fixtures';

test('selection capture accepts rendered message text and preserves its scoped source', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { captureConversationSelection } = await import('/src/lib/conversation-selection.ts');
    const container = document.createElement('div');
    container.innerHTML = '<section data-turn-id="turn-original"><div data-selection-item-id="answer-original">NAS Git <strong>不再依赖 bwrap</strong>；完全访问权限正确应用。</div></section>';
    document.body.append(container);
    const body = container.querySelector('[data-selection-item-id]')!;
    const range = document.createRange();
    range.setStart(body.firstChild!, 0);
    range.setEnd(body.lastChild!, body.lastChild!.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    const result = captureConversationSelection(container, selection, { hostId: 'nas', threadId: 'parent', threadName: '部署项目' });
    selection.removeAllRanges(); container.remove();
    return result;
  });
  expect(result).toEqual({ hostId: 'nas', threadId: 'parent', threadName: '部署项目', itemId: 'answer-original', turnId: 'turn-original', text: 'NAS Git 不再依赖 bwrap；完全访问权限正确应用。' });
});

test('cross-message selections, controls and content outside the transcript cannot become quotations', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { captureConversationSelection } = await import('/src/lib/conversation-selection.ts');
    const container = document.createElement('div');
    container.innerHTML = '<div data-selection-item-id="one"><span>正文一</span><button>复制消息</button><span>结尾</span></div><div data-selection-item-id="two">正文二</div><textarea>输入内容</textarea><pre>工具原始输出</pre>';
    document.body.append(container);
    const first = container.querySelector('[data-selection-item-id="one"]')!;
    const second = container.querySelector('[data-selection-item-id="two"]')!;
    const select = (range: Range) => {
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      return captureConversationSelection(container, selection, { hostId: 'nas', threadId: 'parent' });
    };
    const cross = document.createRange(); cross.setStart(first.firstChild!.firstChild!, 0); cross.setEnd(second.firstChild!, 3);
    const mixed = document.createRange(); mixed.selectNodeContents(first);
    const control = document.createRange(); control.selectNodeContents(first.querySelector('button')!);
    const raw = document.createRange(); raw.selectNodeContents(container.querySelector('pre')!);
    const results = [select(cross), select(mixed), select(control), select(raw)];
    window.getSelection()!.removeAllRanges(); container.remove();
    return results;
  });
  expect(result).toEqual([null, null, null, null]);
});

test('selection payloads contain text rather than executable markup and reject oversized message ranges', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { captureConversationSelection, MAX_CONVERSATION_SELECTION } = await import('/src/lib/conversation-selection.ts');
    const container = document.createElement('div');
    const body = document.createElement('div'); body.dataset.selectionItemId = 'literal';
    body.textContent = '<script>alert("not markup")</script>'; container.append(body); document.body.append(container);
    const select = () => {
      const range = document.createRange(); range.selectNodeContents(body);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      return captureConversationSelection(container, selection, { hostId: 'nas', threadId: 'parent' });
    };
    const plain = select(); body.textContent = 'x'.repeat(MAX_CONVERSATION_SELECTION + 1); const oversized = select();
    window.getSelection()!.removeAllRanges(); container.remove();
    return { plain, oversized };
  });
  expect(result.plain?.text).toBe('<script>alert("not markup")</script>');
  expect(result.oversized).toBeNull();
});
