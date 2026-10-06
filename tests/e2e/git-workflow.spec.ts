import type { Page } from "@playwright/test";
import { test, expect, login, slash, send } from "./fixtures";

type GitFile = {
  path: string;
  index: string;
  working: string;
  untracked: boolean;
  conflicted: boolean;
};
type Worktree = {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};
type GitCall = {
  method: string;
  action: string;
  body: any;
  csrf: string | undefined;
};
const root = "/workspace/demo";
const head = "abcdef1234567890";
const changed = (path: string, index = " ", working = "M"): GitFile => ({
  path,
  index,
  working,
  untracked: false,
  conflicted: false,
});

/** HTTP wire fixtures exercise the actual mounted Vue GitPanel. Real Git and
 * app-server execution are covered by server/git.test.ts. */
async function installGit(page: Page) {
  const calls: GitCall[] = [];
  let files = [changed("one.txt"), changed("other.txt", "M", " ")];
  let branch = "main";
  const branches = ["main", "feature/existing"];
  const worktrees: Worktree[] = [
    {
      path: root,
      head,
      branch: "main",
      detached: false,
      locked: false,
      prunable: false,
    },
  ];
  const status = (cwd = root) => ({
    root: cwd,
    branch: worktrees.find((tree) => tree.path === cwd)?.branch || branch,
    head,
    files: cwd === root ? files : [],
    branches,
    worktrees,
  });
  await page.route("**/api/git/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const action = url.pathname.split("/").pop()!;
    const body =
      request.method() === "POST"
        ? request.postDataJSON()
        : Object.fromEntries(url.searchParams);
    calls.push({
      method: request.method(),
      action,
      body,
      csrf: request.headers()["x-csrf-token"],
    });
    const respond = (value: unknown, code = 200) =>
      route.fulfill({ status: code, json: value });
    if (action === "status") return respond(status(body.cwd));
    if (action === "diff") {
      const entry = files.find((file) => file.path === body.file);
      const visible =
        body.staged === "true" ? entry?.index === "M" : entry?.working === "M";
      return respond({
        path: body.file,
        staged: body.staged === "true",
        diff: visible
          ? `diff --git a/${body.file} b/${body.file}\n--- a/${body.file}\n+++ b/${body.file}\n@@ -1,2 +1,2 @@\n-original line\n+updated line\n unchanged line\n`
          : "",
      });
    }
    if (body.permission === "read-only")
      return respond({ error: "当前为只读权限" }, 403);
    if (action === "stage") {
      files = files.map((file) =>
        body.files.includes(file.path)
          ? { ...file, index: "M", working: " " }
          : file,
      );
      return respond(status(body.cwd));
    }
    if (action === "unstage") {
      files = files.map((file) =>
        body.files.includes(file.path)
          ? { ...file, index: " ", working: "M" }
          : file,
      );
      return respond(status(body.cwd));
    }
    if (action === "commit") {
      files = files.filter((file) => !body.files.includes(file.path));
      return respond({
        ...status(body.cwd),
        output: "Committed exactly the selected files",
      });
    }
    if (action === "branch") {
      branch = body.branch;
      worktrees[0]!.branch = branch;
      if (!branches.includes(branch)) branches.push(branch);
      return respond(status(body.cwd));
    }
    if (action === "worktree") {
      worktrees.push({
        path: body.path,
        head,
        branch: body.branch,
        detached: false,
        locked: false,
        prunable: false,
      });
      if (!branches.includes(body.branch)) branches.push(body.branch);
      return respond({ ...status(body.cwd), projectPath: body.path }, 201);
    }
    return respond({ error: `Unexpected Git test action: ${action}` }, 404);
  });
  return {
    calls,
    request: (action: string) =>
      calls
        .filter((call) => call.action === action && call.method === "POST")
        .at(-1),
  };
}

async function openGit(page: Page) {
  await slash(page, "terminal");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "当前 Git 分支" }),
  ).toHaveValue("main");
  return page.getByRole("region", { name: "Git 工作流" });
}

