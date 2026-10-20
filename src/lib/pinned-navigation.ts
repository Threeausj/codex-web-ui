import { matchesProject, threadActivityAt, type Pin } from './navigation';
import { projectOrderKey } from '../../shared/project-order';

type Project = { hostId?: string; path: string; rootPaths?: string[]; nativeProjectId?: string };
type Thread = { hostId?: string; id: string; cwd?: string; projectId?: string | null; threadSource?: string | null; recencyAt?: number | null; createdAt?: number };
export type PinnedNavigationEntry<P, T> =
  { kind: 'project'; key: string; project: P; activityAt: number } |
  { kind: 'thread'; key: string; thread: T; activityAt: number };

/** A pinned project's recency is its newest conversation, never a metadata write. */
export function pinnedNavigation<P extends Project, T extends Thread>(projects: readonly P[], threads: readonly T[], pins: readonly Pin[]): PinnedNavigationEntry<P, T>[] {
  const projectsByKey = new Map(projects.map(project => [projectOrderKey(project), project]));
  const threadsByKey = new Map(threads.map(thread => [JSON.stringify([thread.hostId || 'local', thread.id]), thread]));
  const entries: PinnedNavigationEntry<P, T>[] = [];
  const seen = new Set<string>();
  for (const pin of pins) {
    const key = JSON.stringify([pin.kind, pin.hostId, pin.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (pin.kind === 'project') {
      const project = projectsByKey.get(projectOrderKey({ hostId: pin.hostId, path: pin.id }));
      if (project) entries.push({ kind: 'project', key, project,
        activityAt: threads.reduce((latest, thread) => (thread.hostId || 'local') === pin.hostId && matchesProject(thread, project)
          ? Math.max(latest, threadActivityAt(thread)) : latest, 0) });
    } else {
      const thread = threadsByKey.get(JSON.stringify([pin.hostId, pin.id]));
      if (thread) entries.push({ kind: 'thread', key, thread, activityAt: threadActivityAt(thread) });
    }
  }
  // Stable equal-time order prevents idle pins from jumping on each refresh.
  return entries.sort((a, b) => b.activityAt - a.activityAt);
}
