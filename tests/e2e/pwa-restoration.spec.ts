import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

async function launchFixture(page: Page, initialURL = '') {
  await page.addInitScript((initialURL) => {
    const fixture = { consumer: null as ((params: { targetURL?: string }) => void) | null,
      deliver(targetURL: string) { this.consumer?.({ targetURL }); } };
    (window as any).appLaunchFixture = fixture;
    Object.defineProperty(window, 'launchQueue', { configurable: true, value: {
      setConsumer(consumer: typeof fixture.consumer) {
        fixture.consumer = consumer;
        if (initialURL) consumer?.({ targetURL: new URL(initialURL, location.href).href });
      },
    } });
  }, initialURL);
}
async function openThread(page: Page) {
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
}
async function records(page: Page) {
  return page.evaluate(() => new Promise<any[]>((resolve, reject) => {
    const open = indexedDB.open('codex-private-work', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('records')) { db.close(); resolve([]); return; }
      const read = db.transaction('records').objectStore('records').getAll();
      read.onsuccess = () => { db.close(); resolve(read.result); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }));
}

test('icon relaunch and a real freeze/resume keep the same document, chat, draft and transport', async ({ page, context, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await launchFixture(page);
  await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await openThread(page);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('挂起后继续输入，不自动提交');
  await page.evaluate(() => { (window as any).documentIdentity = 'existing-app-window'; });
  const debuggerSession = await context.newCDPSession(page);
  await debuggerSession.send('Page.setWebLifecycleState', { state: 'frozen' });
  await debuggerSession.send('Page.setWebLifecycleState', { state: 'active' });
  await page.evaluate(() => (window as any).appLaunchFixture.deliver(location.origin + '/'));
  await expect.poll(() => mock.requests.filter(request => request.method === 'bridge/ping').length).toBeGreaterThan(0);
  await expect(input).toHaveValue('挂起后继续输入，不自动提交');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).documentIdentity)).toBe('existing-app-window');
  expect(mock.sockets).toHaveLength(1);
  expect(mock.request('turn/start')).toBeUndefined();
  await debuggerSession.detach();
});

