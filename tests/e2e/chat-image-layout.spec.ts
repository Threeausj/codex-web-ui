import { test, expect, login } from './fixtures';
import type { Locator, Page } from '@playwright/test';

const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#467458"/></svg>';
const viewports = [{ width: 1280, height: 900 }, { width: 390, height: 844 }];
const imageUrl = (index: number) => `https://images.example/picture-${index}.svg`;
const imagePath = (index: number) => `/workspace/demo/picture-${index}.png`;

async function openExisting(page: Page) {
  await login(page);
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator('.user-message')).toBeVisible();
}

async function expectRightAlignedRows(message: Locator) {
  const layout = await message.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left, right: bounds.right,
      bubbleRight: element.querySelector('.user-bubble')?.getBoundingClientRect().right,
      images: [...element.querySelectorAll('.message-images > button')].map(image => {
        const box = image.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, width: box.width };
      }),
    };
  });
  if (layout.bubbleRight !== undefined) expect(layout.bubbleRight).toBeCloseTo(layout.right, 0);
  const rows = new Map<number, typeof layout.images>();
  for (const image of layout.images) {
    expect(image.left).toBeGreaterThanOrEqual(layout.left - 1);
    expect(image.right).toBeLessThanOrEqual(layout.right + 1);
    const top = Math.round(image.top);
    rows.set(top, [...(rows.get(top) || []), image]);
  }
  expect(rows.size).toBeGreaterThan(0);
  for (const row of rows.values()) {
    expect(Math.max(...row.map(image => image.right)), 'each image row ends at the user message right edge').toBeCloseTo(layout.right, 0);
  }
}

async function expectAttachmentAboveBubble(message: Locator) {
  const position = await message.evaluate(element => {
    const images = element.querySelector('.message-images')!.getBoundingClientRect();
    const bubble = element.querySelector('.user-bubble')!.getBoundingClientRect();
    return { imageBottom: images.bottom, bubbleTop: bubble.top };
  });
  expect(position.imageBottom).toBeLessThanOrEqual(position.bubbleTop);
  expect(position.bubbleTop - position.imageBottom).toBeLessThanOrEqual(9);
}

async function expectImagesLoaded(message: Locator, count: number) {
  await expect(message.locator('.message-images img')).toHaveCount(count);
  for (const image of await message.locator('.message-images img').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1600);
    // Native-history pictures and new upload previews use the same thumbnail size.
    expect((await image.boundingBox())!.width).toBeLessThanOrEqual(230);
    const alignment = await image.evaluate(element => ({
      imageRight: element.getBoundingClientRect().right,
      controlRight: element.parentElement!.getBoundingClientRect().right,
    }));
    expect(alignment.imageRight, 'the visible image reaches the attachment control right edge').toBeCloseTo(alignment.controlRight, 0);
  }
  await expectRightAlignedRows(message);
}

for (const viewport of viewports) {
  for (const kind of ['native', 'image-only', 'mixed'] as const) {
    test(`${kind} user images stay right aligned before/after loading at ${viewport.width}px`, async ({ page, mock }) => {
      await page.setViewportSize(viewport);
      let releaseImages!: () => void;
      const imagesReleased = new Promise<void>(resolve => { releaseImages = resolve; });
      const imageRoute = async (route: import('@playwright/test').Route) => {
        await imagesReleased;
        await route.fulfill({ contentType: 'image/svg+xml', body: picture });
      };
      await page.route('**/api/hosts/*/images?*', imageRoute);
      await page.route('https://images.example/**', imageRoute);
      const images = Array.from({ length: 4 }, (_, index) =>
        kind === 'native' || (kind === 'mixed' && index % 2 === 0)
          ? { type: 'localImage', path: imagePath(index) }
          : { type: 'image', url: imageUrl(index) });
      mock.turns.get('thread-existing')![0].items[0].content = [
        ...(kind === 'image-only' ? [] : [{ type: 'text', text: '请查看这些图片', text_elements: [] }]),
        ...images,
      ];
      await openExisting(page);
      const message = page.locator('.user-message');
      await expect(message.locator('.message-images img')).toHaveCount(images.length);
      try {
        await expectRightAlignedRows(message);
      } finally {
        releaseImages();
      }
      await expectImagesLoaded(message, images.length);
      const sources = await message.locator('.message-images img').evaluateAll(elements => elements.map(image => image.getAttribute('src')));
      // Mixed live/native inputs retain their original order rather than forming two groups.
      expect(sources).toEqual(images.map(image => image.type === 'localImage'
        ? `/api/hosts/local/images?${new URLSearchParams({ path: image.path! })}` : image.url));
    });
  }

  test(`native hydration and cached reload keep user attachments on the right at ${viewport.width}px`, async ({ page, mock }) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/hosts/*/images?*', route => route.fulfill({ contentType: 'image/svg+xml', body: picture }));
    await page.route('https://images.example/**', route => route.fulfill({ contentType: 'image/svg+xml', body: picture }));
    const user = mock.turns.get('thread-existing')![0].items[0];
    user.content.push(...Array.from({ length: 4 }, (_, index) => ({ type: 'image', url: imageUrl(index) })));
    await openExisting(page);
    const message = page.locator('.user-message');
    await expectImagesLoaded(message, 4);
    const previewWidths = await message.locator('.message-images img').evaluateAll(elements => elements.map(image => image.getBoundingClientRect().width));
    user.content = [user.content[0], ...Array.from({ length: 4 }, (_, index) => ({ type: 'localImage', path: imagePath(index) }))];
    mock.emit('item/completed', { threadId: 'thread-existing', turnId: 'turn-history', item: user });
    await expect(message.locator('.conversation-image')).toHaveCount(4);
    await expectImagesLoaded(message, 4);
    expect(await message.locator('.message-images img').evaluateAll(elements => elements.map(image => image.getBoundingClientRect().width))).toEqual(previewWidths);
    await page.reload();
    await expect(message.locator('.conversation-image')).toHaveCount(4);
    await expectImagesLoaded(message, 4);
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 900 }, { width: 390, height: 844 }]) {
  test(`a single image stays aligned with a long user bubble through workspace resize and streaming at ${viewport.width}px`, async ({ page, mock }) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/hosts/*/images?*', route => route.fulfill({ contentType: 'image/svg+xml', body: picture }));
    const turn = mock.turns.get('thread-existing')![0];
    turn.items[0].content = [
      { type: 'text', text: '1.优化会话显示与筛选\n2.这是带有一张图片的较长消息，图片应与此消息的右侧边缘对齐。'.repeat(4), text_elements: [] },
      { type: 'localImage', path: imagePath(0) },
    ];
    await openExisting(page);
    const message = page.locator('.user-message');
    await expectImagesLoaded(message, 1);
    await expectAttachmentAboveBubble(message);
    if (viewport.width > 760) {
      await page.getByRole('button', { name: '切换工作区', exact: true }).click();
      const handle = page.getByRole('separator', { name: '调整工作区宽度', exact: true });
      await expect(handle).toBeVisible();
      await handle.focus();
      await page.keyboard.press('End');
      await expectImagesLoaded(message, 1);
      await expectAttachmentAboveBubble(message);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    mock.emit('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-history', itemId: 'history-agent', delta: '\n收到图片后继续检查。' });
    await expect(page.locator('.agent-message')).toContainText('收到图片后继续检查。');
    await expectImagesLoaded(message, 1);
    await expectAttachmentAboveBubble(message);
    await page.screenshot({ path: `.data/chat-image-alignment-${viewport.width}.png` });
  });
}
