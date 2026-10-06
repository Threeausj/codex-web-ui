import type { Page } from "@playwright/test";
import { test, expect, login, MockCodex } from "./fixtures";

const section = (page: Page, name: string) => page.locator(`[data-section="${name}"]`);
const group = (page: Page, hostId = "local", path = "/workspace/demo") =>
  page.locator(`.nav-project-group[data-host-id="${hostId}"][data-project-path="${path}"]`);
const paths = (locator: ReturnType<typeof section>) =>
  locator.locator(".nav-project-group").evaluateAll((nodes) =>
    nodes.map((node) => `${node.getAttribute("data-host-id")}:${node.getAttribute("data-project-path")}`),
  );
function projectList(mock: MockCodex, count: number, hostId = "local") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${hostId}-project-${index + 1}`,
    name: `${hostId === "local" ? "本地" : "远端"}项目 ${index + 1}`,
    path: index ? `/workspace/project-${index + 1}` : "/workspace/demo",
    hostId,
    source: "web",
  }));
}
function chatList(mock: MockCodex, count: number, prefix = "本地") {
  const original = mock.threads[0];
  const turns = mock.turns.get(original.id)!;
  mock.threads = Array.from({ length: count }, (_, index) => ({
    ...original,
    id: `chat-${index + 1}`,
    name: `${prefix}对话 ${index + 1}`,
    preview: `${prefix}对话 ${index + 1}`,
    createdAt: 1791200000 - index * 60,
    updatedAt: 1791200000 - index * 60,
    recencyAt: 1791200000 - index * 60,
  }));
  mock.turns = new Map(mock.threads.map((thread) => [thread.id, structuredClone(turns)]));
}
function addRemote(mock: MockCodex, count = 6) {
  const remote = new MockCodex();
  chatList(remote, count, "远端");
  mock.hosts.push({ id: "ssh-overflow", name: "远端工作机", kind: "ssh", cwd: "/workspace/demo" });
  mock.hostMocks.set("ssh-overflow", remote);
  return remote;
}

test("pinned and ordinary project lists each show four, expand independently, and keep pinned chats", async ({ page, mock }) => {
  mock.projects = projectList(mock, 12);
  mock.preferences.pins = [
    ...mock.projects.slice(0, 6).map((project) => ({ hostId: "local", kind: "project", id: project.path })),
    { hostId: "local", kind: "thread", id: "thread-existing" },
  ];
  await login(page);
  const pinned = section(page, "pinned");
  const ordinary = section(page, "projects");
  await expect(pinned.locator(".nav-project-group")).toHaveCount(4);
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(4);
  await expect(pinned.locator(".nav-thread:not(.nested)")).toHaveCount(1);
  await pinned.getByRole("button", { name: "显示另外 2 个置顶项目", exact: true }).click();
  await expect(pinned.locator(".nav-project-group")).toHaveCount(6);
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(4);
  await ordinary.getByRole("button", { name: "显示另外 2 个项目", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(6);
  await page.getByRole("button", { name: "刷新对话", exact: true }).click();
  await expect(pinned.locator(".nav-project-group")).toHaveCount(6);
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(6);
  await pinned.getByRole("button", { name: "收起置顶项目", exact: true }).click();
  await ordinary.getByRole("button", { name: "收起项目", exact: true }).click();
  await expect(pinned.locator(".nav-project-group")).toHaveCount(4);
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(4);
  expect(mock.preferences.collapsed).toEqual({});
  await page.getByRole("combobox", { name: "新对话项目", exact: true }).selectOption("/workspace/project-6");
  await expect(pinned.locator(".nav-project-group")).toHaveCount(4);
  await expect(pinned.locator('.nav-project-group[data-project-path="/workspace/project-6"]')).toBeVisible();
  await page.getByRole("button", { name: "折叠项目", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "展开项目", exact: true })).toBeVisible();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(0);
  await page.getByRole("button", { name: "展开项目", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(4);
  await expect(pinned.locator(".nav-project-group")).toHaveCount(4);
});

test("each project's four-chat limit keeps the active chat and separates matching IDs on different hosts", async ({ page, mock }) => {
  chatList(mock, 6);
  addRemote(mock);
  mock.projects.push({ ...mock.projects[0], id: "remote-demo", hostId: "ssh-overflow", name: "远端项目" });
  delete mock.projects[0].hostId;
  await login(page);
  const local = group(page);
  const remote = group(page, "ssh-overflow");
  await expect(local.locator(".nav-thread")).toHaveCount(4);
  await expect(remote.locator(".nav-thread")).toHaveCount(4);
  await local.getByRole("button", { name: "显示另外 2 个对话", exact: true }).click();
  await expect(local.locator(".nav-thread")).toHaveCount(6);
  await expect(remote.locator(".nav-thread")).toHaveCount(4);
  await page.getByRole("button", { name: "刷新对话", exact: true }).click();
  await expect(local.locator(".nav-thread")).toHaveCount(6);
  await local.getByRole("button", { name: "收起对话", exact: true }).click();
  await section(page, "recent").locator('[data-host-id="local"] .thread-row').filter({ hasText: "本地对话 6" }).click();
  await expect(local.locator(".nav-thread")).toHaveCount(4);
  await expect(local.locator(".nav-thread.active .thread-title")).toHaveText("本地对话 6");
  await expect(local.locator(".thread-title")).toHaveText(["本地对话 1", "本地对话 2", "本地对话 3", "本地对话 6"]);
  await expect(remote.locator(".thread-title")).toHaveText(["远端对话 1", "远端对话 2", "远端对话 3", "远端对话 4"]);
  await remote.getByRole("button", { name: "显示另外 2 个对话", exact: true }).click();
  await expect(remote.locator(".nav-thread")).toHaveCount(6);
  await remote.getByRole("button", { name: "收起对话", exact: true }).click();
  await section(page, "recent").locator('[data-host-id="ssh-overflow"] .thread-row').filter({ hasText: "远端对话 6" }).click();
  await expect(remote.locator(".nav-thread.active .thread-title")).toHaveText("远端对话 6");
  await expect(remote.locator(".nav-thread")).toHaveCount(4);
  await expect(local.locator(".thread-title")).toHaveText(["本地对话 1", "本地对话 2", "本地对话 3", "本地对话 4"]);
  expect(mock.preferences.collapsed).toEqual({});
});

test("an active project outside the first four occupies one slot with its own host", async ({ page, mock }) => {
  addRemote(mock, 1);
  mock.projects = [...projectList(mock, 6), ...projectList(mock, 6, "ssh-overflow")];
  await login(page);
  const ordinary = section(page, "projects");
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(4);
  await page.getByRole("combobox", { name: "新对话主机", exact: true }).selectOption("ssh-overflow");
  await expect(page.getByRole("combobox", { name: "新对话项目", exact: true })).toBeEnabled();
  await expect.poll(() => paths(ordinary)).toEqual([
    "local:/workspace/demo", "local:/workspace/project-2", "local:/workspace/project-3", "ssh-overflow:/workspace/demo",
  ]);
  await page.getByRole("combobox", { name: "新对话项目", exact: true }).selectOption("/workspace/project-6");
  await expect.poll(() => paths(ordinary)).toEqual([
    "local:/workspace/demo", "local:/workspace/project-2", "local:/workspace/project-3", "ssh-overflow:/workspace/project-6",
  ]);
  await expect(ordinary.locator(".nav-project-header.active .project-row")).toContainText("远端项目 6");
  await ordinary.getByRole("button", { name: "显示另外 8 个项目", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(12);
  await ordinary.getByRole("button", { name: "收起项目", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(4);
  await expect(group(page, "ssh-overflow", "/workspace/project-6")).toBeVisible();
});

test("project additions and removals keep a manually expanded list and update its hidden count", async ({ page, mock }) => {
  mock.projects = projectList(mock, 6);
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const body = route.request().postDataJSON();
    mock.projects = mock.projects.filter((project) => project.path !== body.path || project.hostId !== body.hostId);
    await route.fulfill({ json: { projects: mock.projects } });
  });
  await login(page);
  const ordinary = section(page, "projects");
  await ordinary.getByRole("button", { name: "显示另外 2 个项目", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(6);
  await ordinary.getByRole("button", { name: "添加项目", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("textbox", { name: "项目路径", exact: true }).fill("/workspace/added-project");
  await settings.getByPlaceholder("我的项目").fill("新增项目");
  await settings.locator(".settings-form").getByRole("button", { name: "添加项目", exact: true }).click();
  await expect.poll(() => mock.projects.length).toBe(7);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(7);
  await group(page, "local", "/workspace/project-2").getByRole("button", { name: "本地项目 2 项目操作", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "移除项目", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(6);
  await expect(group(page, "local", "/workspace/project-2")).toHaveCount(0);
  await ordinary.getByRole("button", { name: "收起项目", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(4);
  await expect(ordinary.getByRole("button", { name: "显示另外 2 个项目", exact: true })).toBeVisible();
  await expect(group(page, "local", "/workspace/added-project")).toBeVisible();
});

for (const initiallyLoaded of [2, 6]) {
  test(`project history pagination remains accessible with ${initiallyLoaded} loaded chats and keeps newly loaded chats visible`, async ({ page, mock }) => {
    chatList(mock, initiallyLoaded + 3);
    await page.routeWebSocket(/\/api\/rpc(?:\?|$)/, (socket) => {
      mock.sockets.push(socket);
      socket.onMessage((raw) => {
        const request = JSON.parse(raw.toString());
        if (request.method !== "thread/list") return (mock as any).receive(socket, request);
        mock.requests.push(request);
        const p = request.params || {};
        const projectQuery = Array.isArray(p.cwd) && p.cwd.includes("/workspace/demo");
        socket.send(JSON.stringify({ id: request.id, result: {
          data: p.cursor ? mock.threads.slice(initiallyLoaded) : mock.threads.slice(0, initiallyLoaded),
          nextCursor: projectQuery && !p.cursor ? "older-project-chats" : null,
        } }));
      });
      socket.send(JSON.stringify({ method: "bridge/status", params: { connected: true, hostId: "local", mode: "spawn", pendingRequests: [], clientId: "fixture-client" } }));
    });
    await login(page);
    const project = group(page);
    await expect(project.locator(".nav-thread")).toHaveCount(Math.min(4, initiallyLoaded));
    const older = project.getByRole("button", { name: "加载项目旧对话", exact: true });
    if (initiallyLoaded > 4) {
      await expect(older).toHaveCount(0);
      await project.getByRole("button", { name: "显示另外 2 个对话", exact: true }).click();
      await expect(project.locator(".nav-thread")).toHaveCount(initiallyLoaded);
    }
    await expect(older).toBeVisible();
    await older.click();
    await expect(project.locator(".nav-thread")).toHaveCount(initiallyLoaded + 3);
    await expect(older).toHaveCount(0);
    const request = mock.requests.find((request) => request.method === "thread/list" && request.params?.cursor === "older-project-chats");
    expect(request?.params.cwd).toEqual(["/workspace/demo"]);
    await project.getByRole("button", { name: "收起对话", exact: true }).click();
    await expect(project.locator(".nav-thread")).toHaveCount(4);
    await expect(project.getByRole("button", { name: `显示另外 ${initiallyLoaded - 1} 个对话`, exact: true })).toBeVisible();
  });
}

test("mobile overflowing project and chat lists expand and shrink without horizontal overflow", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  chatList(mock, 6);
  mock.projects = projectList(mock, 6);
  mock.projects.forEach((project) => { project.name += " 很长的项目名称".repeat(8); });
  await login(page);
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  const ordinary = section(page, "projects");
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(4);
  await ordinary.getByRole("button", { name: "显示另外 2 个项目", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(6);
  const project = group(page);
  await project.getByRole("button", { name: "显示另外 2 个对话", exact: true }).click();
  await expect(project.locator(".nav-thread")).toHaveCount(6);
  await expect(project.getByRole("button", { name: "收起对话", exact: true })).toHaveAttribute("aria-expanded", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await project.getByRole("button", { name: "收起对话", exact: true }).click();
  await ordinary.getByRole("button", { name: "收起项目", exact: true }).click();
  await expect(ordinary.locator(".nav-project-group")).toHaveCount(4);
  await expect(project.locator(".nav-thread")).toHaveCount(4);
});
