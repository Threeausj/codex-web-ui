import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';
const takeoverRoute = /\/api\/threads\/local\/thread-existing\/takeover(?:\/inspect)?$/;

async function lockThread(page: Page, mock: MockCodex) {
  await page.addInitScript(() => localStorage.setItem('codex.draft.local.thread-existing', '占用解除后继续的草稿'));
  await login(page);
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  let locked = true;
  const socket = mock.sockets[0]!;
  const send = socket.send.bind(socket);
  socket.send = raw => {
    const response = JSON.parse(raw.toString());
    const request = mock.requests.find(request => request.id === response.id);
    if (locked && request?.method === 'thread/resume' && request.params.threadId === 'thread-existing')
      return send(JSON.stringify({ id: response.id, error: { code: -32000, message: 'thread thread-existing already has an active writer' } }));
    send(raw);
  };
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByRole('button', { name: '强制进入', exact: true })).toBeVisible();
  return { unlock: () => { locked = false; } };
}

test('locked target and editable draft survive cancellation; only explicit confirmation submits the inspected challenge', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 667 });
  const lock = await lockThread(page, mock);
  const draft = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await expect(draft).toHaveValue('占用解除后继续的草稿');
  await draft.fill('确认前仍能编辑的草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  const calls: any[] = [];
  const bounds = await page.locator('.global-error').boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.locator('.global-error').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '关闭错误', exact: true })).toHaveCount(0);
  await page.route(takeoverRoute, async route => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    calls.push({ inspect: url.pathname.endsWith('/inspect'), body });
    if (url.pathname.endsWith('/inspect')) return route.fulfill({ json: {
      locked: true, owner: { pid: 456, affectedThreadCount: 3 }, challenge: 'inspected-owner-challenge',
    } });
    lock.unlock();
    await route.fulfill({ json: { ok: true, released: true, terminated: true, threadId: 'thread-existing' } });
  });
  page.once('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('3 个会话');
    expect(dialog.message()).toContain('正在运行的任务将被中断');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '强制进入', exact: true }).click();
  await expect(page.getByRole('button', { name: '强制进入', exact: true })).toBeEnabled();
  expect(calls).toEqual([{ inspect: true, body: {} }]);
  await expect(draft).toHaveValue('确认前仍能编辑的草稿');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '强制进入', exact: true }).click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  await expect(draft).toHaveValue('确认前仍能编辑的草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(calls.at(-1)).toEqual({ inspect: false, body: { confirmed: true, challenge: 'inspected-owner-challenge' } });
  expect(mock.request('thread/start')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a failed takeover keeps the same target available for a fresh inspection and retry', async ({ page, mock }) => {
  const lock = await lockThread(page, mock);
  let inspections = 0;
  const challenges: string[] = [];
  await page.route(takeoverRoute, async route => {
    if (new URL(route.request().url()).pathname.endsWith('/inspect')) {
      return route.fulfill({ json: { locked: true, owner: { pid: 456, affectedThreadCount: 1 }, challenge: `challenge-${++inspections}` } });
    }
    challenges.push(route.request().postDataJSON().challenge);
    if (challenges.length === 1) return route.fulfill({ status: 409, json: { error: '占用进程已变化，请重新确认。' } });
    lock.unlock();
    await route.fulfill({ json: { ok: true, released: true, terminated: true } });
  });
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '强制进入', exact: true }).click();
  await expect(page.locator('.global-error')).toContainText('占用进程已变化');
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('占用解除后继续的草稿');
  await page.getByRole('button', { name: '强制进入', exact: true }).click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  expect(challenges).toEqual(['challenge-1', 'challenge-2']);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('an inspection finishing after navigation cannot confirm or terminate the previous target', async ({ page, mock }) => {
  mock.threads.push({ ...mock.threads[0], id: 'thread-other', name: '切换后的对话' });
  mock.turns.set('thread-other', [{ ...mock.turns.get('thread-existing')![0], id: 'other-history', items: [{ id: 'other-answer', type: 'agentMessage', text: '新选择保留' }] }]);
  await lockThread(page, mock);
  let release: (() => Promise<void>) | undefined;
  let submitted = 0;
  await page.route(takeoverRoute, async route => {
    if (!new URL(route.request().url()).pathname.endsWith('/inspect')) {
      submitted++;
      return route.fulfill({ json: { ok: true, released: true } });
    }
    await new Promise<void>(resolve => {
      release = async () => { await route.fulfill({ json: { locked: true, owner: { pid: 456, affectedThreadCount: 2 }, challenge: 'stale-challenge' } }); resolve(); };
    });
  });
  let confirmations = 0;
  page.on('dialog', async dialog => { confirmations++; await dialog.dismiss(); });
  await page.getByRole('button', { name: '强制进入', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '切换后的对话' }).click();
  await expect(page.locator('.agent-message')).toContainText('新选择保留');
  await expect(page.locator('.global-error')).toHaveCount(0);
  await release!();
  await expect(page.getByRole('button', { name: '强制进入', exact: true })).toHaveCount(0);
  expect(confirmations).toBe(0);
  expect(submitted).toBe(0);
  await expect(page.locator('.agent-message')).toContainText('新选择保留');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a confirmed takeover reply arriving after navigation cannot replace the new target or its errors', async ({ page, mock }) => {
  mock.threads.push({ ...mock.threads[0], id: 'thread-after-confirm', name: '确认后选择的对话' });
  mock.turns.set('thread-after-confirm', [{ id: 'new-history', status: 'completed', items: [{ id: 'new-answer', type: 'agentMessage', text: '接管响应不能改变的新选择' }] }]);
  await lockThread(page, mock);
  let release: (() => Promise<void>) | undefined;
  let submitted = 0;
  await page.route(takeoverRoute, async route => {
    if (new URL(route.request().url()).pathname.endsWith('/inspect'))
      return route.fulfill({ json: { locked: true, owner: { pid: 456, affectedThreadCount: 1 }, challenge: 'confirmed-challenge' } });
    submitted++;
    await new Promise<void>(resolve => {
      release = async () => { await route.fulfill({ status: 409, json: { error: '旧目标重新被占用' } }); resolve(); };
    });
  });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '强制进入', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '确认后选择的对话' }).click();
  await expect(page.getByText('接管响应不能改变的新选择', { exact: true })).toBeVisible();
  await release!();
  await expect(page.locator('.global-error')).toHaveCount(0);
  await expect(page.getByText('接管响应不能改变的新选择', { exact: true })).toBeVisible();
  expect(submitted).toBe(1);
  expect(mock.requests.filter(request => request.method === 'thread/resume' && request.params.threadId === 'thread-existing')).toHaveLength(1);
});

