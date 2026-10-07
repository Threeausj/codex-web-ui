import { test, expect, login, type MockCodex } from './fixtures';
import type { Page, WebSocketRoute } from '@playwright/test';

const threadId = 'thread-existing';
const running = { id: 'native-running', status: 'inProgress', items: [{ id: 'running-user', type: 'userMessage', content: [{ type: 'text', text: '当前任务', text_elements: [] }] }] };
const queued = (id: string, text: string) => ({ id, clientUserMessageId: `client-${id}`, input: [{ type: 'text', text, text_elements: [] }] });
async function install(page: Page, mock: MockCodex, supported = true, shared?: { items: any[]; uncertain: boolean; failNext: boolean }) {
  const fields: Record<string, string[]> = {
    add: ['threadId', 'input', 'clientUserMessageId'], list: ['threadId', 'limit', 'cursor'],
    update: ['threadId', 'queuedSubmissionId', 'input'], delete: ['threadId', 'queuedSubmissionId'],
    reorder: ['threadId', 'queuedSubmissionIds'], start: ['threadId', 'queuedSubmissionId'],
  };
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: {
    status: 'known', checkedAt: Date.now(), methods: { ...Object.fromEntries(Object.entries(fields).map(([name, params]) =>
      [`thread/queue/${name}`, { available: supported, params, required: ['threadId'] }])), 'thread/settings/update': { available: supported, params: ['threadId','cwd','model','effort','sandboxPolicy','approvalPolicy','collaborationMode'], required: ['threadId'] } },
  } }));
  if (!(mock.turns.get(threadId) || []).some(turn => turn.id === running.id))
    mock.turns.set(threadId, [...(mock.turns.get(threadId) || []), running]);
  const queue = shared || { items: [] as any[], uncertain: false, failNext: false };
  const original = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: WebSocketRoute, request: any) => {
    if (!request.method.startsWith('thread/queue/')) return original(socket, request);
    mock.requests.push(request);
    const p = request.params;
    const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }));
    if (request.method === 'thread/queue/list') return reply({ data: queue.items, nextCursor: null });
    if (queue.failNext) { queue.failNext = false; return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: 'Test queue failure' } })); }
    if (request.method === 'thread/queue/add') {
      if (queue.uncertain) return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: 'Queue acknowledgement lost', data: { uncertain: true } } }));
      const item = { ...queued(`q-${queue.items.length}`, ''), clientUserMessageId: p.clientUserMessageId, input: p.input };
      queue.items.push(item); mock.emit('thread/queue/changed', { threadId }); return reply({ queuedSubmission: item });
    }
    if (request.method === 'thread/queue/update') {
      queue.items = queue.items.map(item => item.id === p.queuedSubmissionId ? { ...item, input: p.input } : item);
      mock.emit('thread/queue/changed', { threadId }); return reply({ queuedSubmission: queue.items.find(item => item.id === p.queuedSubmissionId) });
    }
    if (request.method === 'thread/queue/reorder') {
      queue.items = p.queuedSubmissionIds.map((id: string) => queue.items.find(item => item.id === id));
      mock.emit('thread/queue/changed', { threadId }); return reply({});
    }
    if (request.method === 'thread/queue/delete') {
      queue.items = queue.items.filter(item => item.id !== p.queuedSubmissionId);
      mock.emit('thread/queue/changed', { threadId }); return reply({});
    }
    if (request.method === 'thread/queue/start') {
      const item = queue.items.find(item => item.id === p.queuedSubmissionId);
      queue.items = queue.items.filter(item => item.id !== p.queuedSubmissionId);
      const turn = { id: 'queued-complete', status: 'completed', items: [
        { id: 'queued-user', type: 'userMessage', clientId: item.clientUserMessageId, content: item.input },
        { id: 'queued-answer', type: 'agentMessage', text: '队列任务已完成' },
      ] };
      mock.turns.set(threadId, [...(mock.turns.get(threadId) || []), turn]);
      mock.emit('turn/completed', { threadId, turn }); mock.emit('thread/queue/changed', { threadId });
      return reply({ turn: { ...turn, status: 'inProgress' } });
    }
    return reply({});
  };
  return queue;
}
async function open(page: Page) {
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.getByRole('combobox', { name: '消息发送方式' })).toBeVisible();
}

