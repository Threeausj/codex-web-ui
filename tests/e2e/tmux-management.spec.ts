import type { Page } from "@playwright/test";
import { test, expect, login, slash, send, MockCodex } from "./fixtures";

type Session = {
  id: string;
  name: string;
  windows: number;
  attached: number;
  createdAt: number;
};
async function installTmux(page: Page) {
  const calls: { action: string; body: any }[] = [];
  const sessions: Session[] = [
    { id: "$1", name: "build", windows: 2, attached: 1, createdAt: 1791200000 },
    {
      id: "$2",
      name: "server",
      windows: 1,
      attached: 0,
      createdAt: 1791200001,
    },
  ];
  const fixture = {
    calls,
    sessions,
    available: true,
    nextId: 3,
    failCreate: false,
    requireFullAccess: false,
    holdLocalRead: null as null | Promise<void>,
  };
  await page.route("**/api/tmux/**", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").pop()!;
    const body = route.request().postDataJSON();
    calls.push({ action, body });
    const reply = (json: unknown, status = 200) =>
      route.fulfill({ status, json });
    if (fixture.requireFullAccess && body.permission !== "danger-full-access")
      return reply(
        {
          error:
            "当前权限阻止访问 tmux socket，请在权限选择中切换到完全访问后重试",
        },
        403,
      );
    if (action === "list")
      return reply({
        available: fixture.available,
        reason: fixture.available ? undefined : "目标主机未检测到 tmux",
        sessions: fixture.available ? sessions : [],
      });
    if (action === "read") {
      if (body.hostId === "local" && fixture.holdLocalRead)
        await fixture.holdLocalRead;
      return reply({
        sessionId: body.sessionId,
        paneId: body.paneId || "%1",
        text: `${body.hostId} ${body.sessionId} ${body.paneId || "%1"} output\n${"x".repeat(180)}`,
        panes: [
          {
            id: "%1",
            title: "Shell",
            command: "zsh",
            path: body.cwd,
            windowId: "@1",
            windowName: "shell",
            active: true,
            windowActive: true,
          },
          {
            id: "%2",
            title: "Dev server",
            command: "node",
            path: body.cwd,
            windowId: "@2",
            windowName: "dev",
            active: true,
            windowActive: false,
          },
        ],
      });
    }
    if (body.permission === "read-only")
      return reply({ error: "只读模式不允许管理会话" }, 403);
    if (action === "create") {
      if (fixture.failCreate) return reply({ error: "会话名称已存在" }, 409);
      const session = {
        id: `$${fixture.nextId++}`,
        name: body.name || "codex-web-created",
        windows: 1,
        attached: 0,
        createdAt: 1791200002,
      };
      sessions.push(session);
      return reply({ session }, 201);
    }
    const session = sessions.find((session) => session.id === body.sessionId);
    if (!session) return reply({ error: "会话已不存在" }, 404);
    if (action === "attach")
      return reply({
        command: ["/usr/bin/tmux", "attach-session", "-t", session.id],
        sessionName: session.name,
        sessionId: session.id,
      });
    if (action === "delete") {
      sessions.splice(sessions.indexOf(session), 1);
      return reply({ ok: true, sessionId: session.id });
    }
    return reply({ error: "Unexpected tmux operation" }, 404);
  });
  return fixture;
}
async function openTmux(page: Page) {
  await slash(page, "terminal");
  await page.getByRole("button", { name: "Tmux", exact: true }).click();
  return page.getByRole("region", { name: "Tmux 会话管理" });
}

