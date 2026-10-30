import type { Page } from "@playwright/test";
import { test, expect, login, MockCodex } from "./fixtures";

const remoteHostId = "ssh-nas-settings";
const cliModels = (extra = false) => ["mock-model-a", "mock-model-b", ...(extra ? ["new-remote-model"] : [])].map(model => ({
  id: model, model, displayName: model, isDefault: model === "mock-model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }, { reasoningEffort: "high", description: "High" }],
}));
function runtimeInformation(overrides: Record<string, any> = {}) {
  return {
    checkedAt: Date.now(),
    runtime: { connected: true, paused: false, managed: true, mode: "ssh", engineId: "original-fixture-engine", userAgent: "codex_cli_rs/0.160.1", activeThreadCount: 0, activeProcesses: [] },
    config: { model: "mock-model-a", model_context_window: 256000, model_auto_compact_token_limit: 220000 },
    models: cliModels(), canReconnect: true, reconnectDisabledReason: null,
    ...overrides,
  };
}
function codexInformation(overrides: Record<string, any> = {}) {
  return { provider: "official", baseUrl: "", hasApiKey: false, model: "mock-model-a", account: null, userAgent: "codex_cli_rs/0.160.1", connected: true, canChange: true, disabledReason: null, ...overrides };
}
type SettingsWire = {
  information: Map<string, any>;
  codex: Map<string, any>;
  calls: { hostId: string; path: string; method: string; body?: any }[];
  failReconnect?: string;
  delay?: Promise<void>;
};
async function wireSettings(page: Page, mock: MockCodex) {
  mock.hosts.push({ id: remoteHostId, name: "NAS", kind: "ssh", hostname: "nas.fixture.test" });
  mock.hostMocks.set(remoteHostId, new MockCodex());
  const wire: SettingsWire = {
    information: new Map([["local", runtimeInformation({ runtime: { ...runtimeInformation().runtime, mode: "spawn" } })], [remoteHostId, runtimeInformation()]]),
    codex: new Map([["local", codexInformation()], [remoteHostId, codexInformation()]]), calls: [],
  };
  const bridgeStatus = (hostId: string) => ({
    ...wire.information.get(hostId).runtime,
    hostId, pendingRequests: [], loadedThreadIds: ["thread-existing"], clientId: "fixture-client",
  });
  for (const [hostId, target] of [["local", mock], [remoteHostId, mock.hostMocks.get(remoteHostId)!]] as const) {
    const original = (target as any).receive.bind(target);
    (target as any).receive = (socket: any, request: any) => {
      if (request.method !== "bridge/ping") return original(socket, request);
      target.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, result: bridgeStatus(hostId) }));
    };
  }
  await page.routeWebSocket(/\/api\/rpc(?:\?|$)/, socket => {
    const hostId = new URL(socket.url()).searchParams.get("host") || "local";
    const target = hostId === "local" ? mock : mock.hostMocks.get(hostId)!;
    target.sockets.push(socket);
    socket.onMessage(raw => (target as any).receive(socket, JSON.parse(raw.toString())));
    socket.send(JSON.stringify({ method: "bridge/status", params: bridgeStatus(hostId) }));
  });
  await page.route(/\/api\/hosts\/[^/]+\/(?:runtime\/(?:information|reconnect|daemon\/restart)|codex-settings(?:\/[^?]+)?|settings\/rpc)(?:\?|$)/, async route => {
    const request = route.request();
    const parts = new URL(request.url()).pathname.split("/");
    const hostId = decodeURIComponent(parts[3]!);
    const path = parts.slice(4).join("/");
    const body = request.method() === "POST" ? request.postDataJSON() : undefined;
    wire.calls.push({ hostId, path, method: request.method(), ...(body ? { body } : {}) });
    if (path === "runtime/information") return route.fulfill({ json: wire.information.get(hostId) });
    if (path === "runtime/reconnect" || path === "runtime/daemon/restart") {
      if (wire.delay) await wire.delay;
      if (wire.failReconnect) return route.fulfill({ status: 409, json: { error: wire.failReconnect } });
      const old = wire.information.get(hostId);
      wire.information.set(hostId, runtimeInformation({
        ...old,
        runtime: { ...old.runtime, userAgent: "codex_cli_rs/0.161.0", engineId: "new-fixture-engine" },
        config: { ...old.config, model_context_window: 500000 }, models: cliModels(true),
      }));
      (hostId === "local" ? mock : mock.hostMocks.get(hostId)!).emit("bridge/status", bridgeStatus(hostId));
      return route.fulfill({ json: { ok: true, runtime: wire.information.get(hostId).runtime } });
    }
    if (path === "codex-settings") return route.fulfill({ json: wire.codex.get(hostId) });
    if (path === "codex-settings/provider") {
      const previous = wire.codex.get(hostId);
      wire.codex.set(hostId, codexInformation({ ...previous, provider: body.provider, ...(body.provider === "gateway" ? { baseUrl: body.baseUrl, hasApiKey: !!body.apiKey || previous.hasApiKey, model: body.model || previous.model } : {}) }));
      return route.fulfill({ json: wire.codex.get(hostId) });
    }
    if (path === "codex-settings/login") return route.fulfill({ json: { loginId: "fixture-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" } });
    if (path === "codex-settings/login/cancel") return route.fulfill({ json: { ok: true } });
    if (path === "codex-settings/logout") { wire.codex.get(hostId).account = null; return route.fulfill({ json: { ok: true } }); }
    if (path === "settings/rpc") {
      const info = wire.information.get(hostId);
      const native = body.method;
      const result = native === "config/read" ? { config: { ...info.config, sandbox_mode: "workspace-write" }, layers: [], origins: {} }
        : native === "model/list" ? { data: info.models, nextCursor: null }
        : native === "configRequirements/read" ? { requirements: null }
        : native === "modelProvider/capabilities/read" ? { webSearch: true, imageGeneration: false, namespaceTools: false }
        : native === "account/read" ? { account: wire.codex.get(hostId).account }
        : native === "permissionProfile/list" ? { data: [{ id: `${hostId}-policy`, description: "所选主机权限", allowed: true }] }
        : native === "skills/list" ? { data: [{ cwd: "/workspace/demo", skills: [{ name: `${hostId}-skill`, path: "/fixture/SKILL.md", description: "所选主机技能" }] }] }
        : { data: [], nextCursor: null };
      return route.fulfill({ json: result });
    }
    return route.fulfill({ status: 404, json: { error: "Unknown settings fixture route" } });
  });
  return wire;
}
async function openSettings(page: Page, section: "性能" | "Codex" | "配置" | "权限预设", hostId = "local") {
  const sidebar = page.getByRole("button", { name: "打开侧边栏", exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator(".settings-button").click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("combobox", { name: "设置主机", exact: true }).selectOption(hostId);
  await settings.locator(".settings-nav").getByRole("button", { name: section, exact: true }).click();
  return settings;
}
function pagedModels(mock: MockCodex) {
  const original = (mock as any).receive.bind(mock);
  const catalogue = { updated: false };
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== "model/list") return original(socket, request);
    mock.requests.push(request);
    const secondPage = request.params?.cursor === "next-models";
    const data = secondPage ? cliModels(true).slice(2) : cliModels();
    socket.send(JSON.stringify({ id: request.id, result: { data, nextCursor: catalogue.updated && !secondPage ? "next-models" : null } }));
  };
  return catalogue;
}

