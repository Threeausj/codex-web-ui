import { test, expect, login } from "./fixtures";
import type { Page } from "@playwright/test";

async function pasteImage(page: Page, name = "first-paste.png", filesEmpty = true, text = "") {
  return page.getByRole("textbox", { name: "消息输入框" }).evaluate((element, args) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71])], args.name, { type: "image/png", lastModified: 1 }));
    if (args.text) clipboard.setData("text/plain", args.text);
    if (args.filesEmpty) Object.defineProperty(clipboard, "files", { value: [] });
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { name, filesEmpty, text });
}

async function captureUploads(page: Page) {
  const bodies: Buffer[] = [];
  await page.route("**/api/uploads", async route => {
    const body = route.request().postDataBuffer()!;
    bodies.push(body);
    const names = [...body.toString().matchAll(/filename="([^"]+)"/g)].map(match => match[1]);
    await route.fulfill({ status: 201, json: { files: names.map((name, index) => ({ name, path: `/test/uploads/${index}-${name}`, mime: "image/png", size: 4 })) } });
  });
  return bodies;
}

test("the first image paste reads clipboard items immediately and duplicated FileList entries upload only once", async ({ page }) => {
  const bodies: Buffer[] = [];
  await page.route("**/api/uploads", async (route) => {
    bodies.push(route.request().postDataBuffer()!);
    await route.fulfill({ status: 201, json: { files: [{ name: "pasted.png", path: "/test/uploads/pasted.png", mime: "image/png", size: 4 }] } });
  });
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("保留粘贴前的说明");
  expect(await pasteImage(page)).toBe(true);
  await expect(page.locator(".attachment")).toHaveCount(1);
  await expect(input).toHaveValue("保留粘贴前的说明");
  expect(bodies[0].toString()).toContain('filename="first-paste.png"');
  expect(await pasteImage(page, "deduplicated.png", false)).toBe(true);
  await expect(page.locator(".attachment")).toHaveCount(2);
  expect(bodies[1].toString().match(/filename="deduplicated.png"/g)).toHaveLength(1);
});

test("normal text and mixed clipboard text keep the browser's default paste behavior", async ({ page, mock }) => {
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  const prevented = await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "普通粘贴内容");
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  expect(mock.uploads).toHaveLength(0);
  expect(await pasteImage(page, "mixed.png", true, "图片说明")).toBe(false);
  await expect.poll(() => mock.uploads.length).toBe(1);
});

test("one paste uploads a clipboard image once even when its FileList alias has different metadata", async ({ page }) => {
  const bodies = await captureUploads(page);
  await login(page);
  await page.getByRole("textbox", { name: "消息输入框" }).evaluate(element => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "clipboard.png", { type: "image/png", lastModified: 1 }));
    Object.defineProperty(clipboard, "files", { value: [
      new File([bytes], "image.png", { type: "image/png", lastModified: 2 }),
    ] });
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(page.locator(".attachment")).toHaveCount(1);
  expect(bodies).toHaveLength(1);
  expect(bodies[0].toString().match(/filename=/g)).toHaveLength(1);
});

