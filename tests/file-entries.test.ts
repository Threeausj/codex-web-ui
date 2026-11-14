import test from 'node:test';
import assert from 'node:assert/strict';
import { changedFilePath, fileEntryPath, validFileEntryName, type FileEntryChange } from '../shared/file-entries';

test('file changes remap exact paths and directory descendants without matching adjacent names', () => {
  const change: FileEntryChange = { hostId: 'host', directory: '/work', operation: 'rename', previousPath: '/work/source', path: '/work/destination', isDirectory: true };
  assert.equal(changedFilePath('/work/source', change), '/work/destination');
  assert.equal(changedFilePath('/work/source/a/b.txt', change), '/work/destination/a/b.txt');
  assert.equal(changedFilePath('/work/source-copy/a.txt', change), '/work/source-copy/a.txt');
  assert.equal(changedFilePath('/work/source/a.txt', { ...change, isDirectory: false }), '/work/source/a.txt');
  assert.equal(changedFilePath('/work/source/a.txt', { ...change, operation: 'delete' }), null);
  assert.equal(fileEntryPath('/', '中文.txt'), '/中文.txt');
  for (const name of ['.', '..', '../x', 'a/b', 'a\\b', 'bad\nname', '文'.repeat(86)]) assert.equal(validFileEntryName(name), false);
  assert.equal(validFileEntryName('中文 `literal` $name.txt'), true);
});

test('move remaps Windows paths without changing copied or uploaded tabs', () => {
  const move: FileEntryChange = { hostId: 'windows', directory: 'C:/目标', operation: 'move', previousPath: 'C:/源', path: 'C:/目标/源', isDirectory: true };
  assert.equal(changedFilePath('c:\\源\\中文.txt', move), 'C:/目标/源/中文.txt');
  assert.equal(changedFilePath('C:/源-copy/file', move), 'C:/源-copy/file');
  assert.equal(changedFilePath('C:/源/a', { ...move, operation: 'copy' }), 'C:/源/a');
  assert.equal(changedFilePath('C:/源/a', { ...move, operation: 'upload' }), 'C:/源/a');
});
