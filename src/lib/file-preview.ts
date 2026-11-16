import { isAbsoluteHostPath, isWindowsHostPath, normalizeHostPath, joinHostPath, hostDirname, withinHostPath } from '../../shared/host-path';
/** Resolve a Markdown file reference without treating it as a browser URL. */
export function previewFilePath(reference: string, filePath: string, root: string): string | null {
  let value: string;
  try { value = decodeURIComponent(reference.split(/[?#]/, 1)[0] || ""); }
  catch { return null; }
  if (!value || /[\x00-\x1f]/.test(value) || value.startsWith('//') || value.startsWith('\\\\') ||
      /^[a-z][a-z0-9+.-]*:/i.test(value) && !isWindowsHostPath(value) || value.includes('\\') && !isWindowsHostPath(filePath)) return null;
  if (!isAbsoluteHostPath(filePath) || !isAbsoluteHostPath(root)) return null;
  const path = isAbsoluteHostPath(value) ? normalizeHostPath(value) : joinHostPath(hostDirname(filePath), value);
  return withinHostPath(root, path) ? path : null;
}

export function isMarkdownPath(path: string) { return /\.(?:md|markdown|mdown)$/i.test(path); }
export function isImagePath(path: string) { return /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path); }

export type OfficeFileKind = 'docx' | 'xlsx' | 'xls' | 'pptx' | 'legacy';
export function officeFileKind(path: string): OfficeFileKind | null {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return extension && ['docx', 'xlsx', 'xls', 'pptx'].includes(extension) ? extension as OfficeFileKind :
    extension && ['doc', 'ppt'].includes(extension) ? 'legacy' : null;
}
export function officeMime(path: string): string | undefined {
  const kind = officeFileKind(path);
  return kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
    kind === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' :
    kind === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' :
    kind === 'xls' ? 'application/vnd.ms-excel' : kind === 'legacy' ? 'application/octet-stream' : undefined;
}

/** Absolute Markdown file links may carry a one-based line and column. */
export function fileLinkLocation(reference: string): { path: string; line?: number; column?: number } | null {
  let value: string; try { value = decodeURIComponent(reference); } catch { return null; }
  if (!isAbsoluteHostPath(value) || value.startsWith('//')) return null;
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(value);
  if (!match) return { path: value };
  const line = Number(match[2]), column = match[3] ? Number(match[3]) : undefined;
  return Number.isSafeInteger(line) && line > 0 && (column === undefined || Number.isSafeInteger(column) && column > 0) ? { path: match[1]!, line, column } : null;
}
