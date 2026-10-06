import { test, expect, login, MockCodex } from "./fixtures";

const localProject = "/workspace/second";
const remoteProject = "/srv/remote-app";
const image = {
  name: "sample.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+UqsAAAAASUVORK5CYII=",
    "base64",
  ),
};
function projects(mock: MockCodex) {
  mock.projects.push({
    id: "second", name: "第二个本地项目", path: localProject,
    hostId: "local", source: "web",
  });
}
function remoteFixture(mock: MockCodex, name = "远程开发机") {
  const remote = new MockCodex();
  mock.hosts.push({ id: "ssh-context", kind: "ssh", name, cwd: "/srv" });
  mock.projects.push(
    { id: "remote", name: "远端应用", path: remoteProject, hostId: "ssh-context", source: "web" },
    { id: "same-path", name: "相同路径的远端项目", path: "/workspace/demo", hostId: "ssh-context", source: "web" },
  );
  mock.hostMocks.set("ssh-context", remote);
  return remote;
}

test("new-chat project choice keeps the draft and attachments, then sends the selected cwd", async ({ page, mock }) => {
  projects(mock);
  remoteFixture(mock);
  await login(page);
  const project = page.getByRole("combobox", { name: "新对话项目", exact: true });
  await expect(project.locator("option")).toHaveText(["Demo Project", "第二个本地项目"]);
  await page.getByRole("textbox", { name: "消息输入框" }).fill("保留项目草稿与附件");
  await page.locator('input[type="file"]').setInputFiles([
    image, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
  ]);
  await expect(page.locator(".attachment")).toHaveCount(2);
  mock.holdConfigReadResponse = true;
  const previous = mock.requests.filter((request) => request.method === "config/read").length;
  await project.selectOption(localProject);
  await expect.poll(() => mock.requests.filter((request) => request.method === "config/read").length).toBeGreaterThan(previous);
  await expect(project).toBeDisabled();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  expect(mock.request("turn/start")).toBeUndefined();
  mock.releaseConfigReadResponse();
  await expect(project).toBeEnabled();
  await expect(project).toHaveValue(localProject);
  await expect(page.getByRole("textbox", { name: "消息输入框" })).toHaveValue("保留项目草稿与附件");
  await expect(page.locator(".attachment")).toHaveCount(2);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("turn/start")?.params.cwd).toBe(localProject);
  expect(mock.request("thread/start")?.params.cwd).toBe(localProject);
  expect(mock.request("turn/start")?.params.input).toContainEqual({ type: "localImage", path: "/test/uploads/sample.png" });
  expect(mock.request("turn/start")?.params.input[0].text).toContain("/test/uploads/notes.txt");
  await expect(page.getByRole("group", { name: "新对话位置" })).toHaveCount(0);
});

test("new-chat host choice waits for remote config and separates same-path projects before remote sending", async ({ page, mock }) => {
  projects(mock);
  const remote = remoteFixture(mock);
  remote.holdConfigReadResponse = true;
  await login(page);
  const host = page.getByRole("combobox", { name: "新对话主机", exact: true });
  const project = page.getByRole("combobox", { name: "新对话项目", exact: true });
  await expect(host.locator("option")).toHaveText(["本地 · 本机", "远程 · 远程开发机"]);
  await page.getByRole("textbox", { name: "消息输入框" }).fill("远程项目草稿");
  await host.selectOption("ssh-context");
  await expect.poll(() => remote.request("config/read")?.method).toBe("config/read");
  await expect(host).toBeDisabled();
  await expect(project).toBeDisabled();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  expect(remote.request("turn/start")).toBeUndefined();
  remote.releaseConfigReadResponse();
  await expect(host).toBeEnabled();
  await expect(host).toHaveValue("ssh-context");
  await expect(project.locator("option")).toHaveText(["远端应用", "相同路径的远端项目"]);
  await project.selectOption("/workspace/demo");
  await expect(project).toBeEnabled();
  await expect(project.locator("option:checked")).toHaveText("相同路径的远端项目");
  await project.selectOption(remoteProject);
  await expect(project).toBeEnabled();
  await expect(project).toHaveValue(remoteProject);
  await expect(page.getByRole("textbox", { name: "消息输入框" })).toHaveValue("远程项目草稿");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => remote.request("turn/start")?.params.cwd).toBe(remoteProject);
  expect(remote.request("thread/start")?.params.cwd).toBe(remoteProject);
  expect(mock.request("turn/start")).toBeUndefined();
});

