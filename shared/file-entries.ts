export type FileEntryOperation = 'createFile' | 'createDirectory' | 'rename' | 'delete';
export type FileEntryChange = { hostId: string; directory: string; operation: FileEntryOperation; path: string; previousPath?: string; isDirectory: boolean };
export type FileEntryRequest = { operation: FileEntryOperation; directory: string; name: string; newName?: string; expectedVersion?: string; confirmed?: boolean };
export const fileEntryPath = (directory: string, name: string) => `${directory.replace(/\/+$/, '')}/${name}`;
export const validFileEntryName = (name: string) => !!name && name !== '.' && name !== '..' && name.length <= 255 && new TextEncoder().encode(name).length <= 255 && !/[\/\\\x00-\x1f\x7f-\x9f]/.test(name);
export function changedFilePath(path: string, change: FileEntryChange): string | null {
  if (!change.previousPath || path !== change.previousPath && !(change.isDirectory && path.startsWith(change.previousPath + '/'))) return path;
  return change.operation === 'delete' ? null : change.path + path.slice(change.previousPath.length);
}
