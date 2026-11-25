import { test, expect, login, type MockCodex } from './fixtures';

function installOperations(mock: MockCodex, status = 'completed') {
  const turn = mock.turns.get('thread-existing')![0];
  const reads = ['memory', 'meminfo'].map((name, index) => ({
    id: `read-${index}`, type: 'commandExecution', command: `cat /proc/${name}`,
    commandActions: [{ type: 'read', name, path: `/proc/${name}` }],
    status, exitCode: status === 'completed' ? 0 : null, aggregatedOutput: `read output ${index}`,
  }));
  const commands = Array.from({ length: 6 }, (_, index) => ({
    id: `command-${index}`, type: 'commandExecution', command: `printf batch-${index}`,
    status: 'completed', exitCode: index === 5 ? 1 : 0, aggregatedOutput: `command output ${index}`,
  }));
  turn.items.splice(1, 0, reads[0], { id: 'private-thought', type: 'reasoning', summary: [' ', ''], content: ['private-only-text'] }, reads[1], ...commands);
  turn.items.at(-1).phase = 'final_answer';
  return turn;
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`${viewport.name}: an operation batch takes one row and opens compact individual rows once`, async ({ page, mock }) => {
    await page.setViewportSize(viewport);
    installOperations(mock);
    await login(page);
    if (viewport.name === 'phone') await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    await page.locator('[data-section="recent"] .thread-row').first().click();
    const turn = page.locator('.conversation-turn[data-turn-id="turn-history"]');
    await turn.locator('.turn-activity > summary').click();
    const batch = turn.locator('.activity-batch');
    await expect(batch).toHaveCount(1);
    await expect(batch).not.toHaveAttribute('open', '');
    await expect(batch.locator(':scope > summary')).toContainText('已读取 2 个文件、运行 6 条命令');
    await expect(batch.locator(':scope > summary')).toContainText('1 项失败');
    await expect(turn.locator('.reasoning-item')).toHaveCount(0);
    await expect(page.getByText('private-only-text', { exact: true })).toHaveCount(0);
    await expect(page.getByText('此模型未提供公开的思考摘要。', { exact: true })).toHaveCount(0);
    await expect(batch.locator('.tool-item > summary').first()).toBeHidden();
    const closedHeight = await batch.evaluate(element => element.getBoundingClientRect().height);
    expect(closedHeight).toBeLessThanOrEqual(viewport.name === 'phone' ? 68 : 40);
    await batch.locator(':scope > summary').click();
    await expect(batch.locator('.tool-item')).toHaveCount(8);
    await expect(batch.locator('.tool-item[open]')).toHaveCount(0);
    await expect(batch.locator('.tool-item > summary').first()).toBeVisible();
    await batch.locator('.tool-item').first().locator(':scope > summary').click();
    await expect(batch.getByText('read output 0', { exact: true })).toBeVisible();
    await expect(batch.getByText('read output 1', { exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('live batches open automatically, respect temporary manual collapse and split only when a public summary arrives', async ({ page, mock }) => {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const turnId = 'live-batch';
  const turn = { id: turnId, status: 'inProgress', items: [], durationMs: null, error: null };
  mock.turns.get('thread-existing')!.push(turn);
  mock.emit('turn/started', { threadId: 'thread-existing', turn });
  const emitItem = (item: any, method = 'item/started') => mock.emit(method, { threadId: 'thread-existing', turnId, item });
  const first = { id: 'live-read', type: 'commandExecution', command: 'cat /tmp/a', commandActions: [{ type: 'read', name: 'a', path: '/tmp/a' }], status: 'inProgress', aggregatedOutput: 'first output' };
  emitItem(first);
  emitItem({ id: 'live-private', type: 'reasoning', summary: [], content: ['hidden private details'] });
  emitItem({ id: 'live-command', type: 'commandExecution', command: 'pwd', status: 'completed', exitCode: 0 });
  const group = page.locator(`.conversation-turn[data-turn-id="${turnId}"]`);
  const batches = group.locator('.activity-batch');
  await expect(batches).toHaveCount(1);
  await expect(batches.first()).toHaveAttribute('open', '');
  await expect(batches.first().locator(':scope > summary')).toContainText('1 项运行中');
  await batches.first().locator(':scope > summary').click();
  await expect(batches.first()).not.toHaveAttribute('open', '');
  mock.emit('item/commandExecution/outputDelta', { threadId: 'thread-existing', turnId, itemId: 'live-read', delta: ' + delta' });
  await expect(batches.first()).not.toHaveAttribute('open', '');
  await batches.first().locator(':scope > summary').click();
  await batches.first().locator('.tool-item').first().locator(':scope > summary').click();
  await expect(group.getByText('first output + delta', { exact: true })).toBeVisible();
  emitItem({ id: 'live-patch', type: 'fileChange', status: 'inProgress', changes: [{ path: '/tmp/a', kind: 'update', diff: '+new' }] });
  await expect(batches.first()).toHaveAttribute('open', '');
  await expect(batches.first().locator(':scope > summary')).toContainText('修改 1 个文件');
  await expect(batches.first().locator('.tool-item[open]')).toHaveCount(1);
  mock.emit('item/reasoning/textDelta', { threadId: 'thread-existing', turnId, itemId: 'live-private', contentIndex: 0, delta: ' more hidden' });
  await expect(group.locator('.reasoning-item')).toHaveCount(0);
  mock.emit('item/reasoning/summaryTextDelta', { threadId: 'thread-existing', turnId, itemId: 'live-private', summaryIndex: 0, delta: '公开的简短摘要' });
  await expect(group.locator('.reasoning-content')).toHaveText('公开的简短摘要');
  await expect(group.locator('.reasoning-content')).toBeVisible();
  await expect(batches).toHaveCount(2);
  await expect(batches.first()).toHaveAttribute('open', '');
  await expect(batches.nth(1)).toHaveAttribute('open', '');
  const order = await group.locator('.turn-activity-content').evaluate(element => [...element.children].map(child => child.className));
  expect(order).toEqual(['activity-batch', 'reasoning-item', 'activity-batch']);
  emitItem({ ...first, status: 'completed', exitCode: 1 }, 'item/completed');
  await expect(batches.first().locator(':scope > summary')).toContainText('1 项失败');
  await expect(batches.first().locator('.tool-item').first()).toHaveAttribute('open', '');
});

for (const scenario of [
  { width: 1440, virtual: false },
  { width: 390, virtual: false },
  { width: 1440, virtual: true },
]) {
  const history = scenario.virtual ? 'virtual' : 'regular';
  test(scenario.width + 'px ' + history + ' history keeps expanded activity close together', async ({ page, mock }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    const turns = mock.turns.get('thread-existing')!;
    mock.threads[0]!.status = { type: 'active' };
    if (scenario.virtual) {
      turns.push(...Array.from({ length: 32 }, (_, index) => ({
        id: 'previous-' + index, status: 'completed', durationMs: 1200, items: [
          { id: 'previous-user-' + index, type: 'userMessage', content: [{ type: 'text', text: 'Earlier prompt' }] },
          { id: 'previous-answer-' + index, type: 'agentMessage', text: 'Earlier result' },
        ],
      })));
    }
    turns.push({ id: 'dense-activity', status: 'inProgress', items: [
      { id: 'dense-agent', type: 'subAgentActivity', status: 'completed' },
      { id: 'dense-summary', type: 'reasoning', summary: ['\n\nChecking incremental progress\n\n'], content: ['private reason'] },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: 'dense-command-' + index, type: 'commandExecution', command: 'printf fixture', status: 'completed', exitCode: 0,
      })),
    ] });
    await login(page);
    if (scenario.width < 760) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    await page.locator('[data-section="recent"] .thread-row').first().click();
    await expect(page.locator('[data-virtual-timeline]')).toHaveCount(scenario.virtual ? 1 : 0);
    const collaboration = page.getByText('已协作 1 次', { exact: true });
    const agent = page.getByText('代理动态', { exact: true });
    const reasoning = page.locator('.reasoning-item > summary');
    const content = page.locator('.reasoning-content');
    const commands = page.getByText('已运行 3 条命令', { exact: true });
    await expect(content).toBeVisible();
    await expect(commands).toBeVisible();
    const spacing = await page.evaluate(() => {
      const locate = (selector: string, text: string) =>
        [...document.querySelectorAll(selector)].find(element => element.textContent?.trim() === text)!.getBoundingClientRect();
      const group = locate('summary, .virtual-batch-toggle', '已协作 1 次');
      const nested = locate('.tool-item > summary', '代理动态');
      const summary = document.querySelector('.reasoning-item > summary')!.getBoundingClientRect();
      const body = document.querySelector('.reasoning-content')!;
      const bodyBox = body.getBoundingClientRect();
      const next = locate('summary, .virtual-batch-toggle', '已运行 3 条命令');
      const { paddingTop, paddingBottom, lineHeight } = getComputedStyle(body);
      return {
        rowHeight: group.height,
        nestedGap: nested.top - group.bottom,
        summaryGap: bodyBox.top + parseFloat(paddingTop) - summary.bottom,
        nextGap: next.top - bodyBox.bottom + parseFloat(paddingBottom),
        lines: (bodyBox.height - parseFloat(paddingTop) - parseFloat(paddingBottom)) / parseFloat(lineHeight),
      };
    });
    expect(spacing.rowHeight).toBe(scenario.width > 760 ? 28 : 40);
    expect(spacing.nestedGap).toBeGreaterThanOrEqual(-1);
    expect(spacing.nestedGap).toBeLessThanOrEqual(4);
    expect(spacing.summaryGap).toBeLessThanOrEqual(3);
    expect(spacing.nextGap).toBeLessThanOrEqual(6);
    expect(spacing.lines).toBeCloseTo(1, 0);
    await expect(page.getByText('private reason', { exact: true })).toHaveCount(0);
    await collaboration.click();
    await expect(agent).toBeHidden();
    await reasoning.click();
    await expect(content).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('assistant commentary, plans, compaction and separate turns retain independent operation batches', async ({ page, mock }) => {
  const turn = mock.turns.get('thread-existing')![0];
  turn.items.splice(1, 0,
    { id: 'first-command', type: 'commandExecution', command: 'first', status: 'completed' },
    { id: 'boundary-commentary', type: 'agentMessage', phase: 'commentary', text: '中间进展' },
    { id: 'second-command', type: 'commandExecution', command: 'second', status: 'completed' },
    { id: 'boundary-plan', type: 'plan', text: '下一步计划' },
    { id: 'third-command', type: 'commandExecution', command: 'third', status: 'completed' },
    { id: 'boundary-compact', type: 'contextCompaction', status: 'completed' },
    { id: 'fourth-command', type: 'commandExecution', command: 'fourth', status: 'completed' },
  );
  turn.items.at(-1).phase = 'final_answer';
  mock.turns.get('thread-existing')!.push({ id: 'next-batch-turn', status: 'completed', durationMs: 1000, items: [{ id: 'next-command', type: 'commandExecution', command: 'next', status: 'completed' }] });
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const group = page.locator('.conversation-turn[data-turn-id="turn-history"]');
  await group.locator('.turn-activity > summary').click();
  await expect(group.locator('.activity-batch')).toHaveCount(4);
  const order = await group.locator('.turn-activity-content').evaluate(element => [...element.children].map(child => child.classList.contains('activity-batch') ? 'operations' : child.classList.contains('compaction-divider') ? 'compaction' : child.classList.contains('plan-card') ? 'plan' : child.querySelector('[data-selection-item-id]')?.getAttribute('data-selection-item-id')));
  expect(order).toEqual(['operations', 'boundary-commentary', 'operations', 'plan', 'operations', 'compaction', 'operations', 'history-agent']);
  await expect(group.locator('.compaction-divider')).toBeVisible();
  const next = page.locator('.conversation-turn[data-turn-id="next-batch-turn"]');
  await next.locator('.turn-activity > summary').click();
  await expect(next.locator('.activity-batch')).toHaveCount(1);
  await expect(next.locator('.activity-batch')).not.toHaveAttribute('open', '');
});
