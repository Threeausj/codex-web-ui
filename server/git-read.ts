import type { BridgeOptions } from './bridge.js'
import type { Host } from './types.js'
import type { CommandExecResponse } from '../shared/protocol/v2/CommandExecResponse.js'
import { runHostPython } from './host-helper.js'

const MAX_OUTPUT = 2 * 1024 * 1024
const same = (value: string[], expected: string[]) => value.length === expected.length && value.every((part, index) => part === expected[index])
const relativeFile = (value: string) => !!value && value.length <= 4096 && !value.startsWith('/') && !value.startsWith('-') && !/[\x00-\x1f\x7f\\]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')

/** This backend file reader accepts Git's fixed query commands, never arbitrary commands or writes. */
export function isReadOnlyGitQuery(args: string[]): boolean {
  if ([
    ['rev-parse', '--show-toplevel'], ['rev-parse', '--git-common-dir'],
    ['rev-parse', '--absolute-git-dir'], ['rev-parse', '--verify', 'HEAD'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    ['worktree', 'list', '--porcelain', '-z'],
  ].some(expected => same(args, expected))) return true
  if (args.length === 3 && args[0] === 'check-ref-format' && args[1] === '--branch')
    return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(args[2]!)
  if (!same(args.slice(0, 3), ['diff', '--no-ext-diff', '--no-textconv'])) return false
  const tail = args.slice(3)
  if (tail[0] === '--no-index') return tail.length === 4 && tail[1] === '--' && tail[2] === '/dev/null' && relativeFile(tail[3]!)
  if (tail[0] === '--cached') tail.shift()
  return tail[0] === '--' && tail.length >= 2 && tail.length <= 3 && tail.slice(1).every(relativeFile)
}

export async function readHostGit(host: Host, cwd: string, args: string[], options: BridgeOptions = {}): Promise<CommandExecResponse> {
  if (!cwd.startsWith('/') || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd) || !isReadOnlyGitQuery(args))
    throw Object.assign(new Error('不支持的 Git 只读查询'), { status: 400 })
  const payload = Buffer.from(JSON.stringify({ cwd, args })).toString('base64')
  // The source travels on stdin, never through the login shell. Git receives
  // literal argv and cannot run fsmonitor, hooks, diff drivers or textconv.
  const source = String.raw`
import base64,json,os,subprocess,threading
p=json.loads(base64.b64decode('${payload}'))
env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
env.update(GIT_OPTIONAL_LOCKS='0',GIT_LITERAL_PATHSPECS='1',GIT_TERMINAL_PROMPT='0',LC_ALL='C.UTF-8')
command=['git','--no-pager','-c','core.quotePath=false','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false','-c','diff.external=','-c','diff.ignoreSubmodules=all','-c','status.submoduleSummary=false']
def execute(args,cap=${MAX_OUTPUT}):
    try: process=subprocess.Popen(args,cwd=p['cwd'],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    except FileNotFoundError: return {'exitCode':127,'stdout':'','stderr':'未找到 Git 或项目目录'}
    streams={'stdout':bytearray(),'stderr':bytearray()}; exceeded=[]
    def capture(name,stream):
        while True:
            data=stream.read(65536)
            if not data: break
            remaining=cap-len(streams[name]); streams[name].extend(data[:remaining])
            if len(data)>remaining:
                exceeded.append(name); process.kill(); break
    threads=[threading.Thread(target=capture,args=(name,getattr(process,name)),daemon=True) for name in streams]
    for thread in threads: thread.start()
    try: process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait(); exceeded.append('timeout')
    for thread in threads: thread.join(timeout=2)
    if 'timeout' in exceeded: return {'exitCode':124,'stdout':'','stderr':'Git 读取超时，请重试'}
    if exceeded: return {'exitCode':-1,'stdout':'','stderr':'Git 输出超过限制，请缩小变更范围后重试','outputLimitExceeded':True}
    return {'exitCode':process.returncode,**{name:bytes(data).decode('utf-8','replace') for name,data in streams.items()}}
# Status and diff can invoke clean filters even with textconv disabled. Query
# their names using Git's data-only config reader, then override every driver.
filters=execute(command+['config','--null','--name-only','--get-regexp',r'^filter\..*\.(clean|smudge|process|required)$'],131072)
if filters['exitCode'] not in (0,1):
    print(json.dumps(filters,ensure_ascii=False)); raise SystemExit
for key in filters['stdout'].split('\0'):
    if key: command+=['-c',key+('=false' if key.endswith('.required') else '=')]
result=execute(command+p['args'])
if result.get('outputLimitExceeded'): result['stderr']='Git 输出超过 2 MB，请缩小变更范围后重试'
print(json.dumps(result,ensure_ascii=False))
`
  const output = JSON.parse(await runHostPython(host, source, options, { timeoutMs: 35000, maxOutputBytes: 14 * 1024 * 1024 })) as CommandExecResponse & { outputLimitExceeded?: boolean }
  if (output.outputLimitExceeded) throw Object.assign(new Error(output.stderr), { status: 413 })
  if (!Number.isInteger(output.exitCode) || typeof output.stdout !== 'string' || typeof output.stderr !== 'string') throw new Error('Git 只读查询返回格式错误')
  return output
}
