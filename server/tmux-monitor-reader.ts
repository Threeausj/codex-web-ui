import { z } from 'zod';
import { runHostPython } from './host-helper.js';
import type { BridgeOptions } from './bridge.js';
import type { Host } from './types.js';
import type { TmuxMonitorPane } from '../shared/tmux-monitors.js';

/** Read-only discovery. Never installs hooks, sends keys, or changes remain-on-exit. */
export const TMUX_MONITOR_HELPER = String.raw`
import json,os,pathlib,re,subprocess
tmux_format='|'.join(['#{pid}','#{session_id}','#{session_created}','#{window_id}','#{window_index}','#{pane_id}','#{pane_index}','#{pane_pid}','#{pane_dead}','#{pane_dead_status}']+['#{s/%/%25/;s/[|]/%7C/;s/#{l:[[:cntrl:]]}/ /:'+key+'}' for key in ['session_name','window_name','pane_current_command','pane_current_path','pane_tty']])
try:
    result=subprocess.run(['tmux','-u','list-panes','-a','-F',tmux_format],env={key:value for key,value in os.environ.items() if key not in ['TMUX','TMUX_PANE']},capture_output=True,text=True,timeout=5)
except FileNotFoundError:
    print(json.dumps({'available':False,'reason':'主机未安装 tmux','panes':[]})); raise SystemExit
if result.returncode:
    if re.search(r'no server running|no sessions|failed to connect to server|error connecting to .*?(?:No such file|Connection refused)',result.stderr,re.I):
        print(json.dumps({'available':True,'panes':[]})); raise SystemExit
    raise RuntimeError('Unable to read tmux server')
if len(result.stdout.encode())>262144: raise RuntimeError('Tmux metadata limit exceeded')
shells={'bash','sh','zsh','fish','dash','ash','ksh','tcsh','csh','login','nu','xonsh'}
panes=[]
def decode(text): return re.sub(r'%25|%7C',lambda match:'%' if match.group()=='%25' else '|',text)
def text_limit(value,limit): return value.encode('utf-16-le','surrogatepass')[:limit*2].decode('utf-16-le','ignore')
for row in result.stdout.splitlines():
    fields=row.split('|')
    if len(fields)!=15: continue
    server,session,created,window,window_index,pane,pane_index,pid,dead,status=fields[:10]
    if not all(value.isdigit() for value in [server,created,window_index,pane_index,pid]) or not re.fullmatch(r'\$\d+',session) or not re.fullmatch(r'@\d+',window) or not re.fullmatch(r'%\d+',pane): continue
    session_name,window_name,command,cwd,tty=[decode(value) for value in fields[10:]]
    session_name=text_limit(session_name,256); window_name=text_limit(window_name,256); command=text_limit(command,256); cwd=text_limit(cwd,4096)
    is_dead=dead=='1'; foreground=None; started=''
    try:
        fd=os.open(tty,os.O_RDONLY|os.O_NONBLOCK|os.O_NOCTTY)
        try: foreground=os.tcgetpgrp(fd)
        finally: os.close(fd)
    except (OSError,ValueError): pass
    active=not is_dead and ((foreground is not None and foreground!=int(pid)) or command.lstrip('-') not in shells)
    identity=foreground if foreground is not None else int(pid)
    try: started=pathlib.Path('/proc',str(identity),'stat').read_text().rsplit(')',1)[1].split()[19]
    except (OSError,ValueError,IndexError): pass
    # A foreground pipeline can change pane_current_command while its process
    # group is still running. Treat the group as one job, even if its leader has
    # already exited; a display-label change must not announce completion.
    job_key=('pgrp:'+str(foreground)) if foreground is not None else 'fallback:'+str(identity)+':'+started+':'+command[:256]
    panes.append({'serverPid':int(server),'sessionId':session,'sessionCreatedAt':int(created),'sessionName':session_name[:256],'windowId':window,'windowIndex':int(window_index),'windowName':window_name[:256],'paneId':pane,'paneIndex':int(pane_index),'command':command[:256],'cwd':cwd[:4096],'active':active,'dead':is_dead,'exitCode':int(status) if is_dead and re.fullmatch(r'-?\d+',status or '') else None,'jobKey':job_key if active else None})
    if len(panes)>512: raise RuntimeError('Too many tmux panes')
print(json.dumps({'available':True,'panes':panes},ensure_ascii=True,separators=(',',':')))
`;

const integer = z.number().int().nonnegative().safe();
const identity = (prefix: string) => z.string().regex(new RegExp(`^\\${prefix}\\d{1,13}$`));
export const tmuxMonitorPaneSchema = z.object({
  serverPid: integer.positive(), sessionId: identity('$'), sessionCreatedAt: integer,
  sessionName: z.string().min(1).max(256), windowId: z.string().regex(/^@\d{1,13}$/), windowIndex: integer,
  windowName: z.string().max(256), paneId: z.string().regex(/^%\d{1,13}$/), paneIndex: integer,
  command: z.string().max(256), cwd: z.string().max(4096), active: z.boolean(), dead: z.boolean(),
  exitCode: z.number().int().nullable(), jobKey: z.string().max(320).nullable(),
}).strict();
export const tmuxMonitorReadingSchema = z.object({
  available: z.boolean(), reason: z.string().max(300).optional(), panes: z.array(tmuxMonitorPaneSchema).max(512),
}).strict();
export type TmuxMonitorReading = { available: boolean; reason?: string; panes: TmuxMonitorPane[] };

export async function collectTmuxMonitorPanes(host: Host, bridgeOptions: BridgeOptions = {}): Promise<TmuxMonitorReading> {
  const result = await runHostPython(host, TMUX_MONITOR_HELPER, bridgeOptions,
    { timeoutMs: 12000, maxOutputBytes: 512 * 1024, background: true });
  return tmuxMonitorReadingSchema.parse(JSON.parse(result));
}
