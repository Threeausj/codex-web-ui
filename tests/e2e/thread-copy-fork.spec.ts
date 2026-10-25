import {test,expect,login,MockCodex} from './fixtures';
import type {Page} from '@playwright/test';
const row=(page:Page,hostId='local')=>page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"]`).first();
async function setupClipboard(page:Page) {
 await page.addInitScript(()=>{(window as any).copiedTexts=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{(window as any).copiedTexts.push(text);}}});});
}
async function copy(page:Page,hostId:string,name:string) {
 const target=row(page,hostId);await target.locator('.nav-row-menu').click();
 await target.getByRole('button',{name:'复制',exact:true}).click();
 await target.getByRole('button',{name,exact:true}).click();
}
const clipboard=(page:Page)=>page.evaluate(()=> (window as any).copiedTexts as string[]);
function remoteFixture(mock:MockCodex) {
 const remote=new MockCodex();remote.threads[0]={...remote.threads[0],name:'远程复制会话',cwd:'/remote/project'};
 mock.hosts.push({id:'ssh-copy',kind:'ssh',name:'远程主机',hostname:'fixture.invalid'});
 mock.hostMocks.set('ssh-copy',remote);return remote;
}

test('copy links and workspace paths from an unopened remote row preserves the selected conversation and draft',async({page,mock})=>{
 const remote=remoteFixture(mock);await setupClipboard(page);await login(page);await row(page).locator('.thread-row').click();
 await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('保留草稿');
 await copy(page,'ssh-copy','复制深度链接');await expect.poll(()=>clipboard(page)).toHaveLength(1);
 const link=new URL((await clipboard(page))[0]!);expect(link.searchParams.get('host')).toBe('ssh-copy');expect(link.searchParams.get('thread')).toBe('thread-existing');
 expect(remote.request('thread/read')).toBeUndefined();
 await copy(page,'ssh-copy','复制工作目录');await expect.poll(()=>clipboard(page)).toContain('/remote/project');
 expect(remote.request('thread/read')?.params).toEqual({threadId:'thread-existing',includeTurns:false});
 expect(remote.request('thread/resume')).toBeUndefined();
 await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'local');await expect(page.getByRole('textbox',{name:'消息输入框',exact:true})).toHaveValue('保留草稿');
});

test('Markdown copy reads complete paginated history from the intended host without switching or resuming it',async({page,mock})=>{
 const remote=remoteFixture(mock);const receive=(remote as any).receive.bind(remote);
 (remote as any).receive=(socket:any,request:any)=>{
  if(request.method==='thread/turns/list'&&request.params.itemsView==='full') {
   remote.requests.push(request);const older=!!request.params.cursor;
   socket.send(JSON.stringify({id:request.id,result:{data:[{id:older?'older':'latest',items:[{type:'agentMessage',text:older?'Earlier remote answer':'Latest remote answer'}]}],nextCursor:older?null:'older-page'}}));return;
  } return receive(socket,request);
 };
 await setupClipboard(page);await login(page);await copy(page,'ssh-copy','复制为 Markdown');
 await expect.poll(()=>clipboard(page)).toHaveLength(1);const text=(await clipboard(page))[0]!;
 expect(text).toContain('# 远程复制会话');expect(text).toContain('/remote/project');
 expect(text.indexOf('Earlier remote answer')).toBeGreaterThan(0);expect(text.indexOf('Latest remote answer')).toBeGreaterThan(text.indexOf('Earlier remote answer'));
 expect(remote.requests.filter(request=>request.method==='thread/turns/list'&&request.params.itemsView==='full').map(request=>request.params.cursor)).toEqual([null,'older-page']);
 expect(remote.request('thread/resume')).toBeUndefined();await expect(page.locator('.welcome')).toBeVisible();
});