test("different images with matching filenames and timestamps are both uploaded", async ({ page }) => {
  const bodies = await captureUploads(page);
  await login(page);
  await page.getByRole("textbox", { name: "消息输入框" }).evaluate(element => {
    const clipboard = new DataTransfer();
    for (const bytes of [[137, 80, 78, 71], [137, 80, 78, 72]])
      clipboard.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png", lastModified: 1 }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(page.locator(".attachment")).toHaveCount(2);
  expect(bodies).toHaveLength(1);
  expect(bodies[0].toString().match(/filename=/g)).toHaveLength(2);
});

test("switching conversations during clipboard comparison cancels the stale upload", async ({ page, mock }) => {
  await login(page);
  await page.getByRole("textbox", { name: "消息输入框" }).evaluate(element => {
    const clipboard = new DataTransfer();
    const first = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png", lastModified: 1 });
    const originalRead = first.arrayBuffer.bind(first);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    (window as any).releaseClipboardRead = release;
    Object.defineProperty(first, "arrayBuffer", { value: async () => { await waiting; return originalRead(); } });
    Object.defineProperty(clipboard, "files", { value: [first, new File([new Uint8Array([137, 80, 78, 71])], "alias.png", { type: "image/png", lastModified: 2 })] });
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(page.getByRole("button", { name: "上传文件或图片", exact: true })).toBeDisabled();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await page.evaluate(() => (window as any).releaseClipboardRead());
  await expect(page.getByRole("button", { name: "上传文件或图片", exact: true })).toBeEnabled();
  await expect(page.locator(".attachment")).toHaveCount(0);
  expect(mock.uploads).toHaveLength(0);
});

test("overlapping pastes cannot enable sending until every upload finishes", async ({ page }) => {
  const pending: Array<() => Promise<void>> = [];
  await page.route("**/api/uploads", async (route) => {
    const number = pending.length + 1;
    await new Promise<void>((resolve) => pending.push(async () => {
      await route.fulfill({ status: 201, json: { files: [{ name: `${number}.png`, path: `/test/uploads/${number}.png`, mime: "image/png", size: 4 }] } });
      resolve();
    }));
  });
  await login(page);
  await page.getByRole("textbox", { name: "消息输入框" }).fill("全部上传后再发送");
  await pasteImage(page, "one.png");
  await pasteImage(page, "two.png");
  await expect.poll(() => pending.length).toBe(2);
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  await expect(send).toBeDisabled();
  await pending[1]();
  await expect(page.locator(".attachment")).toHaveCount(1);
  await expect(send).toBeDisabled();
  await pending[0]();
  await expect(page.locator(".attachment")).toHaveCount(2);
  await expect(send).toBeEnabled();
});

test("context appears left of permissions, uses the latest report and offers compaction", async ({ page, mock }) => {
  await login(page);
  await expect(page.locator(".composer-submit .context-usage")).toHaveText("上下文 0%");
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const indicator = page.locator(".composer-submit .context-usage");
  await expect(indicator).toHaveText("上下文 —");
  mock.emit("thread/tokenUsage/updated", { threadId: "thread-existing", tokenUsage: {
    last: { totalTokens: 25000 }, total: { totalTokens: 2000000 }, modelContextWindow: 100000,
  } });
  await expect(indicator).toHaveText("上下文 25%");
  await expect(indicator).toHaveAttribute("title", /25,000 \/ 100,000 tokens/);
  const left = await indicator.boundingBox();
  const permission = await page.locator(".composer-submit .permission-select").boundingBox();
  expect(left!.x + left!.width).toBeLessThanOrEqual(permission!.x);
  await indicator.click();
  await expect.poll(() => mock.request("thread/compact/start")?.params.threadId).toBe("thread-existing");
  await expect(page.locator(".compaction-divider")).toBeVisible();
  mock.emit("thread/tokenUsage/updated", { threadId: "thread-existing", tokenUsage: {
    last: { totalTokens: 3000 }, total: { totalTokens: 2030000 }, modelContextWindow: 100000,
  } });
  await expect(indicator).toHaveText("上下文 3%");
  mock.emit("turn/started", { threadId: "thread-existing", turn: { id: "context-busy", status: "inProgress", items: [] } });
  await expect(indicator).toBeDisabled();
  expect(mock.requests.filter((rpc) => rpc.method === "thread/compact/start")).toHaveLength(1);
});

for (const width of [320, 390]) {
  test(`context, permissions and send controls fit the ${width}px composer`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 600 });
    await login(page);
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
    await page.locator('[data-section="recent"] .thread-row').first().click();
    mock.emit("thread/tokenUsage/updated", { threadId: "thread-existing", tokenUsage: {
      last: { totalTokens: 100000 }, modelContextWindow: 100000,
    } });
    await expect(page.locator(".context-usage")).toHaveText("上下文 100%");
    await expect(page.getByRole("combobox", { name: "选择权限" })).toBeVisible();
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
    expect(await page.locator(".composer-area").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
