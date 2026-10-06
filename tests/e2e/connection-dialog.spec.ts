import { test, expect, login } from "./fixtures";

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
