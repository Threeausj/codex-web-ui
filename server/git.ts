import path from "node:path";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import type { Bridge, BridgeOptions } from "./bridge.js";
import type { Host } from "./types.js";
import { readHostGit } from "./git-read.js";
import type { CommandExecResponse } from "../shared/protocol/v2/CommandExecResponse.js";

type GitBridge = Pick<Bridge, "request">;
export type GitDependencies = {
  getBridge: (hostId?: string) => Promise<GitBridge>;
  getHost?: (hostId: string) => Host | undefined;
  bridgeOptions?: BridgeOptions;
  busyWorktreeThreads?: (hostId: string, directory: string) => Promise<string[]>;
};
type Permission = "read-only" | "workspace-write" | "danger-full-access";
type Context = { bridge: GitBridge; cwd: string; permission: Permission; read?: (cwd: string, args: string[]) => Promise<CommandExecResponse> };
export type GitFile = {
  path: string;
  originalPath?: string;
  index: string;
  working: string;
  untracked: boolean;
  conflicted: boolean;
};

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value),
    "需要有效的绝对目录",
  );
const scope = z.object({
  hostId: z.string().min(1).max(128).default("local"),
  cwd: absolute,
  permission: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("read-only"),
});
const branch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/, "分支名称含有无效字符")
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.endsWith(".lock") &&
      !value.split("/").some((part) => part.startsWith(".")),
    "无效的分支名称",
  );
const file = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("-") &&
      !/[\x00-\x1f\x7f\\]/.test(value) &&
      !value
        .split("/")
        .some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === ".." ||
            segment.toLowerCase() === ".git",
        ),
    "需要项目内的具体相对文件路径",
  );
const files = z
  .array(file)
  .min(1)
  .max(100)
  .transform((values) => [...new Set(values)]);
