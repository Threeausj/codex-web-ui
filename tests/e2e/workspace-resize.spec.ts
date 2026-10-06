import type { Page } from "@playwright/test";
import { test, expect, login, slash, send } from "./fixtures";

const handle = (page: Page) =>
  page.getByRole("separator", { name: "调整工作区宽度", exact: true });
const panel = (page: Page) => page.locator("#workspace-panel");
async function width(page: Page) {
  const bounds = await panel(page).boundingBox();
  expect(bounds).not.toBeNull();
  return Math.round(bounds!.width);
}
async function drag(page: Page, deltaX: number, release = true, y?: number) {
  const bounds = await handle(page).boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2;
  const dragY = y ?? bounds!.y + Math.min(240, bounds!.height / 2);
  await page.mouse.move(x, dragY);
  await page.mouse.down();
  await expect(page.locator(".workspace-drag-overlay")).toBeVisible();
  await page.mouse.move(x + deltaX, dragY, { steps: 8 });
  if (release) {
    await page.mouse.up();
    await expect(page.locator(".workspace-drag-overlay")).toHaveCount(0);
  }
}
async function storedWidth(page: Page) {
  return page.evaluate(() => localStorage.getItem("codex.workspaceWidth"));
}
async function safeLayout(page: Page, minimumChatWidth: number) {
  const layout = await page.evaluate(() => ({
    main: document.querySelector(".main-column")!.getBoundingClientRect().width,
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(layout.main).toBeGreaterThanOrEqual(minimumChatWidth - 1);
  expect(layout.document).toBeLessThanOrEqual(layout.viewport + 1);
}

test("dragging the divider changes real workspace width, keeps chat usable and persists across close, reopen and reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await expect.poll(() => width(page)).toBe(410);
  await drag(page, -180);
  await expect.poll(() => width(page)).toBe(590);
  expect(await storedWidth(page)).toBe("590");
  await safeLayout(page, 320);
  await send(page, "拖动后聊天仍可用");
  await expect(page.locator(".agent-message")).toContainText("流式回复完成");
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await expect.poll(() => width(page)).toBe(590);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "消息输入框", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await expect.poll(() => width(page)).toBe(590);
  expect(await storedWidth(page)).toBe("590");
  await safeLayout(page, 320);
});

test("keyboard steps, width limits and double click reset agree with the separator's accessible range", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await handle(page).focus();
  await page.keyboard.press("Home");
  await expect.poll(() => width(page)).toBe(310);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "310");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => width(page)).toBe(320);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => width(page)).toBe(360);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => width(page)).toBe(350);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => width(page)).toBe(310);
  await page.keyboard.press("End");
  const maximum = Number(await handle(page).getAttribute("aria-valuemax"));
  await expect.poll(() => width(page)).toBe(maximum);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => width(page)).toBe(maximum);
  await safeLayout(page, 320);
  await handle(page).dblclick();
  await expect.poll(() => width(page)).toBe(410);
  expect(await storedWidth(page)).toBeNull();
  await expect(handle(page)).toHaveAttribute("aria-valuetext", "410 像素");
  await page.setViewportSize({ width: 1050, height: 900 });
  await expect.poll(() => width(page)).toBe(360);
  await safeLayout(page, 240);
});

test("viewport and sidebar changes clamp only the displayed width while desktop preference survives mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1560, height: 900 });
  await login(page);
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await drag(page, -430);
  await expect.poll(() => width(page)).toBe(840);
  expect(await storedWidth(page)).toBe("840");
  await page.setViewportSize({ width: 820, height: 900 });
  await expect.poll(() => width(page)).toBeLessThan(840);
  await expect
    .poll(async () => {
      const currentWidth = await width(page);
      const currentMaximum = Number(
        await handle(page).getAttribute("aria-valuemax"),
      );
      return currentWidth - currentMaximum;
    })
    .toBe(0);
  const withSidebar = await width(page);
  expect(withSidebar).toBeLessThan(840);
  await safeLayout(page, 240);
  await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
  await expect.poll(() => width(page)).toBeGreaterThan(withSidebar);
  await safeLayout(page, 240);
  await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();
  await expect.poll(() => width(page)).toBe(withSidebar);
  expect(await storedWidth(page)).toBe("840");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle(page)).toBeHidden();
  await expect.poll(() => width(page)).toBe(390);
  expect(await storedWidth(page)).toBe("840");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1560, height: 900 });
  await expect(handle(page)).toBeVisible();
  await expect.poll(() => width(page)).toBe(840);
  await safeLayout(page, 320);
});

test("dragging across a preview iframe, cancelling with Escape and closing mid-drag restore pointer and body state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await slash(page, "terminal");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("textbox", { name: "预览地址" }).fill("index.html");
  await page.getByRole("button", { name: "打开预览", exact: true }).click();
  const frame = page.locator('iframe[title="项目预览"]');
  await expect(frame).toBeVisible();
  const bodyStyles = await page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }));
  const frameBounds = (await frame.boundingBox())!;
  await drag(page, 230, false, frameBounds.y + 90);
  await expect.poll(() => width(page)).toBe(310);
  await expect(page.locator(".workspace-drag-overlay")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".workspace-drag-overlay")).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    })),
  ).toEqual(bodyStyles);
  await handle(page).dblclick();
  await expect.poll(() => width(page)).toBe(410);
  await drag(page, -100, false);
  await expect.poll(() => width(page)).toBe(510);
  await page.keyboard.press("Escape");
  await expect.poll(() => width(page)).toBe(410);
  await expect(page.locator(".workspace-drag-overlay")).toHaveCount(0);
  await page.mouse.up();
  expect(await storedWidth(page)).toBeNull();
  await drag(page, -80, false);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "关闭工作区", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".workspace-drag-overlay")).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    })),
  ).toEqual(bodyStyles);
  await page.mouse.up();
  expect(await storedWidth(page)).toBeNull();
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await expect.poll(() => width(page)).toBe(410);
  await drag(page, -50);
  await expect.poll(() => width(page)).toBe(460);
});

test("workspace drag resizes the existing PTY's columns without starting another terminal", async ({
  page,
  mock,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await slash(page, "terminal");
  await expect.poll(() => mock.request("command/exec")?.params.tty).toBe(true);
  const processId = mock.request("command/exec")!.params.processId;
  await expect
    .poll(() => mock.request("command/exec/resize")?.params.processId)
    .toBe(processId);
  const initialColumns = mock.request("command/exec/resize")!.params.size.cols;
  await drag(page, -180);
  await expect
    .poll(() => mock.request("command/exec/resize")?.params.size.cols)
    .toBeGreaterThan(initialColumns);
  expect(mock.request("command/exec/resize")?.params.processId).toBe(processId);
  await handle(page).focus();
  await page.keyboard.press("Home");
  await expect
    .poll(() => mock.request("command/exec/resize")?.params.size.cols)
    .toBeLessThan(initialColumns);
  expect(
    mock.requests.filter((request) => request.method === "command/exec"),
  ).toHaveLength(1);
  await expect(page.getByLabel("交互式终端")).toBeVisible();
  await page.getByRole("button", { name: "结束终端", exact: true }).click();
});