test("mobile tmux reads panes, creates and deletes only the confirmed session, then attaches via app-server PTY", async ({
  page,
  mock,
}) => {
  const tmux = await installTmux(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const panel = await openTmux(page);
  await expect(panel.locator(".tmux-host")).toHaveText("本机");
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "local $1 %1 output",
  );
  await panel
    .getByRole("combobox", { name: "Tmux 窗口与面板" })
    .selectOption("%2");
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "local $1 %2 output",
  );
  await panel
    .getByRole("button", { name: "读取会话 server", exact: true })
    .click();
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "local $2 %1 output",
  );
  await panel.getByRole("button", { name: "新建", exact: true }).click();
  await panel
    .getByRole("textbox", { name: "新建 Tmux 会话名称" })
    .fill("scratch");
  await panel.getByRole("button", { name: "创建会话", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "读取会话 scratch", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "local $3 %1 output",
  );
  await panel
    .getByRole("button", { name: "删除会话 scratch", exact: true })
    .click();
  await expect(
    panel.getByRole("group", { name: "确认删除 Tmux 会话" }),
  ).toContainText("会结束该会话中的进程");
  expect(tmux.calls.filter((call) => call.action === "delete")).toHaveLength(0);
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await panel
    .getByRole("button", { name: "删除会话 scratch", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "确认删除会话", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "读取会话 scratch", exact: true }),
  ).toHaveCount(0);
  expect(tmux.calls.find((call) => call.action === "delete")?.body).toEqual({
    hostId: "local",
    cwd: "/workspace/demo",
    permission: "workspace-write",
    sessionId: "$3",
  });
  expect(tmux.sessions.map((session) => session.name)).toEqual([
    "build",
    "server",
  ]);
  await panel
    .getByRole("button", { name: "读取会话 server", exact: true })
    .click();
  await panel.getByRole("button", { name: "切换到终端", exact: true }).click();
  await expect
    .poll(() => mock.request("command/exec")?.params.command)
    .toEqual(["/usr/bin/tmux", "attach-session", "-t", "$2"]);
  expect(mock.request("command/exec")?.params).toMatchObject({
    tty: true,
    cwd: "/workspace/demo",
    sandboxPolicy: { type: "workspaceWrite" },
  });
  await expect(page.getByLabel("交互式终端")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  const firstProcessId = mock.request("command/exec")!.params.processId;
  await page.getByRole("button", { name: "Tmux", exact: true }).click();
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "local $1 %1 output",
  );
  await panel.getByRole("button", { name: "切换到终端", exact: true }).click();
  await expect
    .poll(() => mock.request("command/exec")?.params.command)
    .toEqual(["/usr/bin/tmux", "attach-session", "-t", "$1"]);
  expect(mock.request("command/exec/terminate")?.params.processId).toBe(
    firstProcessId,
  );
  expect(mock.request("command/exec")?.params.processId).not.toBe(
    firstProcessId,
  );
  expect(tmux.sessions.map((session) => session.name)).toEqual([
    "build",
    "server",
  ]);
  await page.getByRole("button", { name: "结束终端", exact: true }).click();
});

test("attaching tmux preserves an ordinary shell and pending approvals, and switching back restores ordinary terminal controls", async ({
  page,
  mock,
}) => {
  await installTmux(page);
  await login(page);
  await slash(page, "terminal");
  await page.getByRole("button", { name: "启动终端", exact: true }).click();
  await expect
    .poll(() => mock.request("command/exec")?.params.command)
    .toEqual(["/bin/sh"]);
  const ordinaryId = mock.request("command/exec")!.params.processId;
  mock.requireApprovalNext = true;
  await send(page, "需要审批的任务");
  const approval = page.locator(".approval-card");
  await expect(approval).toBeVisible();
  await page.getByRole("button", { name: "Tmux", exact: true }).click();
  const panel = page.getByRole("region", { name: "Tmux 会话管理" });
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "local $1 %1 output",
  );
  await panel.getByRole("button", { name: "切换到终端", exact: true }).click();
  await expect
    .poll(() => mock.request("command/exec")?.params.command)
    .toEqual(["/usr/bin/tmux", "attach-session", "-t", "$1"]);
  expect(
    mock.requests.filter(
      (request) => request.method === "command/exec/terminate",
    ),
  ).toHaveLength(0);
  const tmuxId = mock.request("command/exec")!.params.processId;
  expect(tmuxId).not.toBe(ordinaryId);
  await expect(approval).toBeVisible();
  mock.emit("bridge/status", {
    connected: true,
    activeProcesses: [
      {
        processId: ordinaryId,
        cwd: "/workspace/demo",
        tty: true,
        lastOutput: "original ordinary shell",
      },
      {
        processId: tmuxId,
        cwd: "/workspace/demo",
        tty: true,
        lastOutput: "tmux shell",
      },
    ],
  });
  await page
    .getByRole("combobox", { name: "选择运行中的终端" })
    .selectOption(ordinaryId);
  await expect(page.locator(".pty-toolbar")).toContainText("Shell 正在运行");
  await expect(page.locator(".pty-toolbar")).not.toContainText("tmux ·");
  await expect(
    page.getByRole("button", { name: "结束终端", exact: true }),
  ).toHaveAttribute("title", "结束终端");
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(approval).toHaveCount(0);
  expect(
    mock.requests.filter(
      (request) => request.method === "command/exec/terminate",
    ),
  ).toHaveLength(0);
});

