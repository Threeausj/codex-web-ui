import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import type { Bridge } from "./bridge.js";
import type { CommandExecResponse } from "../shared/protocol/v2/CommandExecResponse.js";

type TmuxBridge = Pick<Bridge, "request">;
export type TmuxDependencies = {
  getBridge: (hostId?: string) => Promise<TmuxBridge>;
};
type Permission = "read-only" | "workspace-write" | "danger-full-access";
type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };
type Context = {
  bridge: TmuxBridge;
  cwd: string;
  permission: Permission;
  executable?: string;
};
export type TmuxSession = {
  id: string;
  name: string;
  windows: number;
  attached: number;
  createdAt: number;
};
export type TmuxPane = {
  id: string;
  windowId: string;
  active: boolean;
  windowActive: boolean;
  command: string;
  path: string;
  windowName: string;
  title: string;
};

const scope = z.object({
  hostId: z.string().min(1).max(128).default("local"),
  cwd: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) => value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value),
      "需要有效的绝对工作目录",
    ),
  permission: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("read-only"),
});
const sessionId = z
  .string()
  .regex(/^\$(?:0|[1-9]\d{0,12})$/, "无效的 tmux 会话 ID");
const paneId = z
  .string()
  .regex(/^%(?:0|[1-9]\d{0,12})$/, "无效的 tmux 窗格 ID");
const target = z.object({ sessionId });
const name = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u,
    "会话名称只能包含字母、数字、下划线和连字符",
  );
const MAX_OUTPUT = 256 * 1024;
const RECORD_PREFIX = "tmux-v1|";
// tmux 3.3 sanitizes literal TABs in -F into underscores. Use printable fields,
// escape '%' before '|', and sanitize controls before they can split a record.
// The nested literal protects the colons in the POSIX character class from the
// format modifier parser. These substitutions require no remote shell helpers.
const labelFormat = (variable: string) =>
  `#{s/%/%25/;s/[|]/%7C/;s/#{l:[[:cntrl:]]}/ /:${variable}}`;
const SESSION_FORMAT =
  `${RECORD_PREFIX}#{session_id}|#{session_windows}|#{session_attached}|#{session_created}|` +
  labelFormat("session_name");
const PANE_FORMAT =
  `${RECORD_PREFIX}#{pane_id}|#{window_id}|#{pane_active}|#{window_active}|` +
  ["pane_current_command", "pane_current_path", "window_name", "pane_title"]
    .map(labelFormat)
    .join("|");
const route =
  (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
const error = (message: string, status: number, code: string) =>
  Object.assign(new Error(message), { status, code });
const missingServer = (message: string) =>
  /no server running|failed to connect to server|error connecting to .*(?:no such file|connection refused)/i.test(
    message,
  );
const missingTarget = (message: string) =>
  /can't find (?:session|pane|window)|(?:session|pane|window) not found|no sessions/i.test(
    message,
  );
const permissions = (message: string) =>
  /permission denied|operation not permitted|access denied|sandbox|denied by/i.test(
    message,
  );
const cleanLabel = (value: string, limit = 4096) =>
  value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit);

