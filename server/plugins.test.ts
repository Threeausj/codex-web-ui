import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { pluginInventoryReader, registerPlugins } from './plugins.js';

test('installed plugin inventory reads only public metadata and bounded in-package icons', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugins-inventory-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bundle=path.join(root,'documents');await fs.mkdir(path.join(bundle,'.codex-plugin'),{recursive:true});
  await fs.writeFile(path.join(bundle,'icon.png'),Buffer.from([137,80,78,71]));
  await fs.writeFile(path.join(bundle,'.codex-plugin/plugin.json'),JSON.stringify({name:'documents',description:'Fallback',secrets:{key:'must-not-leak'},interface:{displayName:'Documents 文档',shortDescription:'Create documents',composerIcon:'icon.png',brandColor:'#4f76e8'}}));
  const malformed=path.join(root,'malformed');await fs.mkdir(path.join(malformed,'.codex-plugin'),{recursive:true});await fs.writeFile(path.join(malformed,'.codex-plugin/plugin.json'),'[]');
  const rows=[{pluginId:'documents@site',name:'documents',installed:true,enabled:true,source:{path:bundle}},
    {pluginId:'documents@site',name:'duplicate',installed:true,enabled:true},
    {pluginId:'bad@site',name:'malformed',installed:true,enabled:false,source:{path:malformed}},
    {pluginId:'unified-computer-use@site',name:'unified-computer-use',installed:true,enabled:true},
    {pluginId:'available@site',name:'available',installed:false,enabled:true},
    {pluginId:'../bad@site',name:'bad',installed:true,enabled:true}];
  const cli=path.join(root,'codex');await fs.writeFile(cli,'#!/usr/bin/env python3\nimport json\nprint('+JSON.stringify(JSON.stringify({installed:rows,available:[]}))+')\n',{mode:0o700});
  const result=spawnSync('python3',['-'],{input:pluginInventoryReader({id:'local',name:'Local',kind:'local'},{codexBin:cli},root),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const inventory=JSON.parse(result.stdout);
  assert.equal(inventory.supported,true);assert.equal(inventory.plugins.length,2);
  assert.equal(inventory.plugins[0].displayName,'Documents 文档');assert.match(inventory.plugins[0].icon,/^data:image\/png;base64,/);
  assert.equal(inventory.plugins[1].enabled,false);assert.ok(!result.stdout.includes('must-not-leak'));
  // A symlinked icon cannot return a file outside the plugin directory.
  await fs.unlink(path.join(bundle,'icon.png'));await fs.symlink(cli,path.join(bundle,'icon.png'));
  const reread=JSON.parse(spawnSync('python3',['-'],{input:pluginInventoryReader({id:'local',name:'Local',kind:'local'},{codexBin:cli},root),encoding:'utf8'}).stdout);
  assert.equal(reread.plugins[0].icon,undefined);
});

test('plugin requests validate before connecting, coalesce per host/cwd, and invalidate changed hosts', async t => {
  let calls=0,host={id:'mac',name:'Mac',kind:'ssh' as const,hostname:'mac.test'};
  let release!:()=>void;let gate=Promise.resolve();
  const app=express();registerPlugins(app,{getHost:id=>id==='mac'?host:undefined,run:async()=>{calls++;await gate;return JSON.stringify({supported:true,plugins:[{id:'documents@site',name:'documents',displayName:'Documents',description:'',enabled:true}]});}});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const base=`http://127.0.0.1:${(server.address() as any).port}/api/hosts/`;
  for(const query of ['?cwd=relative','?cwd=%2Fa&cwd=%2Fb','?force=true','?extra=1']) assert.equal((await fetch(base+'mac/plugins'+query)).status,400);
  assert.equal((await fetch(base+'unknown/plugins')).status,404);assert.equal(calls,0);
  gate=new Promise<void>(r=>{release=r});const first=fetch(base+'mac/plugins?cwd=%2Fproject');const second=fetch(base+'mac/plugins?cwd=%2Fproject');
  await new Promise(r=>setTimeout(r,50));assert.equal(calls,1);release();assert.equal((await first).status,200);assert.equal((await second).status,200);
  await fetch(base+'mac/plugins?cwd=%2Fproject');assert.equal(calls,1);
  await fetch(base+'mac/plugins?cwd=%2Fother');assert.equal(calls,2);
  host={...host,hostname:'other.test'};await fetch(base+'mac/plugins?cwd=%2Fproject');assert.equal(calls,3);
  await fetch(base+'mac/plugins?cwd=%2Fproject&force=1');assert.equal(calls,4);
});
