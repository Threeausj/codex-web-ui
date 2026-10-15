import type { ConversationBookmark } from '../../shared/bookmarks';

type BookmarkProject = { hostId?: string; name?: string; path?: string; rootPaths?: string[] };
type BookmarkHost = { id: string; name?: string };

/** Keep identical directory names on different hosts in separate project groups. */
export function bookmarkProjectDetails(entry: ConversationBookmark, projects: BookmarkProject[] = [], hosts: BookmarkHost[] = []) {
  const normalize = (path: string) => path.replace(/\/+$/, '') || '/';
  const project = projects.find(project => (project.hostId || 'local') === entry.hostId &&
    [project.path, ...(project.rootPaths || [])].some(path => typeof path === 'string' && normalize(path) === normalize(entry.projectPath)));
  const projectName = project?.name || entry.projectPath.split('/').filter(Boolean).at(-1) || entry.projectPath;
  const projectPath = normalize(project?.path || entry.projectPath);
  return {
    key: JSON.stringify([entry.hostId, projectPath]),
    projectName,
    projectPath,
    hostName: hosts.find(host => host.id === entry.hostId)?.name || (entry.hostId === 'local' ? '本机' : entry.hostId),
    knownProject: !!project,
  };
}
