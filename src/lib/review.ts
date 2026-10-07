import type { ReviewTarget } from '../../shared/protocol/v2/ReviewTarget';
export type ReviewScope = 'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom';
export function reviewTarget(scope: ReviewScope, value = '', title?: string): ReviewTarget {
  const trimmed = value.trim();
  if (scope === 'uncommittedChanges') return { type: scope };
  if (scope === 'baseBranch') {
    if (!trimmed || trimmed.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(trimmed) || trimmed.includes('..') || trimmed.includes('//') || trimmed.endsWith('/') || trimmed.endsWith('.') || trimmed.endsWith('.lock') || trimmed.split('/').some(part => part.startsWith('.'))) throw new Error('请选择有效的基准分支');
    return { type: scope, branch: trimmed };
  }
  if (scope === 'commit') {
    if (!/^[a-fA-F0-9]{7,64}$/.test(trimmed)) throw new Error('请输入 7–64 位的 commit SHA');
    return { type: scope, sha: trimmed, title: title?.slice(0, 500) || null };
  }
  if (!trimmed || trimmed.length > 8000) throw new Error('请填写 1–8000 个字符的审阅要求');
  return { type: 'custom', instructions: trimmed };
}
export type ReviewFinding = { title: string; body: string; priority?: number; file: string; start?: number; end?: number };
/** Native review output is a string. Only structured public findings are decoded. */
export function reviewFindings(review: unknown): ReviewFinding[] {
  if (typeof review !== 'string' || review.length > 2 * 1024 * 1024) return [];
  try {
    const output = JSON.parse(review.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!Array.isArray(output?.findings)) return [];
    return output.findings.slice(0, 100).flatMap((entry: any) => {
      const location = entry?.code_location;
      if (!entry || typeof entry.title !== 'string' || typeof entry.body !== 'string' || typeof location?.absolute_file_path !== 'string' || !location.absolute_file_path.startsWith('/') || /[\x00-\x1f\x7f]/.test(location.absolute_file_path)) return [];
      const range = location.line_range;
      const start = Number.isSafeInteger(range?.start) && range.start > 0 ? range.start : undefined;
      const end = Number.isSafeInteger(range?.end) && range.end >= (start || 1) ? range.end : undefined;
      return [{ title: entry.title.slice(0, 1000), body: entry.body.slice(0, 12000), file: location.absolute_file_path, ...(start ? { start } : {}), ...(end ? { end } : {}), ...(Number.isInteger(entry.priority) && entry.priority >= 0 && entry.priority <= 3 ? { priority: entry.priority } : {}) }];
    });
  } catch { return []; }
}
