import { test, expect, login, slash, editSource } from "./fixtures";

const directory = "/workspace/demo";
const source = String.raw`{
  "image_path": "/datasets/4\u67089\u53f7\u65b0\u6570\u636e/\u4e2d\u6587.nii.gz",
  "emoji": "\uD83D\uDE80",
  "native": "已经是中文",
  "case_id": 9007199254740993123456789,
  "score": 1.2300e+42
}`;

function jsonFiles(mock: any, values: Record<string, string>) {
  const receive = mock.receive.bind(mock);
  const reads: string[] = [];
  const writes: { path: string; text: string }[] = [];
  mock.receive = (socket: any, request: any) => {
    const path = request.params?.path;
    const reply = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "fs/readDirectory" && path === directory)
      return reply({ entries: Object.keys(values).map(path => ({ fileName: path.split("/").pop(), isDirectory: false })) });
    if (request.method === "fs/getMetadata" && path in values)
      return reply({ isDirectory: false, isFile: true, isSymlink: false });
    if (request.method === "fs/readFile" && path in values) {
      reads.push(path);
      return reply({ dataBase64: Buffer.from(values[path]!).toString("base64") });
    }
    if (request.method === "fs/writeFile" && path in values) {
      const text = Buffer.from(request.params.dataBase64, "base64").toString("utf8");
      values[path] = text;
      writes.push({ path, text });
      return reply({});
    }
    return receive(socket, request);
  };
  return { reads, writes };
}

async function openJson(page: any, name = "datasets.json") {
  await login(page);
  await slash(page, "terminal");
  await page.locator(".workspace-tabs").getByRole("button", { name: "文件", exact: true }).click();
  await page.locator(".file-tree-row").filter({ hasText: name }).click();
}

const viewSwitch = (page: any) => page.locator('.file-view-switch[aria-label="JSON 显示方式"]');

test("JSON opens with readable Chinese and emoji while source retains exact escapes and number precision", async ({ page, mock }) => {
  const fixture = jsonFiles(mock, { [`${directory}/datasets.json`]: source });
  await openJson(page);
  const editor = page.getByRole("textbox", { name: "datasets.json 文件内容", exact: true });
  await expect(editor).toContainText("/datasets/4月9号新数据/中文.nii.gz");
  await expect(editor).toContainText("🚀");
  await expect(editor).toContainText("已经是中文");
  await expect(editor).toContainText("9007199254740993123456789");
  await expect(editor).toContainText("1.2300e+42");
  await expect(editor).toHaveAttribute("aria-readonly", "true");
  await expect(page.locator(".file-editor-footer")).toContainText("JSON 只读预览");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await viewSwitch(page).getByRole("button", { name: "源码", exact: true }).click();
  await expect(editor).toHaveText(source, { useInnerText: true });
  await expect(editor).toHaveAttribute("aria-readonly", "false");
  expect(fixture.writes).toEqual([]);
});

test("JSON Unicode preview and source switching fit a dark read-only phone", async ({ page, mock }) => {
  const fixture = jsonFiles(mock, { [`${directory}/datasets.json`]: source });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  await page.getByLabel("选择权限", { exact: true }).selectOption("read-only");
  await slash(page, "terminal");
  await page.locator(".workspace-tabs").getByRole("button", { name: "文件", exact: true }).click();
  await page.locator(".file-tree-row").filter({ hasText: "datasets.json" }).click();
  const editor = page.getByRole("textbox", { name: "datasets.json 文件内容", exact: true });
  await expect(editor).toContainText("4月9号新数据/中文.nii.gz");
  await expect(editor).toContainText("🚀");
  await expect(viewSwitch(page)).toBeVisible();
  await viewSwitch(page).getByRole("button", { name: "源码", exact: true }).click();
  await expect(editor).toHaveText(source, { useInnerText: true });
  await expect(editor).toHaveAttribute("aria-readonly", "true");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fixture.writes).toEqual([]);
});

test("JSON preview preserves literal backslash escapes and never turns decoded strings into active HTML", async ({ page, mock }) => {
  const raw = String.raw`{"literal":"\\u4e2d\\u6587","chinese":"\u4e2d\u6587","html":"<img src=x onerror='document.body.dataset.jsonPreviewEscape=1'>"}`;
  jsonFiles(mock, { [`${directory}/datasets.json`]: raw });
  await openJson(page);
  const editor = page.getByRole("textbox", { name: "datasets.json 文件内容", exact: true });
  await expect(editor).toContainText(String.raw`"literal":"\\u4e2d\\u6587"`);
  await expect(editor).toContainText('"chinese":"中文"');
  await expect(editor).toContainText("<img src=x");
  await expect(editor.locator("img,script,[onerror]")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.dataset.jsonPreviewEscape)).toBeUndefined();
  await viewSwitch(page).getByRole("button", { name: "源码", exact: true }).click();
  await expect(editor).toHaveText(raw, { useInnerText: true });
});