const route =
  (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
const error = (message: string, status = 400) =>
  Object.assign(new Error(message), { status });
const MAX_OUTPUT = 2 * 1024 * 1024;

/** Fixed read queries use the backend reader; native writes retain the selected sandbox. */
async function git(
  context: Context,
  args: string[],
  writableRoots?: string[],
  acceptedCodes = [0],
): Promise<CommandExecResponse> {
  const sandboxPolicy =
    context.permission === "danger-full-access"
      ? { type: "dangerFullAccess" }
      : writableRoots
        ? {
          type: "workspaceWrite",
          writableRoots,
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
          }
        : { type: "readOnly", networkAccess: false };
  let result: CommandExecResponse;
  try {
    result =
      !writableRoots && context.read
        ? await context.read(context.cwd, args)
        : (await context.bridge.request("command/exec", {
            command: [
              "git",
              "--no-pager",
              "-c",
              "core.quotePath=false",
              "-c",
              "core.fsmonitor=false",
              ...args,
            ],
            cwd: context.cwd,
            timeoutMs: 30000,
            outputBytesCap: MAX_OUTPUT,
            env: {
              GIT_OPTIONAL_LOCKS: "0",
              GIT_LITERAL_PATHSPECS: "1",
              GIT_TERMINAL_PROMPT: "0",
              GIT_DIR: null,
              GIT_WORK_TREE: null,
              GIT_INDEX_FILE: null,
              GIT_EXTERNAL_DIFF: null,
            },
            sandboxPolicy,
          })) as CommandExecResponse;
  } catch (cause) {
    throwSandboxError(cause, context.permission);
    throw cause;
  }
  if (!acceptedCodes.includes(result.exitCode)) throwSandboxError(result.stderr || result.stdout, context.permission);
  if (!acceptedCodes.includes(result.exitCode))
    throw error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Git 执行失败 (${result.exitCode})`,
      409,
    );
  if (Buffer.byteLength(result.stdout) >= MAX_OUTPUT)
    throw error("Git 输出超过 2 MB，请缩小变更范围后重试", 413);
  return result;
}

function throwSandboxError(cause: unknown, permission: Permission) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!/bwrap.*(?:namespace|operation not permitted|permission)|non-privileged user namespaces|unprivileged_userns_clone/i.test(message)) return;
  throw error(permission === "danger-full-access"
    ? "此主机仍无法执行完全访问的 Git 命令，请检查 Codex 的主机管理策略"
    : "此主机不支持 Codex 的隔离写入沙箱；读取 Git 不受影响，写入需明确切换到完全访问，或由管理员启用用户命名空间", 403);
}

export function parseStatus(source: string): GitFile[] {
  if (source && !source.endsWith("\0"))
    throw error("Git 状态输出不完整，请缩小变更范围", 413);
  const parts = source.split("\0");
  const result: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    const index = record[0] || " ";
    const working = record[1] || " ";
    const item: GitFile = {
      path: record.slice(3),
      index,
      working,
      untracked: index === "?" && working === "?",
      conflicted:
        index === "U" ||
        working === "U" ||
        ["AA", "DD"].includes(`${index}${working}`),
    };
    if (index === "R" || index === "C" || working === "R" || working === "C")
      item.originalPath = parts[++i];
    result.push(item);
  }
  return result;
}

export function parseWorktrees(source: string) {
  const records: {
    path: string;
    head: string;
    branch: string;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
  }[] = [];
  for (const block of source.split("\0\0")) {
    const values = block.split("\0").filter(Boolean);
    const worktree = values.find((value) => value.startsWith("worktree "));
    if (!worktree) continue;
    records.push({
      path: worktree.slice(9),
      head: values.find((value) => value.startsWith("HEAD "))?.slice(5) || "",
      branch: (
        values.find((value) => value.startsWith("branch "))?.slice(7) || ""
      ).replace(/^refs\/heads\//, ""),
      detached: values.includes("detached"),
      locked: values.some((value) => /^locked(?: |$)/.test(value)),
      prunable: values.some((value) => /^prunable(?: |$)/.test(value)),
    });
  }
  return records;
}

async function repository(context: Context) {
  const metadata = (await context.bridge.request("fs/getMetadata", {
    path: context.cwd,
  })) as { isDirectory?: boolean };
  if (!metadata.isDirectory) throw error("项目目录不存在或不是目录");
  let root: string;
  try { root = (await git(context, ["rev-parse", "--show-toplevel"])).stdout.trim(); }
  catch (cause: any) {
    if (/not a git repository/i.test(cause.message))
      throw error(`目录 ${context.cwd} 不是 Git 仓库，请选择仓库目录或其中的子目录。`, 409);
    throw cause;
  }
  if (!root.startsWith("/")) throw error("无法识别 Git 仓库目录");
  context.cwd = root;
  return root;
}
async function mutationRoots(context: Context, extra: string[] = []) {
  if (context.permission === "read-only")
    throw error("当前为只读权限，请切换权限后操作 Git", 403);
  const [common, privateGit] = await Promise.all([
    git(context, ["rev-parse", "--git-common-dir"]),
    git(context, ["rev-parse", "--absolute-git-dir"]),
  ]);
  // Linked worktrees keep their index under the main repository. Grant the
  // exact administrative directory as well as the shared refs directory.
  return [
    ...new Set([
      context.cwd,
      path.posix.resolve(context.cwd, common.stdout.trim()),
      path.posix.resolve(context.cwd, privateGit.stdout.trim()),
      ...extra,
    ]),
  ];
}
async function contextFor(
  deps: GitDependencies,
  input: unknown,
): Promise<Context> {
  const parsed = scope.parse(input);
  const context: Context = {
    bridge: await deps.getBridge(parsed.hostId),
    cwd: path.posix.normalize(parsed.cwd),
    permission: parsed.permission,
  };
  if (deps.getHost) {
    const host = deps.getHost(parsed.hostId);
    if (!host) throw error("主机不存在", 404);
    context.read = (cwd, args) => readHostGit(host, cwd, args, deps.bridgeOptions);
  }
  await repository(context);
  return context;
}
async function assertBranch(context: Context, name: string) {
  await git(context, ["check-ref-format", "--branch", branch.parse(name)]);
}
async function selectedPaths(context: Context, selected: string[]) {
  const changed = parseStatus(
    (
      await git(context, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
      ])
    ).stdout,
  );
  // A staged rename is one logical row. Include its old path so reset/commit
  // does not leave an unrelated-looking deletion in the index.
  const originals = changed
    .filter((item) => selected.includes(item.path) && item.originalPath)
    .map((item) => file.parse(item.originalPath));
  return [...new Set([...selected, ...originals])];
}
async function status(context: Context) {
  const [current, head, changed, branches, worktrees] = await Promise.all([
    git(
      context,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      undefined,
      [0, 1],
    ),
    git(context, ["rev-parse", "--verify", "HEAD"], undefined, [0, 128]),
    git(context, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
    ]),
    git(context, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    git(context, ["worktree", "list", "--porcelain", "-z"]),
  ]);
  return {
    root: context.cwd,
    branch: current.stdout.trim(),
    head: head.exitCode === 0 ? head.stdout.trim() : "",
    files: parseStatus(changed.stdout),
    branches: branches.stdout.split("\n").filter(Boolean),
    worktrees: parseWorktrees(worktrees.stdout),
  };
}

export function registerGit(app: Express, deps: GitDependencies) {
  app.get(
    "/api/git/status",
    route(async (req, res) =>
      res.json(await status(await contextFor(deps, req.query))),
    ),
  );
  app.get(
    "/api/git/diff",
    route(async (req, res) => {
      const context = await contextFor(deps, req.query);
      const input = z
        .object({ file, staged: z.enum(["true", "false"]).default("false") })
        .parse(req.query);
      const changed = parseStatus(
        (
          await git(context, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
          ])
        ).stdout,
      );
      const isUntracked = changed.some(
        (item) => item.path === input.file && item.untracked,
      );
      // --no-index includes newly created text files without staging them.
      const args =
        isUntracked && input.staged !== "true"
          ? [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-index",
              "--",
              "/dev/null",
              input.file,
            ]
          : [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              ...(input.staged === "true" ? ["--cached"] : []),
              "--",
              input.file,
              ...changed
                .filter((item) => item.path === input.file && item.originalPath)
                .map((item) => file.parse(item.originalPath)),
            ];
      const result = await git(
        context,
        args,
        undefined,
        isUntracked ? [0, 1] : [0],
      );
      res.json({
        path: input.file,
        staged: input.staged === "true",
        diff: result.stdout,
      });
    }),
  );
  app.post(
    "/api/git/stage",
    route(async (req, res) => {
      const context = await contextFor(deps, req.body);
      const selected = files.parse(req.body.files);
      const roots = await mutationRoots(context);
      await git(context, ["add", "--", ...selected], roots);
      res.json(await status(context));
    }),
  );
  app.post(
    "/api/git/unstage",
    route(async (req, res) => {
      const context = await contextFor(deps, req.body);
      const selected = files.parse(req.body.files);
      const roots = await mutationRoots(context);
      const head = await git(
        context,
        ["rev-parse", "--verify", "HEAD"],
        undefined,
        [0, 128],
      );
      const targets = await selectedPaths(context, selected);
      await git(
        context,
        head.exitCode === 0
          ? ["reset", "--quiet", "HEAD", "--", ...targets]
          : ["rm", "--cached", "--force", "--", ...targets],
        roots,
      );
      res.json(await status(context));
    }),
  );
  app.post(
    "/api/git/commit",
    route(async (req, res) => {
      const context = await contextFor(deps, req.body);
      const input = z
        .object({
          files,
          message: z
            .string()
            .trim()
            .min(1)
            .max(4000)
            .refine((value) => !value.includes("\0"), "提交说明不能包含空字符"),
        })
        .parse(req.body);
      const roots = await mutationRoots(context);
      // --only commits exactly the named files, preserving every unrelated staged file.
      const result = await git(
        context,
        [
          "commit",
          "--only",
          "-m",
          input.message,
          "--",
          ...(await selectedPaths(context, input.files)),
        ],
        roots,
      );
      res.json({ ...(await status(context)), output: result.stdout });
    }),
  );
  app.post(
    "/api/git/branch",
    route(async (req, res) => {
      const context = await contextFor(deps, req.body);
      const input = z
        .object({ branch, create: z.boolean().default(false) })
        .parse(req.body);
      const roots = await mutationRoots(context);
      await assertBranch(context, input.branch);
      await git(
        context,
        ["switch", ...(input.create ? ["-c"] : []), input.branch],
        roots,
      );
      res.json(await status(context));
    }),
  );
  app.post(
    "/api/git/worktree",
    route(async (req, res) => {
      const context = await contextFor(deps, req.body);
      const input = z
        .object({
          path: absolute,
          branch,
          mode: z.enum(["new", "existing"]).default("new"),
          startPoint: branch.optional(),
        })
        .parse(req.body);
      const destination = path.posix.normalize(input.path);
      if (
        destination === "/" ||
        destination === context.cwd ||
        destination.startsWith(`${context.cwd}/`) ||
        context.cwd.startsWith(`${destination}/`)
      )
        throw error("工作树应创建在当前项目之外的独立目录");
      const roots = await mutationRoots(context, [
        path.posix.dirname(destination),
      ]);
      await assertBranch(context, input.branch);
      if (input.startPoint) await assertBranch(context, input.startPoint);
      const parent = (await context.bridge.request("fs/getMetadata", {
        path: path.posix.dirname(destination),
      })) as { isDirectory?: boolean };
      if (!parent.isDirectory) throw error("工作树的父目录不存在");
      await git(
        context,
        [
          "worktree",
          "add",
          ...(input.mode === "new" ? ["-b", input.branch] : []),
          "--",
          destination,
          input.mode === "new" ? input.startPoint || "HEAD" : input.branch,
        ],
        roots,
      );
      res
        .status(201)
        .json({ ...(await status(context)), projectPath: destination });
    }),
  );
  app.get('/api/git/review-options', route(async (req, res) => {
    const context = await contextFor(deps, req.query);
    const [branches, commits] = await Promise.all([
      git(context, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
      git(context, ['log', '-30', '--format=%H%x00%s', '--no-decorate'], undefined, [0, 128]),
    ]);
    res.json({ root: context.cwd, branches: branches.stdout.split('\n').filter(value => value && !value.endsWith('/HEAD')), commits: commits.exitCode === 0 ? commits.stdout.split('\n').filter(Boolean).map(value => { const [sha, ...title] = value.split('\0'); return { sha, title: title.join('\0') }; }) : [] });
  }));
  app.post('/api/git/worktree/remove', route(async (req, res) => {
    const context = await contextFor(deps, req.body);
    const input = z.object({ path: absolute }).parse(req.body);
    const destination = path.posix.normalize(input.path);
    const trees = parseWorktrees((await git(context, ['worktree', 'list', '--porcelain', '-z'])).stdout);
    const tree = trees.find(entry => entry.path === destination);
    if (!tree) throw error('工作树不存在或已被其他程序移除', 404);
    if (destination === context.cwd || destination === trees[0]?.path) throw error('请切换到主仓库后清理其他工作树；不能删除主仓库或当前目录', 409);
    if (tree.locked || tree.prunable) throw error('工作树已锁定或状态异常，请先在终端检查', 409);
    const active = await deps.busyWorktreeThreads?.(scope.parse(req.body).hostId, destination) || [];
    if (active.length) throw error('此工作树仍有正在运行的 Web 会话，请等待完成或先释放会话', 409);
    const changed = await git({ ...context, cwd: destination }, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
    if (changed.stdout) throw error('工作树有未提交或未跟踪文件，清理前请提交或另行保留这些改动', 409);
    const roots = await mutationRoots(context, [path.posix.dirname(destination)]);
    // No --force: Git rechecks dirty/locked state at removal time.
    await git(context, ['worktree', 'remove', '--', destination], roots);
    res.json({ ...(await status(context)), removedPath: destination });
  }));
}
