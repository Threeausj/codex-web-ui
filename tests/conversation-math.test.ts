import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { clearConversationMathCache, conversationMathAt, createConversationMarkdownParser, plainMessageMath, renderConversationMath } from '../src/lib/conversation-math';

const parser = createConversationMarkdownParser();
const parse = (text: string) => parser.parse(text, { async: false });
const countMath = (html: string) => (html.match(/class="katex"/g) || []).length;

test('conversation math supports dollar and LaTeX delimiters, multiline matrices and MathML', () => {
  const html = parse(String.raw`Inline $a_b^2 + \frac{1}{2}$ and \(\sqrt{x}\).

$$
\begin{aligned} x &= 1 \\ y &= 2 \end{aligned}
$$

\[
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\]`);
  assert.equal(countMath(html), 4);
  assert.equal((html.match(/class="conversation-math-block"/g) || []).length, 2);
  assert.match(html, /<math[^>]*xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(html, /<annotation encoding="application\/x-tex">/);
});

test('math survives Markdown tables, lists, emphasis and reference links', () => {
  const html = parse(String.raw`- **Formula $a_b^2$** followed by _emphasis_.
- \(\alpha + \beta\)

| Name | Formula |
| --- | --- |
| Integral | $\int_0^1 x\,dx$ |
| Absolute | $\lvert x\rvert$ |
| Markdown escaped pipe | $\|y\|$ |

[Reference][ref]

[ref]: https://example.com`);
  assert.equal(countMath(html), 5);
  assert.match(html, /<strong>Formula <span class="katex">/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<table>/);
  assert.match(html, /<a href="https:\/\/example.com">Reference<\/a>/);
});

test('prices, escaped currency and whitespace do not become formulas', () => {
  for (const text of [String.raw`Costs $5 and $10.`, String.raw`Costs \$5 and \$10.`, '$ x $', '$5 and $10 per month', '$x\n+y$', '$$ $$', String.raw`\\(x\\)`]) {
    assert.equal(countMath(parse(text)), 0, text);
    assert.equal(plainMessageMath(text), null, text);
  }
  assert.equal(countMath(parse('The ratio is $5/10$ and $x + y$.')), 2);
  assert.equal(countMath(parse('Costs $5 and $10; actual $x^2$.')), 1);
  assert.equal(countMath(plainMessageMath('Costs $5 and $10; actual $x^2$.')!), 1);
});

test('inline, fenced, indented and HTML code are literal in Markdown', () => {
  const text = String.raw`Inline ${'`'}$x^2$\(y\)${'`'}.

~~~latex
$$x^2$$
\[y\]
~~~

    $indented$

<pre><code>$html$</code></pre>

Visible $z^2$.`;
  const html = parse(text);
  assert.equal(countMath(html), 1);
  assert.match(html, /<code>\$x\^2\$/);
  assert.match(html, /<pre><code class="language-latex">/);
  assert.match(html, /<pre><code>\$indented\$/);
  assert.match(html, /<pre><code>\$html\$<\/code><\/pre>/);
});

test('user bubble math preserves ordinary text, whitespace, HTML and code literals', () => {
  const text = '  <b>plain</b>\n\t$x^2$ **plain** `\\(code\\)`\n```latex\n$literal$\n```\nend';
  const html = plainMessageMath(text)!;
  assert.equal(countMath(html), 1);
  assert.ok(html.startsWith('  &lt;b&gt;plain&lt;/b&gt;\n\t'));
  assert.ok(html.endsWith(' **plain** `\\(code\\)`\n```latex\n$literal$\n```\nend'));
  assert.doesNotMatch(html, /<b>|<strong>|<code>/);
  assert.equal(plainMessageMath('plain `unterminated $x$'), null);
  assert.equal(plainMessageMath('~~~\n$x$'), null);
});

test('streaming incomplete or malformed math does not crash or consume later Markdown', () => {
  for (const text of ['$x^', '$$\\frac{1}', String.raw`\[\sum_{i=`, String.raw`\(x+`, String.raw`$\frac{1}$`]) {
    assert.doesNotThrow(() => parse(text));
    assert.equal(countMath(parse(text)), 0, text);
    assert.equal(plainMessageMath(text), null, text);
  }
  assert.equal(countMath(parse('Before $x^2$ after.')), 1);
  assert.match(parse(String.raw`Before \(x+`), /Before \\\(x\+/);
  assert.match(parse(String.raw`Before \[\sum_{i=`), /Before \\\[/);
  assert.match(parse(String.raw`$\unsupported$ **Still readable**`), /\$\\unsupported\$ <strong>Still readable<\/strong>/);
});

test('escaped delimiters and delimiters inside LaTeX braces do not terminate early', () => {
  const expression = String.raw`$\text{a \$ b}+x$`;
  assert.equal(conversationMathAt(expression)?.formula, String.raw`\text{a \$ b}+x`);
  assert.equal(countMath(parse(expression)), 1);
  assert.equal(conversationMathAt(String.raw`\(\text{\)}+x\)`)?.formula, String.raw`\text{\)}+x`);
});

test('untrusted math cannot create links, images, styles or shared macro state', () => {
  for (const formula of [String.raw`\href{javascript:alert(1)}{click}`, String.raw`\includegraphics{https://evil.example/image}`, String.raw`\htmlStyle{position:fixed}{x}`]) {
    const html = renderConversationMath({ raw: `$${formula}$`, formula, display: false }) || '';
    assert.doesNotMatch(html, /<a\b|<img\b|style="[^"]*position:fixed|href=/);
  }
  assert.ok(renderConversationMath({ raw: '', formula: String.raw`\gdef\custom{1}\custom`, display: false }));
  assert.equal(renderConversationMath({ raw: '$\\custom$', formula: String.raw`\custom`, display: false }), null);
  assert.equal(renderConversationMath({ raw: '', formula: String.raw`\def\recursive{\recursive}\recursive`, display: false }), null);
  const html = renderConversationMath({ raw: '', formula: String.raw`\rule{999999em}{999999em}`, display: false })!;
  assert.doesNotMatch(html, /style="[^"]*999999em/);
  assert.match(html, /style="[^"]*20em/);
  assert.equal(renderConversationMath({ raw: '', formula: 'x'.repeat(16_001), display: false }), null);
  clearConversationMathCache();
});

