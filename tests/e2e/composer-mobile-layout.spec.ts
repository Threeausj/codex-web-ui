import { test, expect, login } from "./fixtures";

for (const width of [320, 390, 430]) {
  test(`mobile ${width}px keeps composer controls aligned in one frame, with the keyboard open`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 844 });
    mock.projects[0].name = "手机长项目名".repeat(12);
    mock.hosts[0].name = "主机名称".repeat(16);
    await login(page);
    const verify = async () => {
      const area = await page.locator(".composer-area").boundingBox();
      const context = await page.locator(".new-context").boundingBox();
      const input = await page.getByRole("textbox", { name: "消息输入框" }).boundingBox();
      const toolbar = await page.locator(".composer-toolbar").boundingBox();
      const tools = await page.locator(".composer-tools").boundingBox();
      const submit = await page.locator(".composer-submit").boundingBox();
      const send = await page.getByRole("button", { name: "发送消息", exact: true }).boundingBox();
      expect(area!.x).toBeGreaterThanOrEqual(0);
      expect(area!.x + area!.width).toBeLessThanOrEqual(width);
      expect(Math.abs(context!.x - area!.x)).toBeLessThanOrEqual(1.1);
      expect(Math.abs(context!.width - area!.width)).toBeLessThanOrEqual(2.1);
      expect(Math.abs(input!.x - toolbar!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(tools!.x - submit!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(tools!.width - submit!.width)).toBeLessThanOrEqual(1);
      expect(send!.x + send!.width).toBeLessThanOrEqual(area!.x + area!.width - 8);
      expect(await page.locator(".composer-area").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);
    };
    await verify();
    await page.setViewportSize({ width, height: 480 });
    await page.getByRole("textbox", { name: "消息输入框" }).fill("键盘打开后仍能输入和发送");
    await verify();
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  });
}

test("mobile touch can choose a file without losing input focus or text", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("请查看 ");
  await page.getByRole("button", { name: "选择模式或引用项目文件", exact: true }).click();
  const option = page.getByRole("listbox").getByRole("option").filter({ hasText: "README.md" });
  await expect(option).toBeVisible();
  await option.dispatchEvent("click");
  await expect(input).toHaveValue("请查看 @/workspace/demo/README.md ");
  await expect(input).toBeFocused();
  expect(mock.request("turn/start")).toBeUndefined();
});

test("website favicon and installed app icons use new URLs for the supplied Command logo", async ({ page }) => {
  await login(page);
  const path = "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3";
  const faviconHref = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(faviconHref).toBe("/favicon-command.svg");
  const favicon = await page.request.get(faviconHref!);
  expect(await favicon.text()).toContain(path);
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await page.request.get(manifestHref!)).json();
  expect(manifest.id).toBe("/");
  expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([
    "/icons/icon-command-192.png", "/icons/icon-command-512.png", "/icons/icon-command-maskable-512.png",
  ]);
  const appleTouchHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(appleTouchHref).toBe("/icons/apple-touch-icon-command.png");
  for (const iconHref of [...manifest.icons.map((icon: { src: string }) => icon.src), appleTouchHref]) {
    const icon = await page.request.get(iconHref!);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/png");
  }
});
