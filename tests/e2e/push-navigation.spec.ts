import { test, expect, login, MockCodex } from "./fixtures";

function addRemote(mock: MockCodex) {
  const remote = new MockCodex();
  remote.threads[0].name = "远程通知对话";
  remote.turns.get("thread-existing")![0].items[1].text = "远程通知对应的内容";
  mock.hosts.push({ id: "ssh-test", name: "Remote", kind: "ssh", cwd: "/workspace/demo" });
  mock.hostMocks.set("ssh-test", remote);
  return remote;
}

test("notification link survives login and opens the correct host when thread IDs overlap", async ({ page, mock }) => {
  const remote = addRemote(mock);
  await page.goto("/?host=ssh-test&thread=thread-existing&keep=yes#anchor");
  await page.getByRole("textbox", { name: "访问密码" }).fill("test-password-123");
  await page.getByRole("button", { name: "进入工作区", exact: true }).click();
  await expect(page.locator(".agent-message")).toContainText("远程通知对应的内容");
  expect(remote.request("thread/resume")?.params.threadId).toBe("thread-existing");
  expect(mock.request("turn/start")).toBeUndefined();
  expect(remote.request("turn/start")).toBeUndefined();
  await expect.poll(() => new URL(page.url()).searchParams.has("thread")).toBe(false);
  expect(new URL(page.url()).searchParams.get("keep")).toBe("yes");
  expect(new URL(page.url()).hash).toBe("#anchor");
});

test("notification navigation opens a remote chat from an existing window and ignores malformed targets", async ({ page, mock }) => {
  const remote = addRemote(mock);
  await login(page);
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("codex:push-navigate", {
    detail: { hostId: "ssh-test", threadId: "thread-existing" },
  })));
  await expect(page.locator(".agent-message")).toContainText("远程通知对应的内容");
  await expect(page.locator("#workspace-panel")).toHaveCount(0);
  const requests = remote.requests.length;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("codex:push-navigate", {
    detail: { hostId: "https://attacker.invalid", threadId: "thread-existing" },
  })));
  await expect(page.locator(".header-host")).toHaveText("Remote");
  expect(remote.requests.length).toBe(requests);
  expect(remote.request("turn/start")).toBeUndefined();
});

test("a notification can switch to a reachable host when the last used remote host is offline", async ({ page, mock }) => {
  addRemote(mock);
  await page.addInitScript(() => localStorage.setItem("codex.hostId", JSON.stringify("ssh-test")));
  await page.routeWebSocket(/\/api\/rpc\?host=ssh-test(?:&|$)/, (socket) => {
    socket.send(JSON.stringify({ method: "bridge/status", params: { connected: false, hostId: "ssh-test", error: "Remote is offline" } }));
  });
  await page.goto("/?host=local&thread=thread-existing");
  await page.getByRole("textbox", { name: "访问密码" }).fill("test-password-123");
  await page.getByRole("button", { name: "进入工作区", exact: true }).click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(page.locator(".header-host")).toHaveText("本机");
  expect(mock.request("thread/resume")?.params.threadId).toBe("thread-existing");
  expect(mock.request("turn/start")).toBeUndefined();
});

test("going offline preserves a draft, disables sending and reconnects without resubmitting it", async ({ page, context, mock }) => {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.fill("恢复网络前不要发送这条草稿");
  await context.setOffline(true);
  await expect(page.getByText("目前离线，联网后将重新连接。操作不会自动提交。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("恢复网络前不要发送这条草稿");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  expect(mock.request("turn/start")).toBeUndefined();
});

test("a notification clicked offline opens its target after reconnection", async ({ page, context, mock }) => {
  const remote = addRemote(mock);
  await login(page);
  await context.setOffline(true);
  await expect(page.getByText("目前离线，联网后将重新连接。操作不会自动提交。", { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("codex:push-navigate", {
    detail: { hostId: "ssh-test", threadId: "thread-existing" },
  })));
  expect(remote.request("thread/resume")).toBeUndefined();
  await context.setOffline(false);
  await expect(page.locator(".agent-message")).toContainText("远程通知对应的内容");
  expect(remote.request("turn/start")).toBeUndefined();
});
