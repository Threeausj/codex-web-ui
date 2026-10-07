import type { Locator, Page } from "@playwright/test";
import { test, expect, login, type MockCodex } from "./fixtures";

const root = "/workspace/demo";
const panel = (page: Page) => page.locator("#workspace-panel");

function changedFiles(count = 45) {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      path: `${root}/src/features/界面/long-component-name-${number}.vue`,
      kind: { type: "update", movePath: null },
      diff: [
        "@@ -1,8 +1,9 @@",
        `-const oldValue = 'original ${number}'`,
        `+const newValue = 'updated ${number}'`,
        " export default {",
        ...Array.from({ length: 8 }, (_, line) => `   property${line}: ${line},`),
        `+  label: '中文文件 ${number}',`,
        " }",
      ].join("\n"),
    };
  });
}

function installChanges(mock: MockCodex, changes: ReturnType<typeof changedFiles>) {
  mock.turns.get("thread-existing")![0].items.splice(1, 0, {
    id: "layout-file-changes",
    type: "fileChange",
    status: "completed",
    changes,
  });
}

async function openHistory(page: Page) {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText("历史保持可读", { exact: true })).toBeVisible();
}

async function openWorkspace(page: Page, name: "变更" | "预览") {
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await panel(page).getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

async function boundedPreview(page: Page, title = "项目预览", containerSelector = ".preview-frame-container") {
  const frame = panel(page).locator(`iframe[title="${title}"]`);
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => {
      const [frameBox, containerBox, panelBox] = await Promise.all([
        frame.boundingBox(),
        panel(page).locator(containerSelector).boundingBox(),
        panel(page).boundingBox(),
      ]);
      if (!frameBox || !containerBox || !panelBox) return false;
      return (
        frameBox.height >= 100 &&
        frameBox.width >= 250 &&
        frameBox.x >= containerBox.x - 1 &&
        frameBox.y >= containerBox.y - 1 &&
        frameBox.x + frameBox.width <= containerBox.x + containerBox.width + 1 &&
        frameBox.y + frameBox.height <= containerBox.y + containerBox.height + 1 &&
        frameBox.y + frameBox.height <= panelBox.y + panelBox.height + 1
      );
    })
    .toBe(true);
  await expect(page.frameLocator(`iframe[title="${title}"]`).locator("#status"))
    .toHaveText("isolated");
}

