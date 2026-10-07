import { test, expect, login, slash } from "./fixtures";

test("opening the terminal starts one shell and reopening tabs reuses it", async ({ page, mock }) => {
  await login(page);
  expect(mock.request("command/exec")).toBeUndefined();
  await slash(page, "terminal");
  await expect.poll(() => mock.requests.filter(request => request.method === "command/exec").length).toBe(1);
  await expect(page.locator(".pty-toolbar")).toContainText("Shell 正在运行");
  expect(mock.request("command/exec")?.params).toMatchObject({
    command: ["/bin/sh"], tty: true, cwd: "/workspace/demo", disableTimeout: true,
  });
  const processId = mock.request("command/exec")!.params.processId;
  await page.locator(".workspace-tabs").getByRole("button", { name: "文件", exact: true }).click();
  await page.locator(".workspace-tabs").getByRole("button", { name: "终端", exact: true }).click();
  await expect(page.locator(".pty-toolbar")).toContainText("Shell 正在运行");
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  await slash(page, "terminal");
  await expect(page.locator(".pty-toolbar")).toContainText("Shell 正在运行");
  expect(mock.requests.filter(request => request.method === "command/exec")).toHaveLength(1);
  await page.getByRole("button", { name: "结束终端", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动终端", exact: true })).toBeEnabled();
  expect(mock.request("command/exec/terminate")?.params.processId).toBe(processId);
  expect(mock.requests.filter(request => request.method === "command/exec")).toHaveLength(1);
  await page.getByRole("button", { name: "启动终端", exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === "command/exec").length).toBe(2);
});

test("read-only terminal waits for write permission before its default shell starts", async ({ page, mock }) => {
  await login(page);
  await page.getByRole("combobox", { name: "选择权限", exact: true }).selectOption("read-only");
  await slash(page, "terminal");
  await expect(page.getByRole("button", { name: "启动终端", exact: true })).toBeDisabled();
  expect(mock.request("command/exec")).toBeUndefined();
  await page.getByRole("combobox", { name: "选择权限", exact: true }).selectOption("workspace-write");
  await expect.poll(() => mock.request("command/exec")?.params.tty).toBe(true);
  expect(mock.requests.filter(request => request.method === "command/exec")).toHaveLength(1);
});

test("a restored project PTY is selected before considering a new shell", async ({ page, mock }) => {
  await login(page);
  mock.emit("bridge/status", { connected: true, activeProcesses: [
    { processId: "web-pty-restored", tty: true, cwd: "/workspace/demo", lastOutput: "restored shell\r\n" },
  ] });
  await slash(page, "terminal");
  await expect(page.getByRole("combobox", { name: "选择运行中的终端", exact: true })).toHaveValue("web-pty-restored");
  await expect(page.locator(".pty-toolbar")).toContainText("Shell 正在运行");
  expect(mock.request("command/exec")).toBeUndefined();
});

test("leaving while persistent shell preparation is pending cannot start a hidden terminal", async ({ page, mock }) => {
  let release!: () => void;
  let preparations = 0;
  await page.route("**/api/terminal-sessions/prepare", async route => {
    preparations++;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { available: true, sessionName: "test-persistent", command: ["/usr/bin/tmux", "attach-session", "-t", "$1"] } });
  });
  await login(page);
  await slash(page, "terminal");
  await expect.poll(() => mock.request("command/exec")?.params.tty).toBe(true);
  await page.getByRole("button", { name: "结束终端", exact: true }).click();
  await page.getByRole("checkbox", { name: /持久 Shell/ }).check();
  await page.getByRole("button", { name: "启动终端", exact: true }).click();
  await expect.poll(() => preparations).toBe(1);
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  const response = page.waitForResponse("**/api/terminal-sessions/prepare");
  release();
  await response;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(mock.requests.filter(request => request.method === "command/exec")).toHaveLength(1);
});

