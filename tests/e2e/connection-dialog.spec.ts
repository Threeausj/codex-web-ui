import { test, expect, login } from "./fixtures";
import type { Page } from "@playwright/test";

async function openConnections(page: any) {
  await login(page);
  const sidebarButton = page.getByRole("button", {
    name: "打开侧边栏",
    exact: true,
  });
  if (await sidebarButton.isVisible()) await sidebarButton.click();
  await page.locator(".settings-button").click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "连接", exact: true })
    .click();
  await page
    .getByRole("button", { name: "添加 SSH 连接", exact: true })
    .click();
  return page.getByRole("dialog", { name: "添加 SSH 连接", exact: true });
}

test("test connection checks an unsaved draft without creating or selecting a host", async ({
  page,
  mock,
}) => {
  const tests: any[] = [];
  await page.route("**/api/hosts/test", async (route) => {
    tests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        ok: true,
        message: "连接成功",
        elapsedMs: 100,
        version: "1.2.3",
        stage: "ready",
      },
    });
  });
  const dialog = await openConnections(page);
  await expect(
    dialog.getByLabel("SSH 显示名称", { exact: true }),
  ).toBeFocused();
  await dialog
    .getByLabel("SSH 主机地址", { exact: true })
    .fill("dev@host.example.test");
  await dialog.getByRole("button", { name: "身份文件", exact: true }).click();
  await dialog
    .getByLabel("SSH 身份文件路径", { exact: true })
    .fill("/keys/dev");
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("连接成功");
  await expect(dialog.getByRole("status")).toContainText("1.2.3");
  expect(tests).toHaveLength(1);
  expect(tests[0]).toMatchObject({
    hostname: "dev@host.example.test",
    identityFile: "/keys/dev",
    codexPath: "",
  });
  expect(mock.hosts).toHaveLength(1);
  expect(mock.hostMocks.size).toBe(0);
  await dialog
    .getByLabel("SSH 主机地址", { exact: true })
    .fill("other.example.test");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toBeVisible();
});

test("connection dialog reports failures and ignores a test after it is closed", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  let attempts = 0;
  await page.route("**/api/hosts/test", async (route) => {
    attempts++;
    if (attempts === 1) {
      await route.fulfill({ status: 502, json: { error: "SSH 身份验证失败" } });
      return;
    }
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: { ok: true, version: "stale", stage: "ready" },
    });
  });
  const dialog = await openConnections(page);
  await dialog
    .getByLabel("SSH 主机地址", { exact: true })
    .fill("host.example.test");
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("SSH 身份验证失败");
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("正在测试连接");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "添加 SSH 连接", exact: true })
    .click();
  release?.();
  await expect(dialog.getByLabel("SSH 主机地址", { exact: true })).toHaveValue(
    "",
  );
  await expect(dialog.getByRole("status")).toHaveCount(0);
});

test("connection dialog fits a phone, traps focus, and closes only its own modal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 667 });
  const dialog = await openConnections(page);
  await dialog.getByRole("button", { name: "身份文件", exact: true }).click();
  await dialog.locator("summary").filter({ hasText: "高级选项" }).click();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(667);
  expect(
    await dialog.evaluate(
      (el: HTMLElement) => el.scrollWidth <= el.clientWidth,
    ),
  ).toBe(true);
  await dialog
    .getByLabel("SSH 主机地址", { exact: true })
    .fill("dev@example.test");
  await dialog
    .getByLabel("SSH 身份文件路径", { exact: true })
    .fill("/keys/test");
  await dialog.getByRole("button", { name: "保存", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭 SSH 连接", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "保存", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "添加 SSH 连接", exact: true }),
  ).toBeFocused();
});

const keyFile = { name: "id_ed25519", mimeType: "application/octet-stream", buffer: Buffer.from("test private key bytes") };

