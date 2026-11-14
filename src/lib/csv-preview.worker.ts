import { parseCsv, CSV_PAGE_ROWS, CSV_PAGE_COLUMNS, type CsvData } from './csv-preview';
let data: CsvData | undefined;
self.onmessage = event => {
  const { id, type, content, delimiter, row = 0, column = 0 } = event.data;
  try {
    if (type === 'load') data = parseCsv(content, delimiter);
    if (!data) throw new Error('CSV 尚未加载');
    const start = Math.max(0, Math.min(data.rows.length, Math.floor(row)));
    const left = Math.max(0, Math.min(data.columns, Math.floor(column)));
    let clipped = false;
    const visible = (cells: string[]) => cells.slice(left, left + CSV_PAGE_COLUMNS).map(cell => {
      if (cell.length <= 4096) return cell;
      clipped = true;return cell.slice(0, 4096) + '…';
    });
    self.postMessage({ id, rows: data.rows.slice(start, start + CSV_PAGE_ROWS).map(visible),
      header: visible(data.rows[0] || []), clipped, rowCount: data.rows.length, columnCount: data.columns,
      rowStart: start, columnStart: left, delimiter: data.delimiter, truncated: data.truncated, warning: data.warning });
  } catch (cause: any) { self.postMessage({ id, error: cause.message || 'CSV 解析失败' }); }
};
