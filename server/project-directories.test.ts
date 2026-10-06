import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import express from "express";
import { Auth } from "./auth.js";
import { Bridge, type Transport } from "./bridge.js";
import type { Host } from "./types.js";
import { registerProjectDirectories } from "./project-directories.js";

type Call = { hostId: string; method: string; params: any };
const hosts: Host[] = [
  { id: "local", name: "Local", kind: "local" },
  {
    id: "remote",
    name: "Remote",
    kind: "ssh",
    hostname: "not-used.invalid",
    cwd: "/remote/default",
  },
  {
    id: "remote-root",
    name: "Remote root",
    kind: "ssh",
    hostname: "not-used.invalid",
  },
  {
    id: "local-configured",
    name: "Configured local",
    kind: "local",
    cwd: "/configured/local",
  },
];
async function fixture(
  handler?: (call: Call) => Promise<unknown>,
  overrides: { cwd?: string; hosts?: Host[] } = {},
) {
  const calls: Call[] = [];
  const selectedHosts: string[] = [];
  const app = express();
  const auth = new Auth("directory-test-password-only", new Set());
  app.use(express.json());
  app.post("/api/auth/login", auth.login);
  app.use("/api", auth.requireAuth, auth.requireCsrf);
  registerProjectDirectories(app, {
    cwd: overrides.cwd || "/local/default",
    storage: {
      host: (id) => (overrides.hosts || hosts).find((host) => host.id === id),
    },
    getBridge: async (hostId) => {
      selectedHosts.push(hostId);
      return {
        request: async (method, params) => {
          const call = { hostId, method, params };
          calls.push(call);
          if (handler) return handler(call);
          if (method === "fs/getMetadata")
            return { isDirectory: true, isFile: false };
          assert.equal(method, "fs/readDirectory");
          return { entries: [] };
        },
      };
    },
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "directory-test-password-only" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  await login.json();
  return {
    calls,
    selectedHosts,
    get: (hostId: string, query = "", authenticated = true) =>
      fetch(
        `${base}/api/hosts/${encodeURIComponent(hostId)}/directories${query}`,
        { headers: authenticated ? { cookie } : {} },
      ),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

test("directory browsing requires authentication and reads only the requested host's explicit directory entries", async (t) => {
  const entry = (fileName: string, isDirectory: unknown, isFile = false) => ({
    fileName,
    isDirectory,
    isFile,
  });
  const endpoint = await fixture(async ({ method, params }) => {
    assert.deepEqual(params, { path: "/项目" });
    if (method === "fs/getMetadata")
      return { isDirectory: true, isFile: false };
    return {
      entries: [
        entry("资料", true),
        entry("项目10", true),
        entry("项目2", true),
        entry("A.txt", false, true),
        entry("wrong type", "true"),
        { fileName: "legacy", type: "directory" },
        entry("/absolute", true),
        entry("../escape", true),
        entry(".", true),
        entry("..", true),
        entry("", true),
        entry("control\nname", true),
      ],
    };
  });
  t.after(endpoint.close);
  assert.equal(
    (await endpoint.get("remote", "?path=%2F%E9%A1%B9%E7%9B%AE", false)).status,
    401,
  );
  assert.deepEqual(endpoint.selectedHosts, []);
  // Authenticated GETs inherit the global CSRF exemption for read-only routes.
  const response = await endpoint.get(
    "remote",
    `?${new URLSearchParams({ path: "//项目/./sub/../" })}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    path: "/项目",
    entries: [
      { fileName: "项目2", isDirectory: true },
      { fileName: "项目10", isDirectory: true },
      { fileName: "资料", isDirectory: true },
    ],
  });
  assert.deepEqual(endpoint.selectedHosts, ["remote"]);
  assert.deepEqual(
    endpoint.calls.map(({ hostId, method }) => [hostId, method]),
    [
      ["remote", "fs/getMetadata"],
      ["remote", "fs/readDirectory"],
    ],
  );
});

test("directory defaults use configured host cwd, local server cwd or remote root without executing a shell", async (t) => {
  const endpoint = await fixture();
  t.after(endpoint.close);
  for (const [hostId, expected] of [
    ["local", "/local/default"],
    ["remote", "/remote/default"],
    ["remote-root", "/"],
    ["local-configured", "/configured/local"],
  ]) {
    const response = await endpoint.get(hostId);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: expected, entries: [] });
  }
  assert.ok(
    endpoint.calls.every(({ method }) =>
      ["fs/getMetadata", "fs/readDirectory"].includes(method),
    ),
  );
  const before = endpoint.selectedHosts.length;
  assert.equal((await endpoint.get("missing")).status, 404);
  assert.equal(endpoint.selectedHosts.length, before);
});

test("strict directory queries reject relative, control-character, repeated and extra parameters before connecting", async (t) => {
  const endpoint = await fixture();
  t.after(endpoint.close);
  const invalid = [
    "?path=relative",
    "?path=",
    "?path=C%3A%5Cproject",
    "?path=%2Fproject%00",
    "?path=%2Fproject%0A",
    "?path=%2Fproject%7F",
    "?path=%2Fproject%C2%85",
    "?path=%2Fa&path=%2Fb",
    "?path=%2Fa&hostId=local",
    "?path%5Bname%5D=%2Fa",
    `?path=${encodeURIComponent("/" + "a".repeat(4096))}`,
  ];
  for (const query of invalid) {
    const response = await endpoint.get("remote", query);
    assert.equal(response.status, 400, query.slice(0, 80));
    assert.match((await response.json()).error, /目录参数/);
  }
  assert.deepEqual(endpoint.selectedHosts, []);
  assert.deepEqual(endpoint.calls, []);
});

test("file paths and malformed protocol responses are rejected while a directory symlink can be browsed", async (t) => {
  const endpoint = await fixture(async ({ method, params }) => {
    if (method === "fs/getMetadata") {
      if (params.path === "/file") return { isDirectory: false, isFile: true };
      if (params.path === "/bad-metadata") return { isFile: false };
      return {
        isDirectory: true,
        isFile: false,
        isSymlink: params.path === "/link",
      };
    }
    return params.path === "/bad-list"
      ? { entries: null }
      : { entries: [{ fileName: "child", isDirectory: true, isFile: false }] };
  });
  t.after(endpoint.close);
  for (const [directory, status] of [
    ["/file", 400],
    ["/bad-metadata", 502],
    ["/bad-list", 502],
  ] as const) {
    assert.equal(
      (await endpoint.get("remote", `?path=${directory}`)).status,
      status,
    );
  }
  assert.equal(
    endpoint.calls.some(
      ({ method, params }) =>
        method === "fs/readDirectory" && params.path === "/file",
    ),
    false,
  );
  const response = await endpoint.get("remote", "?path=/link");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).entries, [
    { fileName: "child", isDirectory: true },
  ]);
  const invalidDefault = await fixture(undefined, {
    hosts: [{ id: "bad", name: "Bad", kind: "ssh", cwd: "relative" }],
  });
  t.after(invalidDefault.close);
  assert.equal((await invalidDefault.get("bad")).status, 400);
  assert.deepEqual(invalidDefault.selectedHosts, []);
});

test("directory errors distinguish missing paths, permissions, connectivity, timeout and unsupported RPC without leaking secrets", async (t) => {
  let failure: unknown;
  const endpoint = await fixture(async () => {
    throw failure;
  });
  t.after(endpoint.close);
  const cases: [unknown, number, RegExp][] = [
    [
      new Error("ENOENT: /private/token-secret No such file or directory"),
      404,
      /目录不存在/,
    ],
    [new Error("ENOTDIR /private/token-secret"), 400, /不是文件夹/],
    [
      new Error("EACCES Permission denied /private/token-secret"),
      403,
      /目录权限/,
    ],
    [
      new Error("EPERM Operation not permitted /private/token-secret"),
      403,
      /目录权限/,
    ],
    [
      new Error(
        "private-user@host: Permission denied (publickey). token-secret",
      ),
      502,
      /SSH/,
    ],
    [new Error("Connection refused private-host token-secret"), 502, /连接/],
    [new Error("spawn /private/token-secret/codex ENOENT"), 502, /Codex/],
    [new Error("App-server request timed out token-secret"), 504, /超时/],
    [
      Object.assign(new Error("token-secret unsupported operation"), {
        rpc: { code: -32601 },
      }),
      502,
      /版本不支持/,
    ],
    [
      new Error("Unknown method private-method token-secret"),
      502,
      /版本不支持/,
    ],
    [new Error("unclassified token-secret failure"), 502, /无法读取/],
  ];
  for (const [error, status, expected] of cases) {
    failure = error;
    const response = await endpoint.get("remote", "?path=/project");
    assert.equal(response.status, status);
    const body = await response.json();
    assert.match(body.error, expected);
    assert.doesNotMatch(
      JSON.stringify(body),
      /token-secret|private-user|private-host|private-method/,
    );
  }
});

const codexBin = process.env.CODEX_BIN || "codex";
const hasCodex =
  spawnSync(codexBin, ["--version"], { stdio: "ignore" }).status === 0;
test(
  "an isolated real app-server browses Chinese directories using only official filesystem RPCs and creates no model turns",
  { skip: !hasCodex, timeout: 20_000 },
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-directory-read-"),
    );
    const codexHome = path.join(directory, "isolated-codex-home");
    const target = path.join(directory, "中文工作区");
    await fs.mkdir(codexHome);
    await fs.mkdir(target);
    await fs.mkdir(path.join(target, "资料"));
    await fs.mkdir(path.join(target, "项目"));
    await fs.writeFile(path.join(target, "文件.txt"), "仅目录浏览");
    await fs.symlink(path.join(target, "资料"), path.join(target, "目录链接"));
    const env = { ...process.env, CODEX_HOME: codexHome };
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ACCESS_TOKEN"])
      delete env[key as keyof typeof env];
    let child: ChildProcessWithoutNullStreams | undefined;
    const bridge = new Bridge(
      { id: "local", name: "Local", kind: "local" },
      {
        transportFactory: (): Transport => {
          child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
            cwd: target,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.stderr.resume();
          const events = new EventEmitter();
          child.on("error", (error) => events.emit("transportError", error));
          child.on("close", () =>
            events.emit(
              "transportClose",
              new Error("App-server subprocess closed"),
            ),
          );
          return {
            input: child.stdin,
            output: child.stdout,
            events,
            dispose: () => {
              child?.stdin.end();
              child?.kill("SIGTERM");
            },
          };
        },
      },
    );
    const endpoint = await fixture(
      ({ method, params }) => bridge.request(method, params),
      { cwd: target },
    );
    try {
      const response = await endpoint.get("local");
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.path, target);
      assert.deepEqual(
        new Set(body.entries.map((entry: any) => entry.fileName)),
        new Set(["资料", "项目", "目录链接"]),
      );
      assert.deepEqual(
        endpoint.calls.map(({ method }) => method),
        ["fs/getMetadata", "fs/readDirectory"],
      );
      assert.equal(
        await fs.access(path.join(codexHome, "sessions")).then(
          () => true,
          () => false,
        ),
        false,
      );
    } finally {
      await endpoint.close();
      bridge.close("Directory test complete");
      if (child && child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => {
          const force = setTimeout(() => child?.kill("SIGKILL"), 1500);
          child!.once("exit", () => {
            clearTimeout(force);
            resolve();
          });
        });
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
