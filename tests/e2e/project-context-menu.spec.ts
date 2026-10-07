import { test, expect, login, MockCodex } from "./fixtures";

const localRow = (page: any) =>
  page.locator('.nav-project-group[data-host-id="local"] .project-row').first();
const projectMenu = (page: any) =>
  page.getByRole("menu", { name: "Demo Project 项目菜单", exact: true });

test("project right-click and action button share a keyboard-accessible menu", async ({
  page,
  mock,
}) => {
  await login(page);
  const row = localRow(page);
  await row.click({ button: "right" });
  const menu = projectMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "置顶项目",
    "编辑",
    "在工作区文件中显示",
    "归档聊天",
    "移除项目",
  ]);
  expect(mock.request("thread/resume")).toBeUndefined();
  await expect(
    menu.getByRole("menuitem", { name: "置顶项目", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "编辑", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Demo Project 项目操作", exact: true })
    .click();
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "置顶项目", exact: true }).click();
  await expect
    .poll(() => mock.preferences.pins[0])
    .toMatchObject({
      kind: "project",
      hostId: "local",
      id: "/workspace/demo",
    });
  await expect(menu).toHaveCount(0);
  await page
    .locator('[data-section="pinned"]')
    .getByRole("button", { name: "Demo Project 项目操作", exact: true })
    .click();
  await expect(
    menu.getByRole("menuitem", { name: "取消置顶", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "搜索对话", exact: true }).click();
  await expect(menu).toHaveCount(0);
});

test("mobile project menu stays inside screen edges and closes on tab or resize", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await localRow(page).dispatchEvent("contextmenu", {
    clientX: 388,
    clientY: 842,
    bubbles: true,
  });
  const menu = projectMenu(page);
  await expect(menu).toBeVisible();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(382);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(836);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await page
    .getByRole("button", { name: "Demo Project 项目操作", exact: true })
    .click();
  await expect(menu).toBeVisible();
  await page.setViewportSize({ width: 420, height: 844 });
  await expect(menu).toHaveCount(0);
});

test("conversation scrolling preserves a project menu while scrolling its sidebar anchor closes it", async ({ page, mock }) => {
  mock.turns.get("thread-existing")![0].items.at(-1).text = Array.from({ length: 100 }, (_, index) => `较长的历史回复 ${index}`).join("\n\n");
  const original = mock.threads[0];
  mock.threads.push(...Array.from({ length: 20 }, (_, index) => ({ ...original, id: `scroll-menu-${index}`, name: `侧栏对话 ${index}` })));
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: "已有测试历史" }).click();
  await expect(page.getByRole("button", { name: "编辑消息", exact: true })).toBeVisible();
  const row = localRow(page);
  await row.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Demo Project 项目操作", exact: true }).click();
  const menu = projectMenu(page);
  await expect(menu).toBeVisible();
  const sidebar = page.locator(".sidebar-scroll");
  // Browser scroll notifications are queued. A notification from the
  // pointer's preceding scrollIntoView must not dismiss the newly opened menu
  // when the anchor has already reached its final position.
  await sidebar.dispatchEvent("scroll");
  await expect(menu).toBeVisible();
  const conversation = page.locator(".conversation-scroll");
  const previousConversation = await conversation.evaluate((element) => element.scrollTop);
  await conversation.evaluate((element) => { element.scrollTop = element.scrollTop > 20 ? 10 : 40; });
  await expect.poll(() => conversation.evaluate((element) => element.scrollTop)).not.toBe(previousConversation);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "归档聊天", exact: true })).toBeVisible();
  const previousSidebar = await sidebar.evaluate((element) => element.scrollTop);
  await sidebar.evaluate((element) => { element.scrollTop += 50; });
  await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).not.toBe(previousSidebar);
  await expect(menu).toHaveCount(0);
});

test("showing a remote project opens its host's workspace files without resuming local history", async ({
  page,
  mock,
}) => {
  const remote = new MockCodex();
  mock.hosts.push({
    id: "ssh-project",
    name: "远程开发机",
    kind: "ssh",
    hostname: "server.invalid",
  });
  mock.projects.push({
    ...mock.projects[0],
    id: "remote-project",
    name: "Remote Project",
    hostId: "ssh-project",
  });
  mock.hostMocks.set("ssh-project", remote);
  await login(page);
  await page
    .locator('.nav-project-group[data-host-id="ssh-project"] .project-row')
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "在工作区文件中显示", exact: true })
    .click();
  await expect(page.locator(".header-host")).toHaveText("远程开发机");
  await expect(page.locator(".workspace-panel")).toBeVisible();
  await expect
    .poll(() => remote.request("fs/readDirectory")?.params.path)
    .toBe("/workspace/demo");
  expect(mock.request("thread/resume")).toBeUndefined();
});

