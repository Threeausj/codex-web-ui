import { test, expect, login, send, type MockCodex } from "./fixtures";

function startProcess(mock: MockCodex, id: string) {
  const threadId = "thread-existing";
  const items = [
    { id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: `开始 ${id}`, text_elements: [] }] },
    { id: `${id}-reasoning`, type: "reasoning", summary: [`${id} 公开摘要`], content: ["非摘要内容不展示"] },
    { id: `${id}-progress`, type: "agentMessage", phase: "commentary", text: `${id} 进展说明` },
    { id: `${id}-tool`, type: "commandExecution", command: "pwd", status: "inProgress", aggregatedOutput: `${id} 工具输出` },
  ];
  const turn = { id, status: "inProgress", items, error: null as any, durationMs: null as number | null, startedAt: 1791200000, completedAt: null as number | null };
  mock.turns.get(threadId)!.push(turn);
  mock.emit("turn/started", { threadId, turn });
  for (const item of items) mock.emit("item/completed", { threadId, turnId: id, item });
  return turn;
}

test("desktop-style output collapses process history behind elapsed time and keeps final answers visible", async ({
  page,
  mock,
}) => {
  const turn = mock.turns.get("thread-existing")![0];
  turn.durationMs = 1534000;
  turn.items.splice(
    1,
    0,
    {
      id: "reasoning",
      type: "reasoning",
      summary: ["公开的思考摘要"],
      content: [],
    },
    {
      id: "progress",
      type: "agentMessage",
      phase: "commentary",
      text: "正在分析项目文件",
    },
    {
      id: "tool",
      type: "commandExecution",
      command: "pwd",
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "/workspace/demo",
    },
  );
  turn.items.at(-1).phase = "final_answer";
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const group = page.locator('.conversation-turn[data-turn-id="turn-history"]');
  await expect(group.getByText("历史保持可读", { exact: true })).toBeVisible();
  await expect(
    group.getByText("用时 25 分钟 34 秒", { exact: true }),
  ).toBeVisible();
  await expect(
    group.getByText("正在分析项目文件", { exact: true }),
  ).toBeHidden();
  await expect(group.locator(".reasoning-item")).toBeHidden();
  await expect(group.locator(".tool-item")).toBeHidden();
  await group.locator(".turn-activity > summary").click();
  await expect(
    group.getByText("正在分析项目文件", { exact: true }),
  ).toBeVisible();
  await group.getByText("思考过程", { exact: true }).click();
  await expect(
    group.getByText("公开的思考摘要", { exact: true }),
  ).toBeVisible();
  await group.locator(".tool-item > summary").click();
  await expect(group.locator(".command-code")).toContainText("pwd");
  await page.reload();
  await expect(group.getByText("历史保持可读", { exact: true })).toBeVisible();
  await expect(
    group.getByText("正在分析项目文件", { exact: true }),
  ).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(group.locator(".turn-activity > summary")).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("live process keeps commands and file changes collapsed by default while progress and approvals stay visible", async ({
  page,
  mock,
}) => {
  mock.holdFinalMessage = true;
  mock.requireApprovalNext = true;
  await login(page);
  await send(page, "运行时展示过程，结束后收起");
  const approval = page.getByRole("region", { name: "批准命令执行" });
  await expect(approval).toBeVisible();
  const threadId = mock.request("turn/start")!.params.threadId;
  const turnId = mock.turns.get(threadId)!.at(-1).id;
  mock.emit("item/completed", {
    threadId,
    turnId,
    item: {
      id: "live-commentary",
      type: "agentMessage",
      phase: "commentary",
      text: "一大段中间进展说明",
    },
  });
  mock.emit("item/completed", {
    threadId,
    turnId,
    item: {
      id: "live-reasoning",
      type: "reasoning",
      summary: ["过程摘要"],
      content: [],
    },
  });
  mock.emit("item/started", {
    threadId,
    turnId,
    item: { id: "live-tool", type: "commandExecution", command: "pwd", status: "inProgress", aggregatedOutput: "工作目录输出" },
  });
  mock.emit("item/started", {
    threadId,
    turnId,
    item: { id: "live-file-change", type: "fileChange", status: "inProgress", changes: [{ path: "/workspace/demo/README.md", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }] },
  });
  const group = page.locator(`.conversation-turn[data-turn-id="${turnId}"]`);
  await expect(
    group.getByText("一大段中间进展说明", { exact: true }),
  ).toBeVisible();
  await expect(group.getByText("过程摘要", { exact: true })).toBeVisible();
  const command = group.locator(".tool-item").filter({ has: page.locator(".tool-title", { hasText: "运行命令" }) });
  const changes = group.locator(".tool-item").filter({ has: page.locator(".tool-title", { hasText: "修改文件" }) });
  await expect(command.locator("summary")).toBeVisible();
  await expect(changes.locator(":scope > summary")).toBeVisible();
  await expect(command).not.toHaveAttribute("open", "");
  await expect(changes).not.toHaveAttribute("open", "");
  await expect(group.getByText("工作目录输出", { exact: true })).toBeHidden();
  await expect(changes.locator(".file-changes")).toBeHidden();
  await command.locator("summary").click();
  await changes.locator(":scope > summary").click();
  await expect(changes.locator(".diff-code")).toBeHidden();
  await changes.locator(".file-diff > summary").click();
  await expect(group.getByText("工作目录输出", { exact: true })).toBeVisible();
  await expect(changes.locator(".diff-code")).toContainText("+new");
  await expect(changes.locator(".diff-code")).toBeVisible();
  mock.emit("item/commandExecution/outputDelta", { threadId, turnId, itemId: "live-tool", delta: " · 新输出" });
  mock.emit("item/completed", { threadId, turnId, item: { id: "live-file-change", type: "fileChange", status: "completed", changes: [{ path: "/workspace/demo/README.md", kind: "update", diff: "@@ -1 +1 @@\n-old\n+updated" }] } });
  await expect(command.getByText("工作目录输出 · 新输出", { exact: true })).toBeVisible();
  await expect(changes.locator(".diff-code")).toContainText("+updated");
  await expect(changes.locator(".diff-code")).toBeVisible();
  await command.locator("summary").click();
  await changes.locator(":scope > summary").click();
  await expect(group.locator(".turn-activity")).toHaveAttribute("open", "");
  await expect(group.getByText("正在处理…", { exact: true })).toBeVisible();
  await approval.getByRole("button", { name: "拒绝", exact: true }).click();
  // Legacy phase omitted by this fixture: its latest streaming answer remains visible.
  await expect(group.locator(":scope > .agent-message")).toContainText(
    "操作已拒",
  );
  mock.finishStream();
  await expect(group.locator(":scope > .agent-message")).toContainText(
    "操作已拒绝",
  );
  await expect(
    group.getByText("一大段中间进展说明", { exact: true }),
  ).toBeHidden();
  await expect(approval).toHaveCount(0);
  await expect(group.locator(".turn-activity")).not.toHaveAttribute("open", "");
  await expect(group.locator(".reasoning-item")).not.toHaveAttribute("open", "");
  await expect(group.locator(".tool-item[open]")).toHaveCount(0);
  await group.locator(".turn-activity > summary").click();
  await expect(
    group.getByText("一大段中间进展说明", { exact: true }),
  ).toBeVisible();
});

test("historical failures remain visible even when they have no items or duration", async ({
  page,
  mock,
}) => {
  mock.turns.get("thread-existing")!.push({
    id: "failed-empty",
    status: "failed",
    durationMs: null,
    error: { message: "该账户暂时无法使用此模型" },
    items: [],
  });
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const failed = page.locator(
    '.conversation-turn[data-turn-id="failed-empty"]',
  );
  await expect(failed.getByRole("alert")).toHaveText(
    "该账户暂时无法使用此模型",
  );
  await expect(
    failed.getByText("执行失败 · 工作过程", { exact: true }),
  ).toBeVisible();
  await expect(failed.locator(".turn-activity")).not.toHaveAttribute(
    "open",
    "",
  );
  await page.reload();
  await expect(failed.getByRole("alert")).toBeVisible();
});

test("manual process and reasoning toggles survive new deltas, while completed history stays open during another turn", async ({ page, mock }) => {
  const history = mock.turns.get("thread-existing")![0];
  history.items.splice(1, 0, { id: "history-progress", type: "agentMessage", phase: "commentary", text: "手动展开的历史进展" });
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const historical = page.locator('.conversation-turn[data-turn-id="turn-history"]');
  await historical.locator(".turn-activity > summary").click();
  await expect(historical.getByText("手动展开的历史进展", { exact: true })).toBeVisible();
  const turn = startProcess(mock, "manual-turn");
  const group = page.locator('.conversation-turn[data-turn-id="manual-turn"]');
  await expect(group.getByText("manual-turn 公开摘要", { exact: true })).toBeVisible();
  await expect(group.getByText("非摘要内容不展示", { exact: true })).toHaveCount(0);
  await group.locator(".turn-activity > summary").click();
  mock.emit("item/reasoning/summaryTextDelta", { threadId: "thread-existing", turnId: turn.id, itemId: "manual-turn-reasoning", summaryIndex: 0, delta: " · 新摘要" });
  mock.emit("item/agentMessage/delta", { threadId: "thread-existing", turnId: turn.id, itemId: "manual-turn-progress", delta: " · 新进展" });
  await expect(group.getByText("manual-turn 进展说明 · 新进展", { exact: true })).toBeHidden();
  await expect(group.locator(".turn-activity")).not.toHaveAttribute("open", "");
  await group.locator(".turn-activity > summary").click();
  await group.locator(".reasoning-item > summary").click();
  await group.locator(".tool-item > summary").click();
  await expect(group.getByText("manual-turn 工具输出", { exact: true })).toBeVisible();
  await group.locator(".tool-item > summary").click();
  mock.emit("item/reasoning/summaryTextDelta", { threadId: "thread-existing", turnId: turn.id, itemId: "manual-turn-reasoning", summaryIndex: 0, delta: " · 更多摘要" });
  mock.emit("item/commandExecution/outputDelta", { threadId: "thread-existing", turnId: turn.id, itemId: "manual-turn-tool", delta: " · 更多输出" });
  await expect(group.locator(".reasoning-content")).toContainText("更多摘要");
  await expect(group.locator(".reasoning-content")).toBeHidden();
  await expect(group.getByText("manual-turn 工具输出 · 更多输出", { exact: true })).toBeHidden();
  await expect(group.locator(".reasoning-item")).not.toHaveAttribute("open", "");
  await expect(group.locator(".tool-item")).not.toHaveAttribute("open", "");
  await expect(historical.getByText("手动展开的历史进展", { exact: true })).toBeVisible();
  turn.status = "completed";
  turn.durationMs = 1000;
  turn.completedAt = 1791200001;
  mock.emit("turn/completed", { threadId: "thread-existing", turn });
  await expect(group.locator(".turn-activity")).not.toHaveAttribute("open", "");
  await expect(historical.locator(".turn-activity")).toHaveAttribute("open", "");
});

for (const status of ["failed", "interrupted"]) {
  test(`a running process folds on ${status}, preserving its final answer and error`, async ({ page, mock }) => {
    await login(page);
    await page.locator('[data-section="recent"] .thread-row').first().click();
    const turn = startProcess(mock, `${status}-live`);
    const group = page.locator(`.conversation-turn[data-turn-id="${turn.id}"]`);
    await expect(group.getByText(`${turn.id} 公开摘要`, { exact: true })).toBeVisible();
    await expect(group.getByText(`${turn.id} 工具输出`, { exact: true })).toBeHidden();
    await expect(group.locator(".tool-item > summary")).toBeVisible();
    const final = { id: `${turn.id}-final`, type: "agentMessage", phase: "final_answer", text: "直接可见的最终答复" };
    mock.emit("item/completed", { threadId: "thread-existing", turnId: turn.id, item: final });
    await expect(group.getByText(final.text, { exact: true })).toBeVisible();
    turn.status = status;
    turn.durationMs = 1000;
    turn.completedAt = 1791200001;
    if (status === "failed") turn.error = { message: "这一轮执行失败的原因" };
    mock.emit("turn/completed", { threadId: "thread-existing", turn });
    await expect(group.locator(".turn-activity")).not.toHaveAttribute("open", "");
    await expect(group.locator(".reasoning-item")).not.toHaveAttribute("open", "");
    await expect(group.locator(".tool-item")).not.toHaveAttribute("open", "");
    await expect(group.getByText(`${turn.id} 进展说明`, { exact: true })).toBeHidden();
    await expect(group.getByText(final.text, { exact: true })).toBeVisible();
    if (status === "failed") await expect(group.getByRole("alert")).toHaveText("这一轮执行失败的原因");
    await expect(group.locator(".turn-activity > summary")).toContainText(status === "failed" ? "执行失败" : "已停止");
    await group.locator(".turn-activity > summary").click();
    await expect(group.getByText(`${turn.id} 进展说明`, { exact: true })).toBeVisible();
  });
}

test("busy fallback folds a turn without completion metadata and another running turn never reopens the old one", async ({ page, mock }) => {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const older = startProcess(mock, "missing-completion");
  const oldGroup = page.locator('.conversation-turn[data-turn-id="missing-completion"]');
  await expect(oldGroup.getByText("missing-completion 公开摘要", { exact: true })).toBeVisible();
  mock.emit("thread/status/changed", { threadId: "thread-existing", status: { type: "idle" } });
  await expect(oldGroup.locator(".turn-activity")).not.toHaveAttribute("open", "");
  await expect(oldGroup.locator(".reasoning-item")).not.toHaveAttribute("open", "");
  // The server may mark the chat busy before announcing its next turn.
  mock.emit("thread/status/changed", { threadId: "thread-existing", status: { type: "active" } });
  await expect(page.locator(".working-indicator")).toBeVisible();
  await expect(oldGroup.locator(".turn-activity")).not.toHaveAttribute("open", "");
  await oldGroup.locator(".turn-activity > summary").click();
  await oldGroup.locator(".reasoning-item > summary").click();
  const current = startProcess(mock, "current-after-missing");
  const currentGroup = page.locator('.conversation-turn[data-turn-id="current-after-missing"]');
  await expect(currentGroup.getByText("current-after-missing 公开摘要", { exact: true })).toBeVisible();
  await expect(oldGroup.locator(".turn-activity")).toHaveAttribute("open", "");
  await expect(oldGroup.locator(".reasoning-item")).toHaveAttribute("open", "");
  await expect(oldGroup.locator(".turn-activity > summary .thinking-dot")).toHaveCount(0);
  mock.emit("item/reasoning/summaryTextDelta", { threadId: "thread-existing", turnId: older.id, itemId: "missing-completion-reasoning", summaryIndex: 0, delta: " · 迟到摘要" });
  await expect(oldGroup.locator(".reasoning-content")).toContainText("迟到摘要");
  current.status = "completed";
  current.durationMs = 1000;
  current.completedAt = 1791200001;
  mock.emit("turn/completed", { threadId: "thread-existing", turn: current });
  await expect(currentGroup.locator(".turn-activity")).not.toHaveAttribute("open", "");
  await expect(oldGroup.locator(".turn-activity")).toHaveAttribute("open", "");
  await expect(oldGroup.locator(".reasoning-item")).toHaveAttribute("open", "");
  await expect(oldGroup.locator(".reasoning-content")).toBeVisible();
});
