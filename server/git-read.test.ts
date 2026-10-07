import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isReadOnlyGitQuery, readHostGit } from './git-read.js'

const execute = promisify(execFile)
const host = { id: 'local', name: 'Read test', kind: 'local' as const }

test('fixed readonly Git helper rejects writes, arbitrary options and path/shell injection', async () => {
  for (const args of [
    ['add', '--', 'one.txt'], ['commit', '--only', '-m', 'message', '--', 'one.txt'],
    ['worktree', 'add', '/tmp/new'], ['rev-parse', '--show-toplevel', '--git-dir'],
    ['diff', '--no-ext-diff', '--no-textconv', '--', '../outside'],
    ['diff', '--no-ext-diff', '--no-textconv', '--', '.git/config'],
    ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--cached', '--', 'a'],
    ['/bin/sh', '-c', 'true'], ['check-ref-format', '--branch', 'main;echo wrong'],
  ]) {
    assert.equal(isReadOnlyGitQuery(args), false, JSON.stringify(args))
    await assert.rejects(readHostGit(host, '/tmp', args), /不支持/)
  }
  await assert.rejects(readHostGit(host, 'relative', ['rev-parse', '--show-toplevel']), /不支持/)
})

test('readonly Git ignores executable repository configuration and inherited Git environment', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-git-read-'))
  const marker = path.join(directory, 'unwanted execution')
  const envDir = process.env.GIT_DIR
  const optionalLocks = process.env.GIT_OPTIONAL_LOCKS
  try {
    const run = (...args: string[]) => execute('git', args, { cwd: directory })
    await run('init', '--initial-branch=main')
    await run('config', 'user.name', 'Readonly test')
    await run('config', 'user.email', 'readonly@example.invalid')
    await fs.writeFile(path.join(directory, 'one.txt'), 'before\n')
    await run('add', '--', 'one.txt')
    await run('commit', '-m', 'Fixture')
    const script = path.join(directory, 'hook.sh')
    await fs.writeFile(script, `#!/bin/sh\ntouch '${marker.replace(/'/g, "'\\''")}'\n`, { mode: 0o700 })
    await run('config', 'core.fsmonitor', script)
    await run('config', 'diff.external', script)
    await run('config', 'diff.unsafe.textconv', script)
    await run('config', 'core.pager', script)
    await run('config', 'filter.unsafe.clean', script)
    await run('config', 'filter.unsafe.smudge', script)
    await run('config', 'filter.unsafe.process', script)
    await run('config', 'filter.unsafe.required', 'true')
    await fs.writeFile(path.join(directory, '.gitattributes'), '*.txt diff=unsafe filter=unsafe\n')
    await fs.writeFile(path.join(directory, 'one.txt'), 'after\n')
    process.env.GIT_DIR = '/missing/inherited-git-dir'
    process.env.GIT_OPTIONAL_LOCKS = '1'
    const status = await readHostGit(host, directory, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    assert.equal(status.exitCode, 0)
    assert.match(status.stdout, /one.txt/)
    const diff = await readHostGit(host, directory, ['diff', '--no-ext-diff', '--no-textconv', '--', 'one.txt'])
    assert.equal(diff.exitCode, 0)
    assert.match(diff.stdout, /\+after/)
    await assert.rejects(fs.access(marker), { code: 'ENOENT' })
    const oversized = path.join(directory, 'large.txt')
    await fs.writeFile(oversized, 'added line\n'.repeat(240000))
    await assert.rejects(readHostGit(host, directory, ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', 'large.txt']), /超过 2 MB/)
  } finally {
    if (envDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = envDir
    if (optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = optionalLocks
    await fs.rm(directory, { recursive: true, force: true })
  }
})
