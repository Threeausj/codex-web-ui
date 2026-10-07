import { test, expect, login, slash } from "./fixtures";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+UqsAAAAASUVORK5CYII=";
function files(mock: any, values: Record<string, string>, images = new Set<string>()) {
  const receive = mock.receive.bind(mock);
  const reads: string[] = [];
  const writes: { path: string; text: string }[] = [];
  mock.receive = (socket: any, request: any) => {
    const path = request.params?.path;
    if (request.method === "fs/readFile" && path in values) {
      reads.push(path);
      socket.send(JSON.stringify({ id: request.id, result: { dataBase64: images.has(path) ? values[path] : Buffer.from(values[path]!).toString("base64") } }));
      return;
    }
    if (request.method === "fs/writeFile") {
      const text = Buffer.from(request.params.dataBase64, "base64").toString("utf8");
      writes.push({ path, text });
      values[path] = text;
      socket.send(JSON.stringify({ id: request.id, result: {} }));
      return;
    }
    return receive(socket, request);
  };
  return { reads, writes };
}
async function openFiles(page: any) {
  await login(page);
  await slash(page, "terminal");
  await page.getByRole("button", { name: "文件", exact: true }).click();
}

test("Markdown defaults to rendered content and source/preview preserve the draft until saving", async ({ page, mock }) => {
  const fixture = files(mock, { "/workspace/demo/README.md": "# Preview heading\n\n**rendered** text" });
  await openFiles(page);
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  const rendered = page.getByRole("region", { name: "Markdown 文件预览" });
  await expect(rendered.getByRole("heading", { name: "Preview heading" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "README.md 文件内容" })).toHaveCount(0);
  await page.locator(".file-view-switch").getByRole("button", { name: "源码", exact: true }).click();
  const source = page.getByRole("textbox", { name: "README.md 文件内容" });
  await source.fill("# Draft heading\n\n尚未保存");
  await page.locator(".file-view-switch").getByRole("button", { name: "预览", exact: true }).click();
  await expect(rendered.getByRole("heading", { name: "Draft heading" })).toBeVisible();
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  await page.locator(".file-view-switch").getByRole("button", { name: "源码", exact: true }).click();
  await expect(source).toHaveText("# Draft heading\n\n尚未保存", { useInnerText: true });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => fixture.writes).toEqual([{ path: "/workspace/demo/README.md", text: "# Draft heading\n\n尚未保存" }]);
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
});

test("Markdown relative images and links read from the same host instead of browser routes", async ({ page, mock }) => {
  const fixture = files(mock, {
    "/workspace/demo/README.md": "# Diagram\n\n![Local image](assets/图%20一.png)\n\n[Next page](docs/next.md)",
    "/workspace/demo/assets/图 一.png": png,
    "/workspace/demo/docs/next.md": "# Next page\n\n内容",
  }, new Set(["/workspace/demo/assets/图 一.png"]));
  await openFiles(page);
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  const image = page.getByRole("img", { name: "Local image", exact: true });
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  expect(fixture.reads).toContain("/workspace/demo/assets/图 一.png");
  await page.getByRole("link", { name: "Next page", exact: true }).click();
  await expect(page.getByRole("region", { name: "Markdown 文件预览" }).getByRole("heading", { name: "Next page" })).toBeVisible();
  expect(fixture.reads).toContain("/workspace/demo/docs/next.md");
});

test("a missing relative image shows a local notice without interrupting the document or global connection", async ({ page, mock }) => {
  const fixture = files(mock, {
    "/workspace/demo/README.md": "# Document remains visible\n\n正文继续显示。\n\n![Missing](assets/missing.png)\n\n![Available](assets/available.png)\n\n![Repeated](assets/available.png)",
    "/workspace/demo/assets/available.png": png,
  }, new Set(["/workspace/demo/assets/available.png"]));
  const receive = mock.receive.bind(mock);
  let missingReads = 0;
  mock.receive = (socket: any, request: any) => {
    if (request.method === "fs/readFile" && request.params.path === "/workspace/demo/assets/missing.png") {
      ++missingReads;
      socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "Missing preview image" } }));
      return;
    }
    return receive(socket, request);
  };
  await openFiles(page);
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  const rendered = page.getByRole("region", { name: "Markdown 文件预览" });
  await expect(rendered.getByRole("heading", { name: "Document remains visible" })).toBeVisible();
  await expect(rendered).toContainText("正文继续显示。");
  await expect(rendered.getByRole("status")).toContainText("部分图片读取失败");
  await expect(rendered.getByRole("img", { name: "Missing", exact: true })).toHaveAttribute("title", "Missing preview image");
  await expect(rendered.getByRole("img", { name: "Available", exact: true })).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(rendered.getByRole("img", { name: "Repeated", exact: true })).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.locator(".global-error, .panel-error")).toHaveCount(0);
  expect(missingReads).toBe(1);
  expect(fixture.reads.filter(path => path.endsWith("available.png"))).toHaveLength(1);
});

test("a failed Markdown save preserves the draft and can be retried from preview", async ({ page, mock }) => {
  const fixture = files(mock, { "/workspace/demo/README.md": "# Original" });
  const receive = mock.receive.bind(mock);
  let fail = true;
  mock.receive = (socket: any, request: any) => {
    if (request.method === "fs/writeFile" && fail) {
      fail = false;
      socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "写入失败" } }));
      return;
    }
    return receive(socket, request);
  };
  await openFiles(page);
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  await page.locator(".file-view-switch").getByRole("button", { name: "源码", exact: true }).click();
  await page.getByRole("textbox", { name: "README.md 文件内容" }).fill("# Retained draft");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".panel-error")).toContainText("写入失败");
  await page.locator(".file-view-switch").getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.getByRole("region", { name: "Markdown 文件预览" }).getByRole("heading", { name: "Retained draft" })).toBeVisible();
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => fixture.writes).toEqual([{ path: "/workspace/demo/README.md", text: "# Retained draft" }]);
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
});

