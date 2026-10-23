/// <reference lib="webworker" />
import { prepareOfficeBytes, SHEET_MAX_ROWS, SHEET_PAGE_COLUMNS, SHEET_PAGE_ROWS, type SpreadsheetPage } from './office-preview';
import type { OfficeFileKind } from './file-preview';
import type * as Sheets from '@stackline/xlsx';

let bytes: Uint8Array | undefined, names: string[] = [], selected = -1, workbook: Sheets.WorkBook | undefined;
let library: typeof Sheets | undefined;
const requestPage = (sheetIndex: number, rowStart: number, columnStart: number): SpreadsheetPage => {
  if (!bytes || !library || !names.length) throw new Error('工作簿没有可预览的工作表');
  const index = Math.max(0, Math.min(Math.floor(sheetIndex) || 0, names.length - 1));
  if (selected !== index || !workbook) {
    workbook = library.read(bytes, { type: 'array', sheets: index, sheetRows: SHEET_MAX_ROWS + 1,
      cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, cellText: true });
    selected = index;
  }
  const sheet = workbook.Sheets[names[index]!] || {};
  const range = library.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const full = library.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1:A1');
  const rowCount = Math.min(SHEET_MAX_ROWS, Math.max(1, full.e.r + 1)), columnCount = Math.min(16384, Math.max(1, range.e.c + 1));
  const first = Math.max(0, Math.min(Math.floor(rowStart) || 0, Math.floor((rowCount - 1) / SHEET_PAGE_ROWS) * SHEET_PAGE_ROWS));
  const left = Math.max(0, Math.min(Math.floor(columnStart) || 0, Math.floor((columnCount - 1) / SHEET_PAGE_COLUMNS) * SHEET_PAGE_COLUMNS));
  const rows = Array.from({ length: Math.min(SHEET_PAGE_ROWS, rowCount - first) }, (_, r) => Array.from({ length: Math.min(SHEET_PAGE_COLUMNS, columnCount - left) }, (_, c) => {
    const cell = sheet[library!.utils.encode_cell({ r: first + r, c: left + c })];
    // Cached formula results are displayed; no formula engine, hyperlinks,
    // generated HTML or macros are executed in the preview.
    const text = cell ? String(cell.w ?? cell.v ?? '') : '';
    return text.length > 4000 ? text.slice(0, 4000) + '…' : text;
  }));
  return { sheetNames: names, sheetIndex: index, rows, rowStart: first, rowEnd: first + rows.length, columnStart: left,
    columnEnd: left + (rows[0]?.length || 0), rowCount, columnCount, limited: full.e.r + 1 > SHEET_MAX_ROWS };
};
self.onmessage = async (event: MessageEvent<{ id: number; type: 'load' | 'page'; bytes?: Uint8Array; kind?: OfficeFileKind; sheetIndex?: number; rowStart?: number; columnStart?: number }>) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      workbook = undefined; selected = -1; names = [];
      const safe = await prepareOfficeBytes(message.bytes!, message.kind!, new AbortController().signal);
      if (message.kind !== 'xlsx' && message.kind !== 'xls') {
        self.postMessage({ id: message.id, bytes: safe }, { transfer: [safe.buffer] }); return;
      }
      bytes = safe; library = await import('@stackline/xlsx');
      const metadata = library.read(bytes, { type: 'array', bookSheets: true, bookProps: false, bookVBA: false });
      names = metadata.SheetNames;
      if (names.length > 256) throw new Error('工作表过多，请下载原文件查看');
    }
    self.postMessage({ id: message.id, page: requestPage(message.sheetIndex || 0, message.rowStart || 0, message.columnStart || 0) });
  } catch (cause: any) {
    self.postMessage({ id: message.id, error: cause?.message || 'Office 文件读取失败，请下载原文件查看' });
  }
};
