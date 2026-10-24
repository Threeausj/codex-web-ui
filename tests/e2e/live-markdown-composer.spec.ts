import { test, expect, login, readComposerSource, setComposerSelection, getComposerSelection } from './fixtures';
import type { Page } from '@playwright/test';

const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
async function fillAtEnd(page: Page, source: string) {
  const editor = input(page);
  await editor.fill(source);
  await expect(editor).toHaveValue(source);
  await setComposerSelection(editor, source.length);
}

for (const width of [1440, 390]) test(`${width}px edits show Markdown styles immediately and preserve exact source without opening preview`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 844 });
  let externalImages = 0;
  await page.route('https://preview.example.invalid/**', route => { externalImages++; return route.abort(); });
  await login(page);
  const source = '# 实时标题\n**粗体** *斜体* ~~删除~~ `代码`\n- [x] 完成\n> 引用\n![不联网图片](https://preview.example.invalid/private.png)';
  await fillAtEnd(page, source);
  await input(page).evaluate(element => element.blur());
  const editor = page.locator('.markdown-composer-editor');
  await expect(editor.locator('.cm-md-heading-1')).toBeVisible();
  await expect(editor.locator('.cm-md-strong')).toHaveCSS('font-weight', '700');
  await expect(editor.locator('.cm-md-emphasis')).toHaveCSS('font-style', 'italic');
  await expect(editor.locator('.cm-md-strike')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(editor.locator('.cm-md-inline-code')).toBeVisible();
  await expect(editor.locator('.cm-md-task-marker')).toHaveAttribute('data-preview-token', '☑');
  await expect(editor.locator('.cm-md-quote').first()).toBeVisible();
  await expect(editor.locator('.cm-md-hidden-token').first()).toHaveCSS('font-size', '0px');
  expect(await readComposerSource(input(page))).toBe(source);
  expect(externalImages).toBe(0);
  expect(mock.request('turn/start')).toBeUndefined();
  await expect(page.getByRole('region', { name: 'Markdown 草稿预览', exact: true })).toHaveCount(0);
  const height = await editor.locator('.cm-scroller').evaluate(element => element.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(Math.min(210, 844 * .35) + 1);
});

test('Ctrl/Cmd formatting preserves Chinese and emoji, source selections, and undo/redo steps', async ({ page, mock }) => {
  await login(page);
  await fillAtEnd(page, '中文😀 内容');
  await setComposerSelection(input(page), 0, 4);
  await input(page).press('ControlOrMeta+b');
  await expect(input(page)).toHaveValue('**中文😀** 内容');
  expect(await getComposerSelection(input(page))).toEqual([2, 6]);
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('中文😀 内容');
  await input(page).press('ControlOrMeta+Shift+Z');
  await expect(input(page)).toHaveValue('**中文😀** 内容');
  await input(page).press('ControlOrMeta+b');
  await expect(input(page)).toHaveValue('中文😀 内容');
  await input(page).press('ControlOrMeta+i');
  await expect(input(page)).toHaveValue('*中文😀* 内容');
  await input(page).press('ControlOrMeta+i');
  await expect(input(page)).toHaveValue('中文😀 内容');
  await input(page).press('ControlOrMeta+e');
  await expect(input(page)).toHaveValue('`中文😀` 内容');
  await input(page).press('ControlOrMeta+e');
  await expect(input(page)).toHaveValue('中文😀 内容');
  await input(page).press('ControlOrMeta+Shift+K');
  await expect(input(page)).toHaveValue('[中文😀](https://) 内容');
  expect(mock.request('turn/start')).toBeUndefined();
  await input(page).press('ControlOrMeta+Enter');
  await expect.poll(() => mock.request('turn/start')?.params.input[0]?.text).toBe('[中文😀](https://) 内容');
});

