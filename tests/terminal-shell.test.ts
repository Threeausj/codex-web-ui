import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interactiveShellCommand } from '../shared/terminal-shell';

const execute = promisify(execFile);

test('interactive shell launcher uses the explicitly configured shell without interpolating its path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-terminal-shell-'));
  try {
    const shell = join(directory, 'custom shell;literal', 'bash');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, 'custom shell;literal'));
    await writeFile(shell, '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n', { mode: 0o700 });
    const result = await execute(interactiveShellCommand[0], interactiveShellCommand.slice(1), {
      env: { PATH: '/usr/bin:/bin', SHELL: shell }, timeout: 5000,
    });
    assert.deepEqual(result.stdout.trim().split('\n'), [shell, '-i']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a PTY started from dash falls back to bash and performs real Tab completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-terminal-completion-'));
  const marker = 'codex_web_completion_marker.txt';
  try {
    await writeFile(join(directory, marker), 'fixture');
    const script = `
import json, os, pty, select, subprocess, sys, time
command=json.loads(sys.argv[1]); cwd=sys.argv[2]
master, slave=pty.openpty()
process=subprocess.Popen(command, cwd=cwd, stdin=slave, stdout=slave, stderr=slave,
    env={'PATH':'/usr/bin:/bin','SHELL':'/bin/sh','HOME':cwd,'TERM':'xterm-256color','PS1':'fixture> '})
os.close(slave)
def collect(seconds):
    output=b''; deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        ready,_,_=select.select([master],[],[],min(.05,max(0,deadline-time.monotonic())))
        if ready:
            try: output+=os.read(master,65536)
            except OSError: break
    return output
try:
    collect(.3)
    os.write(master,b"printf 'COMPLETED:%s\\\\n' codex_web_completion_\\t\\r")
    output=collect(.6)
    assert b'COMPLETED:codex_web_completion_marker.txt' in output, repr(output)
    print('PTY Tab completion passed')
finally:
    process.terminate()
    try: process.wait(timeout=2)
    except subprocess.TimeoutExpired: process.kill(); process.wait()
    os.close(master)
`;
    const result = await execute('/usr/bin/python3', ['-c', script, JSON.stringify(interactiveShellCommand), directory], { timeout: 5000 });
    assert.match(result.stdout, /PTY Tab completion passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
