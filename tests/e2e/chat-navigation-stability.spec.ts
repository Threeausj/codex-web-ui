import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const targetId = 'thread-existing';
const targetTitle = '持续工作的会话';
const otherTitle = '切换用会话';
function conversation(mock: MockCodex, title = targetTitle, virtual = false) {
  mock.threads[0] = { ...mock.threads[0], name: title, preview: title, status: { type: 'active' } };
  const turns = Array.from({ length: 24 }, (_, index) => ({
    id: `stable-${index}`, status: index === 23 ? 'inProgress' : 'completed', itemsView: 'full',
    items: [{ id: `stable-agent-${index}`, type: 'agentMessage', phase: index === 23 ? 'commentary' : 'final_answer',
      text: Array.from({ length: 6 }, (_, line) => `稳定历史 ${index} 第 ${line} 段，用于验证切换时历史阅读位置不会闪动。`).join('\n\n') }] as any[],
  }));
  if (virtual) turns[23]!.items.unshift(...Array.from({ length: 70 }, (_, index) => ({
    id: `stable-tool-${index}`, type: 'commandExecution', status: 'completed', exitCode: 0,
    command: `echo working-${index}`, aggregatedOutput: `working-${index}`,
  })));
  mock.turns.set(targetId, turns);
  return turns;
}
function addOther(mock: MockCodex) {
  mock.threads.push({ ...mock.threads[0], id: 'stable-other', name: otherTitle, preview: otherTitle, status: { type: 'idle' } });
  mock.turns.set('stable-other', [{ id: 'other-turn', status: 'completed', items: [{ id: 'other-answer', type: 'agentMessage', text: '另一个会话的短内容' }] }]);
}
function markRunning(mock: MockCodex, turns: any[]) {
  const turn = turns.at(-1)!;
  mock.emit('turn/started', { threadId: targetId, turn });
}
function delayNative(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  let holding = false;
  const queued: { socket: any; request: any }[] = [];
  (mock as any).receive = (socket: any, request: any) => {
    if (holding && request.params?.threadId === targetId && ['thread/resume', 'thread/read', 'thread/turns/list'].includes(request.method)) {
      queued.push({ socket, request }); return;
    }
    return receive(socket, request);
  };
  return { queued, hold() { holding = true; }, release() {
    holding = false;
    for (const { socket, request } of queued.splice(0)) receive(socket, request);
  } };
}
async function choose(page: Page, title: string, host = 'local') {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator(`[data-section="recent"] [data-host-id="${host}"] .thread-row`).filter({ hasText: title }).first().click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: title, exact: true }).dblclick();
}
async function topTab(page: Page, title: string) {
  await page.getByRole('tab', { name: title, exact: true }).click();
}
async function historicalPosition(page: Page, host = 'local') {
  await page.locator('.conversation-scroll').evaluate(viewport => {
    const anchor = viewport.querySelector<HTMLElement>('[data-history-id="stable-8"]')!;
    viewport.scrollTop += anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 35;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.evaluate(host => {
    const value = JSON.parse(sessionStorage.getItem(`codex.scroll.${host}.thread-existing`) || 'null');
    return value?.anchor?.historyId || null;
  }, host)).not.toBeNull();
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  return page.evaluate(host => {
    const position = JSON.parse(sessionStorage.getItem(`codex.scroll.${host}.thread-existing`) || 'null');
    return { id: position.anchor.historyId as string, offset: position.anchor.offset as number };
  }, host);
}
async function trackFrames(page: Page, title: string, historyId = 'stable-8') {
  await page.evaluate(({ title, historyId }) => {
    const frames: { offset: number | null; gap: number; visible: boolean; content: boolean; runningOpen: boolean; time: number }[] = [];
    const started = performance.now(); let running = true;
    (window as any).chatNavigationFrames = frames;
    (window as any).stopChatNavigationFrames = () => { running = false; };
    const frame = () => {
      if (!running) return;
      const viewport = document.querySelector<HTMLElement>('.conversation-scroll');
      const heading = document.querySelector('.main-header h1');
      if (viewport && heading?.textContent?.trim() === title) {
        const anchor = [...viewport.querySelectorAll<HTMLElement>('[data-history-id]')].find(element => element.dataset.historyId === historyId);
        // Normal and virtual timelines use different row wrappers; the last
        // activity disclosure belongs to the latest (in-progress) turn.
        const runningActivity = [...document.querySelectorAll<HTMLElement>('.turn-activity')].at(-1);
        const runningContent = runningActivity?.querySelector<HTMLElement>('.turn-activity-content');
        const virtualRunningActivity = document.querySelector<HTMLElement>('.virtual-turn-toggle[aria-label="工作过程（运行中）"]');
        frames.push({
          offset: anchor ? anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top : null,
          gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
          visible: !!viewport.clientHeight && getComputedStyle(viewport).visibility !== 'hidden' && getComputedStyle(viewport).opacity !== '0' &&
            getComputedStyle(viewport.querySelector('[data-virtual-timeline]') || viewport).visibility !== 'hidden',
          content: !!viewport.querySelector('.agent-message'),
          runningOpen: virtualRunningActivity ? virtualRunningActivity.getAttribute('aria-expanded') === 'true'
            : !!runningActivity?.matches('details[open]') && !!runningContent && getComputedStyle(runningContent).display !== 'none',
          time: performance.now() - started,
        });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, { title, historyId });
}
async function frames(page: Page, count = 18) {
  await page.evaluate(count => new Promise<void>(resolve => {
    let remaining = count;
    const step = () => --remaining ? requestAnimationFrame(step) : resolve();
    requestAnimationFrame(step);
  }), count);
  return page.evaluate(() => (window as any).chatNavigationFrames as {
    offset: number | null; gap: number; visible: boolean; content: boolean; runningOpen: boolean; time: number;
  }[]);
}

for (const width of [1440, 390]) test(`${width}px: a cached running chat restores historical reading before delayed native hydration, without painting another position`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 844 });
  const turns = conversation(mock); addOther(mock); const native = delayNative(mock);
  await login(page); await choose(page, targetTitle);
  markRunning(mock, turns);
  await expect(page.locator('.turn-activity').last()).toHaveAttribute('open', '');
  await expect(page.locator('.turn-activity').last().locator('.turn-activity-content')).toBeVisible();
  const position = await historicalPosition(page);
  await choose(page, otherTitle);
  native.hold(); await trackFrames(page, targetTitle, position.id); await topTab(page, targetTitle);
  await expect.poll(() => native.queued.length).toBeGreaterThan(0);
  // Cached history must remain readable while the fresh native response waits.
  await expect(page.getByText('稳定历史 8 第 0 段，用于验证切换时历史阅读位置不会闪动。', { exact: true })).toBeVisible();
  const pending = (await frames(page)).filter(frame => frame.visible && frame.content && frame.offset !== null);
  expect(pending.length).toBeGreaterThanOrEqual(8);
  expect(Math.max(...pending.map(frame => Math.abs(frame.offset! - position.offset)))).toBeLessThanOrEqual(2);
  expect(pending.every(frame => frame.runningOpen), 'cached in-progress turn should not flash collapsed during native hydration').toBe(true);
  turns[23]!.items[0].text += '\n\n切换过程中工作继续输出。';
  native.release();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  const settled = (await frames(page)).filter(frame => frame.visible && frame.content && frame.offset !== null);
  expect(Math.max(...settled.map(frame => Math.abs(frame.offset! - position.offset)))).toBeLessThanOrEqual(2);
  expect(settled.every(frame => frame.runningOpen), 'in-progress turn should stay expanded after hydration').toBe(true);
  expect(mock.requests.filter(request => ['turn/start', 'turn/interrupt', 'thread/unsubscribe'].includes(request.method || ''))).toEqual([]);
});

test('a running virtual timeline stays at the latest output while cached content is revalidated', async ({ page, mock }) => {
  const turns = conversation(mock, targetTitle, true); addOther(mock); const native = delayNative(mock);
  await login(page); await choose(page, targetTitle);
  markRunning(mock, turns);
  await expect(page.locator('[data-virtual-timeline]')).toBeVisible();
  await expect.poll(() => page.locator('.conversation-scroll').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
  await choose(page, otherTitle);
  native.hold(); await trackFrames(page, targetTitle); await topTab(page, targetTitle);
  await expect.poll(() => native.queued.length).toBeGreaterThan(0);
  await expect(page.locator('[data-virtual-timeline]')).toBeVisible();
  const pending = (await frames(page)).filter(frame => frame.visible && frame.content);
  expect(pending.length).toBeGreaterThanOrEqual(8);
  expect(Math.max(...pending.map(frame => Math.abs(frame.gap)))).toBeLessThanOrEqual(2);
  // Work is allowed to continue during navigation; its output must not create
  // another scroll owner when the canonical history finally arrives.
  const last = turns[23]!.items.at(-1)!;
  last.text += '\n\n后台工作继续输出。';
  mock.emit('item/agentMessage/delta', { threadId: targetId, turnId: 'stable-23', itemId: last.id, delta: '\n\n后台工作继续输出。' });
  native.release();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  const settled = (await frames(page)).filter(frame => frame.visible && frame.content);
  expect(Math.max(...settled.map(frame => Math.abs(frame.gap)))).toBeLessThanOrEqual(2);
  expect(mock.sockets).toHaveLength(1);
  expect(mock.requests.filter(request => ['turn/start', 'turn/interrupt', 'thread/unsubscribe'].includes(request.method || ''))).toEqual([]);
});

for (const width of [1440, 390]) test(`${width}px: a virtual historical revisit keeps its anchor through cached restoration and live hydration`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 844 });
  const turns = conversation(mock, targetTitle, true); addOther(mock); const native = delayNative(mock);
  await login(page); await choose(page, targetTitle);
  markRunning(mock, turns);
  const viewport = page.locator('.conversation-scroll');
  await expect(page.locator('[data-virtual-timeline]')).toBeVisible();
  // The historical row is initially outside the mounted virtual range. Move
  // toward the beginning, then use its measured geometry rather than assuming
  // that the virtualizer's estimated heights match desktop/mobile wrapping.
  await viewport.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  const anchor = viewport.locator('[data-history-id="item:stable-agent-8"]');
  await expect(anchor).toBeAttached();
  await viewport.evaluate(element => {
    const anchor = element.querySelector<HTMLElement>('[data-history-id="item:stable-agent-8"]')!;
    element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - 35;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const position = JSON.parse(sessionStorage.getItem('codex.scroll.local.thread-existing') || 'null');
    return !!position?.anchor && !position.bottom;
  })).toBe(true);
  const position = await page.evaluate(() => {
    const position = JSON.parse(sessionStorage.getItem('codex.scroll.local.thread-existing')!);
    return { id: position.anchor.historyId as string, offset: position.anchor.offset as number };
  });
  await choose(page, otherTitle);
  native.hold(); await trackFrames(page, targetTitle, position.id); await topTab(page, targetTitle);
  await expect.poll(() => native.queued.length).toBeGreaterThan(0);
  const pending = await frames(page);
  // A hidden viewport must not disguise a long blank flash. At most two
  // animation frames are allowed while the virtual anchor is first measured.
  expect(pending.filter(frame => !frame.visible).length).toBeLessThanOrEqual(2);
  const visible = pending.filter(frame => frame.visible);
  expect(visible.length).toBeGreaterThanOrEqual(8);
  expect(visible.every(frame => frame.content && frame.offset !== null), 'every visible historical frame should contain its restored anchor').toBe(true);
  expect(Math.max(...visible.map(frame => Math.abs(frame.offset! - position.offset)))).toBeLessThanOrEqual(2);
  const last = turns[23]!.items.at(-1)!;
  const delta = '\n\n阅读旧消息时，后台工作继续输出。';
  last.text += delta;
  mock.emit('item/agentMessage/delta', { threadId: targetId, turnId: 'stable-23', itemId: last.id, delta });
  native.release();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  const settled = await frames(page);
  expect(settled.filter(frame => !frame.visible).length).toBeLessThanOrEqual(2);
  const settledVisible = settled.filter(frame => frame.visible);
  expect(settledVisible.every(frame => frame.content && frame.offset !== null)).toBe(true);
  expect(Math.max(...settledVisible.map(frame => Math.abs(frame.offset! - position.offset))),
    JSON.stringify({ position, visibleOffsets: [...new Set(settledVisible.map(frame => frame.offset))] })).toBeLessThanOrEqual(2);
  expect(mock.requests.filter(request => ['turn/start', 'turn/interrupt', 'thread/unsubscribe'].includes(request.method || ''))).toEqual([]);
});

