import { test, expect, login, setComposerSelection } from './fixtures';

test('refreshing the same conversation in another directory rejects file results from its previous scope', async ({ page, mock }) => {
  const originalDirectory = '/workspace/demo', nextDirectory = '/workspace/second';
  mock.projects.push({ id: 'second', name: '项目 B', path: nextDirectory, hostId: 'local', source: 'web' });
  const receive = mock.receive.bind(mock);
  let releaseOldSearch: (() => void) | undefined;
  let releaseCurrentSearch: (() => void) | undefined;
  mock.receive = (socket, request) => {
    if (request.method !== 'fuzzyFileSearch' || request.params.query !== 'private') return receive(socket, request);
    mock.requests.push(request);
    const root = request.params.roots[0];
    const reply = (name: string) => socket.send(JSON.stringify({ id: request.id, result: { files: [{
      file_name: name, path: name, root, score: 100, indices: [],
    }] } }));
    if (root === originalDirectory) {
      releaseOldSearch = () => reply('private-from-project-a.txt');
    } else if (root === nextDirectory) releaseCurrentSearch = () => reply('private-from-project-b.txt');
    else throw new Error(`Unexpected file search root: ${root}`);
  };
  await login(page);
  const currentConversation = page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' });
  await currentConversation.click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  const draft = '保留当前会话的草稿 @private';
  await input.fill(draft);
  await setComposerSelection(input, draft.length);
  await expect.poll(() => typeof releaseOldSearch).toBe('function');

  // A native history refresh can change cwd without changing the thread ID.
  // Reopening the current sidebar entry exercises that ordinary app-server
  // response, rather than modifying Vue state from a test-only browser hook.
  mock.threads[0]!.cwd = nextDirectory;
  await currentConversation.click();
  await expect(page.locator('.header-project > button')).toContainText('项目 B');
  await expect(input).toHaveValue(draft);
  const picker = page.getByRole('listbox', { name: '模式与项目文件', exact: true });
  releaseOldSearch!();
  // This notification follows the old reply on the same ordered WebSocket.
  // Its visible title confirms the reply was processed before asserting that
  // stale results cannot reopen the picker, without a timing-only sleep.
  mock.emit('thread/name/updated', { threadId: 'thread-existing', threadName: '目录同步后的同一会话' });
  await expect(page.locator('.main-header h1')).toHaveText('目录同步后的同一会话');
  await expect(picker).toHaveCount(0);

  await input.click();
  await setComposerSelection(input, draft.length);
  await expect.poll(() => typeof releaseCurrentSearch).toBe('function');
  await expect(picker.getByRole('option').filter({ hasText: 'private-from-project-a.txt' })).toHaveCount(0);
  await input.press('Enter');
  await expect(input).toHaveValue(draft);
  expect(mock.request('turn/start')).toBeUndefined();
  releaseCurrentSearch!();
  const currentFile = picker.getByRole('option').filter({ hasText: 'private-from-project-b.txt' });
  await expect(currentFile).toBeEnabled();
  await currentFile.click();
  await expect(input).toHaveValue('保留当前会话的草稿 @/workspace/second/private-from-project-b.txt ');
  expect(mock.request('turn/start')).toBeUndefined();
});