export function tmuxSandbox(
  permission: Permission,
  cwd: string,
): SandboxPolicy {
  if (permission === "danger-full-access") return { type: "dangerFullAccess" };
  if (permission === "read-only")
    return { type: "readOnly", networkAccess: false };
  // Match the existing terminal's workspace policy; never upgrade the selected permission.
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

async function execute(
  context: Context,
  command: string[],
): Promise<CommandExecResponse> {
  try {
    return (await context.bridge.request("command/exec", {
      // Force UTF-8 output even when a remote host has no UTF-8 locale set.
      command:
        command[0] === context.executable
          ? [command[0]!, "-u", ...command.slice(1)]
          : command,
      cwd: context.cwd,
      timeoutMs: 10000,
      outputBytesCap: MAX_OUTPUT,
      env: { TMUX: null, TMUX_PANE: null },
      sandboxPolicy: tmuxSandbox(context.permission, context.cwd),
    })) as CommandExecResponse;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (permissions(message))
      throw error(
        "当前权限阻止访问 tmux socket，请在权限选择中切换到完全访问后重试",
        403,
        "tmux_permission",
      );
    if (/timed? out|timeout/i.test(message))
      throw error("读取 tmux 超时，请刷新后重试", 504, "tmux_timeout");
    throw cause;
  }
}
function checked(result: CommandExecResponse, operation: string) {
  // Some tmux versions return zero after a failed server startup; stderr is decisive.
  const message =
    result.stderr.trim() || (result.exitCode !== 0 ? result.stdout.trim() : "");
  if (permissions(message))
    throw error(
      "当前权限阻止访问 tmux socket，请在权限选择中切换到完全访问后重试",
      403,
      "tmux_permission",
    );
  if (missingServer(message) || missingTarget(message))
    throw error("tmux 会话或窗格已结束，请刷新列表", 404, "tmux_missing");
  if (/duplicate session/i.test(message))
    throw error("已存在同名 tmux 会话，请更换名称", 409, "tmux_duplicate");
  if (result.exitCode === 0) return result;
  throw error(
    `${operation}失败：${cleanLabel(message || `退出码 ${result.exitCode}`, 800)}`,
    409,
    "tmux_failed",
  );
}
async function contextFor(
  deps: TmuxDependencies,
  input: unknown,
  writable = false,
): Promise<Context> {
  const parsed = scope.parse(input);
  if (writable && parsed.permission === "read-only")
    throw error(
      "当前为只读权限，请切换权限后管理或连接 tmux 会话",
      403,
      "tmux_readonly",
    );
  const context: Context = {
    bridge: await deps.getBridge(parsed.hostId),
    cwd: path.posix.normalize(parsed.cwd),
    permission: parsed.permission,
  };
  const metadata = (await context.bridge.request("fs/getMetadata", {
    path: context.cwd,
  })) as { isDirectory?: boolean };
  if (!metadata.isDirectory)
    throw error("工作目录不存在或不是目录", 400, "tmux_directory");
  return context;
}
async function detect(context: Context) {
  // This fixed discovery command is the only shell invocation. User input never enters it.
  const result = await execute(context, ["/bin/sh", "-c", "command -v tmux"]);
  if (permissions(result.stderr)) checked(result, "检测 tmux");
  const executable = result.stdout.trim();
  if (
    result.exitCode !== 0 ||
    !executable.startsWith("/") ||
    /[\x00-\x1f\x7f]/.test(executable)
  )
    return false;
  context.executable = executable;
  return true;
}
async function requireTmux(context: Context) {
  if (!(await detect(context)))
    throw error(
      "所选主机未安装 tmux，安装后即可管理持久会话",
      409,
      "tmux_unavailable",
    );
}
function metadataSize(result: CommandExecResponse) {
  if (Buffer.byteLength(result.stdout) >= MAX_OUTPUT)
    throw error(
      "tmux 列表过大，无法完整读取，请减少会话或窗格后重试",
      413,
      "tmux_output",
    );
}
function recordFields(row: string, count: number): string[] | null {
  const normalized = row.replace(/\r$/, "");
  if (!normalized.startsWith(RECORD_PREFIX)) return normalized.split("\t");
  const fields = normalized.slice(RECORD_PREFIX.length).split("|");
  if (fields.length !== count) return null;
  // Decode in one pass: a literal "%7C" was emitted as "%257C", so it must
  // remain "%7C", rather than becoming another field separator.
  return fields.map((field) =>
    field.replace(/%25|%7C/g, (encoded) => (encoded === "%25" ? "%" : "|")),
  );
}
export function parseTmuxSessions(source: string): TmuxSession[] {
  const sessions = new Map<string, TmuxSession>();
  for (const row of source.split("\n")) {
    if (!row) continue;
    const fields = recordFields(row, 5);
    if (!fields) continue;
    const [id, windows, attached, createdAt, ...nameParts] = fields;
    if (
      !sessionId.safeParse(id).success ||
      ![windows, attached, createdAt].every((value) =>
        /^\d+$/.test(value || ""),
      )
    )
      continue;
    const numbers = [windows, attached, createdAt].map(Number);
    if (!numbers.every(Number.isSafeInteger)) continue;
    sessions.set(id!, {
      id: id!,
      name: cleanLabel(nameParts.join("\t"), 256) || id!,
      windows: numbers[0]!,
      attached: numbers[1]!,
      createdAt: numbers[2]!,
    });
  }
  return [...sessions.values()].sort(
    (a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name),
  );
}
export function parseTmuxPanes(source: string): TmuxPane[] {
  const panes = new Map<string, TmuxPane>();
  for (const row of source.split("\n")) {
    if (!row) continue;
    const [
      id,
      windowId,
      active,
      windowActive,
      command,
      cwd,
      windowName,
      ...title
    ] = recordFields(row, 8) || [];
    if (
      !paneId.safeParse(id).success ||
      !/^@(?:0|[1-9]\d{0,12})$/.test(windowId || "") ||
      ![active, windowActive].every((value) => value === "0" || value === "1")
    )
      continue;
    panes.set(id!, {
      id: id!,
      windowId: windowId!,
      active: active === "1",
      windowActive: windowActive === "1",
      command: cleanLabel(command || "", 256),
      path: cleanLabel(cwd || ""),
      windowName: cleanLabel(windowName || "", 256),
      title: cleanLabel(title.join("\t"), 256),
    });
  }
  return [...panes.values()];
}
async function sessions(context: Context, allowNoServer = false) {
  const result = await execute(context, [
    context.executable!,
    "list-sessions",
    "-F",
    SESSION_FORMAT,
  ]);
  if (
    allowNoServer &&
    !permissions(result.stderr) &&
    missingServer(result.stderr)
  )
    return [];
  checked(result, "读取 tmux 会话");
  metadataSize(result);
  return parseTmuxSessions(result.stdout);
}
async function selectedSession(context: Context, id: string) {
  const session = (await sessions(context)).find((entry) => entry.id === id);
  if (!session) throw error("tmux 会话已结束，请刷新列表", 404, "tmux_missing");
  return session;
}

/** Register after shared authentication and CSRF middleware, like the Git routes. */
export function registerTmux(app: Express, deps: TmuxDependencies) {
  app.post(
    "/api/tmux/list",
    route(async (req, res) => {
      const context = await contextFor(deps, req.body);
      if (!(await detect(context))) {
        res.json({
          available: false,
          reason: "所选主机未检测到 tmux，安装后即可管理持久会话",
          sessions: [],
        });
        return;
      }
      res.json({
        available: true,
        executable: context.executable,
        sessions: await sessions(context, true),
      });
    }),
  );
  app.post(
    "/api/tmux/read",
    route(async (req, res) => {
      const input = target
        .extend({
          paneId: paneId.optional(),
          lines: z.number().int().min(1).max(2000).default(300),
        })
        .parse(req.body);
      const context = await contextFor(deps, req.body);
      await requireTmux(context);
      await selectedSession(context, input.sessionId);
      const result = checked(
        await execute(context, [
          context.executable!,
          "list-panes",
          "-s",
          "-t",
          input.sessionId,
          "-F",
          PANE_FORMAT,
        ]),
        "读取 tmux 窗格",
      );
      metadataSize(result);
      const panes = parseTmuxPanes(result.stdout);
      const pane = input.paneId
        ? panes.find((entry) => entry.id === input.paneId)
        : panes.find((entry) => entry.windowActive && entry.active) ||
          panes.find((entry) => entry.active) ||
          panes[0];
      if (!pane)
        throw error(
          "tmux 窗格已结束或不属于该会话，请刷新后重试",
          404,
          "tmux_missing",
        );
      const capture = checked(
        await execute(context, [
          context.executable!,
          "capture-pane",
          "-p",
          "-t",
          pane.id,
          "-S",
          `-${input.lines}`,
        ]),
        "读取 tmux 输出",
      );
      const rows = capture.stdout
        .replace(/\r/g, "")
        .replace(/\n$/, "")
        .split("\n");
      res.json({
        sessionId: input.sessionId,
        paneId: pane.id,
        text: rows.slice(-input.lines).join("\n"),
        panes,
        truncated:
          rows.length > input.lines ||
          Buffer.byteLength(capture.stdout) >= MAX_OUTPUT,
      });
    }),
  );
  app.post(
    "/api/tmux/create",
    route(async (req, res) => {
      const input = z.object({ name: name.optional() }).parse(req.body);
      const context = await contextFor(deps, req.body, true);
      await requireTmux(context);
      const sessionName =
        input.name ||
        `codex-web-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
      const result = checked(
        await execute(context, [
          context.executable!,
          "new-session",
          "-d",
          "-P",
          "-F",
          SESSION_FORMAT,
          "-s",
          sessionName,
          "-c",
          context.cwd,
        ]),
        "新建 tmux 会话",
      );
      metadataSize(result);
      const session = parseTmuxSessions(result.stdout)[0];
      if (!session)
        throw error(
          "tmux 已执行创建，但未返回会话信息，请刷新列表确认",
          409,
          "tmux_result",
        );
      res.status(201).json({ session });
    }),
  );
  app.post(
    "/api/tmux/attach",
    route(async (req, res) => {
      const input = target.parse(req.body);
      const context = await contextFor(deps, req.body, true);
      await requireTmux(context);
      const session = await selectedSession(context, input.sessionId);
      res.json({
        command: [context.executable, "attach-session", "-t", session.id],
        env: { TMUX: null, TMUX_PANE: null },
        sessionName: session.name,
        sessionId: session.id,
      });
    }),
  );
  app.post(
    "/api/tmux/delete",
    route(async (req, res) => {
      const input = target.parse(req.body);
      const context = await contextFor(deps, req.body, true);
      await requireTmux(context);
      await selectedSession(context, input.sessionId);
      checked(
        await execute(context, [
          context.executable!,
          "kill-session",
          "-t",
          input.sessionId,
        ]),
        "删除 tmux 会话",
      );
      res.json({ ok: true, sessionId: input.sessionId });
    }),
  );
}
