import type { Bridge, BridgeOptions } from './bridge.js';
import type { Host } from './types.js';
import { runHostPython } from './host-helper.js';
import { isAbsoluteHostPath } from '../shared/host-path.js';

/** Probe native flock ownership rather than trusting Web's active-turn list.
 * A writer outside the container PID namespace is still detectable this way.
 * The helper never removes lock files, signals a writer or starts a model. */
export function worktreeWriterReader(codexHome?: string) {
  return `import json,os,re,stat,sys
home=${JSON.stringify(codexHome || '')} or os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex')
if not os.path.isabs(home): raise RuntimeError('Cannot verify native writer locks')
if os.name=='nt':
    import msvcrt,errno
    root=os.path.join(os.path.realpath(home),'thread-writer-locks');threads=[]
    try: metadata=os.lstat(root)
    except FileNotFoundError: print(json.dumps({'threads':[]}));raise SystemExit
    if not stat.S_ISDIR(metadata.st_mode) or getattr(metadata,'st_file_attributes',0)&0x400: raise RuntimeError('Invalid lock directory')
    names=os.listdir(root)
    if len(names)>10000: raise RuntimeError('Too many locks')
    for name in names:
        if not re.fullmatch(r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\\.lock',name): continue
        file=os.path.join(root,name)
        try:
            metadata=os.lstat(file)
            if not stat.S_ISREG(metadata.st_mode) or getattr(metadata,'st_file_attributes',0)&0x400: raise RuntimeError('Invalid lock')
            descriptor=os.open(file,os.O_RDWR|os.O_BINARY)
        except FileNotFoundError: continue
        try:
            try: msvcrt.locking(descriptor,msvcrt.LK_NBLCK,1)
            except OSError as error:
                if error.errno not in (errno.EACCES,errno.EAGAIN,errno.EDEADLK): raise
                threads.append(name[:-5])
            else: msvcrt.locking(descriptor,msvcrt.LK_UNLCK,1)
        finally: os.close(descriptor)
        if len(threads)>100: raise RuntimeError('Too many native writers')
    print(json.dumps({'threads':threads}));raise SystemExit
if sys.platform not in ('linux','darwin'): raise RuntimeError('Cannot verify native writer locks')
import fcntl
try: directory=os.open(os.path.join(os.path.realpath(home),'thread-writer-locks'),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
except FileNotFoundError: print(json.dumps({'threads':[]})); raise SystemExit
threads=[]
try:
    names=os.listdir(directory)
    if len(names)>10000: raise RuntimeError('Too many locks')
    for name in names:
        if not re.fullmatch(r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\\.lock',name): continue
        try: descriptor=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
        except FileNotFoundError: continue
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode): raise RuntimeError('Invalid lock')
            try: fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: threads.append(name[:-5])
            else: fcntl.flock(descriptor,fcntl.LOCK_UN)
        finally: os.close(descriptor)
        if len(threads)>100: raise RuntimeError('Too many native writers')
finally: os.close(directory)
print(json.dumps({'threads':threads}))
`;
}
export async function nativeWorktreeWriters(host: Host, bridge: Pick<Bridge, 'request' | 'codexHome' | 'connect'>, directory: string, options: BridgeOptions = {}) {
  await bridge.connect();
  const configuredHome = bridge.codexHome || (host.kind === 'local' ? options.codexHome : undefined);
  const result = JSON.parse(await runHostPython(host, worktreeWriterReader(configuredHome), options));
  if (!Array.isArray(result.threads) || result.threads.length > 100 || result.threads.some((id: unknown) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new Error('无法确认原生会话锁');
  const candidates: { id: string; cwd: string }[] = [];
  for (const id of result.threads as string[]) {
    const metadata = await bridge.request('thread/read', { threadId: id, includeTurns: false }, 10000) as any;
    if (!isAbsoluteHostPath(metadata?.thread?.cwd)) throw new Error('无法确认原生写入者的工作目录');
    candidates.push({ id, cwd: metadata.thread.cwd });
  }
  if (!candidates.length) return [];
  // Desktop/CLI may have opened the same tree through a symlink or a path
  // containing '..'. Resolve on the source host before comparing directories.
  const paths = JSON.stringify({ directory, candidates });
  const matched = JSON.parse(await runHostPython(host, `import json,os\ndata=json.loads(${JSON.stringify(paths)})\nroot=os.path.normcase(os.path.realpath(data['directory']))\ndef inside(value):\n    try: return os.path.commonpath([root,os.path.normcase(os.path.realpath(value))])==root\n    except ValueError: return False\nprint(json.dumps([row['id'] for row in data['candidates'] if inside(row['cwd'])]))\n`, options));
  if (!Array.isArray(matched) || matched.some(id => !candidates.some(row => row.id === id))) throw new Error('无法核对原生工作目录');
  return matched as string[];
}
