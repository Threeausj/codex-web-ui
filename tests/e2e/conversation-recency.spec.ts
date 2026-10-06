import { test, expect, login, MockCodex } from "./fixtures";

const recent = (page: any) => page.locator('[data-section="recent"]');
const row = (page: any, label: string) =>
  recent(page).locator(".nav-thread").filter({ hasText: label });
const order = (page: any) => recent(page).locator(".thread-title");

function addOlderChat(mock: MockCodex, empty = false, canonical = true) {
  const thread: any = {
    ...mock.threads[0],
    id: "thread-older",
    name: empty ? "空的旧对话" : "较早的对话",
    preview: "较早的对话",
    createdAt: 1790000000,
    updatedAt: 1790000100,
    ...(canonical ? { recencyAt: empty ? 1790000000 : 1790000100 } : {}),
  };
  mock.threads[0] = {
    ...mock.threads[0],
    createdAt: 1791000000,
    updatedAt: 1791000100,
    ...(canonical ? { recencyAt: 1791000100 } : {}),
  } as any;
  mock.turns.get("thread-existing")![0].startedAt = 1791000100;
  mock.turns.get("thread-existing")![0].completedAt = 1791000100;
  mock.threads.push(thread);
  mock.turns.set(
    thread.id,
    empty
      ? []
      : [{
          ...structuredClone(mock.turns.get("thread-existing")![0]),
          id: "turn-older",
          startedAt: 1790000100,
          completedAt: 1790000100,
        }],
  );
  return thread;
}

/** Simulate the real unloaded-resume metadata write, including the metadata
 * returned by every later list/read rather than just the resume response. */
function metadataWritesOnResume(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    const thread = mock.threads.find((item) => item.id === request.params?.threadId) as any;
    if (request.method === "thread/resume" && thread) {
      thread.updatedAt = Math.floor(Date.now() / 1000);
      mock.emit("thread/started", { thread: { ...thread } });
    }
    if (request.method === "turn/start" && thread) {
      thread.updatedAt = Math.floor(Date.now() / 1000);
      if (typeof thread.recencyAt === "number") thread.recencyAt = thread.updatedAt;
    }
    receive(socket, request);
  };
}

test("opening empty and older chats preserves content ordering and time across refresh and reload; a new turn promotes them", async ({ page, mock }) => {
  const older = addOlderChat(mock);
  const empty: any = { ...older, id: "thread-empty", name: "空的旧对话", preview: "", recencyAt: 1789000000, createdAt: 1789000000 };
  mock.threads.push(empty);
  mock.turns.set(empty.id, []);
  metadataWritesOnResume(mock);
  await login(page);
  const expected = ["已有测试历史", "较早的对话", "空的旧对话"];
  await expect(order(page)).toHaveText(expected);
  const olderTime = await row(page, "较早的对话").locator("small").textContent();
  const emptyTime = await row(page, "空的旧对话").locator("small").textContent();
  for (const label of ["较早的对话", "空的旧对话"]) {
    await row(page, label).locator(".thread-row").click();
    await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "刷新对话", exact: true }).click();
    await expect(order(page)).toHaveText(expected);
    await expect(row(page, "较早的对话").locator("small")).toHaveText(olderTime!);
    await expect(row(page, "空的旧对话").locator("small")).toHaveText(emptyTime!);
  }
  await page.reload();
  await expect(order(page)).toHaveText(expected);
  await expect(row(page, "空的旧对话").locator("small")).toHaveText(emptyTime!);
  await page.getByRole("textbox", { name: "消息输入框", exact: true }).fill("现在更新这个对话");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(order(page).first()).toHaveText("空的旧对话");
  await expect(row(page, "空的旧对话").locator("small")).toHaveText("刚刚");
  await expect.poll(() => mock.request("thread/list")?.params.sortKey).toBe("recency_at");
});

test("remote resume does not change merged host recency, including a subsequent local selection and reload", async ({ page, mock }) => {
  const remote = new MockCodex();
  addOlderChat(remote, true);
  remote.threads = [remote.threads[1]];
  mock.threads[0] = { ...mock.threads[0], createdAt: 1791000000, recencyAt: 1791000100 } as any;
  mock.hosts.push({ id: "ssh-recency", kind: "ssh", name: "测试远端", hostname: "remote.invalid" });
  mock.hostMocks.set("ssh-recency", remote);
  metadataWritesOnResume(remote);
  await login(page);
  await expect(order(page)).toHaveText(["已有测试历史", "空的旧对话"]);
  const time = await row(page, "空的旧对话").locator("small").textContent();
  await row(page, "空的旧对话").locator(".thread-row").click();
  await expect(page.locator(".header-host")).toHaveText("测试远端");
  await row(page, "已有测试历史").locator(".thread-row").click();
  await expect(page.locator(".header-host")).toHaveText("本机");
  await page.getByRole("button", { name: "刷新对话", exact: true }).click();
  await expect(order(page)).toHaveText(["已有测试历史", "空的旧对话"]);
  await expect(row(page, "空的旧对话").locator("small")).toHaveText(time!);
  await page.reload();
  await expect(order(page)).toHaveText(["已有测试历史", "空的旧对话"]);
  await expect(row(page, "空的旧对话").locator("small")).toHaveText(time!);
  expect(remote.request("thread/list")?.params.sortKey).toBe("recency_at");
});

test("legacy servers without recency metadata use latest turn time, cache metadata reads and preserve known time on failed reads", async ({ page, mock }) => {
  const older = addOlderChat(mock, false, false);
  (mock.threads[0] as any).recencyAt = null;
  metadataWritesOnResume(mock);
  const receive = (mock as any).receive.bind(mock);
  let failHistory = false;
  (mock as any).receive = (socket: any, request: any) => {
    if ((request.method === "thread/list" || request.method === "thread/search") && request.params?.sortKey === "recency_at") {
      mock.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, error: { code: -32602, message: "unknown sort variant recency_at" } }));
      return;
    }
    if (failHistory && request.method === "thread/turns/list" && request.params?.itemsView === "notLoaded") {
      mock.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "temporarily unavailable" } }));
      return;
    }
    receive(socket, request);
  };
  await login(page);
  await expect(order(page)).toHaveText(["已有测试历史", "较早的对话"]);
  const time = await row(page, "较早的对话").locator("small").textContent();
  const count = () => mock.requests.filter((request) => request.method === "thread/turns/list" && request.params?.itemsView === "notLoaded").length;
  expect(count()).toBe(2);
  await page.getByRole("button", { name: "刷新对话", exact: true }).click();
  await expect.poll(() => mock.request("thread/list")?.params.sortKey).toBe("updated_at");
  expect(count()).toBe(2);
  await row(page, "较早的对话").locator(".thread-row").click();
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toBeEnabled();
  failHistory = true;
  older.updatedAt += 1;
  await page.getByRole("button", { name: "刷新对话", exact: true }).click();
  await expect.poll(count).toBe(3);
  await expect(order(page)).toHaveText(["已有测试历史", "较早的对话"]);
  await expect(row(page, "较早的对话").locator("small")).toHaveText(time!);
  failHistory = false;
  await page.reload();
  await expect(order(page)).toHaveText(["已有测试历史", "较早的对话"]);
  await expect(row(page, "较早的对话").locator("small")).toHaveText(time!);
  await page.getByRole("textbox", { name: "消息输入框", exact: true }).fill("旧版服务也正确更新内容时间");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(order(page).first()).toHaveText(older.name);
});