test("editing an imported local project preserves the active remote chat and saves only its project scope", async ({
  page,
  mock,
}) => {
  const remote = new MockCodex();
  remote.turns.get("thread-existing")![0].items[1].text = "远程聊天保持显示";
  mock.hosts.push({
    id: "ssh-editor",
    name: "远程编辑机",
    kind: "ssh",
    hostname: "server.invalid",
  });
  mock.projects[0].rootPaths = ["/workspace/demo", "/workspace/old-root"];
  mock.projects.push({
    ...mock.projects[0],
    id: "remote-edit",
    name: "Remote Project",
    hostId: "ssh-editor",
  });
  mock.hostMocks.set("ssh-editor", remote);
  const edits: any[] = [];
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const fields = route.request().postDataJSON();
    edits.push(fields);
    mock.projects = mock.projects.map((project) =>
      project.hostId === fields.hostId && project.path === fields.path
        ? { ...project, ...fields, source: "web" }
        : project,
    );
    await route.fulfill({
      json: {
        project: mock.projects.find(
          (project) =>
            project.hostId === fields.hostId && project.path === fields.path,
        ),
        projects: mock.projects,
      },
    });
  });
  await login(page);
  await page
    .locator('[data-section="recent"] [data-host-id="ssh-editor"] .thread-row')
    .click();
  await expect(page.locator(".agent-message")).toContainText(
    "远程聊天保持显示",
  );
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.fill("保留远程草稿");
  const resumes = remote.requests.filter(
    (request) => request.method === "thread/resume",
  ).length;
  await localRow(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑项目", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "项目目录", exact: true }),
  ).toHaveValue("/workspace/demo");
  await expect(
    dialog.getByRole("textbox", { name: "项目目录", exact: true }),
  ).toHaveAttribute("readonly", "");
  await expect(
    dialog.getByRole("textbox", { name: "其他工作目录", exact: true }),
  ).toHaveValue("/workspace/old-root");
  await dialog
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill("本机项目新名称");
  await dialog
    .getByRole("textbox", { name: "其他工作目录", exact: true })
    .fill("/workspace/shared\n/workspace/assets");
  await dialog.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(edits).toEqual([
    {
      hostId: "local",
      path: "/workspace/demo",
      name: "本机项目新名称",
      rootPaths: ["/workspace/demo", "/workspace/shared", "/workspace/assets"],
    },
  ]);
  await expect(localRow(page)).toContainText("本机项目新名称");
  await expect(page.locator(".header-host")).toHaveText("远程编辑机");
  await expect(page.locator(".agent-message")).toContainText(
    "远程聊天保持显示",
  );
  await expect(input).toHaveValue("保留远程草稿");
  expect(
    remote.requests.filter((request) => request.method === "thread/resume"),
  ).toHaveLength(resumes);
  expect(mock.request("thread/resume")).toBeUndefined();
  expect(
    mock.projects.find((project) => project.hostId === "ssh-editor")?.name,
  ).toBe("Remote Project");
});

test("project removal can be cancelled, then persists across reload while preserving chats and another host's project pin", async ({
  page,
  mock,
}) => {
  const remote = new MockCodex();
  mock.hosts.push({
    id: "ssh-removal",
    name: "远程保留机",
    kind: "ssh",
    hostname: "server.invalid",
  });
  mock.projects.push({
    ...mock.projects[0],
    id: "remote-removal",
    name: "Remote Project",
    hostId: "ssh-removal",
  });
  mock.hostMocks.set("ssh-removal", remote);
  mock.preferences.pins = [
    {
      kind: "project",
      id: "/workspace/demo",
      hostId: "local",
      label: "Demo Project",
    },
    {
      kind: "project",
      id: "/workspace/demo",
      hostId: "ssh-removal",
      label: "Remote Project",
    },
  ];
  const removals: any[] = [];
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const fields = route.request().postDataJSON();
    removals.push(fields);
    mock.projects = mock.projects.filter(
      (project) =>
        project.hostId !== fields.hostId || project.path !== fields.path,
    );
    await route.fulfill({ json: { projects: mock.projects } });
  });
  await login(page);
  await page
    .locator('[data-section="recent"] [data-host-id="local"] .thread-row')
    .click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await localRow(page).click({ button: "right" });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("项目文件和对话会保留");
    await dialog.dismiss();
  });
  await page.getByRole("menuitem", { name: "移除项目", exact: true }).click();
  expect(removals).toHaveLength(0);
  await expect(localRow(page)).toBeVisible();
  await localRow(page).click({ button: "right" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "移除项目", exact: true }).click();
  await expect(
    page.locator('.nav-project-group[data-host-id="local"]'),
  ).toHaveCount(0);
  expect(removals).toEqual([{ hostId: "local", path: "/workspace/demo" }]);
  await expect
    .poll(() => mock.preferences.pins)
    .toEqual([
      {
        kind: "project",
        id: "/workspace/demo",
        hostId: "ssh-removal",
        label: "Remote Project",
      },
    ]);
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  expect(mock.threads).toHaveLength(1);
  expect(mock.archivedThreads).toHaveLength(0);
  await page.reload();
  await expect(
    page.locator('.nav-project-group[data-host-id="local"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('.nav-project-group[data-host-id="ssh-removal"] .project-row'),
  ).toContainText("Remote Project");
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
});

