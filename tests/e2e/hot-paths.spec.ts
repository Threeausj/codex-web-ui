import { test, expect, login } from './fixtures';

test('a dirty editor persists its draft without rewriting the tab catalog per keystroke', async ({ page, mock }) => {
  await page.addInitScript(() => {
    const probe = (window as any).writes = { catalogs: 0, draft: '' };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === 'records' && value.key.includes('"file-workspace-tabs"')) probe.catalogs++;
      if (this.name === 'records' && value.key.includes('"file-workspace"'))
        this.transaction.addEventListener('complete', () => { probe.draft = value.value.tabs[0]?.content || ''; });
      return put.call(this, value, key);
    };
  });
  await login(page);
  await expect.poll(() => mock.requests.filter(request => request.method === 'account/rateLimits/read').length).toBe(1);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
  await page.locator('.file-view-switch').getByRole('button', { name: '源码' }).click();
  const editor = page.getByRole('textbox', { name: 'README.md 文件内容' });
  await editor.click(); await editor.press('End'); await editor.press('Z');
  await expect.poll(() => page.evaluate(() => (window as any).writes.draft)).toContain('Z');
  const before = await page.evaluate(() => (window as any).writes.catalogs);
  await editor.pressSequentially('abcdefghijkl', { delay: 20 });
  await expect.poll(() => page.evaluate(() => (window as any).writes.draft)).toContain('abcdefghijkl');
  expect(await page.evaluate(() => (window as any).writes.catalogs)).toBe(before);
});

test('upgrading private storage preserves drafts and enforces quotas across concurrent connections without scanning payloads', async ({ page }) => {
  await page.route('**/storage-fixture', route => route.fulfill({ contentType: 'text/html', body: '<title>Storage fixture</title>' }));
  await page.goto('/storage-fixture');
  const result = await page.evaluate(async () => {
    const limit = 64 * 1024 * 1024;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('codex-private-work', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('records', { keyPath: 'key' });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('records', 'readwrite');
        tx.objectStore('records').put({ key: 'old', value: 'recover me', scope: 'test', bytes: limit - 1 });
        tx.oncomplete = () => { open.result.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
    });
    const modulePath = '/src/lib/private-state.ts';
    const { indexedPrivatePersistence } = await import(modulePath);
    const first = indexedPrivatePersistence(), second = indexedPrivatePersistence();
    const original = IDBObjectStore.prototype.getAll;
    let scans = 0;
    IDBObjectStore.prototype.getAll = function(...args) { if (this.name === 'records') scans++; return original.apply(this, args); };
    const write = (store: typeof first, key: string, bytes: number) => store.write({ key, bytes, value: key, scope: 'test' });
    const old = (await first.read('old')).value;
    const concurrent = await Promise.allSettled([write(first, 'a', 1), write(second, 'b', 1)]);
    const rejected = (await Promise.allSettled([write(first, 'old', limit)]))[0].status;
    const intact = (await first.read('old')).value;
    await second.remove('old'); await write(first, 'after-remove', limit - 1);
    await first.clear(); await write(second, 'after-clear', limit);
    return { old, intact, scans, rejected, committed: concurrent.filter(entry => entry.status === 'fulfilled').length };
  });
  expect(result).toEqual({ old: 'recover me', intact: 'recover me', scans: 0, rejected: 'rejected', committed: 1 });
});

test('legacy list is visible while latest-turn metadata is still outstanding', async ({ page, mock }) => {
  (mock.threads[0] as any).recencyAt = null;
  const receive = (mock as any).receive.bind(mock), held: (() => void)[] = [];
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/turns/list' && request.params?.itemsView === 'notLoaded') {
      held.push(() => receive(socket, request)); return;
    }
    return receive(socket, request);
  };
  try {
    await page.goto('/');
    await page.locator('input[type="password"]').fill('test-password-123');
    await page.getByRole('button', { name: /登录|进入工作区|解锁/ }).click();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(page.locator('[data-section="recent"] .thread-row').first()).toContainText('已有测试历史');
  } finally { held.splice(0).forEach(reply => reply()); }
});

test('selecting the current mobile chat closes the drawer without resuming it again', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const open = page.getByRole('button', { name: '打开侧边栏', exact: true });
  const row = page.locator('[data-section="recent"] .thread-row').first();
  await open.click(); await row.click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'thread/resume').length).toBe(1);
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await open.click(); await row.click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/mobile-open/);
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(1);
});

test('title preference is saved to the Web service and survives reopening settings', async ({ page, mock }) => {
  await login(page);
  await page.locator('.settings-button').click();
  const mode = page.getByRole('combobox', { name: '新对话标题' });
  await mode.selectOption('preview');
  await expect.poll(() => mock.preferences.threadTitleMode).toBe('preview');
  await page.reload();
  await page.locator('.settings-button').click();
  await expect(mode).toHaveValue('preview');
});