test("read-only tmux still reads sessions and panes while all mutations stay disabled", async ({
  page,
}) => {
  const tmux = await installTmux(page);
  await login(page);
  await page
    .getByRole("combobox", { name: "选择权限", exact: true })
    .selectOption("read-only");
  const panel = await openTmux(page);
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "local $1 %1 output",
  );
  await panel
    .getByRole("button", { name: "读取会话 server", exact: true })
    .click();
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "local $2 %1 output",
  );
  for (const name of ["新建", "切换到终端", "删除会话 server"])
    await expect(
      panel.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await panel
    .getByRole("button", { name: "刷新会话输出", exact: true })
    .click();
  await expect
    .poll(() => tmux.calls.filter((call) => call.action === "read").length)
    .toBeGreaterThan(2);
  expect(
    tmux.calls.every((call) => ["list", "read"].includes(call.action)),
  ).toBe(true);
  expect(tmux.calls.every((call) => call.body.permission === "read-only")).toBe(
    true,
  );
});

test("missing tmux and failed creation keep a useful inline explanation without starting a terminal", async ({
  page,
  mock,
}) => {
  const tmux = await installTmux(page);
  tmux.available = false;
  await login(page);
  const panel = await openTmux(page);
  await expect(panel).toContainText("目标主机未检测到 tmux");
  await expect(
    panel.getByRole("button", { name: "新建", exact: true }),
  ).toBeDisabled();
  expect(mock.request("command/exec")).toBeUndefined();
  tmux.available = true;
  await panel
    .getByRole("button", { name: "刷新 Tmux 会话", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "新建", exact: true }),
  ).toBeEnabled();
  tmux.failCreate = true;
  await panel.getByRole("button", { name: "新建", exact: true }).click();
  await panel
    .getByRole("textbox", { name: "新建 Tmux 会话名称" })
    .fill("build");
  await panel.getByRole("button", { name: "创建会话", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("会话名称已存在");
  await expect(
    panel.getByRole("textbox", { name: "新建 Tmux 会话名称" }),
  ).toHaveValue("build");
  expect(tmux.sessions).toHaveLength(2);
  expect(mock.request("command/exec")).toBeUndefined();
});

test("sandbox access failure stays visible and explicitly choosing full access allows a refresh", async ({
  page,
  mock,
}) => {
  const tmux = await installTmux(page);
  tmux.requireFullAccess = true;
  await login(page);
  const panel = await openTmux(page);
  await expect(panel.getByRole("alert")).toContainText(
    "当前权限阻止访问 tmux socket",
  );
  expect(mock.request("command/exec")).toBeUndefined();
  await page
    .getByRole("combobox", { name: "选择权限", exact: true })
    .selectOption("danger-full-access");
  await panel
    .getByRole("button", { name: "刷新 Tmux 会话", exact: true })
    .click();
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "local $1 %1 output",
  );
  expect(tmux.calls.at(-1)?.body.permission).toBe("danger-full-access");
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("a late local snapshot cannot replace the remote host's output after switching hosts", async ({
  page,
  mock,
}) => {
  const remote = new MockCodex();
  mock.hosts.push({
    id: "ssh-test",
    name: "开发服务器",
    kind: "ssh",
    hostname: "server.invalid",
    cwd: "/workspace/demo",
  });
  mock.projects.push({
    ...mock.projects[0],
    id: "remote-project",
    hostId: "ssh-test",
    name: "Remote Project",
  });
  mock.hostMocks.set("ssh-test", remote);
  const tmux = await installTmux(page);
  let release!: () => void;
  tmux.holdLocalRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  await login(page);
  const panel = await openTmux(page);
  await expect
    .poll(
      () =>
        tmux.calls.find(
          (call) => call.action === "read" && call.body.hostId === "local",
        )?.body.sessionId,
    )
    .toBe("$1");
  await page
    .getByRole("combobox", { name: "选择主机", exact: true })
    .selectOption("ssh-test");
  await expect(panel.locator(".tmux-host")).toHaveText("开发服务器");
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "ssh-test $1 %1 output",
  );
  release();
  await page
    .getByRole("button", { name: "刷新 Tmux 会话", exact: true })
    .click();
  await expect(panel.getByLabel("Tmux 输出快照")).toContainText(
    "ssh-test $1 %1 output",
  );
  await expect(panel.getByLabel("Tmux 输出快照")).not.toContainText("local");
  expect(remote.request("command/exec")).toBeUndefined();
  expect(mock.request("command/exec")).toBeUndefined();
});
