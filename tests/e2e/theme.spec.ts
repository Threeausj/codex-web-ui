import type { Locator, Page } from "@playwright/test";
import { test, expect, login, send } from "./fixtures";

/** Check the actual rendered colors, including transparent conversation layers.
 * A correct data-theme value alone missed the former white document canvas. */
async function renderedColors(element: Locator) {
  return element.evaluate((node) => {
    const context = document.createElement("canvas").getContext("2d")!;
    function rgba(color: string) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).map((v, i) => i === 3 ? v / 255 : v);
    }
    const layers: number[][] = [];
    for (let current: Element | null = node; current; current = current.parentElement)
      layers.unshift(rgba(getComputedStyle(current).backgroundColor));
    let background = [255, 255, 255];
    for (const layer of layers)
      background = background.map((value, index) => layer[index]! * layer[3]! + value * (1 - layer[3]!));
    const foreground = rgba(getComputedStyle(node).color).slice(0, 3);
    const luminance = (rgb: number[]) => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const a = luminance(foreground), b = luminance(background);
    return { foreground, background, luminance: b, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
  });
}

async function readableDark(element: Locator) {
  await expect(element).toBeVisible();
  const colors = await renderedColors(element);
  expect(colors.luminance, "The visible surface must be dark, including inherited canvas backgrounds").toBeLessThan(.1);
  expect(colors.contrast, "Small UI text must remain readable against its actual background").toBeGreaterThanOrEqual(4.5);
}

async function openSettings(page: Page) {
  const sidebar = page.getByRole("button", { name: "打开侧边栏", exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator(".settings-button").click();
  return page.getByRole("dialog", { name: "设置", exact: true });
}

test("system appearance updates the document canvas, login, native fields and PWA bar", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await readableDark(page.locator(".login-card > h1"));
  await readableDark(page.locator(".login-caption"));
  await readableDark(page.locator('.login-password input'));
  expect((await renderedColors(page.locator("html"))).luminance).toBeLessThan(.1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#20211f");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  expect((await renderedColors(page.locator("html"))).luminance).toBeGreaterThan(.8);
  expect((await renderedColors(page.locator(".login-caption"))).contrast).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#fafaf9");
});

test("dark conversation, Markdown, options, approvals and workspace share readable surfaces", async ({ page, mock }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const history = mock.turns.get("thread-existing")![0];
  history.items[1].text = [
    "历史保持可读",
    "使用 `inline-code` 与 [文档](https://example.invalid/docs)。",
    "```ts\nconst dark = true;\n```",
    "| 名称 | 状态 |\n| --- | --- |\n| 主题 | 深色 |",
  ].join("\n\n");
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await readableDark(page.locator(".main-header h1"));
  await readableDark(page.locator(".sidebar-account"));
  await readableDark(page.locator(".user-bubble"));
  await readableDark(page.locator(".agent-message .markdown"));
  await readableDark(page.locator(".markdown pre"));
  await readableDark(page.locator(".markdown a"));
  await readableDark(page.locator(".markdown th").first());
  await readableDark(page.getByRole("textbox", { name: "消息输入框" }));
  const model = page.getByRole("combobox", { name: "选择模型" });
  await readableDark(model);
  const optionColors = await renderedColors(model.locator("option").first());
  expect(optionColors.luminance).toBeLessThan(.1);
  expect(optionColors.contrast).toBeGreaterThanOrEqual(4.5);

  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await page.locator("#workspace-panel").getByRole("button", { name: "文件", exact: true }).click();
  await page.locator("#workspace-panel").getByRole("button", { name: "README.md", exact: true }).click();
  await readableDark(page.getByRole("textbox", { name: "README.md 文件内容", exact: true }));
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();

  mock.requireApprovalNext = true;
  await send(page, "验证深色审批");
  const approval = page.getByRole("region", { name: "批准命令执行" });
  await readableDark(approval);
  await readableDark(approval.locator(".approval-command"));
  await readableDark(approval.locator(".approval-icon"));
  await readableDark(approval.locator(".approval-reason"));
  await page.screenshot({ path: test.info().outputPath("dark-conversation.png") });
  await approval.getByRole("button", { name: "允许一次", exact: true }).click();
  await expect(approval).toHaveCount(0);
});

test("explicit appearance survives reload and overrides system changes until system is selected", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  let settings = await openSettings(page);
  const appearance = () => settings.locator(".setting-row").filter({ hasText: "外观" }).locator("select");
  await appearance().selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect((await renderedColors(settings)).luminance).toBeGreaterThan(.8);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  settings = await openSettings(page);
  await appearance().selectOption("dark");
  await readableDark(settings);
  await readableDark(appearance());
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await appearance().selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await readableDark(settings);
});

test("phone dark settings and native folder dialog retain contrast and fit the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route(/\/api\/hosts\/[^/]+\/directories(?:\?|$)/, route =>
    route.fulfill({ json: { path: "/workspace", entries: [{ fileName: "中文项目", isDirectory: true }] } }));
  await login(page);
  const settings = await openSettings(page);
  await readableDark(settings);
  await readableDark(settings.locator(".settings-description"));
  await readableDark(settings.getByRole("combobox", { name: "全局默认权限" }));
  await settings.locator(".settings-nav").getByRole("button", { name: "项目", exact: true }).click();
  await settings.getByRole("button", { name: "浏览项目文件夹", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择项目文件夹", exact: true });
  await readableDark(picker);
  await readableDark(picker.getByRole("textbox", { name: "文件夹路径", exact: true }));
  await readableDark(picker.getByRole("button", { name: "进入 中文项目", exact: true }));
  await expect(picker.getByRole("button", { name: "使用文件夹", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("dark-phone-folder-dialog.png") });
});
