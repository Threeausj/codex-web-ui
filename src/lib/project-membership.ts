export type ProjectBinding = {
  path: string;
  hostId?: string;
  name?: string;
  rootPaths?: string[];
  nativeProjectId?: string;
};

/** Only inputs used to resolve the native identity belong in this key. */
export function projectBindingKey(project: ProjectBinding): string {
  return JSON.stringify([
    project.hostId || 'local', project.path, project.name?.trim() || '',
    [...new Set([project.path, ...(project.rootPaths || [])])].sort(),
  ]);
}

/** Project API responses contain saved settings, not the native identities
 * learned by this browser. Retain those identities for unchanged projects. */
export function retainProjectBindings<T extends ProjectBinding>(previous: readonly ProjectBinding[], next: readonly T[]): T[] {
  const bindings = new Map(previous.map(project => [projectBindingKey(project), project.nativeProjectId]));
  return next.map(project => {
    const result = { ...project };
    delete result.nativeProjectId;
    const identity = bindings.get(projectBindingKey(project));
    if (identity) result.nativeProjectId = identity;
    return result;
  });
}
