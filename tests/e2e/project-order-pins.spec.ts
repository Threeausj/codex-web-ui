import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';
import { orderProjects, type ProjectOrderEntry } from '../../shared/project-order';

const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const projectNames = (page: Page) => page.locator('[data-section="projects"] .project-row > span:first-of-type');
const identities = (projects: any[]) => projects.map(({ hostId, path }) => ({ hostId: hostId || 'local', path }));
const inventory = [
  { id: 'demo', name: 'First Project', path: '/workspace/demo', hostId: 'local', source: 'web' },
  { id: 'second', name: 'Second Project', path: '/workspace/second', hostId: 'local', source: 'web' },
  { id: 'third', name: 'Third Project', path: '/workspace/third', hostId: 'local', source: 'web' },
];
function populate(mock: MockCodex) { mock.projects = inventory.map(project => ({ ...project })); }
class ProjectOrderBackend {
  order = identities(inventory);
  calls: ProjectOrderEntry[][] = [];
  devices: MockCodex[] = [];
  failNext = false;
  holdNext = false;
  release?: () => void;
  async install(page: Page, mock: MockCodex) {
    this.devices.push(mock); this.apply();
    await page.route('**/api/projects/order', async route => {
      expect(route.request().method()).toBe('PATCH');
      const projects = route.request().postDataJSON().projects as ProjectOrderEntry[];
      this.calls.push(projects);
      if (this.failNext) { this.failNext = false; return route.fulfill({ status: 503, json: { error: '项目顺序暂时无法保存，请重试' } }); }
      this.change(projects);
      const saved = mock.projects.map(project => ({ ...project }));
      if (this.holdNext) { this.holdNext = false; await new Promise<void>(resolve => { this.release = resolve; }); }
      return route.fulfill({ json: { projects: saved } });
    });
  }
  change(order: ProjectOrderEntry[]) {
    this.order = order; this.apply();
    for (const mock of this.devices) mock.emit('bridge/project-order/changed', { projects: order });
  }
  private apply() { for (const mock of this.devices) mock.projects = orderProjects(mock.projects, this.order); }
}
async function sidebar(page: Page) {
  const open = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await open.isVisible()) await open.click();
}
async function projectMenu(page: Page, name: string) {
  await sidebar(page);
  await page.getByRole('button', { name: `${name} 项目操作`, exact: true }).click();
  return page.getByRole('menu', { name: `${name} 项目菜单`, exact: true });
}

