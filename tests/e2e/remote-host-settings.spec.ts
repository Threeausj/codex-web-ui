import { test, expect, login } from "./fixtures";

test("SSH connections can be edited and empty advanced fields restore automatic detection", async ({
  page,
}) => {
  const hosts: any[] = [{ id: "local", name: "本机", kind: "local" }];
  const writes: { method: string; body: any }[] = [];
  await page.route(/\/api\/hosts(?:\/[^/?]+)?(?:\?|$)/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: { hosts } });
      return;
    }
    const body = request.postDataJSON();
    writes.push({ method: request.method(), body });
    const id = new URL(request.url()).pathname.split("/")[3];
    const address = body.hostname.split("@");
    const next = {
      ...body,
      id: id || "ssh-test",
      kind: "ssh",
      hostname: address.at(-1),
      username: address.length === 2 ? address[0] : undefined,
      port: body.port || 22,
    };
    for (const key of ["username", "identityFile", "codexPath", "cwd"])
      if (!next[key]) delete next[key];
    if (request.method() === "POST") hosts.push(next);
    else {
      const old = hosts.find((host) => host.id === id);
      Object.assign(old, next);
      for (const key of ["username", "identityFile", "codexPath", "cwd"])
        if (!next[key]) delete old[key];
    }
    await route.fulfill({
      json: { host: next, hosts, connectionReset: false },
    });
  });
  await login(page);
  await page.locator(".settings-button").click();
  await page
    .locator(".settings-nav")
    .getByRole("button", { name: "连接", exact: true })
    .click();
  await page
    .getByRole("button", { name: "添加 SSH 连接", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "添加 SSH 连接",
    exact: true,
  });
  await expect(dialog.getByLabel("SSH 端口", { exact: true })).toHaveValue("");
  await dialog.locator("summary").filter({ hasText: "高级选项" }).click();
  await expect(
    dialog.getByLabel("远端 Codex 路径", { exact: true }),
  ).toHaveValue("");
  await dialog.getByLabel("SSH 显示名称", { exact: true }).fill("开发服务器");
  await dialog
    .getByLabel("SSH 主机地址", { exact: true })
    .fill("dev@dev.example.test");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑 开发服务器", exact: true }),
  ).toBeVisible();
  expect(writes[0]).toMatchObject({
    method: "POST",
    body: {
      hostname: "dev@dev.example.test",
      username: "",
      codexPath: "",
      port: null,
    },
  });

  await page
    .getByRole("button", { name: "编辑 开发服务器", exact: true })
    .click();
  const edit = page.getByRole("dialog", { name: "编辑 SSH 连接", exact: true });
  await expect(edit.getByLabel("SSH 主机地址", { exact: true })).toHaveValue(
    "dev@dev.example.test",
  );
  await edit.getByLabel("SSH 显示名称", { exact: true }).fill("生产服务器");
  await edit
    .getByLabel("SSH 主机地址", { exact: true })
    .fill("ops@prod.example.test");
  await edit.getByLabel("SSH 端口", { exact: true }).fill("2222");
  await edit.getByRole("button", { name: "身份文件", exact: true }).click();
  await edit.getByLabel("SSH 身份文件路径", { exact: true }).fill("/keys/prod");
  await edit.locator("summary").filter({ hasText: "高级选项" }).click();
  await edit
    .getByLabel("远端 Codex 路径", { exact: true })
    .fill("/opt/codex/bin/codex");
  await edit
    .getByLabel("SSH 默认工作目录", { exact: true })
    .fill("/srv/project");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑 生产服务器", exact: true }),
  ).toBeVisible();
  expect(writes[1]).toEqual({
    method: "PATCH",
    body: {
      name: "生产服务器",
      hostname: "ops@prod.example.test",
      username: "",
      port: 2222,
      identityFile: "/keys/prod",
      codexPath: "/opt/codex/bin/codex",
      cwd: "/srv/project",
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "编辑 生产服务器", exact: true })
    .click();
  await edit.locator("summary").filter({ hasText: "高级选项" }).click();
  await expect(edit.getByLabel("远端 Codex 路径", { exact: true })).toHaveValue(
    "/opt/codex/bin/codex",
  );
  await edit.getByLabel("远端 Codex 路径", { exact: true }).fill("");
  await edit.getByLabel("SSH 端口", { exact: true }).fill("");
  await edit.getByRole("button", { name: "无身份验证", exact: true }).click();
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "设置", exact: true })
      .getByText("SSH 配置已更新", { exact: true }),
  ).toBeVisible();
  expect(writes[2].body).toMatchObject({
    codexPath: "",
    identityFile: "",
    port: null,
  });
  await page
    .getByRole("button", { name: "编辑 生产服务器", exact: true })
    .click();
  await edit.locator("summary").filter({ hasText: "高级选项" }).click();
  await expect(edit.getByLabel("远端 Codex 路径", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    edit.getByLabel("SSH 身份文件路径", { exact: true }),
  ).toHaveCount(0);
  await edit.getByRole("button", { name: "身份文件", exact: true }).click();
  await expect(
    edit.getByLabel("SSH 身份文件路径", { exact: true }),
  ).toHaveValue("");
});
