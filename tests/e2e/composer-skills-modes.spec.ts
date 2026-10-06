import { test, expect, login, MockCodex } from "./fixtures";

function skill(name: string, root = "/test/.codex/skills", enabled = true) {
  return { name, description: `${name} 的技能说明`, path: `${root}/${name}/SKILL.md`, enabled,
    scope: "user", pluginId: null, interface: { shortDescription: `${name} 简介` } };
}

/** Isolated wire responses; no real Codex process, model, or server is used. */
function composerWire(mock: MockCodex, options: { plan?: boolean; goal?: boolean; skills?: any[] } = {}) {
  const original = (mock as any).receive.bind(mock);
  const control = { skills: options.skills || [skill("writer"), skill("reviewer"), skill("disabled-skill", undefined, false)],
    failSkills: false, failMode: false, failGoalActivation: false, goal: null as any, holdSkills: false,
    holdGoalGet: false, releaseGoalGet: undefined as (() => void) | undefined,
    releaseSkills: undefined as (() => void) | undefined };
  (mock as any).receive = (socket: any, request: any) => {
    const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }));
    const error = (message: string, code = -32601) => socket.send(JSON.stringify({ id: request.id, error: { code, message } }));
    const params = request.params || {};
    switch (request.method) {
      case "collaborationMode/list":
        mock.requests.push(request);
        return reply({ data: [
          { name: "Default", mode: "default", model: null, reasoning_effort: null },
          ...(options.plan === false ? [] : [{ name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" }]),
        ] });
      case "skills/list": {
        mock.requests.push(request);
        const finish = () => control.failSkills ? error("Test skill inventory unavailable", -32000)
          : reply({ data: [{ cwd: params.cwds?.[0], skills: control.skills, errors: [] }] });
        if (control.holdSkills) control.releaseSkills = finish;
        else finish();
        return;
      }
      case "thread/goal/get":
        mock.requests.push(request);
        if (options.goal === false) return error("Method not found");
        if (control.holdGoalGet && params.threadId === "thread-existing") {
          const snapshot = control.goal;
          control.releaseGoalGet = () => reply({ goal: snapshot });
          return;
        }
        return reply({ goal: control.goal });
      case "thread/goal/set":
        mock.requests.push(request);
        if (params.status === "active" && control.failGoalActivation)
          return error("Test goal activation failed", -32000);
        control.goal = { threadId: params.threadId, objective: params.objective ?? control.goal?.objective ?? "",
          status: params.status ?? control.goal?.status ?? "active", tokenBudget: Object.prototype.hasOwnProperty.call(params, "tokenBudget")
            ? params.tokenBudget : control.goal?.tokenBudget ?? null,
          tokensUsed: 230, timeUsedSeconds: 7, createdAt: 1791200000, updatedAt: 1791200001 };
        reply({ goal: control.goal });
        mock.emit("thread/goal/updated", { threadId: params.threadId, turnId: null, goal: control.goal });
        return;
      case "thread/goal/clear":
        mock.requests.push(request);
        control.goal = null;
        reply({ cleared: true });
        mock.emit("thread/goal/cleared", { threadId: params.threadId });
        return;
      case "thread/settings/update":
        mock.requests.push(request);
        return control.failMode ? error("Test mode update failed", -32000) : reply({});
      default:
        return original(socket, request);
    }
  };
  return control;
}

test("slash loads enabled skills from the current cwd and sends structured skill input", async ({ page, mock }) => {
  composerWire(mock);
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("/writer");
  const picker = page.getByRole("listbox", { name: "对话指令" });
  await expect(picker.getByRole("option").filter({ hasText: "/writer" })).toBeVisible();
  await expect(picker).not.toContainText("disabled-skill");
  expect(mock.request("skills/list")?.params.cwds).toEqual(["/workspace/demo"]);
  await picker.getByRole("option").filter({ hasText: "/writer" }).click();
  await expect(page.locator(".composer-tokens")).toContainText("writer");
  await expect(input).toHaveValue("");
  expect(mock.request("turn/start")).toBeUndefined();
  await input.fill("使用这个技能整理说明");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("turn/start")?.params.input).toContainEqual({
    type: "skill", name: "writer", path: "/test/.codex/skills/writer/SKILL.md",
  });
});