test("reconnecting the current host refreshes a paginated model catalogue while preserving thread, draft, choices and actual context measurement", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  const catalogue = pagedModels(mock);
  const usage = { last: { totalTokens: 100000 }, modelContextWindow: 256000 };
  await page.route("**/api/hosts/local/threads/thread-existing/context*", route => route.fulfill({ json: { tokenUsage: usage, compacting: false } }));
  await login(page);
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]').filter({ hasText: "已有测试历史" }).locator(".thread-row").click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.fill("更新过程中保留草稿");
  await page.getByRole("combobox", { name: "选择模型", exact: true }).selectOption("mock-model-b");
  await page.getByRole("combobox", { name: "推理强度", exact: true }).selectOption("high");
  await page.getByRole("combobox", { name: "选择权限", exact: true }).selectOption("read-only");
  const settings = await openSettings(page, "性能");
  catalogue.updated = true;
  await settings.getByRole("button", { name: "重新连接 Codex", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("Codex 已重新连接");
  await expect(settings.getByText("500k tokens", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(input).toHaveValue("更新过程中保留草稿");
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await expect(page.getByRole("combobox", { name: "选择模型", exact: true })).toHaveValue("mock-model-b");
  await expect(page.getByRole("combobox", { name: "推理强度", exact: true })).toHaveValue("high");
  await expect(page.getByRole("combobox", { name: "选择权限", exact: true })).toHaveValue("read-only");
  await expect(page.getByRole("combobox", { name: "选择模型", exact: true }).locator('option[value="new-remote-model"]')).toHaveCount(1);
  expect(mock.requests.some(request => request.method === "model/list" && request.params?.cursor === "next-models")).toBe(true);
  await page.locator(".composer-submit .context-usage").click();
  await expect(page.getByRole("dialog", { name: "上下文用量与压缩", exact: true })).toContainText("100k / 256k");
  expect(wire.calls.filter(call => call.path === "runtime/reconnect")).toHaveLength(1);
});

test("another Web client observing a new engine refreshes available models without changing its draft or choices", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  const catalogue = pagedModels(mock);
  await login(page);
  mock.emit("bridge/status", { hostId: "local", connected: true, paused: false, engineId: "original-fixture-engine", pendingRequests: [] });
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.fill("观察页面自己的草稿");
  await page.getByRole("combobox", { name: "选择模型", exact: true }).selectOption("mock-model-b");
  await page.getByRole("combobox", { name: "推理强度", exact: true }).selectOption("high");
  // The selected DOM option can update before the asynchronous native settings
  // operation completes. Preserve an acknowledged choice across the restart;
  // a request interrupted by a new engine is deliberately rejected instead.
  await expect(page.getByRole("combobox", { name: "推理强度", exact: true })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "推理强度", exact: true })).toHaveValue("high");
  catalogue.updated = true;
  wire.information.set("local", runtimeInformation({ models: cliModels(true), config: { model: "mock-model-a", model_context_window: 500000 }, runtime: { ...runtimeInformation().runtime, mode: "spawn", engineId: "updated-fixture-engine" } }));
  mock.emit("bridge/status", { hostId: "local", connected: true, paused: false, engineId: "updated-fixture-engine", pendingRequests: [] });
  await expect(page.getByRole("combobox", { name: "选择模型", exact: true }).locator('option[value="new-remote-model"]')).toHaveCount(1);
  await expect(input).toHaveValue("观察页面自己的草稿");
  await expect(page.getByRole("combobox", { name: "选择模型", exact: true })).toHaveValue("mock-model-b");
  await expect(page.getByRole("combobox", { name: "推理强度", exact: true })).toHaveValue("high");
  expect(wire.calls.filter(call => call.path === "runtime/reconnect")).toHaveLength(0);
});

