import katex from 'katex';
import { Marked, Renderer, type Token } from 'marked';

const MAX_FORMULA_LENGTH = 16_000;
const MAX_MATH_CACHE_BYTES = 2 * 1024 * 1024;
const mathCache = new Map<string, { html: string | null; bytes: number }>();
let mathCacheBytes = 0;

export function clearConversationMathCache() { mathCache.clear(); mathCacheBytes = 0; }

export function escapeMathText(text: string) {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export type ConversationMath = { raw: string; formula: string; display: boolean };

function escaped(text: string, index: number) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Dollar edges follow the usual Markdown math convention, so prices such as
 * "$5 and $10" or an escaped "\\$5" are ordinary text. Braces and escaped
 * delimiters inside LaTeX must not terminate an expression early. */
export function conversationMathAt(text: string, index = 0): ConversationMath | null {
  const left = text.startsWith('$$', index) ? '$$' : text.startsWith('\\[', index) ? '\\['
    : text.startsWith('\\(', index) ? '\\(' : text[index] === '$' && text[index - 1] !== '$' ? '$' : '';
  if (!left || escaped(text, index)) return null;
  const right = left === '\\[' ? '\\]' : left === '\\(' ? '\\)' : left;
  const start = index + left.length;
  if (left === '$' && (!text[start] || /\s/.test(text[start]!))) return null;
  const closing = text.indexOf(right, start);
  if (closing < 0 || closing - start > MAX_FORMULA_LENGTH) return null;
  let braces = 0;
  for (let cursor = start; cursor < text.length && cursor - start <= MAX_FORMULA_LENGTH; cursor++) {
    const character = text[cursor]!;
    if (left === '$' && (character === '\n' || character === '\r')) return null;
    if (braces === 0 && text.startsWith(right, cursor)) {
      if (left === '$' && (text[cursor - 1] === '$' || text[cursor + 1] === '$' || /\s/.test(text[cursor - 1] || '') || /\d/.test(text[cursor + 1] || ''))) return null;
      const formula = text.slice(start, cursor);
      if (!formula.trim()) return null;
      return { raw: text.slice(index, cursor + right.length), formula, display: left === '$$' || left === '\\[' };
    }
    if (character === '\\') { cursor++; continue; }
    if (character === '{') braces++;
    else if (character === '}') braces = Math.max(0, braces - 1);
  }
  return null;
}

/** Keep renderer failures and user macros local to one formula. No URL, image,
 * class or style commands are trusted, and source/expansion/size limits bound
 * work and generated layout even for untrusted model output. */
export function renderConversationMath(math: ConversationMath): string | null {
  if (math.formula.length > MAX_FORMULA_LENGTH) return null;
  const key = JSON.stringify([math.display, math.formula]);
  const previous = mathCache.get(key);
  if (previous) { mathCache.delete(key); mathCache.set(key, previous); return previous.html; }
  let html: string | null = null;
  try {
    html = katex.renderToString(math.formula, {
      displayMode: math.display, output: 'htmlAndMathml', trust: false,
      throwOnError: true, strict: 'ignore', maxExpand: 1000, maxSize: 20,
      macros: {}, globalGroup: false,
    });
  } catch { /* Incomplete/unsupported LaTeX remains readable as its source. */ }
  const bytes = (key.length + (html?.length || 0)) * 2;
  if (bytes <= 128 * 1024) {
    mathCache.set(key, { html, bytes }); mathCacheBytes += bytes;
    while (mathCacheBytes > MAX_MATH_CACHE_BYTES || mathCache.size > 256) {
      const oldest = mathCache.keys().next().value!;
      mathCacheBytes -= mathCache.get(oldest)!.bytes; mathCache.delete(oldest);
    }
  }
  return html;
}

function mathHtml(math: ConversationMath) {
  return renderConversationMath(math) || escapeMathText(math.raw);
}

/** An isolated parser keeps conversation extensions out of file previews and
 * other users of Marked. Code/link tokens retain Marked's original behavior. */
export function createConversationMarkdownParser() {
  return new Marked({ renderer: {
    image(token) {
      // Marked's text renderer also calls extension renderers. Parsing image
      // alt tokens would therefore insert KaTeX markup inside a quoted attribute.
      // Use one escaped plain-text token while retaining Marked's URL/title rules.
      const text = escapeMathText(token.text);
      return Renderer.prototype.image.call(this, {
        ...token, tokens: [{ type: 'text', raw: token.text, text, escaped: true }],
      });
    },
  }, extensions: [
    {
      name: 'conversationBlockMath', level: 'block',
      start(source) { return /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source)?.index; },
      tokenizer(source) {
        const indentation = /^ {0,3}/.exec(source)![0].length;
        const math = conversationMathAt(source, indentation);
        if (!math?.display) return;
        const tail = source.slice(indentation + math.raw.length);
        const lineEnd = /^[ \t]*(?:\n|$)/.exec(tail);
        if (!lineEnd) return;
        return { type: 'conversationBlockMath', ...math, raw: source.slice(0, indentation + math.raw.length + lineEnd[0].length), rawMath: math.raw };
      },
      renderer(token: Token) {
        const block = token as Token & ConversationMath & { rawMath: string };
        const math = { raw: block.rawMath, formula: block.formula, display: true };
        return `<div class="conversation-math-block">${mathHtml(math)}</div>\n`;
      },
    },
    {
      name: 'conversationInlineMath', level: 'inline',
      start(source) {
        for (let index = 0; index < source.length; index++) {
          if (source[index] !== '$' && !source.startsWith('\\(', index) && !source.startsWith('\\[', index)) continue;
          if (escaped(source, index)) continue;
          if (source.startsWith('\\(', index) || source.startsWith('\\[', index)
            || (source[index] === '$' && conversationMathAt(source, index))) return index;
        }
      },
      tokenizer(source) {
        // HTML code/pre blocks are literal, like fenced and inline code.
        if (this.lexer.state.inRawBlock) return;
        const math = conversationMathAt(source);
        if (math) return { type: 'conversationInlineMath', ...math };
        // Streaming may stop after an opening delimiter. Preserve its slash
        // rather than letting Markdown treat it as an ordinary punctuation escape.
        if (source.startsWith('\\(') || source.startsWith('\\[')) {
          return { type: 'conversationInlineMath', raw: source.slice(0, 2) };
        }
      },
      renderer(token: Token) {
        const math = token as Token & Partial<ConversationMath>;
        return typeof math.formula === 'string' ? mathHtml(math as ConversationMath) : escapeMathText(math.raw);
      },
    },
  ] });
}