test("JSON draft preview and tab switches do not rewrite or save original source bytes", async ({ page, mock }) => {
  const path = `${directory}/datasets.json`;
  const fixture = jsonFiles(mock, { [path]: source, [`${directory}/other.json`]: '{"name":"second file"}' });
  await openJson(page);
  await viewSwitch(page).getByRole("button", { name: "源码", exact: true }).click();
  const draft = source.replace(String.raw`\u4e2d\u6587`, String.raw`\u6d4b\u8bd5`).replace("9007199254740993123456789", "9007199254740993123456790");
  await editSource(page, "datasets.json 文件内容", draft);
  await viewSwitch(page).getByRole("button", { name: "预览", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "datasets.json 文件内容", exact: true });
  await expect(editor).toContainText("新数据/测试.nii.gz");
  await expect(page.locator(".file-editor-footer")).toContainText("未保存");
  await editor.press("ControlOrMeta+s");
  expect(fixture.writes).toEqual([]);
  await page.getByRole("button", { name: "返回文件列表", exact: true }).click();
  await page.locator(".file-tree-row").filter({ hasText: "other.json" }).click();
  await expect(page.getByRole("textbox", { name: "other.json 文件内容", exact: true })).toHaveAttribute("aria-readonly", "true");
  await page.getByRole("navigation", { name: "已打开文件" }).getByRole("button", { name: "datasets.json", exact: true }).click();
  await expect(editor).toContainText("新数据/测试.nii.gz");
  await expect(editor).toHaveAttribute("aria-readonly", "true");
  await viewSwitch(page).getByRole("button", { name: "源码", exact: true }).click();
  await expect(editor).toHaveText(draft, { useInnerText: true });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => fixture.writes).toEqual([{ path, text: draft }]);
  await expect(page.locator(".file-editor-footer")).toContainText("已保存");
});

test("JSON line links keep readable preview and quoted selections use the displayed Chinese text", async ({ page, mock }) => {
  jsonFiles(mock, { [`${directory}/datasets.json`]: source });
  mock.turns.get("thread-existing")![0].items[1].text = `[查看影像路径](${directory}/datasets.json:2)`;
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await page.getByRole("link", { name: "查看影像路径", exact: true }).click();
  await expect(page.locator(".file-editor-footer")).toContainText("JSON 只读预览");
  await expect(page.locator(".file-editor-footer")).toContainText("定位第 2 行");
  const editor = page.getByRole("textbox", { name: "datasets.json 文件内容", exact: true });
  await expect(editor).toContainText("4月9号新数据/中文.nii.gz");
  await page.locator(".code-selection-toolbar").getByRole("button", { name: "添加到对话", exact: true }).click();
  await expect(page.locator(".composer-quote")).toContainText("datasets.json");
  // The selected line is shown as context without sending or saving a file.
  expect(mock.requests.some(request => request.method === "turn/start" || request.method === "fs/writeFile")).toBe(false);
  await page.getByRole("textbox", { name: "消息输入框", exact: true }).fill("解释路径");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("turn/start")?.params.input).toBeTruthy();
  expect(JSON.stringify(mock.request("turn/start")!.params.input)).toContain("4月9号新数据/中文.nii.gz");
});

test("JSONL and NDJSON support Unicode preview while escaped text in other file types stays unchanged", async ({ page, mock }) => {
  const raw = String.raw`{"name":"\u4e2d\u6587","id":9007199254740993123456789}`;
  jsonFiles(mock, { [`${directory}/events.jsonl`]: `${raw}\n${raw}`, [`${directory}/events.ndjson`]: raw, [`${directory}/notes.txt`]: raw });
  await openJson(page, "events.jsonl");
  await expect(page.getByRole("textbox", { name: "events.jsonl 文件内容", exact: true })).toContainText('"name":"中文"');
  await expect(page.locator(".file-editor-footer")).toContainText("2 行");
  await page.getByRole("button", { name: "返回文件列表", exact: true }).click();
  await page.locator(".file-tree-row").filter({ hasText: "events.ndjson" }).click();
  await expect(page.getByRole("textbox", { name: "events.ndjson 文件内容", exact: true })).toContainText('"name":"中文"');
  await page.getByRole("button", { name: "返回文件列表", exact: true }).click();
  await page.locator(".file-tree-row").filter({ hasText: "notes.txt" }).click();
  await expect(viewSwitch(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "notes.txt 文件内容", exact: true })).toHaveText(raw, { useInnerText: true });
});

test("the workspace preview address opens JSON as readable text rather than an HTML iframe", async ({ page, mock }) => {
  const fixture = jsonFiles(mock, { [`${directory}/datasets.json`]: source });
  await login(page);
  await slash(page, "terminal");
  await page.locator(".workspace-tabs").getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("textbox", { name: "预览地址", exact: true }).fill(`${directory}/datasets.json`);
  await page.getByRole("button", { name: "打开预览", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "datasets.json 文件内容", exact: true })).toContainText("4月9号新数据/中文.nii.gz");
  await expect(viewSwitch(page)).toBeVisible();
  await expect(page.locator(".file-editor-footer")).toContainText("JSON 只读预览");
  await expect(page.locator('iframe[title="项目预览"]')).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
});

test("downloading a readable JSON preview still hands the saved source path to the browser", async ({ page, mock }) => {
  const path = `${directory}/datasets.json`;
  const fixture = jsonFiles(mock, { [path]: source });
  await openJson(page);
  await expect(page.getByRole("textbox", { name: "datasets.json 文件内容", exact: true })).toContainText("中文.nii.gz");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件", exact: true }).click();
  const download = await pending;
  const url = new URL(download.url());
  expect(url.pathname).toBe("/api/hosts/local/download");
  expect(url.searchParams.get("path")).toBe(path);
  expect(download.suggestedFilename()).toBe("datasets.json");
  expect(fixture.reads).toEqual([path]);
  expect(fixture.writes).toEqual([]);
});