test("project archive includes every page and root only on the chosen host while retaining the current local chat", async ({
  page,
  mock,
}) => {
  const remote = new MockCodex();
  const original = remote.threads[0];
  remote.threads = [
    { ...original, recencyAt: original.createdAt },
    {
      ...original,
      id: "remote-page-two",
      name: "分页对话",
      recencyAt: original.createdAt,
    },
    {
      ...original,
      id: "remote-shared",
      name: "附加目录对话",
      cwd: "/workspace/shared",
      recencyAt: original.createdAt,
    },
    {
      ...original,
      id: "remote-unrelated",
      name: "无关目录对话",
      cwd: "/workspace/unrelated",
      recencyAt: original.createdAt,
    },
  ];
  mock.threads.push({
    ...mock.threads[0],
    id: "local-shared",
    name: "本机附加目录对话",
    cwd: "/workspace/shared",
  });
  mock.hosts.push({
    id: "ssh-archive",
    name: "远程归档机",
    kind: "ssh",
    hostname: "server.invalid",
  });
  mock.projects.push({
    ...mock.projects[0],
    id: "remote-archive",
    name: "Remote Project",
    hostId: "ssh-archive",
    rootPaths: ["/workspace/demo", "/workspace/shared", "/workspace/demo"],
  });
  mock.hostMocks.set("ssh-archive", remote);
  const receiver = (remote as any).receive.bind(remote);
  (remote as any).receive = (socket: any, request: any) => {
    if (request.method !== "thread/list" || request.params?.limit !== 100)
      return receiver(socket, request);
    remote.requests.push(request);
    const candidates = remote.threads.filter(
      (thread) => thread.cwd === request.params.cwd,
    );
    const offset = request.params.cursor ? 1 : 0;
    socket.send(
      JSON.stringify({
        id: request.id,
        result: {
          data: candidates.slice(offset, offset + 1),
          nextCursor:
            offset === 0 && candidates.length > 1 ? "project-next-page" : null,
        },
      }),
    );
  };
  await login(page);
  await page
    .locator('[data-section="recent"] [data-host-id="local"] .thread-row')
    .filter({ hasText: "已有测试历史" })
    .click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  const remoteRow = page.locator(
    '.nav-project-group[data-host-id="ssh-archive"] .project-row',
  );
  await remoteRow.click({ button: "right" });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("menuitem", { name: "归档聊天", exact: true }).click();
  expect(
    remote.requests.filter((request) => request.method === "thread/archive"),
  ).toHaveLength(0);
  await remoteRow.click({ button: "right" });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("包括其他工作目录");
    await dialog.accept();
  });
  await page.getByRole("menuitem", { name: "归档聊天", exact: true }).click();
  await expect
    .poll(() => remote.archivedThreads.map((thread) => thread.id).sort())
    .toEqual(["remote-page-two", "remote-shared", "thread-existing"]);
  expect(
    remote.requests.filter((request) => request.method === "thread/archive"),
  ).toHaveLength(3);
  expect(
    remote.requests
      .filter(
        (request) =>
          request.method === "thread/list" && request.params.limit === 100,
      )
      .map((request) => ({
        cwd: request.params.cwd,
        cursor: request.params.cursor || null,
      })),
  ).toEqual([
    { cwd: "/workspace/demo", cursor: null },
    { cwd: "/workspace/demo", cursor: "project-next-page" },
    { cwd: "/workspace/shared", cursor: null },
  ]);
  expect(remote.threads.map((thread) => thread.id)).toEqual([
    "remote-unrelated",
  ]);
  expect(mock.archivedThreads).toHaveLength(0);
  expect(mock.threads).toHaveLength(2);
  await expect(page.locator(".header-host")).toHaveText("本机");
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
});
