import type { Page } from '@playwright/test';
import { test, expect, login, MockCodex } from './fixtures';

const path = String.raw`C:\Users\tester\.codex\visualizations\heatmap.html`;
const marker = (file: string) => '\uE200visualize\uE202' + JSON.stringify({ path: file, title: '测试热图' }) + '\uE201';
const fragment = `
<h2>测试热图</h2>
<div class="viz-controls">
  <label class="form-label">听后评分
    <select class="form-select"><option>激发度</option><option>效价</option></select>
  </label>
</div>
<output>激发度</output>
<div id="details" style="height: 130px"></div>
<script>
  const choice = document.querySelector('select');
  choice.addEventListener('change', () => {
    document.querySelector('output').textContent = choice.value;
    document.querySelector('#details').style.height = '30px';
  });
</script>`;

function answer(mock: MockCodex, text: string) {
  mock.turns.get('thread-existing')![0].items[1].text = text;
}

async function openThread(page: Page, hostId: string) {
  if ((page.viewportSize()?.width || 1280) <= 760)
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"] .thread-row`).first().click();
}

test('a native visualization runs in the conversation and fits when its controls resize it', async ({ page, mock }) => {
  await page.setViewportSize({ width: 320, height: 650 });
  answer(mock, '报告 $x^2$。\n\n[PDF](/workspace/report.pdf) · [ZIP](/workspace/figures.zip) · [Excel](/workspace/stats.xlsx) · [报告](/workspace/report.md) · [官网](https://example.com/report.pdf)\n' + marker(path));
  const files: string[] = [];
  await page.route('**/api/hosts/*/files?*', route => {
    const url = new URL(route.request().url());
    files.push(url.pathname + '?path=' + url.searchParams.get('path'));
    return route.fulfill({ json: { dataBase64: Buffer.from(fragment).toString('base64') } });
  });
  await login(page);
  await openThread(page, 'local');
  const message = page.locator('[data-selection-item-id="history-agent"]');
  await expect(message.locator('.katex')).toHaveCount(1);
  await expect(message).not.toContainText('\uE200visualize');
  for (const [name, type] of [['PDF', 'pdf'], ['ZIP', 'archive'], ['Excel', 'spreadsheet'], ['报告', 'document']]) {
    const link = message.getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('data-conversation-file', type);
    expect(await link.evaluate(element => getComputedStyle(element, '::before').maskImage)).toMatch(/^url\(/);
  }
  await expect(message.getByRole('link', { name: '官网' })).not.toHaveAttribute('data-conversation-file', /.+/);
  const frame = message.locator('iframe[title="测试热图"]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await frame.evaluate((element: HTMLIFrameElement) => element.contentDocument)).toBeNull();
  const chart = frame.contentFrame();
  await expect(chart.getByRole('heading', { name: '测试热图' })).toBeVisible();
  await expect(chart.locator('output')).toHaveText('激发度');
  const height = () => frame.evaluate(element => element.clientHeight);
  await expect.poll(height).toBeGreaterThan(160);
  const initial = await height();
  await chart.getByLabel('听后评分').selectOption({ label: '效价' });
  await expect(chart.locator('output')).toHaveText('效价');
  await expect.poll(height).toBeLessThan(initial - 50);
  expect(await chart.locator('body').evaluate(body => body.scrollWidth <= innerWidth)).toBe(true);
  expect(files).toEqual(['/api/hosts/local/files?path=' + path]);
});

test('remote visualizations use their conversation host and can retry when a file is absent', async ({ page, mock }) => {
  const remote = new MockCodex();
  mock.hosts.push({ id: 'visualization-host', name: '图表主机', kind: 'ssh', hostname: 'fixture.invalid' });
  mock.hostMocks.set('visualization-host', remote);
  remote.threads[0]!.name = remote.threads[0]!.preview = '远程交互图表';
  const file = '/home/test/.codex/visualizations/remote.html';
  answer(remote, '报告。\n' + marker(file));
  const paths: string[] = [];
  let available = false;
  await page.route('**/api/hosts/*/files?*', route => {
    const url = new URL(route.request().url());
    paths.push(url.pathname + '?path=' + url.searchParams.get('path'));
    return available ? route.fulfill({ json: { dataBase64: Buffer.from(fragment).toString('base64') } })
      : route.fulfill({ status: 404, json: { error: 'missing' } });
  });
  await login(page);
  await openThread(page, 'visualization-host');
  const message = page.locator('[data-selection-item-id="history-agent"]');
  await expect(message.getByRole('status')).toHaveText('找不到图表文件，可能已移动或删除。');
  available = true;
  await message.getByRole('button', { name: '重试' }).click();
  await expect(message.frameLocator('iframe').getByRole('heading', { name: '测试热图' })).toBeVisible();
  expect(paths.length).toBeGreaterThanOrEqual(2);
  expect([...new Set(paths)]).toEqual(['/api/hosts/visualization-host/files?path=' + file]);
});

test('visualization markers in literal code and invalid paths remain text', async ({ page, mock }) => {
  answer(mock, [
    '~~~text\n' + marker(path) + '\n~~~',
    marker('https://example.com/plot.html'),
    marker('/root/notes.txt'),
  ].join('\n\n'));
  let reads = 0;
  await page.route('**/api/hosts/*/files?*', route => { reads++; return route.abort(); });
  await login(page);
  await openThread(page, 'local');
  const message = page.locator('[data-selection-item-id="history-agent"]');
  await expect(message.locator('pre')).toContainText(marker(path));
  await expect(message).toContainText('https://example.com/plot.html');
  await expect(message).toContainText('/root/notes.txt');
  await expect(message.locator('iframe')).toHaveCount(0);
  expect(reads).toBe(0);
});
