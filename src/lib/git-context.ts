/** Prefer recent operation directories; never infer a repository from prose. */
export function repositoryCandidates(items: any[], projects: any[], hostId: string, current: string): string[] {
  const paths = [...items].reverse().map(entry => (entry.item || entry).cwd);
  paths.push(...projects.filter(project => (project.hostId || 'local') === hostId).map(project => project.path));
  return [...new Set(paths.filter((value): value is string => typeof value === 'string' && value.startsWith('/') &&
    value !== '/' && value !== current && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)))].slice(0, 8);
}

export function missingRepository(message: string): boolean {
  return /not a git repository|不是 Git 仓库|项目目录不存在|no such file or directory|未找到 Git 或项目目录/i.test(message);
}
