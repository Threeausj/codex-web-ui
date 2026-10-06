import { test, expect, login, MockCodex } from "./fixtures";
import type { Page } from "@playwright/test";

async function openProjects(page: Page) {
  const sidebar = page.getByRole("button", { name: "打开侧边栏", exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator(".settings-button").click();
  await page.locator(".settings-nav").getByRole("button", { name: "项目", exact: true }).click();
  return page.getByRole("dialog", { name: "设置", exact: true });
}
const picker = (page: Page) => page.getByRole("dialog", { name: "选择项目文件夹", exact: true });
const browseRoute = /\/api\/hosts\/[^/]+\/directories(?:\?|$)/;

test("browse and typed paths select a project and extra workspace roots, excluding files", async ({ page, mock }) => {
  const calls: string[] = [];
  await page.route(browseRoute, async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "/workspace";
    calls.push(path);
    await route.fulfill({ json: {
      path,
      entries: path === "/workspace" ? [
        { fileName: "中文项目", isDirectory: true },
        { fileName: "README.md", isDirectory: false },
      ] : [],
    } });
  });
  await login(page);
  const settings = await openProjects(page);
  await settings.getByRole("button", { name: "浏览项目文件夹", exact: true }).click();
  const dialog = picker(page);
  await expect(dialog.getByRole("textbox", { name: "文件夹路径", exact: true })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "进入 README.md", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "进入 中文项目", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "文件夹路径", exact: true })).toHaveValue("/workspace/中文项目");
  await expect(dialog.getByText("此文件夹没有子文件夹", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "上级文件夹", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "进入 中文项目", exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "文件夹路径", exact: true }).fill("/workspace/手输项目");
  await expect(dialog.getByRole("button", { name: "使用文件夹", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "文件夹路径", exact: true }).press("Enter");
  await expect(dialog.getByRole("button", { name: "使用文件夹", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "使用文件夹", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "项目路径", exact: true })).toHaveValue("/workspace/手输项目");
  await settings.getByRole("button", { name: "选择其他工作目录", exact: true }).click();
  await dialog.getByRole("textbox", { name: "文件夹路径", exact: true }).fill("/workspace/共享");
  await dialog.getByRole("textbox", { name: "文件夹路径", exact: true }).press("Enter");
  await expect(dialog.getByRole("button", { name: "使用文件夹", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "使用文件夹", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "其他工作目录", exact: true })).toHaveValue("/workspace/共享");
  await settings.getByRole("button", { name: "添加项目", exact: true }).click();
  await expect.poll(() => mock.projects.find((project) => project.path === "/workspace/手输项目")).toMatchObject({
    hostId: "local", rootPaths: ["/workspace/共享"],
  });
  expect(calls).toEqual(["/workspace", "/workspace/中文项目", "/workspace", "/workspace/手输项目", "/workspace/手输项目", "/workspace/共享"]);
});