test('project menu sorting persists without disturbing the current conversation, draft or socket', async ({ page, mock }) => {
  populate(mock); const backend = new ProjectOrderBackend(); await backend.install(page, mock); await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await input(page).fill('项目排序保留的当前草稿');
  const sockets = mock.sockets.length;
  let menu = await projectMenu(page, 'First Project');
  await expect(menu.getByRole('menuitem', { name: '上移项目 First Project', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  menu = await projectMenu(page, 'Third Project');
  await expect(menu.getByRole('menuitem', { name: '下移项目 Third Project', exact: true })).toBeDisabled();
  await menu.getByRole('menuitem', { name: '上移项目 Third Project', exact: true }).click();
  await expect(projectNames(page)).toHaveText(['First Project', 'Third Project', 'Second Project']);
  menu = await projectMenu(page, 'Third Project');
  await menu.getByRole('menuitem', { name: '上移项目 Third Project', exact: true }).click();
  await expect(projectNames(page)).toHaveText(['Third Project', 'First Project', 'Second Project']);
  await expect(input(page)).toHaveValue('项目排序保留的当前草稿');
  expect(mock.sockets.length).toBe(sockets);
  expect(mock.request('turn/start')).toBeUndefined();
  await page.reload();
  await expect(projectNames(page)).toHaveText(['Third Project', 'First Project', 'Second Project']);
  await expect(input(page)).toHaveValue('项目排序保留的当前草稿');
});

test('failed project saves preserve order and a later shared change beats the earlier save ACK', async ({ page, mock }) => {
  populate(mock); const backend = new ProjectOrderBackend(); await backend.install(page, mock); await login(page);
  backend.failNext = true;
  let menu = await projectMenu(page, 'Third Project');
  await menu.getByRole('menuitem', { name: '上移项目 Third Project', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('项目顺序暂时无法保存');
  await expect(projectNames(page)).toHaveText(['First Project', 'Second Project', 'Third Project']);
  backend.holdNext = true;
  await menu.getByRole('menuitem', { name: '上移项目 Third Project', exact: true }).click();
  await expect(projectNames(page)).toHaveText(['First Project', 'Third Project', 'Second Project']);
  backend.change(identities([inventory[1], inventory[2], inventory[0]]));
  await expect(projectNames(page)).toHaveText(['Second Project', 'Third Project', 'First Project']);
  backend.release!();
  await expect(menu).not.toBeVisible();
  await expect(projectNames(page)).toHaveText(['Second Project', 'Third Project', 'First Project']);
});

test('a delayed project edit refreshes its name without replacing a newer shared project order', async ({ page, mock }) => {
  populate(mock); const backend = new ProjectOrderBackend(); await backend.install(page, mock);
  let release!: () => void, editing = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/projects', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const fields = route.request().postDataJSON();
    mock.projects = mock.projects.map(project => project.path === fields.path && project.hostId === fields.hostId ? { ...project, ...fields } : project);
    const saved = structuredClone(mock.projects);
    editing = true;
    await held;
    return route.fulfill({ json: { projects: saved, project: saved.find(project => project.path === fields.path && project.hostId === fields.hostId) } });
  });
  await login(page);
  await input(page).fill('迟到的项目设置不影响草稿');
  const sockets = mock.sockets.length;
  const menu = await projectMenu(page, 'First Project');
  await menu.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('Renamed First');
  await dialog.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect.poll(() => editing).toBe(true);
  // Another device sorts after the edit's response snapshot was generated.
  backend.change(identities([inventory[2], inventory[1], inventory[0]]));
  await expect(projectNames(page)).toHaveText(['Third Project', 'Second Project', 'First Project']);
  release();
  await expect(dialog).not.toBeVisible();
  await expect(projectNames(page)).toHaveText(['Third Project', 'Second Project', 'Renamed First']);
  await expect(input(page)).toHaveValue('迟到的项目设置不影响草稿');
  expect(mock.sockets.length).toBe(sockets);
  expect(mock.request('turn/start')).toBeUndefined();
  await page.reload();
  await expect(projectNames(page)).toHaveText(['Third Project', 'Second Project', 'Renamed First']);
});

test('shared order never creates unknown projects and the next metadata response places a new project in its saved slot', async ({ page, mock }) => {
  populate(mock); const backend = new ProjectOrderBackend(); await backend.install(page, mock);
  let release!: () => void, editing = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const added = { id: 'new-project', name: 'New Shared Project', path: '/workspace/new', hostId: 'local', source: 'web' };
  await page.route('**/api/projects', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const fields = route.request().postDataJSON();
    mock.projects = [...mock.projects.map(project => project.path === fields.path ? { ...project, ...fields } : project), added];
    const saved = structuredClone(mock.projects);
    editing = true; await held;
    return route.fulfill({ json: { projects: saved } });
  });
  await login(page);
  const menu = await projectMenu(page, 'First Project');
  await menu.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await dialog.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect.poll(() => editing).toBe(true);
  backend.change(identities([inventory[2], added, inventory[1], inventory[0]]));
  await expect(projectNames(page)).toHaveText(['Third Project', 'Second Project', 'First Project']);
  release();
  await expect(dialog).not.toBeVisible();
  await expect(projectNames(page)).toHaveText(['Third Project', 'New Shared Project', 'Second Project', 'First Project']);
});

test('pinned conversations and projects use one activity order, initially show six items, and update live', async ({ page, mock }) => {
  populate(mock);
  const original = mock.threads[0]!;
  mock.threads = Array.from({ length: 7 }, (_, index) => ({ ...original, id: `pin-${index}`, name: `Pinned ${index}`, preview: `Pinned ${index}`, cwd: '/outside', recencyAt: 1791200100 + index * 10 }));
  mock.threads.push({ ...original, id: 'project-latest', cwd: '/workspace/second', name: 'Project latest', recencyAt: 1791200155 });
  mock.preferences.pins = [
    { kind: 'project', hostId: 'local', id: '/workspace/second' },
    ...mock.threads.slice(0, 7).map(thread => ({ kind: 'thread', hostId: 'local', id: thread.id })),
  ];
  for (const project of inventory) mock.preferences.collapsed[`project:local:${project.path}`] = true;
  await login(page);
  const pinned = page.locator('[data-section="pinned"]');
  const rows = () => pinned.locator('.project-row > span:first-of-type, .thread-row > .thread-title');
  await expect(rows()).toHaveText(['Pinned 6', 'Second Project', 'Pinned 5', 'Pinned 4', 'Pinned 3', 'Pinned 2']);
  await pinned.getByRole('button', { name: '显示另外 2 个置顶项', exact: true }).click();
  await expect(rows()).toHaveText(['Pinned 6', 'Second Project', 'Pinned 5', 'Pinned 4', 'Pinned 3', 'Pinned 2', 'Pinned 1', 'Pinned 0']);
  mock.threads[0]!.recencyAt = 1791200200;
  mock.emit('thread/status/changed', { threadId: 'pin-0', status: { type: 'idle' } });
  // Navigation refresh obtains the canonical new activity, rather than using metadata write time.
  await page.getByRole('button', { name: '刷新对话', exact: true }).click();
  await expect(rows()).toHaveText(['Pinned 0', 'Pinned 6', 'Second Project', 'Pinned 5', 'Pinned 4', 'Pinned 3', 'Pinned 2', 'Pinned 1']);
  await pinned.getByRole('button', { name: '收起置顶', exact: true }).click();
  await expect(rows()).toHaveCount(6);
});

test('project order updates an independent browser while preserving its draft and active conversation', async ({ browser, baseURL }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const backend = new ProjectOrderBackend(), mocks: MockCodex[] = [];
  try {
    for (const page of pages) {
      const mock = new MockCodex(); populate(mock); mocks.push(mock);
      await mock.install(page); await backend.install(page, mock); await page.goto(baseURL!); await login(page);
    }
    await pages[1]!.locator('[data-section="recent"] .thread-row').first().click();
    await expect(pages[1]!.getByText('历史保持可读', { exact: true })).toBeVisible();
    await input(pages[1]!).fill('另一个设备自己的草稿');
    const counts = mocks.map(mock => mock.sockets.length);
    const menu = await projectMenu(pages[0]!, 'Second Project');
    await menu.getByRole('menuitem', { name: '上移项目 Second Project', exact: true }).click();
    for (const page of pages) await expect(projectNames(page)).toHaveText(['Second Project', 'First Project', 'Third Project']);
    await expect(input(pages[1]!)).toHaveValue('另一个设备自己的草稿');
    await expect(pages[1]!.getByText('历史保持可读', { exact: true })).toBeVisible();
    expect(mocks.map(mock => mock.sockets.length)).toEqual(counts);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('mobile project order menu has clear boundaries and touch sized controls', async ({ page, mock }) => {
  populate(mock); const backend = new ProjectOrderBackend(); await backend.install(page, mock);
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const menu = await projectMenu(page, 'Third Project');
  const up = menu.getByRole('menuitem', { name: '上移项目 Third Project', exact: true });
  expect((await up.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await expect(menu.getByRole('menuitem', { name: '下移项目 Third Project', exact: true })).toBeDisabled();
  await up.click(); await expect(projectNames(page)).toHaveText(['First Project', 'Third Project', 'Second Project']);
  const geometry = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
});
