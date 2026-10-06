import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { Auth } from "./auth.js";
import { Bridge } from "./bridge.js";
import {
  registerTmux,
  parseTmuxSessions,
  parseTmuxPanes,
  tmuxSandbox,
} from "./tmux.js";

const execute = promisify(execFile);
type Command = {
  command: string[];
  cwd: string;
  outputBytesCap: number;
  timeoutMs: number;
  env: Record<string, string | null>;
  sandboxPolicy: { type: string; writableRoots?: string[] };
};
type Result = { exitCode: number; stdout: string; stderr: string };
type Session = { id: string; name: string; created: number };
const ok = (stdout = ""): Result => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): Result => ({ exitCode: 1, stdout: "", stderr });
const tmuxCommand = (input: Command) => {
  assert.equal(input.command[1], "-u", "tmux metadata must force UTF-8 output");
  return [input.command[0]!, ...input.command.slice(2)];
};
const sessionRows = (values: Session[]) =>
  values
    .map((entry) => `${entry.id}\t1\t0\t${entry.created}\t${entry.name}`)
    .join("\n") + "\n";

async function fixture(
  handler?: (hostId: string, input: Command) => Promise<Result>,
) {
  const calls: { hostId: string; input: Command }[] = [];
  const selectedHosts: string[] = [];
  const stores = new Map<string, Session[]>([
    ["local", [{ id: "$1", name: "Local", created: 10 }]],
    ["remote", [{ id: "$1", name: "Remote", created: 20 }]],
  ]);
  let nextId = 2;
  const app = express();
  const auth = new Auth(
    "tmux-test-password-only",
    new Set(["http://localhost"]),
  );
  app.use(express.json());
  app.post("/api/auth/login", auth.login);
  app.use("/api", auth.requireAuth, auth.requireCsrf);
  registerTmux(app, {
    getBridge: async (hostId = "local") => {
      selectedHosts.push(hostId);
      if (!stores.has(hostId))
        throw Object.assign(new Error("Host not found"), { status: 404 });
      return {
        request: async (method, params) => {
          if (method === "fs/getMetadata")
            return { isDirectory: (params as any).path !== "/not-a-directory" };
          assert.equal(method, "command/exec");
          const input = params as Command;
          calls.push({ hostId, input });
          if (handler) return handler(hostId, input);
          const command =
            input.command[0] === "/bin/sh" ? input.command : tmuxCommand(input);
          if (command[0] === "/bin/sh") {
            assert.deepEqual(command, ["/bin/sh", "-c", "command -v tmux"]);
            return ok("/usr/bin/tmux\n");
          }
          assert.equal(command[0], "/usr/bin/tmux");
          const entries = stores.get(hostId)!;
          if (command[1] === "list-sessions")
            return entries.length
              ? ok(sessionRows(entries))
              : fail("no server running on /tmp/tmux-test");
          if (command[1] === "list-panes")
            return ok(
              "%1\t@1\t1\t0\tzsh\t/repo\tother\told\n%2\t@2\t1\t1\tbash\t/repo\tactive\tlive\n",
            );
          if (command[1] === "capture-pane")
            return ok(
              command.includes("%1") ? "old output\n" : "current output\n",
            );
          if (command[1] === "new-session") {
            const name = command[command.indexOf("-s") + 1]!;
            if (entries.some((entry) => entry.name === name))
              return fail("duplicate session: existing");
            const session = { id: `$${nextId++}`, name, created: 30 };
            entries.push(session);
            return ok(sessionRows([session]));
          }
          if (command[1] === "kill-session") {
            const id = command[command.indexOf("-t") + 1];
            const index = entries.findIndex((entry) => entry.id === id);
            if (index < 0) return fail("can't find session");
            entries.splice(index, 1);
            return ok();
          }
          throw new Error(`Unexpected command ${command[1]}`);
        },
      };
    },
  });
  app.use(
    (
      cause: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(cause instanceof z.ZodError ? 400 : cause.status || 500)
        .json({ error: cause.message }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "tmux-test-password-only" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const csrf = ((await login.json()) as any).csrfToken as string;
  const post = async (
    endpoint: string,
    values: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    const result = await fetch(`${base}/api/tmux/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf,
        ...headers,
      },
      body: JSON.stringify({
        hostId: "local",
        cwd: "/repo",
        permission: "workspace-write",
        ...values,
      }),
    });
    return { code: result.status, body: (await result.json()) as any };
  };
  return {
    calls,
    selectedHosts,
    stores,
    post,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause ? reject(cause) : resolve())),
      ),
  };
}

test("tmux routes require authentication, CSRF and trusted origin before contacting a host", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post("list", {}, { cookie: "" })).code, 401);
    assert.equal((await f.post("list", {}, { "x-csrf-token": "" })).code, 403);
    assert.equal(
      (
        await f.post(
          "delete",
          { sessionId: "$1" },
          { origin: "https://untrusted.invalid" },
        )
      ).code,
      403,
    );
    assert.equal(f.selectedHosts.length, 0);
  } finally {
    await f.close();
  }
});

test("tmux canonical targets and names reject shell injection, global targets and invalid paths", async () => {
  const f = await fixture();
  try {
    for (const sessionId of [
      "local",
      "*",
      "=Local",
      "$01",
      "$1;kill-server",
      "$(touch /tmp/x)",
      "--all",
      "$1\n",
    ]) {
      for (const endpoint of ["read", "attach", "delete"])
        assert.equal(
          (await f.post(endpoint, { sessionId })).code,
          400,
          `${endpoint}: ${sessionId}`,
        );
    }
    for (const name of [
      "a;b",
      "$(touch-x)",
      "`id`",
      "-option",
      "a.b",
      "a:b",
      "a b",
      "x\ny",
      "a".repeat(65),
    ])
      assert.equal((await f.post("create", { name })).code, 400, name);
    for (const cwd of ["relative", "/repo\n", ""])
      assert.equal((await f.post("list", { cwd })).code, 400);
    assert.equal(f.selectedHosts.length, 0);
    assert.equal((await f.post("list", { cwd: "/not-a-directory" })).code, 400);
    assert.equal((await f.post("list", { hostId: "missing" })).code, 404);
    assert.equal(
      (await f.post("read", { sessionId: "$1", paneId: "%01" })).code,
      400,
    );
  } finally {
    await f.close();
  }
});

test("read-only allows list and capture but blocks creation, attachment and deletion", async () => {
  const f = await fixture();
  try {
    for (const endpoint of ["create", "attach", "delete"])
      assert.equal(
        (await f.post(endpoint, { permission: "read-only", sessionId: "$1" }))
          .code,
        403,
      );
    assert.equal(f.selectedHosts.length, 0);
    assert.equal((await f.post("list", { permission: "read-only" })).code, 200);
    assert.equal(
      (await f.post("read", { permission: "read-only", sessionId: "$1" })).body
        .text,
      "current output",
    );
    assert.ok(
      f.calls.every(({ input }) => input.sandboxPolicy.type === "readOnly"),
    );
    assert.deepEqual(tmuxSandbox("workspace-write", "/repo"), {
      type: "workspaceWrite",
      writableRoots: ["/repo"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    assert.deepEqual(tmuxSandbox("danger-full-access", "/repo"), {
      type: "dangerFullAccess",
    });
  } finally {
    await f.close();
  }
});

test("tmux management scopes identical session IDs to the selected host and deletes exactly one session", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.post("list", { hostId: "remote" })).body.sessions[0].name,
      "Remote",
    );
    const created = await f.post("create", {
      hostId: "remote",
      name: "开发_2",
    });
    assert.equal(created.code, 201);
    assert.equal(created.body.session.name, "开发_2");
    const attached = await f.post("attach", {
      hostId: "remote",
      sessionId: "$1",
    });
    assert.deepEqual(attached.body.command, [
      "/usr/bin/tmux",
      "attach-session",
      "-t",
      "$1",
    ]);
    assert.deepEqual(attached.body.env, { TMUX: null, TMUX_PANE: null });
    assert.equal(attached.body.sessionName, "Remote");
    assert.equal(
      (await f.post("delete", { hostId: "remote", sessionId: "$1" })).code,
      200,
    );
    assert.equal(f.stores.get("local")!.length, 1);
    assert.equal(f.stores.get("remote")!.length, 1);
    assert.equal(
      (await f.post("delete", { hostId: "remote", sessionId: "$1" })).code,
      404,
    );
    assert.equal(
      (await f.post("create", { hostId: "remote", name: "开发_2" })).code,
      409,
    );
    assert.ok(
      f.calls.every(({ input }) => !input.command.includes("kill-server")),
    );
    assert.ok(
      f.calls.every(
        ({ input }) => input.env.TMUX === null && input.env.TMUX_PANE === null,
      ),
    );
    assert.ok(
      f.calls.every(
        ({ input }) =>
          input.timeoutMs === 10000 && input.outputBytesCap === 256 * 1024,
      ),
    );
  } finally {
    await f.close();
  }
});

test("tmux fast read selects the active window pane and verifies requested pane membership", async () => {
  const f = await fixture();
  try {
    const active = await f.post("read", { sessionId: "$1" });
    assert.equal(active.body.paneId, "%2");
    assert.equal(active.body.panes.length, 2);
    assert.equal(active.body.panes[1].windowActive, true);
    assert.equal(
      (await f.post("read", { sessionId: "$1", paneId: "%1" })).body.text,
      "old output",
    );
    const before = f.calls.filter(({ input }) =>
      input.command.includes("capture-pane"),
    ).length;
    assert.equal(
      (await f.post("read", { sessionId: "$1", paneId: "%999" })).code,
      404,
    );
    assert.equal(
      f.calls.filter(({ input }) => input.command.includes("capture-pane"))
        .length,
      before,
    );
  } finally {
    await f.close();
  }
});

test("tmux distinguishes unavailable executable and an installed executable with no server", async () => {
  for (const available of [false, true]) {
    const f = await fixture(async (_host, input) =>
      input.command[0] === "/bin/sh"
        ? available
          ? ok("/usr/bin/tmux\n")
          : fail("")
        : fail(
            "error connecting to /tmp/private-test/default (No such file or directory)",
          ),
    );
    try {
      const result = await f.post("list");
      assert.equal(result.code, 200);
      assert.equal(result.body.available, available);
      assert.deepEqual(result.body.sessions, []);
      if (!available)
        assert.equal((await f.post("create", { name: "test" })).code, 409);
    } finally {
      await f.close();
    }
  }
});

test("tmux surfaces sandbox and vanished target failures without retrying with broader permissions", async () => {
  for (const [diagnostic, expected, exitCode] of [
    ["error connecting to /tmp/tmux-private (Operation not permitted)", 403, 1],
    ["error creating /tmp/tmux-private (Operation not permitted)", 403, 0],
    ["can't find session: $1", 404, 1],
    ["unrecognized command", 409, 1],
  ] as const) {
    const f = await fixture(async (_host, input) =>
      input.command[0] === "/bin/sh"
        ? ok("/usr/bin/tmux\n")
        : { exitCode, stdout: "", stderr: diagnostic },
    );
    try {
      assert.equal((await f.post("list")).code, expected);
      assert.equal(f.calls.length, 2);
      assert.ok(
        f.calls.every(
          ({ input }) => input.sandboxPolicy.type === "workspaceWrite",
        ),
      );
    } finally {
      await f.close();
    }
  }
});

test("tmux capture bounds scrollback lines and byte capture and rejects out-of-range requests", async () => {
  const f = await fixture(async (_host, input) => {
    if (input.command[0] === "/bin/sh") return ok("/usr/bin/tmux\n");
    const command = tmuxCommand(input);
    if (command[1] === "list-sessions") return ok("$1\t1\t0\t10\ttest\n");
    if (command[1] === "list-panes")
      return ok("%1\t@1\t1\t1\tzsh\t/repo\tmain\ttitle\n");
    assert.equal(command[1], "capture-pane");
    assert.deepEqual(command.slice(-2), ["-S", "-2"]);
    return ok("first\nsecond\nthird\n");
  });
  try {
    const result = await f.post("read", { sessionId: "$1", lines: 2 });
    assert.equal(result.body.text, "second\nthird");
    assert.equal(result.body.truncated, true);
    for (const lines of [0, 2001, 1.5, "20"])
      assert.equal(
        (await f.post("read", { sessionId: "$1", lines })).code,
        400,
      );
  } finally {
    await f.close();
  }
});

test("tmux parsers preserve labels, ignore malformed records and deduplicate canonical IDs", () => {
  assert.deepEqual(
    parseTmuxSessions(
      "$1\t2\t1\t10\tolder\n$2\t1\t0\t20\t中文\n$01\t1\t0\t30\tbad\n$1\t2\t1\t10\tupdated\nmalformed\n",
    ),
    [
      { id: "$2", name: "中文", windows: 1, attached: 0, createdAt: 20 },
      { id: "$1", name: "updated", windows: 2, attached: 1, createdAt: 10 },
    ],
  );
  const panes = parseTmuxPanes(
    "%2\t@1\t1\t1\tzsh\t/project space\tmain\ttitle\tcontinued\n%01\t@1\t1\t1\tbash\t/repo\tbad\tbad\n",
  );
  assert.equal(panes.length, 1);
  assert.equal(panes[0]!.path, "/project space");
  assert.equal(panes[0]!.title, "title continued");
});

test("tmux printable records preserve delimiters, percent-like strings, Unicode and backslashes", () => {
  assert.deepEqual(
    parseTmuxSessions(
      "tmux-v1|$8|2|1|100|会话%7C%257C\\目录_%25\n" +
        "tmux-v1|$9|1|0|101|extra|delimiter\n" +
        "tmux-v1|$01|1|0|102|invalid\n",
    ),
    [{ id: "$8", name: "会话|%7C\\目录_%", windows: 2, attached: 1, createdAt: 100 }],
  );
  assert.deepEqual(
    parseTmuxPanes(
      "tmux-v1|%8|@2|1|0|run%7C%25\\job|/工作区%7C%257C\\目录|窗口%7C%2525|标题%7C%257C\\尾_%25\n" +
        "tmux-v1|%9|@2|1|1|sh|/repo|window|bad|extra\n" +
        "tmux-v1|%10|@2|2|1|sh|/repo|window|invalid\n",
    ),
    [{
      id: "%8", windowId: "@2", active: true, windowActive: false,
      command: "run|%\\job", path: "/工作区|%7C\\目录",
      windowName: "窗口|%25", title: "标题|%7C\\尾_%",
    }],
  );
});

const tmuxExecutable = spawnSync("/bin/sh", ["-c", "command -v tmux"], {
  encoding: "utf8",
}).stdout?.trim();
const hasTmux =
  !!tmuxExecutable &&
  spawnSync(tmuxExecutable, ["-V"], { stdio: "ignore" }).status === 0;
const hasCodex =
  spawnSync(process.env.CODEX_BIN || "codex", ["--version"], {
    stdio: "ignore",
  }).status === 0;

test(
  "real tmux lifecycle uses a private socket and never touches the user's default sessions",
  { skip: !hasTmux, timeout: 20000 },
  async () => {
    const rootDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "codex-tmux-test-")),
    );
    const directory = path.join(rootDirectory, "工作区|%7C\\目录_%");
    await fs.mkdir(directory);
    const socket = `codex-web-test-${randomUUID()}`;
    const f = await fixture(async (_host, input) => {
      if (input.command[0] === "/bin/sh") return ok(`${tmuxExecutable}\n`);
      try {
        const result = await execute(
          tmuxExecutable!,
          ["-L", socket, ...input.command.slice(1)],
          {
            cwd: input.cwd,
            env: { ...process.env, TMUX: "", TMUX_PANE: "" },
            maxBuffer: 1024 * 1024,
          },
        );
        return ok(result.stdout);
      } catch (cause) {
        const result = cause as {
          code: number;
          stdout: string;
          stderr: string;
        };
        return {
          exitCode: result.code,
          stdout: result.stdout || "",
          stderr: result.stderr || "",
        };
      }
    });
    try {
      assert.deepEqual(
        (await f.post("list", { cwd: directory })).body.sessions,
        [],
      );
      const first = await f.post("create", { cwd: directory, name: "first" });
      const second = await f.post("create", { cwd: directory, name: "second" });
      assert.equal(first.code, 201, JSON.stringify(first.body));
      assert.equal(second.code, 201, JSON.stringify(second.body));
      const firstId = first.body.session.id;
      const privateTmux = (...args: string[]) =>
        execute(tmuxExecutable!, ["-L", socket, "-u", ...args]);
      await privateTmux("rename-session", "-t", firstId, "会话|%7C\\目录_%");
      await privateTmux("set-option", "-t", firstId, "allow-rename", "off");
      await privateTmux("rename-window", "-t", firstId, "窗口|%25\\名称_%");
      await privateTmux("select-pane", "-t", firstId, "-T", "标题|%7C\\尾_%");
      const nativeName = (await privateTmux("display-message", "-p", "-t", firstId, "#{session_name}")).stdout.trimEnd();
      const nativeWindow = (await privateTmux("list-panes", "-t", firstId, "-F", "#{window_name}")).stdout.trimEnd();
      const nativeTitle = (await privateTmux("list-panes", "-t", firstId, "-F", "#{pane_title}")).stdout.trimEnd();
      assert.equal(
        (await f.post("list", { cwd: directory })).body.sessions.find((entry: any) => entry.id === firstId).name,
        nativeName,
      );
      const read = await f.post("read", { cwd: directory, sessionId: firstId });
      assert.equal(read.code, 200, JSON.stringify(read.body));
      assert.equal(read.body.panes[0].path, directory);
      assert.equal(read.body.panes[0].windowName, nativeWindow);
      assert.equal(read.body.panes[0].title, nativeTitle);
      assert.equal(
        (
          await f.post("attach", {
            cwd: directory,
            sessionId: second.body.session.id,
          })
        ).body.sessionName,
        "second",
      );
      assert.equal(
        (await f.post("delete", { cwd: directory, sessionId: firstId })).code,
        200,
      );
      assert.deepEqual(
        (await f.post("list", { cwd: directory })).body.sessions.map(
          (session: any) => session.name,
        ),
        ["second"],
      );
      assert.equal(
        (await f.post("read", { cwd: directory, sessionId: firstId })).code,
        404,
      );
    } finally {
      await execute(tmuxExecutable!, ["-L", socket, "kill-server"]).catch(
        () => {},
      );
      await f.close();
      await fs.rm(rootDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "installed app-server manages real isolated tmux through official command/exec",
  { skip: !hasTmux || !hasCodex, timeout: 30000 },
  async (t) => {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "codex-appserver-tmux-")),
    );
    const home = path.join(directory, "codex-home");
    await fs.mkdir(home);
    const socket = `codex-web-protocol-test-${randomUUID()}`;
    const bridge = new Bridge(
      { id: "local", name: "Isolated tmux", kind: "local" },
      {
        cwd: directory,
        codexHome: home,
        codexBin: process.env.CODEX_BIN || "codex",
      },
    );
    const f = await fixture(async (_host, input) => {
      const command =
        input.command[0] === "/bin/sh"
          ? input.command
          : [input.command[0]!, "-L", socket, ...input.command.slice(1)];
      const result = (await bridge.request("command/exec", {
        ...input,
        command,
      })) as Result;
      return result;
    });
    try {
      const workspace = await f.post("create", {
        cwd: directory,
        permission: "workspace-write",
        name: "workspace-test",
      });
      if (process.platform === "darwin") {
        assert.equal(workspace.code, 403, JSON.stringify(workspace.body));
        t.diagnostic(
          "macOS workspace sandbox correctly reports the default tmux socket restriction without upgrading permissions",
        );
      } else {
        assert.equal(workspace.code, 201, JSON.stringify(workspace.body));
        assert.equal(
          (
            await f.post("read", {
              cwd: directory,
              permission: "workspace-write",
              sessionId: workspace.body.session.id,
            })
          ).code,
          200,
        );
        assert.equal(
          (
            await f.post("delete", {
              cwd: directory,
              permission: "workspace-write",
              sessionId: workspace.body.session.id,
            })
          ).code,
          200,
        );
      }
      const created = await f.post("create", {
        cwd: directory,
        permission: "danger-full-access",
        name: "protocol-test",
      });
      assert.equal(created.code, 201, JSON.stringify(created.body));
      const id = created.body.session.id;
      const read = await f.post("read", {
        cwd: directory,
        permission: "danger-full-access",
        sessionId: id,
      });
      assert.equal(read.code, 200, JSON.stringify(read.body));
      assert.equal(read.body.panes[0].path, directory);
      await bridge.request("command/exec", {
        command: [
          tmuxExecutable!,
          "-L",
          socket,
          "send-keys",
          "-t",
          id,
          "printf '\\nCODEX_TMUX_CAPTURE_OK\\n'",
          "Enter",
        ],
        cwd: directory,
        timeoutMs: 10000,
        outputBytesCap: 1024,
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      let captured = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        captured = (
          await f.post("read", {
            cwd: directory,
            permission: "danger-full-access",
            sessionId: id,
          })
        ).body.text;
        if (/^CODEX_TMUX_CAPTURE_OK$/m.test(captured)) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      assert.match(captured, /^CODEX_TMUX_CAPTURE_OK$/m);
      const readonly = await f.post("read", {
        cwd: directory,
        permission: "read-only",
        sessionId: id,
      });
      assert.equal(
        readonly.code,
        process.platform === "darwin" ? 403 : 200,
        JSON.stringify(readonly.body),
      );
      assert.equal(
        (
          await f.post("attach", {
            cwd: directory,
            permission: "danger-full-access",
            sessionId: id,
          })
        ).code,
        200,
      );
      assert.equal(
        (
          await f.post("delete", {
            cwd: directory,
            permission: "danger-full-access",
            sessionId: id,
          })
        ).code,
        200,
      );
      assert.deepEqual(
        (
          await f.post("list", {
            cwd: directory,
            permission: "danger-full-access",
          })
        ).body.sessions,
        [],
      );
    } finally {
      bridge.close();
      await execute(tmuxExecutable!, ["-L", socket, "kill-server"]).catch(
        () => {},
      );
      await f.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