test("changing the host uploads original images to the target host before sending, never local paths", async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  const uploads: string[] = [];
  await page.route("**/api/uploads", async (route) => {
    const body = route.request().postDataBuffer()!.toString("utf8");
    uploads.push(body);
    const target = body.includes('name="hostId"\r\n\r\nssh-context') ? "remote" : "local";
    await route.fulfill({ status: 201, json: { files: [{ name: "sample.png", path: `/${target}/uploads/sample.png`, mime: "image/png", size: image.buffer.length }] } });
  });
  await login(page);
  await page.getByRole("textbox", { name: "消息输入框" }).fill("远端查看图片");
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(page.locator(".attachment")).toHaveCount(1);
  await page.getByRole("combobox", { name: "新对话主机", exact: true }).selectOption("ssh-context");
  await expect.poll(() => uploads.length).toBe(2);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await expect(page.locator(".attachment")).toHaveCount(1);
  expect(uploads[1]).toContain('name="hostId"\r\n\r\nssh-context');
  expect(uploads[1]).toContain('name="cwd"\r\n\r\n/srv/remote-app');
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => remote.request("turn/start")?.method).toBe("turn/start");
  expect(remote.request("turn/start")?.params.input).toContainEqual({ type: "localImage", path: "/remote/uploads/sample.png" });
  expect(JSON.stringify(remote.request("turn/start")?.params.input)).not.toContain("/local/uploads/");
  expect(mock.request("turn/start")).toBeUndefined();
});

test("existing chats hide the context bar and retain their original workspace when continued", async ({ page, mock }) => {
  projects(mock);
  remoteFixture(mock);
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: "已有测试历史" }).first().click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(page.getByRole("group", { name: "新对话位置" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "消息输入框" }).fill("继续旧对话");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("turn/start")?.params.cwd).toBe("/workspace/demo");
});

test("an offline host still allows choosing the local host to continue the draft", async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page);
  const host = page.getByRole("combobox", { name: "新对话主机", exact: true });
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("连接中断也保留草稿");
  await host.selectOption("ssh-context");
  await expect(host).toBeEnabled();
  remote.emit("bridge/status", { connected: false, hostId: "ssh-context", mode: "spawn" });
  await expect(input).toBeDisabled();
  await expect(host).toBeEnabled();
  await host.selectOption("local");
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("连接中断也保留草稿");
  await expect(host).toHaveValue("local");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("turn/start")?.params.cwd).toBe("/workspace/demo");
  expect(remote.request("turn/start")).toBeUndefined();
});

test("mobile long project and host labels stay inside the viewport and remain selectable", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  projects(mock);
  mock.projects[0].name = "本地非常长的项目名称用于验证手机选择栏不会溢出".repeat(3);
  const remote = remoteFixture(mock, "长主机名称用于验证手机选择栏不会溢出".repeat(4));
  mock.projects.find((project) => project.id === "remote")!.name = "远端非常长的项目名称用于验证手机选择栏不会溢出".repeat(3);
  await login(page);
  const group = page.getByRole("group", { name: "新对话位置" });
  expect(await group.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("手机项目选择");
  await page.getByRole("combobox", { name: "新对话主机", exact: true }).selectOption("ssh-context");
  await expect(page.getByRole("combobox", { name: "新对话项目", exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "新对话项目", exact: true }).selectOption(remoteProject);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  expect(await group.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await group.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(input).toHaveValue("手机项目选择");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => remote.request("turn/start")?.params.cwd).toBe(remoteProject);
});

test("a host without projects retains its current directory and offers project setup", async ({ page, mock }) => {
  mock.projects = [];
  await login(page);
  const project = page.getByRole("combobox", { name: "新对话项目", exact: true });
  await expect(project).toBeDisabled();
  await expect(project.locator("option")).toHaveText(["demo · 当前目录"]);
  await page.getByRole("group", { name: "新对话位置" }).getByRole("button", { name: "添加项目", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "项目路径", exact: true })).toBeVisible();
});
