import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const threadId = 'thread-existing';
const viewport = (page: Page) => page.locator('.conversation-scroll');
const gap = (page: Page) => viewport(page).evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
function wireItems(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/items/list') return receive(socket, request);
    mock.requests.push(request);
    const p = request.params, turn = mock.turns.get(p.threadId)?.find((entry: any) => entry.id === p.turnId);
    const items = turn?.items || [];
    const start = p.cursor && typeof p.cursor === 'object' ? items.findIndex((item: any) => item.id === p.cursor.itemId) + 1 : Number(String(p.cursor || '0').replace('items:', ''));
    const page = items.slice(start, start + p.limit);
    return socket.send(JSON.stringify({ id: request.id, result: { data: page.map((item: any) => ({ turnId: p.turnId, item })), nextCursor: start + page.length < items.length ? `items:${start + page.length}` : null } }));
  };
}
function running(mock: MockCodex, count = 2000) {
  mock.threads[0].status = { type: 'active' };
  const turn = { id: 'large-active', status: 'inProgress', itemsView: 'full', items: [
    { id: 'active-user', type: 'userMessage', content: [{ type: 'text', text: '大型活动轮次的初始消息' }] },
    ...Array.from({ length: count }, (_, i) => ({ id: `active-command-${i}`, type: 'commandExecution', command: `echo command-${i}`, status: 'completed', exitCode: 0, aggregatedOutput: `result-${i}\n` + 'output line\n'.repeat(10) })),
    { id: 'active-answer', type: 'agentMessage', phase: 'commentary', text: '实时进展的末尾' },
  ] };
  mock.turns.set(threadId, [turn]); wireItems(mock); return turn;
}
async function enter(page: Page) {
  await login(page);
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator('[data-virtual-timeline]')).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
}
async function anchor(page: Page) {
  return viewport(page).evaluate(element => {
    const box = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>('[data-timeline-row]')].find(row => row.getBoundingClientRect().top >= box.top && row.getBoundingClientRect().bottom <= box.bottom);
    return { id: row!.dataset.timelineRow!, offset: row!.getBoundingClientRect().top - box.top };
  });
}
async function offset(page: Page, id: string) {
  return viewport(page).evaluate((element, id) => element.querySelector<HTMLElement>(`[data-timeline-row="${id}"]`)!.getBoundingClientRect().top - element.getBoundingClientRect().top, id);
}
async function select(page: Page, label: string) {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: label }).first().click();
  await expect(page.locator('.main-header h1')).toHaveText(label);
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
}

test('2000 tools in one running turn mount a bounded single layer and remain navigable from the first input to latest output', async ({ page, mock }) => {
  running(mock);
  await enter(page);
  await expect(page.locator('[data-virtual-timeline]')).toHaveAttribute('data-row-count', '2004');
  const mounted = await page.locator('[data-timeline-row]').count();
  expect(mounted).toBeLessThan(65);
  await expect(page.getByText('实时进展的末尾', { exact: true })).toBeVisible();
  await viewport(page).evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByText('大型活动轮次的初始消息', { exact: true })).toBeVisible();
  expect(await page.locator('[data-timeline-row]').count()).toBeLessThan(65);
  await page.getByRole('button', { name: '跳到最新消息', exact: true }).click();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
  await page.screenshot({ path: '.data/virtual-timeline-2000-tools.png' });
  console.log(JSON.stringify({ sourceTools: 2000, mountedRows: mounted, singleVirtualLayer: true }));
});

for (const width of [1440, 390]) test(`${width}px streaming while reading preserves a virtual row anchor and explicit latest resumes following`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 844 });
  const turn = running(mock, 500);
  await enter(page);
  await viewport(page).evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  const before = await anchor(page);
  turn.items.at(-1)!.text += '\n\n' + '更新底部进展\n\n'.repeat(60);
  mock.emit('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: 'active-answer', delta: '\n\n' + '更新底部进展\n\n'.repeat(60) });
  await expect.poll(() => offset(page, before.id)).toBeCloseTo(before.offset, 0);
  await page.getByRole('button', { name: '跳到最新消息', exact: true }).click();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
  mock.emit('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: 'active-answer', delta: '\n\n' + '继续跟随\n\n'.repeat(20) });
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
});

