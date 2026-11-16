export const CSV_PAGE_ROWS = 100;
export const CSV_PAGE_COLUMNS = 40;
export const isCsvPath = (path: string) => /\.(?:csv|tsv)$/i.test(path);
export type CsvData = { rows: string[][]; columns: number; delimiter: string; truncated: boolean; warning: string };

/** A bounded RFC 4180 reader. Values remain literal text, including formulas. */
export function parseCsv(text: string, delimiter?: string, limits = { rows: 100000, cells: 1000000 }): CsvData {
  text = text.replace(/^\uFEFF/, '');
  if (!delimiter) {
    const candidates = [',', '\t', ';'];
    const score = (candidate: string) => {
      let quoted = false, counts: number[] = [], count = 0;
      for (let i = 0; i < Math.min(text.length, 65536) && counts.length < 25; i++) {
        const c = text[i];
        if (c === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
        else if (!quoted && c === candidate) count++;
        else if (!quoted && (c === '\r' || c === '\n')) { if (c === '\r' && text[i + 1] === '\n') i++; counts.push(count); count = 0; }
      }
      if (!counts.length) counts.push(count);
      const frequencies = new Map<number, number>();
      for (const value of counts) if (value) frequencies.set(value, (frequencies.get(value) || 0) + 1);
      return Math.max(0, ...[...frequencies].map(([value, frequency]) => frequency / counts.length * 100 + Math.min(value, 30)));
    };
    delimiter = candidates.reduce((best, value) => score(value) > score(best) ? value : best, ',');
  }
  if (![',', '\t', ';'].includes(delimiter)) throw new Error('不支持的 CSV 分隔符');
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, afterQuote = false, cells = 0, truncated = false, warning = '';
  const addCell = () => { row.push(cell); cell = ''; cells++; afterQuote = false; };
  const addRow = () => { addCell(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; afterQuote = true; } }
      else cell += c;
    } else if (c === delimiter) addCell();
    else if (c === '\r' || c === '\n') { addRow(); if (c === '\r' && text[i + 1] === '\n') i++; }
    else if (c === '"' && cell === '' && !afterQuote) quoted = true;
    else { if (afterQuote && c.trim()) warning = '部分字段的引号格式不规范，已尽量保留原文。'; cell += c; }
    if (cells >= limits.cells || rows.length >= limits.rows || row.length >= 10000 || cell.length > 1048576) { truncated = true; break; }
  }
  if (!truncated && (cell || row.length || afterQuote || quoted)) addRow();
  if (quoted && !truncated) warning = '存在未闭合的引号，请在源码中检查。';
  return { rows, columns: rows.reduce((max, row) => Math.max(max, row.length), 0), delimiter, truncated, warning };
}
export function decodeCsvBytes(bytes: Uint8Array): { content: string; encoding: string } {
  let encoding = 'UTF-8', content: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'UTF-16LE';content = new TextDecoder('utf-16le', { fatal: true }).decode(bytes); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'UTF-16BE';content = new TextDecoder('utf-16be', { fatal: true }).decode(bytes); }
  else try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { encoding = 'GB18030';content = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
  if (content.includes('\0')) throw new Error('CSV 包含二进制内容');
  return { content, encoding };
}