test('a busy composer explicitly chooses native next-turn delivery; accepted input and attachment move into the queue', async ({ page, mock }) => {
  const queue = await install(page, mock); await login(page); await open(page);
  await expect(page.getByRole('combobox', { name: '消息发送方式' })).toHaveValue('immediate');
  await expect.poll(() => mock.requests.some(request => request.method === 'thread/queue/list')).toBe(true);
  await page.getByRole('combobox', { name: '消息发送方式' }).selectOption('queue');
  await page.getByRole('textbox', { name: '消息输入框' }).fill('下一轮查看图片');
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: Buffer.from('PNG') });
  await expect(page.getByText('sample.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加入下一轮队列', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('');
  expect(queue.items[0].input.map((input: any) => input.type)).toEqual(['text', 'localImage', 'text']);
  expect(mock.requests.some(request => request.method === 'turn/start' || request.method === 'turn/steer')).toBe(false);
  await page.getByRole('button', { name: /运行中 · 下一轮队列 1/ }).click();
  await expect(page.locator('.queue-prompt')).toContainText('下一轮查看图片');
  await page.getByRole('button', { name: '编辑排队消息', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑排队消息' }).fill('下一轮检查图片内容');
  await page.getByRole('button', { name: '保存消息', exact: true }).click();
  await expect(page.locator('.queue-prompt')).toContainText('下一轮检查图片内容');
  expect(queue.items[0].input[1].type).toBe('localImage');
  expect(queue.items[0].input[2].text).toContain('/test/uploads/notes.txt');
});

test('queue order synchronizes across browsers and preserves each browser composer draft', async ({ page, mock, context }) => {
  const queue = await install(page, mock); queue.items = [queued('first', '第一个排队任务'), queued('second', '第二个排队任务')];
  await login(page); await open(page);
  const other = await context.newPage(); await mock.install(other); await install(other, mock, true, queue);
  await other.goto('/'); await open(other);
  await page.getByRole('button', { name: /运行中 · 下一轮队列 2/ }).click();
  await other.getByRole('button', { name: /运行中 · 下一轮队列 2/ }).click();
  await other.getByRole('textbox', { name: '消息输入框' }).fill('另一端保留的草稿');
  await page.getByRole('button', { name: '下移排队消息', exact: true }).first().click();
  await expect(other.locator('.queue-prompt').first()).toContainText('第二个排队任务');
  await expect(other.getByRole('textbox', { name: '消息输入框' })).toHaveValue('另一端保留的草稿');
  await page.getByRole('button', { name: '删除排队消息', exact: true }).first().click();
  await expect(other.locator('.queue-prompt')).toHaveCount(1);
  await expect(other.locator('.queue-prompt')).toContainText('第一个排队任务');
});

test('unsupported native queue advertises the reason and never sends a fake queue probe or starts a turn', async ({ page, mock }) => {
  await install(page, mock, false); await login(page); await open(page);
  await page.getByRole('button', { name: /运行中 · 下一轮队列 0/ }).click();
  await expect(page.getByText(/此主机的 Codex 不支持当前原生消息队列协议/)).toBeVisible();
  await expect(page.locator('select[aria-label="消息发送方式"] option[value="queue"]')).toHaveJSProperty('disabled', true);
  expect(mock.requests.some(request => request.method.startsWith('thread/queue/'))).toBe(false);
  expect(mock.requests.some(request => request.method === 'turn/start')).toBe(false);
});

test('queue failure preserves the draft, and an unknown outcome blocks blind duplicate delivery', async ({ page, mock }) => {
  const queue = await install(page, mock); await login(page); await open(page);
  await expect.poll(() => mock.requests.some(request => request.method === 'thread/queue/list')).toBe(true);
  await page.getByRole('combobox', { name: '消息发送方式' }).selectOption('queue');
  await page.getByRole('textbox', { name: '消息输入框' }).fill('必须保留的排队草稿');
  queue.uncertain = true;
  await page.getByRole('button', { name: '加入下一轮队列', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('必须保留的排队草稿');
  await expect(page.locator('.queue-notice')).toContainText('已保留草稿，不会自动重复提交');
  await page.getByRole('combobox', { name: '消息发送方式' }).selectOption('immediate');
  await expect(page.getByRole('button', { name: '追加指令', exact: true })).toHaveCount(0);
  expect(mock.requests.filter(request => request.method === 'thread/queue/add')).toHaveLength(1);
  await page.getByRole('button', { name: '已核对，恢复发送' }).click();
  await expect(page.getByRole('button', { name: '追加指令', exact: true })).toBeEnabled();
});

test('busy tasks cannot be interrupted by queue start; late native start acknowledgement cannot revive a completed task', async ({ page, mock }) => {
  const queue = await install(page, mock); queue.items = [queued('next', '等待启动')];
  await login(page); await open(page);
  await page.getByRole('button', { name: /运行中 · 下一轮队列 1/ }).click();
  await expect(page.getByRole('button', { name: '立即启动', exact: true })).toBeDisabled();
  mock.emit('turn/completed', { threadId, turn: { ...running, status: 'completed' } });
  await expect(page.getByRole('button', { name: '立即启动', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '立即启动', exact: true }).click();
  await expect(page.getByText('队列任务已完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  expect(queue.items).toHaveLength(0);
});