test("skill keyboard selection preserves surrounding text, deduplicates, and removes a token", async ({ page, mock }) => {
  composerWire(mock, { skills: [skill("writer"), skill("writer-extra")] });
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("请用 /writer 处理文档");
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(10, 10);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.getByRole("listbox")).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page.locator(".composer-tokens")).toContainText("writer-extra");
  await expect(input).toHaveValue("请用  处理文档");
  await input.fill("/writer-extra");
  await expect(page.getByRole("listbox")).toBeVisible();
  await input.press("Enter");
  await expect(page.locator(".composer-token")).toHaveCount(1);
  await page.getByRole("button", { name: "移除技能 writer-extra", exact: true }).click();
  await expect(page.locator(".composer-token")).toHaveCount(0);
  expect(mock.request("turn/start")).toBeUndefined();
});

test("existing slash commands still work and Escape closes suggestions without sending", async ({ page, mock }) => {
  composerWire(mock);
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("/");
  await expect(page.getByRole("listbox")).toContainText("/new");
  await expect(page.getByRole("listbox")).toContainText("/compact");
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(input).toHaveValue("/");
  expect(mock.request("turn/start")).toBeUndefined();
  await input.fill("/settings");
  await input.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("at menu selects native Plan mode and keeps file mentions available", async ({ page, mock }) => {
  composerWire(mock);
  await login(page);
  await page.getByRole("button", { name: "选择模式或引用项目文件", exact: true }).click();
  const picker = page.getByRole("listbox", { name: "模式与项目文件" });
  await expect(picker.getByRole("option").filter({ hasText: "Plan 模式" })).toBeEnabled();
  await expect(picker).toContainText("README.md");
  await picker.getByRole("option").filter({ hasText: "Plan 模式" }).click();
  await expect(page.locator(".mode-token")).toContainText("Plan 模式");
  await page.getByRole("textbox", { name: "消息输入框" }).fill("先给出实现计划");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("turn/start")?.params.collaborationMode?.mode).toBe("plan");
  await page.getByRole("button", { name: "恢复默认模式", exact: true }).click();
  await expect(page.locator(".mode-token")).toHaveCount(0);
  expect(mock.request("thread/settings/update")?.params.collaborationMode.mode).toBe("default");
});

test("unsupported Plan and Goal are disabled with an explanation", async ({ page, mock }) => {
  composerWire(mock, { plan: false, goal: false });
  await login(page);
  await page.getByRole("button", { name: "选择模式或引用项目文件", exact: true }).click();
  const picker = page.getByRole("listbox");
  await expect(picker.getByRole("option").filter({ hasText: "Plan 模式" })).toBeDisabled();
  await expect(picker.getByRole("option").filter({ hasText: "Goal 模式" })).toBeDisabled();
  await expect(picker).toContainText("当前 Codex 版本未提供 Goal 模式");
  expect(mock.request("thread/goal/set")).toBeUndefined();
});

test("Goal creates a native target and supports pause, resume, and clear", async ({ page, mock }) => {
  composerWire(mock);
  mock.holdFinalMessage = true;
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("@goal");
  await expect(page.getByRole("listbox").getByRole("option").filter({ hasText: "Goal 模式" })).toBeEnabled();
  await input.press("Enter");
  await expect(page.locator(".composer-goal")).toContainText("输入目标后发送");
  await input.fill("完成测试目标并汇报结果");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.status).toBe("active");
  await expect(page.locator(".composer-goal")).toContainText("完成测试目标并汇报结果");
  await expect(page.locator(".composer-goal")).toContainText("已用 230 tokens");
  await page.getByRole("button", { name: "暂停目标", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.status).toBe("paused");
  await page.getByRole("button", { name: "继续目标", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.status).toBe("active");
  await page.getByRole("button", { name: "清除目标", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/clear")?.method).toBe("thread/goal/clear");
  await expect(page.locator(".composer-goal")).toContainText("输入目标后发送");
});

test("a failed native mode update preserves the current mode and draft", async ({ page, mock }) => {
  const control = composerWire(mock);
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: "已有测试历史" }).first().click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  control.failMode = true;
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("@plan");
  await expect(page.getByRole("listbox").getByRole("option").filter({ hasText: "Plan 模式" })).toBeEnabled();
  await input.press("Enter");
  await expect(page.getByRole("listbox")).toContainText("Test mode update failed");
  await expect(input).toHaveValue("@plan");
  await expect(page.locator(".mode-token")).toHaveCount(0);
  expect(mock.request("turn/start")).toBeUndefined();
});

test("switching hosts does not carry the previous host's skill paths", async ({ page, mock }) => {
  composerWire(mock);
  const remote = new MockCodex();
  composerWire(remote, { skills: [skill("remote-skill", "/remote/.codex/skills")] });
  mock.hosts.push({ id: "ssh-skills", kind: "ssh", name: "测试远端", cwd: "/srv" });
  mock.projects.push({ id: "remote-skills", name: "远端项目", path: "/srv/demo", hostId: "ssh-skills", source: "web" });
  mock.hostMocks.set("ssh-skills", remote);
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("/writer");
  await page.getByRole("listbox").getByRole("option").filter({ hasText: "/writer" }).click();
  await expect(page.locator(".composer-token")).toContainText("writer");
  await page.getByRole("combobox", { name: "新对话主机", exact: true }).selectOption("ssh-skills");
  await expect(input).toBeEnabled();
  await expect(page.locator(".composer-token")).toHaveCount(0);
  await input.fill("/");
  await expect(page.getByRole("listbox")).toContainText("remote-skill");
  await expect(page.getByRole("listbox")).not.toContainText("/writer");
  expect(remote.request("skills/list")?.params.cwds).toEqual(["/srv/demo"]);
});

async function selectGoal(page: any) {
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("@goal");
  await expect(page.getByRole("listbox").getByRole("option").filter({ hasText: "Goal 模式" })).toBeEnabled();
  await input.press("Enter");
  await expect(page.locator(".composer-goal")).toContainText("输入目标后发送");
  return input;
}

test("Goal submits once in paused → full turn input → active order", async ({ page, mock }) => {
  composerWire(mock);
  await login(page);
  const input = await selectGoal(page);
  await input.fill("只提交一次的目标");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.status).toBe("active");
  const sequence = mock.requests.filter((request) => ["thread/goal/set", "turn/start"].includes(request.method || ""));
  expect(sequence.map((request) => request.method === "turn/start" ? "turn" : request.params.status)).toEqual(["paused", "turn", "active"]);
  expect(sequence[1].params.input).toContainEqual(expect.objectContaining({ type: "text", text: "只提交一次的目标" }));
  expect(sequence[1].params.collaborationMode.mode).toBe("default");
});

test("a failed Goal turn stays paused and preserves the objective draft", async ({ page, mock }) => {
  composerWire(mock);
  await login(page);
  const input = await selectGoal(page);
  mock.failTurnStartNext = true;
  await input.fill("失败后保留的目标");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await expect(input).toHaveValue("失败后保留的目标");
  await expect(page.locator(".composer-goal")).toContainText("已暂停");
  expect(mock.requests.filter((request) => request.method === "thread/goal/set").map((request) => request.params.status)).toEqual(["paused"]);
});

test("Goal activation failure does not keep a successfully submitted message in the draft", async ({ page, mock }) => {
  const control = composerWire(mock);
  await login(page);
  const input = await selectGoal(page);
  control.failGoalActivation = true;
  await input.fill("消息成功但目标激活失败");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.locator(".composer-mode-error")).toContainText("Test goal activation failed");
  await expect(page.locator(".composer-goal")).toContainText("已暂停");
  expect(mock.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
});

for (const terminalEvent of ["complete", "cleared"] as const) {
  test(`a Goal ${terminalEvent} notification before turn ACK cannot reactivate the target`, async ({ page, mock }) => {
    const control = composerWire(mock);
    await login(page);
    const input = await selectGoal(page);
    mock.holdTurnStartResponse = true;
    await input.fill("等待确认时完成的目标");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => mock.request("turn/start")?.method).toBe("turn/start");
    const threadId = mock.request("turn/start")?.params.threadId;
    if (terminalEvent === "complete") {
      control.goal = { ...control.goal, status: "complete" };
      mock.emit("thread/goal/updated", { threadId, turnId: null, goal: control.goal });
      await expect(page.locator(".composer-goal")).toContainText("已完成");
    } else {
      control.goal = null;
      mock.emit("thread/goal/cleared", { threadId });
      await expect(page.locator(".composer-goal")).toContainText("输入目标后发送");
    }
    mock.releaseTurnStartResponse();
    await expect(input).toHaveValue("");
    expect(mock.requests.filter((request) => request.method === "thread/goal/set" && request.params.status === "active")).toHaveLength(0);
  });
}

