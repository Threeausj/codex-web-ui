import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const strip = (page: Page) => page.getByRole('tablist', { name: '聊天标签页', exact: true });
const editor = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const tab = (page: Page, name: string) => strip(page).getByRole('tab', { name, exact: true });
const wrapper = (page: Page, hostId: string, threadId = 'thread-existing') =>
  page.locator(`.chat-tab[data-host-id="${hostId}"][data-thread-id="${threadId}"]`);
async function sidebar(page: Page) {
  const toggle = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await toggle.isVisible() && !await page.locator('.sidebar').evaluate(element => element.classList.contains('mobile-open')))
    await toggle.click();
}
async function open(page: Page, name: string, hostId = 'local') {
  await sidebar(page);
  await page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"] .thread-row`).filter({ hasText: name }).click();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect(editor(page)).toBeEnabled();
}
function add(mock: MockCodex, id: string, name: string, text = `${name}的内容`) {
  mock.threads.push({ ...mock.threads[0]!, id, name, preview: name, status: { type: 'idle' } });
  mock.turns.set(id, [{ id: `turn-${id}`, status: 'completed', itemsView: 'full', error: null,
    items: [{ id: `answer-${id}`, type: 'agentMessage', text }] }]);
}
function noDestructiveRequests(mock: MockCodex) {
  expect(mock.requests.filter(request => ['turn/interrupt', 'thread/archive', 'thread/delete', 'thread/unsubscribe', 'command/exec/terminate'].includes(request.method || ''))).toEqual([]);
}

test('opened chats become browser tabs, retain independent drafts and use the existing connection', async ({ page, mock }) => {
  add(mock, 'second-tab', '第二条标签聊天');
  await login(page); await open(page, '已有测试历史');
  await editor(page).fill('第一条聊天的草稿');
  await open(page, '第二条标签聊天');
  await editor(page).fill('第二条聊天的草稿');
  await expect(strip(page).getByRole('tab')).toHaveCount(2);
  await expect(page.locator('.main-header .header-host')).toHaveCount(0);
  await expect(wrapper(page, 'local', 'second-tab').getByRole('button', { name: '对话操作', exact: true })).toBeVisible();
  await expect(page.locator('.header-actions').getByRole('button', { name: '对话操作', exact: true })).toHaveCount(0);
  await tab(page, '已有测试历史').click();
  await expect(editor(page)).toHaveValue('第一条聊天的草稿');
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  await tab(page, '第二条标签聊天').click();
  await expect(editor(page)).toHaveValue('第二条聊天的草稿');
  expect(mock.sockets).toHaveLength(1);
  expect(mock.request('turn/start')).toBeUndefined();
  noDestructiveRequests(mock);
  await page.screenshot({ path: '.data/chat-tabs-desktop.png' });
});

test('identical native IDs and titles on different hosts create independent tabs and drafts', async ({ page, mock }) => {
  const remote = new MockCodex();
  remote.turns.get('thread-existing')![0].items[1].text = '远端同名聊天内容';
  mock.hosts.push({ id: 'tabs-remote', name: '远端主机', kind: 'ssh', hostname: 'remote.invalid' });
  mock.projects.push({ ...mock.projects[0], id: 'remote-tabs-project', hostId: 'tabs-remote' });
  mock.hostMocks.set('tabs-remote', remote);
  await login(page); await open(page, '已有测试历史');
  await editor(page).fill('本机同名聊天草稿');
  await sidebar(page);
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="tabs-remote"] .thread-row').click();
  await expect(wrapper(page, 'tabs-remote').getByRole('tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.agent-message')).toContainText('远端同名聊天内容');
  await editor(page).fill('远端同名聊天草稿');
  await expect(strip(page).getByRole('tab', { name: '已有测试历史', exact: true })).toHaveCount(2);
  await wrapper(page, 'local').getByRole('tab').click();
  await expect(wrapper(page, 'local').getByRole('tab')).toHaveAttribute('aria-selected', 'true');
  await expect(editor(page)).toHaveValue('本机同名聊天草稿');
  await wrapper(page, 'tabs-remote').getByRole('tab').click();
  await expect(editor(page)).toHaveValue('远端同名聊天草稿');
  noDestructiveRequests(mock); noDestructiveRequests(remote);
});