test("performance reconnection refreshes version, models and a 500k window without changing the current conversation or draft", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  await login(page);
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]').filter({ hasText: "已有测试历史" }).locator(".thread-row").click();
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.fill("保留当前主机的草稿");
  const resumes = mock.requests.filter(request => request.method === "thread/resume").length;
  const settings = await openSettings(page, "性能", remoteHostId);
  await expect(settings.getByText("256k tokens", { exact: true })).toBeVisible();
  await expect(settings.getByText("codex_cli_rs/0.160.1", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "重新连接 Codex", exact: true }).click();
  await expect(settings.getByText("500k tokens", { exact: true })).toBeVisible();
  await expect(settings.getByText("codex_cli_rs/0.161.0", { exact: true })).toBeVisible();
  await expect(settings.getByText("3 个", { exact: true })).toBeVisible();
  await settings.screenshot({ path: ".data/settings-performance-desktop.png" });
  expect(wire.calls.filter(call => call.path === "runtime/reconnect")).toEqual([{ hostId: remoteHostId, path: "runtime/reconnect", method: "POST", body: {} }]);
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(input).toHaveValue("保留当前主机的草稿");
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  expect(mock.requests.filter(request => request.method === "thread/resume")).toHaveLength(resumes);
  expect(mock.hostMocks.get(remoteHostId)?.request("thread/resume")).toBeUndefined();
});