test("a late Goal read for the previous thread cannot replace a new conversation", async ({ page, mock }) => {
  const control = composerWire(mock);
  await login(page);
  control.goal = { threadId: "thread-existing", objective: "过期对话目标", status: "active", tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1791200000, updatedAt: 1791200001 };
  control.holdGoalGet = true;
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: "已有测试历史" }).first().click();
  await expect.poll(() => typeof control.releaseGoalGet).toBe("function");
  await page.locator(".new-thread-button").click();
  await expect(page.locator(".welcome")).toBeVisible();
  control.releaseGoalGet?.();
  await expect(page.getByRole("textbox", { name: "消息输入框" })).toBeEnabled();
  await expect(page.locator(".composer-goal")).toHaveCount(0);
  await expect(page.locator(".composer-area")).not.toContainText("过期对话目标");
});

test("Goal accepts an optional positive token budget and saves later edits using native RPC", async ({ page, mock }) => {
  const control = composerWire(mock);
  await login(page);
  const input = await selectGoal(page);
  const budget = page.getByRole("spinbutton", { name: "Goal token 预算", exact: true });
  await budget.fill("-1");
  await input.fill("设置预算的测试目标");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await expect(page.locator(".goal-budget-error")).toContainText("正整数");
  await budget.fill("1000");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.status).toBe("active");
  expect(mock.requests.find((request) => request.method === "thread/goal/set")?.params.tokenBudget).toBe(1000);
  await budget.fill("2000");
  // Progress notifications must not overwrite a budget edit in progress.
  control.goal = { ...control.goal, tokensUsed: 400 };
  mock.emit("thread/goal/updated", { threadId: control.goal.threadId, turnId: null, goal: control.goal });
  await expect(budget).toHaveValue("2000");
  await page.getByRole("button", { name: "保存预算", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.tokenBudget).toBe(2000);
  await budget.fill("");
  await page.getByRole("button", { name: "保存预算", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.tokenBudget).toBeNull();
  await expect(budget).toHaveValue("");
});

test("a reached Goal budget requires an explicit increase before continuing", async ({ page, mock }) => {
  const control = composerWire(mock);
  await login(page);
  const input = await selectGoal(page);
  await input.fill("达到预算后不会自动突破额度");
  await page.getByRole("spinbutton", { name: "Goal token 预算", exact: true }).fill("1000");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.status).toBe("active");
  control.goal = { ...control.goal, status: "budgetLimited", tokenBudget: 1000, tokensUsed: 1000 };
  mock.emit("thread/goal/updated", { threadId: control.goal.threadId, turnId: null, goal: control.goal });
  await expect(page.locator(".composer-goal")).toContainText("已达到预算");
  const previous = mock.requests.filter((request) => request.method === "thread/goal/set" && request.params.status === "active").length;
  await page.getByRole("button", { name: "继续目标", exact: true }).click();
  await expect(page.locator(".composer-mode-error")).toContainText("预算");
  expect(mock.requests.filter((request) => request.method === "thread/goal/set" && request.params.status === "active")).toHaveLength(previous);
  await page.getByRole("spinbutton", { name: "Goal token 预算", exact: true }).fill("2000");
  await page.getByRole("button", { name: "保存预算", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.tokenBudget).toBe(2000);
  await page.getByRole("button", { name: "继续目标", exact: true }).click();
  await expect.poll(() => mock.request("thread/goal/set")?.params.status).toBe("active");
});

test("busy tasks explain why changing collaboration modes must wait", async ({ page, mock }) => {
  composerWire(mock);
  mock.holdFinalMessage = true;
  await login(page);
  await page.getByRole("textbox", { name: "消息输入框" }).fill("运行期间不切换协作模式");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "选择模式或引用项目文件", exact: true }).click();
  const picker = page.getByRole("listbox");
  await expect(picker.getByRole("option").filter({ hasText: "Plan 模式" })).toBeDisabled();
  await expect(picker.getByRole("option").filter({ hasText: "Goal 模式" })).toBeDisabled();
  await expect(picker).toContainText("任务运行中，结束或停止后切换");
  await expect(picker.getByRole("option").filter({ hasText: "README.md" })).toBeEnabled();
});

test("a successful first submission does not leave its draft in the new-chat project slot", async ({ page, mock }) => {
  composerWire(mock);
  await login(page);
  await page.getByRole("textbox", { name: "消息输入框" }).fill("发送成功后清除旧的项目草稿");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".agent-message")).toContainText("流式回复完成");
  await page.locator(".new-thread-button").click();
  await expect(page.getByRole("textbox", { name: "消息输入框" })).toHaveValue("");
});
