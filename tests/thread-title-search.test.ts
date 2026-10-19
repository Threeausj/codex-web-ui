import test from "node:test";
import assert from "node:assert/strict";
import { matchesThreadTitle, searchableThreadTitle, ThreadTitlePageCache, threadTitleQueryKey } from "../src/lib/thread-title-search";

test('all-project, unassigned and assigned project filters never reuse each other cached pages', async () => {
  const cache = new ThreadTitlePageCache<string[]>();
  const scope = [1, 0, true, '', null];
  let reads = 0;
  const read = (filters: { projectId?: string | null }, data: string[]) => cache.query(threadTitleQueryKey('nas', scope, filters), async () => { ++reads; return data; });
  assert.deepEqual(await read({}, ['assigned', 'unassigned']), ['assigned', 'unassigned']);
  assert.deepEqual(await read({ projectId: null }, ['unassigned']), ['unassigned']);
  assert.deepEqual(await read({ projectId: 'native-b' }, ['assigned']), ['assigned']);
  assert.deepEqual(await read({}, ['must not refill cache']), ['assigned', 'unassigned']);
  assert.equal(reads, 3);
});

test("title matching excludes preview, directory, session ID and history when a canonical title exists", () => {
  const thread = { name: "配置 SSH 服务器", title: "其他标题", preview: "正文含有 secret", cwd: "/secret", id: "secret-id", turns: [{ text: "secret" }] };
  assert.equal(matchesThreadTitle(thread, " ssh "), true);
  assert.equal(matchesThreadTitle(thread, "secret"), false);
  assert.equal(matchesThreadTitle(thread, "其他标题"), false);
  assert.equal(matchesThreadTitle({ name: "ＧＰＵ load" }, "gpu LOAD"), true);
});
test("unnamed legacy sessions use a bounded first-line title instead of searching their prompt", () => {
  assert.equal(searchableThreadTitle({ name: " \t", preview: "标题\n正文" }), "标题");
  assert.equal(matchesThreadTitle({ preview: "标题\n正文关键词" }, "关键词"), false);
  assert.equal(matchesThreadTitle({ preview: "a".repeat(70) + "关键词" }, "关键词"), false);
  assert.equal(searchableThreadTitle({ title: "旧协议标题", preview: "正文" }), "旧协议标题");
  assert.equal(matchesThreadTitle({}, "未命名"), true);
});
test("title pages share concurrent requests, expire, bound storage and isolate hosts", async () => {
  let now = 0, calls = 0;
  const cache = new ThreadTitlePageCache<number>(10, 2, () => now);
  const load = async () => ++calls;
  const a = '"a":query', b = '"b":query', c = '"c":query';
  assert.deepEqual(await Promise.all([cache.query(a, load), cache.query(a, load)]), [1, 1]);
  assert.equal(await cache.query(a, load), 1);
  await cache.query(b, load);
  cache.clearHost("a");
  assert.equal(await cache.query(b, load), 2);
  assert.equal(await cache.query(a, load), 3);
  await cache.query(c, load);
  assert.equal(await cache.query(b, load), 5);
  now = 11;
  assert.equal(await cache.query(b, load), 6);
});
test("invalidating a pending title request cannot refill the new cache revision", async () => {
  const cache = new ThreadTitlePageCache<string>();
  const key = '"host":query';
  let complete!: (value: string) => void;
  const older = cache.query(key, () => new Promise(resolve => { complete = resolve; }));
  cache.clearHost("host");
  assert.equal(await cache.query(key, async () => "renamed"), "renamed");
  complete("old title");
  assert.equal(await older, "old title");
  assert.equal(await cache.query(key, async () => "unexpected"), "renamed");
  cache.clear();
  await assert.rejects(cache.query(key, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await cache.query(key, async () => "recovered"), "recovered");
});