async function actualDiffLines(pre: Locator, expected: string) {
  // Reading rendered text catches the former literal "\\n" in Vue templates;
  // fixtures supply actual protocol newlines rather than pre-escaped strings.
  const text = await pre.textContent();
  expect(text).not.toContain("\\n");
  expect(text?.trimEnd()).toBe(expected);
  const [hunk, removal, addition] = await Promise.all([
    pre.locator(".diff-hunk").first().boundingBox(),
    pre.locator(".diff-remove").first().boundingBox(),
    pre.locator(".diff-add").first().boundingBox(),
  ]);
  expect(hunk).not.toBeNull();
  expect(removal).not.toBeNull();
  expect(addition).not.toBeNull();
  expect(removal!.y).toBeGreaterThan(hunk!.y);
  expect(addition!.y).toBeGreaterThan(removal!.y);
}

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "phone", width: 390, height: 844 },
]) {
  test(`${viewport.label}: 45 changed files retain readable cards and the final file can be reached`, async ({ page, mock }) => {
    const changes = changedFiles();
    installChanges(mock, changes);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHistory(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openWorkspace(page, "变更");
    const view = panel(page).locator(".changes-view");
    const cards = view.locator(".change-card");
    await expect(view.getByText("本次对话 · 45 个文件", { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(45);
    const heights = await cards.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    expect(Math.min(...heights), "Compact headings retain usable controls").toBeGreaterThanOrEqual(viewport.label === "phone" ? 40 : 32);
    expect(Math.max(...heights), "Collapsed headings stay compact").toBeLessThanOrEqual(viewport.label === "phone" ? 44 : 38);
    await expect(cards.first()).not.toHaveAttribute("open", "");
    await expect(cards.first().locator(".diff-code")).toBeHidden();
    await cards.first().locator("summary").click();
    const scroll = await view.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }));
    expect(scroll.content).toBeGreaterThan(scroll.height * 2);
    await actualDiffLines(cards.first().locator(".diff-code"), changes[0]!.diff);
    await page.screenshot({ path: test.info().outputPath(`workspace-changes-${viewport.label}.png`) });
    const last = cards.last();
    await last.scrollIntoViewIfNeeded();
    await expect(last.locator(".file-diff-heading")).toBeInViewport();
    expect(await view.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await last.locator("summary").click();
    await actualDiffLines(last.locator(".diff-code"), changes.at(-1)!.diff);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await last.getByRole("button", { name: `打开文件 ${changes.at(-1)!.path}`, exact: true }).click();
    await expect(panel(page).getByRole("textbox", { name: "long-component-name-45.vue 文件内容" })).toHaveValue(/文件读取正常/);
    expect(mock.request("fs/readFile")?.params.path).toBe(changes.at(-1)!.path);
  });
}

test("expanded chat file-change output uses real diff lines as the workspace does", async ({ page, mock }) => {
  const changes = changedFiles(1);
  installChanges(mock, changes);
  await openHistory(page);
  const turn = page.locator('.conversation-turn[data-turn-id="turn-history"]');
  await turn.locator(".turn-activity > summary").click();
  await turn.locator(".activity-batch > summary").click();
  await turn.locator(".tool-item > summary").click();
  await expect(turn.locator(".file-diff .diff-code")).toBeHidden();
  await turn.locator(".file-diff > summary").click();
  const diff = turn.locator(".file-diff .diff-code");
  await expect(diff).toBeVisible();
  await actualDiffLines(diff, changes[0]!.diff);
});

for (const viewport of [
  { label: "desktop", width: 1440, height: 480 },
  { label: "phone", width: 390, height: 480 },
]) {
  test(`${viewport.label}: short-screen HTML preview keeps toolbar controls usable and iframe within the workspace`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await login(page);
    await openWorkspace(page, "预览");
    const input = panel(page).getByRole("textbox", { name: "预览地址" });
    await input.fill("index.html");
    await panel(page).getByRole("button", { name: "打开预览", exact: true }).click();
    await expect(input).toBeInViewport();
    const toolbarBox = await panel(page).locator(".preview-toolbar").boundingBox();
    expect(toolbarBox!.height).toBeGreaterThanOrEqual(40);
    await expect(panel(page).getByRole("button", { name: "刷新预览", exact: true })).toBeInViewport();
    await boundedPreview(page);
    await panel(page).getByRole("button", { name: "手机预览", exact: true }).click();
    await boundedPreview(page);
    await panel(page).getByRole("button", { name: "刷新预览", exact: true }).click();
    await boundedPreview(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test(`${viewport.label}: short-screen development preview fits its iframe below usable controls`, async ({ page }) => {
    const connections: any[] = [];
    const released: string[] = [];
    await page.route("**/api/dev-previews**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "POST") {
        connections.push(request.postDataJSON());
        const id = `layout-ticket-${connections.length}`;
        return route.fulfill({ json: { id, url: `/api/dev-previews/${id}/page`, expiresAt: Date.now() + 3_600_000 } });
      }
      if (request.method() === "DELETE") {
        released.push(url.pathname.split("/").at(-1)!);
        return route.fulfill({ json: { ok: true } });
      }
      // This ticket page is fixture-only and requires no real Vite process,
      // SSH tunnel, account or model. Its script verifies the real iframe sandbox.
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><p id="status">pending</p><script>try{parent.document.body.dataset.previewEscape="escaped";document.getElementById("status").textContent="escaped"}catch{document.getElementById("status").textContent="isolated"}</script>' });
    });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await login(page);
    await openWorkspace(page, "预览");
    await panel(page).getByRole("button", { name: "开发服务", exact: true }).click();
    await panel(page).getByRole("spinbutton", { name: "开发服务端口", exact: true }).fill("5173");
    await panel(page).getByRole("textbox", { name: "开发服务路径", exact: true }).fill("/preview/page");
    await panel(page).getByRole("button", { name: "连接", exact: true }).click();
    await boundedPreview(page, "开发服务预览", ".dev-preview-frame");
    expect(connections).toEqual([{ hostId: "local", port: 5173, path: "/preview/page" }]);
    await expect(panel(page).getByRole("spinbutton", { name: "开发服务端口", exact: true })).toBeInViewport();
    await expect(panel(page).getByRole("textbox", { name: "开发服务路径", exact: true })).toBeInViewport();
    await expect(panel(page).getByRole("button", { name: "关闭开发服务预览", exact: true })).toBeInViewport();
    await panel(page).getByRole("button", { name: "开发服务手机预览", exact: true }).click();
    await boundedPreview(page, "开发服务预览", ".dev-preview-frame");
    await panel(page).getByRole("button", { name: "重新连接开发服务", exact: true }).click();
    await boundedPreview(page, "开发服务预览", ".dev-preview-frame");
    expect(released).toContain("layout-ticket-1");
    await panel(page).getByRole("button", { name: "关闭开发服务预览", exact: true }).click();
    await expect(panel(page).locator('iframe[title="开发服务预览"]')).toHaveCount(0);
    expect(released).toContain("layout-ticket-2");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