test("editing during a pending save keeps later changes marked unsaved", async ({ page, mock }) => {
  files(mock, { "/workspace/demo/README.md": "# Original" });
  const receive = mock.receive.bind(mock);
  let release: (() => void) | undefined;
  mock.receive = (socket: any, request: any) => {
    if (request.method === "fs/writeFile") {
      release = () => receive(socket, request);
      return;
    }
    return receive(socket, request);
  };
  await openFiles(page);
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  await page.locator(".file-view-switch").getByRole("button", { name: "源码", exact: true }).click();
  const source = page.getByRole("textbox", { name: "README.md 文件内容" });
  await source.fill("# First draft");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await source.fill("# Later draft");
  release!();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await page.locator(".file-view-switch").getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.getByRole("region", { name: "Markdown 文件预览" }).getByRole("heading", { name: "Later draft" })).toBeVisible();
});

test("Markdown strips active HTML and does not fetch external or out-of-project images", async ({ page, mock }) => {
  let externalRequests = 0;
  await page.route("https://example.invalid/**", route => { ++externalRequests; return route.abort(); });
  const fixture = files(mock, { "/workspace/demo/README.md": `# Safe content
<script>document.body.dataset.filePreviewEscape='yes'</script>
<iframe src="https://example.invalid/frame"></iframe>
<img src="https://example.invalid/image.png" onerror="document.body.dataset.filePreviewEscape='yes'">
![Private](../../secret.png)
[Unsafe](javascript:alert(1))
<style>body { display: none; }</style>` });
  await openFiles(page);
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  const rendered = page.getByRole("region", { name: "Markdown 文件预览" });
  await expect(rendered.getByRole("heading", { name: "Safe content" })).toBeVisible();
  await expect(rendered.locator("script,iframe,style,[onerror]")).toHaveCount(0);
  await expect(rendered.locator('img[src^="http"]')).toHaveCount(0);
  await expect(rendered.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.dataset.filePreviewEscape)).toBeUndefined();
  expect(externalRequests).toBe(0);
  expect(fixture.reads).toEqual(["/workspace/demo/README.md"]);
});

test("the preview address supports Markdown and images while retaining opaque HTML preview", async ({ page, mock }) => {
  files(mock, { "/workspace/demo/notes.md": "# Address preview", "/workspace/demo/photo.png": png }, new Set(["/workspace/demo/photo.png"]));
  await openFiles(page);
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("textbox", { name: "预览地址" }).fill("notes.md");
  await page.getByRole("button", { name: "打开预览", exact: true }).click();
  await expect(page.getByRole("region", { name: "Markdown 文件预览" }).getByRole("heading", { name: "Address preview" })).toBeVisible();
  await page.getByRole("textbox", { name: "预览地址" }).fill("photo.png");
  await page.getByRole("button", { name: "打开预览", exact: true }).click();
  await expect(page.locator(".file-image img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.locator(".file-view-switch")).toHaveCount(0);
  await page.getByRole("textbox", { name: "预览地址" }).fill("index.html");
  await page.getByRole("button", { name: "打开预览", exact: true }).click();
  await expect(page.locator('iframe[title="项目预览"]')).toBeVisible();
  await expect(page.locator('iframe[title="项目预览"]')).not.toHaveAttribute("sandbox", /allow-same-origin/);
});

test("a late Markdown image response cannot enter another project's preview", async ({ page, mock }) => {
  const receive = mock.receive.bind(mock);
  let release: (() => void) | undefined;
  mock.receive = (socket: any, request: any) => {
    if (request.method === "fs/readFile" && request.params.path === "/workspace/demo/README.md") {
      socket.send(JSON.stringify({ id: request.id, result: { dataBase64: Buffer.from("# Old project\n![Old image](old.png)").toString("base64") } })); return;
    }
    if (request.method === "fs/readFile" && request.params.path === "/workspace/demo/old.png") {
      release = () => socket.send(JSON.stringify({ id: request.id, result: { dataBase64: png } })); return;
    }
    return receive(socket, request);
  };
  mock.projects.push({ id: "other", name: "Other Project", path: "/workspace/other", hostId: "local", source: "web" });
  await openFiles(page);
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole("button", { name: "Other Project 项目操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "在工作区文件中显示", exact: true }).click();
  await expect(page.getByLabel("目录路径", { exact: true })).toHaveValue("/workspace/other");
  release!();
  await expect(page.getByRole("img", { name: "Old image", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Markdown 文件预览" })).toHaveCount(0);
});

test("Markdown preview/source work on dark mobile screens under read-only permissions", async ({ page, mock }) => {
  files(mock, { "/workspace/demo/README.md": "# 手机预览\n\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n\n```js\nconsole.log('宽行')\n```" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  await page.getByLabel("选择权限", { exact: true }).selectOption("read-only");
  await slash(page, "terminal");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  const rendered = page.getByRole("region", { name: "Markdown 文件预览" });
  await expect(rendered.getByRole("heading", { name: "手机预览" })).toBeVisible();
  expect(await rendered.evaluate((element: HTMLElement) => getComputedStyle(element).backgroundColor)).not.toBe("rgb(250, 250, 249)");
  await page.locator(".file-view-switch").getByRole("button", { name: "源码", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "README.md 文件内容" })).toHaveAttribute("aria-readonly", "true");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
