import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Preferences, preferencesPatch } from "./preferences.js";
import { Storage } from "./storage.js";

test("navigation preferences persist with private permissions and concurrent collapses merge", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-preferences-"),
  );
  try {
    const file = path.join(directory, "preferences.json");
    const store = new Preferences(file);
    await store.init();
    await Promise.all([
      store.update({ collapsed: { "section:local:pinned": true } }),
      store.update({ collapsed: { "project:local:/project": true } }),
    ]);
    await store.update({
      pins: [
        { kind: "project", hostId: "local", id: "/project" },
        { kind: "project", hostId: "local", id: "/project" },
      ],
    });
    const restored = new Preferences(file);
    await restored.init();
    assert.deepEqual(restored.get().collapsed, {
      "section:local:pinned": true,
      "project:local:/project": true,
    });
    assert.equal(restored.get().pins.length, 1);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const snapshot = restored.get();
    snapshot.pins.length = 0;
    assert.equal(restored.get().pins.length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("preferences reject unknown fields and prototype keys", () => {
  assert.equal(
    preferencesPatch.safeParse({ authToken: "unexpected" }).success,
    false,
  );
  assert.equal(
    preferencesPatch.safeParse(JSON.parse('{"collapsed":{"__proto__":true}}'))
      .success,
    false,
  );
  assert.equal(
    preferencesPatch.safeParse({
      permissionProfiles: [
        {
          id: "p",
          name: "P",
          sandboxMode: "any",
          approvalPolicy: "never",
          networkAccess: true,
        },
      ],
    }).success,
    false,
  );
});
test("projects retain multiple roots after a service restart", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-roots-"),
  );
  try {
    const storage = new Storage(
      directory,
      path.join(directory, "codex"),
      "/project",
    );
    await storage.init();
    await storage.addProject("local", "/project", "Multi Root", [
      "/project",
      "/other",
    ]);
    const restored = new Storage(
      directory,
      path.join(directory, "codex"),
      "/project",
    );
    await restored.init();
    const project = (await restored.projects()).find(
      (project) => project.name === "Multi Root",
    )!;
    assert.deepEqual(project.rootPaths, ["/project", "/other"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("preferences HTTP routes require authentication and CSRF for writes", async () => {
  const { createServer } = await import("./app.js");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-preferences-auth-"),
  );
  const app = await createServer({
    dataDir: directory,
    password: "preferences-auth-password",
    serveStatic: false,
    secureCookie: false,
  });
  try {
    await new Promise<void>((resolve) =>
      app.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    assert.equal((await fetch(base + "/api/preferences")).status, 401);
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "preferences-auth-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    assert.equal(
      (
        await fetch(base + "/api/preferences", {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: '{"collapsed":{"recent":true}}',
        })
      ).status,
      403,
    );
    const response = await fetch(base + "/api/preferences", {
      method: "PATCH",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: '{"collapsed":{"recent":true}}',
    });
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as any).preferences.collapsed.recent,
      true,
    );
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
