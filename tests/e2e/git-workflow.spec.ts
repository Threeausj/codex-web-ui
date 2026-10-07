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
async function installGit(page: Page, mock?: any) {
  await page.route('**/api/hosts/*/native-capabilities?*', route => route.fulfill({ json: { status: 'known', checkedAt: Date.now(), methods: { 'thread/settings/update': { available: true, params: ['threadId', 'cwd', 'sandboxPolicy', 'approvalPolicy', 'model', 'effort', 'serviceTier'], required: ['threadId'] } } } }));
  if (mock) {
    const receive = mock.receive.bind(mock);
    mock.receive = (socket: any, request: any) => {
      if (request.method === 'thread/settings/update') { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result: {} })); return; }
      receive(socket, request);
    };
  }
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
    if (action === 'review-options') return respond({ root, branches: [...branches, 'origin/main'], commits: [{ sha: 'abcdef1234567890abcdef1234567890abcdef1234', title: 'Review auth lifecycle' }] });
    if (url.pathname.endsWith('/worktree/remove')) {
      const index = worktrees.findIndex(tree => tree.path === body.path);
      if (index < 1) return respond({ error: 'Cannot remove primary worktree' }, 409);
      worktrees.splice(index, 1);
      return respond({ ...status(body.cwd), removedPath: body.path });
    }
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

