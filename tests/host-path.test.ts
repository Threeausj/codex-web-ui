import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsoluteHostPath, normalizeHostPath, joinHostPath, hostDirname, hostBasename, withinHostPath } from '../shared/host-path';
import { previewFilePath, fileLinkLocation } from '../src/lib/file-preview';
import { skillInventory } from '../src/lib/conversation-modes';
import { normalizeConversationSelection } from '../src/lib/conversation-selection';

test('workstation paths retain POSIX, drive and UNC roots and reject relative/device/control paths', () => {
  for (const path of ['/project/中文', 'C:\\Users\\测试\\project', 'd:/project/file', '\\\\server\\share\\file']) assert.ok(isAbsoluteHostPath(path), path);
  for (const path of ['C:relative', 'relative', '\\rooted', '\\\\?\\C:\\secret', '\\\\.\\pipe\\name', '/a\u0085b', '/a\\b', 'C:/a\n']) assert.equal(isAbsoluteHostPath(path), false, path);
  assert.equal(normalizeHostPath('C:\\Users\\测试\\..\\项目'), 'C:/Users/项目');
  assert.equal(joinHostPath('C:/', '项目', '文件.md'), 'C:/项目/文件.md');
  assert.equal(hostDirname('C:/项目'), 'C:/');
  assert.equal(hostDirname('C:/'), 'C:/');
  assert.equal(hostDirname('\\\\server\\share\\file'), '\\\\server/share/');
  assert.equal(hostDirname('\\\\server\\share\\'), '\\\\server/share/');
  assert.equal(hostBasename('C:\\目录\\文件.md'), '文件.md');
  assert.ok(withinHostPath('C:/Project', 'c:/project/file'));
  assert.equal(withinHostPath('C:/Project', 'C:/Projects/file'), false);
  assert.equal(withinHostPath('C:/Project', 'D:/Project/file'), false);
  assert.equal(withinHostPath('/Project', '/project/file'), false);
});

test('Windows Markdown links, skill inventory and selected files keep workstation paths', () => {
  assert.equal(previewFilePath('../图.png', 'C:/项目/docs/说明.md', 'c:/项目'), 'C:/项目/图.png');
  assert.equal(previewFilePath('../../outside.txt', 'C:/项目/说明.md', 'C:/项目'), null);
  assert.equal(previewFilePath('D:/secret', 'C:/项目/说明.md', 'C:/项目'), null);
  assert.deepEqual(fileLinkLocation('C:/项目/file.ts:12:3'), { path: 'C:/项目/file.ts', line: 12, column: 3 });
  assert.equal(normalizeConversationSelection({ hostId: 'windows', threadId: 'thread', path: 'C:\\项目\\file.ts', text: '中文', startLine: 2 })?.path, 'C:\\项目\\file.ts');
  // Skills reported by a Windows runtime are not Linux server-local paths.
  const skill={ name:'documents:documents',path:'C:/Users/test/.codex/plugins/documents/skills/SKILL.md',enabled:true };
  assert.equal(skillInventory({ data:[{cwd:'C:/项目',skills:[skill],errors:[]}] }, 'C:/项目').length, 1);
});
