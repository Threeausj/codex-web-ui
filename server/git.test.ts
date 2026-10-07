import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import express from "express";
import { z } from "zod";
import { registerGit, parseStatus, parseWorktrees } from "./git.js";
import { Bridge } from "./bridge.js";

const execute = promisify(execFile);
type Call = {
  command: string[];
  cwd: string;
  sandboxPolicy: { type: string; writableRoots?: string[] };
  env: Record<string, string | null>;
};

async function fixture(useAppServer = false, options: { directRead?: boolean; unavailableSandbox?: boolean } = {}) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codex-git-workflow-")),
  );
  const root = path.join(directory, "repository space");
  await fs.mkdir(root);
  const run = async (...args: string[]) =>
    (await execute("git", args, { cwd: root })).stdout;
  await run("init", "--initial-branch=main");
  await run("config", "user.name", "Workflow Test");
  await run("config", "user.email", "workflow-test@example.invalid");
  await fs.writeFile(path.join(root, "one.txt"), "original one\n");
  await fs.writeFile(path.join(root, "two.txt"), "original two\n");
  await run("add", "--", "one.txt", "two.txt");
  await run("commit", "-m", "Initial");
  const calls: Call[] = [];
  const codexHome = path.join(directory, "codex-home");
  await fs.mkdir(codexHome);
  const bridge = useAppServer
    ? new Bridge(
        { id: "local", name: "Test", kind: "local" },
        { cwd: root, codexHome, codexBin: process.env.CODEX_BIN || "codex" },
      )
    : null;
  const app = express();
  app.use(express.json());
  registerGit(app, {
    ...(options.directRead ? { getHost: (id: string) => id === "local" ? { id, name: "Test", kind: "local" as const } : undefined } : {}),
    getBridge: async () =>
      bridge ||
      ({
        request: async (method: string, params: unknown) => {
          if (method === "fs/getMetadata") {
            const stat = await fs.stat((params as { path: string }).path);
            return { isDirectory: stat.isDirectory() };
          }
          assert.equal(method, "command/exec");
          const input = params as Call;
          calls.push(input);
          if (options.unavailableSandbox && input.sandboxPolicy.type !== "dangerFullAccess")
            return { exitCode: 1, stdout: "", stderr: "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces." };
          assert.equal(input.command[0], "git");
          assert.ok(!input.command.includes("/bin/sh"));
          const env = { ...process.env };
          for (const [key, value] of Object.entries(input.env)) {
            if (value === null) delete env[key];
            else env[key] = value;
          }
          try {
            const result = await execute(
              input.command[0]!,
              input.command.slice(1),
              { cwd: input.cwd, env },
            );
            return {
              exitCode: 0,
              stdout: result.stdout,
              stderr: result.stderr,
            };
          } catch (cause) {
            const failure = cause as {
              code: number;
              stdout: string;
              stderr: string;
            };
            return {
              exitCode: failure.code,
              stdout: failure.stdout,
              stderr: failure.stderr,
            };
          }
        },
      } as any),
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
  const get = async (endpoint: string, values: Record<string, string> = {}) => {
    const response = await fetch(
      `${base}/api/git/${endpoint}?${new URLSearchParams({ cwd: root, hostId: "local", ...values })}`,
    );
    return { code: response.status, body: (await response.json()) as any };
  };
  const post = async (
    endpoint: string,
    values: Record<string, unknown> = {},
  ) => {
    const response = await fetch(`${base}/api/git/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: root,
        hostId: "local",
        permission: "workspace-write",
        ...values,
      }),
    });
    return { code: response.status, body: (await response.json()) as any };
  };
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    bridge?.close();
    await fs.rm(directory, { recursive: true, force: true });
  };
  return { directory, root, run, get, post, close, calls };
}

test("Git status/diff/stage and explicit-file commit preserve unrelated staged changes", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "one.txt"), "changed one\n");
    await fs.writeFile(path.join(f.root, "two.txt"), "changed two\n");
    await fs.writeFile(path.join(f.root, "中文 file.txt"), "new content\n");
    const initial = await f.get("status");
    assert.equal(initial.code, 200);
    assert.equal(initial.body.branch, "main");
    assert.equal(initial.body.files.length, 3);
    const diff = await f.get("diff", { file: "one.txt" });
    assert.match(diff.body.diff, /\+changed one/);
    assert.match(diff.body.diff, /-original one/);
    const untracked = await f.get("diff", { file: "中文 file.txt" });
    assert.equal(untracked.code, 200);
    assert.match(untracked.body.diff, /\+new content/);
    assert.equal(
      (await f.post("stage", { files: ["one.txt", "two.txt"] })).code,
      200,
    );
    const staged = await f.get("diff", { file: "one.txt", staged: "true" });
    assert.match(staged.body.diff, /\+changed one/);
    const committed = await f.post("commit", {
      files: ["one.txt"],
      message: "Commit one only",
    });
    assert.equal(committed.code, 200);
    assert.equal((await f.run("show", "HEAD:one.txt")).trim(), "changed one");
    assert.equal((await f.run("show", "HEAD:two.txt")).trim(), "original two");
    assert.equal(
      (await f.run("diff", "--cached", "--name-only")).trim(),
      "two.txt",
    );
    assert.equal((await f.post("unstage", { files: ["two.txt"] })).code, 200);
    assert.equal((await f.run("diff", "--cached", "--name-only")).trim(), "");
    assert.equal(
      await fs.readFile(path.join(f.root, "two.txt"), "utf8"),
      "changed two\n",
    );
    assert.ok(
      f.calls
        .filter((call) => call.command.includes("commit"))
        .every((call) => call.command.includes("--only")),
    );
  } finally {
    await f.close();
  }
});

test("full-access Git uses its selected policy for repository discovery, reads and writes on hosts without namespaces", async () => {
  const f = await fixture(false, { unavailableSandbox: true });
  try {
    await fs.writeFile(path.join(f.root, "one.txt"), "full access change\n");
    assert.equal((await f.get("status", { permission: "danger-full-access" })).code, 200);
    assert.match((await f.get("diff", { file: "one.txt", permission: "danger-full-access" })).body.diff, /\+full access change/);
    assert.equal((await f.post("stage", { files: ["one.txt"], permission: "danger-full-access" })).code, 200);
    assert.ok(f.calls.length > 10);
    assert.ok(f.calls.every(call => call.sandboxPolicy.type === "dangerFullAccess"));
  } finally { await f.close(); }
});

test("backend Git reads work without namespaces while workspace writes fail honestly and readonly mutations stay forbidden", async () => {
  const f = await fixture(false, { directRead: true, unavailableSandbox: true });
  try {
    await fs.writeFile(path.join(f.root, "one.txt"), "read safely\n");
    for (const permission of ["read-only", "workspace-write"]) {
      const status = await f.get("status", { permission });
      assert.equal(status.code, 200, JSON.stringify(status.body));
      assert.equal(status.body.branch, "main");
      const diff = await f.get("diff", { permission, file: "one.txt" });
      assert.equal(diff.code, 200, JSON.stringify(diff.body));
      assert.match(diff.body.diff, /\+read safely/);
    }
    assert.equal(f.calls.length, 0, "fixed backend queries do not create native command/exec jobs");
    const readonly = await f.post("stage", { permission: "read-only", files: ["one.txt"] });
    assert.equal(readonly.code, 403);
    assert.equal(f.calls.length, 0);
    const workspace = await f.post("stage", { files: ["one.txt"] });
    assert.equal(workspace.code, 403);
    assert.match(workspace.body.error, /明确切换到完全访问/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.sandboxPolicy.type, "workspaceWrite");
    assert.equal((await f.run("diff", "--cached", "--name-only")).trim(), "");
    assert.equal((await f.get("status", { hostId: "missing" })).code, 404);
  } finally { await f.close(); }
});

test("Git branches and independent worktrees support paths with spaces", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.post("branch", { branch: "feature/first", create: true })).code,
      200,
    );
    assert.equal(
      (await f.post("branch", { branch: "main" })).body.branch,
      "main",
    );
    const destination = path.join(f.directory, "parallel space");
    const created = await f.post("worktree", {
      path: destination,
      branch: "feature/parallel",
      mode: "new",
    });
    assert.equal(created.code, 201);
    assert.equal(created.body.projectPath, destination);
    assert.ok(
      created.body.worktrees.some(
        (tree: any) =>
          tree.path === destination && tree.branch === "feature/parallel",
      ),
    );
    assert.equal(
      await fs.readFile(path.join(destination, "one.txt"), "utf8"),
      "original one\n",
    );
    const alternate = await f.get("status", { cwd: destination });
    assert.equal(alternate.body.branch, "feature/parallel");
    await fs.writeFile(path.join(destination, "one.txt"), "worktree change\n");
    assert.equal(
      (await f.post("stage", { cwd: destination, files: ["one.txt"] })).code,
      200,
    );
    const call = f.calls.findLast(
      (call) => call.command.includes("add") && call.cwd === destination,
    )!;
    assert.ok(
      call.sandboxPolicy.writableRoots?.includes(path.join(f.root, ".git")),
    );
    assert.equal(
      (
        await f.post("worktree", {
          path: path.join(f.root, "nested"),
          branch: "feature/bad",
        })
      ).code,
      400,
    );
  } finally {
    await f.close();
  }
});

test("Git rejects path traversal, option/ref injection and read-only mutation", async () => {
  const f = await fixture();
  try {
    for (const bad of [
      "../outside",
      "/absolute",
      ".git/config",
      "a/../b",
      "--all",
      ":(top)../outside",
      "a\nb",
    ]) {
      // Git pathspec magic is either a harmless literal filename or rejected; it never expands.
      const result = await f.post("stage", { files: [bad] });
      assert.ok(
        result.code === 400 || result.code === 409,
        `${bad}: ${result.code}`,
      );
    }
    for (const bad of [
      "--detach",
      "a..b",
      "a@{x}",
      "a//b",
      ".hidden",
      "a.lock",
      "a/../b",
    ])
      assert.equal(
        (await f.post("branch", { branch: bad, create: true })).code,
        400,
      );
    assert.equal(
      (await f.post("stage", { files: ["one.txt"], permission: "read-only" }))
        .code,
      403,
    );
    assert.equal(
      (await f.post("commit", { files: [], message: "No selected files" }))
        .code,
      400,
    );
    assert.equal((await f.get("status", { cwd: "relative" })).code, 400);
    assert.equal((await f.run("status", "--porcelain")).trim(), "");
    assert.ok(f.calls.every((call) => call.env.GIT_LITERAL_PATHSPECS === "1"));
  } finally {
    await f.close();
  }
});

test("Git porcelain parsers preserve rename paths and worktree lock metadata", () => {
  const files = parseStatus(
    "R  destination name\0source name\0?? 中文.txt\0UU conflict.txt\0",
  );
  assert.equal(files[0]?.path, "destination name");
  assert.equal(files[0]?.originalPath, "source name");
  assert.equal(files[1]?.untracked, true);
  assert.equal(files[2]?.conflicted, true);
  assert.throws(() => parseStatus(" M partial"), /不完整/);
  const worktrees = parseWorktrees(
    "worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /other space\0HEAD def\0detached\0locked reason\0\0",
  );
  assert.equal(worktrees.length, 2);
  assert.equal(worktrees[0]?.branch, "main");
  assert.equal(worktrees[1]?.detached, true);
  assert.equal(worktrees[1]?.locked, true);
});

test("staged rename commit includes its original path without committing other staged files", async () => {
  const f = await fixture();
  try {
    await f.run("mv", "one.txt", "renamed.txt");
    assert.equal((await f.post("stage", { files: ["renamed.txt"] })).code, 200);
    const diff = await f.get("diff", { file: "renamed.txt", staged: "true" });
    assert.match(diff.body.diff, /rename from one.txt/);
    await fs.writeFile(path.join(f.root, "two.txt"), "other staged change\n");
    await f.run("add", "--", "two.txt");
    const result = await f.post("commit", {
      files: ["renamed.txt"],
      message: "Rename one only",
    });
    assert.equal(result.code, 200, JSON.stringify(result.body));
    assert.equal(
      (await f.run("ls-tree", "--name-only", "HEAD")).trim(),
      "renamed.txt\ntwo.txt",
    );
    assert.equal(
      (await f.run("diff", "--cached", "--name-only")).trim(),
      "two.txt",
    );
  } finally {
    await f.close();
  }
});

test("unstaging an unborn branch preserves content edited after staging", async () => {
  const f = await fixture();
  try {
    await f.run("checkout", "--orphan", "unborn");
    await fs.writeFile(
      path.join(f.root, "one.txt"),
      "preserve working content\n",
    );
    const result = await f.post("unstage", { files: ["one.txt"] });
    assert.equal(result.code, 200, JSON.stringify(result.body));
    assert.equal(
      await fs.readFile(path.join(f.root, "one.txt"), "utf8"),
      "preserve working content\n",
    );
    assert.equal((await f.run("ls-files", "one.txt")).trim(), "");
  } finally {
    await f.close();
  }
});

test(
  "installed app-server executes isolated Git writes and worktree metadata through command/exec",
  {
    skip:
      spawnSync(process.env.CODEX_BIN || "codex", ["--version"], {
        stdio: "ignore",
      }).status !== 0,
    timeout: 30000,
  },
  async () => {
    const f = await fixture(true);
    try {
      assert.equal((await f.get("status")).body.branch, "main");
      await fs.writeFile(path.join(f.root, "one.txt"), "app-server commit\n");
      const staged = await f.post("stage", { files: ["one.txt"] });
      assert.equal(staged.code, 200, JSON.stringify(staged.body));
      const committed = await f.post("commit", {
        files: ["one.txt"],
        message: "App-server test only",
      });
      assert.equal(committed.code, 200, JSON.stringify(committed.body));
      const destination = path.join(f.directory, "app-server worktree");
      const created = await f.post("worktree", {
        path: destination,
        branch: "feature/app-server",
        mode: "new",
      });
      assert.equal(created.code, 201, JSON.stringify(created.body));
      await fs.writeFile(
        path.join(destination, "one.txt"),
        "alternate app-server write\n",
      );
      const alternate = await f.post("stage", {
        cwd: destination,
        files: ["one.txt"],
      });
      assert.equal(alternate.code, 200, JSON.stringify(alternate.body));
      assert.equal(
        await fs.readFile(path.join(f.root, "one.txt"), "utf8"),
        "app-server commit\n",
      );
    } finally {
      await f.close();
    }
  },
);
