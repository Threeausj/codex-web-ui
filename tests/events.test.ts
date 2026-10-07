import test from "node:test";
import assert from "node:assert/strict";
import {
  applyItemEvent,
  contextPercent,
  mergeSnapshotItems,
  upsertItem,
  type DisplayItem,
} from "../src/lib/events";
import { withinRoot, rewritePreviewAssets } from "../server/preview";

test("streamed response is replaced by authoritative completion, without duplicating its item", () => {
  const items: DisplayItem[] = [];
  applyItemEvent(items, "item/agentMessage/delta", {
    itemId: "a",
    turnId: "t",
    delta: "Hel",
  });
  applyItemEvent(items, "item/agentMessage/delta", {
    itemId: "a",
    turnId: "t",
    delta: "lo",
  });
  assert.equal(items[0].text, "Hello");
  applyItemEvent(items, "item/completed", {
    turnId: "t",
    item: {
      id: "a",
      type: "agentMessage",
      text: "Hello world",
      phase: "final_answer",
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "Hello world");
});
test("optimistic user message is reconciled using official clientId", () => {
  const items: DisplayItem[] = [
    { id: "optimistic", clientId: "client-message", type: "userMessage" },
  ];
  upsertItem(items, {
    id: "actual-id",
    clientId: "client-message",
    type: "userMessage",
    content: [],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "actual-id");
});
test("context pressure uses last request rather than cumulative billing tokens", () => {
  assert.equal(
    contextPercent({
      total: { totalTokens: 700000 },
      last: { totalTokens: 85000 },
      modelContextWindow: 100000,
    }),
    85,
  );
  assert.equal(
    contextPercent({ last: { totalTokens: 85000 }, modelContextWindow: null }),
    0,
  );
});
test("preview boundary rejects sibling-prefix paths and parent traversal", () => {
  assert.equal(withinRoot("/workspace/app", "/workspace/app/index.html"), true);
  assert.equal(
    withinRoot("/workspace/app", "/workspace/application/secrets"),
    false,
  );
  assert.equal(withinRoot("/workspace/app", "/workspace/app/../secret"), false);
});
test("preview root assets use its own capability path and external URLs stay intact", () => {
  const html =
    '<link href="/assets/site.css"><script src="/assets/app.js"></script><img src="//cdn.example.com/a.png">';
  assert.equal(
    rewritePreviewAssets(html, "/api/preview-files/ticket", ".html"),
    '<link href="/api/preview-files/ticket/assets/site.css"><script src="/api/preview-files/ticket/assets/app.js"></script><img src="//cdn.example.com/a.png">',
  );
});

test("history hydration preserves later completion and replaces optimistic aliases", () => {
  const merged = mergeSnapshotItems(
    [
      { id: "agent", type: "agentMessage", text: "Partial" },
      {
        id: "persisted",
        type: "userMessage",
        clientId: "message",
        content: [],
      },
    ],
    [
      { id: "agent", type: "agentMessage", text: "Completed answer" },
      {
        id: "optimistic",
        type: "userMessage",
        clientId: "message",
        status: "unconfirmed",
      },
      {
        id: "old-cache-only",
        type: "agentMessage",
        text: "Do not append old history out of order",
      },
    ],
    new Set(["agent"]),
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "Completed answer");
  assert.equal(merged[1].id, "persisted");
});

test("authoritative user messages clear temporary sending status", () => {
  const items: DisplayItem[] = [
    {
      id: "optimistic",
      clientId: "message",
      type: "userMessage",
      status: "sending",
    },
  ];
  upsertItem(items, {
    id: "persisted",
    clientId: "message",
    type: "userMessage",
    content: [],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, undefined);
});

test("browser state handles out-of-order RPCs and live events without reviving turns or changing selected chats", async (t) => {
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  };
  const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
  };
  install("localStorage", memoryStorage());
  install("sessionStorage", memoryStorage());
  install("location", { protocol: "http:", host: "localhost:8787" });
  install("document", { hidden: false, createElement: () => ({}) });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  type Request = { id: number; method: string; params: any };
  let sequence = 0;
  const thread = (id: string, status = "idle") => ({
    id,
    cwd: "/workspace/a",
    status: { type: status },
    preview: id,
  });
  const defaults = (request: Request): any => {
    switch (request.method) {
      case "thread/list":
        return { data: [thread("a"), thread("b")], nextCursor: null };
      case "thread/resume":
        return {
          thread: thread(request.params.threadId),
          model: "test",
          sandbox: { type: "workspaceWrite" },
        };
      case "thread/turns/list":
        return { data: [], nextCursor: null };
      case "config/read":
        return { config: { model: "test", sandbox_mode: "workspace-write" } };
      case "model/list":
        return { data: [{ id: "test", model: "test", isDefault: true }] };
      case "account/read":
        return { account: null };
      case "thread/start":
        return { thread: thread(`created-${++sequence}`) };
      case "turn/start":
        return {
          turn: {
            id: `turn-${++sequence}`,
            status: "completed",
            items: [
              {
                id: `user-${sequence}`,
                type: "userMessage",
                clientId: request.params.clientUserMessageId,
                content: request.params.input,
              },
            ],
          },
        };
      default:
        return {};
    }
  };
  let handle = defaults;
  let welcomeProcesses: any[] | undefined;
  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    requests: Request[] = [];
    constructor(readonly url: string) {
      FakeSocket.instances.push(this);
      queueMicrotask(() =>
        this.deliver({
          method: "bridge/status",
          params: {
            connected: true,
            mode: "spawn",
            pendingRequests: [],
            ...(welcomeProcesses ? { activeProcesses: welcomeProcesses } : {}),
          },
        }),
      );
    }
    deliver(message: any) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
    reply(request: Request, result: any) {
      this.deliver({ id: request.id, result });
    }
    send(data: string) {
      const request = JSON.parse(data) as Request;
      this.requests.push(request);
      if (!request.method) return;
      const result = handle(request);
      if (result !== undefined)
        queueMicrotask(() => this.reply(request, result));
    }
    close(code = 1000) {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code }));
    }
  }
  install("WebSocket", FakeSocket);
  let sessionActive = true;
  const fetchCalls: { url: string; options: RequestInit }[] = [];
  const fetchResponse = async (url: string, options: RequestInit = {}) => {
    fetchCalls.push({ url, options });
    const pathname = new URL(url, 'http://localhost:8787').pathname;
    const data = pathname.endsWith("/bootstrap")
      ? {
          hosts: [{ id: "local", name: "Local" }],
          projects: [],
          cwd: "/workspace/a",
          connectionMode: "spawn",
        }
      : {
          authenticated: sessionActive && !pathname.endsWith("/logout"),
          authRequired: true,
          csrfToken: "csrf",
        };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  install("fetch", fetchResponse);
  const { useCodex } = await import("../src/lib/useCodex");
  const api = useCodex();
  try {
    await api.login("fake-password");
    let ws = FakeSocket.instances.at(-1)!;
    await t.test(
      "completion before turn/start response never restores an already completed active turn",
      async () => {
        await api.selectThread("a");
        handle = (request) => {
          if (request.method !== "turn/start") return defaults(request);
          const turnId = `early-completion-${++sequence}`;
          ws.deliver({
            method: "turn/started",
            params: { threadId: "a", turn: { id: turnId } },
          });
          ws.deliver({
            method: "item/completed",
            params: {
              threadId: "a",
              turnId,
              item: {
                id: "answer",
                type: "agentMessage",
                text: "Completed answer",
              },
            },
          });
          ws.deliver({
            method: "turn/completed",
            params: {
              threadId: "a",
              turn: { id: turnId, status: "completed" },
            },
          });
          return {
            turn: {
              id: turnId,
              status: "inProgress",
              items: [
                {
                  id: "answer",
                  type: "agentMessage",
                  text: "Stale start snapshot",
                },
              ],
            },
          };
        };
        await api.send("Hello");
        assert.equal(api.state.busy, false);
        assert.equal(api.state.turns.at(-1)?.status, "completed");
        assert.equal(
          api.state.items.find((item) => item.id === "answer")?.text,
          "Completed answer",
        );
        const before = ws.requests.length;
        await api.interrupt();
        assert.equal(ws.requests.length, before);
        handle = defaults;
      },
    );
    await t.test(
      "history completion during resume is retained and an in-progress snapshot cannot revive it",
      async () => {
        await api.refreshThreads();
        let held!: Request;
        const recovering = {
          ...thread("recover", "active"),
          createdAt: 50,
          updatedAt: 100,
          recencyAt: 100,
        };
        api.state.threads.push(recovering);
        handle = (request) => {
          if (request.method === "thread/resume")
            return { thread: recovering, model: "test" };
          if (request.method === "thread/list")
            return {
              data: [{ ...recovering, recencyAt: 310 }, thread("a"), thread("b")],
              nextCursor: null,
            };
          if (request.method === "thread/turns/list") {
            held = request;
            return undefined;
          }
          return defaults(request);
        };
        const selection = api.selectThread("recover");
        await tick();
        ws.deliver({
          method: "item/completed",
          params: {
            threadId: "recover",
            turnId: "old-turn",
            item: {
              id: "recover-answer",
              type: "agentMessage",
              text: "Live final answer",
            },
          },
        });
        ws.deliver({
          method: "turn/completed",
          params: {
            threadId: "recover",
            turn: {
              id: "old-turn",
              status: "completed",
              startedAt: 300,
              completedAt: 310,
              durationMs: 10_000,
            },
          },
        });
        ws.reply(held, {
          data: [
            {
              id: "old-turn",
              status: "inProgress",
              items: [
                {
                  id: "recover-answer",
                  type: "agentMessage",
                  text: "Stale partial",
                },
              ],
            },
          ],
          nextCursor: null,
        });
        await selection;
        assert.equal(api.state.busy, false);
        assert.equal(api.state.items[0].text, "Live final answer");
        assert.equal(api.state.activeThread.recencyAt, 310);
        assert.equal(api.state.threads.find((item) => item.id === "recover")?.recencyAt, 310);
        assert.equal(api.state.turns[0].durationMs, 10_000);
        const before = ws.requests.length;
        await api.interrupt();
        assert.equal(ws.requests.length, before);
        handle = defaults;
      },
    );
    await t.test(
      "live content recency survives a delayed resume response and stale thread notification",
      async () => {
        let resumeRequest!: Request;
        const recovering = {
          ...thread("resume-race"),
          createdAt: 50,
          updatedAt: 100,
          recencyAt: 100,
        };
        api.state.threads.push(recovering);
        handle = (request) => {
          if (request.method === "thread/resume") {
            resumeRequest = request;
            return undefined;
          }
          if (request.method === "thread/list")
            return { data: [recovering], nextCursor: null };
          return defaults(request);
        };
        const selection = api.selectThread(recovering.id);
        await tick();
        ws.deliver({
          method: "turn/started",
          params: {
            threadId: recovering.id,
            turn: { id: "race-turn", status: "inProgress", startedAt: 300 },
          },
        });
        assert.equal(api.state.activeThread.recencyAt, 300);
        ws.deliver({ method: "thread/started", params: { thread: recovering } });
        assert.equal(api.state.activeThread.recencyAt, 300);
        ws.reply(resumeRequest, { thread: recovering, model: "test" });
        await selection;
        assert.equal(api.state.activeThread.recencyAt, 300);
        assert.equal(api.state.threads.find((item) => item.id === recovering.id)?.recencyAt, 300);
        handle = defaults;
      },
    );
    await t.test(
      "sending during thread creation preserves a newer selection and sends to the original thread",
      async () => {
        api.newThread();
        let held!: Request;
        handle = (request) => {
          if (request.method === "thread/start") {
            held = request;
            return undefined;
          }
          return defaults(request);
        };
        const sending = api.send("Background message");
        await tick();
        await api.selectThread("b");
        ws.reply(held, { thread: thread("background-created") });
        await sending;
        assert.equal(api.state.activeThread.id, "b");
        assert.equal(api.state.items.length, 0);
        const turn = ws.requests
          .filter((request) => request.method === "turn/start")
          .at(-1)!;
        assert.equal(turn.params.threadId, "background-created");
        assert.equal(turn.params.cwd, "/workspace/a");
        handle = defaults;
      },
    );
    await t.test(
      "thread selection blocks sends until its project and global permission are hydrated",
      async () => {
        let held!: Request;
        handle = (request) =>
          request.method === "thread/resume"
            ? ((held = request), undefined)
            : defaults(request);
        const loading = api.selectThread("other-project");
        await tick();
        assert.equal(api.state.selectingThread, true);
        const before = ws.requests.filter(
          (request) => request.method === "turn/start",
        ).length;
        await assert.rejects(
          () => api.send("Do not send with the previous cwd"),
          /正在加载会话/,
        );
        assert.equal(
          ws.requests.filter((request) => request.method === "turn/start")
            .length,
          before,
        );
        ws.reply(held, {
          thread: { ...thread("other-project"), cwd: "/workspace/other" },
          model: "test",
          sandbox: { type: "readOnly", networkAccess: true },
          approvalPolicy: "untrusted",
        });
        await loading;
        assert.equal(api.state.selectingThread, false);
        await api.send("Use the selected thread policy");
        assert.equal(
          ws.requests
            .filter((request) => request.method === "turn/start")
            .at(-1)!.params.cwd,
          "/workspace/other",
        );
        assert.equal(
          ws.requests
            .filter((request) => request.method === "turn/start")
            .at(-1)!.params.approvalPolicy,
          "on-request",
        );
        assert.equal(
          ws.requests
            .filter((request) => request.method === "turn/start")
            .at(-1)!.params.sandboxPolicy.networkAccess,
          false,
        );
        handle = defaults;
        await api.setProject("/workspace/a");
      },
    );
    await t.test(
      "resuming full access applies the global workspace policy instead of restoring full access",
      async () => {
        handle = (request) =>
          request.method === "thread/resume"
            ? {
                thread: thread("strict-full"),
                model: "test",
                sandbox: { type: "dangerFullAccess" },
                approvalPolicy: "untrusted",
              }
            : defaults(request);
        await api.selectThread("strict-full");
        await api.send("Use the global workspace policy");
        assert.equal(
          ws.requests
            .filter((request) => request.method === "turn/start")
            .at(-1)!.params.approvalPolicy,
          "on-request",
        );
        assert.equal(ws.requests.filter((request) => request.method === "turn/start").at(-1)!.params.sandboxPolicy.type, "workspaceWrite");
        await api.selectThread("strict-full");
        await api.send("Use the global policy after reconnect hydration");
        assert.equal(
          ws.requests
            .filter((request) => request.method === "turn/start")
            .at(-1)!.params.approvalPolicy,
          "on-request",
        );
        assert.equal(ws.requests.filter((request) => request.method === "turn/start").at(-1)!.params.sandboxPolicy.type, "workspaceWrite");
        handle = defaults;
        await api.setProject("/workspace/a");
      },
    );
    await t.test(
      "desktop archive notifications clear the selected chat immediately",
      async () => {
        await api.selectThread("a");
        ws.deliver({ method: "thread/archived", params: { threadId: "a" } });
        assert.equal(api.state.activeThread, null);
        assert.equal(api.state.busy, false);
        assert.ok(!api.state.threads.some((thread) => thread.id === "a"));
      },
    );
    await t.test(
      "concurrent thread refreshes keep the latest host-wide list across project selection",
      async () => {
        const requests: Request[] = [];
        handle = (request) => {
          if (request.method === "thread/list") {
            requests.push(request);
            return undefined;
          }
          return defaults(request);
        };
        const first = api.refreshThreads();
        const second = api.refreshThreads();
        ws.reply(requests[1], { data: [thread("new-list")], nextCursor: null });
        await second;
        ws.reply(requests[0], { data: [thread("old-list")], nextCursor: null });
        await first;
        assert.equal(api.state.threads[0].id, "new-list");
        const previousProject = api.refreshThreads();
        api.state.projectPath = "/workspace/other";
        ws.reply(requests[2], {
          data: [
            {
              ...thread("host-wide-history"),
              cwd: "/workspace/another-project",
            },
          ],
          nextCursor: null,
        });
        await previousProject;
        assert.equal(requests[2].params.cwd, undefined);
        assert.equal(api.state.threads[0].id, "host-wide-history");
        assert.equal(api.state.projectPath, "/workspace/other");
        api.state.projectPath = "/workspace/a";
        handle = defaults;
      },
    );
    await t.test(
      "periodic first-page refresh preserves loaded pages and their next cursor",
      async () => {
        handle = (request) => {
          if (request.method !== "thread/list") return defaults(request);
          if (request.params.cursor === "page-2")
            return { data: [thread("third")], nextCursor: "page-3" };
          if (request.params.cursor === "page-3")
            return { data: [thread("fourth")], nextCursor: null };
          return {
            data: [thread("first"), thread("second")],
            nextCursor: "page-2",
          };
        };
        await api.refreshThreads();
        await api.loadMoreThreads();
        await api.refreshThreads();
        assert.deepEqual(
          api.state.threads.map((item) => item.id),
          ["first", "second", "third"],
        );
        await api.loadMoreThreads();
        assert.equal(
          ws.requests
            .filter((request) => request.method === "thread/list")
            .at(-1)!.params.cursor,
          "page-3",
        );
        assert.equal(api.state.moreThreads, false);
        handle = defaults;
      },
    );
    await t.test(
      "previous-project config results cannot overwrite a newer configuration",
      async () => {
        const held: Request[] = [];
        handle = (request) => {
          held.push(request);
          return undefined;
        };
        const first = api.readConfig();
        api.state.projectPath = "/workspace/new-config";
        handle = (request) =>
          request.method === "config/read"
            ? { config: { model: "new-config" } }
            : request.method === "model/list"
              ? { data: [{ id: "new-model", model: "new-model" }] }
              : defaults(request);
        await api.readConfig();
        for (const request of held)
          ws.reply(
            request,
            request.method === "config/read"
              ? { config: { model: "old-config" } }
              : request.method === "model/list"
                ? { data: [{ id: "old-model", model: "old-model" }] }
                : defaults(request),
          );
        await first;
        assert.equal(api.state.config.config.model, "new-config");
        assert.ok(
          !api.state.models.some((model) => model.model === "old-model"),
        );
        api.state.projectPath = "/workspace/a";
        handle = defaults;
      },
    );
    await t.test(
      "optional rate-limit and integration failures do not become global conversation errors",
      async () => {
        api.state.error = "";
        handle = (request) => {
          if (
            request.method === "account/rateLimits/read" ||
            request.method === "app/list"
          ) {
            ws.deliver({
              id: request.id,
              error: {
                code: -32000,
                message: "ChatGPT authentication required",
              },
            });
            return undefined;
          }
          if (
            request.method === "skills/list" ||
            request.method === "mcpServerStatus/list"
          )
            return { data: [] };
          return defaults(request);
        };
        await api.readConfig();
        assert.equal(api.state.error, "");
        await api.loadIntegrations();
        assert.equal(api.state.error, "");
        assert.deepEqual(api.state.integrationErrors, [
          { source: "apps", message: "ChatGPT authentication required" },
        ]);
        handle = defaults;
      },
    );
    await t.test(
      "timed-out sends are reconciled by clientId and are never automatically retried",
      async () => {
        await api.selectThread("timeout-thread");
        let held!: Request;
        handle = (request) => {
          if (request.method === "turn/start") {
            held = request;
            return undefined;
          }
          if (request.method === "thread/turns/list" && held)
            return {
              data: [
                {
                  id: "accepted-turn",
                  status: "completed",
                  items: [
                    {
                      id: "accepted-user",
                      type: "userMessage",
                      clientId: held.params.clientUserMessageId,
                      content: held.params.input,
                    },
                  ],
                },
              ],
              nextCursor: null,
            };
          return defaults(request);
        };
        const originalTimeout = globalThis.setTimeout;
        globalThis.setTimeout = ((
          callback: (...args: any[]) => void,
          delay?: number,
          ...args: any[]
        ) =>
          originalTimeout(
            callback,
            delay === 45000 ? 5 : delay,
            ...args,
          )) as typeof setTimeout;
        const before = ws.requests.filter(
          (request) => request.method === "turn/start",
        ).length;
        try {
          await assert.rejects(api.send("Possibly accepted"), /请求超时/);
        } finally {
          globalThis.setTimeout = originalTimeout;
        }
        await tick();
        assert.equal(
          ws.requests.filter((request) => request.method === "turn/start")
            .length,
          before + 1,
        );
        assert.equal(
          api.state.items.filter((item) => item.type === "userMessage").length,
          1,
        );
        assert.equal(
          api.state.items.find((item) => item.type === "userMessage")?.id,
          "accepted-user",
        );
        ws.reply(held, {
          turn: { id: "accepted-turn", status: "inProgress", items: [] },
        });
        await tick();
        assert.equal(api.state.busy, false);
        handle = defaults;
      },
    );
    await t.test(
      "terminal reconnect restores process and output, and completion works without the original RPC",
      async () => {
        let command!: Request;
        handle = (request) => {
          if (request.method === "command/exec") {
            command = request;
            return undefined;
          }
          return defaults(request);
        };
        const job = api.startTerminal();
        const outcome = job.catch((error) => error);
        await tick();
        const processId = command.params.processId;
        assert.ok(
          (
            JSON.parse(
              sessionStorage.getItem("codex.terminalProcessIds")!,
            ) as Record<string, string>
          ).local === processId,
        );
        // Earlier bridge versions omit activeProcesses: they must not stop a running terminal.
        ws.deliver({
          method: "bridge/status",
          params: { connected: true, pendingRequests: [] },
        });
        assert.equal(api.state.terminalRunning, true);
        welcomeProcesses = [
          { processId, tty: true, lastOutput: "Restored prompt> " },
        ];
        const originalTimeout = globalThis.setTimeout;
        globalThis.setTimeout = ((
          callback: (...args: any[]) => void,
          delay?: number,
          ...args: any[]
        ) =>
          originalTimeout(
            callback,
            delay === 2500 ? 1 : delay,
            ...args,
          )) as typeof setTimeout;
        try {
          ws.close(1006);
          await new Promise<void>((resolve) => originalTimeout(resolve, 15));
        } finally {
          globalThis.setTimeout = originalTimeout;
        }
        await outcome;
        ws = FakeSocket.instances.at(-1)!;
        assert.equal(api.state.connected, true);
        assert.equal(api.state.terminalRunning, true);
        assert.equal(api.state.terminalProcessId, processId);
        assert.equal(api.state.terminalOutput, "Restored prompt> ");
        await api.writeTerminal("help\n");
        assert.equal(ws.requests.at(-1)!.params.processId, processId);
        ws.deliver({
          method: "bridge/terminal/completed",
          params: {
            processId,
            result: { exitCode: 0, stdout: "", stderr: "" },
          },
        });
        ws.deliver({
          method: "bridge/status",
          params: { connected: true, pendingRequests: [], activeProcesses: [] },
        });
        assert.equal(api.state.terminalRunning, false);
        assert.match(api.state.terminalOutput, /进程退出 0/);
        assert.equal(
          (api.state.terminalOutput.match(/进程退出 0/g) || []).length,
          1,
        );
        welcomeProcesses = undefined;
        handle = defaults;
      },
    );
    await t.test('releasing a Web runtime clears stale approval, choice, conflict and terminal state before the disconnect finishes', async () => {
      handle = request => {
        if (request.method === 'thread/resume') {
          ws.deliver({ id: request.id, error: { code: -32000, message: `thread ${request.params.threadId} already has an active writer` } });
          return undefined;
        }
        return defaults(request);
      };
      await api.selectThread('a');
      assert.ok(api.state.threadConflict);
      const approvals = [
        { id: 7001, method: 'item/commandExecution/requestApproval', params: { threadId: 'a' } },
        { id: 7002, method: 'item/tool/requestUserInput', params: { threadId: 'a', questions: [] } },
      ];
      for (const request of approvals) ws.deliver(request);
      assert.equal(api.state.pendingRequests.length, 2);
      api.state.terminalProcessId = 'web-pty-release-fixture';
      const inventory = [{ processId: api.state.terminalProcessId, tty: true, lastOutput: '' }];
      ws.deliver({ method: 'bridge/status', params: { connected: true, paused: false, activeProcesses: inventory, pendingRequests: approvals } });
      assert.equal(api.state.terminalRunning, true);
      const before = ws.requests.length;
      // The first pause status is sent before the subprocess is reaped. Its old
      // inventory must not re-add controls for requests that are being cancelled.
      ws.deliver({ method: 'bridge/status', params: { connected: true, paused: true, pendingRequests: approvals, activeProcesses: inventory } });
      assert.equal(api.state.connected, false);
      assert.equal(api.state.runtimePaused, true);
      assert.equal(api.state.threadReady, false);
      assert.equal(api.state.activeThread.id, 'a');
      assert.equal(api.state.pendingRequests.length, 0);
      assert.equal(api.state.threadConflict, null);
      assert.equal(api.state.terminalRunning, false);
      assert.equal(api.state.terminalProcesses.length, 0);
      await api.resumeConnection();
      await assert.rejects(api.send('暂停后不能提交'), /已释放/);
      assert.equal(ws.requests.length, before);
      handle = defaults;
      ws.deliver({ method: 'bridge/status', params: { connected: true, paused: false, pendingRequests: [], activeProcesses: [] } });
      await api.selectThread('a');
      assert.equal(api.state.threadReady, true);
    });
    await t.test('private GETs use distinct cache keys and preserve existing query parameters', async () => {
      const before = fetchCalls.length;
      await api.http('/preferences?source=history');
      await api.http('/preferences?source=history');
      const reads = fetchCalls.slice(before);
      assert.equal(reads.length, 2);
      const urls = reads.map(call => new URL(call.url, 'http://localhost:8787'));
      assert.ok(urls.every(url => url.pathname === '/api/preferences' && url.searchParams.get('source') === 'history'));
      assert.ok(urls.every(url => !!url.searchParams.get('_request')));
      assert.notEqual(urls[0].searchParams.get('_request'), urls[1].searchParams.get('_request'));
      assert.ok(reads.every(call => call.options.cache === 'no-store' && call.options.credentials === 'same-origin'));
      assert.ok(urls.every(url => !url.searchParams.has('csrfToken')));
    });
    await t.test('a delayed unauthorized push response cannot overwrite a newer login', async () => {
      let release!: (response: Response) => void;
      const held = new Promise<Response>(resolve => { release = resolve; });
      install('fetch', (url: string, options?: RequestInit) => url === '/api/push/test' ? held : fetchResponse(url, options));
      try {
        const request = api.http('/push/test', { method: 'POST', body: '{}' }, false).catch(error => error);
        await api.login('fake-password');
        ws = FakeSocket.instances.at(-1)!;
        release(new Response(JSON.stringify({ error: 'Old session expired' }), { status: 401 }));
        assert.equal((await request).status, 401);
        assert.equal(api.state.authenticated, true);
        assert.equal(api.state.connected, true);
        assert.doesNotMatch(api.state.error, /登录已过期/);
      } finally { install('fetch', fetchResponse); }
    });
    await t.test('an unauthorized push request checks the current cookie without treating network errors as logout', async () => {
      let checks = 0;
      let unavailable = false;
      install('fetch', (url: string, options?: RequestInit) => {
        const pathname = new URL(url, 'http://localhost:8787').pathname;
        if (pathname === '/api/push/test') return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized push request' }), { status: 401 }));
        if (pathname === '/api/auth/session') {
          checks++;
          if (unavailable) return Promise.reject(new TypeError('Temporary network error'));
        }
        return fetchResponse(url, options);
      });
      try {
        for (unavailable of [false, true]) {
          await assert.rejects(api.http('/push/test', { method: 'POST', body: '{}' }, false), (error: any) => error.status === 401);
          assert.equal(api.state.authenticated, true);
          assert.equal(api.state.connected, true);
        }
        assert.equal(checks, 2);
      } finally { install('fetch', fetchResponse); }
    });
    await t.test('a stale session check cannot clear a login established while it was waiting', async () => {
      let release!: (response: Response) => void;
      const held = new Promise<Response>(resolve => { release = resolve; });
      let checked = false;
      install('fetch', (url: string, options?: RequestInit) => {
        const pathname = new URL(url, 'http://localhost:8787').pathname;
        if (pathname === '/api/push/test') return Promise.resolve(new Response('{}', { status: 401 }));
        if (pathname === '/api/auth/session') { checked = true; return held; }
        return fetchResponse(url, options);
      });
      try {
        const request = api.http('/push/test', { method: 'POST', body: '{}' }, false).catch(error => error);
        await tick();
        assert.equal(checked, true);
        await api.login('fake-password');
        ws = FakeSocket.instances.at(-1)!;
        release(new Response(JSON.stringify({ authenticated: false, authRequired: true })));
        assert.equal((await request).status, 401);
        assert.equal(api.state.authenticated, true);
        assert.equal(api.state.connected, true);
      } finally { install('fetch', fetchResponse); }
    });
    await t.test(
      "expired sessions stop reconnect attempts and return to login",
      async () => {
        sessionActive = false;
        const originalTimeout = globalThis.setTimeout;
        globalThis.setTimeout = ((
          callback: (...args: any[]) => void,
          delay?: number,
          ...args: any[]
        ) =>
          originalTimeout(
            callback,
            delay === 2500 ? 1 : delay,
            ...args,
          )) as typeof setTimeout;
        const count = FakeSocket.instances.length;
        try {
          ws.close(1006);
          await new Promise<void>((resolve) => originalTimeout(resolve, 10));
        } finally {
          globalThis.setTimeout = originalTimeout;
        }
        assert.equal(api.state.authenticated, false);
        assert.match(api.state.error, /登录已过期/);
        assert.equal(FakeSocket.instances.length, count);
        sessionActive = true;
      },
    );
  } finally {
    handle = defaults;
    await api.logout();
    for (const [key, descriptor] of savedGlobals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
