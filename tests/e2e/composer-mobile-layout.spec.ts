import type { Page } from "@playwright/test";
import { test, expect, login } from "./fixtures";

async function expectAlignedToolbar(page: Page) {
  const { gap, rows } = await page.locator(".composer-toolbar").evaluate(toolbar => ({
    gap: parseFloat(getComputedStyle(toolbar).rowGap),
    rows: [...toolbar.querySelectorAll(".composer-tools, .composer-submit")].map(row => {
      const bounds = row.getBoundingClientRect();
      const controls = [...row.querySelectorAll(".icon-button, .composer-select, .account-usage summary, .context-usage, .send-button")];
      return {
        top: bounds.top, bottom: bounds.bottom, height: bounds.height,
        width: bounds.width, scrollWidth: row.scrollWidth,
        controls: controls.map(control => {
          const box = control.getBoundingClientRect();
          const label = control.querySelector(".composer-select-value, .service-tier-value, .context-ring + span");
          const content = [...control.children].filter(child => (child === label || child.tagName.toLowerCase() === "svg" ||
            child.classList.contains("context-ring")) && child.getBoundingClientRect().height > 0);
          return {
            height: box.height,
            contained: box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.width > 0,
            centerOffset: Math.abs((box.top + box.bottom) / 2 - (bounds.top + bounds.bottom) / 2),
            clippedLabel: label && label.scrollWidth > label.clientWidth + 1
              ? { text: label.textContent, width: label.clientWidth, needed: label.scrollWidth }
              : null,
            fontSize: label && getComputedStyle(label).fontSize,
            lineHeight: label && getComputedStyle(label).lineHeight,
            contentCenterOffsets: content.map(child => {
              const childBox = child.getBoundingClientRect();
              return Math.abs((childBox.top + childBox.bottom) / 2 - (bounds.top + bounds.bottom) / 2);
            }),
          };
        }),
      };
    }),
  }));
  expect(rows).toHaveLength(2);
  expect(rows[1]!.top - rows[0]!.bottom).toBeCloseTo(gap, 0);
  for (const row of rows) {
    expect(row.height).toBe(36);
    expect(row.scrollWidth).toBeLessThanOrEqual(Math.ceil(row.width));
    expect(row.controls.map(control => control.clippedLabel).filter(Boolean)).toEqual([]);
    for (const control of row.controls) {
      expect(control.height).toBe(36);
      expect(control.contained).toBe(true);
      expect(control.centerOffset).toBeLessThanOrEqual(1);
      if (control.fontSize) expect([control.fontSize, control.lineHeight]).toEqual(["13px", "18px"]);
      for (const offset of control.contentCenterOffsets) expect(offset).toBeLessThanOrEqual(1);
    }
  }
}

for (const width of [320, 360, 390, 430]) {
  test(`mobile ${width}px keeps composer controls aligned in one frame, with the keyboard open`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 844 });
    mock.projects[0].name = "手机长项目名".repeat(12);
    mock.hosts[0].name = "主机名称".repeat(16);
    mock.config.model = 'gpt-6.2-astra';
    mock.modelCatalog = [{ ...mock.modelCatalog[0], id: 'gpt-6.2-astra', model: 'gpt-6.2-astra',
      displayName: 'GPT-6.2-Astra', serviceTiers: [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }] }];
    await login(page);
    const model = page.getByRole('combobox', { name: '选择模型', exact: true });
    await expect(model).toHaveValue('gpt-6.2-astra');
    await expect(page.getByRole('combobox', { name: '模型服务层级', exact: true })).toBeAttached();
    const verify = async () => {
      const area = await page.locator(".composer-area").boundingBox();
      const context = await page.locator(".new-context").boundingBox();
      const input = await page.locator(".markdown-composer-editor").boundingBox();
      const toolbar = await page.locator(".composer-toolbar").boundingBox();
      const tools = await page.locator(".composer-tools").boundingBox();
      const submit = await page.locator(".composer-submit").boundingBox();
      const send = await page.getByRole("button", { name: "发送消息", exact: true }).boundingBox();
      expect(area!.x).toBeGreaterThanOrEqual(0);
      expect(area!.x + area!.width).toBeLessThanOrEqual(width);
      expect(Math.abs(context!.x - area!.x)).toBeLessThanOrEqual(1.1);
      expect(Math.abs(context!.width - area!.width)).toBeLessThanOrEqual(2.1);
      expect(Math.abs(input!.x - toolbar!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(tools!.x - submit!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(tools!.width - submit!.width)).toBeLessThanOrEqual(1);
      expect(send!.x + send!.width).toBeLessThanOrEqual(area!.x + area!.width - 8);
      await expectAlignedToolbar(page);
      expect(await page.locator(".composer-area").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);
    };
    await verify();
    await page.setViewportSize({ width, height: 480 });
    await page.getByRole("textbox", { name: "消息输入框" }).fill("键盘打开后仍能输入和发送");
    await verify();
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  });
}