test("Tmux opens at the latest output, follows refreshes, and preserves an intentional history scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let lines = 180;
  let reads = 0;
  await page.route("**/api/tmux/*", route => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    const body = route.request().postDataJSON();
    if (action === "list") return route.fulfill({ json: { available: true, sessions: [{ id: "$1", name: "test", windows: 1, attached: 0, createdAt: 1791200000 }] } });
    reads++;
    return route.fulfill({ json: {
      paneId: body.paneId || "%1",
      panes: ["%1", "%2"].map(id => ({ id, windowId: "@1", windowName: "test", command: "sh", active: id === "%1", windowActive: true })),
      text: Array.from({ length: lines }, (_, index) => `${body.paneId || "%1"} output ${index + 1}`).join("\n"),
    } });
  });
  await login(page);
  await slash(page, "terminal");
  await page.getByRole("button", { name: "Tmux", exact: true }).click();
  const output = page.getByLabel("Tmux 输出快照");
  const gap = () => output.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  await expect(output).toContainText("%1 output 180");
  await expect.poll(gap).toBeLessThanOrEqual(1);
  lines = 210;
  await page.getByRole("button", { name: "刷新会话输出", exact: true }).click();
  await expect(output).toContainText("%1 output 210");
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await output.evaluate(element => { element.scrollTop = 100; element.dispatchEvent(new Event("scroll")); });
  lines = 240;
  await page.getByRole("button", { name: "刷新会话输出", exact: true }).click();
  await expect(output).toContainText("%1 output 240");
  await expect.poll(() => output.evaluate(element => element.scrollTop)).toBe(100);
  await page.getByRole("combobox", { name: "Tmux 窗口与面板", exact: true }).selectOption("%2");
  await expect(output).toContainText("%2 output 240");
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await output.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await page.getByRole("button", { name: "滚动到 Tmux 最新输出", exact: true }).click();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  expect(reads).toBeGreaterThanOrEqual(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("changed files start folded in chat and workspace and streaming updates preserve each user's choice", async ({ page, mock }) => {
  const paths = ["/workspace/demo/src/a.ts", "/workspace/demo/src/b.ts", "/workspace/demo/src/c.ts"];
  const item = { id: "folded-files", type: "fileChange", status: "completed", changes: paths.slice(0, 2).map(path => ({ path, kind: "update", diff: "@@ -1 +1 @@\n-old\n+initial" })) };
  mock.turns.get("thread-existing")![0].items.splice(1, 0, item);
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const turn = page.locator('.conversation-turn[data-turn-id="turn-history"]');
  await turn.locator(".turn-activity > summary").click();
  await turn.locator(".activity-batch > summary").click();
  await turn.locator(".tool-item > summary").click();
  const chatFiles = turn.locator(".file-diff");
  await expect(chatFiles.first().locator(".diff-code")).toBeHidden();
  await expect(chatFiles.last().locator(".diff-code")).toBeHidden();
  await chatFiles.first().locator("summary").click();
  await expect(chatFiles.first().locator(".diff-code")).toBeVisible();
  item.changes = paths.map(path => ({ path, kind: "update", diff: "@@ -1 +1 @@\n-old\n+updated" }));
  mock.emit("item/completed", { threadId: "thread-existing", turnId: "turn-history", item });
  await expect(chatFiles).toHaveCount(3);
  await expect(chatFiles.first().locator(".diff-code")).toBeVisible();
  await expect(chatFiles.first().locator(".diff-code")).toContainText("+updated");
  await expect(chatFiles.nth(1).locator(".diff-code")).toBeHidden();
  await expect(chatFiles.last().locator(".diff-code")).toBeHidden();
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await page.locator(".workspace-tabs").getByRole("button", { name: /^变更/ }).click();
  const cards = page.locator(".change-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.first().locator(".diff-code")).toBeHidden();
  await cards.first().locator("summary").click();
  item.changes[0]!.diff += "\n+streamed";
  mock.emit("item/completed", { threadId: "thread-existing", turnId: "turn-history", item });
  await expect(cards.first().locator(".diff-code")).toContainText("+streamed");
  await expect(cards.first().locator(".diff-code")).toBeVisible();
  await expect(cards.last().locator(".diff-code")).toBeHidden();
  await cards.last().getByRole("button", { name: `打开文件 ${paths[2]}`, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "c.ts 文件内容", exact: true })).toHaveText(/文件读取正常/);
});
