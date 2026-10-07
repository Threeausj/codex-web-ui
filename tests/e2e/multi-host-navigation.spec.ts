import { test, expect, login, MockCodex } from "./fixtures";

function remoteFixture(mock: MockCodex) {
  const remote = new MockCodex();
  remote.threads[0] = {
    ...remote.threads[0],
    name: "远程项目历史",
    preview: "远程项目历史",
  };
  remote.turns.get("thread-existing")![0].items[1].text = "远程会话内容";
  mock.hosts.push({
    id: "ssh-test",
    name: "开发服务器",
    kind: "ssh",
    hostname: "server.invalid",
    cwd: "/workspace/demo",
  });
  mock.projects.push({
    ...mock.projects[0],
    id: "remote-project",
    hostId: "ssh-test",
    name: "Remote Project",
  });
  mock.hostMocks.set("ssh-test", remote);
  return remote;
}
const recent = (page: any) => page.locator('[data-section="recent"]');

test("all hosts share navigation, same IDs and paths remain isolated, switching preserves local drafts", async ({
  page,
  mock,
}) => {
  const remote = remoteFixture(mock);
  await login(page);
  await expect(
    page.locator('.nav-project-group[data-host-id="local"] .host-badge'),
  ).toHaveText("本机");
  await expect(
    page.locator('.nav-project-group[data-host-id="ssh-test"] .host-badge'),
  ).toHaveText("开发服务器");
  await expect(
    page.locator('.nav-project-group[data-host-id="local"] .thread-title'),
  ).toHaveText("已有测试历史");
  await expect(
    page.locator('.nav-project-group[data-host-id="ssh-test"] .thread-title'),
  ).toHaveText("远程项目历史");
  await recent(page).locator('[data-host-id="local"] .thread-row').click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await page
    .getByRole("textbox", { name: "消息输入框", exact: true })
    .fill("本机草稿");
  await recent(page).locator('[data-host-id="ssh-test"] .thread-row').click();
  await expect(page.locator(".agent-message")).toContainText("远程会话内容");
  await expect(page.locator(".header-host")).toHaveText("开发服务器");
  await expect(page.locator(".nav-project-group")).toHaveCount(2);
  await expect(
    page.getByRole("textbox", { name: "消息输入框", exact: true }),
  ).toHaveValue("");
  expect(remote.request("thread/resume")?.params.threadId).toBe(
    "thread-existing",
  );
  await page.getByRole("button", { name: "折叠项目", exact: true }).click();
  await recent(page).locator('[data-host-id="local"] .thread-row').click();
  await expect(
    page.getByRole("button", { name: "展开项目", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "消息输入框", exact: true }),
  ).toHaveValue("本机草稿");
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
});

test("pin, search and archive target the row's host without replacing the active local chat", async ({
  page,
  mock,
}) => {
  const remote = remoteFixture(mock);
  await login(page);
  await recent(page).locator('[data-host-id="local"] .thread-row').click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await recent(page).locator('[data-host-id="ssh-test"] .nav-row-menu').click();
  await page.getByRole("button", { name: "置顶对话", exact: true }).click();
  await expect.poll(() => mock.preferences.pins[0]?.hostId).toBe("ssh-test");
  await expect(
    page.locator('[data-section="pinned"] .nav-thread .host-badge'),
  ).toHaveText("开发服务器");
  await page
    .getByRole("textbox", { name: "搜索对话", exact: true })
    .fill("远程会话内容");
  await expect(page.locator(".nav-search-results .thread-row")).toHaveCount(1);
  await expect(page.locator(".nav-search-results .host-badge")).toHaveText(
    "开发服务器",
  );
  await page.locator(".nav-search-results .nav-row-menu").click();
  await page.getByRole("button", { name: "归档对话", exact: true }).click();
  await expect.poll(() => remote.archivedThreads.length).toBe(1);
  expect(mock.archivedThreads).toHaveLength(0);
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(page.locator(".header-host")).toHaveText("本机");
  await page.getByRole("button", { name: "返回会话导航", exact: true }).click();
  await page.getByRole("button", { name: "已归档对话", exact: true }).click();
  await expect(page.locator(".nav-search-results .thread-row")).toHaveCount(1);
  await page.locator(".nav-search-results .nav-row-menu").click();
  await page.getByRole("button", { name: "恢复对话", exact: true }).click();
  await expect.poll(() => remote.archivedThreads.length).toBe(0);
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
});

