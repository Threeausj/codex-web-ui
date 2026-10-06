import type { Page } from "@playwright/test";
import { test, expect, login } from "./fixtures";

const newFingerprint = `SHA256:${"A".repeat(43)}`;
const oldFingerprint = `SHA256:${"B".repeat(43)}`;

function inspection(hostname = "host.example.test", port = 22, status = "unknown") {
  return {
    hostname,
    port,
    status,
    keys: [{ type: "ssh-ed25519", fingerprint: newFingerprint }],
    previousFingerprints: status === "changed" ? [{ type: "ssh-ed25519", fingerprint: oldFingerprint }] : [],
    challenge: status === "trusted" ? "" : `${hostname}:${port}:challenge`,
    expiresAt: Date.now() + 60_000,
  };
}

async function openConnection(page: Page) {
  await login(page);
  const sidebarButton = page.getByRole("button", { name: "打开侧边栏", exact: true });
  if (await sidebarButton.isVisible()) await sidebarButton.click();
  await page.locator(".settings-button").click();
  await page.locator(".settings-nav").getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "添加 SSH 连接", exact: true }).click();
  return page.getByRole("dialog", { name: "添加 SSH 连接", exact: true });
}

test("structured host-key failures fetch public fingerprints despite an untranslated message and trust retries the same unsaved draft", async ({ page, mock }) => {
  const probes: any[] = [];
  const scans: any[] = [];
  const trusts: any[] = [];
  await page.route("**/api/hosts/test", async route => {
    probes.push(route.request().postDataJSON());
    await route.fulfill(probes.length === 1
      ? { json: { ok: false, stage: "ssh", hostKeyRequired: true, message: "Please confirm this server's identity." } }
      : { json: { ok: true, version: "0.test", stage: "ready" } });
  });
  await page.route("**/api/hosts/key/inspect", async route => {
    expect(route.request().headers()["x-csrf-token"]).toBe("mock-csrf");
    scans.push(route.request().postDataJSON());
    await route.fulfill({ json: inspection("host.example.test", 2222) });
  });
  await page.route("**/api/hosts/key/trust", async route => {
    expect(route.request().headers()["x-csrf-token"]).toBe("mock-csrf");
    trusts.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  const dialog = await openConnection(page);
  await dialog.getByLabel("SSH 显示名称", { exact: true }).fill("尚未保存的开发机");
  await dialog.getByLabel("SSH 主机地址", { exact: true }).fill("dev@host.example.test");
  await dialog.getByLabel("SSH 端口", { exact: true }).fill("2222");
  await dialog.getByRole("button", { name: "身份文件", exact: true }).click();
  await dialog.getByLabel("SSH 身份文件路径", { exact: true }).fill("/keys/dev");
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  const fingerprints = dialog.getByRole("region", { name: "SSH 服务器指纹", exact: true });
  await expect(fingerprints).toContainText("首次连接：确认服务器指纹");
  await expect(fingerprints).toContainText("ssh-ed25519");
  await expect(fingerprints).toContainText(newFingerprint);
  expect(scans).toEqual([{ hostname: "dev@host.example.test", port: 2222 }]);
  expect(trusts).toEqual([]);
  expect(mock.hosts).toHaveLength(1);
  await fingerprints.getByRole("button", { name: "信任并测试连接", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "连接成功" })).toContainText("0.test");
  expect(trusts).toEqual([{
    hostname: "dev@host.example.test",
    port: 2222,
    challenge: "host.example.test:2222:challenge",
    replace: false,
  }]);
  expect(probes).toHaveLength(2);
  expect(probes[1]).toEqual(probes[0]);
  expect(mock.hosts).toHaveLength(1);
  await expect(fingerprints).toContainText("服务器指纹已受信任");
  await expect(fingerprints.getByRole("button", { name: "信任并测试连接", exact: true })).toHaveCount(0);
});

test("a changed key shows old and new fingerprints and requires an explicit replacement on dark phone layouts", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 667 });
  await page.emulateMedia({ colorScheme: "dark" });
  const trusts: any[] = [];
  await page.route("**/api/hosts/key/inspect", route => route.fulfill({ json: inspection("host.example.test", 22, "changed") }));
  await page.route("**/api/hosts/key/trust", async route => {
    trusts.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/hosts/test", route => route.fulfill({ json: { ok: true, stage: "ready" } }));
  const dialog = await openConnection(page);
  await dialog.getByLabel("SSH 主机地址", { exact: true }).fill("host.example.test");
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  const fingerprints = dialog.getByRole("region", { name: "SSH 服务器指纹", exact: true });
  await expect(fingerprints).toContainText("服务器指纹已变更");
  await expect(fingerprints).toContainText("此前信任的指纹");
  await expect(fingerprints).toContainText(oldFingerprint);
  await expect(fingerprints).toContainText(newFingerprint);
  const trust = fingerprints.getByRole("button", { name: "替换指纹并测试连接", exact: true });
  await expect(trust).toBeDisabled();
  expect(trusts).toEqual([]);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(667);
  expect(await fingerprints.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 255, 255)");
  await fingerprints.getByRole("checkbox", { name: "我已确认服务器密钥变更，同意替换此前信任的指纹" }).check();
  await trust.click();
  await expect(dialog.getByRole("status").filter({ hasText: "连接成功" })).toBeVisible();
  expect(trusts).toEqual([{
    hostname: "host.example.test", port: null,
    challenge: "host.example.test:22:challenge", replace: true,
  }]);
});

