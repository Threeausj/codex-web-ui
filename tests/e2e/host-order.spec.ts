import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const hosts = [
  { id: 'local', name: '本机', kind: 'local' },
  { id: 'ssh-nas', name: 'NAS', kind: 'ssh', hostname: 'nas.invalid', cwd: '/workspace/demo' },
  { id: 'ssh-rtx', name: 'RTX4090x8', kind: 'ssh', hostname: 'rtx.invalid', cwd: '/workspace/demo' },
];
const names = (ids: string[]) => ids.map(id => hosts.find(host => host.id === id)!.name);
const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const filters = (page: Page) => page.locator('.recent-host-filter button');
const rows = (page: Page) => page.getByRole('dialog', { name: '设置', exact: true }).locator('.connection-row .connection-details strong');

function populate(mock: MockCodex, inventory = hosts) {
  mock.hosts = inventory.map(host => ({ ...host }));
  for (const host of inventory.filter(host => host.kind === 'ssh')) {
    const remote = new MockCodex();
    remote.threads[0] = { ...remote.threads[0]!, name: `${host.name} 历史`, preview: `${host.name} 历史` };
    remote.turns.get('thread-existing')![0].items[1].text = `${host.name} 原有内容`;
    mock.hostMocks.set(host.id, remote);
    mock.projects.push({ ...mock.projects[0], id: `${host.id}-project`, hostId: host.id, name: `${host.name} 项目` });
  }
}

/** Shared HTTP state and explicit runtime notifications; browser storage is never shared. */
class HostOrderBackend {
  order: string[];
  calls: string[][] = [];
  devices: MockCodex[] = [];
  failNext = false;
  holdNextResponse = false;
  private heldResponse?: () => void;
  constructor(private inventory = hosts) { this.order = inventory.map(host => host.id); }
  async install(page: Page, mock: MockCodex) {
    this.devices.push(mock);
    this.apply();
    await page.route(/\/api\/hosts(?:\/order)?(?:\?|$)/, async route => {
      const request = route.request();
      if (new URL(request.url()).pathname === '/api/hosts/order') {
        expect(request.method()).toBe('PATCH');
        const hostIds = request.postDataJSON().hostIds as string[];
        this.calls.push([...hostIds]);
        expect([...hostIds].sort()).toEqual(this.inventory.map(host => host.id).sort());
        if (this.failNext) {
          this.failNext = false;
          return route.fulfill({ status: 503, json: { error: '模拟主机顺序保存失败，请重试' } });
        }
        // The real backend can broadcast before the requesting page receives its ACK.
        this.changeOrder(hostIds);
        const savedHosts = mock.hosts.map(host => ({ ...host }));
        if (this.holdNextResponse) {
          this.holdNextResponse = false;
          await new Promise<void>(resolve => { this.heldResponse = resolve; });
        }
        return route.fulfill({ json: { hosts: savedHosts } });
      }
      return route.fulfill({ json: { hosts: mock.hosts, localEnabled: true } });
    });
  }
  changeOrder(hostIds: string[]) {
    this.order = [...hostIds];
    this.apply();
    for (const device of this.devices) {
      for (const runtime of [device, ...device.hostMocks.values()]) runtime.emit('bridge/host-order/changed', { hostIds });
    }
  }
  releaseResponse() { this.heldResponse?.(); this.heldResponse = undefined; }
  private apply() {
    for (const mock of this.devices) mock.hosts = this.order.map(id => ({ ...this.inventory.find(host => host.id === id)! }));
  }
}

async function sidebar(page: Page) {
  const open = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await open.isVisible()) await open.click();
}
async function connections(page: Page) {
  await sidebar(page);
  await page.locator('.settings-button').click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.locator('.settings-nav').getByRole('button', { name: '连接', exact: true }).click();
  return dialog;
}
async function openChat(page: Page, hostId: string) {
  await sidebar(page);
  await page.locator(`[data-section="recent"] [data-host-id="${hostId}"] .thread-row`).click();
  await expect(page.locator('.header-host')).toHaveText(hosts.find(host => host.id === hostId)!.name);
  await expect(input(page)).toBeEnabled();
}
function socketCounts(mock: MockCodex) {
  return [mock, ...mock.hostMocks.values()].map(runtime => runtime.sockets.length);
}
function expectNoModelCalls(mock: MockCodex) {
  for (const runtime of [mock, ...mock.hostMocks.values()]) {
    expect(runtime.request('turn/start')).toBeUndefined();
    expect(runtime.request('turn/steer')).toBeUndefined();
  }
}

