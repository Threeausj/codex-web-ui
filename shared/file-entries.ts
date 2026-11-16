import { joinHostPath, normalizeHostPath, isWindowsHostPath } from './host-path.js';
export type FileEntryOperation = 'createFile' | 'createDirectory' | 'rename' | 'delete' | 'copy' | 'move' | 'upload';
export type FileEntryChange = { hostId: string; directory: string; operation: FileEntryOperation; path: string; previousPath?: string; isDirectory: boolean };
export type FileEntryRequest = { operation: FileEntryOperation; directory: string; name: string; newName?: string; sourceDirectory?: string; expectedVersion?: string; confirmed?: boolean };
export type FileClipboard = { hostId: string; hostIdentity: string; directory: string; name: string; isDirectory: boolean; version: string; mode: 'copy' | 'move' };
export const fileEntryPath = joinHostPath;
export const validFileEntryName = (name: string) => !!name && name !== '.' && name !== '..' && name.length <= 255 && new TextEncoder().encode(name).length <= 255 && !/[\/\\\x00-\x1f\x7f-\x9f]/.test(name);
export function changedFilePath(path: string, change: FileEntryChange): string | null {
  if (!change.previousPath || !['rename', 'move', 'delete'].includes(change.operation)) return path;
  const source = normalizeHostPath(change.previousPath), normalized = normalizeHostPath(path);
  const compare = (value: string) => isWindowsHostPath(source) ? value.toLowerCase() : value;
  if (compare(normalized) !== compare(source) && !(change.isDirectory && compare(normalized).startsWith(compare(source) + '/'))) return path;
  return change.operation === 'delete' ? null : change.path + normalized.slice(source.length);
}
