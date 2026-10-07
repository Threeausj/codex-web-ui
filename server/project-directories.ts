import path from "node:path";
import type { Express } from "express";
import { z } from "zod";
import type { FsReadDirectoryEntry } from "../shared/protocol/v2/FsReadDirectoryEntry.js";
import type { Bridge } from "./bridge.js";
import type { Storage } from "./storage.js";

export type ProjectDirectoriesOptions = {
  getBridge: (hostId: string) => Promise<Pick<Bridge, "request">>;
  storage: Pick<Storage, "host">;
  cwd: string;
};
export type ProjectDirectoryResult = {
  path: string;
  entries: { fileName: string; isDirectory: boolean }[];
};
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      path.posix.isAbsolute(value) && !/[\x00-\x1f\x7f-\x9f]/.test(value),
    "请提供绝对目录路径，且不能包含控制字符。",
  );
const query = z
  .object({
    path: absolutePath.optional(),
    // The shared browser HTTP client adds this nonce to private GET requests.
    _request: z.string().uuid().optional(),
  })
  .strict();
const collator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});
function normalize(value: string) {
  const normalized = path.posix.normalize(value);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}
function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value &&
    value !== "." &&
    value !== ".." &&
    !/[\/\x00-\x1f\x7f-\x9f]/.test(value)
  );
}
function failure(error: unknown) {
  const value = error as {
    message?: unknown;
    status?: number;
    rpc?: { code?: number };
  } | null;
  const message =
    typeof value?.message === "string" ? value.message.slice(-16_384) : "";
  if (value?.status === 404 && /host not found/i.test(message))
    return { status: 404, error: "主机不存在，请刷新主机列表。" };
  if (/timed? out|timeout|超时/i.test(message))
    return { status: 504, error: "读取目录超时，请检查目标主机连接后重试。" };
  if (
    /permission denied \(|authentication failed|host key verification|could not resolve hostname|connection refused|no route to host|network is unreachable|app-server subprocess closed|app-server exited|spawn .+ ENOENT|Codex was not found|远端未找到 Codex/i.test(
      message,
    )
  )
    return {
      status: 502,
      error: "无法连接目标主机，请检查 SSH 连接和 Codex 启动配置。",
    };
  if (
    value?.rpc?.code === -32601 ||
    /method not found|unknown method|unrecognized method/i.test(message)
  )
    return {
      status: 502,
      error: "目标主机的 Codex 版本不支持目录浏览，请更新后重试。",
    };
  if (/ENOTDIR|not a directory|os error 20/i.test(message))
    return { status: 400, error: "请选择目录，当前路径不是文件夹。" };
  if (/ENOENT|no such file or directory|os error 2\b/i.test(message))
    return { status: 404, error: "目录不存在，请检查目标主机上的路径。" };
  if (
    /EACCES|EPERM|permission denied|operation not permitted|os error (?:1|13)\b/i.test(
      message,
    )
  )
    return {
      status: 403,
      error: "无法读取此目录，请检查目标主机上的目录权限。",
    };
  return {
    status: 502,
    error: "无法读取目标主机目录，请检查连接、目录权限和 Codex 版本。",
  };
}

/** Read target-host directories through its official bridge without changing chats.
 * Register after the application's shared authentication middleware. */
export function registerProjectDirectories(
  app: Express,
  options: ProjectDirectoriesOptions,
) {
  app.get("/api/hosts/:hostId/directories", (req, res) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "目录参数格式不正确：只允许一个绝对 path，且不能包含控制字符。",
      });
      return;
    }
    const hostId = String(req.params.hostId);
    const host = options.storage.host(hostId);
    if (!host) {
      res.status(404).json({ error: "主机不存在，请刷新主机列表。" });
      return;
    }
    const requested =
      parsed.data.path ??
      (host.cwd || (host.kind === "local" ? options.cwd : "/"));
    if (!absolutePath.safeParse(requested).success) {
      res
        .status(400)
        .json({ error: "主机默认目录无效，请修改连接配置中的工作目录。" });
      return;
    }
    const directory = normalize(requested);
    void (async () => {
      const bridge = await options.getBridge(hostId);
      const metadata = (await bridge.request("fs/getMetadata", {
        path: directory,
      })) as { isDirectory?: unknown };
      if (!metadata || typeof metadata.isDirectory !== "boolean") {
        res
          .status(502)
          .json({ error: "目标主机返回的目录信息无效，请检查 Codex 版本。" });
        return;
      }
      if (!metadata.isDirectory) {
        res.status(400).json({ error: "请选择目录，当前路径不是文件夹。" });
        return;
      }
      const result = (await bridge.request("fs/readDirectory", {
        path: directory,
      })) as { entries?: FsReadDirectoryEntry[] };
      if (!result || !Array.isArray(result.entries)) {
        res
          .status(502)
          .json({ error: "目标主机返回的目录列表无效，请检查 Codex 版本。" });
        return;
      }
      const entries = result.entries
        .filter(
          (entry) => entry?.isDirectory === true && validName(entry.fileName),
        )
        .map((entry) => ({ fileName: entry.fileName, isDirectory: true }))
        .sort(
          (left, right) =>
            collator.compare(left.fileName, right.fileName) ||
            left.fileName.localeCompare(right.fileName),
        );
      res.json({ path: directory, entries } satisfies ProjectDirectoryResult);
    })().catch((error: unknown) => {
      const result = failure(error);
      res.status(result.status).json({ error: result.error });
    });
  });
}
