import {test,expect,login} from './fixtures';

test('command search matches titles only and shares cached requests with sidebar search',async({page,mock})=>{
 mock.threads[0]={...mock.threads[0],name:'索引标题',preview:'排除正文关键词'};
 await login(page);const sidebar=page.getByRole('textbox',{name:'搜索对话',exact:true});await sidebar.fill('索引标题');
 await expect.poll(()=>mock.requests.filter(r=>r.method==='thread/list'&&r.params.searchTerm==='索引标题').length).toBe(1);
 await page.keyboard.press('Control+k');const search=page.getByRole('textbox',{name:'搜索对话或指令',exact:true});
 await search.fill('索引标题');await expect(page.locator('.palette-results button')).toHaveCount(1);
 // Clearing the body-only query after it completed ensures the title query
 // is read again through the shared cache, rather than just local filtering.
 await search.fill('排除正文关键词');await expect(page.locator('.palette-results button')).toHaveCount(0);
 await expect.poll(()=>mock.request('thread/list')?.params.searchTerm).toBe('排除正文关键词');
 await search.fill('索引标题');await expect(page.locator('.palette-results button')).toHaveCount(1);
 await expect(page.locator('.palette-empty')).toHaveCount(0);
 await page.waitForTimeout(300);expect(mock.requests.filter(r=>r.method==='thread/list'&&r.params.searchTerm==='索引标题')).toHaveLength(1);
 expect(mock.requests.some(r=>r.method==='thread/search')).toBe(false);
});

test('command search invalidates unloaded results after another client renames and deletes the conversation',async({page,mock})=>{
 let outside={...mock.threads[0],id:'outside-index',name:'索引旧标题'};let deleted=false;
 const receive=(mock as any).receive.bind(mock);
 (mock as any).receive=(socket:any,request:any)=>{
  if(request.method==='thread/list'&&request.params.searchTerm){
   mock.requests.push(request);socket.send(JSON.stringify({id:request.id,result:{data:deleted?[]:[outside],nextCursor:null}}));return;
  }return receive(socket,request);
 };
 await login(page);await page.keyboard.press('Control+k');const search=page.getByRole('textbox',{name:'搜索对话或指令',exact:true});
 await search.fill('索引');await expect(page.locator('.palette-results button')).toContainText(['索引旧标题']);
 outside={...outside,name:'索引新标题'};mock.emit('thread/name/updated',{threadId:outside.id,threadName:outside.name});
 await expect(page.locator('.palette-results button')).toContainText(['索引新标题']);
 deleted=true;mock.emit('thread/deleted',{threadId:outside.id});
 await expect(page.locator('.palette-results button')).toHaveCount(0);
 await expect(page.locator('.palette-empty')).toContainText('没有找到');
});

test('command search finds a saved quotation and Enter opens its source without starting a model turn',async({page,mock})=>{
 mock.bookmarks=[{id:'00000000-0000-4000-8000-000000000088',hostId:'local',projectPath:'/workspace/demo',name:'架构重点',
  source:{threadId:'thread-existing',turnId:'turn-history',itemId:'history-agent',text:'历史保持可读',threadName:'已有测试历史'},createdAt:1,updatedAt:1}];
 await login(page);
 expect(mock.bookmarkRequests).toHaveLength(0);
 await page.keyboard.press('Control+k');
 const search=page.getByRole('textbox',{name:'搜索对话或指令',exact:true});
 await search.fill('架构重点');
 await expect(page.locator('.palette-results button')).toHaveCount(1);
 await expect(page.locator('.palette-results button')).toContainText(['架构重点']);
 await expect(page.locator('.palette-results button')).toContainText(['收藏 · Demo Project · 本机']);
 await search.press('Enter');
 await expect(page.locator('[data-selection-item-id="history-agent"]')).toHaveClass(/bookmark-location/);
 await expect(page.locator('.bookmarks-panel')).toHaveCount(0);
 expect(mock.requests.some(request=>['turn/start','turn/steer','thread/revert','thread/delete'].includes(request.method||''))).toBe(false);
});