test("performance disables reconnect for active tasks, terminals and released runtimes but supports reconnecting to an external proxy", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  await login(page);
  const settings = await openSettings(page, "性能", remoteHostId);
  const reconnect = settings.getByRole("button", { name: "重新连接 Codex", exact: true });
  for (const [override, text] of [
    [{ activeThreadCount: 1 }, "主机上有正在运行的任务"],
    [{ activeProcesses: [{ processId: "fixture-shell" }] }, "主机上有正在运行的终端"],
    [{ paused: true, connected: false }, "此主机的 Web Codex 已释放"],
  ] as const) {
    wire.information.set(remoteHostId, runtimeInformation({ runtime: { ...runtimeInformation().runtime, ...override } }));
    await settings.getByRole("button", { name: "刷新信息", exact: true }).click();
    await expect(reconnect).toBeDisabled();
    await expect(settings.locator(".performance-reason")).toContainText(text);
  }
  wire.information.set(remoteHostId, runtimeInformation({ runtime: { ...runtimeInformation().runtime, managed: false, mode: "proxy" } }));
  await settings.getByRole("button", { name: "刷新信息", exact: true }).click();
  await expect(reconnect).toBeEnabled();
  await expect(settings.getByText("重新建立 Web 与原生代理的连接", { exact: false })).toBeVisible();
  expect(wire.calls.filter(call => call.path === "runtime/reconnect")).toHaveLength(0);
});

test("duplicate reconnect clicks issue one request, show an error and can retry", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  await login(page);
  const settings = await openSettings(page, "性能", remoteHostId);
  await expect(settings.getByText("256k tokens", { exact: true })).toBeVisible();
  let release!: () => void;
  wire.delay = new Promise<void>(resolve => { release = resolve; });
  wire.failReconnect = "另一页面刚启动任务，结束后重试";
  await settings.getByRole("button", { name: "重新连接 Codex", exact: true }).dblclick();
  await expect(settings.getByRole("button", { name: "重新连接中…", exact: true })).toBeDisabled();
  await expect(settings.getByRole("combobox", { name: "设置主机", exact: true })).toBeDisabled();
  expect(wire.calls.filter(call => call.path === "runtime/reconnect")).toHaveLength(1);
  release();
  await expect(settings.getByRole("alert")).toContainText("另一页面刚启动任务");
  wire.delay = undefined;
  wire.failReconnect = undefined;
  await settings.getByRole("button", { name: "重新连接 Codex", exact: true }).click();
  await expect(settings.getByText("500k tokens", { exact: true })).toBeVisible();
  expect(wire.calls.filter(call => call.path === "runtime/reconnect")).toHaveLength(2);
});