for (const [source, next] of [
  ['- 第一项', '- 第一项\n- '],
  ['9. 第一项', '9. 第一项\n10. '],
  ['- [x] 完成项', '- [x] 完成项\n- [ ] '],
  ['> - 引用列表', '> - 引用列表\n> - '],
  ['  - 嵌套项', '  - 嵌套项\n  - '],
] as const) test(`Enter continues ${JSON.stringify(source)} without sending the draft`, async ({ page, mock }) => {
  await login(page); await fillAtEnd(page, source);
  await input(page).press('Enter'); await expect(input(page)).toHaveValue(next);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('an empty list item exits the list and mobile beforeinput follows the same continuation', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page); await fillAtEnd(page, '- 第一项\n- ');
  await input(page).press('Enter'); await expect(input(page)).toHaveValue('- 第一项\n');
  await fillAtEnd(page, '- 手机版');
  await input(page).evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true })));
  await expect(input(page)).toHaveValue('- 手机版\n- ');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('code fences and Shift+Enter insert literal newlines, while plain Enter sends', async ({ page, mock }) => {
  await login(page); await fillAtEnd(page, '```ts\n- literal');
  await input(page).press('Enter'); await expect(input(page)).toHaveValue('```ts\n- literal\n');
  expect(mock.request('turn/start')).toBeUndefined();
  await fillAtEnd(page, '普通第一行'); await input(page).press('Shift+Enter');
  await expect(input(page)).toHaveValue('普通第一行\n');
  await input(page).pressSequentially('第二行');
  await input(page).press('Enter');
  await expect.poll(() => mock.request('turn/start')?.params.input[0]?.text).toBe('普通第一行\n第二行');
});

test('IME candidate confirmation cannot send or insert an accidental editor newline', async ({ page, mock }) => {
  await login(page); await fillAtEnd(page, '**中文**');
  await setComposerSelection(input(page), 2, 4);
  await input(page).dispatchEvent('compositionstart', { data: '中', bubbles: true });
  await input(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
  await input(page).dispatchEvent('beforeinput', { inputType: 'insertParagraph', isComposing: true, bubbles: true, cancelable: true });
  await expect(input(page)).toHaveValue('**中文**');
  expect(mock.request('turn/start')).toBeUndefined();
  await input(page).dispatchEvent('compositionend', { data: '中', bubbles: true });
  await input(page).press('Escape');
  await expect(input(page)).toHaveValue('**中文**');
});

test('changing conversation resets undo so another draft cannot be restored into the current chat', async ({ page }) => {
  await login(page);
  await fillAtEnd(page, '欢迎页草稿');
  await input(page).pressSequentially('只属于欢迎页');
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(input(page)).toHaveValue('');
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('');
  await input(page).pressSequentially('现有会话草稿');
  await expect(input(page)).toHaveValue('现有会话草稿');
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).not.toHaveValue(/欢迎页/);
});

test('dropping an attachment uploads it once without inserting its file contents into Markdown', async ({ page, mock }) => {
  await login(page);
  await fillAtEnd(page, '保留 **现有草稿**');
  await input(page).evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['ATTACHMENT_CONTENT_MUST_NOT_ENTER_THE_DRAFT'], 'notes.txt', { type: 'text/plain' }));
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true,
      clientX: bounds.left + 8, clientY: bounds.top + 8 }));
  });
  await expect(page.locator('.attachment').filter({ hasText: 'notes.txt' })).toBeVisible();
  expect(mock.uploads).toHaveLength(1);
  expect(mock.uploads[0]!.body.toString()).toContain('ATTACHMENT_CONTENT_MUST_NOT_ENTER_THE_DRAFT');
  await expect(input(page)).toHaveValue('保留 **现有草稿**');
  expect(mock.request('turn/start')).toBeUndefined();
});

