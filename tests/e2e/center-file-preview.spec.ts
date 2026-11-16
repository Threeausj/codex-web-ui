import { test, expect, login, editSource, MockCodex } from './fixtures';
import type { Locator, Page } from '@playwright/test';

const root = '/workspace/demo';
const readme = `${root}/README.md`;
const html = `${root}/index.html`;
type Request = { id: string | number; method: string; params?: any };

function files(mock: MockCodex, values: Record<string, string>) {
  const receive = (mock as any).receive.bind(mock);
  const writes: { path: string; text: string }[] = [];
  (mock as any).receive = (socket: { send: (raw: string) => void }, request: Request) => {
    const path = request.params?.path;
    if (request.method === 'fs/readFile' && Object.hasOwn(values, path)) {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, result: { dataBase64: Buffer.from(values[path]!).toString('base64') } }));
    }
    if (request.method === 'fs/writeFile') {
      mock.requests.push(request);
      const text = Buffer.from(request.params.dataBase64, 'base64').toString('utf8');
      writes.push({ path, text }); values[path] = text;
      return socket.send(JSON.stringify({ id: request.id, result: {} }));
    }
    return receive(socket, request);
  };
  return { writes };
}
async function openConversation(page: Page, title = '已有测试历史', hostId = 'local') {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"] .thread-row`).filter({ hasText: title }).first().click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
}
async function openFiles(page: Page) {
  const workspace = page.getByRole('button', { name: '切换工作区', exact: true });
  if (!await page.locator('.workspace-tabs').isVisible()) await workspace.click();
  await page.locator('.workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
}
async function inCenter(element: Locator) {
  await expect(element).toBeVisible();
  expect(await element.evaluate(element => !!element.closest('.main-column') && !element.closest('.workspace-panel'))).toBe(true);
}
const chatTab = (page: Page, title = '已有测试历史') => page.getByRole('tab', { name: title, exact: true });
const fileTab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

for (const width of [1440, 390]) test(`${width}px: conversation links and existing file tabs preview in the center without opening the workspace sidebar`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 900 });
  mock.turns.get('thread-existing')![0].items[1].text = `[阅读文档](${readme}) [查看源码](${html}:1)`;
  files(mock, { [readme]: '# Center-only document\n\n从聊天打开文件不应弹出工作区侧栏。', [html]: '<h1>Center-only source</h1>' });
  await login(page); await openConversation(page);
  const workspace = page.locator('#workspace-panel');
  await expect(workspace).toBeHidden();
  await page.evaluate(() => {
    const visibleFrames: boolean[] = [];
    (window as any).centerPreviewSidebarFrames = visibleFrames;
    (window as any).stopCenterPreviewSidebarFrames = false;
    const sample = () => {
      if ((window as any).stopCenterPreviewSidebarFrames) return;
      const panel = document.querySelector<HTMLElement>('#workspace-panel');
      visibleFrames.push(!!panel?.getClientRects().length && getComputedStyle(panel).visibility !== 'hidden');
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole('link', { name: '阅读文档', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Markdown 文件预览' });
  await inCenter(preview);
  await expect(preview.getByRole('heading', { name: 'Center-only document', exact: true })).toBeVisible();
  await expect(workspace).toBeHidden();
  await expect(fileTab(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
  await chatTab(page).click();
  await page.getByRole('link', { name: '查看源码', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'index.html 文件内容', exact: true });
  await inCenter(source);
  await expect(page.locator('.file-editor-footer')).toContainText('定位第 1 行');
  await expect(workspace).toBeHidden();
  await chatTab(page).click();
  await fileTab(page, 'README.md').click();
  await inCenter(preview);
  await expect(workspace).toBeHidden();
  await fileTab(page, 'index.html').click();
  await inCenter(source);
  await expect(workspace).toBeHidden();
  // Sample through the two following paint frames so a transient drawer flash
  // is caught even when preview readiness precedes its next layout.
  const panelFrames = await page.evaluate(() => new Promise<boolean[]>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    (window as any).stopCenterPreviewSidebarFrames = true;
    resolve((window as any).centerPreviewSidebarFrames);
  }))));
  expect(panelFrames.length).toBeGreaterThan(0);
  expect(panelFrames.some(Boolean), 'opening a chat file or existing file tab must not flash the workspace sidebar').toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(mock.request('turn/start')).toBeUndefined();
});

for (const width of [1440, 390]) test(`${width}px: a side-chat file link opens the center preview without revealing the workspace sidebar`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 900 });
  const sideId = 'center-file-side-branch';
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: { send: (raw: string) => void }, request: Request) => {
    if (request.method === 'thread/fork' && request.params?.ephemeral) {
      mock.requests.push(request);
      mock.turns.set(sideId, []);
      return socket.send(JSON.stringify({ id: request.id, result: {
        thread: { ...mock.threads[0], id: sideId, ephemeral: true, forkedFromId: 'thread-existing', turns: [] },
        model: mock.config.model, reasoningEffort: 'medium', sandbox: { type: 'readOnly' },
      } }));
    }
    return receive(socket, request);
  };
  files(mock, { [readme]: '# Side-chat document' });
  mock.holdFinalMessage = true;
  await login(page); await openConversation(page);
  await page.getByRole('button', { name: '新建侧边聊天', exact: true }).click();
  await page.getByRole('textbox', { name: '基于当前对话提问', exact: true }).fill('给出文件链接');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect.poll(() => mock.turns.get(sideId)?.length || 0).toBeGreaterThan(0);
  const turn = mock.turns.get(sideId)!.at(-1)!;
  mock.emit('item/completed', { threadId: sideId, turnId: turn.id, item: {
    id: 'center-side-file-answer', type: 'agentMessage', text: `[侧边文件](${readme})`,
  } });
  const side = page.locator('#side-chat-panel');
  await side.getByRole('link', { name: '侧边文件', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Markdown 文件预览' });
  await inCenter(preview);
  await expect(preview.getByRole('heading', { name: 'Side-chat document', exact: true })).toBeVisible();
  await expect(side).toBeHidden();
  await expect(page.locator('#workspace-panel')).toBeHidden();
  await expect(fileTab(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
  expect(mock.requests.filter(request => request.method === 'turn/interrupt')).toEqual([]);
});

for (const width of [1440, 390]) test(`${width}px: opening a workspace file uses the middle column and switching back retains the chat draft`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 900 });
  files(mock, { [readme]: '# Middle column document\n\n内容应显示在聊天同级的中间栏。' });
  await login(page); await openConversation(page);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('文件查看前尚未发送的聊天草稿');
  await openFiles(page);
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  const preview = page.getByRole('region', { name: 'Markdown 文件预览' });
  await inCenter(preview);
  await expect(preview.getByRole('heading', { name: 'Middle column document', exact: true })).toBeVisible();
  await expect(fileTab(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
  if (width > 760) {
    await expect(page.locator('.workspace-panel .file-tree-row').filter({ hasText: 'README.md' })).toBeVisible();
    const [documentBox, directoryBox] = await Promise.all([preview.boundingBox(), page.locator('.workspace-panel').boundingBox()]);
    expect(documentBox!.x + documentBox!.width).toBeLessThanOrEqual(directoryBox!.x + 1);
  } else {
    await expect(fileTab(page, 'README.md')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.screenshot({ path: `.data/center-file-preview-${width > 760 ? 'desktop' : 'mobile'}.png` });
  await chatTab(page).click();
  await expect(input).toBeVisible(); await expect(input).toHaveValue('文件查看前尚未发送的聊天草稿');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await fileTab(page, 'README.md').click(); await inCenter(preview);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('phone browser back returns from the middle preview to the chat without losing the open file', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  files(mock, { [readme]: '# A mobile file' });
  await login(page); await openConversation(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('返回后保留的草稿');
  await openFiles(page);
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  const preview = page.getByRole('region', { name: 'Markdown 文件预览' });
  await inCenter(preview);
  await page.evaluate(() => history.back());
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('返回后保留的草稿');
  await expect(preview).toBeHidden();
  await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
  await fileTab(page, 'README.md').click();
  await inCenter(preview);
  await expect(preview.getByRole('heading', { name: 'A mobile file', exact: true })).toBeVisible();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('middle-column previews retain historical reading and follow new output when the chat was at the latest answer', async ({ page, mock }) => {
  mock.threads[0]!.status = { type: 'active' };
  const turns = Array.from({ length: 18 }, (_, index) => ({
    id: `center-reading-${index}`, status: index === 17 ? 'inProgress' : 'completed', itemsView: 'full', error: null,
    items: [{ id: `center-answer-${index}`, type: 'agentMessage', phase: index === 17 ? 'commentary' : 'final_answer',
      text: (`阅读位置 ${index}：查看文件后应保留原文位置。\n\n`).repeat(6) }],
  }));
  mock.turns.set('thread-existing', turns);
  files(mock, { [readme]: '# Read while the task runs' });
  await login(page); await openConversation(page); await openFiles(page);
  const scroll = page.locator('.conversation-scroll');
  const gap = () => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await scroll.evaluate(element => {
    const anchor = element.querySelector('[data-history-id="center-reading-6"]')!;
    element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - 32;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  const offset = () => scroll.evaluate(element => element.querySelector('[data-history-id="center-reading-6"]')!.getBoundingClientRect().top - element.getBoundingClientRect().top);
  const before = await offset();
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await inCenter(page.getByRole('region', { name: 'Markdown 文件预览' }));
  const sockets = mock.sockets.length;
  const append = (delta: string) => {
    turns[17]!.items[0]!.text += delta;
    mock.emit('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'center-reading-17', itemId: 'center-answer-17', delta });
  };
  append('\n\n查看文件期间继续输出。');
  await chatTab(page).click();
  await expect.poll(offset).toBeCloseTo(before, 0);
  await page.getByRole('button', { name: '跳到最新消息', exact: true }).click();
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await expect(page.locator('.agent-message').last()).toContainText('查看文件期间继续输出。');
  await fileTab(page, 'README.md').click();
  append('\n\n' + '从最新位置打开文件时保持跟随。\n\n'.repeat(40));
  await chatTab(page).click();
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await expect(page.locator('.agent-message').last()).toContainText('从最新位置打开文件时保持跟随。');
  expect(mock.sockets).toHaveLength(sockets);
  expect(mock.requests.filter(request => ['turn/start', 'turn/interrupt', 'thread/unsubscribe'].includes(request.method || ''))).toEqual([]);
});

test('middle-column file tabs preserve edits and closing the last file returns to the same conversation', async ({ page, mock }) => {
  const fixture = files(mock, { [readme]: '# Original markdown', [html]: '<h1>Original HTML</h1>' });
  await login(page); await openConversation(page); await openFiles(page);
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await page.locator('.file-view-switch').getByRole('button', { name: '源码', exact: true }).click();
  await editSource(page, 'README.md 文件内容', '# Retained editor draft\n尚未写入磁盘');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '关闭文件 README.md', exact: true }).click();
  await expect(fileTab(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.workspace-panel .workspace-tabs').getByRole('button', { name: '终端', exact: true }).click();
  await inCenter(page.getByRole('textbox', { name: 'README.md 文件内容', exact: true }));
  await page.locator('.workspace-panel .workspace-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('button', { name: '上一级目录', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue('/workspace');
  await expect(page.getByRole('textbox', { name: 'README.md 文件内容', exact: true })).toContainText('Retained editor draft');
  await page.getByRole('textbox', { name: '目录路径', exact: true }).fill(root);
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await page.locator('.workspace-panel .file-tree-row').filter({ hasText: 'index.html' }).click();
  await inCenter(page.getByRole('textbox', { name: 'index.html 文件内容', exact: true }));
  await fileTab(page, 'README.md').click();
  await expect(page.getByRole('textbox', { name: 'README.md 文件内容', exact: true })).toHaveText('# Retained editor draft\n尚未写入磁盘', { useInnerText: true });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => fixture.writes).toEqual([{ path: readme, text: '# Retained editor draft\n尚未写入磁盘' }]);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载文件', exact: true }).click();
  const download = await pending; const url = new URL(download.url());
  expect(url.pathname).toBe('/api/hosts/local/download'); expect(url.searchParams.get('path')).toBe(readme);
  await page.getByRole('button', { name: '关闭文件 README.md', exact: true }).click();
  await expect(fileTab(page, 'index.html')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '关闭文件 index.html', exact: true }).click();
  await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a source-line file link opens in the middle and adding its selection returns to the chat composer', async ({ page, mock }) => {
  mock.turns.get('thread-existing')![0].items[1].text = '[引用第二行](/workspace/demo/README.md:2)';
  files(mock, { [readme]: '# Source file\nconst selectedLine = true;\n第三行' });
  await login(page); await openConversation(page);
  await page.getByRole('link', { name: '引用第二行', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'README.md 文件内容', exact: true });
  await inCenter(editor); await expect(page.locator('.file-editor-footer')).toContainText('定位第 2 行');
  await page.locator('.code-selection-toolbar').getByRole('button', { name: '添加到对话', exact: true }).click();
  await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.composer-quote')).toContainText('README.md');
  await expect(page.locator('.composer-quote')).toContainText('const selectedLine = true;');
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeVisible();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('changing host hides the old middle preview and never reads its file path on the new host', async ({ page, mock }) => {
  const remote = new MockCodex();
  remote.threads[0] = { ...remote.threads[0], name: 'Remote conversation', preview: 'Remote conversation', cwd: '/remote/project' };
  mock.hosts.push({ id: 'host-center-preview', name: 'Remote host', kind: 'ssh', hostname: 'fixture.invalid', cwd: '/remote/project' });
  mock.hostMocks.set('host-center-preview', remote);
  files(mock, { [readme]: '# Local middle file' });
  files(remote, { '/remote/project/README.md': '# Remote middle file' });
  await login(page); await openConversation(page); await openFiles(page);
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await expect(page.getByRole('heading', { name: 'Local middle file', exact: true })).toBeVisible();
  await openConversation(page, 'Remote conversation', 'host-center-preview');
  await expect(page.getByRole('heading', { name: 'Local middle file', exact: true })).toBeHidden();
  await expect(page.getByRole('textbox', { name: '目录路径', exact: true })).toHaveValue('/remote/project');
  expect(remote.requests.filter(request => request.method?.startsWith('fs/') && request.params?.path?.startsWith(root))).toEqual([]);
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await inCenter(page.getByRole('region', { name: 'Markdown 文件预览' }));
  await expect(page.getByRole('heading', { name: 'Remote middle file', exact: true })).toBeVisible();
  await expect(page.locator('.global-error, .workspace-panel .panel-error')).toHaveCount(0);
});