test("an active independent daemon permits transport reconnect while keeping its task and disabling daemon restart", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  wire.information.set("local", runtimeInformation({
    runtime: { ...runtimeInformation().runtime, mode: "proxy", connectionMode: "daemon", independentDaemon: true, activeThreadCount: 1 },
    canRestartDaemon: false, daemonRestartDisabledReason: "此主机仍有对话或子智能体正在运行",
  }));
  mock.holdFinalMessage = true;
  await login(page);
  await page.getByRole("textbox", { name: "消息输入框", exact: true }).fill("继续运行中的 daemon 任务");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
  const settings = await openSettings(page, "性能");
  await expect(settings.getByText("独立 daemon", { exact: true })).toBeVisible();
  await expect(settings.getByText("重新连接只恢复网页代理", { exact: false })).toBeVisible();
  await expect(settings.getByRole("button", { name: "重新连接 Codex", exact: true })).toBeEnabled();
  const restart = settings.getByRole("button", { name: "重启 daemon", exact: true });
  await expect(restart).toBeDisabled();
  await expect(restart).toHaveAttribute("title", "此主机仍有对话或子智能体正在运行");
  await settings.getByRole("button", { name: "重新连接 Codex", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("Web 连接已恢复，后台 daemon 继续运行");
  expect(wire.calls.filter(call => call.path === "runtime/reconnect")).toEqual([{ hostId: "local", path: "runtime/reconnect", method: "POST", body: {} }]);
  expect(wire.calls.filter(call => call.path === "runtime/daemon/restart")).toHaveLength(0);
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
  expect(mock.requests.some(request => request.method === "turn/interrupt")).toBe(false);
});

test("daemon restart requires the server's idle permission and explicit confirmation, targets one host, and carries CSRF", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  const daemon = runtimeInformation({
    runtime: { ...runtimeInformation().runtime, mode: "proxy", connectionMode: "daemon", independentDaemon: true },
    canRestartDaemon: true, daemonRestartDisabledReason: null,
  });
  wire.information.set(remoteHostId, daemon);
  const posted: { path: string; csrf?: string; body: any }[] = [];
  page.on("request", request => {
    if (!request.url().includes("/runtime/daemon/restart")) return;
    posted.push({ path: new URL(request.url()).pathname, csrf: request.headers()["x-csrf-token"], body: request.postDataJSON() });
  });
  await login(page);
  await page.getByRole("textbox", { name: "消息输入框", exact: true }).fill("当前主机草稿不因另一个主机重启而变化");
  const settings = await openSettings(page, "性能", remoteHostId);
  const restart = settings.getByRole("button", { name: "重启 daemon", exact: true });
  await expect(restart).toBeEnabled();
  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("NAS"); expect(dialog.message()).toContain("其他客户端"); await dialog.dismiss();
  });
  await restart.click();
  expect(posted).toHaveLength(0);
  wire.information.set(remoteHostId, { ...daemon, canRestartDaemon: false, daemonRestartDisabledReason: "还有排队消息，请先处理" });
  await settings.getByRole("button", { name: "刷新信息", exact: true }).click();
  await expect(restart).toBeDisabled();
  await expect(restart).toHaveAttribute("title", "还有排队消息，请先处理");
  await expect(settings.getByRole("button", { name: "重新连接 Codex", exact: true })).toBeEnabled();
  wire.information.set(remoteHostId, daemon);
  await settings.getByRole("button", { name: "刷新信息", exact: true }).click();
  await expect(restart).toBeEnabled();
  page.once("dialog", dialog => dialog.accept());
  await restart.click();
  await expect(settings.getByRole("status")).toContainText("Codex 已重新连接");
  expect(posted).toEqual([{ path: `/api/hosts/${remoteHostId}/runtime/daemon/restart`, csrf: "mock-csrf", body: { confirmed: true } }]);
  expect(wire.calls.filter(call => call.path === "runtime/daemon/restart")).toEqual([{ hostId: remoteHostId, path: "runtime/daemon/restart", method: "POST", body: { confirmed: true } }]);
  expect(wire.calls.filter(call => call.path === "runtime/reconnect")).toHaveLength(0);
  await settings.getByRole("combobox", { name: "设置主机", exact: true }).selectOption("local");
  await expect(settings.getByRole("button", { name: "重启 daemon", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toHaveValue("当前主机草稿不因另一个主机重启而变化");
});

test("a reused external native service remains reconnectable and explicitly disables daemon lifecycle controls", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  const disabledReason = "此连接由其他客户端启动，请在原客户端管理或迁移为托管服务";
  wire.information.set(remoteHostId, runtimeInformation({
    runtime: { ...runtimeInformation().runtime, mode: "proxy", connectionMode: "daemon", independentDaemon: true, managed: false, daemonLifecycleManaged: false },
    canRestartDaemon: false, daemonRestartDisabledReason: disabledReason,
  }));
  await login(page);
  const settings = await openSettings(page, "性能", remoteHostId);
  await expect(settings.getByRole("button", { name: "重新连接 Codex", exact: true })).toBeEnabled();
  await expect(settings.getByRole("button", { name: "重启 daemon", exact: true })).toBeDisabled();
  await expect(settings.getByRole("button", { name: "重启 daemon", exact: true })).toHaveAttribute("title", disabledReason);
  await expect(settings).toContainText("已有服务");
  await expect(settings).toContainText("外部管理");
  expect(wire.calls.filter(call => call.path === "runtime/daemon/restart")).toHaveLength(0);
});