test("fingerprint discovery validates only the target, and editing its address or port invalidates an old challenge", async ({ page }) => {
  const scans: any[] = [];
  const trusts: any[] = [];
  await page.route("**/api/hosts/key/inspect", async route => {
    const body = route.request().postDataJSON();
    scans.push(body);
    await route.fulfill({ json: inspection(body.hostname, body.port || 22) });
  });
  await page.route("**/api/hosts/key/trust", async route => {
    trusts.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/hosts/test", route => route.fulfill({ json: { ok: true, stage: "ready" } }));
  const dialog = await openConnection(page);
  await dialog.getByRole("button", { name: "身份文件", exact: true }).click();
  await dialog.getByLabel("SSH 主机地址", { exact: true }).fill("first.example.test");
  await dialog.getByLabel("SSH 端口", { exact: true }).fill("70000");
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("1–65535");
  expect(scans).toEqual([]);
  await dialog.getByLabel("SSH 端口", { exact: true }).fill("22");
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  const fingerprints = dialog.getByRole("region", { name: "SSH 服务器指纹", exact: true });
  await expect(fingerprints).toBeVisible();
  await expect(dialog.getByLabel("SSH 身份文件路径", { exact: true })).toHaveValue("");
  await fingerprints.getByRole("button", { name: "信任并测试连接", exact: true }).click();
  expect(trusts).toEqual([]);
  await dialog.getByLabel("SSH 身份文件路径", { exact: true }).fill("/keys/test");
  await dialog.getByLabel("SSH 主机地址", { exact: true }).fill("second.example.test");
  await expect(fingerprints).toHaveCount(0);
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  await expect(fingerprints).toContainText("second.example.test:22");
  await dialog.getByLabel("SSH 端口", { exact: true }).fill("2222");
  await expect(fingerprints).toHaveCount(0);
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  await expect(fingerprints).toContainText("second.example.test:2222");
  await fingerprints.getByRole("button", { name: "信任并测试连接", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "连接成功" })).toBeVisible();
  expect(trusts).toEqual([{
    hostname: "second.example.test", port: 2222,
    challenge: "second.example.test:2222:challenge", replace: false,
  }]);
  expect(scans).toHaveLength(3);
});

test("late fingerprint scans cannot populate a closed or newly opened dialog", async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route("**/api/hosts/key/inspect", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: inspection() });
  });
  const dialog = await openConnection(page);
  await dialog.getByLabel("SSH 主机地址", { exact: true }).fill("host.example.test");
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "正在获取服务器指纹…", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "添加 SSH 连接", exact: true }).click();
  release?.();
  await expect(dialog.getByLabel("SSH 主机地址", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("region", { name: "SSH 服务器指纹", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("trusting is sent once, holds the modal open during its write and safely closes during the later test", async ({ page }) => {
  const trusts: any[] = [];
  const deleted: string[] = [];
  let releaseTrust: (() => void) | undefined;
  let releaseTest: (() => void) | undefined;
  await page.route(/\/api\/ssh-keys(?:\/[^/?]+)?$/, async route => {
    if (route.request().method() === "DELETE") {
      deleted.push("draft-key");
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({ status: 201, json: { id: "draft-key", identityFile: "/app/data/ssh-keys/draft.key" } });
  });
  await page.route("**/api/hosts/key/inspect", route => route.fulfill({ json: inspection() }));
  await page.route("**/api/hosts/key/trust", async route => {
    trusts.push(route.request().postDataJSON());
    await new Promise<void>(resolve => { releaseTrust = resolve; });
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/hosts/test", async route => {
    await new Promise<void>(resolve => { releaseTest = resolve; });
    await route.fulfill({ json: { ok: true, version: "stale", stage: "ready" } });
  });
  const dialog = await openConnection(page);
  await dialog.getByLabel("SSH 主机地址", { exact: true }).fill("host.example.test");
  await dialog.getByRole("button", { name: "身份文件", exact: true }).click();
  await dialog.getByLabel("SSH 私钥文件", { exact: true }).setInputFiles({
    name: "id_ed25519", mimeType: "application/octet-stream", buffer: Buffer.from("fixture private key bytes"),
  });
  await expect(dialog.getByLabel("SSH 身份文件路径", { exact: true })).toHaveValue("/app/data/ssh-keys/draft.key");
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  await dialog.getByRole("button", { name: "信任并测试连接", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "正在保存服务器指纹…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "关闭 SSH 连接", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(trusts).toHaveLength(1);
  expect(deleted).toEqual([]);
  releaseTrust?.();
  await expect(dialog.getByRole("status").filter({ hasText: "正在测试连接" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  releaseTest?.();
  await expect.poll(() => deleted).toEqual(["draft-key"]);
  await page.getByRole("button", { name: "添加 SSH 连接", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "SSH 服务器指纹", exact: true })).toHaveCount(0);
});

test("expired confirmations are cleared and server rejection requires a fresh discovery", async ({ page }) => {
  const trusts: any[] = [];
  let scans = 0;
  await page.route("**/api/hosts/key/inspect", async route => {
    scans++;
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({ json: { ...inspection(), expiresAt: now + 2_000 } });
  });
  await page.route("**/api/hosts/key/trust", async route => {
    trusts.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { error: "服务器指纹确认已过期，请重新获取服务器指纹。" } });
  });
  const dialog = await openConnection(page);
  await page.clock.install();
  await dialog.getByLabel("SSH 主机地址", { exact: true }).fill("host.example.test");
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  const fingerprints = dialog.getByRole("region", { name: "SSH 服务器指纹", exact: true });
  await expect(fingerprints).toBeVisible();
  await page.clock.fastForward(2_001);
  await expect(fingerprints).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toContainText("指纹确认已过期");
  expect(trusts).toEqual([]);
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  await expect(fingerprints).toBeVisible();
  await fingerprints.getByRole("button", { name: "信任并测试连接", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("指纹确认已过期");
  await expect(fingerprints).toHaveCount(0);
  expect(trusts).toHaveLength(1);
  expect(scans).toBe(2);
});

test("already trusted keys stay informational, and discovery failures do not change the draft", async ({ page }) => {
  let scans = 0;
  const trusts: any[] = [];
  await page.route("**/api/hosts/key/inspect", async route => {
    scans++;
    await route.fulfill(scans === 1
      ? { status: 502, json: { error: "无法获取服务器指纹，请检查服务器地址与端口。" } }
      : { json: inspection("host.example.test", 22, "trusted") });
  });
  await page.route("**/api/hosts/key/trust", async route => {
    trusts.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  const dialog = await openConnection(page);
  await dialog.getByLabel("SSH 主机地址", { exact: true }).fill("host.example.test");
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("无法获取服务器指纹");
  await expect(dialog.getByLabel("SSH 主机地址", { exact: true })).toHaveValue("host.example.test");
  await dialog.getByRole("button", { name: "获取服务器指纹", exact: true }).click();
  const fingerprints = dialog.getByRole("region", { name: "SSH 服务器指纹", exact: true });
  await expect(fingerprints).toContainText("服务器指纹已受信任");
  await expect(fingerprints.getByRole("button")).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(trusts).toEqual([]);
});
