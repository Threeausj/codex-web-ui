import { test, expect, login, MockCodex } from "./fixtures";

const recent = (page: any) => page.locator('[data-section="recent"]');
function addRemote(mock: MockCodex) {
  const remote = new MockCodex();
  remote.threads[0] = { ...remote.threads[0]!, name: "NAS 标题", preview: "NAS 正文关键词", recencyAt: 1791200000 };
  mock.hosts.push({ id: "nas-title", name: "NAS", kind: "ssh", cwd: "/workspace/demo" });
  mock.hostMocks.set("nas-title", remote);
  return remote;
}

for (const width of [1440, 390]) {
  test(`${width}px recent device filtering preserves the active chat and project list, and survives reload`, async ({ page, mock }) => {
    const remote = addRemote(mock);
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    if (width < 760) await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
    await recent(page).locator('[data-host-id="local"] .thread-row').click();
    await expect(page.locator(".agent-message")).toContainText("历史保持可读");
    if (width < 760) await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
    const filters = page.getByRole("group", { name: "按设备筛选最近对话" });
    await expect(recent(page).locator(".nav-thread")).toHaveCount(2);
    await filters.getByRole("button", { name: "NAS", exact: true }).click();
    await expect(recent(page).locator(".thread-title")).toHaveText(["NAS 标题"]);
    await expect(filters.getByRole("button", { name: "NAS", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".header-host")).toHaveText("本机");
    await expect(page.locator('[data-section="projects"] .thread-title')).toHaveText(["已有测试历史"]);
    expect(remote.request("thread/resume")).toBeUndefined();
    await page.reload();
    await expect(page.locator(".agent-message")).toContainText("历史保持可读");
    if (width < 760) await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
    await expect(recent(page).locator(".thread-title")).toHaveText(["NAS 标题"]);
    await filters.getByRole("button", { name: "全部", exact: true }).click();
    await expect(recent(page).locator(".nav-thread")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("sidebar title search ignores prompts, workspace paths and content, and reuses metadata pages", async ({ page, mock }) => {
  const remote = addRemote(mock);
  mock.threads[0] = { ...mock.threads[0]!, preview: "NAS 正文关键词", cwd: "/NAS" };
  await login(page);
  await expect(recent(page).locator(".nav-thread")).toHaveCount(2);
  const search = page.getByRole("textbox", { name: "搜索对话", exact: true });
  const titles = page.locator(".nav-search-results .thread-title");
  await search.fill("NAS");
  await expect(titles).toHaveText(["NAS 标题"]);
  await expect.poll(() => remote.requests.filter(r => r.method === "thread/list" && r.params.searchTerm === "nas").length).toBe(1);
  await search.fill("正文关键词");
  await expect(titles).toHaveCount(0);
  await expect.poll(() => mock.request("thread/list")?.params.searchTerm).toBe("正文关键词");
  await search.fill("历史保持可读");
  await expect(titles).toHaveCount(0);
  await expect.poll(() => mock.request("thread/list")?.params.searchTerm).toBe("历史保持可读");
  await search.fill("NAS");
  await expect(titles).toHaveText(["NAS 标题"]);
  await page.waitForTimeout(350);
  expect(remote.requests.filter(r => r.method === "thread/list" && r.params.searchTerm === "nas")).toHaveLength(1);
  expect(mock.requests.some(r => r.method === "thread/search")).toBe(false);
  expect(remote.requests.some(r => r.method === "thread/search")).toBe(false);
});

test("renaming a matching title removes it from results and invalidates cached queries", async ({ page, mock }) => {
  await login(page);
  const search = page.getByRole("textbox", { name: "搜索对话", exact: true });
  await search.fill("历史");
  const results = page.locator(".nav-search-results");
  await expect(results.locator(".thread-title")).toHaveText(["已有测试历史"]);
  await expect.poll(() => mock.request("thread/list")?.params.searchTerm).toBe("历史");
  await results.locator(".nav-row-menu").click();
  await results.getByRole("button", { name: "重命名对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名对话", exact: true });
  await dialog.getByRole("textbox", { name: "对话名称", exact: true }).fill("新的标题");
  await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(results.locator(".thread-title")).toHaveCount(0);
  await search.fill("新的标题");
  await expect(results.locator(".thread-title")).toHaveText(["新的标题"]);
  await search.fill("历史");
  await expect(results.locator(".thread-title")).toHaveCount(0);
  await expect.poll(() => mock.requests.filter(r => r.method === "thread/list" && r.params.searchTerm === "历史").length).toBe(2);
});

test("old servers paginate title metadata without full-text or per-result history reads", async ({ page, mock }) => {
  addRemote(mock);
  const calls: any[] = [];
  const base = { ...mock.threads[0]!, recencyAt: 1791200000 };
  await page.route("**/api/navigation/nas-title", async route => {
    const request = route.request().postDataJSON();
    if (request.method !== "thread/list") return route.fallback();
    calls.push(request);
    if (request.params.searchTerm) return route.fulfill({ status: 400, json: { error: "unknown field `searchTerm`" } });
    return route.fulfill({ json: request.params.cursor === "older"
      ? { data: [{ ...base, id: "older-title", name: "目标旧会话", recencyAt: undefined }], nextCursor: null }
      : { data: [{ ...base, id: "unrelated", name: "无关标题", preview: "目标正文" }], nextCursor: "older" } });
  });
  await login(page);
  await expect(recent(page).locator(".nav-thread")).toHaveCount(2);
  const search = page.getByRole("textbox", { name: "搜索对话", exact: true });
  await search.fill("目标");
  const results = page.locator(".nav-search-results");
  await expect(results.locator(".thread-title")).toHaveCount(0);
  await expect(results.getByRole("button", { name: "加载更多结果", exact: true })).toBeVisible();
  await results.getByRole("button", { name: "加载更多结果", exact: true }).click();
  await expect(results.locator(".thread-title")).toHaveText(["目标旧会话"]);
  expect(calls.filter(r => r.params.searchTerm)).toHaveLength(1);
  expect(calls.find(r => r.params.cursor === "older")?.params.searchTerm).toBeUndefined();
  expect(mock.hostMocks.get("nas-title")!.requests.some(r => r.method === "thread/search")).toBe(false);
  expect(mock.hostMocks.get("nas-title")!.requests.some(r => r.method === "thread/turns/list")).toBe(false);
});

test("loading older filtered recent conversations requests only the chosen device", async ({ page, mock }) => {
  const remote = addRemote(mock);
  const calls: any[] = [];
  const first = { ...remote.threads[0]!, recencyAt: 1791200000 };
  await page.route("**/api/navigation/nas-title", async route => {
    const request = route.request().postDataJSON();
    if (request.method !== "thread/list") return route.fallback();
    calls.push(request);
    return route.fulfill({ json: request.params.cursor === "next"
      ? { data: [{ ...first, id: "nas-older", name: "NAS 旧会话", recencyAt: 1791100000 }], nextCursor: null }
      : { data: [first], nextCursor: "next" } });
  });
  await login(page);
  await expect(recent(page).locator(".nav-thread")).toHaveCount(2);
  await page.getByRole("group", { name: "按设备筛选最近对话" }).getByRole("button", { name: "NAS", exact: true }).click();
  const localRequests = mock.requests.filter(r => r.method === "thread/list").length;
  await recent(page).getByRole("button", { name: "加载更早的对话", exact: true }).click();
  await expect(recent(page).locator(".thread-title")).toHaveText(["NAS 标题", "NAS 旧会话"]);
  expect(calls.some(r => r.params.cursor === "next")).toBe(true);
  expect(mock.requests.filter(r => r.method === "thread/list").length).toBe(localRequests);
  await expect(page.locator(".header-host")).toHaveText("本机");
});
