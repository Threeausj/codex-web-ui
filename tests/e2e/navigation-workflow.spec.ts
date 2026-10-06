import fs from "node:fs/promises";
import { test, expect, login, send } from "./fixtures";

const recent = (page: any) => page.locator('[data-section="recent"]');
const projects = (page: any) => page.locator('[data-section="projects"]');
const pinned = (page: any) => page.locator('[data-section="pinned"]');

test("pinned projects and chats form collapsible trees, and the fold state survives reload", async ({
  page,
  mock,
}) => {
  mock.projects.push({
    id: "other",
    name: "Other Project",
    path: "/workspace/other",
    hostId: "local",
    source: "web",
  });
  mock.threads.push({
    ...mock.threads[0],
    id: "other-thread",
    name: "其他项目历史",
    preview: "其他项目历史",
    cwd: "/workspace/other",
  });
  await login(page);
  expect(
    await page
      .locator("[data-section]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-section")),
      ),
  ).toEqual(["pinned", "projects", "recent"]);
  await expect(
    projects(page)
      .getByRole("button", { name: "其他项目历史", exact: false })
      .first(),
  ).toBeVisible();
  await projects(page)
    .getByRole("button", { name: "Demo Project 项目操作", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "置顶项目", exact: true }).click();
  await expect(
    pinned(page)
      .getByRole("button", { name: "Demo Project", exact: false })
      .first(),
  ).toBeVisible();
  await recent(page)
    .getByRole("button", { name: "已有测试历史 对话操作", exact: true })
    .click();
  await recent(page)
    .getByRole("button", { name: "置顶对话", exact: true })
    .click();
  await expect.poll(() => mock.preferences.pins.length).toBe(2);
  await pinned(page)
    .getByRole("button", { name: "折叠项目 Demo Project", exact: true })
    .click();
  await expect(pinned(page).locator(".nav-project-threads")).toHaveCount(0);
  await page.getByRole("button", { name: "折叠置顶", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "展开置顶", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "展开置顶", exact: true }).click();
  await expect(
    pinned(page).getByRole("button", {
      name: "展开项目 Demo Project",
      exact: true,
    }),
  ).toBeVisible();
  await expect(pinned(page).locator(".nav-thread")).toHaveCount(1);
  await pinned(page)
    .getByRole("button", { name: "展开项目 Demo Project", exact: true })
    .click();
  await pinned(page)
    .locator(".nav-project-threads .thread-row")
    .first()
    .click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  expect(
    mock.requests.some(
      (request) =>
        request.method === "thread/list" && request.params.cwd === undefined,
    ),
  ).toBe(true);
});

