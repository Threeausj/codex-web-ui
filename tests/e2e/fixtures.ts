import { createHash } from "node:crypto";
import { asyncUserInputQuestions } from '../../shared/async-user-input';
import { asyncQuestionReplyText } from '../../shared/async-question-reply';
import { asyncQuestionAnswered } from '../../shared/async-question-reply';
import {
  test as base,
  expect,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";

type Rpc = {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};
const workspace = "/workspace/demo";
const models = ["mock-model-a", "mock-model-b"].map((model, index) => ({
  id: model,
  model,
  displayName: `Test Model ${index ? "B" : "A"}`,
  hidden: false,
  isDefault: index === 0,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Medium" },
    { reasoningEffort: "high", description: "High" },
  ],
}));
const makeThread = (id: string, name = "测试会话") => ({
  id,
  name,
  preview: name,
  cwd: workspace,
  modelProvider: "openai",
  createdAt: 1791200000,
  updatedAt: 1791200000,
  status: { type: "idle" },
  source: "cli",
  historyMode: "paginated",
  path: `/test/sessions/${id}.jsonl`,
  turns: [],
});
const makeTurn = (id: string, items: any[] = [], status = "completed") => ({
  id,
  items,
  itemsView: "full",
  status,
  error: null,
  startedAt: 1791200000,
  completedAt: status === "completed" ? 1791200001 : null,
  durationMs: 1000,
});

/** Wire fixtures only. Product code always uses a real app-server connection. */
export class MockCodex {
  unresponsiveSockets = new Set<WebSocketRoute>();
  hosts: any[] = [{ id: "local", name: "本机", kind: "local" }];
  hostMocks = new Map<string, MockCodex>();
  requests: Rpc[] = [];
  responses: Rpc[] = [];
  asyncAnswers: { hostId: string; threadId: string; itemId: string; body: any }[] = [];
  failAsyncAnswerNext = false;
  asyncStatusRequests: { hostId: string; threadId: string; itemId: string; turnId: string | null }[] = [];
  asyncStatusOverride: boolean | null = null;
  uploads: { body: Buffer; contentType: string }[] = [];
  sockets: WebSocketRoute[] = [];
  authenticated = false;
  requireApprovalNext = false;
  holdFinalMessage = false;
  holdTurnStartResponse = false;
  holdConfigReadResponse = false;
  failRevertNext = false;
  failTurnStartNext = false;
  failHistoryNext = false;
  holdRevertResponse = false;
  private heldRevertResponse?: () => void;
  private heldConfigReadResponse?: () => void;
  private heldTurnStartResponse?: () => void;
  contextTokens = 200;
  preferences: any = {
    pins: [],
    collapsed: {},
    permissionProfiles: [],
    activePermissionProfileId: "",
  };
  projects: any[] = [
    {
      id: "demo",
      name: "Demo Project",
      path: workspace,
      hostId: "local",
      source: "desktop",
    },
  ];
  archivedThreads: any[] = [];
  runtimeReleasedThreads: { hostId: string; threadId: string }[] = [];
  requirements: any = null;
  config: Record<string, unknown> = {
    model: "mock-model-a",
    sandbox_mode: "workspace-write",
    model_reasoning_effort: "medium",
  };
  threads = [makeThread("thread-existing", "已有测试历史")];
  turns = new Map<string, any[]>([
    [
      "thread-existing",
      [
        makeTurn("turn-history", [
          {
            id: "history-user",
            type: "userMessage",
            content: [
              { type: "text", text: "已有测试问题", text_elements: [] },
            ],
          },
          { id: "history-agent", type: "agentMessage", text: "历史保持可读" },
        ]),
      ],
    ],
  ]);
  private activeApproval?: { id: string; threadId: string; turn: any };
  private activeProcess?: {
    request: Rpc;
    socket: WebSocketRoute;
    processId: string;
  };
  private finishMessage?: () => void;
  private count = 0;