test("the settings host controls configuration and policy without selecting another conversation", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  await login(page);
  const settings = await openSettings(page, "配置", remoteHostId);
  await expect(settings.getByText("mock-model-a", { exact: true }).first()).toBeVisible();
  expect(wire.calls.some(call => call.hostId === remoteHostId && call.path === "settings/rpc" && call.body.method === "config/read")).toBe(true);
  await settings.getByLabel("配置修改数组", { exact: true }).fill('[{"keyPath":"model","value":"new-remote-model","mergeStrategy":"replace"}]');
  await settings.getByRole("button", { name: "保存到主机", exact: true }).click();
  await expect(settings.getByText("配置已保存并重新读取", { exact: true })).toBeVisible();
  expect(wire.calls.filter(call => call.path === "settings/rpc" && call.body.method === "config/batchWrite")).toHaveLength(1);
  expect(wire.calls.find(call => call.path === "settings/rpc" && call.body.method === "config/batchWrite")!.hostId).toBe(remoteHostId);
  await settings.locator(".settings-nav").getByRole("button", { name: "权限预设", exact: true }).click();
  await expect(settings.getByText(`${remoteHostId}-policy`, { exact: true })).toBeVisible();
  expect(mock.hostMocks.get(remoteHostId)?.request("thread/resume")).toBeUndefined();
});

test("gateway settings send a new key only to the selected host, clear it, and preserve the configured key on a later edit", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  await login(page);
  const settings = await openSettings(page, "Codex", remoteHostId);
  await expect(settings.getByRole("button", { name: "保存提供方", exact: true })).toBeEnabled();
  await settings.getByRole("button", { name: "中转站", exact: true }).click();
  await settings.getByLabel("中转站 URL", { exact: true }).fill("https://gateway.fixture.test/v1/");
  const key = settings.getByLabel("中转站 API 密钥", { exact: true });
  await key.fill("fixture-secret-key");
  await settings.getByLabel("中转站默认模型", { exact: true }).fill("new-remote-model");
  await settings.getByRole("button", { name: "保存提供方", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("模型提供方已更新");
  await expect(key).toHaveValue("");
  await settings.getByLabel("中转站 URL", { exact: true }).fill("https://new-gateway.fixture.test/v1");
  await settings.getByRole("button", { name: "保存提供方", exact: true }).click();
  await expect.poll(() => wire.calls.filter(call => call.path === "codex-settings/provider").length).toBe(2);
  const writes = wire.calls.filter(call => call.path === "codex-settings/provider");
  expect(writes[0]).toMatchObject({ hostId: remoteHostId, body: { provider: "gateway", baseUrl: "https://gateway.fixture.test/v1", apiKey: "fixture-secret-key", model: "new-remote-model" } });
  expect(writes[1]!.body).not.toHaveProperty("apiKey");
  expect(await settings.innerText()).not.toContain("fixture-secret-key");
});

test("device-code login can be cancelled and a completed official account is detected", async ({ page, mock }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).copiedLoginCode = value; } } }); });
  const wire = await wireSettings(page, mock);
  await login(page);
  const settings = await openSettings(page, "Codex", remoteHostId);
  await settings.getByRole("button", { name: "登录 ChatGPT", exact: true }).click();
  await expect(settings.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await expect(settings.getByRole("link", { name: "打开登录页面", exact: true })).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  await settings.getByRole("button", { name: "复制登录验证码", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedLoginCode)).toBe("ABCD-EFGH");
  await settings.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(settings.getByText("ABCD-EFGH", { exact: true })).toHaveCount(0);
  expect(wire.calls.find(call => call.path === "codex-settings/login/cancel")).toMatchObject({ hostId: remoteHostId, body: { loginId: "fixture-login" } });
  await settings.getByRole("button", { name: "登录 ChatGPT", exact: true }).click();
  wire.codex.get(remoteHostId).account = { type: "chatgpt", email: "fixture@example.test", planType: "plus" };
  await expect(settings.getByText("fixture@example.test", { exact: true })).toBeVisible();
  await expect(settings.getByText("ABCD-EFGH", { exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "退出 Codex 账户", exact: true }).click();
  await expect(settings.getByRole("button", { name: "登录 ChatGPT", exact: true })).toBeVisible();
});