test('selected source text remains mounted when the selected row moves outside the visible range', async ({ page, mock }) => {
  running(mock, 300);
  await enter(page);
  const selected = await page.getByText('实时进展的末尾', { exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return window.getSelection()!.toString();
  });
  await viewport(page).evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByText('大型活动轮次的初始消息', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
  await expect(page.locator('[data-timeline-row="item:active-answer"]')).toHaveCount(1);
  expect(await page.locator('[data-timeline-row]').count()).toBeLessThan(65);
});

test('released command output is fetched by native item anchor only after the reader asks for the full text', async ({ page, mock }) => {
  const turn = running(mock, 200);
  turn.items[1]!.aggregatedOutput = 'original-command-prefix\n' + 'large output\n'.repeat(15000) + 'original-command-tail';
  await enter(page);
  await expect.poll(() => mock.requests.some(request => request.method === 'thread/items/list' && request.params.limit === 1)).toBe(true);
  // The first completed command is older than the sixteen retained output windows.
  await viewport(page).evaluate(element => { element.scrollTop = 0; });
  const tool = page.locator('.tool-item').filter({ hasText: 'echo command-0' });
  await tool.locator('summary').click();
  await expect(tool).toContainText('输出已从内存释放');
  await tool.getByRole('button', { name: '读取完整输出', exact: true }).click();
  await expect(tool).toContainText('original-command-prefix');
  await expect(tool).toContainText('original-command-tail');
  expect(mock.requests.filter(request => request.method === 'thread/items/list').some(request => request.params.cursor?.itemId === 'active-user' && request.params.limit === 1)).toBe(true);
});

test('crossing the virtualization threshold during an update keeps an existing historical reading anchor', async ({ page, mock }) => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ id: `threshold-${i}`, status: i === 19 ? 'inProgress' : 'completed', itemsView: 'full', durationMs: 1000,
    items: [{ id: `threshold-user-${i}`, type: 'userMessage', content: [{ type: 'text', text: `历史输入 ${i}` }] },
      { id: `threshold-agent-${i}`, type: 'agentMessage', phase: 'final_answer', text: (`历史回复 ${i}\n\n`).repeat(5) }] }));
  mock.turns.set(threadId, turns); mock.threads[0].status = { type: 'active' }; wireItems(mock);
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator('[data-virtual-timeline]')).toHaveCount(0);
  const before = await viewport(page).evaluate(element => {
    const block = element.querySelector<HTMLElement>('[data-history-id="threshold-6"]')!;
    element.scrollTop += block.getBoundingClientRect().top - element.getBoundingClientRect().top - 24;
    element.dispatchEvent(new Event('scroll'));
    return block.getBoundingClientRect().top - element.getBoundingClientRect().top;
  });
  for (let i = 0; i < 60; i++) mock.emit('item/completed', { threadId, turnId: 'threshold-19', item: { id: `threshold-tool-${i}`, type: 'commandExecution', command: `echo ${i}`, status: 'completed', exitCode: 0, aggregatedOutput: 'done' } });
  await expect(page.locator('[data-virtual-timeline]')).toBeVisible();
  await expect.poll(() => offset(page, 'item:threshold-user-6')).toBeCloseTo(before, 0);
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
});

for (const width of [1440, 390]) test(`${width}px virtual reading position survives switching and reload while latest resumes following`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 844 });
  const turn = running(mock, 400);
  mock.threads.push({ ...mock.threads[0], id: 'virtual-other', name: '另一个虚拟阅读会话', status: { type: 'idle' } });
  mock.turns.set('virtual-other', []);
  await login(page); await select(page, '已有测试历史');
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
  await viewport(page).evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  const before = await anchor(page);
  await select(page, '另一个虚拟阅读会话');
  turn.items.at(-1)!.text += '\n\n' + '切换期间新增进展\n\n'.repeat(30);
  await select(page, '已有测试历史');
  await expect.poll(() => offset(page, before.id)).toBeCloseTo(before.offset, 0);
  await page.reload();
  await select(page, '已有测试历史');
  await expect.poll(() => offset(page, before.id)).toBeCloseTo(before.offset, 0);
  await page.getByRole('button', { name: '跳到最新消息', exact: true }).click();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
  await select(page, '另一个虚拟阅读会话');
  turn.items.at(-1)!.text += '\n\n' + '离开后继续新增\n\n'.repeat(30);
  await select(page, '已有测试历史');
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
});