test("host status strip is removed while remote projects, local chat and mobile typography remain usable", async ({
  page,
  mock,
}) => {
  remoteFixture(mock);
  await page.route("**/api/navigation/ssh-test", (route) =>
    route.fulfill({ status: 502, json: { error: "SSH connection refused" } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await expect(page.getByRole('navigation', { name: '会话导航' }).getByLabel('主机状态')).toHaveCount(0);
  await expect(page.locator('.nav-project-group[data-host-id="ssh-test"] .host-badge')).toHaveText('开发服务器');
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await recent(page).locator('[data-host-id="local"] .thread-row').click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(page.locator(".header-host")).toHaveText("本机");
  const metrics = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    body: parseFloat(
      getComputedStyle(document.querySelector(".agent-message")!).fontSize,
    ),
    model: parseFloat(
      getComputedStyle(document.querySelector(".model-select select")!)
        .fontSize,
    ),
    input: parseFloat(
      getComputedStyle(document.querySelector(".composer textarea")!).fontSize,
    ),
  }));
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.body).toBeGreaterThanOrEqual(14);
  expect(metrics.model).toBeGreaterThanOrEqual(12);
  expect(metrics.input).toBe(16);
});

test("a slow remote connection can be cancelled without resuming its ID on the local host", async ({
  page,
  mock,
}) => {
  const remote = remoteFixture(mock);
  await page.routeWebSocket(/\/api\/rpc\?host=ssh-test(?:&|$)/, (socket) => {
    socket.onMessage(() => {}); // Deliberately never reports connected.
  });
  await login(page);
  await recent(page).locator('[data-host-id="ssh-test"] .thread-row').click();
  await expect(
    page.getByRole("combobox", { name: "选择主机", exact: true }),
  ).toHaveValue("ssh-test");
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await expect(input).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
  await recent(page).locator('[data-host-id="local"] .thread-row').click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(page.locator(".header-host")).toHaveText("本机");
  expect(remote.request("thread/resume")).toBeUndefined();
  await input.fill("本机恢复可发送");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".error-banner")).toHaveCount(0);
});

test("manual refresh removes an externally archived remote thread from loaded project pages", async ({
  page,
  mock,
}) => {
  const remote = remoteFixture(mock);
  await login(page);
  await expect(
    page.locator('.nav-project-group[data-host-id="ssh-test"] .thread-title'),
  ).toHaveText("远程项目历史");
  remote.archivedThreads.push(...remote.threads);
  remote.threads = [];
  await page.getByRole("button", { name: "刷新对话", exact: true }).click();
  await expect(
    page.locator('.nav-project-group[data-host-id="ssh-test"] .nav-thread'),
  ).toHaveCount(0);
  await expect(recent(page).locator('[data-host-id="ssh-test"]')).toHaveCount(
    0,
  );
  await expect(
    page.locator('.nav-project-group[data-host-id="local"] .thread-title'),
  ).toHaveText("已有测试历史");
});

test("a connected remote cannot send with the previous host's permissions before its config is ready", async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  remote.holdConfigReadResponse = true;
  await login(page);
  await page.getByRole('combobox', { name: '选择权限', exact: true }).selectOption('danger-full-access');
  await recent(page).locator('[data-host-id="ssh-test"] .thread-row').click();
  await expect.poll(() => remote.request('config/read')?.method).toBe('config/read');
  await expect(page.getByRole('heading', { name: '远程项目历史', exact: true })).toBeVisible();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.locator('.empty-conversation')).toHaveCount(0);
  await expect(page.locator('.agent-message')).toContainText('远程会话内容');
  expect(remote.request('thread/resume')).toBeUndefined();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await expect(input).toBeEnabled();
  await input.fill('等远程配置完成后发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '选择权限', exact: true })).toBeDisabled();
  expect(remote.request('turn/start')).toBeUndefined();
  remote.releaseConfigReadResponse();
  await expect(page.locator('.agent-message')).toContainText('远程会话内容');
  await input.fill('远程权限已经加载');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.getByRole('combobox', { name: '选择权限', exact: true })).not.toHaveValue('danger-full-access');
});

