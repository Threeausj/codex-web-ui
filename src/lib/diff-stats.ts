/** Count patch lines only inside hunks; file headers are not edits. */
export function diffStats(diff: string = '') {
  let added = 0, removed = 0, hunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { hunk = true; continue; }
    if (line.startsWith('diff ')) { hunk = false; continue; }
    if (!hunk && /^(--- |\+\+\+ )/.test(line)) continue;
    if (hunk && line.startsWith('+')) added++;
    if (hunk && line.startsWith('-')) removed++;
  }
  return { added, removed };
}
