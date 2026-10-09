import { test, expect, login, MockCodex } from "./fixtures";
import type { Page } from "@playwright/test";

const recent = (page: Page, hostId = "local") =>
  page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"]`).first();
const actionDialog = (page: Page, name: string) => page.getByRole("dialog", { name, exact: true });
async function menuAction(page: Page, row: ReturnType<Page["locator"]>, name: string) {
  await row.locator(".nav-row-menu").click();
  await row.getByRole("button", { name, exact: true }).click();
}
function remoteFixture(mock: MockCodex) {
  const remote = new MockCodex();
  remote.threads[0]!.name = "远程待改名对话";
  mock.hosts.push({ id: "ssh-actions", kind: "ssh", name: "远程测试主机", hostname: "server.invalid" });
  mock.projects.push({ ...mock.projects[0], id: "remote-actions", name: "Remote Project", hostId: "ssh-actions" });
  mock.hostMocks.set("ssh-actions", remote);
  return remote;
}

test("renaming an unopened remote row preserves the current host, conversation and draft", async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page);
  await recent(page).locator(".thread-row").click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await page.getByRole("textbox", { name: "消息输入框", exact: true }).fill("当前会话草稿");
  await menuAction(page, recent(page, "ssh-actions"), "重命名对话");
  const dialog = actionDialog(page, "重命名对话");
  const input = dialog.getByRole("textbox", { name: "对话名称", exact: true });
  await expect(input).toHaveValue("远程待改名对话");
  await expect(input).toBeFocused();
  await input.fill("远程新名称");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(recent(page, "ssh-actions").locator(".thread-title")).toHaveText("远程新名称");
  await expect(page.locator('.nav-project-group[data-host-id="ssh-actions"] .thread-title')).toHaveText("远程新名称");
  await expect(page.locator(".header-host")).toHaveText("本机");
  await expect(page.getByRole("heading", { name: "已有测试历史", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toHaveValue("当前会话草稿");
  expect(remote.request("thread/name/set")?.params).toEqual({ threadId: "thread-existing", name: "远程新名称" });
  expect(remote.request("thread/resume")).toBeUndefined();
  expect(mock.request("thread/name/set")).toBeUndefined();
});

test("renaming the selected conversation updates its heading and rejects empty names", async ({ page }) => {
  await login(page);
  await recent(page).locator(".thread-row").click();
  await menuAction(page, recent(page), "重命名对话");
  const dialog = actionDialog(page, "重命名对话");
  const input = dialog.getByRole("textbox", { name: "对话名称", exact: true });
  await input.fill("   ");
  await expect(dialog.getByRole("button", { name: "保存名称", exact: true })).toBeDisabled();
  await input.fill("  重新命名的会话  ");
  await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "重新命名的会话", exact: true })).toBeVisible();
  await expect(recent(page).locator(".thread-title")).toHaveText("重新命名的会话");
});

test("rename errors keep the edited name for retry and Escape restores opener focus", async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  let fail = true;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== "thread/name/set" || !fail) return receive(socket, request);
    mock.requests.push(request);
    socket.send(JSON.stringify({ id: request.id, error: { code: -32603, message: "保存失败，请重试" } }));
  };
  await login(page);
  await menuAction(page, recent(page), "重命名对话");
  const dialog = actionDialog(page, "重命名对话");
  await dialog.getByRole("textbox", { name: "对话名称", exact: true }).fill("保留输入的名字");
  await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("保存失败，请重试");
  await expect(dialog.getByRole("textbox", { name: "对话名称", exact: true })).toHaveValue("保留输入的名字");
  await expect(recent(page).locator(".thread-title")).toHaveText("已有测试历史");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(recent(page).locator(".nav-row-menu")).toBeFocused();
  fail = false;
});