for (const target of [
  { scope: 'uncommittedChanges', value: '', expected: { type: 'uncommittedChanges' } },
  { scope: 'baseBranch', value: 'origin/main', expected: { type: 'baseBranch', branch: 'origin/main' } },
  { scope: 'commit', value: 'abcdef1234567890abcdef1234567890abcdef1234', expected: { type: 'commit', sha: 'abcdef1234567890abcdef1234567890abcdef1234', title: 'Review auth lifecycle' } },
  { scope: 'custom', value: '检查登录重启和注销竞态', expected: { type: 'custom', instructions: '检查登录重启和注销竞态' } },
]) {
  test(`native review chooses ${target.scope} on a native thread without a synthetic user prompt`, async ({ page, mock }) => {
    await installGit(page, mock);
    await login(page);
    await slash(page, 'review');
    const dialog = page.getByRole('dialog', { name: '代码审阅', exact: true });
    await dialog.getByRole('combobox', { name: '审阅范围' }).selectOption(target.scope);
    if (target.scope === 'baseBranch') await dialog.getByRole('combobox', { name: '审阅基准分支' }).selectOption(target.value);
    if (target.scope === 'commit') await dialog.getByRole('combobox', { name: '审阅 commit SHA' }).fill(target.value);
    if (target.scope === 'custom') await dialog.getByRole('textbox', { name: '自定义审阅要求' }).fill(target.value);
    await dialog.getByRole('button', { name: '开始审阅', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(mock.request('review/start')?.params).toMatchObject({ delivery: 'inline', target: target.expected });
    expect(mock.request('thread/start')?.params).toMatchObject({ cwd: root, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
    await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  });
}

test('review validates commit and custom scopes and preserves the existing composer draft', async ({ page, mock }) => {
  await installGit(page);
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('未发送的审阅前草稿');
  await page.getByRole('button', { name: '搜索与指令', exact: false }).click();
  await page.getByPlaceholder('搜索对话或输入指令…').fill('审查代码变更');
  await page.locator('.palette-results button').filter({ hasText: '审查代码变更' }).click();
  const dialog = page.getByRole('dialog', { name: '代码审阅', exact: true });
  await dialog.getByRole('combobox', { name: '审阅范围' }).selectOption('commit');
  await dialog.getByRole('combobox', { name: '审阅 commit SHA' }).fill('HEAD; git reset --hard');
  await expect(dialog.getByRole('button', { name: '开始审阅', exact: true })).toBeDisabled();
  await dialog.getByRole('combobox', { name: '审阅范围' }).selectOption('custom');
  await expect(dialog.getByRole('button', { name: '开始审阅', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭代码审阅', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('未发送的审阅前草稿');
  expect(mock.request('review/start')).toBeUndefined();
});

test('an existing review applies the current full-access policy before starting the review turn', async ({ page, mock }) => {
  await installGit(page, mock);
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  await page.getByRole('combobox', { name: '选择权限' }).selectOption('danger-full-access');
  await slash(page, 'review');
  await page.getByRole('dialog', { name: '代码审阅' }).getByRole('button', { name: '开始审阅', exact: true }).click();
  await expect.poll(() => mock.request('review/start')?.params.threadId).toBe('thread-existing');
  expect(mock.request('thread/settings/update')?.params).toMatchObject({ threadId: 'thread-existing', sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' });
  expect(mock.requests.filter(request => request.method === 'thread/unsubscribe')).toHaveLength(0);
  expect(mock.request('thread/start')).toBeUndefined();
});

test('welcome review stays locked after creating its thread and shows a settings failure before retrying the same thread', async ({ page, mock }) => {
  await installGit(page, mock);
  const receive = (mock as any).receive.bind(mock);
  let rejectSettings: (() => void) | undefined;
  let firstSettings = true;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/settings/update' && firstSettings) {
      firstSettings = false;
      mock.requests.push(request);
      rejectSettings = () => socket.send(JSON.stringify({ id: request.id, error: { code: -32602, message: '审阅权限更新失败，请重新确认' } }));
      return;
    }
    return receive(socket, request);
  };
  await login(page);
  await slash(page, 'review');
  const dialog = page.getByRole('dialog', { name: '代码审阅', exact: true });
  await dialog.getByRole('button', { name: '开始审阅', exact: true }).click();
  await expect.poll(() => !!rejectSettings).toBe(true);
  await expect(page.getByRole('heading', { name: '新的测试对话', exact: true })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: '审阅范围' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '正在启动…', exact: true })).toBeDisabled();
  expect(mock.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
  rejectSettings!();
  await expect(dialog.getByRole('alert')).toContainText('审阅权限更新失败');
  await expect(dialog.getByRole('button', { name: '开始审阅', exact: true })).toBeEnabled();
  expect(mock.request('review/start')).toBeUndefined();
  const createdId = mock.request('thread/settings/update')!.params.threadId;
  await dialog.getByRole('button', { name: '开始审阅', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
  expect(mock.request('review/start')?.params.threadId).toBe(createdId);
});

test('creating from a starting branch prepares a worktree conversation and binds the first real message to its cwd', async ({ page, mock }) => {
  const git = await installGit(page);
  await login(page);
  const panel = await openGit(page);
  await panel.getByText('创建独立工作树', { exact: true }).click();
  const destination = '/workspace/new-worktree-thread';
  await panel.getByRole('textbox', { name: '工作树绝对路径' }).fill(destination);
  await panel.getByRole('textbox', { name: '工作树新分支名称' }).fill('feature/new-thread');
  await panel.getByRole('combobox', { name: '工作树起始分支' }).selectOption('feature/existing');
  await panel.getByRole('checkbox', { name: '创建工作树后新建对话' }).check();
  await panel.getByRole('button', { name: '创建工作树', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '当前 Git 分支' })).toHaveValue('feature/new-thread');
  expect(git.request('worktree')?.body).toMatchObject({ startPoint: 'feature/existing', branch: 'feature/new-thread', path: destination });
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
  expect(mock.requests.filter(request => request.method === 'thread/start')).toHaveLength(0);
  await send(page, '在此工作树开始实现');
  await expect(page.locator('.agent-message').last()).toContainText('流式回复完成');
  expect(mock.request('thread/start')?.params.cwd).toBe(destination);
  expect(mock.request('turn/start')?.params.threadId).toBe(mock.request('thread/start')?.params ? mock.threads[0]!.id : '');
});

test('worktree cleanup is explicitly confirmed and preserves conversation history without archiving', async ({ page, mock }) => {
  const git = await installGit(page);
  await login(page);
  const panel = await openGit(page);
  await panel.getByText('创建独立工作树', { exact: true }).click();
  const destination = '/workspace/remove-worktree';
  await panel.getByRole('textbox', { name: '工作树绝对路径' }).fill(destination);
  await panel.getByRole('textbox', { name: '工作树新分支名称' }).fill('feature/remove-tree');
  await panel.getByRole('button', { name: '创建工作树', exact: true }).click();
  const remove = panel.getByRole('button', { name: `移除工作树 ${destination}`, exact: true });
  await expect(remove).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss());
  await remove.click();
  expect(git.calls.filter(call => call.action === 'remove')).toHaveLength(0);
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('保留分支'); await dialog.accept(); });
  await remove.click();
  await expect(panel.locator('.git-worktree').filter({ hasText: destination })).toHaveCount(0);
  expect(git.request('remove')?.body.path).toBe(destination);
  expect(mock.requests.filter(request => request.method === 'thread/archive')).toHaveLength(0);
});