async function mockKeyUploads(page: Page) {
  const uploads: string[] = [];
  const deleted: string[] = [];
  await page.route(/\/api\/ssh-keys(?:\/[^/?]+)?$/, async route => {
    const request = route.request();
    if (request.method() === "DELETE") {
      deleted.push(new URL(request.url()).pathname.split("/").at(-1)!);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    expect(request.headers()["x-csrf-token"]).toBe("mock-csrf");
    expect(request.headers()["content-type"]).toContain("multipart/form-data; boundary=");
    const bytes = request.postDataBuffer()!.toString();
    expect(bytes).toContain('name="key"; filename="id_ed25519"');
    expect(bytes).toContain("test private key bytes");
    const id = `key-${uploads.length + 1}`;
    uploads.push(id);
    await route.fulfill({ status: 201, json: { id, identityFile: `/app/data/ssh-keys/${id}.key` } });
  });
  return { uploads, deleted };
}

test("uploaded keys auto-fill test and save settings and can replace an existing SSH key", async ({ page, mock }) => {
  const { uploads, deleted } = await mockKeyUploads(page);
  const writes: any[] = [];
  const probes: any[] = [];
  await page.route("**/api/hosts/test", async route => {
    probes.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, stage: "ready" } });
  });
  await page.route(/\/api\/hosts(?:\/ssh-upload-test)?$/, async route => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: { hosts: mock.hosts } });
      return;
    }
    const body = request.postDataJSON();
    writes.push({ method: request.method(), ...body });
    const host = { ...body, id: "ssh-upload-test", kind: "ssh" };
    mock.hosts = [mock.hosts[0], host];
    await route.fulfill({ json: { host, hosts: mock.hosts, connectionReset: false } });
  });
  const dialog = await openConnections(page);
  await dialog.getByLabel("SSH 显示名称", { exact: true }).fill("上传测试");
  await dialog.getByLabel("SSH 主机地址", { exact: true }).fill("host.example.test");
  await dialog.getByRole("button", { name: "身份文件", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "上传私钥", exact: true }).click();
  await (await chooser).setFiles(keyFile);
  await expect(dialog.getByLabel("SSH 身份文件路径", { exact: true })).toHaveValue("/app/data/ssh-keys/key-1.key");
  await expect(dialog.getByRole("status")).toContainText("已上传 id_ed25519");
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "连接成功" })).toBeVisible();
  expect(probes[0].identityFile).toBe("/app/data/ssh-keys/key-1.key");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes[0]).toMatchObject({ method: "POST", identityFile: "/app/data/ssh-keys/key-1.key" });
  expect(deleted).toEqual([]);

  await page.getByRole("button", { name: "编辑 上传测试", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑 SSH 连接", exact: true });
  await expect(edit.getByLabel("SSH 身份文件路径", { exact: true })).toHaveValue("/app/data/ssh-keys/key-1.key");
  await edit.getByLabel("SSH 私钥文件", { exact: true }).setInputFiles(keyFile);
  await expect(edit.getByLabel("SSH 身份文件路径", { exact: true })).toHaveValue("/app/data/ssh-keys/key-2.key");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await expect(edit).toHaveCount(0);
  expect(writes[1]).toMatchObject({ method: "PATCH", identityFile: "/app/data/ssh-keys/key-2.key" });
  expect(uploads).toHaveLength(2);
  expect(deleted).toEqual([]);
});

test("replacing or cancelling draft uploads cleans them without removing an existing key", async ({ page }) => {
  const { deleted } = await mockKeyUploads(page);
  const dialog = await openConnections(page);
  await dialog.getByRole("button", { name: "身份文件", exact: true }).click();
  await dialog.getByLabel("SSH 身份文件路径", { exact: true }).fill("/keys/existing");
  await dialog.getByLabel("SSH 私钥文件", { exact: true }).setInputFiles(keyFile);
  await expect(dialog.getByLabel("SSH 身份文件路径", { exact: true })).toHaveValue("/app/data/ssh-keys/key-1.key");
  await dialog.getByLabel("SSH 私钥文件", { exact: true }).setInputFiles(keyFile);
  await expect(dialog.getByLabel("SSH 身份文件路径", { exact: true })).toHaveValue("/app/data/ssh-keys/key-2.key");
  await expect.poll(() => deleted).toEqual(["key-1"]);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(() => deleted).toEqual(["key-1", "key-2"]);
});

test("upload failures keep the old identity and oversized files never reach the server", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/ssh-keys", async route => {
    attempts++;
    await route.fulfill({ status: 400, json: { error: "此私钥需要口令" } });
  });
  const dialog = await openConnections(page);
  await dialog.getByRole("button", { name: "身份文件", exact: true }).click();
  await dialog.getByLabel("SSH 身份文件路径", { exact: true }).fill("/keys/existing");
  await dialog.getByLabel("SSH 私钥文件", { exact: true }).setInputFiles(keyFile);
  await expect(dialog.getByRole("alert")).toContainText("此私钥需要口令");
  await expect(dialog.getByLabel("SSH 身份文件路径", { exact: true })).toHaveValue("/keys/existing");
  await dialog.getByLabel("SSH 私钥文件", { exact: true }).setInputFiles({ ...keyFile, buffer: Buffer.alloc(64 * 1024 + 1) });
  await expect(dialog.getByRole("alert")).toContainText("64 KB");
  expect(attempts).toBe(1);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("upload in progress prevents closing the modal until the returned key can be cleaned", async ({ page }) => {
  let release: (() => void) | undefined;
  const deleted: string[] = [];
  await page.route(/\/api\/ssh-keys(?:\/[^/?]+)?$/, async route => {
    if (route.request().method() === "DELETE") {
      deleted.push("pending-key");
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 201, json: { id: "pending-key", identityFile: "/app/data/ssh-keys/pending.key" } });
  });
  const dialog = await openConnections(page);
  await dialog.getByRole("button", { name: "身份文件", exact: true }).click();
  await dialog.getByLabel("SSH 私钥文件", { exact: true }).setInputFiles(keyFile);
  await expect(dialog.getByRole("button", { name: "上传中…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release?.();
  await expect(dialog.getByRole("button", { name: "上传私钥", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(() => deleted).toEqual(["pending-key"]);
});