for (const modifier of ['Control', 'Meta']) test(`${modifier}+K preserves global search and Escape returns to the unchanged draft`, async ({ page, mock }) => {
  await login(page);
  const draft = '搜索前 **保留草稿**';
  await fillAtEnd(page, draft);
  await setComposerSelection(input(page), 4, 8);
  await input(page).press(`${modifier}+k`);
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true });
  await expect(palette).toBeVisible();
  await expect(page.getByRole('textbox', { name: '搜索对话或指令', exact: true })).toBeFocused();
  await expect(input(page)).toHaveValue(draft);
  await page.getByRole('textbox', { name: '搜索对话或指令', exact: true }).press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue(draft);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a late file search for an old mention token cannot replace the current mode or select stale files', async ({ page, mock }) => {
  mock.holdFinalMessage = true;
  const receive = mock.receive.bind(mock);
  let releaseOldSearch: (() => void) | undefined;
  let releaseCurrentSearch: (() => void) | undefined;
  mock.receive = (socket, request) => {
    if (request.method === 'collaborationMode/list') {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, result: { data: [{ mode: 'default', name: 'Default' }, { mode: 'plan', name: 'Plan' }] } }));
    }
    if (request.method === 'fuzzyFileSearch' && ['', 'plan'].includes(request.params.query)) {
      mock.requests.push(request);
      const reply = (name: string) => socket.send(JSON.stringify({ id: request.id, result: { files: [{
        file_name: name, path: name, root: '/workspace/demo', score: 100, indices: [],
      }] } }));
      if (request.params.query === '') releaseOldSearch = () => reply('README.md');
      else releaseCurrentSearch = () => reply('plan.ts');
      return;
    }
    return receive(socket, request);
  };
  await login(page);
  await fillAtEnd(page, '运行中的任务');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await fillAtEnd(page, '保留草稿 @');
  await expect.poll(() => typeof releaseOldSearch).toBe('function');
  await input(page).fill('保留草稿 @plan');
  // Release immediately after the edit, before the 180ms current-query debounce.
  releaseOldSearch!();
  await expect(input(page)).toHaveValue('保留草稿 @plan');
  const picker = page.getByRole('listbox', { name: '模式与项目文件', exact: true });
  const plan = picker.getByRole('option').filter({ hasText: 'Plan 模式' });
  await expect(plan).toBeDisabled();
  await expect.poll(() => typeof releaseCurrentSearch).toBe('function');
  await expect(picker.getByRole('option').filter({ hasText: 'README.md' })).toHaveCount(0);
  await input(page).press('ArrowDown');
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('保留草稿 @plan');
  await expect(plan).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  releaseCurrentSearch!();
  await expect(picker.getByRole('option').filter({ hasText: 'plan.ts' })).toBeEnabled();
  await expect(picker.getByRole('option').filter({ hasText: 'README.md' })).toHaveCount(0);
  await picker.getByRole('option').filter({ hasText: 'plan.ts' }).click();
  await expect(input(page)).toHaveValue('保留草稿 @/workspace/demo/plan.ts ');
});

test('same-thread metadata refresh and task completion preserve the open mobile mode picker and its draft', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  mock.holdFinalMessage = true;
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => {
    const reply = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
    if (request.method === 'collaborationMode/list') {
      mock.requests.push(request);
      return reply({ data: [{ mode: 'default', name: 'Default' }, { mode: 'plan', name: 'Plan' }] });
    }
    if (request.method === 'thread/settings/update') {
      mock.requests.push(request);
      return reply({});
    }
    if (request.method === 'fuzzyFileSearch' && request.params.query === 'plan') {
      mock.requests.push(request);
      return reply({ files: [] });
    }
    return receive(socket, request);
  };
  await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await fillAtEnd(page, '运行中的既有会话');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await fillAtEnd(page, '继续保留草稿 @plan');
  const picker = page.getByRole('listbox', { name: '模式与项目文件', exact: true });
  const plan = picker.getByRole('option').filter({ hasText: 'Plan 模式' });
  await expect(plan).toBeDisabled();
  // Metadata can replace the active thread object without changing its identity.
  mock.emit('thread/name/updated', { threadId: 'thread-existing', threadName: '同一会话的新标题' });
  await expect(page.getByRole('heading', { name: '同一会话的新标题', exact: true })).toBeVisible();
  await expect(plan).toBeVisible();
  await expect(input(page)).toHaveValue('继续保留草稿 @plan');
  mock.finishStream();
  await expect(plan).toBeEnabled();
  await expect(input(page)).toHaveValue('继续保留草稿 @plan');
  await plan.click();
  await expect(page.locator('.mode-token')).toContainText('Plan 模式');
  await expect(input(page)).toHaveValue('继续保留草稿 ');
});