test('rapidly leaving and returning to a virtual chat cancels obsolete restoration work', async ({ page, mock }) => {
  const turns = conversation(mock, targetTitle, true); addOther(mock); const native = delayNative(mock);
  await login(page); await choose(page, targetTitle); markRunning(mock, turns);
  const viewport = page.locator('.conversation-scroll');
  await expect(page.locator('[data-virtual-timeline]')).toBeVisible();
  await viewport.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(viewport.locator('[data-history-id="item:stable-agent-8"]')).toBeAttached();
  await viewport.evaluate(element => {
    const anchor = element.querySelector<HTMLElement>('[data-history-id="item:stable-agent-8"]')!;
    element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - 35;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  const position = await page.evaluate(() => {
    const position = JSON.parse(sessionStorage.getItem('codex.scroll.local.thread-existing')!);
    return { id: position.anchor.historyId as string, offset: position.anchor.offset as number };
  });
  await choose(page, otherTitle);
  native.hold();
  // Hold frame work to reproduce a user changing tabs before the first
  // historical anchor has been measured. Release only that obsolete work while
  // the replacement instance is still waiting for its own next frame.
  await page.evaluate(() => {
    const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
    const queued = new Map<number, FrameRequestCallback>(); let next = -1;
    window.requestAnimationFrame = callback => { const id = next--; queued.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { if (id < 0) queued.delete(id); else cancel(id); };
    (window as any).navigationFrameHold = {
      ids: () => [...queued.keys()],
      release(ids: number[]) { for (const id of ids) { const callback = queued.get(id); queued.delete(id); callback?.(performance.now()); } },
      finish() {
        window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel;
        for (const callback of queued.values()) request(callback);
        queued.clear();
      },
    };
  });
  await topTab(page, targetTitle);
  await expect.poll(() => page.evaluate(() => (window as any).navigationFrameHold.ids().length)).toBeGreaterThan(0);
  const obsoleteFrames = await page.evaluate(() => (window as any).navigationFrameHold.ids() as number[]);
  await topTab(page, otherTitle);
  await expect(page.locator('[data-virtual-timeline]')).toHaveCount(0);
  await topTab(page, targetTitle);
  await expect(page.locator('[data-virtual-timeline]')).toBeAttached();
  const visibility = await page.locator('[data-virtual-timeline]').evaluate(element => getComputedStyle(element).visibility);
  await page.evaluate(ids => (window as any).navigationFrameHold.release(ids), obsoleteFrames);
  // A synchronously mounted anchor can already be visible. If the new instance
  // still needs a frame, an obsolete callback must not reveal it prematurely.
  if (visibility === 'hidden')
    await expect.poll(() => page.locator('[data-virtual-timeline]').evaluate(element => getComputedStyle(element).visibility)).toBe('hidden');
  else await expect.poll(() => viewport.evaluate((element, id) => {
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-history-id]')].find(row => row.dataset.historyId === id);
    return anchor ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
  }, position.id)).toBeCloseTo(position.offset, 0);
  await page.evaluate(() => (window as any).navigationFrameHold.finish());
  native.release();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await expect(page.locator('[data-virtual-timeline]')).toBeVisible();
  await expect(page.getByText('稳定历史 8 第 0 段，用于验证切换时历史阅读位置不会闪动。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  expect(mock.requests.filter(request => ['turn/start', 'turn/interrupt', 'thread/unsubscribe'].includes(request.method || ''))).toEqual([]);
});

test('returning to a cached running chat on another host restores that host’s reading anchor before its history request finishes', async ({ page, mock }) => {
  const remote = new MockCodex(); conversation(remote);
  const remoteHost = 'stable-remote';
  mock.hosts.push({ id: remoteHost, name: 'Stable Remote', kind: 'ssh', cwd: '/srv/stable-remote' });
  mock.hostMocks.set(remoteHost, remote); const native = delayNative(remote);
  await login(page); await choose(page, targetTitle, remoteHost);
  markRunning(remote, remote.turns.get(targetId)!);
  await expect(page.locator('.turn-activity').last()).toHaveAttribute('open', '');
  await expect(page.locator('.turn-activity').last().locator('.turn-activity-content')).toBeVisible();
  const position = await historicalPosition(page, remoteHost);
  await choose(page, '已有测试历史');
  native.hold(); await trackFrames(page, targetTitle, position.id); await topTab(page, targetTitle);
  await expect.poll(() => native.queued.length).toBeGreaterThan(0);
  await expect(page.getByText('稳定历史 8 第 0 段，用于验证切换时历史阅读位置不会闪动。', { exact: true })).toBeVisible();
  const pending = (await frames(page)).filter(frame => frame.visible && frame.content && frame.offset !== null);
  expect(pending.length).toBeGreaterThanOrEqual(8);
  expect(Math.max(...pending.map(frame => Math.abs(frame.offset! - position.offset)))).toBeLessThanOrEqual(2);
  expect(pending.every(frame => frame.runningOpen), 'cached in-progress turn should stay expanded while reconnecting to its host').toBe(true);
  native.release();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  const settled = (await frames(page)).filter(frame => frame.visible && frame.content && frame.offset !== null);
  expect(Math.max(...settled.map(frame => Math.abs(frame.offset! - position.offset)))).toBeLessThanOrEqual(2);
  expect(settled.every(frame => frame.runningOpen), 'in-progress turn should remain expanded after remote hydration').toBe(true);
  expect(remote.sockets).toHaveLength(1);
  expect(remote.requests.filter(request => ['turn/start', 'turn/interrupt', 'thread/unsubscribe'].includes(request.method || ''))).toEqual([]);
});