test("mobile host settings fit the screen and changing host clears an unsaved gateway secret", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const wire = await wireSettings(page, mock);
  await login(page);
  const settings = await openSettings(page, "Codex", remoteHostId);
  await expect(settings.getByRole("button", { name: "保存提供方", exact: true })).toBeEnabled();
  await settings.getByRole("button", { name: "中转站", exact: true }).click();
  await settings.getByLabel("中转站 API 密钥", { exact: true }).fill("unsaved-fixture-secret");
  await settings.getByRole("combobox", { name: "设置主机", exact: true }).selectOption("local");
  await expect(settings.getByRole("button", { name: "官方账户", exact: true })).toHaveAttribute("aria-pressed", "true");
  await settings.getByRole("button", { name: "中转站", exact: true }).click();
  await expect(settings.getByLabel("中转站 API 密钥", { exact: true })).toHaveValue("");
  expect(wire.calls.filter(call => call.path === "codex-settings/provider")).toHaveLength(0);
  expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await settings.screenshot({ path: ".data/settings-codex-mobile.png" });
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toBeVisible();
});

test("mobile official login exposes a usable device link, copy action and cancel button", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).copiedLoginCode = value; } } }); });
  const wire = await wireSettings(page, mock);
  await login(page);
  const settings = await openSettings(page, "Codex", remoteHostId);
  await settings.getByRole("button", { name: "登录 ChatGPT", exact: true }).click();
  await expect(settings.getByRole("link", { name: "打开登录页面", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "复制登录验证码", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedLoginCode)).toBe("ABCD-EFGH");
  await settings.screenshot({ path: ".data/settings-codex-device-mobile.png" });
  await settings.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(settings.getByText("ABCD-EFGH", { exact: true })).toHaveCount(0);
  expect(wire.calls.find(call => call.path === "codex-settings/login/cancel")).toMatchObject({ hostId: remoteHostId, body: { loginId: "fixture-login" } });
  expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("device login can still be cancelled when another client starts a task", async ({ page, mock }) => {
  const wire = await wireSettings(page, mock);
  await login(page);
  const settings = await openSettings(page, "Codex");
  await settings.getByRole("button", { name: "登录 ChatGPT", exact: true }).click();
  await expect(settings.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  mock.emit("turn/started", { threadId: "thread-existing", turn: { id: "another-client-turn", status: "inProgress", items: [] } });
  wire.codex.get("local").canChange = false;
  wire.codex.get("local").disabledReason = "任务运行中，完成后可切换账户";
  await settings.getByRole("button", { name: "检查登录状态", exact: true }).click();
  await expect(settings.getByText("任务运行中，完成后可切换账户", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(settings.getByText("ABCD-EFGH", { exact: true })).toHaveCount(0);
  expect(wire.calls.find(call => call.path === "codex-settings/login/cancel")).toMatchObject({ hostId: "local", body: { loginId: "fixture-login" } });
});

test("a provider override warning shows the actual effective provider without reporting a successful switch", async ({ page, mock }) => {
  await wireSettings(page, mock);
  await page.route("**/api/hosts/*/codex-settings/provider", route => route.fulfill({ json: codexInformation({
    provider: "official", hasApiKey: true,
    warning: "已保存用户配置，但当前项目配置仍指定官方提供方，请检查更高优先级配置。",
  }) }));
  await login(page);
  const settings = await openSettings(page, "Codex", remoteHostId);
  await expect(settings.getByRole("button", { name: "保存提供方", exact: true })).toBeEnabled();
  await settings.getByRole("button", { name: "中转站", exact: true }).click();
  await settings.getByLabel("中转站 URL", { exact: true }).fill("https://gateway.fixture.test/v1");
  await settings.getByLabel("中转站 API 密钥", { exact: true }).fill("fixture-secret-key");
  await settings.getByRole("button", { name: "保存提供方", exact: true }).click();
  await expect(settings.getByRole("alert")).toContainText("当前项目配置仍指定官方提供方");
  await expect(settings.getByRole("button", { name: "官方账户", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(settings.getByRole("status")).toHaveCount(0);
});
