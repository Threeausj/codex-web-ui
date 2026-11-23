import type { Page } from '@playwright/test';
import { expect, login, test } from './fixtures';

const graph = [
  'flowchart TD',
  '  T["用户提交的源文档和关键词"] --> B["文本匹配分数"]',
  '  T --> E["文本检索产生候选结果"]',
  '  I["用户提供的三张参考图片"] --> X["提取图片中的候选区域"]',
  '  E --> R["比较文本和图像结果"]',
  '  X --> R',
  '  R --> M["重新排序候选结果"]',
  '  B --> M',
  '  I --> S["独立提取整体图像特征"]',
  '  S --> A["生成图像描述和摘要"]',
  '  M --> Q["整理相关内容"]',
  '  A --> Q',
  '  T --> Q',
  '  Q --> O["输出完整检索报告"]',
].join('\n');
const fence = (source: string) => ['```mermaid', source, '```'].join('\n');

async function openThread(page: Page) {
  await login(page);
  if (page.viewportSize()!.width <= 760)
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
}

for (const width of [1440, 390]) {
  test('renders a branched Mermaid flowchart and keeps the turn controls close at ' + width + 'px', async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 920 });
    const history = mock.turns.get('thread-existing')![0];
    history.durationMs = 99_000;
    history.items[1].text = '流程说明。\n\n' + fence(graph) + '\n\n流程结束。';
    await openThread(page);
    const turn = page.locator('.conversation-turn[data-turn-id="turn-history"]');
    const answer = turn.locator('.agent-message');
    const preview = answer.getByRole('region', { name: 'Mermaid 流程图' });
    await preview.scrollIntoViewIfNeeded();
    const frame = preview.locator('iframe');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    const diagram = frame.contentFrame().locator('#diagram svg');
    await expect(diagram.locator('.node')).toHaveCount(11);
    await expect(diagram.locator('.flowchart-link')).toHaveCount(13);
    await expect(diagram).toContainText('输出完整检索报告');
    await expect(answer.locator('pre')).toHaveCount(0);
    await expect(answer).toContainText('流程结束。');
    await expect.poll(() => frame.evaluate(element => element.clientHeight)).toBeGreaterThan(120);
    expect(await frame.evaluate((element: HTMLIFrameElement) => element.contentDocument)).toBeNull();
    if (width < 760) {
      expect(await preview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await answer.getByRole('button', { name: '放大流程图', exact: true }).click();
      const scroll = await preview.evaluate(element => {
        element.scrollLeft = element.scrollWidth;
        return { x: element.scrollLeft, fits: document.documentElement.scrollWidth <= innerWidth };
      });
      expect(scroll.x).toBeGreaterThan(0);
      expect(scroll.fits).toBe(true);
      await answer.getByRole('button', { name: '适应宽度', exact: true }).click();
      expect(await preview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    const summary = turn.locator('.turn-activity > summary');
    const actions = turn.locator('.user-message .message-actions');
    const bubble = turn.locator('.user-bubble');
    await bubble.scrollIntoViewIfNeeded();
    const bubbleBox = (await bubble.boundingBox())!;
    const summaryBox = (await summary.boundingBox())!;
    if (width > 760) {
      expect(summaryBox.y - bubbleBox.y - bubbleBox.height).toBeLessThanOrEqual(12);
      await bubble.hover();
      await expect(actions).toHaveCSS('opacity', '1');
      const actionBox = (await actions.boundingBox())!;
      expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(summaryBox.y + summaryBox.height);
    } else {
      await expect(actions).toHaveCSS('opacity', '1');
      const actionBox = (await actions.boundingBox())!;
      expect(summaryBox.y - actionBox.y - actionBox.height).toBeLessThanOrEqual(12);
    }
    await summary.click();
    await expect(turn.locator('.turn-activity')).toHaveAttribute('open', '');
  });
}

test('preserves ordinary code and falls back to readable source for an invalid Mermaid block', async ({ page, mock }) => {
  mock.turns.get('thread-existing')![0].items[1].text =
    ['```text', 'flowchart TD', '```', '', fence('flowchart TD\n  A -->')].join('\n');
  await openThread(page);
  const answer = page.locator('[data-selection-item-id="history-agent"]');
  await expect(answer.locator('code.language-text')).toHaveText('flowchart TD');
  await expect(answer.getByRole('status')).toHaveText('流程图无法渲染，已保留源码。');
  await expect(answer.locator('.mermaid-diagram code')).toContainText('A -->');
  await expect(answer.locator('iframe')).toHaveCount(0);
});

test('renders a streamed flowchart once its fence closes', async ({ page, mock }) => {
  await openThread(page);
  const item = { id: 'streamed-mermaid', type: 'agentMessage', phase: 'final_answer', text: '```mermaid\nflowchart TD\n  A --> B' };
  const turn = { id: 'streamed-mermaid-turn', status: 'inProgress', items: [item] };
  mock.turns.get('thread-existing')!.push(turn);
  mock.emit('turn/started', { threadId: 'thread-existing', turn });
  const answer = page.locator('[data-selection-item-id="streamed-mermaid"]');
  await expect(answer.locator('code.language-mermaid')).toBeVisible();
  await expect(answer.locator('iframe')).toHaveCount(0);
  mock.emit('item/agentMessage/delta', { threadId: 'thread-existing', turnId: turn.id, itemId: item.id, delta: '\n```' });
  const diagram = answer.frameLocator('iframe').locator('#diagram svg');
  await expect(diagram.locator('.flowchart-link')).toHaveCount(1);
  await expect(answer.locator('pre')).toHaveCount(0);
});