test('focus-existing notification launches switch hosts while ordinary or untrusted launches preserve the chat', async ({ page, mock }) => {
  const remote = new MockCodex();
  remote.turns.get('thread-existing')![0].items[1].text = '启动通知的远程对话';
  mock.hosts.push({ id: 'ssh-test', name: 'Remote', kind: 'ssh', cwd: '/workspace/demo' });
  mock.hostMocks.set('ssh-test', remote);
  await launchFixture(page);
  await login(page); await openThread(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('本机原来的草稿');
  await page.evaluate(() => (window as any).appLaunchFixture.deliver(location.origin + '/?host=ssh-test&thread=thread-existing'));
  await expect(page.getByText('启动通知的远程对话', { exact: true })).toBeVisible();
  const events = await page.evaluate(() => {
    let events = 0;
    const listener = () => events++;
    window.addEventListener('codex:push-navigate', listener);
    window.addEventListener('codex:app-resume', listener);
    for (const url of ['https://attacker.invalid/?host=local&thread=thread-existing', location.origin + '/other?host=local&thread=thread-existing', 'malformed url'])
      (window as any).appLaunchFixture.deliver(url);
    window.removeEventListener('codex:push-navigate', listener);
    window.removeEventListener('codex:app-resume', listener);
    return events;
  });
  expect(events).toBe(0);
  await page.evaluate(() => (window as any).appLaunchFixture.deliver(location.origin + '/'));
  await expect(page.locator('.header-host')).toHaveText('Remote');
  await openThread(page); // The recent row for the local thread is first.
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('本机原来的草稿');
  expect(mock.request('turn/start')).toBeUndefined();
  expect(remote.request('turn/start')).toBeUndefined();
});

test('a cold launch destination received before login still opens the requested conversation', async ({ page, mock }) => {
  await launchFixture(page, '/?host=local&thread=thread-existing');
  await login(page);
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a late reading-position receipt cannot scroll a different conversation selected during restoration', async ({ page, context, mock }) => {
  const text = Array.from({ length: 100 }, (_, i) => `长段落 ${i + 1}`).join('\n\n');
  mock.turns.get('thread-existing')![0].items[1].text = text;
  mock.threads.push({ ...mock.threads[0], id: 'second-thread', name: '独立阅读位置' });
  mock.turns.set('second-thread', [{ id: 'second-turn', status: 'completed', items: [{ id: 'second-agent', type: 'agentMessage', text }] }]);
  await login(page); await openThread(page);
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 275; element.dispatchEvent(new Event('scroll')); document.dispatchEvent(new Event('freeze')); });
  await expect.poll(async () => (await records(page)).some(row => JSON.parse(row.key)[1] === 'reading-positions')).toBe(true);
  await page.close();
  const reopened = await context.newPage();
  await mock.install(reopened);
  await reopened.addInitScript(() => {
    let captured = false;
    const probe = { release: null as (() => void) | null };
    (window as any).positionReadProbe = probe;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      if (!captured && this.transaction.db.name === 'codex-private-work' && JSON.parse(String(key))[1] === 'reading-positions') {
        captured = true;
        (this.transaction as any).holdPositionReceipt = true;
      }
      return get.call(this, key);
    };
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(handler) {
      descriptor.set!.call(this, (event: Event) => {
        if ((this as any).holdPositionReceipt && typeof handler === 'function') probe.release = () => handler.call(this, event);
        else if (typeof handler === 'function') handler.call(this, event);
      });
    } });
  });
  await reopened.goto('/');
  await expect.poll(() => reopened.evaluate(() => !!(window as any).positionReadProbe.release)).toBe(true);
  await reopened.locator('[data-section="recent"] .thread-row').filter({ hasText: '独立阅读位置' }).click();
  await expect(reopened.getByRole('heading', { name: '独立阅读位置', exact: true })).toBeVisible();
  await reopened.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 600; element.dispatchEvent(new Event('scroll')); });
  await reopened.evaluate(() => (window as any).positionReadProbe.release());
  await expect.poll(() => reopened.locator('.conversation-scroll').evaluate(element => element.scrollTop)).toBe(600);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a discarded app window restores its reading position from private storage, with no sessionStorage', async ({ page, context, mock }) => {
  mock.turns.get('thread-existing')![0].items[1].text = Array.from({ length: 100 }, (_, i) => `历史段落 ${i + 1}`).join('\n\n');
  await login(page); await openThread(page);
  const top = await page.locator('.conversation-scroll').evaluate(element => {
    element.scrollTop = 275;
    element.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('freeze'));
    return element.scrollTop;
  });
  expect(top).toBe(275);
  await expect.poll(async () => (await records(page)).some(row => JSON.parse(row.key)[1] === 'reading-positions' && row.value.some((entry: any) => entry.top === top && !entry.bottom))).toBe(true);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('重开后保留阅读位置和草稿');
  await page.close();
  const reopened = await context.newPage();
  await mock.install(reopened); await reopened.goto('/');
  await expect(reopened.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('重开后保留阅读位置和草稿');
  await expect.poll(() => reopened.locator('.conversation-scroll').evaluate(element => element.scrollTop)).toBe(top);
  expect(mock.request('turn/start')).toBeUndefined();
  await reopened.getByRole('button', { name: /^设置\s/ }).click();
  await reopened.getByRole('button', { name: '账户', exact: true }).click();
  await reopened.getByRole('button', { name: '退出网页', exact: true }).click();
  await expect(reopened.getByRole('textbox', { name: '访问密码', exact: true })).toBeVisible();
  await expect.poll(async () => (await records(reopened)).filter(row => JSON.parse(row.key)[1] === 'reading-positions').length).toBe(0);
  expect(await reopened.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('codex.scroll.')))).toBe(false);
});

for (const event of ['hidden', 'freeze'] as const) {
  test(`${event} commits an editor draft immediately even when its debounce timer cannot run`, async ({ page, context, mock }) => {
    await page.addInitScript(() => {
      const timeout = window.setTimeout;
      // Android may freeze the renderer before the ordinary draft debounce.
      window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => delay === 180 ? 0 : timeout(callback, delay, ...args)) as typeof window.setTimeout;
    });
    await login(page); await openThread(page);
    await page.getByRole('button', { name: '切换工作区', exact: true }).click();
    await page.locator('.file-tree-row').filter({ hasText: 'README.md' }).click();
    await page.getByRole('button', { name: '源码', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'README.md 文件内容', exact: true });
    await editor.click(); await editor.press('ControlOrMeta+A');
    await page.keyboard.insertText('立即保留的文件草稿');
    await expect(editor).toContainText('立即保留的文件草稿');
    await page.evaluate(event => {
      if (event === 'hidden') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      } else document.dispatchEvent(new Event('freeze'));
    }, event);
    await expect.poll(async () => (await records(page)).some(row => JSON.parse(row.key)[1] === 'file-workspace' && row.value.tabs.some((entry: any) => entry.content === '立即保留的文件草稿'))).toBe(true);
    await page.close();
    const reopened = await context.newPage();
    await mock.install(reopened); await reopened.goto('/');
    await expect(reopened.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
    await reopened.getByRole('button', { name: '切换工作区', exact: true }).click();
    await expect(reopened.getByRole('textbox', { name: 'README.md 文件内容', exact: true })).toContainText('立即保留的文件草稿');
    expect(mock.request('fs/writeFile')).toBeUndefined();
    expect(mock.request('turn/start')).toBeUndefined();
  });
}