test("remote project browsing and addition preserve the current local chat and draft, resetting paths between hosts", async ({ page, mock }) => {
  const remote = new MockCodex();
  mock.hosts.push({ id: "ssh-folders", name: "远程开发机", kind: "ssh", hostname: "server.invalid" });
  mock.hostMocks.set("ssh-folders", remote);
  const calls: Array<{ hostId: string; path: string | null }> = [];
  await page.route(browseRoute, async (route) => {
    const url = new URL(route.request().url());
    const hostId = decodeURIComponent(url.pathname.split("/")[3]!);
    calls.push({ hostId, path: url.searchParams.get("path") });
    await route.fulfill({ json: { path: "/root", entries: [{ fileName: "远程项目", isDirectory: true }] } });
  });
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.fill("保留当前草稿");
  const resumeCount = mock.requests.filter((request) => request.method === "thread/resume").length;
  const settings = await openProjects(page);
  await expect(settings.getByRole("combobox", { name: "项目主机", exact: true })).toHaveValue("local");
  await settings.getByRole("textbox", { name: "项目路径", exact: true }).fill("/local/path");
  await settings.getByRole("textbox", { name: "其他工作目录", exact: true }).fill("/local/extra");
  await settings.getByRole("combobox", { name: "项目主机", exact: true }).selectOption("ssh-folders");
  await expect(settings.getByRole("textbox", { name: "项目路径", exact: true })).toHaveValue("");
  await expect(settings.getByRole("textbox", { name: "其他工作目录", exact: true })).toHaveValue("");
  await settings.getByRole("button", { name: "浏览项目文件夹", exact: true }).click();
  const dialog = picker(page);
  await expect(dialog.locator(".picker-host")).toHaveText("远程开发机");
  await expect(dialog.getByRole("button", { name: "进入 远程项目", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "使用文件夹", exact: true }).click();
  await settings.getByRole("textbox", { name: "其他工作目录", exact: true }).fill("/remote/shared");
  await settings.getByRole("button", { name: "添加项目", exact: true }).click();
  await expect(settings.getByText("项目已添加", { exact: true })).toBeVisible();
  expect(calls).toEqual([{ hostId: "ssh-folders", path: null }]);
  expect(mock.projects.find((project) => project.path === "/root")).toMatchObject({ hostId: "ssh-folders", rootPaths: ["/remote/shared"] });
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.locator(".header-host")).toHaveText("本机");
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(input).toHaveValue("保留当前草稿");
  expect(mock.requests.filter((request) => request.method === "thread/resume")).toHaveLength(resumeCount);
  expect(remote.request("thread/resume")).toBeUndefined();
  expect(remote.request("initialize")).toBeUndefined();
});

test("quick directory navigation ignores old replies and a failed directory cannot be confirmed", async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route(browseRoute, async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "/workspace";
    if (path === "/slow") await new Promise<void>((resolve) => { release = resolve; });
    if (path === "/missing") return route.fulfill({ status: 404, json: { error: "文件夹不存在" } });
    await route.fulfill({ json: { path, entries: [{ fileName: path === "/slow" ? "过期目录" : "当前目录", isDirectory: true }] } });
  });
  await login(page);
  const settings = await openProjects(page);
  await settings.getByRole("button", { name: "浏览项目文件夹", exact: true }).click();
  const dialog = picker(page);
  const address = dialog.getByRole("textbox", { name: "文件夹路径", exact: true });
  await expect(address).toHaveValue("/workspace");
  await address.fill("/slow");
  await address.press("Enter");
  await expect.poll(() => !!release).toBe(true);
  await expect(dialog.getByRole("button", { name: "使用文件夹", exact: true })).toBeDisabled();
  await address.fill("/fast");
  await address.press("Enter");
  await expect(address).toHaveValue("/fast");
  await expect(dialog.getByRole("button", { name: "使用文件夹", exact: true })).toBeEnabled();
  const oldResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get("path") === "/slow");
  release?.();
  await oldResponse;
  await page.waitForTimeout(100);
  await expect(address).toHaveValue("/fast");
  await expect(dialog.getByRole("button", { name: "进入 过期目录", exact: true })).toHaveCount(0);
  await address.fill("/missing");
  await address.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("文件夹不存在");
  await expect(dialog.getByRole("button", { name: "使用文件夹", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "项目路径", exact: true })).toHaveValue("");
});

test("phone folder dialog traps focus and ignores an old reply after Escape and reopening", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 667 });
  let release: (() => void) | undefined;
  let count = 0;
  await page.route(browseRoute, async (route) => {
    const current = ++count;
    if (current === 1) await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { path: current === 1 ? "/stale" : "/fresh", entries: [] } });
  });
  await login(page);
  const settings = await openProjects(page);
  const trigger = settings.getByRole("button", { name: "浏览项目文件夹", exact: true });
  await trigger.click();
  const dialog = picker(page);
  await expect.poll(() => !!release).toBe(true);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(667);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByRole("textbox", { name: "文件夹路径", exact: true })).toHaveCSS("font-size", "16px");
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog.getByRole("textbox", { name: "文件夹路径", exact: true })).toHaveValue("/fresh");
  const oldResponse = page.waitForResponse((response) => response.url().includes("/directories"));
  release?.();
  await oldResponse;
  await page.waitForTimeout(100);
  await expect(dialog.getByRole("textbox", { name: "文件夹路径", exact: true })).toHaveValue("/fresh");
});
