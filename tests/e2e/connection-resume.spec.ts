import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

async function foreground(page: Page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('resume'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new Event('focus'));
  });
}
function missedTurn(mock: MockCodex) {
  mock.turns.get('thread-existing')!.push({
    id: 'completed-in-background', status: 'completed',
    items: [{ id: 'background-answer', type: 'agentMessage', text: '后台完成的结果已恢复' }],
  });
}

test('foreground events share one health check and recover history without reconnecting a healthy socket', async ({ page, mock }) => {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('返回前台后保留草稿');
  missedTurn(mock);
  await foreground(page);
  await expect(page.locator('.agent-message').last()).toHaveText('后台完成的结果已恢复');
  expect(mock.sockets).toHaveLength(1);
  expect(mock.requests.filter(request => request.method === 'thread/loaded/list')).toHaveLength(1);
  await expect(input).toHaveValue('返回前台后保留草稿');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a socket that stays OPEN but stops answering is replaced automatically without submitting the draft', async ({ page, mock }) => {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('只恢复连接，不提交草稿');
  mock.unresponsiveSockets.add(mock.sockets[0]!);
  missedTurn(mock);
  await foreground(page);
  await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2);
  await expect(page.locator('.agent-message').last()).toHaveText('后台完成的结果已恢复');
  await expect(input).toHaveValue('只恢复连接，不提交草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a fresh app window restores the host, project, chat and draft without logging in again', async ({ page, context, mock }) => {
  const remote = new MockCodex();
  remote.threads[0].name = '远程重进测试';
  remote.threads[0].cwd = '/workspace/mobile-project';
  remote.turns.get('thread-existing')![0].items[1].text = '远程对话仍在';
  mock.hosts.push({ id: 'ssh-test', name: 'Remote', kind: 'ssh', cwd: '/workspace/demo' });
  mock.hostMocks.set('ssh-test', remote);
  await page.addInitScript(() => {
    localStorage.setItem('codex.hostId', JSON.stringify('ssh-test'));
    sessionStorage.setItem('codex.draft.ssh-test.thread-existing', '旧版窗口草稿');
  });
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '远程重进测试' }).first().click();
  await expect(page.locator('.agent-message').last()).toHaveText('远程对话仍在');
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('旧版窗口草稿');
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('退出应用后继续编辑');
  await page.close();
  const reopened = await context.newPage();
  await mock.install(reopened);
  await reopened.goto('/');
  await expect(reopened.locator('.header-host')).toHaveText('Remote');
  await expect(reopened.locator('.agent-message').last()).toHaveText('远程对话仍在');
  await expect(reopened.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('退出应用后继续编辑');
  await expect(reopened.getByRole('textbox', { name: '访问密码' })).toHaveCount(0);
  expect(remote.request('config/read')?.params.cwd).toBe('/workspace/mobile-project');
  expect(remote.request('turn/start')).toBeUndefined();
});

test('a stale foreground check cannot replace a host chosen while it was waiting', async ({ page, mock }) => {
  const remote = new MockCodex();
  remote.threads[0].name = '切换到远程';
  remote.turns.get('thread-existing')![0].items[1].text = '远程选择保持不变';
  mock.hosts.push({ id: 'ssh-test', name: 'Remote', kind: 'ssh', cwd: '/workspace/demo' });
  mock.hostMocks.set('ssh-test', remote);
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').click();
  mock.unresponsiveSockets.add(mock.sockets[0]!);
  await foreground(page);
  await expect.poll(() => !!mock.request('thread/loaded/list')).toBe(true);
  await page.locator('[data-section="recent"] [data-host-id="ssh-test"] .thread-row').click();
  await expect(page.locator('.agent-message').last()).toHaveText('远程选择保持不变');
  await expect(page.locator('.header-host')).toHaveText('Remote');
  expect(mock.sockets).toHaveLength(1);
  expect(remote.sockets).toHaveLength(1);
  expect(remote.request('turn/start')).toBeUndefined();
});