test("Git line diff and selected-file commit leave the other staged file intact", async ({
  page,
}) => {
  const git = await installGit(page);
  await login(page);
  const panel = await openGit(page);
  await panel
    .locator(".git-file")
    .filter({ hasText: "one.txt" })
    .locator(".git-file-name")
    .click();
  const diff = panel.getByRole("region", { name: "文件逐行差异" });
  await expect(diff.locator(".git-diff-line.added")).toContainText(
    "+updated line",
  );
  await expect(diff.locator(".git-diff-line.removed")).toContainText(
    "-original line",
  );
  await expect(
    diff.locator(".git-diff-line.added .git-line-number").last(),
  ).toHaveText("1");
  await panel
    .getByRole("checkbox", { name: "选择变更 one.txt", exact: true })
    .check();
  await panel.getByRole("button", { name: "暂存所选", exact: true }).click();
  await expect(
    panel.getByText("2 已暂存 · 0 未暂存", { exact: true }),
  ).toBeVisible();
  expect(git.request("stage")?.body).toMatchObject({
    cwd: root,
    hostId: "local",
    permission: "workspace-write",
    files: ["one.txt"],
  });
  expect(git.request("stage")?.csrf).toBe("mock-csrf");
  await panel.getByRole("button", { name: "已暂存差异", exact: true }).click();
  await expect(diff.locator(".git-diff-line.added")).toContainText(
    "+updated line",
  );
  await panel
    .getByRole("textbox", { name: "Git 提交说明" })
    .fill("Commit one selected file");
  await panel.getByRole("button", { name: "提交所选", exact: true }).click();
  await expect(panel.locator(".git-file")).toHaveCount(1);
  await expect(panel.locator(".git-file")).toContainText("other.txt");
  await expect(
    panel.getByText("1 已暂存 · 0 未暂存", { exact: true }),
  ).toBeVisible();
  expect(git.request("commit")?.body).toMatchObject({
    files: ["one.txt"],
    message: "Commit one selected file",
  });
  await expect(
    panel.getByRole("textbox", { name: "Git 提交说明" }),
  ).toHaveValue("");
  await expect(
    panel.getByRole("button", { name: "提交所选", exact: true }),
  ).toBeDisabled();
});

test("read-only Git still shows line diffs while disabling every write entry point", async ({
  page,
}) => {
  const git = await installGit(page);
  await login(page);
  await page
    .getByRole("combobox", { name: "选择权限" })
    .selectOption("read-only");
  const panel = await openGit(page);
  await expect(
    panel.getByRole("combobox", { name: "当前 Git 分支" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("checkbox", { name: "选择变更 one.txt", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "暂存 one.txt", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "取消暂存 other.txt", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("textbox", { name: "Git 提交说明" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "提交所选", exact: true }),
  ).toBeDisabled();
  await panel
    .locator(".git-file")
    .filter({ hasText: "one.txt" })
    .locator(".git-file-name")
    .click();
  await expect(
    panel.getByRole("region", { name: "文件逐行差异" }),
  ).toContainText("+updated line");
  await panel.getByText("创建独立工作树", { exact: true }).click();
  await expect(
    panel.getByRole("textbox", { name: "工作树绝对路径" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "创建工作树", exact: true }),
  ).toBeDisabled();
  expect(git.calls.filter((call) => call.method === "POST")).toHaveLength(0);
});

test("create and open an independent worktree starts the next thread in its project directory", async ({
  page,
  mock,
}) => {
  const git = await installGit(page);
  await login(page);
  const panel = await openGit(page);
  await panel.getByText("创建独立工作树", { exact: true }).click();
  const destination = "/workspace/parallel-task";
  await panel
    .getByRole("textbox", { name: "工作树绝对路径" })
    .fill(destination);
  await panel
    .getByRole("textbox", { name: "工作树新分支名称" })
    .fill("feature/parallel-task");
  await panel.getByRole("button", { name: "创建工作树", exact: true }).click();
  const worktree = panel
    .locator(".git-worktree")
    .filter({ hasText: destination });
  await expect(worktree).toContainText("feature/parallel-task");
  expect(git.request("worktree")?.body).toMatchObject({
    path: destination,
    branch: "feature/parallel-task",
    mode: "new",
    cwd: root,
  });
  const imported = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/projects") && request.method() === "POST",
  );
  await worktree.getByRole("button", { name: "打开", exact: true }).click();
  expect((await imported).postDataJSON()).toMatchObject({
    hostId: "local",
    path: destination,
  });
  await expect(
    panel.getByRole("combobox", { name: "当前 Git 分支" }),
  ).toHaveValue("feature/parallel-task");
  await send(page, "在独立工作树中继续");
  await expect(page.locator(".agent-message")).toContainText("流式回复完成");
  expect(mock.request("thread/start")?.params.cwd).toBe(destination);
  expect(mock.request("turn/start")?.params.cwd).toBe(destination);
});
