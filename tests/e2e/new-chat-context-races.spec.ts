import { test, expect, login, MockCodex } from "./fixtures";

const image = {
  name: "source.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+UqsAAAAASUVORK5CYII=",
    "base64",
  ),
};
function remoteFixture(mock: MockCodex) {
  const remote = new MockCodex();
  mock.hosts.push({ id: "ssh-race", name: "远端竞态测试机", kind: "ssh", cwd: "/srv" });
  mock.projects.push({ id: "race-project", name: "远端项目", hostId: "ssh-race", path: "/srv/race-project", source: "web" });
  mock.hostMocks.set("ssh-race", remote);
  return remote;
}

test("opening a local existing chat supersedes an unfinished remote context switch without restoring its draft or attachments", async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  remote.holdConfigReadResponse = true;
  await login(page);
  const existing = page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: "已有测试历史" }).first();
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await existing.click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await input.fill("已有对话自己的草稿");
  await page.locator(".new-thread-button").click();
  await expect(page.getByRole("group", { name: "新对话位置", exact: true })).toBeVisible();
  await input.fill("被放弃的新对话草稿");
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(page.locator(".attachment")).toHaveCount(2);
  await page.getByRole("combobox", { name: "新对话主机", exact: true }).selectOption("ssh-race");
  await expect.poll(() => remote.request("config/read")?.method).toBe("config/read");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await existing.click();
  await expect(page.locator(".header-host")).toHaveText("本机");
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(input).toHaveValue("已有对话自己的草稿");
  await expect(page.locator(".attachment")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "新对话位置", exact: true })).toHaveCount(0);
  remote.releaseConfigReadResponse();
  await page.waitForTimeout(100);
  await expect(input).toHaveValue("已有对话自己的草稿");
  await expect(page.locator(".attachment")).toHaveCount(0);
  await expect(page.locator(".header-host")).toHaveText("本机");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("turn/start")?.params.cwd).toBe("/workspace/demo");
  expect(mock.request("turn/start")?.params.input).toEqual([
    { type: "text", text: "已有对话自己的草稿", text_elements: [] },
  ]);
  expect(remote.request("turn/start")).toBeUndefined();
});

test("remote attachment upload failure preserves text, reports the failure, and never sends a local attachment path to the remote host", async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  const uploads: Array<{ hostId: string; body: Buffer }> = [];
  await page.route("**/api/uploads", async (route) => {
    const body = route.request().postDataBuffer()!;
    const hostId = body.toString("utf8").includes('name="hostId"\r\n\r\nssh-race') ? "ssh-race" : "local";
    uploads.push({ hostId, body });
    if (hostId === "ssh-race") return route.fulfill({ status: 502, json: { error: "远端上传目录不可写" } });
    await route.fulfill({ status: 201, json: { files: [{ name: image.name, path: "/local-only/uploads/source.png", mime: image.mimeType, size: image.buffer.length }] } });
  });
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.fill("上传失败后保留的文字草稿");
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(page.locator(".attachment")).toHaveCount(1);
  await page.getByRole("combobox", { name: "新对话主机", exact: true }).selectOption("ssh-race");
  await expect(page.getByRole("alert")).toContainText("已切换主机，附件上传失败，请重新上传附件");
  await expect(input).toHaveValue("上传失败后保留的文字草稿");
  await expect(page.locator(".attachment")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "新对话主机", exact: true })).toHaveValue("ssh-race");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  expect(uploads.map((upload) => upload.hostId)).toEqual(["local", "ssh-race"]);
  expect(uploads[1]!.body.includes(image.buffer)).toBe(true);
  expect(uploads[1]!.body.toString("utf8")).toContain('name="cwd"\r\n\r\n/srv/race-project');
  expect(remote.request("turn/start")).toBeUndefined();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => remote.request("turn/start")?.params.cwd).toBe("/srv/race-project");
  expect(remote.request("turn/start")?.params.input).toEqual([
    { type: "text", text: "上传失败后保留的文字草稿", text_elements: [] },
  ]);
  expect(JSON.stringify(remote.request("turn/start")?.params)).not.toContain("/local-only/");
  expect(mock.request("turn/start")).toBeUndefined();
});

test("a late remote upload failure cannot show an unrelated error or change the draft and cwd of a newly selected local chat", async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  let releaseRemoteUpload: (() => void) | undefined;
  await page.route("**/api/uploads", async (route) => {
    const body = route.request().postDataBuffer()!.toString("utf8");
    if (body.includes('name="hostId"\r\n\r\nssh-race')) {
      await new Promise<void>((resolve) => { releaseRemoteUpload = resolve; });
      return route.fulfill({ status: 502, json: { error: "迟到的远端上传失败" } });
    }
    await route.fulfill({ status: 201, json: { files: [{ name: image.name, path: "/local-only/uploads/source.png", mime: image.mimeType, size: image.buffer.length }] } });
  });
  await login(page);
  const existing = page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: "已有测试历史" }).first();
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await existing.click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await input.fill("本机聊天自己的未发送草稿");
  await page.locator(".new-thread-button").click();
  await input.fill("即将放弃的远端草稿");
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(page.locator(".attachment")).toHaveCount(1);
  await page.getByRole("combobox", { name: "新对话主机", exact: true }).selectOption("ssh-race");
  await expect.poll(() => !!releaseRemoteUpload).toBe(true);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await existing.click();
  await expect(page.locator(".header-host")).toHaveText("本机");
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(input).toHaveValue("本机聊天自己的未发送草稿");
  await expect(page.locator(".attachment")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const remoteUploadResponse = page.waitForResponse((response) => response.url().endsWith("/api/uploads") && response.status() === 502);
  releaseRemoteUpload?.();
  await remoteUploadResponse;
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(input).toHaveValue("本机聊天自己的未发送草稿");
  await expect(page.locator(".attachment")).toHaveCount(0);
  await expect(page.locator(".header-host")).toHaveText("本机");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("turn/start")?.params.cwd).toBe("/workspace/demo");
  expect(mock.request("turn/start")?.params.input).toEqual([
    { type: "text", text: "本机聊天自己的未发送草稿", text_elements: [] },
  ]);
  expect(remote.request("turn/start")).toBeUndefined();
});