test("delete requires explicit permanent confirmation and removes all copies of the selected row", async ({ page, mock }) => {
  await login(page);
  await recent(page).locator(".thread-row").click();
  await menuAction(page, recent(page), "删除对话");
  const dialog = actionDialog(page, "删除对话");
  await expect(dialog).toContainText("及其子智能体对话将永久删除，无法恢复");
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  expect(mock.request("thread/delete")).toBeUndefined();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(mock.request("thread/delete")).toBeUndefined();
  await menuAction(page, recent(page), "删除对话");
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".nav-thread")).toHaveCount(0);
  await expect(page.locator(".welcome")).toBeVisible();
  expect(mock.request("thread/delete")?.params).toEqual({ threadId: "thread-existing" });
  expect(mock.request("thread/archive")).toBeUndefined();
});

test("delete errors remain in the confirmation dialog and preserve the conversation", async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== "thread/delete") return receive(socket, request);
    mock.requests.push(request);
    socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: "当前 Codex 版本不支持删除对话，请升级" } }));
  };
  await login(page);
  await menuAction(page, recent(page), "删除对话");
  const dialog = actionDialog(page, "删除对话");
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("升级");
  await expect(dialog.getByRole("button", { name: "永久删除", exact: true })).toBeEnabled();
  await expect(recent(page).locator(".thread-title")).toHaveText("已有测试历史");
  expect(mock.request("thread/archive")).toBeUndefined();
});

test("deleting a remote row with the same thread ID preserves the selected local conversation", async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page);
  await recent(page).locator(".thread-row").click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await page.getByRole("textbox", { name: "消息输入框", exact: true }).fill("保留本机草稿");
  await menuAction(page, recent(page, "ssh-actions"), "删除对话");
  await actionDialog(page, "删除对话").getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(page.locator('.nav-thread[data-host-id="ssh-actions"]')).toHaveCount(0);
  await expect(recent(page).locator(".thread-title")).toHaveText("已有测试历史");
  await expect(page.getByRole("heading", { name: "已有测试历史", exact: true })).toBeVisible();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toHaveValue("保留本机草稿");
  expect(remote.request("thread/delete")?.params.threadId).toBe("thread-existing");
  expect(remote.request("thread/resume")).toBeUndefined();
  expect(mock.request("thread/delete")).toBeUndefined();
  expect(mock.threads).toHaveLength(1);
});

test("archived remote conversations can be renamed and deleted without restoring or selecting them", async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  remote.archivedThreads = remote.threads;
  remote.threads = [];
  await login(page);
  await page.getByRole("button", { name: "已归档对话", exact: true }).click();
  const row = page.locator('.nav-search-results .nav-thread[data-host-id="ssh-actions"]');
  await expect(row).toHaveCount(1);
  await menuAction(page, row, "重命名对话");
  const rename = actionDialog(page, "重命名对话");
  await rename.getByRole("textbox", { name: "对话名称", exact: true }).fill("归档新名称");
  await rename.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(row.locator(".thread-title")).toHaveText("归档新名称");
  await menuAction(page, row, "删除对话");
  await actionDialog(page, "删除对话").getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(remote.archivedThreads).toHaveLength(0);
  expect(remote.request("thread/unarchive")).toBeUndefined();
  expect(remote.request("thread/resume")).toBeUndefined();
  expect(mock.request("thread/delete")).toBeUndefined();
  await expect(page.locator(".header-host")).toHaveText("本机");
});

test("an archived query started before deletion cannot restore the deleted row or erase other results", async ({ page, mock }) => {
  mock.archivedThreads = [
    { ...mock.threads[0], id: "archived-delete", name: "待删除归档" },
    { ...mock.threads[0], id: "archived-keep", name: "保留归档" },
  ];
  const receive = (mock as any).receive.bind(mock);
  let hold = false;
  let release: (() => void) | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== "thread/list" || !request.params.archived || !hold) return receive(socket, request);
    mock.requests.push(request);
    const data = structuredClone(mock.archivedThreads);
    release = () => socket.send(JSON.stringify({ id: request.id, result: { data, nextCursor: null } }));
  };
  await login(page);
  await page.getByRole("button", { name: "已归档对话", exact: true }).click();
  const results = page.locator(".nav-search-results");
  await expect(results.locator(".nav-thread")).toHaveCount(2);
  hold = true;
  await page.getByRole("button", { name: "刷新对话", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  const row = results.locator(".nav-thread").filter({ has: page.locator(".thread-title", { hasText: "待删除归档" }) });
  await menuAction(page, row, "删除对话");
  await actionDialog(page, "删除对话").getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(results.locator(".thread-title")).toHaveText(["保留归档"]);
  release!();
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
  await expect(results.locator(".thread-title")).toHaveText(["保留归档"]);
  await expect(page.locator(".error-banner")).toHaveCount(0);
});