test("mobile keeps two rows with a native speed, quota, and a running task", async ({ page, mock }) => {
  await page.setViewportSize({ width: 320, height: 500 });
  mock.config.model = "gpt-6.2-astra";
  mock.modelCatalog = [{
    ...mock.modelCatalog[0], id: "gpt-6.2-astra", model: "gpt-6.2-astra", displayName: "GPT-6.2-Astra",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "max" }],
    serviceTiers: [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }],
  }];
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => {
    if (request.method === "account/rateLimits/read") {
      socket.send(JSON.stringify({ id: request.id, result: {
        rateLimits: { limitId: "codex", primary: { usedPercent: 64, windowDurationMins: 300 } },
        ordinaryUsageAllowed: false,
      } }));
      return;
    }
    if (request.method !== "thread/resume") return receive(socket, request);
    return receive({ send(payload: string) {
      const reply = JSON.parse(payload);
      if (reply.result) Object.assign(reply.result, { serviceTier: "default", reasoningEffort: "max" });
      socket.send(JSON.stringify(reply));
    } } as typeof socket, request);
  };
  await login(page);
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const speed = page.getByRole("combobox", { name: "模型服务层级", exact: true });
  await expect(speed).toHaveValue("default");
  await expect(page.locator(".service-tier-value")).toHaveText("标准");
  await expect(page.getByRole("status").filter({ hasText: "常规额度已受限" })).toBeVisible();
  const quota = page.getByLabel("查看账户使用额度", { exact: true });
  await quota.click();
  await expect(page.locator(".account-usage-popover")).toContainText("已用 64%");
  await quota.click();
  mock.emit("thread/tokenUsage/updated", { threadId: "thread-existing", tokenUsage: {
    last: { totalTokens: 250000 }, modelContextWindow: 250000,
  } });
  mock.emit("turn/started", { threadId: "thread-existing", turn: { id: "mobile-layout-running", status: "inProgress", items: [] } });
  await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeInViewport();
  await expect(page.getByRole("combobox", { name: "消息发送方式", exact: true })).toBeVisible();
  mock.emit("bridge/thread/changed", { threadId: "thread-existing", method: "thread/settings/update",
    changeId: "mobile-ultrafast", request: { serviceTier: "ultrafast" }, result: {} });
  await expect(page.locator(".service-tier-value")).toHaveText("Ultrafast");
  await expectAlignedToolbar(page);
  expect(mock.request("turn/start")).toBeUndefined();
});

test("mobile touch can choose a file without losing input focus or text", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.fill("请查看 ");
  await input.pressSequentially("@");
  const option = page.getByRole("listbox").getByRole("option").filter({ hasText: "README.md" });
  await expect(option).toBeVisible();
  await option.dispatchEvent("click");
  await expect(input).toHaveValue("请查看 @/workspace/demo/README.md ");
  await expect(input).toBeFocused();
  expect(mock.request("turn/start")).toBeUndefined();
});

test("website favicon and installed app icons use new URLs for the supplied Command logo", async ({ page }) => {
  await login(page);
  const path = "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3";
  const faviconHref = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(faviconHref).toBe("/favicon-command.svg");
  const favicon = await page.request.get(faviconHref!);
  expect(await favicon.text()).toContain(path);
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await page.request.get(manifestHref!)).json();
  expect(manifest.id).toBe("/");
  expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([
    "/icons/icon-command-192.png", "/icons/icon-command-512.png", "/icons/icon-command-maskable-512.png",
  ]);
  const appleTouchHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(appleTouchHref).toBe("/icons/apple-touch-icon-command.png");
  for (const iconHref of [...manifest.icons.map((icon: { src: string }) => icon.src), appleTouchHref]) {
    const icon = await page.request.get(iconHref!);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/png");
  }
});
