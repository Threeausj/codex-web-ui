import styles from './visualization-frame.css?raw';

const cdns = 'https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com';
const chartAssets = 'https://persistent.oaistatic.com/plugins/visualize/';
const policy = [
  "default-src 'none'",
  "script-src 'unsafe-inline' " + cdns + ' ' + chartAssets,
  "style-src 'unsafe-inline' " + cdns + ' ' + chartAssets + ' https://fonts.googleapis.com https://fonts.bunny.net',
  'img-src data: blob: ' + cdns,
  'font-src data: https://fonts.gstatic.com https://fonts.bunny.net ' + cdns,
  'media-src data: blob: ' + cdns,
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

// Run the fragment in an opaque iframe. Its only message handled by the
// conversation is a bounded content-height update.
const runtime = `
let widgetState = null;
window.openai = {
  get widgetState() { return widgetState; },
  async setWidgetState(state) { widgetState = state; },
};
document.addEventListener('DOMContentLoaded', () => {
  let previous = 0;
  const measure = () => {
    const body = document.body;
    const height = Math.max(1, body.offsetHeight, body.scrollHeight);
    if (height === previous) return;
    previous = height;
    parent.postMessage({ type: 'codex-visualization-height', height }, '*');
  };
  new ResizeObserver(measure).observe(document.body);
  measure();
});
`;

export function visualizationFrame(fragment: string) {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy}">
<style>${styles}</style><script>${runtime}</script>
</head><body>${fragment}</body></html>`;
}
