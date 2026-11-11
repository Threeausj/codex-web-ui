/** Paths belong to the selected workstation, not the Linux web server. Keep
 * Windows drive/UNC roots and use forward separators for browser navigation. */
export const isWindowsHostPath = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^.?#\\/][^\\/]*[\\/][^.?#\\/][^\\/]*/.test(value);
export const isAbsoluteHostPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 &&
  !/[\x00-\x1f\x7f-\x9f]/.test(value) && (isWindowsHostPath(value) || value.startsWith('/') && !value.includes('\\'));
export function normalizeHostPath(value: string): string {
  const windows = isWindowsHostPath(value), source = windows ? value.replace(/\\/g, '/') : value;
  const drive = /^[A-Za-z]:\//.exec(source)?.[0];
  const unc = windows && !drive ? /^\/\/([^/]+)\/([^/]+)/.exec(source) : null;
  const prefix = drive || (unc ? `\\\\${unc[1]}/${unc[2]}/` : source.startsWith('/') ? '/' : '');
  const rest = source.slice(drive ? 3 : unc ? unc[0].length : prefix.length);
  const parts: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (parts.length && parts.at(-1) !== '..') parts.pop(); else if (!prefix) parts.push(segment); }
    else parts.push(segment);
  }
  return prefix + parts.join('/') || '.';
}
export function joinHostPath(base: string, ...segments: string[]) {
  return normalizeHostPath([base.replace(/[\\/]+$/, ''), ...segments].join('/'));
}
export function hostDirname(value: string) {
  const normalized = normalizeHostPath(value), unc = /^\\\\[^/]+\/[^/]+\//.exec(normalized);
  const minimum = /^[A-Za-z]:\//.test(normalized) ? 3 : unc ? unc[0].length : 1;
  const index = normalized.lastIndexOf('/');
  return normalized.slice(0, Math.max(minimum, index)) || '/';
}
export function hostBasename(value: string) { return normalizeHostPath(value).replace(/\/$/, '').split('/').pop() || ''; }
export function withinHostPath(root: string, value: string) {
  let base = normalizeHostPath(root).replace(/\/$/, ''), target = normalizeHostPath(value);
  if (isWindowsHostPath(root)) { base = base.toLowerCase(); target = target.toLowerCase(); }
  return target === base || target.startsWith(base + '/');
}