test("full-text search, archive recovery and complete markdown export use the selected thread", async ({
  page,
  mock,
}) => {
  await login(page);
  await page
    .getByRole("textbox", { name: "搜索对话", exact: true })
    .fill("历史保持可读");
  await expect(page.locator(".nav-search-results .thread-row")).toHaveCount(1);
  expect(mock.request("thread/search")?.params.searchTerm).toBe("历史保持可读");
  await page.getByRole("button", { name: "返回会话导航", exact: true }).click();
  await recent(page).locator(".thread-row").first().click();
  await page.getByRole("button", { name: "对话操作", exact: true }).click();
  await page.getByRole("button", { name: "归档对话", exact: true }).click();
  await expect.poll(() => mock.archivedThreads.length).toBe(1);
  await page.getByRole("button", { name: "已归档对话", exact: true }).click();
  await expect(page.locator(".nav-search-results .thread-row")).toHaveCount(1);
  await page.locator(".nav-search-results .nav-row-menu").click();
  await page.getByRole("button", { name: "恢复对话", exact: true }).click();
  await expect.poll(() => mock.archivedThreads.length).toBe(0);
  await page.getByRole("button", { name: "返回会话导航", exact: true }).click();
  await recent(page).locator(".thread-row").first().click();
  await page.getByRole("button", { name: "对话操作", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出 Markdown", exact: true })
    .click();
  const download = await downloaded;
  const content = await fs.readFile((await download.path())!, "utf8");
  expect(content).toContain("已有测试问题");
  expect(content).toContain("历史保持可读");
  expect(mock.request("thread/read")?.params.threadId).toBe("thread-existing");
});

test("drafts and scroll positions stay with each chat and the active chat survives reload", async ({
  page,
  mock,
}) => {
  const other = {
    ...mock.threads[0],
    id: "second",
    name: "另一个会话",
    preview: "另一个会话",
  };
  mock.threads.push(other);
  mock.turns.set(other.id, []);
  const turns = mock.turns.get("thread-existing")!;
  turns[0].items[1].text = Array.from(
    { length: 150 },
    (_, index) => `历史段落 ${index}，用于检查滚动位置保持。`,
  ).join("\n\n");
  await login(page);
  await recent(page)
    .locator(".thread-row")
    .filter({ hasText: "已有测试历史" })
    .click();
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.fill("保留在第一个会话的草稿");
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.scrollTop = 140;
  });
  await expect
    .poll(() =>
      page
        .locator(".conversation-scroll")
        .evaluate((element) => element.scrollTop),
    )
    .toBe(140);
  await recent(page)
    .locator(".thread-row")
    .filter({ hasText: "另一个会话" })
    .click();
  await expect(input).toHaveValue("");
  await input.fill("第二个会话草稿");
  await recent(page)
    .locator(".thread-row")
    .filter({ hasText: "已有测试历史" })
    .click();
  await expect(input).toHaveValue("保留在第一个会话的草稿");
  await expect
    .poll(() =>
      page
        .locator(".conversation-scroll")
        .evaluate((element) => element.scrollTop),
    )
    .toBe(140);
  await page.reload();
  await expect(page.locator(".agent-message")).toContainText("历史段落 149");
  await expect(input).toHaveValue("保留在第一个会话的草稿");
  await expect
    .poll(() =>
      page
        .locator(".conversation-scroll")
        .evaluate((element) => element.scrollTop),
    )
    .toBe(140);
});

test("named permission presets and multi-root projects reach actual turn parameters", async ({
  page,
  mock,
}) => {
  await login(page);
  await page.locator(".settings-button").click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "权限预设", exact: true })
    .click();
  await page.getByRole("button", { name: "新建预设", exact: true }).click();
  await page.getByPlaceholder("例如：只读联网研究").fill("联网工作区");
  await page.getByLabel("审批策略", { exact: true }).selectOption("untrusted");
  await page.locator(".settings-form").getByRole("switch").click();
  await page.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect.poll(() => mock.preferences.permissionProfiles.length).toBe(1);
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await page.getByPlaceholder("/home/user/project").fill("/workspace/multi");
  await page.getByPlaceholder("我的项目").fill("多根项目");
  await page
    .getByRole("textbox", { name: "其他工作目录", exact: true })
    .fill("/workspace/shared\n/workspace/assets");
  await page
    .locator(".settings-form")
    .getByRole("button", { name: "添加项目", exact: true })
    .click();
  await expect
    .poll(
      () =>
        mock.projects.find((project) => project.path === "/workspace/multi")
          ?.rootPaths?.length,
    )
    .toBe(2);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await send(page, "使用命名权限和多个工作目录");
  await expect(page.locator(".agent-message")).toContainText("流式回复完成");
  expect(mock.request("thread/start")?.params.runtimeWorkspaceRoots).toEqual([
    "/workspace/multi",
    "/workspace/shared",
    "/workspace/assets",
  ]);
  expect(mock.request("turn/start")?.params).toMatchObject({
    approvalPolicy: "untrusted",
    sandboxPolicy: {
      type: "workspaceWrite",
      networkAccess: true,
      writableRoots: [
        "/workspace/multi",
        "/workspace/shared",
        "/workspace/assets",
      ],
    },
  });
});

test("new draft typed while a send awaits acknowledgement survives the acknowledgement and reload", async ({
  page,
  mock,
}) => {
  await login(page);
  await recent(page).locator(".thread-row").first().click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  mock.holdTurnStartResponse = true;
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.fill("发送这条消息");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(() => mock.request("turn/start")?.params.input[0].text)
    .toBe("发送这条消息");
  await input.fill("这是发送期间的新草稿");
  mock.releaseTurnStartResponse();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(input).toHaveValue("这是发送期间的新草稿");
});
