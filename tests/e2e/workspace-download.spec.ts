import { test, expect, login, slash, editSource } from "./fixtures";

// Browser-managed downloads bypass Playwright's HTTP route mocks. These checks
// verify the real download handoff; backend transfer tests cover exact bytes.

test("workspace list and editor hand the saved file path to the browser download manager", async ({
  page,
  mock,
}) => {
  await login(page);
  await slash(page, "terminal");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  let pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 README.md", exact: true })
    .click();
  let downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe("README.md");
  let url = new URL(downloaded.url());
  expect(url.pathname).toBe("/api/hosts/local/download");
  expect(url.searchParams.get("path")).toBe("/workspace/demo/README.md");
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await editSource(page, "README.md 文件内容", "还未保存的新内容");
  pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件", exact: true }).click();
  downloaded = await pending;
  url = new URL(downloaded.url());
  expect(url.pathname).toBe("/api/hosts/local/download");
  expect(url.searchParams.get("path")).toBe("/workspace/demo/README.md");
  expect(mock.request("fs/writeFile")).toBeUndefined();
  await page.getByLabel("选择权限", { exact: true }).selectOption("read-only");
  pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件", exact: true }).click();
  downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe("README.md");
  expect(new URL(downloaded.url()).searchParams.get("path")).toBe("/workspace/demo/README.md");
  // The actual transfer bypasses fs/readFile and never sends the unsaved draft.
  expect(mock.requests.filter(request => request.method === "fs/readFile")).toHaveLength(1);
});

test("binary files remain downloadable through the host endpoint without a second preview read on a phone", async ({
  page,
  mock,
}) => {
  const bytes = Buffer.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00, 0xc3, 0x28, 0x0d, 0x0a,
  ]);
  const receive = mock.receive.bind(mock);
  let fileReads = 0;
  mock.receive = (socket, request) => {
    if (request.method === "fs/readDirectory")
      return socket.send(
        JSON.stringify({
          id: request.id,
          result: {
            entries: [{ fileName: "数据 报告.pdf", isDirectory: false }],
          },
        }),
      );
    if (request.method === "fs/readFile") {
      ++fileReads;
      return socket.send(
        JSON.stringify({
          id: request.id,
          result: { dataBase64: bytes.toString("base64") },
        }),
      );
    }
    return receive(socket, request);
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await slash(page, "terminal");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page
    .locator(".file-tree-row")
    .filter({ hasText: "数据 报告.pdf" })
    .click();
  await expect(page.getByRole("alert")).toContainText("PDF 预览失败，可下载文件查看");
  await expect(page.locator(".code-editor")).toHaveCount(0);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件", exact: true }).click();
  const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe("数据 报告.pdf");
  const url = new URL(downloaded.url());
  expect(url.pathname).toBe("/api/hosts/local/download");
  expect(url.searchParams.get("path")).toBe("/workspace/demo/数据 报告.pdf");
  expect(fileReads).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("a late file response from an old project cannot replace the new workspace editor", async ({
  page,
  mock,
}) => {
  const receive = mock.receive.bind(mock);
  let release: (() => void) | undefined;
  mock.receive = (socket, request) => {
    if (
      request.method === "fs/readFile" &&
      request.params.path.endsWith("README.md")
    ) {
      release = () =>
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              dataBase64: Buffer.from("旧项目内容").toString("base64"),
            },
          }),
        );
      return;
    }
    return receive(socket, request);
  };
  mock.projects.push({
    id: "other",
    name: "Other Project",
    path: "/workspace/other",
    hostId: "local",
    source: "web",
  });
  await login(page);
  await slash(page, "terminal");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.locator(".file-tree-row").filter({ hasText: "README.md" }).click();
  await expect.poll(() => !!release).toBe(true);
  await page
    .getByRole("button", { name: "Other Project 项目操作", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "在工作区文件中显示", exact: true })
    .click();
  await expect(page.getByLabel("目录路径", { exact: true })).toHaveValue(
    "/workspace/other",
  );
  release!();
  await expect(page.locator(".code-editor")).toHaveCount(0);
  await page
    .locator(".file-tree-row")
    .filter({ hasText: "index.html" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "index.html 文件内容" }),
  ).toHaveText("<h1>Demo preview</h1>");
});

test("a late path lookup cannot overwrite a more recently revealed file in the same project", async ({
  page,
  mock,
}) => {
  mock.turns.get("thread-existing")![0].items.at(-1).text =
    "[first](/workspace/demo/first.txt) [second](/workspace/demo/second.txt)";
  let release: (() => void) | undefined;
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => {
    if (
      request.method === "fs/getMetadata" &&
      request.params.path.endsWith("first.txt")
    ) {
      release = () =>
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { isFile: true, isDirectory: false },
          }),
        );
      return;
    }
    if (
      request.method === "fs/getMetadata" &&
      request.params.path.endsWith("second.txt")
    )
      return socket.send(
        JSON.stringify({
          id: request.id,
          result: { isFile: true, isDirectory: false },
        }),
      );
    if (request.method === "fs/readFile")
      return socket.send(
        JSON.stringify({
          id: request.id,
          result: {
            dataBase64: Buffer.from(request.params.path).toString("base64"),
          },
        }),
      );
    return receive(socket, request);
  };
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await page.getByRole("link", { name: "first", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole("link", { name: "second", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "second.txt 文件内容" }),
  ).toHaveText("/workspace/demo/second.txt");
  release!();
  await page.waitForTimeout(100);
  await expect(
    page.getByRole("textbox", { name: "second.txt 文件内容" }),
  ).toHaveText("/workspace/demo/second.txt");
});