test('remote cached history paints before the replacement transport connects, without showing welcome or another host history', async ({ page, mock }) => {
  remoteFixture(mock);
  await login(page);
  await recent(page).locator('[data-host-id="ssh-test"] .thread-row').click();
  await expect(page.locator('.agent-message')).toContainText('远程会话内容');
  await recent(page).locator('[data-host-id="local"] .thread-row').click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  await page.routeWebSocket(/\/api\/rpc\?host=ssh-test(?:&|$)/, socket => {
    socket.onMessage(() => {});
  });
  await recent(page).locator('[data-host-id="ssh-test"] .thread-row').click();
  await expect(page.getByRole('heading', { name: '远程项目历史', exact: true })).toBeVisible();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.locator('.agent-message')).toContainText('远程会话内容');
  await expect(page.locator('.agent-message')).not.toContainText('历史保持可读');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
});

test('slow account, quota and model metadata do not delay a remote writer or sending', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  const receive = (remote as any).receive.bind(remote);
  (remote as any).receive = (socket: any, request: any) => {
    if (['account/read', 'account/rateLimits/read', 'model/list', 'permissionProfile/list', 'skills/list'].includes(request.method))
      remote.requests.push(request);
    else receive(socket, request);
  };
  await login(page);
  await recent(page).locator('[data-host-id="ssh-test"] .thread-row').click();
  await expect(page.locator('.agent-message')).toContainText('远程会话内容');
  await expect(page.locator('.welcome')).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('辅助查询仍在等待，正常发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(remote.request('thread/resume')?.params.threadId).toBe('thread-existing');
  expect(remote.request('account/read')).toBeDefined();
});

test('a failed remote permission check keeps the selected conversation readable and never grants a writer', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  const receive = (remote as any).receive.bind(remote);
  (remote as any).receive = (socket: any, request: any) => {
    if (request.method === 'configRequirements/read') {
      remote.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: 'Managed permissions unavailable' } }));
    } else receive(socket, request);
  };
  await login(page);
  await recent(page).locator('[data-host-id="ssh-test"] .thread-row').click();
  await expect(page.getByRole('heading', { name: '远程项目历史', exact: true })).toBeVisible();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.locator('.global-error')).toContainText('Managed permissions unavailable');
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('检查失败时保留草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  expect(remote.request('thread/resume')).toBeUndefined();
  await recent(page).locator('[data-host-id="ssh-test"] .thread-row').click();
  await expect.poll(() => remote.requests.filter(request => request.method === 'configRequirements/read').length).toBe(2);
  expect(remote.request('thread/resume')).toBeUndefined();
});

test('a cold thread with slow native history shows its own loading view immediately', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  const receive = (remote as any).receive.bind(remote);
  const held: { socket: any; request: any }[] = [];
  let holding = true;
  await login(page);
  await expect(recent(page).locator('[data-host-id="ssh-test"] .thread-row')).toBeVisible();
  (remote as any).receive = (socket: any, request: any) => {
    if (holding && ['thread/resume', 'thread/turns/list'].includes(request.method)) {
      remote.requests.push(request);
      held.push({ socket, request });
    } else receive(socket, request);
  };
  await recent(page).locator('[data-host-id="local"] .thread-row').click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  await recent(page).locator('[data-host-id="ssh-test"] .thread-row').click();
  await expect(page.getByRole('heading', { name: '远程项目历史', exact: true })).toBeVisible();
  await expect(page.locator('.conversation-loading')).toHaveText('正在加载会话…');
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.locator('.agent-message')).toHaveCount(0);
  holding = false;
  for (const entry of held) receive(entry.socket, entry.request);
  await expect(page.locator('.agent-message')).toContainText('远程会话内容');
  await expect(page.locator('.conversation-loading')).toHaveCount(0);
});
