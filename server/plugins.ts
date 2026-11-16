import type { Express } from 'express';
import { z } from 'zod';
import { runHostPython } from './host-helper.js';
import type { BridgeOptions } from './bridge.js';
import type { Host } from './types.js';
import { validPluginId, type InstalledPlugin, type PluginInventory } from '../shared/plugin-mentions.js';
import { isAbsoluteHostPath } from '../shared/host-path.js';

/** The installed CLI inventory is documented; plugin/list RPC is still marked
 * unsuitable for production clients. Read only manifests of installed entries. */
export function pluginInventoryReader(host: Host, options: BridgeOptions = {}, cwd?: string) {
  const config = Buffer.from(JSON.stringify({ executable: host.kind === 'ssh' ? host.codexPath || 'codex' : options.codexBin || 'codex', remote: host.kind === 'ssh', cwd })).toString('base64');
  return `import os,json,base64,pathlib,subprocess,shlex,re
p=json.loads(base64.b64decode('${config}'))
def text(value,limit): return value[:limit] if isinstance(value,str) else ''
try:
 args=[p['executable'],'plugin','list','--json']
 if p['remote'] and os.name!='nt':
  command=('cd -- '+shlex.quote(p['cwd'])+' && ' if p.get('cwd') else '')+'exec '+ ' '.join(shlex.quote(a) for a in args)
  args=[os.environ.get('SHELL') or '/bin/sh','-ilc',command]
 process=subprocess.run(args,cwd=p.get('cwd') or None,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=20)
 if process.returncode or len(process.stdout)>1048576: raise ValueError('Plugin inventory unavailable')
 value=json.loads(process.stdout); rows=value.get('installed'); plugins=[]; seen=set(); budget=524288
 if not isinstance(rows,list): raise ValueError('Unknown inventory')
 for row in rows[:256]:
  if not isinstance(row,dict) or row.get('installed') is not True: continue
  identity=row.get('pluginId'); name=row.get('name')
  if not isinstance(identity,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9._-]{0,127}',identity) or identity in seen or not isinstance(name,str): continue
  seen.add(identity); manifest={}; icon=None; root=None
  source=row.get('source'); source=source if isinstance(source,dict) else {}; location=row.get('installedPath') or source.get('path')
  if isinstance(location,str) and os.path.isabs(location):
   try:
    root=pathlib.Path(location).resolve(); file=(root/'.codex-plugin'/'plugin.json').resolve()
    if root not in file.parents: raise ValueError('Manifest is outside its plugin')
    if file.stat().st_size<=65536: manifest=json.loads(file.read_text(encoding='utf-8-sig'))
   except (OSError,ValueError,TypeError): pass
  manifest=manifest if isinstance(manifest,dict) else {}
  interface=manifest.get('interface'); interface=interface if isinstance(interface,dict) else {}
  # Internal runtime packages without an interface are not composer choices.
  if not interface and name in ('unified-computer-use','codex-app-tools'): continue
  if root is not None and isinstance(interface.get('composerIcon'),str) and budget>0:
   try:
    asset=(root/interface['composerIcon']).resolve()
    if root in asset.parents and asset.suffix.lower() in ('.png','.jpg','.jpeg','.webp') and asset.stat().st_size<=32768:
     data=asset.read_bytes(); budget-=len(data)
     if budget>=0: icon='data:image/'+('jpeg' if asset.suffix.lower() in ('.jpg','.jpeg') else asset.suffix[1:].lower())+';base64,'+base64.b64encode(data).decode()
   except (OSError,ValueError,TypeError): pass
  entry={'id':identity,'name':text(name,160),'displayName':text(interface.get('displayName') or name,160),'description':text(interface.get('shortDescription') or manifest.get('description'),1000),'enabled':row.get('enabled') is True}
  if icon: entry['icon']=icon
  color=interface.get('brandColor')
  if isinstance(color,str) and re.fullmatch(r'#[0-9a-fA-F]{6}',color): entry['brandColor']=color
  plugins.append(entry)
 print(json.dumps({'supported':True,'plugins':plugins},separators=(',',':')))
except (OSError,ValueError,TypeError,subprocess.SubprocessError):
 print(json.dumps({'supported':False,'plugins':[],'reason':'当前主机的 Codex 未提供可读取的已安装插件清单；可先使用插件技能。'},separators=(',',':')))
`;
}
export function registerPlugins(app: Express, dependencies: { getHost(id: string): Host | undefined; bridgeOptions?: BridgeOptions; run?: (host: Host, source: string) => Promise<string> }) {
  const query = z.object({ cwd: z.string().min(1).max(4096).refine(isAbsoluteHostPath).optional(), force: z.literal('1').optional(), _request: z.string().uuid().optional() }).strict();
  const cache = new Map<string, { host: Host; expires: number; promise: Promise<PluginInventory> }>();
  app.get('/api/hosts/:id/plugins', (req, res, next) => {
    void (async () => {
      const input = query.safeParse(req.query);
      if (!input.success) { res.status(400).json({ error: '插件目录参数无效。' }); return; }
      const host = dependencies.getHost(String(req.params.id));
      if (!host) { res.status(404).json({ error: '主机不存在或已停用。' }); return; }
      const key = JSON.stringify([host.id, input.data.cwd]);
      let entry = cache.get(key);
      if (!entry || entry.host !== host || input.data.force || entry.expires < Date.now()) {
        const promise = (async () => {
          const raw = await (dependencies.run ? dependencies.run(host, pluginInventoryReader(host, dependencies.bridgeOptions, input.data.cwd)) : runHostPython(host, pluginInventoryReader(host, dependencies.bridgeOptions, input.data.cwd), dependencies.bridgeOptions, { timeoutMs: 30000, maxOutputBytes: 1048576, background: true }));
          const result = JSON.parse(raw) as PluginInventory;
          if (typeof result.supported !== 'boolean' || !Array.isArray(result.plugins)) throw new Error('主机返回的插件列表无效。');
          result.plugins = result.plugins.filter((plugin: InstalledPlugin) => plugin && validPluginId(plugin.id) && typeof plugin.name === 'string' && typeof plugin.displayName === 'string' && typeof plugin.description === 'string' && typeof plugin.enabled === 'boolean');
          return result;
        })();
        entry = { host, expires: Date.now() + 30000, promise }; cache.set(key, entry);
        while (cache.size > 128) cache.delete(cache.keys().next().value!);
        promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
      }
      res.json(await entry.promise);
    })().catch(next);
  });
}