test('fixed tabs stay first and survive a page reload without changing sidebar pins', async ({ page, mock }) => {
  add(mock, 'second-tab', '常驻聊天');
  await login(page); await open(page, '已有测试历史'); await open(page, '常驻聊天');
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.locator('.thread-menu').getByRole('button', { name: '固定标签页', exact: true }).click();
  await expect(strip(page).getByRole('tab').first()).toHaveText('常驻聊天');
  await expect(wrapper(page, 'local', 'second-tab').getByRole('button', { name: '关闭标签页：常驻聊天', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(strip(page).getByRole('tab').first()).toHaveText('常驻聊天');
  await expect(tab(page, '已有测试历史')).toHaveCount(1);
  await tab(page, '常驻聊天').click();
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.locator('.thread-menu').getByRole('button', { name: '取消固定标签页', exact: true }).click();
  await expect(page.getByRole('button', { name: '关闭标签页：常驻聊天', exact: true })).toBeVisible();
  expect(mock.preferences.pins).toEqual([]);
  noDestructiveRequests(mock);
});

test('closing running or selected tabs selects a neighboring chat without cancelling or archiving work', async ({ page, mock }) => {
  add(mock, 'second-tab', '第二条标签聊天');
  add(mock, 'third-tab', '第三条标签聊天');
  mock.threads[0]!.status = { type: 'active' };
  mock.turns.get('thread-existing')![0].status = 'inProgress';
  await login(page); await open(page, '已有测试历史'); await open(page, '第二条标签聊天'); await open(page, '第三条标签聊天');
  await page.getByRole('button', { name: '关闭标签页：已有测试历史', exact: true }).click();
  await expect(tab(page, '已有测试历史')).toHaveCount(0);
  await expect(tab(page, '第三条标签聊天')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '关闭标签页：第三条标签聊天', exact: true }).click();
  await expect(tab(page, '第二条标签聊天')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.agent-message')).toContainText('第二条标签聊天的内容');
  await page.getByRole('button', { name: '关闭标签页：第二条标签聊天', exact: true }).click();
  await expect(page.locator('.welcome')).toBeVisible();
  await expect(strip(page).getByRole('tab', { name: '新对话', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' })).toBeVisible();
  noDestructiveRequests(mock);
});

test('the new-tab button creates a draft and the first sent message replaces it with a real chat tab', async ({ page, mock }) => {
  await login(page); await open(page, '已有测试历史');
  await editor(page).fill('旧标签草稿');
  await page.getByRole('button', { name: '新建聊天标签页', exact: true }).click();
  await expect(page.locator('.welcome')).toBeVisible();
  await expect(tab(page, '新对话')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, '已有测试历史')).toHaveAttribute('aria-selected', 'false');
  await editor(page).fill('从新标签发送');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(tab(page, '新对话')).toHaveCount(0);
  await expect(strip(page).getByRole('tab')).toHaveCount(2);
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(1);
  await tab(page, '已有测试历史').click();
  await expect(editor(page)).toHaveValue('旧标签草稿');
  noDestructiveRequests(mock);
});

test('tab navigation keeps a historical reading anchor while an inactive conversation grows', async ({ page, mock }) => {
  mock.turns.set('thread-existing', Array.from({ length: 18 }, (_, index) => ({
    id: `tabs-reading-${index}`, status: 'completed', itemsView: 'full', error: null,
    items: [{ id: `tabs-reading-answer-${index}`, type: 'agentMessage', phase: 'final_answer', text: (`历史阅读 ${index}：标签切换应保持原文位置。\n\n`).repeat(6) }],
  })));
  add(mock, 'second-tab', '第二条标签聊天');
  await login(page); await open(page, '已有测试历史');
  const scroll = page.locator('.conversation-scroll');
  await scroll.evaluate(element => {
    const target = element.querySelector('[data-history-id="tabs-reading-7"]')!;
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - 30;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  const offset = () => scroll.evaluate(element => element.querySelector('[data-history-id="tabs-reading-7"]')!.getBoundingClientRect().top - element.getBoundingClientRect().top);
  const before = await offset();
  await open(page, '第二条标签聊天');
  mock.turns.get('thread-existing')![0].items[0].text += '\n\n' + '较早历史增长。\n\n'.repeat(30);
  await tab(page, '已有测试历史').click();
  await expect.poll(offset).toBeCloseTo(before, 0);
  noDestructiveRequests(mock);
});

test('keyboard tab focus does not navigate until Enter selects the focused chat', async ({ page, mock }) => {
  add(mock, 'second-tab', '第二条标签聊天'); add(mock, 'third-tab', '第三条标签聊天');
  await login(page); await open(page, '已有测试历史'); await open(page, '第二条标签聊天'); await open(page, '第三条标签聊天');
  await tab(page, '第三条标签聊天').focus();
  await page.keyboard.press('Home');
  await expect(tab(page, '已有测试历史')).toBeFocused();
  await expect(tab(page, '第三条标签聊天')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, '第二条标签聊天')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tab(page, '第二条标签聊天')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tab(page, '第三条标签聊天')).toBeFocused();
  noDestructiveRequests(mock);
});

test('mobile overflowing tabs keep the selected chat, menu and right-hand controls reachable without page overflow', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (let index = 1; index <= 5; index++) add(mock, `mobile-tab-${index}`, `移动标签聊天 ${index}`);
  await login(page); await open(page, '已有测试历史');
  for (let index = 1; index <= 5; index++) await open(page, `移动标签聊天 ${index}`);
  await expect(tab(page, '移动标签聊天 5')).toBeInViewport();
  for (const name of ['新建侧边聊天', '切换工作区', '新建聊天标签页']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  }
  await expect(page.locator('.main-header .header-host')).toHaveCount(0);
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await expect(page.locator('.thread-menu').getByRole('button', { name: '固定标签页', exact: true })).toBeVisible();
  const menu = await page.locator('.thread-menu').boundingBox();
  expect(menu!.x).toBeGreaterThanOrEqual(0); expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.data/chat-tabs-mobile.png' });
  noDestructiveRequests(mock);
});
