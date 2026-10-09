/** Error wording is only a hint. The candidate still needs a fresh native read. */
export function interruptConflictCandidate(error: unknown, requestedId: string): string | null {
  const failure = error as { uncertain?: boolean; message?: unknown } | null;
  if (failure?.uncertain || typeof failure?.message !== 'string') return null;
  const match = /^expected active turn id (\S+) but found (\S+)$/i.exec(failure.message);
  if (!match || match[1] === match[2]) return null;
  return match[1] === requestedId ? match[2] : match[2] === requestedId ? match[1] : null;
}
