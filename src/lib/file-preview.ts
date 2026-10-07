/** Resolve a Markdown file reference without treating it as a browser URL. */
export function previewFilePath(reference: string, filePath: string, root: string): string | null {
  let value: string;
  try { value = decodeURIComponent(reference.split(/[?#]/, 1)[0] || ""); }
  catch { return null; }
  if (!value || /[\x00-\x1f\\]/.test(value) || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const normalize = (path: string) => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  };
  if (!filePath.startsWith("/") || !root.startsWith("/")) return null;
  const base = filePath.slice(0, filePath.lastIndexOf("/") + 1);
  const path = normalize(value.startsWith("/") ? value : base + value);
  const boundary = normalize(root);
  return boundary === "/" || path === boundary || path.startsWith(boundary + "/") ? path : null;
}

export function isMarkdownPath(path: string) { return /\.(?:md|markdown|mdown)$/i.test(path); }
export function isImagePath(path: string) { return /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path); }

/** Absolute Markdown file links may carry a one-based line and column. */
export function fileLinkLocation(reference: string): { path: string; line?: number; column?: number } | null {
  let value: string; try { value = decodeURIComponent(reference); } catch { return null; }
  if (!value.startsWith('/') || value.startsWith('//') || /[\x00-\x1f\x7f]/.test(value)) return null;
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(value);
  if (!match) return { path: value };
  const line = Number(match[2]), column = match[3] ? Number(match[3]) : undefined;
  return Number.isSafeInteger(line) && line > 0 && (column === undefined || Number.isSafeInteger(column) && column > 0) ? { path: match[1]!, line, column } : null;
}
