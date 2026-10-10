import { test, expect, login, send, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const newId = 'thread-title-new';
const heading = (page: Page) => page.locator('.main-header h1');
const titleRow = (page: Page) =>
  page.locator('[data-section="recent"] .thread-title').first();
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];

/** Real app-server starts with no name/preview; the generic fixture is named. */
function unnamedStart(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/start') return receive(socket, request);
    mock.requests.push(request);
    const thread = { ...mock.threads[0], id: newId, name: '', preview: '',
      cwd: request.params.cwd, createdAt: Math.floor(Date.now() / 1000),
      recencyAt: Math.floor(Date.now() / 1000), turns: [] };
    mock.threads.unshift(thread);
    mock.turns.set(newId, []);
    mock.emit('thread/started', { thread });
    socket.send(JSON.stringify({ id: request.id, result: { thread } }));
  };
}

test('a new conversation gets its default title from confirmed live input before generation finishes', async ({ page, mock }) => {
  unnamedStart(mock);
  mock.holdFinalMessage = true;
  mock.holdTurnStartResponse = true;
  await login(page);
  await send(page, '修复项目的新对话标题');
  await expect(heading(page)).toHaveText('修复项目的新对话标题');
  await expect(titleRow(page)).toHaveText('修复项目的新对话标题');
  await expect.poll(() => page.title()).toBe('修复项目的新对话标题 · Codex Web');
  expect(mock.request('thread/name/set')).toBeUndefined();
  mock.releaseTurnStartResponse();
  await expect(heading(page)).toHaveText('修复项目的新对话标题');
});

test('accepted turn response supplies a default title when native user-message events are absent', async ({ page, mock }) => {
  unnamedStart(mock);
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'turn/start') return receive(socket, request);
    mock.requests.push(request);
    const turn = { id: 'title-response-only', status: 'inProgress', items: [] };
    mock.turns.get(newId)!.push(turn);
    socket.send(JSON.stringify({ id: request.id, result: { turn } }));
  };
  await login(page);
  await send(page, '仅有成功响应也应显示标题');
  await expect(heading(page)).toHaveText('仅有成功响应也应显示标题');
  await expect(titleRow(page)).toHaveText('仅有成功响应也应显示标题');
  expect(mock.request('thread/name/set')).toBeUndefined();
});

test('rejected input does not become a conversation title', async ({ page, mock }) => {
  unnamedStart(mock);
  mock.failTurnStartNext = true;
  await login(page);
  await send(page, '这条消息尚未被接受');
  await expect(page.locator('.global-error')).toContainText('Test turn start failed');
  await expect(heading(page)).toHaveText('新对话');
  await expect(titleRow(page)).toHaveText('未命名对话');
  expect(mock.request('thread/name/set')).toBeUndefined();
});

test('later messages and empty metadata refreshes retain the first confirmed default title', async ({ page, mock }) => {
  unnamedStart(mock);
  await login(page);
  await send(page, '最初的会话主题');
  await expect(heading(page)).toHaveText('最初的会话主题');
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await send(page, '第二轮不应替换会话主题');
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '刷新对话', exact: true }).click();
  await expect(titleRow(page)).toHaveText('最初的会话主题');
  await expect(heading(page)).toHaveText('最初的会话主题');
  expect(mock.request('thread/name/set')).toBeUndefined();
});

test('list metadata updates the active heading without reloading history or changing a running turn', async ({ page, mock }) => {
  mock.threads[0]!.name = '';
  mock.threads[0]!.preview = '原来的预览标题';
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(heading(page)).toHaveText('原来的预览标题');
  const resumes = mock.requests.filter(request => request.method === 'thread/resume').length;
  const draft = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await draft.fill('刷新标题时保留我的草稿');
  mock.emit('turn/started', { threadId: 'thread-existing', turn: { id: 'title-active', status: 'inProgress', items: [] } });
  mock.threads[0]!.preview = '原生记录中已经存在的新标题';
  await page.getByRole('button', { name: '刷新对话', exact: true }).click();
  await expect(heading(page)).toHaveText('原生记录中已经存在的新标题');
  await expect(titleRow(page)).toHaveText('原生记录中已经存在的新标题');
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await expect(draft).toHaveValue('刷新标题时保留我的草稿');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(resumes);
});

