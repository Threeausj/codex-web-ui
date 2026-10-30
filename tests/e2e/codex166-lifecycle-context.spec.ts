import {test, expect, login, type MockCodex} from './fixtures';
import type {Page} from '@playwright/test';
const id='thread-existing';
async function open(page:Page){await page.locator('[data-section="recent"] .thread-row').filter({hasText:'已有测试历史'}).first().click();await expect(page.getByText('历史保持可读',{exact:true})).toBeVisible();}
async function engineFixture(page:Page,mock:MockCodex){
 let engine='native166-engine-a';const receive=(mock as any).receive.bind(mock);
 (mock as any).receive=(socket:any,request:any)=>{if(request.method==='bridge/ping'){mock.requests.push(request);return socket.send(JSON.stringify({id:request.id,result:{connected:true,paused:false,engineId:engine,loadedThreadIds:[id],pendingRequests:[],activeProcesses:[],stateIncluded:true}}));}return receive(socket,request);};
 await page.routeWebSocket(/\/api\/rpc(?:\?|$)/,socket=>{mock.sockets.push(socket);socket.onMessage(raw=>(mock as any).receive(socket,JSON.parse(raw.toString())));socket.send(JSON.stringify({method:'bridge/status',params:{connected:true,engineId:engine,pendingRequests:[],activeProcesses:[]}}));});
 return{get id(){return engine;},restart(){engine='native166-engine-b';mock.emit('bridge/status',{connected:true,engineId:engine,pendingRequests:[],activeProcesses:[]});}};
}

test('native166 runtime closure removes obsolete approvals and preserves history and draft until explicit rejoin',async({page,mock})=>{
 await login(page);await open(page);const input=page.getByRole('textbox',{name:'消息输入框',exact:true});await input.fill('关闭运行时也保留的草稿');
 for(const socket of mock.sockets)socket.send(JSON.stringify({id:'closed-approval',method:'item/commandExecution/requestApproval',params:{threadId:id,turnId:'turn-history',command:'printf old-review'}}));
 await expect(page.locator('.approval-card')).toHaveCount(1);const resumes=mock.requests.filter(r=>r.method==='thread/resume').length;
 mock.emit('thread/closed',{threadId:id});await expect(page.locator('.approval-card')).toHaveCount(0);await expect(page.getByRole('button',{name:'重新连接会话',exact:true})).toBeVisible();
 await expect(input).toHaveValue('关闭运行时也保留的草稿');await expect(page.getByText('历史保持可读',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();
 expect(mock.requests.filter(r=>r.method==='thread/resume')).toHaveLength(resumes);expect(mock.request('turn/start')).toBeUndefined();
 await page.getByRole('button',{name:'重新连接会话',exact:true}).click();await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeEnabled();await expect(input).toHaveValue('关闭运行时也保留的草稿');
 expect(mock.requests.filter(r=>r.method==='thread/resume')).toHaveLength(resumes+1);expect(mock.request('turn/start')).toBeUndefined();
});

test('late resume metadata cannot re-enable a writer retired by a newer native notLoaded notification',async({page,mock})=>{
 const receive=(mock as any).receive.bind(mock);let release:(()=>void)|undefined;
 (mock as any).receive=(socket:any,request:any)=>{if(request.method==='thread/resume'&&!release){mock.requests.push(request);const thread=structuredClone(mock.threads[0]);release=()=>socket.send(JSON.stringify({id:request.id,result:{thread,model:mock.config.model,sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request'}}));return;}return receive(socket,request);};
 await login(page);await page.locator('[data-section="recent"] .thread-row').first().click();await expect.poll(()=>!!release).toBe(true);
 await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('迟到确认不能发送此草稿');mock.emit('thread/status/changed',{threadId:id,status:{type:'notLoaded'}});release!();
 await expect(page.getByText('历史保持可读',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'重新连接会话',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();expect(mock.request('turn/start')).toBeUndefined();
});

test('context endpoint data from an old engine cannot replace the current native reasoning sample',async({page,mock})=>{
 const engine=await engineFixture(page,mock);let release:(()=>Promise<void>)|undefined;
 await page.route('**/api/hosts/local/threads/thread-existing/context*',async route=>{await new Promise<void>(resolve=>{release=async()=>{await route.fulfill({json:{engineId:'retired-engine',tokenUsage:{last:{totalTokens:990,reasoningOutputTokens:900},modelContextWindow:1000},compacting:false}});resolve();};});});
 await login(page);mock.emit('thread/tokenUsage/updated',{threadId:id,tokenUsage:{last:{totalTokens:120,reasoningOutputTokens:30},total:{totalTokens:9000,reasoningOutputTokens:3000},modelContextWindow:1000}});await open(page);await expect.poll(()=>!!release).toBe(true);await release!();await expect(page.locator('.context-usage')).toHaveText('上下文 12%');expect(engine.id).toContain('engine-a');expect(mock.request('thread/compact/start')).toBeUndefined();
});

test('automatic compaction waits for a fresh last-context sample after engine replacement and ignores cumulative-only usage',async({page,mock})=>{
 await page.addInitScript(()=>localStorage.setItem('codex.autoCompact','true'));const engine=await engineFixture(page,mock);
 await page.route('**/api/hosts/local/threads/thread-existing/context*',route=>route.fulfill({json:{engineId:engine.id,tokenUsage:null,compacting:false}}));
 await login(page);await open(page);mock.emit('thread/tokenUsage/updated',{threadId:id,tokenUsage:{last:{totalTokens:900},modelContextWindow:1000}});await expect(page.locator('.context-usage')).toHaveText('上下文 90%');
 const resumes=mock.requests.filter(r=>r.method==='thread/resume').length;engine.restart();await expect.poll(()=>mock.requests.filter(r=>r.method==='thread/resume').length).toBe(resumes+1);
 const complete=(name:string)=>mock.emit('turn/completed',{threadId:id,turn:{id:name,status:'completed',items:[]}});
 complete('old-snapshot-completion');await page.waitForTimeout(250);expect(mock.request('thread/compact/start')).toBeUndefined();
 mock.emit('thread/tokenUsage/updated',{threadId:id,tokenUsage:{total:{totalTokens:250000,reasoningOutputTokens:100000},modelContextWindow:1000}});complete('billing-only-completion');await page.waitForTimeout(250);expect(mock.request('thread/compact/start')).toBeUndefined();
 mock.emit('thread/tokenUsage/updated',{threadId:id,tokenUsage:{last:{totalTokens:900,reasoningOutputTokens:200},total:{totalTokens:250900,reasoningOutputTokens:100200},modelContextWindow:1000}});complete('fresh-sample-completion');await expect.poll(()=>mock.requests.filter(r=>r.method==='thread/compact/start').length).toBe(1);
});