test('an already released lock resumes without asking to terminate a process', async ({ page, mock }) => {
  const lock = await lockThread(page, mock);
  let confirmations = 0;
  let mutations = 0;
  page.on('dialog', async dialog => { confirmations++; await dialog.dismiss(); });
  await page.route(takeoverRoute, async route => {
    if (!new URL(route.request().url()).pathname.endsWith('/inspect')) mutations++;
    lock.unlock();
    await route.fulfill({ json: { locked: false } });
  });
  await page.getByRole('button', { name: '强制进入', exact: true }).click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  expect(confirmations).toBe(0);
  expect(mutations).toBe(0);
});

test('session expiry during a pending resume preserves the remembered thread and expiry message', async ({ page, mock }) => {
  await login(page);
  const row = page.locator('[data-section="recent"] .thread-row').first();
  await row.click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  const draft = page.getByRole('textbox', { name: '消息输入框' });
  await draft.fill('重新登录后继续的草稿');
  const socket = mock.sockets[0]!;
  const send = socket.send.bind(socket);
  let pendingResume = false;
  socket.send = raw => {
    const response = JSON.parse(raw.toString());
    const request = mock.requests.find(request => request.id === response.id);
    if (request?.method === 'thread/resume') { pendingResume = true; return; }
    send(raw);
  };
  await row.click();
  await expect.poll(() => pendingResume).toBe(true);
  mock.authenticated = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('textbox', { name: '访问密码' })).toBeVisible();
  await expect(page.locator('.login-card .inline-error')).toHaveText('登录已过期，请重新登录');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('codex.selectedThreadIds') || '{}').local))
    .toBe('thread-existing');
  expect(await page.evaluate(() => localStorage.getItem('codex.draft.local.thread-existing')))
    .toBe('重新登录后继续的草稿');
  // Re-login in this same app instance; a document reload would conceal stale
  // selection/takeover flags left behind by the previous authentication scope.
  await page.getByRole('textbox', { name: '访问密码' }).fill('test-password-123');
  await page.getByRole('button', { name: /登录|进入工作区|解锁/ }).first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('重新登录后继续的草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '强制进入', exact: true })).toHaveCount(0);
  expect(mock.request('turn/start')).toBeUndefined();
});