function literalCodeEnd(text: string, index: number): number | null {
  if (index === 0 || text[index - 1] === '\n') {
    const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(text.slice(index));
    if (opening) {
      const marker = opening[1]![0]!, width = opening[1]!.length;
      const closing = new RegExp(`^ {0,3}${marker}{${width},}[ \\t]*(?:\\n|$)`, 'gm');
      closing.lastIndex = index + opening[0].length;
      const end = closing.exec(text);
      return end ? end.index + end[0].length : text.length;
    }
  }
  if (text[index] !== '`' || escaped(text, index)) return null;
  const marker = /^`+/.exec(text.slice(index))![0];
  let closing = index + marker.length;
  while ((closing = text.indexOf(marker, closing)) !== -1) {
    if (text[closing - 1] !== '`' && text[closing + marker.length] !== '`') return closing + marker.length;
    closing += marker.length;
  }
  return text.length;
}

/** User bubbles retain every non-math character and whitespace; this does not
 * interpret Markdown or HTML. Null preserves the ordinary plain-text path. */
export function plainMessageMath(text: string): string | null {
  let html = '', literalStart = 0, rendered = false;
  for (let index = 0; index < text.length;) {
    const codeEnd = literalCodeEnd(text, index);
    if (codeEnd !== null) { index = codeEnd; continue; }
    const math = (text[index] === '$' || text[index] === '\\') ? conversationMathAt(text, index) : null;
    if (!math) { index++; continue; }
    const formulaHtml = renderConversationMath(math);
    if (formulaHtml) {
      html += escapeMathText(text.slice(literalStart, index)) + formulaHtml;
      literalStart = index + math.raw.length; rendered = true;
    }
    index += math.raw.length;
  }
  return rendered ? html + escapeMathText(text.slice(literalStart)) : null;
}