test('moving enabled local and remote hosts persists the order without changing the current chat or draft', async ({ page, mock }) => {
  populate(mock);
  const backend = new HostOrderBackend();
  await backend.install(page, mock);
  await login(page);
  await openChat(page, 'ssh-nas');
  await input(page).fill('排序不会丢失的 NAS 草稿');
  const sockets = socketCounts(mock);
  const reconnects: string[] = [];
  page.on('request', request => { if (request.url().includes('/runtime/reconnect')) reconnects.push(request.url()); });
  const settings = await connections(page);
  await expect(rows(page)).toHaveText(['本机', 'NAS', 'RTX4090x8']);
  await expect(settings.getByRole('button', { name: '上移 本机', exact: true })).toBeDisabled();
  await expect(settings.getByRole('button', { name: '下移 RTX4090x8', exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: '上移 NAS', exact: true }).click();
  await expect(rows(page)).toHaveText(['NAS', '本机', 'RTX4090x8']);
  await settings.getByRole('button', { name: '上移 RTX4090x8', exact: true }).click();
  await expect(rows(page)).toHaveText(['NAS', 'RTX4090x8', '本机']);
  await settings.getByRole('button', { name: '下移 NAS', exact: true }).click();
  await expect(rows(page)).toHaveText(['RTX4090x8', 'NAS', '本机']);
  await expect(settings.getByRole('combobox', { name: '设置主机', exact: true })).toHaveValue('ssh-nas');
  await page.screenshot({ path: '.data/host-order-desktop.png' });
  expect(backend.calls).toEqual([
    ['ssh-nas', 'local', 'ssh-rtx'], ['ssh-nas', 'ssh-rtx', 'local'], ['ssh-rtx', 'ssh-nas', 'local'],
  ]);
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(filters(page)).toHaveText(['全部', 'RTX4090x8', 'NAS', '本机']);
  await expect(page.locator('.main-header')).toContainText('NAS 历史');
  await expect(page.locator('.agent-message')).toContainText('NAS 原有内容');
  await expect(input(page)).toHaveValue('排序不会丢失的 NAS 草稿');
  expect(socketCounts(mock)).toEqual(sockets);
  expect(reconnects).toEqual([]);
  expectNoModelCalls(mock);
  await page.reload();
  await expect(input(page)).toHaveValue('排序不会丢失的 NAS 草稿');
  await expect(page.locator('.main-header')).toContainText('NAS 历史');
  await expect(filters(page)).toHaveText(['全部', 'RTX4090x8', 'NAS', '本机']);
  await connections(page);
  await expect(rows(page)).toHaveText(names(backend.order));
});

test('a rejected order save leaves both connection rows and recent filters unchanged and can be retried', async ({ page, mock }) => {
  populate(mock);
  const backend = new HostOrderBackend();
  await backend.install(page, mock);
  await login(page);
  await input(page).fill('保存失败后仍在的草稿');
  backend.failNext = true;
  const settings = await connections(page);
  await settings.getByRole('button', { name: '上移 NAS', exact: true }).click();
  await expect(settings.locator('.panel-error')).toContainText('模拟主机顺序保存失败');
  await expect(rows(page)).toHaveText(['本机', 'NAS', 'RTX4090x8']);
  await expect(filters(page)).toHaveText(['全部', '本机', 'NAS', 'RTX4090x8']);
  expect(backend.order).toEqual(['local', 'ssh-nas', 'ssh-rtx']);
  await settings.getByRole('button', { name: '上移 NAS', exact: true }).click();
  await expect(rows(page)).toHaveText(['NAS', '本机', 'RTX4090x8']);
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(input(page)).toHaveValue('保存失败后仍在的草稿');
  expectNoModelCalls(mock);
});

test('a delayed order save ACK cannot replace a newer order received from another device', async ({ page, mock }) => {
  populate(mock);
  const backend = new HostOrderBackend();
  await backend.install(page, mock);
  await login(page);
  await input(page).fill('并发排序保留草稿');
  const settings = await connections(page);
  backend.holdNextResponse = true;
  await settings.getByRole('button', { name: '上移 NAS', exact: true }).click();
  await expect(rows(page)).toHaveText(['NAS', '本机', 'RTX4090x8']);
  await expect(settings.getByRole('button', { name: '下移 NAS', exact: true })).toBeDisabled();
  backend.changeOrder(['ssh-rtx', 'local', 'ssh-nas']);
  await expect(rows(page)).toHaveText(['RTX4090x8', '本机', 'NAS']);
  backend.releaseResponse();
  // Saving feedback is emitted after the old HTTP response has been processed.
  await expect(settings.locator('.settings-success')).toContainText('主机顺序已保存');
  await expect(settings.getByRole('button', { name: '下移 本机', exact: true })).toBeEnabled();
  await expect(rows(page)).toHaveText(['RTX4090x8', '本机', 'NAS']);
  await expect(filters(page)).toHaveText(['全部', 'RTX4090x8', '本机', 'NAS']);
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(input(page)).toHaveValue('并发排序保留草稿');
  expectNoModelCalls(mock);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`mobile ${colorScheme} connection controls remain touchable without horizontal overflow`, async ({ page, mock }) => {
    const longName = 'RTX4090x8-longhostnamelonghostnamelonghostnamelonghostname';
    const mobileHosts = hosts.map(host => host.id === 'ssh-rtx' ? { ...host, name: longName, hostname: 'longhostnamelonghostnamelonghostnamelonghostname.invalid' } : { ...host });
    populate(mock, mobileHosts);
    const backend = new HostOrderBackend(mobileHosts);
    await backend.install(page, mock);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await login(page);
    const settings = await connections(page);
    await expect(settings.getByRole('button', { name: '上移 本机', exact: true })).toBeDisabled();
    await expect(settings.getByRole('button', { name: `下移 ${longName}`, exact: true })).toBeDisabled();
    const up = settings.getByRole('button', { name: '上移 NAS', exact: true });
    await up.scrollIntoViewIfNeeded();
    const bounds = await up.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(30);
    expect(bounds!.width).toBeGreaterThanOrEqual(28);
    await up.click();
    await expect(rows(page)).toHaveText(['NAS', '本机', longName]);
    await expect(settings.getByRole('button', { name: '上移 NAS', exact: true })).toBeDisabled();
    const geometry = await settings.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, page: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(geometry.content).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
    await settings.getByRole('button', { name: `上移 ${longName}`, exact: true }).scrollIntoViewIfNeeded();
    await expect(settings.getByRole('button', { name: `上移 ${longName}`, exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: `下移 ${longName}`, exact: true })).toBeVisible();
    await page.screenshot({ path: `.data/host-order-mobile-${colorScheme}.png` });
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
    await sidebar(page);
    await expect(filters(page)).toHaveText(['全部', 'NAS', '本机', longName]);
    expectNoModelCalls(mock);
  });
}

test('another independent device applies the shared order while retaining its host, recent filter and draft', async ({ browser, baseURL }) => {
  const backend = new HostOrderBackend();
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } })));
  try {
    const devices: { page: Page; mock: MockCodex }[] = [];
    for (const context of contexts) {
      const page = await context.newPage(), mock = new MockCodex();
      populate(mock);
      await mock.install(page);
      await backend.install(page, mock);
      await login(page);
      devices.push({ page, mock });
    }
    const [a, b] = devices as [{ page: Page; mock: MockCodex }, { page: Page; mock: MockCodex }];
    await a.page.evaluate(() => localStorage.setItem('host-order-device-proof', 'only-device-a'));
    expect(await b.page.evaluate(() => localStorage.getItem('host-order-device-proof'))).toBeNull();
    await openChat(a.page, 'ssh-nas');
    await input(a.page).fill('设备 A 的 NAS 草稿');
    await openChat(b.page, 'ssh-rtx');
    await input(b.page).fill('设备 B 的 RTX 草稿');
    await filters(b.page).filter({ hasText: /^RTX4090x8$/ }).click();
    const sockets = socketCounts(b.mock);
    const settings = await connections(a.page);
    await settings.getByRole('button', { name: '上移 NAS', exact: true }).click();
    for (const { page } of devices) await expect(filters(page)).toHaveText(['全部', 'NAS', '本机', 'RTX4090x8']);
    await expect(filters(b.page).filter({ hasText: /^RTX4090x8$/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(b.page.locator('.header-host')).toHaveText('RTX4090x8');
    await expect(b.page.locator('.main-header')).toContainText('RTX4090x8 历史');
    await expect(input(b.page)).toHaveValue('设备 B 的 RTX 草稿');
    expect(socketCounts(b.mock)).toEqual(sockets);
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(input(a.page)).toHaveValue('设备 A 的 NAS 草稿');
    for (const { mock } of devices) expectNoModelCalls(mock);
    await connections(b.page);
    await expect(rows(b.page)).toHaveText(['NAS', '本机', 'RTX4090x8']);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