test('an in-flight old list cannot undo a native rename', async ({ page, mock }) => {
  mock.threads[0]!.name = '';
  mock.threads[0]!.preview = '原来的默认标题';
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(heading(page)).toHaveText('原来的默认标题');
  const receive = (mock as any).receive.bind(mock);
  const replies: (() => void)[] = [];
  let release: (() => void) | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/list') return receive(socket, request);
    mock.requests.push(request);
    const snapshot = structuredClone(mock.threads);
    replies.push(() => socket.send(JSON.stringify({ id: request.id, result: { data: snapshot, nextCursor: null } })));
    release = () => replies.splice(0).forEach(reply => reply());
  };
  await page.getByRole('button', { name: '刷新对话', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  mock.emit('thread/name/updated', { threadId: 'thread-existing', threadName: '用户刚刚重命名的标题' });
  await expect(heading(page)).toHaveText('用户刚刚重命名的标题');
  release!();
  await expect(titleRow(page)).toHaveText('用户刚刚重命名的标题');
  await expect(heading(page)).toHaveText('用户刚刚重命名的标题');
});

test('accepted input updates the observing Web page title and preserves its draft', async ({ page, context, mock }) => {
  mock.threads[0]!.name = '';
  mock.threads[0]!.preview = '';
  mock.turns.set('thread-existing', []);
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(heading(page)).toHaveText('新对话');
  const other = await context.newPage();
  await mock.install(other);
  await other.goto('/');
  await expect(other.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  const draft = other.getByRole('textbox', { name: '消息输入框', exact: true });
  await draft.fill('另一个网页未发送的草稿');
  const turn = { id: 'title-other-web', status: 'inProgress', items: [] };
  mock.emit('bridge/thread/changed', { threadId: 'thread-existing', method: 'turn/start', changeId: 'title-web:1',
    result: { turn }, request: { input: input('来自其他网页的首条已接受消息'), clientUserMessageId: 'title-client' } });
  for (const target of [page, other]) {
    await expect(heading(target)).toHaveText('来自其他网页的首条已接受消息');
    await expect(titleRow(target)).toHaveText('来自其他网页的首条已接受消息');
  }
  await expect(draft).toHaveValue('另一个网页未发送的草稿');
  expect(mock.request('thread/name/set')).toBeUndefined();
  await other.close();
});

test('live runtime updates do not hide a newer canonical title read from the list', async ({ page, mock }) => {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(heading(page)).toHaveText('已有测试历史');
  const receive = (mock as any).receive.bind(mock);
  const replies: (() => void)[] = [];
  let release: (() => void) | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/list') return receive(socket, request);
    mock.requests.push(request);
    const snapshot = structuredClone(mock.threads);
    snapshot[0]!.name = '列表读取到的新名称';
    replies.push(() => socket.send(JSON.stringify({ id: request.id, result: { data: snapshot, nextCursor: null } })));
    release = () => replies.splice(0).forEach(reply => reply());
  };
  await page.getByRole('button', { name: '刷新对话', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  mock.emit('turn/started', { threadId: 'thread-existing', turn: { id: 'title-racing-turn', status: 'inProgress', items: [] } });
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  release!();
  await expect(heading(page)).toHaveText('列表读取到的新名称');
  await expect(titleRow(page)).toHaveText('列表读取到的新名称');
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
});

test('a late resume response cannot undo the newer title already fetched by the list', async ({ page, mock }) => {
  await login(page);
  const receive = (mock as any).receive.bind(mock);
  let release: (() => void) | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/resume') return receive(socket, request);
    mock.requests.push(request);
    const snapshot = structuredClone(mock.threads[0]);
    release = () => socket.send(JSON.stringify({ id: request.id, result: {
      thread: snapshot, model: mock.config.model, reasoningEffort: 'medium', sandbox: { type: 'workspaceWrite' },
    } }));
  };
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect.poll(() => !!release).toBe(true);
  mock.threads[0]!.name = '恢复过程中读到的新标题';
  await page.getByRole('button', { name: '刷新对话', exact: true }).click();
  await expect(heading(page)).toHaveText('恢复过程中读到的新标题');
  release!();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await expect(heading(page)).toHaveText('恢复过程中读到的新标题');
  await expect(titleRow(page)).toHaveText('恢复过程中读到的新标题');
});

test('a late resume response cannot undo a newer preview when there is no explicit name', async ({ page, mock }) => {
  mock.threads[0]!.name = '';
  mock.threads[0]!.preview = '恢复开始时的默认标题';
  await login(page);
  const receive = (mock as any).receive.bind(mock);
  let release: (() => void) | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/resume') return receive(socket, request);
    mock.requests.push(request);
    const snapshot = structuredClone(mock.threads[0]);
    release = () => socket.send(JSON.stringify({ id: request.id, result: {
      thread: snapshot, model: mock.config.model, reasoningEffort: 'medium', sandbox: { type: 'workspaceWrite' },
    } }));
  };
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect.poll(() => !!release).toBe(true);
  mock.threads[0]!.preview = '列表已经读到的新版默认标题';
  await page.getByRole('button', { name: '刷新对话', exact: true }).click();
  await expect(heading(page)).toHaveText('列表已经读到的新版默认标题');
  release!();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await expect(heading(page)).toHaveText('列表已经读到的新版默认标题');
  await expect(titleRow(page)).toHaveText('列表已经读到的新版默认标题');
});

test('editing the only message replaces its default preview after an acknowledged empty revert', async ({ page, mock }) => {
  unnamedStart(mock);
  await login(page);
  await send(page, '首轮编辑前的标题');
  await expect(heading(page)).toHaveText('首轮编辑前的标题');
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑消息内容', exact: true }).fill('首轮编辑后的新标题');
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑消息内容', exact: true })).toHaveCount(0);
  await expect(heading(page)).toHaveText('首轮编辑后的新标题');
  await expect(titleRow(page)).toHaveText('首轮编辑后的新标题');
  expect(mock.request('thread/revert')?.params.threadId).toBe(newId);
  expect(mock.request('thread/name/set')).toBeUndefined();
});

test('a named conversation keeps its canonical title when new input is accepted', async ({ page, mock }) => {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await send(page, '后续输入不能覆盖用户指定的标题');
  await expect(page.getByText('流式回复完成 ✅', { exact: true })).toBeVisible();
  await expect(heading(page)).toHaveText('已有测试历史');
  await expect(titleRow(page)).toHaveText('已有测试历史');
  expect(mock.request('thread/name/set')).toBeUndefined();
});
