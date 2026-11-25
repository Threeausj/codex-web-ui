const source = JSON.parse(document.getElementById('diagram-source').textContent);
const container = document.getElementById('diagram');
const colorScheme = matchMedia('(prefers-color-scheme: dark)');
let minimumWidth = 0;
let rendering = false;

function reportSize() {
  if (minimumWidth === 0) return;
  parent.postMessage({
    type: 'mermaid-diagram',
    height: Math.ceil(document.body.getBoundingClientRect().height),
    minimumWidth,
  }, '*');
}

async function render() {
  if (rendering) return;
  rendering = true;
  const dark = colorScheme.matches;
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: 24_000,
      maxEdges: 150,
      secure: ['secure', 'startOnLoad', 'securityLevel', 'htmlLabels', 'flowchart', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'themeCSS'],
      fontFamily: 'system-ui, sans-serif',
      theme: 'base',
      themeVariables: {
        darkMode: dark,
        fontSize: '16px',
        primaryColor: dark ? '#20344d' : '#edf4ff',
        primaryBorderColor: dark ? '#547cae' : '#b7ceef',
        primaryTextColor: dark ? '#e2edfd' : '#234a81',
        lineColor: dark ? '#9aaac1' : '#6b7c92',
      },
      flowchart: { curve: 'basis', htmlLabels: false },
    });
    const { svg } = await mermaid.render('rendered-mermaid', source);
    container.innerHTML = svg;
    const diagram = container.querySelector('svg');
    if (!diagram?.viewBox.baseVal.width) throw new Error('Missing diagram dimensions');
    const width = diagram.viewBox.baseVal.width;
    diagram.style.maxWidth = Math.ceil(width) + 'px';
    minimumWidth = Math.ceil(width * 0.8) + 8;
    reportSize();
  } catch {
    parent.postMessage({ type: 'mermaid-diagram', failed: true }, '*');
  } finally {
    rendering = false;
    if (dark !== colorScheme.matches) void render();
  }
}

new ResizeObserver(reportSize).observe(document.body);
colorScheme.addEventListener('change', render);
void render();