test('Markdown copy refuses explicitly incomplete history instead of copying a summary',async({page,mock})=>{
 const remote=remoteFixture(mock);const receive=(remote as any).receive.bind(remote);
 (remote as any).receive=(socket:any,request:any)=>{
  if(request.method==='thread/turns/list'&&request.params.itemsView==='full') {
   socket.send(JSON.stringify({id:request.id,result:{data:[{id:'summary',itemsView:'summary',items:[{type:'agentMessage',text:'Only a summary'}]}],nextCursor:null}}));return;
  }return receive(socket,request);
 };
 await setupClipboard(page);await login(page);await copy(page,'ssh-copy','复制为 Markdown');
 await expect(page.locator('.global-error')).toContainText('历史内容尚未完整加载');expect(await clipboard(page)).toHaveLength(0);
});

test('a delayed export cannot download private conversation history after logout',async({page,mock})=>{
 const remote=remoteFixture(mock);const receive=(remote as any).receive.bind(remote);let held=false;let release:()=>void=()=>{};
 (remote as any).receive=(socket:any,request:any)=>{
  if(request.method==='thread/turns/list'&&request.params.itemsView==='full'){held=true;release=()=>receive(socket,request);return;}
  return receive(socket,request);
 };
 await page.addInitScript(()=>{(window as any).conversationDownloads=[];HTMLAnchorElement.prototype.click=function(){(window as any).conversationDownloads.push(this.download);};});
 await login(page);await row(page,'ssh-copy').locator('.nav-row-menu').click();await row(page,'ssh-copy').getByRole('button',{name:'导出 Markdown',exact:true}).click();
 await expect.poll(()=>held).toBe(true);
 await page.getByRole('button',{name:/^设置\s/}).click();await page.getByRole('button',{name:'账户',exact:true}).click();await page.getByRole('button',{name:'退出网页',exact:true}).click();
 await expect(page.locator('input[type="password"]')).toBeVisible();
 const response=page.waitForResponse(r=>r.url().includes('/api/navigation/ssh-copy')&&r.request().postDataJSON()?.method==='thread/turns/list');
 release();await (await response).finished();await page.waitForTimeout(150);
 expect(await page.evaluate(()=>(window as any).conversationDownloads)).toEqual([]);
});

test('forking an unopened remote conversation keeps native history and opens the new branch on its source host',async({page,mock})=>{
 const remote=remoteFixture(mock);await login(page);await row(page).locator('.thread-row').click();
 const original=structuredClone(remote.turns.get('thread-existing'));
 await row(page,'ssh-copy').locator('.nav-row-menu').click();await row(page,'ssh-copy').getByRole('button',{name:'分叉对话 (Fork)',exact:true}).click();
 await expect(page.locator('.main-header')).toContainText('分支测试对话');await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'ssh-copy');
 expect(remote.request('thread/fork')?.params).toEqual({threadId:'thread-existing',excludeTurns:true,deferGoalContinuation:true});
 expect(mock.request('thread/fork')).toBeUndefined();expect(remote.turns.get('fork-1')).toEqual(original);
 expect(remote.turns.get('thread-existing')).toEqual(original);expect(remote.request('turn/start')).toBeUndefined();
});

test('a late remote fork does not steal focus after switching away and back to the original conversation',async({page,mock})=>{
 const remote=remoteFixture(mock);const receive=(remote as any).receive.bind(remote);
 let release:()=>void=()=>{};let held=false;
 (remote as any).receive=(socket:any,request:any)=>{
  if(request.method==='thread/fork'){held=true;release=()=>receive(socket,request);return;}
  return receive(socket,request);
 };
 mock.threads.push({...mock.threads[0],id:'thread-second',name:'第二个对话'});mock.turns.set('thread-second',[]);
 await login(page);await row(page).locator('.thread-row').click();
 await row(page,'ssh-copy').locator('.nav-row-menu').click();await row(page,'ssh-copy').getByRole('button',{name:'分叉对话 (Fork)',exact:true}).click();
 await expect.poll(()=>held).toBe(true);
 await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]').filter({hasText:'第二个对话'}).locator('.thread-row').click();
 await expect(page.getByRole('heading',{name:'第二个对话',exact:true})).toBeVisible();
 await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]').filter({hasText:'已有测试历史'}).locator('.thread-row').click();
 await expect(page.getByRole('heading',{name:'已有测试历史',exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('当前草稿');
 release();await expect(page.locator('[data-section="recent"] .nav-thread[data-host-id="ssh-copy"]').filter({hasText:'分支测试对话'})).toBeVisible();
 await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'local');await expect(page.getByRole('heading',{name:'已有测试历史',exact:true})).toBeVisible();
 await expect(page.getByRole('textbox',{name:'消息输入框',exact:true})).toHaveValue('当前草稿');expect(remote.request('thread/resume')).toBeUndefined();
});

