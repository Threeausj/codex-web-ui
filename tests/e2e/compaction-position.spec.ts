import { test, expect, login } from "./fixtures";

test("same-turn compaction is displayed before replies generated after it and stays there after reload", async ({ page, mock }) => {
  const turn = mock.turns.get("thread-existing")![0];
  turn.items.splice(1, 0,
    { id: "before-compact", type: "agentMessage", phase: "final_answer", text: "压缩前的回复" },
    { id: "between-compact", type: "contextCompaction" });
  turn.items.at(-1).phase = "final_answer";
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const group = page.locator('.conversation-turn[data-turn-id="turn-history"]');
  const order = () => group.locator(":scope > .agent-message, :scope > .compaction-divider").evaluateAll((elements) => elements.map((element) =>
    element.classList.contains("compaction-divider") ? "compaction" : element.querySelector(".markdown")?.textContent?.trim()));
  await expect.poll(order).toEqual(["压缩前的回复", "compaction", "历史保持可读"]);
  await page.reload();
  await expect.poll(order).toEqual(["压缩前的回复", "compaction", "历史保持可读"]);
});

test('running and expanded processes keep compression between earlier and later commentary through completion and reload', async ({ page, mock }) => {
  const turn = mock.turns.get('thread-existing')![0]; turn.status = 'inProgress';
  turn.items = [turn.items[0],
    { id: 'before-progress', type: 'agentMessage', phase: 'commentary', text: '压缩前的进展' },
    { id: 'before-operation', type: 'commandExecution', command: 'printf before', status: 'completed', exitCode: 0 },
    { id: 'middle-compression', type: 'contextCompaction', status: 'completed' },
    { id: 'after-progress', type: 'agentMessage', phase: 'commentary', text: '压缩后继续处理' },
    { id: 'after-operation', type: 'commandExecution', command: 'printf after', status: 'completed', exitCode: 0 },
  ];
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  const group = page.locator('.conversation-turn[data-turn-id="turn-history"]');
  const order = () => group.locator('.turn-activity-content > .agent-message, .turn-activity-content > .compaction-divider').evaluateAll(elements => elements.map(element => element.classList.contains('compaction-divider') ? 'compaction' : element.textContent?.trim()));
  await expect.poll(order).toEqual(['压缩前的进展', 'compaction', '压缩后继续处理']);
  mock.emit('item/completed', { threadId: 'thread-existing', turnId: turn.id, item: { id: 'latest-progress', type: 'agentMessage', phase: 'commentary', text: '继续处理下一步' } });
  await expect.poll(order).toEqual(['压缩前的进展', 'compaction', '压缩后继续处理', '继续处理下一步']);
  turn.items.push({ id: 'latest-progress', type: 'agentMessage', phase: 'commentary', text: '继续处理下一步' }, { id: 'finished-answer', type: 'agentMessage', phase: 'final_answer', text: '处理完成' });
  turn.status = 'completed'; mock.emit('turn/completed', { threadId: 'thread-existing', turn });
  await expect(group.locator('.compaction-divider')).toHaveCount(1);
  await expect(group.getByText('处理完成', { exact: true })).toBeVisible();
  await group.locator('.turn-activity > summary').click();
  await expect.poll(order).toEqual(['压缩前的进展', 'compaction', '压缩后继续处理', '继续处理下一步', '处理完成']);
  await page.reload();
  await group.locator('.turn-activity > summary').click();
  await expect.poll(order).toEqual(['压缩前的进展', 'compaction', '压缩后继续处理', '继续处理下一步', '处理完成']);
  await expect(group.locator('.compaction-divider')).toHaveCount(1);
});

test("a delayed completed compaction turn is inserted before a later conversation turn", async ({ page, mock }) => {
  mock.turns.get("thread-existing")!.push(
    { id: "compaction-turn", status: "completed", items: [] },
    { id: "after-compact-turn", status: "completed", items: [
      { id: "later-user", type: "userMessage", content: [{ type: "text", text: "压缩后继续对话" }] },
      { id: "later-answer", type: "agentMessage", text: "压缩之后的回复" },
    ] });
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText("压缩之后的回复", { exact: true })).toBeVisible();
  mock.emit("item/completed", { threadId: "thread-existing", turnId: "compaction-turn", item: { id: "late-compact", type: "contextCompaction" } });
  await expect(page.locator(".compaction-divider")).toBeVisible();
  await expect.poll(() => page.locator(".conversation-turn").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-turn-id"))))
    .toEqual(["turn-history", "compaction-turn", "after-compact-turn"]);
});
