import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "./app.js";
import { Storage } from "./storage.js";
import type { Transport } from "./bridge.js";
import type { Host, Project, RpcMessage } from "./types.js";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-projects-"));
  const cwd = path.join(directory, "workspace");
  const codexHome = path.join(directory, "codex-home");
  const dataDir = path.join(directory, "web-data");
  const projectPath = path.join(directory, "desktop-project");
  const extraPath = path.join(directory, "shared-root");
  const otherPath = path.join(directory, "other-project");
  await Promise.all(
    [cwd, codexHome, projectPath, extraPath, otherPath].map((directory) =>
      fs.mkdir(directory),
    ),
  );
  const desktopFile = path.join(codexHome, ".codex-global-state.json");
  const desktopContent =
    JSON.stringify(
      {
        "local-projects": [
          {
            id: "desktop-original",
            name: "Desktop Project",
            rootPaths: [projectPath, extraPath],
          },
        ],
        "electron-persisted-atom-state": {
          "unrelated-private-atom": "must remain untouched",
        },
      },
      null,
      2,
    ) + "\n";
  await fs.writeFile(desktopFile, desktopContent);
  await fs.writeFile(
    path.join(projectPath, "README.md"),
    "test file, not a project directory",
  );
  const storage = new Storage(dataDir, codexHome, cwd);
  await storage.init();
  const restart = async () => {
    const restored = new Storage(dataDir, codexHome, cwd);
    await restored.init();
    return restored;
  };
  return {
    directory,
    cwd,
    codexHome,
    dataDir,
    projectPath,
    extraPath,
    otherPath,
    desktopFile,
    desktopContent,
    storage,
    restart,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const byScope = (projects: Project[], hostId: string, projectPath: string) =>
  projects.find(
    (project) => project.hostId === hostId && project.path === projectPath,
  );

test("project edits persist web overrides while preserving desktop metadata and other web projects", async () => {
  const item = await fixture();
  try {
    const web = await item.storage.addProject(
      "local",
      item.otherPath,
      "Web Project",
    );
    const imported = byScope(
      await item.storage.projects(),
      "local",
      item.projectPath,
    )!;
    assert.equal(imported.source, "desktop");
    const renamed = await item.storage.updateProject(
      "local",
      item.projectPath,
      { name: "Web Display Name" },
    );
    assert.equal(renamed.id, "desktop-original");
    assert.equal(renamed.source, "web");
    assert.deepEqual(renamed.rootPaths, [item.projectPath, item.extraPath]);
    await item.storage.updateProject("local", web.path, {
      name: "Edited Web Project",
      rootPaths: [item.extraPath, item.extraPath],
    });
    const restored = await item.restart();
    assert.equal(
      byScope(await restored.projects(), "local", item.projectPath)?.name,
      "Web Display Name",
    );
    assert.deepEqual(
      byScope(await restored.projects(), "local", web.path)?.rootPaths,
      [web.path, item.extraPath],
    );
    assert.equal(
      byScope(await restored.projects(), "local", web.path)?.name,
      "Edited Web Project",
    );
    assert.equal(
      await fs.readFile(item.desktopFile, "utf8"),
      item.desktopContent,
    );
    assert.equal(
      (await fs.stat(path.join(item.dataDir, "projects.json"))).mode & 0o777,
      0o600,
    );
    await assert.rejects(
      item.storage.updateProject("local", "/missing-project", {
        name: "Absent",
      }),
      (error) => (error as any).status === 404,
    );
  } finally {
    await fs.rm(item.directory, { recursive: true, force: true });
  }
});

test("removed desktop, web and automatic cwd projects stay hidden after restart without deleting files", async () => {
  const item = await fixture();
  try {
    await item.storage.addProject("local", item.otherPath, "Web Project");
    await Promise.all(
      [item.projectPath, item.otherPath, item.cwd].map((projectPath) =>
        item.storage.removeProject("local", projectPath),
      ),
    );
    assert.equal((await item.storage.projects()).length, 0);
    const restored = await item.restart();
    assert.equal((await restored.projects()).length, 0);
    assert.equal(
      await fs.readFile(item.desktopFile, "utf8"),
      item.desktopContent,
    );
    assert.equal(
      await fs.readFile(path.join(item.projectPath, "README.md"), "utf8"),
      "test file, not a project directory",
    );
    assert.equal((await fs.stat(item.otherPath)).isDirectory(), true);
    await assert.rejects(
      restored.removeProject("local", item.projectPath),
      (error) => (error as any).status === 404,
    );
  } finally {
    await fs.rm(item.directory, { recursive: true, force: true });
  }
});

test("concurrent edits preserve independent changes and identical paths remain isolated by host", async () => {
  const item = await fixture();
  try {
    const remote = await item.storage.addHost({
      name: "Remote",
      hostname: "server.invalid",
    });
    await item.storage.addProject(
      remote.id,
      item.projectPath,
      "Remote Project",
      [item.otherPath],
    );
    await item.storage.addProject("local", item.otherPath, "Other Project");
    await Promise.all([
      item.storage.updateProject("local", item.projectPath, {
        name: "Local renamed",
      }),
      item.storage.updateProject("local", item.projectPath, { rootPaths: [] }),
      item.storage.updateProject(remote.id, item.projectPath, {
        name: "Remote renamed",
      }),
      item.storage.updateProject("local", item.otherPath, {
        rootPaths: [item.extraPath],
      }),
    ]);
    const restored = await item.restart();
    const projects = await restored.projects();
    assert.equal(
      byScope(projects, "local", item.projectPath)?.name,
      "Local renamed",
    );
    assert.deepEqual(byScope(projects, "local", item.projectPath)?.rootPaths, [
      item.projectPath,
    ]);
    assert.equal(
      byScope(projects, remote.id, item.projectPath)?.name,
      "Remote renamed",
    );
    assert.deepEqual(
      byScope(projects, remote.id, item.projectPath)?.rootPaths,
      [item.projectPath, item.otherPath],
    );
    assert.deepEqual(byScope(projects, "local", item.otherPath)?.rootPaths, [
      item.otherPath,
      item.extraPath,
    ]);
    await restored.removeProject(remote.id, item.projectPath);
    assert.equal(
      byScope(await restored.projects(), remote.id, item.projectPath),
      undefined,
    );
    assert.equal(
      byScope(await restored.projects(), "local", item.projectPath)?.name,
      "Local renamed",
    );
  } finally {
    await fs.rm(item.directory, { recursive: true, force: true });
  }
});

type MetadataRead = { hostId: string; path: string };
function metadataTransport(host: Host, reads: MetadataRead[]): Transport {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = "";
  const reply = async (message: RpcMessage) => {
    if (message.id === undefined) return;
    try {
      let result: unknown = {};
      if (message.method === "initialize")
        result = { userAgent: "project-test" };
      else if (message.method === "fs/getMetadata") {
        const projectPath = (message.params as { path: string }).path;
        reads.push({ hostId: host.id, path: projectPath });
        const stat = await fs.stat(projectPath);
        result = { isDirectory: stat.isDirectory(), isFile: stat.isFile() };
      } else throw new Error(`Unexpected project RPC: ${message.method}`);
      output.write(JSON.stringify({ id: message.id, result }) + "\n");
    } catch (error) {
      output.write(
        JSON.stringify({
          id: message.id,
          error: { code: -32000, message: (error as Error).message },
        }) + "\n",
      );
    }
  };
  input.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, newline)) as RpcMessage;
      buffer = buffer.slice(newline + 1);
      void reply(message);
    }
  });
  return {
    input,
    output,
    events: new EventEmitter(),
    dispose: () => {
      input.destroy();
      output.destroy();
    },
  };
}
async function apiFixture(item: Fixture) {
  const reads: MetadataRead[] = [];
  const password = "project-api-test-password-123";
  const application = await createServer({
    cwd: item.cwd,
    dataDir: item.dataDir,
    codexHome: item.codexHome,
    password,
    serveStatic: false,
    secureCookie: false,
    bridgeOptions: {
      mode: "spawn",
      transportFactory: (host) => metadataTransport(host, reads),
    },
  });
  await new Promise<void>((resolve) =>
    application.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`;
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const headers = {
    "content-type": "application/json",
    cookie,
    "x-csrf-token": csrfToken,
  };
  const request = (
    method: string,
    body: unknown,
    overrides: Record<string, string> = headers,
  ) =>
    fetch(base + "/api/projects", {
      method,
      headers: overrides,
      body: JSON.stringify(body),
    });
  return { application, base, cookie, headers, request, reads };
}

test("project PATCH and DELETE require auth and CSRF, respect host/path scope, and POST restores removed desktop projects", async () => {
  const item = await fixture();
  const api = await apiFixture(item);
  try {
    const body = { hostId: "local", path: item.projectPath, name: "Edited" };
    for (const method of ["PATCH", "DELETE"]) {
      const fields =
        method === "PATCH" ? body : { hostId: body.hostId, path: body.path };
      assert.equal(
        (
          await api.request(method, fields, {
            "content-type": "application/json",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await api.request(method, fields, {
            "content-type": "application/json",
            cookie: api.cookie,
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (await api.request("PATCH", { ...body, hostId: "missing-host" })).status,
      404,
    );
    assert.equal(
      (
        await api.request("DELETE", {
          hostId: "missing-host",
          path: item.projectPath,
        })
      ).status,
      404,
    );
    assert.equal(
      (await api.request("PATCH", { ...body, path: item.otherPath })).status,
      404,
    );
    assert.equal(
      (await api.request("PATCH", { ...body, source: "desktop" })).status,
      400,
    );
    assert.equal(
      (await api.request("PATCH", { path: item.projectPath })).status,
      400,
    );
    assert.equal(
      (
        await api.request("DELETE", {
          path: item.projectPath,
          hostId: "local",
          id: "other",
        })
      ).status,
      400,
    );
    const edited = await api.request("PATCH", body);
    assert.equal(edited.status, 200);
    assert.equal(
      ((await edited.json()) as { project: Project }).project.name,
      "Edited",
    );
    assert.equal(
      api.reads.length,
      0,
      "renaming uses stored metadata and does not connect to a host",
    );
    const remote = await api.application.storage.addHost({
      name: "Remote",
      hostname: "server.invalid",
    });
    const addedRemote = await api.request("POST", {
      hostId: remote.id,
      path: item.projectPath,
      name: "Remote Project",
    });
    assert.equal(addedRemote.status, 201);
    const removed = await api.request("DELETE", {
      hostId: "local",
      path: item.projectPath,
    });
    assert.equal(removed.status, 200);
    const remaining = ((await removed.json()) as { projects: Project[] })
      .projects;
    assert.equal(byScope(remaining, "local", item.projectPath), undefined);
    assert.equal(
      byScope(remaining, remote.id, item.projectPath)?.name,
      "Remote Project",
    );
    const restarted = await item.restart();
    assert.equal(
      byScope(await restarted.projects(), "local", item.projectPath),
      undefined,
    );
    assert.equal(
      (await api.request("DELETE", { hostId: "local", path: item.projectPath }))
        .status,
      404,
    );
    const readded = await api.request("POST", {
      hostId: "local",
      path: item.projectPath,
      name: "Restored Project",
    });
    assert.equal(readded.status, 201);
    const restored = await item.restart();
    assert.equal(
      byScope(await restored.projects(), "local", item.projectPath)?.name,
      "Restored Project",
    );
    assert.equal(
      byScope(await restored.projects(), remote.id, item.projectPath)?.name,
      "Remote Project",
    );
    assert.equal(
      await fs.readFile(item.desktopFile, "utf8"),
      item.desktopContent,
    );
  } finally {
    await api.application.close();
    await fs.rm(item.directory, { recursive: true, force: true });
  }
});

test("project root edits validate every unique directory through the selected host before persistence", async () => {
  const item = await fixture();
  const api = await apiFixture(item);
  try {
    const remote = await api.application.storage.addHost({
      name: "Remote",
      hostname: "server.invalid",
    });
    await api.application.storage.addProject(
      remote.id,
      item.projectPath,
      "Remote Project",
    );
    const body = { hostId: remote.id, path: item.projectPath };
    for (const fields of [
      { rootPaths: ["relative"] },
      { rootPaths: ["/bad\nroot"] },
      { rootPaths: Array.from({ length: 13 }, () => item.extraPath) },
      { name: " " },
      { path: "relative", name: "Name" },
    ])
      assert.equal(
        (await api.request("PATCH", { ...body, ...fields })).status,
        400,
      );
    assert.equal(api.reads.length, 0, "invalid fields never reach app-server");
    const rejected = await api.request("PATCH", {
      ...body,
      name: "Must not persist",
      rootPaths: [path.join(item.projectPath, "README.md")],
    });
    assert.equal(rejected.status, 400);
    assert.match(
      ((await rejected.json()) as { error: string }).error,
      /directory/,
    );
    assert.equal(
      byScope(
        await api.application.storage.projects(),
        remote.id,
        item.projectPath,
      )?.name,
      "Remote Project",
    );
    assert.equal(
      api.reads.every((read) => read.hostId === remote.id),
      true,
    );
    api.reads.length = 0;
    const edited = await api.request("PATCH", {
      ...body,
      rootPaths: [item.extraPath, item.projectPath, item.extraPath],
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(
      ((await edited.json()) as { project: Project }).project.rootPaths,
      [item.projectPath, item.extraPath],
    );
    assert.deepEqual(
      api.reads.map((read) => read.path).sort(),
      [item.projectPath, item.extraPath].sort(),
    );
    assert.equal(
      api.reads.every((read) => read.hostId === remote.id),
      true,
    );
    assert.deepEqual(
      byScope(
        await api.application.storage.projects(),
        "local",
        item.projectPath,
      )?.rootPaths,
      [item.projectPath, item.extraPath],
    );
    api.reads.length = 0;
    const cleared = await api.request("PATCH", { ...body, rootPaths: [] });
    assert.equal(cleared.status, 200);
    assert.deepEqual(
      ((await cleared.json()) as { project: Project }).project.rootPaths,
      [item.projectPath],
    );
    assert.deepEqual(api.reads, [
      { hostId: remote.id, path: item.projectPath },
    ]);
  } finally {
    await api.application.close();
    await fs.rm(item.directory, { recursive: true, force: true });
  }
});
