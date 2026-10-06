import { test, expect, login, send } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", { configurable: true, value: undefined });
  });
});

test("without randomUUID, login, reload and messages keep working", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  const clientId = await page.evaluate(() => sessionStorage.getItem("codex.clientId"));
  expect(clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem("codex.clientId"))).toBe(clientId);
  await send(page, "HTTP 访问也能正常发送消息");
  await expect(page.locator(".agent-message")).toContainText("流式回复完成");
  expect(errors).toEqual([]);
});

test("permission presets can be created without randomUUID", async ({ page, mock }) => {
  await login(page);
  await page.locator(".settings-button").click();
  await page.getByRole("button", { name: "权限预设", exact: true }).click();
  await page.getByRole("button", { name: "新建预设", exact: true }).click();
  await page.getByLabel("预设名称").fill("HTTP 权限预设");
  await page.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect.poll(() => mock.preferences.permissionProfiles[0]?.name).toBe("HTTP 权限预设");
  expect(mock.preferences.permissionProfiles[0].id).toMatch(/^web-[0-9a-f-]{36}$/);
});