test("running conversations cannot be deleted from the menu", async ({ page, mock }) => {
  mock.threads[0]!.status = { type: "active" };
  await login(page);
  await recent(page).locator(".nav-row-menu").click();
  await expect(recent(page).getByRole("button", { name: "删除对话", exact: true })).toBeDisabled();
  await expect(recent(page)).toContainText("请先停止运行中的任务，再删除对话");
  expect(mock.request("thread/delete")).toBeUndefined();
  await recent(page).getByRole("button", { name: "重命名对话", exact: true }).click();
  await expect(actionDialog(page, "重命名对话")).toBeVisible();
});

test("mobile rename dialog remains inside the viewport and supports cancel without changing the name", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await menuAction(page, recent(page), "重命名对话");
  const dialog = actionDialog(page, "重命名对话");
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(dialog.getByRole("textbox", { name: "对话名称", exact: true })).toHaveCSS("font-size", "16px");
  await dialog.getByRole("textbox", { name: "对话名称", exact: true }).fill("取消的名称");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(recent(page).locator(".thread-title")).toHaveText("已有测试历史");
  expect(mock.request("thread/name/set")).toBeUndefined();
});

test("a rename acknowledgement after notification navigation updates only its original conversation", async ({ page, mock }) => {
  mock.threads.push({ ...mock.threads[0]!, id: "thread-other", name: "另一个对话" });
  mock.turns.set("thread-other", []);
  const receive = (mock as any).receive.bind(mock);
  let release: (() => void) | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== "thread/name/set") return receive(socket, request);
    mock.requests.push(request);
    release = () => {
      mock.threads.find(thread => thread.id === request.params.threadId)!.name = request.params.name;
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    };
  };
  await login(page);
  await recent(page).locator(".thread-row").click();
  await menuAction(page, recent(page), "重命名对话");
  const dialog = actionDialog(page, "重命名对话");
  await dialog.getByRole("textbox", { name: "对话名称", exact: true }).fill("原对话的新名字");
  await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  // A notification can navigate independently while the rename RPC is pending.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("codex:push-navigate", {
    detail: { hostId: "local", threadId: "thread-other" },
  })));
  await expect(page.locator(".main-header h1")).toHaveText("另一个对话");
  release!();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".main-header h1")).toHaveText("另一个对话");
  await expect(page.locator('[data-section="recent"] .thread-title')).toHaveText(["原对话的新名字", "另一个对话"]);
  expect(mock.request("thread/name/set")?.params.threadId).toBe("thread-existing");
});

test("a late resume snapshot cannot overwrite a native rename received while the conversation is loading", async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  let release: (() => void) | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== "thread/resume") return receive(socket, request);
    mock.requests.push(request);
    // Freeze the response before the native rename, just as a slow resume can
    // acknowledge a snapshot captured before its newer notification arrived.
    const thread = structuredClone(mock.threads.find(thread => thread.id === request.params.threadId));
    release = () => socket.send(JSON.stringify({ id: request.id, result: {
      thread, model: mock.config.model, reasoningEffort: "medium", sandbox: { type: "workspaceWrite" },
    } }));
  };
  await login(page);
  await recent(page).locator(".thread-row").click();
  await expect.poll(() => !!release).toBe(true);
  mock.threads[0]!.name = "加载期间更新的名称";
  mock.emit("thread/name/updated", { threadId: "thread-existing", threadName: "加载期间更新的名称" });
  await expect(page.locator(".main-header h1")).toHaveText("加载期间更新的名称");
  release!();
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toBeEnabled();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(page.locator(".main-header h1")).toHaveText("加载期间更新的名称");
  await expect(page.locator(".nav-thread .thread-title")).toHaveText(["加载期间更新的名称", "加载期间更新的名称"]);
});