  async install(page: Page) {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, json: body });
      const asyncStatusRoute = /^\/api\/threads\/([^/]+)\/([^/]+)\/async-questions\/([^/]+)\/status$/.exec(url.pathname);
      if (asyncStatusRoute) {
        const [, encodedHost, encodedThread, encodedItem] = asyncStatusRoute;
        const hostId = decodeURIComponent(encodedHost!), threadId = decodeURIComponent(encodedThread!), itemId = decodeURIComponent(encodedItem!);
        const target = hostId === 'local' ? this : this.hostMocks.get(hostId);
        if (!target) return respond({ error: 'Host not found' }, 404);
        target.asyncStatusRequests.push({ hostId, threadId, itemId, turnId: url.searchParams.get('turnId') });
        const items = (target.turns.get(threadId) || []).flatMap(turn => turn.items);
        const item = items.find(item => item.id === itemId);
        return respond({ answered: target.asyncStatusOverride ?? asyncQuestionAnswered(item, items) });
      }
      const asyncAnswerRoute = /^\/api\/threads\/([^/]+)\/([^/]+)\/async-questions\/([^/]+)\/answer$/.exec(url.pathname);
      if (asyncAnswerRoute) {
        const [, encodedHost, encodedThread, encodedItem] = asyncAnswerRoute;
        const hostId = decodeURIComponent(encodedHost!), threadId = decodeURIComponent(encodedThread!), itemId = decodeURIComponent(encodedItem!);
        const target = hostId === 'local' ? this : this.hostMocks.get(hostId);
        if (!target) return respond({ error: 'Host not found' }, 404);
        const body = request.postDataJSON();
        target.asyncAnswers.push({ hostId, threadId, itemId, body });
        if (target.failAsyncAnswerNext) {
          target.failAsyncAnswerNext = false;
          return respond({ error: '模拟回答被拒绝，请重试' }, 422);
        }
        const turns = target.turns.get(threadId) || [];
        const item = turns.flatMap(turn => turn.items).find(item => item.id === itemId);
        const questions = asyncUserInputQuestions(item);
        if (!questions.length || body.answers?.length !== questions.length) return respond({ error: 'Question not found' }, 404);
        const input = [{ type: 'text', text: asyncQuestionReplyText(item, body.answers), text_elements: [] }];
        const clientUserMessageId = `async-answer-${++target.count}`;
        const active = turns.findLast(turn => turn.status === 'inProgress');
        const method = active ? 'turn/steer' : 'turn/start';
        const params = { threadId, input, clientUserMessageId, ...(active ? { expectedTurnId: active.id } : {}) };
        return new Promise<void>(resolve => {
          const sink = { send(raw: string) {
            const message = JSON.parse(raw);
            if (message.error) { void respond({ error: message.error.message }, 422).then(resolve); return; }
            target.emit('bridge/thread/changed', { threadId, method, result: message.result, request: { input, clientUserMessageId }, changeId: `async-change-${clientUserMessageId}` });
            void respond({ accepted: true, input, clientUserMessageId, ...message.result }).then(resolve);
          } } as unknown as WebSocketRoute;
          target.receive(sink, { id: `native-${clientUserMessageId}`, method, params });
        });
      }
      const fileRoute = /^\/api\/hosts\/([^/]+)\/files$/.exec(url.pathname);
      if (fileRoute) {
        const hostId = decodeURIComponent(fileRoute[1]!);
        const target = hostId === "local" ? this : this.hostMocks.get(hostId);
        if (!target) return respond({ error: "Host not found" }, 404);
        const native = (method: string, params: any) => new Promise<any>((resolve, reject) => {
          const sink = { send(raw: string) {
            const message = JSON.parse(raw);
            if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
          } } as unknown as WebSocketRoute;
          target.receive(sink, { id: `files-${this.count++}`, method, params });
        });
        const version = (dataBase64: string) => createHash("sha256").update(Buffer.from(dataBase64, "base64")).digest("hex");
        try {
          if (request.method() === "GET") {
            const result = await native("fs/readFile", { path: url.searchParams.get("path") });
            return respond({ ...result, version: version(result.dataBase64) });
          }
          const form = await new Request(request.url(), { method: "POST", headers: request.headers(), body: request.postDataBuffer()! }).formData();
          const path = String(form.get("path"));
          const original = await native("fs/readFile", { path });
          if (version(original.dataBase64) !== form.get("expectedVersion")) return respond({ code: "FILE_CONFLICT", error: "文件已被其他程序修改；你的草稿已保留，请先比较或重新载入。" }, 409);
          const file = form.get("file") as File;
          const dataBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
          await native("fs/writeFile", { path, dataBase64 });
          return respond({ version: version(dataBase64) });
        } catch (cause: any) { return respond({ error: cause.message }, 502); }
      }
      if (url.pathname.startsWith("/api/navigation/")) {
        const hostId = decodeURIComponent(
          url.pathname.slice("/api/navigation/".length),
        );
        const target = hostId === "local" ? this : this.hostMocks.get(hostId);
        if (!target) return respond({ error: "Host not found" }, 404);
        const rpc = {
          ...request.postDataJSON(),
          id: `navigation-${this.count++}`,
        };
        return new Promise<void>((resolve) => {
          const sink = {
            send: (raw: string) => {
              const message = JSON.parse(raw);
              void respond(
                message.error
                  ? { error: message.error.message }
                  : message.result,
                message.error ? 502 : 200,
              ).then(resolve);
            },
          } as unknown as WebSocketRoute;
          target.receive(sink, rpc);
        });
      }
      switch (url.pathname) {
        case "/api/auth/session":
          return respond({
            authenticated: this.authenticated,
            authRequired: true,
            csrfToken: "mock-csrf",
          });
        case "/api/auth/login":
          if (request.postDataJSON()?.password !== "test-password-123")
            return respond({ error: "Incorrect password" }, 401);
          this.authenticated = true;
          return respond({
            authenticated: true,
            csrfToken: "mock-csrf",
            expiresAt: Date.now() + 28_800_000,
          });
        case "/api/auth/logout":
          this.authenticated = false;
          return respond({ authenticated: false });
        case "/api/bootstrap":
          return respond({
            hosts: this.hosts,
            runtimeReleasedThreads: this.runtimeReleasedThreads,
            projects: this.projects,
            preferences: this.preferences,
            cwd: workspace,
            codexHome: "/test/.codex",
            connectionMode: "spawn",
          });
        case "/api/preferences":
          if (request.method() === "PATCH") {
            const patch = request.postDataJSON();
            this.preferences = {
              ...this.preferences,
              ...patch,
              collapsed: { ...this.preferences.collapsed, ...patch.collapsed },
            };
          }
          return respond({ preferences: this.preferences });
        case "/api/projects": {
          if (request.method() === "POST") {
            const fields = request.postDataJSON();
            const project = {
              ...fields,
              id: `project-${this.count++}`,
              source: "web",
            };
            this.projects = [
              ...this.projects.filter(
                (project) =>
                  project.path !== fields.path ||
                  project.hostId !== fields.hostId,
              ),
              project,
            ];
            return respond({ project }, 201);
          }
          return respond({ projects: this.projects });
        }
        case "/api/uploads": {
          this.uploads.push({
            body: request.postDataBuffer()!,
            contentType: request.headers()["content-type"] || "",
          });
          return respond(
            {
              files: [
                {
                  name: "sample.png",
                  path: "/test/uploads/sample.png",
                  mime: "image/png",
                  size: 68,
                },
                {
                  name: "notes.txt",
                  path: "/test/uploads/notes.txt",
                  mime: "text/plain",
                  size: 5,
                },
              ],
            },
            201,
          );
        }
        case "/api/preview":
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><p id="status">pending</p><script>try{parent.document.body.dataset.previewEscape="escaped";document.getElementById("status").textContent="escaped"}catch{document.getElementById("status").textContent="isolated"}</script>',
          });
        default:
          return respond(
            { error: `Unimplemented test HTTP route: ${url.pathname}` },
            404,
          );
      }
    });
    await page.routeWebSocket(/\/api\/rpc(?:\?|$)/, (socket) => {
      const hostId = new URL(socket.url()).searchParams.get("host") || "local";
      const target =
        hostId === "local" ? this : (this.hostMocks.get(hostId) ?? this);
      target.sockets.push(socket);
      socket.onMessage((raw) =>
        target.receive(socket, JSON.parse(raw.toString())),
      );
      socket.send(
        JSON.stringify({
          method: "bridge/status",
          params: {
            connected: true,
            releasedThreadIds: this.runtimeReleasedThreads.map(entry => entry.threadId),
            hostId,
            mode: "spawn",
            pendingRequests: [],
            clientId: "fixture-client",
          },
        }),
      );
    });
  }

  emit(method: string, params: unknown) {
    for (const socket of this.sockets)
      socket.send(JSON.stringify({ method, params }));
  }
  private reply(socket: WebSocketRoute, request: Rpc, result: unknown) {
    socket.send(JSON.stringify({ id: request.id, result }));
  }
  private receive(socket: WebSocketRoute, request: Rpc) {
    if (!request.method) {
      this.responses.push(request);
      if (this.activeApproval?.id === request.id) {
        const { threadId, turn } = this.activeApproval;
        this.emit("serverRequest/resolved", { requestId: request.id });
        this.activeApproval = undefined;
        this.complete(
          threadId,
          turn,
          request.result?.decision?.startsWith("accept")
            ? "审批后继续工作"
            : "操作已拒绝",
        );
      }
      return;
    }
    this.requests.push(request);
    if (this.unresponsiveSockets.has(socket)) return;
    const p = request.params || {};
    switch (request.method) {
      case "thread/loaded/list":
        return this.reply(socket, request, { data: ["thread-existing"], nextCursor: null });
      case "thread/list":
      case "thread/search": {
        const candidates = p.archived ? this.archivedThreads : this.threads;
        const roots = Array.isArray(p.cwd) ? p.cwd : p.cwd ? [p.cwd] : null;
        const query = p.searchTerm?.toLowerCase() || "";
        return this.reply(socket, request, {
          data: candidates.filter(
            (thread) =>
              (!roots || roots.includes(thread.cwd)) &&
              (!query ||
                `${thread.name} ${thread.preview} ${request.method === "thread/search" ? JSON.stringify(this.turns.get(thread.id)) : ""}`
                  .toLowerCase()
                  .includes(query)),
          ),
          nextCursor: null,
        });
      }
      case "thread/read":
        return this.reply(socket, request, {
          thread:
            [...this.threads, ...this.archivedThreads].find(
              (thread) => thread.id === p.threadId,
            ) || makeThread(p.threadId),
        });
      case "thread/unarchive": {
        const thread = this.archivedThreads.find(
          (thread) => thread.id === p.threadId,
        );
        this.archivedThreads = this.archivedThreads.filter(
          (thread) => thread.id !== p.threadId,
        );
        if (thread) this.threads.unshift(thread);
        return this.reply(socket, request, { thread });
      }
      case "configRequirements/read":
        return this.reply(socket, request, { requirements: this.requirements });
      case "permissionProfile/list":
        return this.reply(socket, request, { data: [], nextCursor: null });
      case "modelProvider/capabilities/read":
        return this.reply(socket, request, { providerId: "openai" });
      case "config/read": {
        const reply = () =>
          this.reply(socket, request, {
            config: this.config,
            origins: {},
            layers: [],
          });
        if (this.holdConfigReadResponse) this.heldConfigReadResponse = reply;
        else reply();
        return;
      }
      case "model/list":
        return this.reply(socket, request, { data: models, nextCursor: null });
      case "account/read":
        return this.reply(socket, request, {
          account: {
            type: "chatgpt",
            email: "test@example.invalid",
            planType: "plus",
          },
          requiresOpenaiAuth: true,
        });
      case "account/rateLimits/read":
        return this.reply(socket, request, { rateLimits: null });
      case "skills/list":
        return this.reply(socket, request, {
          data: [{ cwd: workspace, skills: [] }],
          errors: [],
        });
      case "app/list":
      case "mcpServerStatus/list":
        return this.reply(socket, request, { data: [], nextCursor: null });
      case "thread/start": {
        const thread = {
          ...makeThread(`thread-${++this.count}`, "新的测试对话"),
          cwd: p.cwd || workspace,
        };
        this.threads.unshift(thread);
        this.turns.set(thread.id, []);
        this.emit("thread/started", { thread });
        return this.reply(socket, request, {
          thread,
          model: p.model || models[0].model,
        });
      }
      case "thread/resume":
        return this.reply(socket, request, {
          thread: this.threads.find((t) => t.id === p.threadId),
          model: this.config.model,
          reasoningEffort: "medium",
          sandbox: { type: "workspaceWrite" },
        });
      case "thread/turns/list":
        if (this.failHistoryNext) {
          this.failHistoryNext = false;
          return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "Test history read failed" } }));
        }
        return this.reply(socket, request, {
          data: [...(this.turns.get(p.threadId) || [])].reverse(),
          nextCursor: null,
        });
      case "thread/revert": {
        if (this.failRevertNext) {
          this.failRevertNext = false;
          return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "Test revert failed" } }));
        }
        const revert = () => {
          const turns = this.turns.get(p.threadId) || [];
          const index = turns.findIndex((turn) => turn.id === p.beforeTurnId);
          if (index < 0)
            return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "Revert turn not found" } }));
          this.turns.set(p.threadId, turns.slice(0, index));
          const thread = { ...this.threads.find((thread) => thread.id === p.threadId), turns: [] };
          const result = { thread, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
          this.reply(socket, request, result);
          // Codex also emits a canonical notification after acknowledging the
          // request. An editor must not let it revive the removed answer.
          setTimeout(() => this.emit("thread/reverted", { threadId: p.threadId }), 0);
        };
        if (this.holdRevertResponse) this.heldRevertResponse = revert;
        else revert();
        return;
      }
      case "thread/fork": {
        const thread = makeThread(`fork-${++this.count}`, "分支测试对话");
        const source = structuredClone(this.turns.get(p.threadId) || []);
        const index = source.findIndex((turn) => turn.id === p.lastTurnId);
        this.turns.set(
          thread.id,
          index >= 0 ? source.slice(0, index + 1) : source,
        );
        this.threads.unshift(thread);
        this.emit("thread/started", { thread });
        return this.reply(socket, request, { thread });
      }
      case "turn/start": {
        if (this.failTurnStartNext) {
          this.failTurnStartNext = false;
          return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "Test turn start failed" } }));
        }
        const turn = makeTurn(`turn-${++this.count}`, [], "inProgress");
        const user = {
          id: `user-${this.count}`,
          type: "userMessage",
          clientId: p.clientUserMessageId,
          content: p.input,
        };
        turn.items.push(user);
        this.turns.get(p.threadId)?.push(turn);
        this.emit("turn/started", { threadId: p.threadId, turn });
        this.emit("item/completed", {
          threadId: p.threadId,
          turnId: turn.id,
          item: user,
        });
        if (this.holdTurnStartResponse)
          this.heldTurnStartResponse = () =>
            this.reply(socket, request, { turn });
        else this.reply(socket, request, { turn });
        if (this.requireApprovalNext) {
          this.requireApprovalNext = false;
          const id = `approval-${this.count}`;
          this.activeApproval = { id, threadId: p.threadId, turn };
          socket.send(
            JSON.stringify({
              id,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: p.threadId,
                turnId: turn.id,
                itemId: "command-approval",
                command: "printf approved",
                cwd: workspace,
                reason: "执行可恢复的测试命令",
              },
            }),
          );
        } else
          setTimeout(
            () => this.complete(p.threadId, turn, "流式回复完成 ✅"),
            25,
          );
        return;
      }
      case "turn/steer": {
        const turn = (this.turns.get(p.threadId) || []).find(
          (turn) => turn.id === p.expectedTurnId,
        );
        if (!turn || turn.status !== "inProgress")
          return socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: -32000, message: "Expected active turn mismatch" },
            }),
          );
        const item = {
          id: `steered-${++this.count}`,
          type: "userMessage",
          clientId: p.clientUserMessageId,
          content: p.input,
        };
        turn.items.push(item);
        this.emit("item/completed", {
          threadId: p.threadId,
          turnId: turn.id,
          item,
        });
        return this.reply(socket, request, { turnId: turn.id });
      }
      case "thread/compact/start": {
        const turn = makeTurn(`compact-${++this.count}`, [], "inProgress");
        const item = {
          id: `compact-item-${this.count}`,
          type: "contextCompaction",
        };
        this.turns.get(p.threadId)?.push(turn);
        this.emit("turn/started", { threadId: p.threadId, turn });
        this.reply(socket, request, {});
        setTimeout(() => {
          turn.items.push(item);
          turn.status = "completed";
          this.emit("item/completed", {
            threadId: p.threadId,
            turnId: turn.id,
            item,
          });
          this.emit("thread/compacted", {
            threadId: p.threadId,
            turnId: turn.id,
          });
          this.emit("turn/completed", { threadId: p.threadId, turn });
        }, 25);
        return;
      }
      case "fuzzyFileSearch":
        return this.reply(socket, request, {
          files: [
            {
              file_name: "README.md",
              path: "README.md",
              root: workspace,
              score: 100,
              indices: [],
            },
          ],
        });
      case "fs/readDirectory":
        return this.reply(socket, request, {
          entries: [
            { fileName: "index.html", isDirectory: false },
            { fileName: "README.md", isDirectory: false },
          ],
        });
      case "fs/getMetadata": {
        const isFile = /\/(?:index\.html|README\.md)$/.test(p.path);
        return this.reply(socket, request, {
          isDirectory: !isFile,
          isFile,
          isSymlink: false,
          createdAtMs: 0,
          modifiedAtMs: 0,
        });
      }
      case "fs/readFile":
        return this.reply(socket, request, {
          dataBase64: Buffer.from(
            p.path.endsWith(".html")
              ? "<h1>Demo preview</h1>"
              : "# Demo Project\n文件读取正常",
          ).toString("base64"),
        });
      case "fs/writeFile":
        return this.reply(socket, request, {});
      case "command/exec": {
        this.activeProcess = { request, socket, processId: p.processId };
        // A UTF-8 codepoint can cross app-server byte-chunk boundaries.
        const bytes = Buffer.from("终端输出正常\n");
        this.emit("command/exec/outputDelta", {
          processId: p.processId,
          stream: "stdout",
          deltaBase64: bytes.subarray(0, 2).toString("base64"),
          capReached: false,
        });
        this.emit("command/exec/outputDelta", {
          processId: p.processId,
          stream: "stdout",
          deltaBase64: bytes.subarray(2).toString("base64"),
          capReached: false,
        });
        return;
      }
      case "command/exec/write":
        return this.reply(socket, request, {});
      case "command/exec/resize":
        return this.reply(socket, request, {});
      case "command/exec/terminate": {
        if (this.activeProcess) {
          this.reply(this.activeProcess.socket, this.activeProcess.request, {
            stdout: "",
            stderr: "",
            exitCode: 0,
          });
          this.activeProcess = undefined;
        }
        return this.reply(socket, request, {});
      }
      case "config/batchWrite":
        return this.reply(socket, request, {
          status: "ok",
          configVersion: "test",
        });
      case "thread/name/set": {
        const thread = [...this.threads, ...this.archivedThreads].find((t) => t.id === p.threadId);
        if (thread) thread.name = p.name;
        return this.reply(socket, request, {});
      }
      case "thread/delete": {
        this.threads = this.threads.filter((thread) => thread.id !== p.threadId);
        this.archivedThreads = this.archivedThreads.filter((thread) => thread.id !== p.threadId);
        this.turns.delete(p.threadId);
        return this.reply(socket, request, {});
      }
      case "thread/archive": {
        const thread = this.threads.find((t) => t.id === p.threadId);
        if (thread) this.archivedThreads.push(thread);
        this.threads = this.threads.filter((t) => t.id !== p.threadId);
        return this.reply(socket, request, {});
      }
      case "review/start":
        return this.reply(socket, request, {
          turn: makeTurn("review"),
          reviewThreadId: p.threadId,
        });
      default:
        return socket.send(
          JSON.stringify({
            id: request.id,
            error: {
              code: -32601,
              message: `Unimplemented test RPC: ${request.method}`,
            },
          }),
        );
    }
  }
  private complete(threadId: string, turn: any, text: string) {
    const item = { id: `agent-${turn.id}`, type: "agentMessage", text: "" };
    this.emit("item/started", { threadId, turnId: turn.id, item });
    this.emit("item/agentMessage/delta", {
      threadId,
      turnId: turn.id,
      itemId: item.id,
      delta: text.slice(0, 4),
    });
    const finish = () => {
      this.emit("item/agentMessage/delta", {
        threadId,
        turnId: turn.id,
        itemId: item.id,
        delta: text.slice(4),
      });
      item.text = text;
      turn.items.push(item);
      turn.status = "completed";
      this.emit("item/completed", { threadId, turnId: turn.id, item });
      this.emit("thread/tokenUsage/updated", {
        threadId,
        tokenUsage: {
          last: { totalTokens: this.contextTokens },
          total: { totalTokens: 5000 },
          modelContextWindow: 1000,
        },
      });
      this.emit("turn/completed", { threadId, turn });
    };
    if (this.holdFinalMessage) this.finishMessage = finish;
    else finish();
  }
  releaseTurnStartResponse() {
    this.heldTurnStartResponse?.();
    this.heldTurnStartResponse = undefined;
  }
  releaseRevertResponse() {
    this.holdRevertResponse = false;
    this.heldRevertResponse?.();
    this.heldRevertResponse = undefined;
  }
  releaseConfigReadResponse() {
    this.holdConfigReadResponse = false;
    this.heldConfigReadResponse?.();
    this.heldConfigReadResponse = undefined;
  }
  finishStream() {
    this.finishMessage?.();
    this.finishMessage = undefined;
  }
  request(method: string) {
    return this.requests.filter((request) => request.method === method).at(-1);
  }
}

export const test = base.extend<{ mock: MockCodex }>({
  mock: [
    async ({ page }, use) => {
      const mock = new MockCodex();
      await mock.install(page);
      await use(mock);
    },
    { auto: true },
  ],
});
export { expect };

export async function editSource(page: Page, name: string, text: string) {
  // Use CodeMirror's actual key/input handlers; DOM-only fill can race a
  // language compartment update and concatenate the old document.
  const editor = page.getByRole('textbox', { name, exact: true });
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
  await expect(editor).toHaveText(text, { useInnerText: true });
}

export async function login(page: Page) {
  await page.goto("/");
  await page
    .locator('input[type="password"]')
    .first()
    .fill("test-password-123");
  await page
    .getByRole("button", { name: /登录|进入工作区|解锁/ })
    .first()
    .click();
  await expect(page.getByRole("textbox", { name: "消息输入框" })).toBeEnabled();
}
export async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "消息输入框" }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}
export async function slash(page: Page, command: string) {
  await page.getByRole("textbox", { name: "消息输入框" }).fill(`/${command}`);
  await expect(page.getByRole("listbox", { name: "对话指令" })).toBeVisible();
  await page
    .getByRole("option")
    .filter({ hasText: `/${command}` })
    .click();
}
