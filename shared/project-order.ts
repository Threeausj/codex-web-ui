export type ProjectOrderEntry = { hostId: string; path: string };

/** Paths and hosts are independent identities, including paths containing colons. */
export const projectOrderKey = (project: { hostId?: string; path: string }) =>
  JSON.stringify([project.hostId || 'local', project.path]);

/** Keep newly imported projects visible and leave configuration records untouched. */
export function orderProjects<T extends { hostId?: string; path: string }>(projects: readonly T[], order: readonly ProjectOrderEntry[]): T[] {
  const byKey = new Map(projects.map(project => [projectOrderKey(project), project]));
  const seen = new Set<string>(), result: T[] = [];
  for (const entry of order) {
    const key = projectOrderKey(entry), project = byKey.get(key);
    if (project && !seen.has(key)) { result.push(project); seen.add(key); }
  }
  for (const project of projects) {
    const key = projectOrderKey(project);
    if (!seen.has(key)) { result.push(project); seen.add(key); }
  }
  return result;
}