test('conversation parser does not alter the global Markdown parser or stable block contents', () => {
  assert.equal(countMath(marked.parse('$x^2$', { async: false })), 0);
  const initial = parser.lexer('Stable $x^2$.\n\nStreaming');
  const next = parser.lexer('Stable $x^2$.\n\nStreaming $y^2$');
  assert.deepEqual(initial[0], next[0]);
  assert.equal(parser.parser([initial[0]!]), parser.parser([next[0]!]));
});

test('display math consumes its indentation and closing newline without shifting following paragraphs', () => {
  const tokens = parser.lexer('  $$x^2$$\n\nAfter **math**.\n\n\\[y^2\\]\nNext paragraph.');
  assert.equal(tokens[0]?.raw, '  $$x^2$$\n\n');
  assert.equal(tokens.filter(token => token.type === 'conversationBlockMath').length, 2);
  const html = parser.parser(tokens);
  assert.equal(countMath(html), 2);
  assert.match(html, /After <strong>math<\/strong>/);
  assert.match(html, /Next paragraph\./);
});

test('image descriptions keep formula source and hostile quotes inside an escaped alt attribute', () => {
  const dollar = parse('![Dollar $x$](https://example.com/image.png "normal title")');
  assert.equal(countMath(dollar), 0);
  assert.match(dollar, /<img src="https:\/\/example.com\/image.png" alt="Dollar \$x\$" title="normal title">/);
  const latex = parse(String.raw`![formula \(x\)](./plot.png)`);
  assert.equal(countMath(latex), 0);
  assert.match(latex, /<img src="\.\/plot.png" alt="formula \\\(x\\\)">/);
  const hostile = parse('![Dollar $x$ " onerror="alert(1) <script> & symbols](./plot.png "quote \\" test")');
  assert.equal(countMath(hostile), 0);
  assert.match(hostile, /alt="Dollar \$x\$ &quot; onerror=&quot;alert\(1\) &lt;script&gt; &amp; symbols"/);
  assert.doesNotMatch(hostile, /alt="[^"]*<span| onerror="|<script>/);
  const linked = parse('[![math $x$](./plot.png)](https://example.com)');
  assert.match(linked, /<a href="https:\/\/example.com"><img src="\.\/plot.png" alt="math \$x\$"><\/a>/);
});