test('prepending a native page preserves the visible virtual anchor and chronology without mounting the whole history', async ({ page, mock }) => {
  const turns = Array.from({ length: 65 }, (_, i) => ({ id: `prepend-${i}`, status: 'completed', itemsView: 'full', durationMs: 1000,
    items: [{ id: `prepend-user-${i}`, type: 'userMessage', content: [{ type: 'text', text: `分页问题 ${i}` }] },
      { id: `prepend-agent-${i}`, type: 'agentMessage', phase: 'final_answer', text: (`分页回复 ${i}\n\n`).repeat(4) }] }));
  mock.turns.set(threadId, turns); wireItems(mock);
  const original = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/turns/list') return original(socket, request);
    mock.requests.push(request);
    const start = Number(request.params.cursor || 0), newest = [...turns].reverse();
    return socket.send(JSON.stringify({ id: request.id, result: { data: newest.slice(start, start + request.params.limit), nextCursor: start + request.params.limit < turns.length ? String(start + request.params.limit) : null } }));
  };
  await enter(page);
  await viewport(page).evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  const before = await anchor(page);
  // Programmatic activation keeps the viewport at the current reading anchor.
  await page.getByRole('button', { name: '加载更早的消息', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => offset(page, before.id)).toBeCloseTo(before.offset, 0);
  await expect(page.locator('[data-virtual-timeline]')).toHaveAttribute('data-row-count', '180');
  expect(await page.locator('[data-timeline-row]').count()).toBeLessThan(65);
});

test('a delayed image changes its measured virtual row height and keeps a reader at the latest output', async ({ page, mock }) => {
  const turn = running(mock, 200);
  turn.items.at(-1)!.text += '\n\n![延迟加载图片](https://virtual-image.test/image.svg)';
  let release: (() => Promise<void>) | undefined;
  await page.route('https://virtual-image.test/image.svg', route => new Promise<void>(resolve => {
    release = async () => { await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="700"><rect width="800" height="700" fill="blue"/></svg>' }); resolve(); };
  }));
  await enter(page);
  await expect.poll(() => !!release).toBe(true);
  const before = await viewport(page).evaluate(element => element.scrollHeight);
  await release!();
  await expect.poll(() => page.getByAltText('延迟加载图片').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(800);
  await expect.poll(() => viewport(page).evaluate(element => element.scrollHeight)).toBeGreaterThan(before + 100);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
});

test('an unanswered form stays mounted with its selected answer when its virtual row leaves the viewport', async ({ page, mock }) => {
  const turn = running(mock, 300);
  turn.items.push({ id: 'virtual-question', type: 'agentMessage', delivery: 'async', phase: 'commentary', text: '确认处理范围',
    questions: [{ title: '要处理哪些数据？', options: ['仅验证集', '所有数据'] }] } as any);
  await enter(page);
  const card = page.locator('[data-async-question-id="virtual-question"]');
  await expect(card).toBeVisible();
  await card.getByRole('radio', { name: '仅验证集', exact: true }).check();
  await viewport(page).evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByText('大型活动轮次的初始消息', { exact: true })).toBeVisible();
  await expect(card.getByRole('radio', { name: '仅验证集', exact: true })).toBeChecked();
  await expect(card.getByRole('button', { name: '提交选择', exact: true })).toBeEnabled();
  expect(await page.locator('[data-timeline-row]').count()).toBeLessThan(65);
});

test('editing a message retains its virtual row and unsent changes while reading another part of the conversation', async ({ page, mock }) => {
  mock.turns.set(threadId, Array.from({ length: 45 }, (_, i) => ({ id: `edit-virtual-${i}`, status: 'completed', itemsView: 'full', durationMs: 1000,
    items: [{ id: `edit-virtual-user-${i}`, type: 'userMessage', content: [{ type: 'text', text: `编辑问题 ${i}` }] },
      { id: `edit-virtual-agent-${i}`, type: 'agentMessage', phase: 'final_answer', text: (`编辑回复 ${i}\n\n`).repeat(3) }] })));
  wireItems(mock);
  await enter(page);
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const draft = page.getByRole('textbox', { name: '编辑消息内容', exact: true });
  await draft.fill('暂未发送的新内容');
  await viewport(page).evaluate(element => { element.scrollTop = 0; });
  await expect(draft).toHaveValue('暂未发送的新内容');
  expect(await page.locator('[data-timeline-row]').count()).toBeLessThan(65);
  await page.locator('.message-editor').getByRole('button', { name: '取消', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(draft).toHaveCount(0);
  expect(mock.request('thread/revert')).toBeUndefined();
});