for (const event of ["native", "accepted"]) {
  test(`${event} deletion from another Web clears the active conversation, drafts and pin without stale-list revival`, async ({ page, mock }) => {
    mock.preferences.pins.push({ kind: "thread", hostId: "local", id: "thread-existing", label: "已有测试历史" });
    await login(page);
    await page.locator('[data-section="pinned"] .nav-thread .thread-row').click();
    await expect(page.locator(".agent-message")).toContainText("历史保持可读");
    await page.getByRole("textbox", { name: "消息输入框", exact: true }).fill("删除时应清理的草稿");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("codex.draft.local.thread-existing"))).toBe("删除时应清理的草稿");
    if (event === "native") mock.emit("thread/deleted", { threadId: "thread-existing" });
    else mock.emit("bridge/thread/changed", { threadId: "thread-existing", method: "thread/delete", changeId: "other-web:delete", result: {}, request: {} });
    await expect(page.locator(".welcome")).toBeVisible();
    await expect(page.locator(".nav-thread")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toHaveValue("");
    await expect.poll(() => mock.preferences.pins).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("codex.draft.local.thread-existing"))).toBeNull();
    // Keep the fixture's old thread/list snapshot deliberately: tombstones must
    // filter a late cached list even when the native delete notice came first.
    await page.getByRole("button", { name: "刷新对话", exact: true }).click();
    await expect(page.locator(".nav-thread")).toHaveCount(0);
    expect(mock.request("thread/delete")).toBeUndefined();
  });
}

test("search results follow another Web's rename and deletion, including native name aliases", async ({ page, mock }) => {
  await login(page);
  await page.getByRole("textbox", { name: "搜索对话", exact: true }).fill("历史");
  const titles = page.locator(".nav-search-results .thread-title");
  await expect(titles).toHaveText(["已有测试历史"]);
  const change = { threadId: "thread-existing", method: "thread/name/set", changeId: "other-web:rename", result: {}, request: { name: "其他网页改名" } };
  mock.emit("bridge/thread/changed", change);
  await expect(titles).toHaveText(["其他网页改名"]);
  mock.emit("thread/name/updated", { threadId: "thread-existing", threadName: "原生名称更新" });
  await expect(titles).toHaveText(["原生名称更新"]);
  mock.emit("bridge/thread/changed", change);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(titles).toHaveText(["原生名称更新"]);
  await mock.sockets[0]!.close({ code: 4003, reason: "Rename reconnect fixture" });
  await expect.poll(() => mock.sockets.length, { timeout: 12_000 }).toBe(2);
  mock.emit("bridge/thread/changed", { ...change, request: { name: "重连复用编号后的名称" } });
  await expect(titles).toHaveText(["重连复用编号后的名称"]);
  mock.emit("bridge/thread/changed", { threadId: "thread-existing", method: "thread/delete", changeId: "other-web:delete", result: {}, request: {} });
  await expect(titles).toHaveCount(0);
});

test("archived search results remove native deleted child conversations", async ({ page, mock }) => {
  mock.archivedThreads.push({ ...mock.threads[0]!, id: "archived-child", name: "已归档子对话" });
  await login(page);
  await page.getByRole("button", { name: "已归档对话", exact: true }).click();
  const titles = page.locator(".nav-search-results .thread-title");
  await expect(titles).toHaveText(["已归档子对话"]);
  mock.emit("thread/deleted", { threadId: "archived-child" });
  await expect(titles).toHaveCount(0);
  await expect(recent(page)).toHaveCount(0); // Archive search remains selected.
});
