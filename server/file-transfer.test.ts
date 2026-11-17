import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileTransferScript } from './file-transfer.js';
import { fileEntryScript } from './file-entries.js';

// Reproduce NFS rejecting only the native no-replace rename. File contents,
// directory descriptors, link publication and cleanup still use real syscalls.
function noReplaceUnsupported(errno: string, race = false) {
  return `import ctypes,errno,types,os\ndef unsupported(source_fd,source,target_fd,target,flags):\n ${race ? "fd=os.open(os.fsdecode(target),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=target_fd);os.write(fd,b'concurrent file');os.close(fd)" : 'pass'}\n ctypes.set_errno(errno.${errno});return -1\nlib=types.SimpleNamespace(renameat2=unsupported,renameatx_np=unsupported)\nctypes.CDLL=lambda *args,**kwargs:lib\n`;
}
async function python(source: string, bytes = Buffer.alloc(0)) {
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile('python3', ['-c', source], { timeout: 10000, maxBuffer: 32768 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.on('error', () => {});child.stdin!.end(bytes);
  });
  return JSON.parse(output);
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nfs-publication-test-'));
  const bytes = Buffer.from('# 候选音乐与听后反应\n中文正文\n\x00\xff');
  const input = { operation: 'upload', directory: root, name: '候选音乐与听后反应.md', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { root, bytes, input, close: () => fs.rm(root, { recursive: true, force: true }) };
}
for (const code of ['EINVAL', 'ENOSYS', 'EOPNOTSUPP']) test(`NFS-style ${code} falls back to an atomic link for a fully verified upload`, async () => {
  const f = await fixture();
  try {
    const result = await python(noReplaceUnsupported(code) + fileTransferScript(f.input), f.bytes);
    assert.equal(result.ok, true);assert.deepEqual(await fs.readFile(path.join(f.root, f.input.name)), f.bytes);
    assert.equal((await fs.stat(path.join(f.root, f.input.name))).nlink, 1);
    assert.deepEqual(await fs.readdir(f.root), [f.input.name]);
  } finally { await f.close(); }
});
test('a concurrent file appearing during NFS publication wins without being overwritten', async () => {
  const f = await fixture();
  try {
    const result = await python(noReplaceUnsupported('EINVAL', true) + fileTransferScript(f.input), f.bytes);
    assert.equal(result.code, 'EXISTS');assert.equal(await fs.readFile(path.join(f.root, f.input.name), 'utf8'), 'concurrent file');
    assert.deepEqual(await fs.readdir(f.root), [f.input.name]);
  } finally { await f.close(); }
});
test('incomplete and corrupt NFS uploads never publish a destination or leave temporary entries', async () => {
  const f = await fixture();
  try {
    for (const input of [{ ...f.input, size: f.input.size + 1 }, { ...f.input, sha256: '0'.repeat(64) }]) {
      const result = await python(noReplaceUnsupported('EINVAL') + fileTransferScript(input), f.bytes);
      assert.equal(result.code, 'INCOMPLETE_UPLOAD');assert.deepEqual(await fs.readdir(f.root), []);
    }
    const result = await python(noReplaceUnsupported('EINVAL') + fileTransferScript({ ...f.input, size: 0, sha256: createHash('sha256').update('').digest('hex') }));
    assert.equal(result.ok, true);assert.equal((await fs.stat(path.join(f.root, f.input.name))).size, 0);
  } finally { await f.close(); }
});
test('when neither safe rename nor hard links are supported the upload fails without a partial target', async () => {
  const f = await fixture();
  try {
    const rejectLinks = "def no_links(*args,**kwargs): raise OSError(errno.EOPNOTSUPP,'unsupported')\nos.link=no_links\n";
    const result = await python(noReplaceUnsupported('EINVAL') + rejectLinks + fileTransferScript(f.input), f.bytes);
    assert.equal(result.code, 'UNSUPPORTED_RENAME');assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.close(); }
});
test('NFS file copies publish complete bytes but moves and directory copies preserve sources when native rename is unavailable', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'source'), f.bytes);await fs.mkdir(path.join(f.root, 'folder'));await fs.writeFile(path.join(f.root, 'folder/child'), f.bytes);
    const metadata = await python(fileEntryScript({ operation: 'inspect', directory: f.root, name: 'source' }));
    const transfer = { operation: 'copy', directory: f.root, sourceDirectory: f.root, name: 'source', newName: 'copy', expectedVersion: metadata.version };
    assert.equal((await python(noReplaceUnsupported('EINVAL') + fileTransferScript(transfer))).ok, true);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'copy')), f.bytes);assert.deepEqual(await fs.readFile(path.join(f.root, 'source')), f.bytes);
    assert.equal((await python(noReplaceUnsupported('EINVAL') + fileTransferScript({ ...transfer, operation: 'move', newName: 'moved' }))).code, 'UNSUPPORTED_RENAME');
    const folder = await python(fileEntryScript({ operation: 'inspect', directory: f.root, name: 'folder' }));
    assert.equal((await python(noReplaceUnsupported('EINVAL') + fileTransferScript({ ...transfer, name: 'folder', newName: 'copied-folder', expectedVersion: folder.version }))).code, 'UNSUPPORTED_RENAME');
    assert.deepEqual((await fs.readdir(f.root)).sort(), ['copy', 'folder', 'source']);assert.deepEqual(await fs.readFile(path.join(f.root, 'folder/child')), f.bytes);
  } finally { await f.close(); }
});
for (const [errno, code] of [['ENOSPC', 'NO_SPACE'], ['EDQUOT', 'NO_SPACE'], ['EROFS', 'READ_ONLY'], ['ENAMETOOLONG', 'NAME_TOO_LONG']] as const) test(`upload reports ${code} for ${errno} without publishing bytes`, async () => {
  const f = await fixture();
  try {
    const failingWrite = `import os,errno\ndef fail_sync(*args): raise OSError(errno.${errno},'fixture failure')\nos.fsync=fail_sync\n`;
    const result = await python(failingWrite + fileTransferScript(f.input), f.bytes);
    assert.equal(result.code, code);assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.close(); }
});
