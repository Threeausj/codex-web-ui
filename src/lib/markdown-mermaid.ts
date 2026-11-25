import type { Token } from 'marked';

export function mermaidSource(token: Token): string | undefined {
  if (token.type !== 'code' || !/^mermaid(?:\s|$)/i.test(token.lang || '')) return;
  const fence = /^ {0,3}([`~])\1{2,}/.exec(token.raw);
  if (!fence) return;
  const closing = new RegExp('\n {0,3}' + fence[1] + '{' + fence[0].trimStart().length + ',}$');
  if (closing.test(token.raw.trimEnd())) return token.text;
}