test('a copied remote deep link restores the correct host and thread when opened',async({page,mock})=>{
 const remote=remoteFixture(mock);await setupClipboard(page);await login(page);await copy(page,'ssh-copy','复制深度链接');
 await expect.poll(()=>clipboard(page)).toHaveLength(1);const link=(await clipboard(page))[0]!;
 await page.goto(link);
 await expect(page.getByRole('heading',{name:'远程复制会话',exact:true})).toBeVisible();await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'ssh-copy');
 expect(remote.request('thread/resume')?.params.threadId).toBe('thread-existing');
});

test('clipboard fallback works without a secure-context API and failed copies do not report success',async({page})=>{
 await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});(window as any).copiedTexts=[];document.execCommand=(command:string)=>{if(command==='copy'){(window as any).copiedTexts.push((document.activeElement as HTMLTextAreaElement).value);return true;}return false;};});
 await login(page);await copy(page,'local','复制深度链接');await expect.poll(()=>clipboard(page)).toHaveLength(1);
 await page.evaluate(()=>{document.execCommand=()=>false;});await copy(page,'local','复制工作目录');
 await expect(page.locator('.global-error')).toContainText('无法复制');expect(await clipboard(page)).toHaveLength(1);await expect(page.locator('textarea[aria-hidden="true"]')).toHaveCount(0);
});

test('a delayed clipboard rejection after logout cannot copy private history through the fallback or report success',async({page})=>{
 await page.addInitScript(()=>{
  (window as any).clipboardStarted=false;(window as any).fallbackCopies=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise<void>((_,reject)=>{
   (window as any).clipboardStarted=true;(window as any).rejectClipboard=()=>reject(new Error('permission denied'));
  })}});
  document.execCommand=(command:string)=>{
   if(command==='copy')(window as any).fallbackCopies.push((document.activeElement as HTMLTextAreaElement).value);
   return true;
  };
  (window as any).copySuccessToasts=[];
  new MutationObserver(()=>{
   const text=document.querySelector('.toast-message')?.textContent;
   if(text?.includes('已复制'))(window as any).copySuccessToasts.push(text);
  }).observe(document,{childList:true,subtree:true,characterData:true});
 });
 await login(page);await copy(page,'local','复制为 Markdown');
 await expect.poll(()=>page.evaluate(()=>(window as any).clipboardStarted)).toBe(true);
 await page.getByRole('button',{name:/^设置\s/}).click();await page.getByRole('button',{name:'账户',exact:true}).click();await page.getByRole('button',{name:'退出网页',exact:true}).click();
 await expect(page.locator('input[type="password"]')).toBeVisible();
 await page.evaluate(()=>(window as any).rejectClipboard());
 // Let the clipboard promise and its copy handler finish after authentication was revoked.
 await page.waitForTimeout(150);
 expect(await page.evaluate(()=>(window as any).fallbackCopies)).toEqual([]);
 expect(await page.evaluate(()=>(window as any).copySuccessToasts)).toEqual([]);
 await expect(page.locator('textarea[aria-hidden="true"]')).toHaveCount(0);
});

test('the active conversation menu has the same copy options and closes after copying on mobile',async({page})=>{
 await page.setViewportSize({width:390,height:844});await setupClipboard(page);await login(page);
 await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();await row(page).locator('.thread-row').click();
 await page.getByRole('button',{name:'对话操作',exact:true}).click();const menu=page.locator('.thread-menu');
 await menu.getByRole('button',{name:'复制',exact:true}).click();await menu.getByRole('button',{name:'复制深度链接',exact:true}).click();
 await expect.poll(()=>clipboard(page)).toHaveLength(1);await expect(menu).toHaveCount(0);await expect(page.getByRole('textbox',{name:'消息输入框',exact:true})).toBeEditable();
});
