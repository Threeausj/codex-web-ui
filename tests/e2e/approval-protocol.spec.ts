import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const threadId = 'thread-existing', turnId = 'turn-history';
function deliver(mock: MockCodex, request: any) {
  for (const socket of mock.sockets) socket.send(JSON.stringify(request));
}
async function open(page: Page) {
  if (page.viewportSize()!.width < 700) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
}
function approval(mock: MockCodex, params: any = {}, method = 'item/commandExecution/requestApproval') {
  deliver(mock, { id: 'review', method, params: { threadId, turnId, ...params } });
}

test('service callbacks and unsupported client tool requests never become approval cards, including reconnect state', async ({ page, mock }) => {
  await login(page); await open(page);
  const requests = [
    { id: 'clock', method: 'currentTime/read', params: { threadId } },
    { id: 'tool', method: 'item/tool/call', params: { threadId, turnId, tool: 'desktop-tool', arguments: {} } },
    { id: 'attest', method: 'attestation/generate', params: {} },
  ];
  for (const request of requests) deliver(mock, request);
  approval(mock, { command: 'printf real-review' });
  await expect(page.locator('.approval-card')).toHaveCount(1);
  await expect(page.locator('.approval-card')).toContainText('printf real-review');
  mock.emit('bridge/status', { connected: true, pendingRequests: [...requests, { id: 'real', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'printf restored-review' } }] });
  await expect(page.locator('.approval-card')).toHaveCount(1);
  await expect(page.locator('.approval-card')).toContainText('printf restored-review');
});

test('a command approval with omitted command fields uses the matching streamed item', async ({ page, mock }) => {
  await login(page); await open(page);
  mock.emit('item/started', { threadId, turnId, item: { id: 'operation', type: 'commandExecution', command: 'printf linked-operation', cwd: '/workspace/demo', status: 'inProgress' } });
  approval(mock, { itemId: 'operation', command: null, reason: null });
  const card = page.getByRole('region', { name: '批准命令执行' });
  await expect(card).toContainText('printf linked-operation');
  await expect(card).toContainText('/workspace/demo');
  await expect(card).not.toContainText('未提供此操作');
  await card.getByRole('button', { name: '允许一次', exact: true }).click();
  expect(mock.responses.at(-1)).toMatchObject({ id: 'review', result: { decision: 'accept' } });
});

test('reconnected approval previews survive summary history and never borrow another turn’s item', async ({ page, mock }) => {
  await login(page); await open(page);
  mock.emit('item/started', { threadId, turnId: 'unrelated', item: { id: 'operation', type: 'commandExecution', command: 'wrong operation', cwd: '/wrong' } });
  approval(mock, { itemId: 'operation', bridgeApprovalContext: { command: 'printf retained-preview', cwd: '/workspace/demo' } });
  const card = page.getByRole('region', { name: '批准命令执行' });
  await expect(card).toContainText('printf retained-preview'); await expect(card).not.toContainText('wrong operation');
  mock.emit('serverRequest/resolved', { requestId: 'review', threadId });
  approval(mock, { itemId: 'operation' });
  await expect(card).toContainText('未提供此操作的详细内容');
  await expect(card).not.toContainText('wrong operation');
});

test('phone network approvals explain the destination even without a shell command', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  mock.preferences.defaultPermission = 'danger-full-access';
  await login(page); await open(page);
  expect(mock.request('thread/resume')?.params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' });
  approval(mock, { networkApprovalContext: { host: 'approval-target.example:443', protocol: 'https' }, command: null });
  const card = page.getByRole('region', { name: '批准网络访问' });
  await expect(card).toContainText('https · approval-target.example:443');
  await expect(card).not.toContainText('未提供此操作');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('file approvals show affected paths and terminal-input requests identify their action', async ({ page, mock }) => {
  await login(page); await open(page);
  approval(mock, { itemId: 'patch', bridgeApprovalContext: { filePaths: ['src/app.ts', 'README.md'] } }, 'item/fileChange/requestApproval');
  await expect(page.getByRole('region', { name: '批准文件修改' })).toContainText('src/app.ts');
  mock.emit('serverRequest/resolved', { requestId: 'review', threadId });
  approval(mock, { kind: 'writeStdin' });
  await expect(page.getByRole('region', { name: '批准终端输入' })).toContainText('向运行中的终端发送输入');
});

test('legacy approvals display argv and return the legacy decision schema', async ({ page, mock }) => {
  await login(page); await open(page);
  deliver(mock, { id: 'legacy', method: 'execCommandApproval', params: { conversationId: threadId, callId: 'cmd', command: ['printf', 'review me'], cwd: '/workspace/demo' } });
  const card = page.getByRole('region', { name: '批准命令执行' });
  await expect(card).toContainText('printf "review me"');
  await card.getByRole('button', { name: '允许一次', exact: true }).click();
  expect(mock.responses.at(-1)).toMatchObject({ id: 'legacy', result: { decision: 'approved' } });
});
