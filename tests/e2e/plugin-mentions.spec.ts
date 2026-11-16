import { test, expect, login } from './fixtures';

function integrations(mock:any) {
  mock.plugins=[
    {id:'documents@openai-primary-runtime',name:'documents',displayName:'Documents',description:'Create and edit documents',enabled:true},
    {id:'pdf@openai-primary-runtime',name:'pdf',displayName:'PDF',description:'Read and create PDFs',enabled:false},
  ];
  const receive=mock.receive.bind(mock);
  mock.receive=(socket:any,request:any)=>{
    if(request.method==='app/list') {
      mock.requests.push(request);
      return socket.send(JSON.stringify({id:request.id,result:{data:[
        {id:'drive_123',name:'Google Drive',description:'Search files',isAccessible:true,isEnabled:true},
        {id:'slack_123',name:'Slack',description:'Messages',isAccessible:false,isEnabled:true},
      ],nextCursor:null}}));
    }
    return receive(socket,request);
  };
}

test('at menu exposes installed bundles and connected apps, preserving official structured input',async({page,mock})=>{
  integrations(mock);await login(page);
  const input=page.getByRole('textbox',{name:'消息输入框'});
  await input.fill('@');
  const menu=page.getByRole('listbox',{name:'插件、应用、模式与文件'});
  await expect(menu.getByRole('option').filter({hasText:'Documents'})).toBeVisible();
  await expect(menu.getByRole('option').filter({hasText:'PDF'})).toBeDisabled();
  await expect(menu.getByRole('option').filter({hasText:'Slack'})).toBeDisabled();
  await menu.getByRole('option').filter({hasText:'Documents'}).click();
  await expect(input).toHaveValue('[@Documents](plugin://documents@openai-primary-runtime) ');
  expect(mock.request('turn/start')).toBeUndefined();
  await input.fill('[@Documents](plugin://documents@openai-primary-runtime) 整理文档');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect.poll(()=>mock.request('turn/start')?.params.input).toContainEqual({type:'mention',name:'Documents',path:'plugin://documents@openai-primary-runtime'});
});

test('app selection works by keyboard and references survive draft restoration',async({page,mock})=>{
  integrations(mock);await login(page);
  const input=page.getByRole('textbox',{name:'消息输入框'});
  await input.fill('@Google');
  await expect(page.getByRole('option').filter({hasText:'Google Drive'})).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('[@Google Drive](app://drive_123) ');
  await input.fill('[@Google Drive](app://drive_123) 查找文档');
  await page.reload();await expect(input).toHaveValue('[@Google Drive](app://drive_123) 查找文档');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect.poll(()=>mock.request('turn/start')?.params.input).toContainEqual({type:'mention',name:'Google Drive',path:'app://drive_123'});
});

test('phone at choices respond to touch while a slow plugin inventory leaves typing available',async({page,mock})=>{
  await page.setViewportSize({width:390,height:844});integrations(mock);await login(page);
  const input=page.getByRole('textbox',{name:'消息输入框'});
  await input.fill('@Doc');
  const option=page.getByRole('option').filter({hasText:'Documents'});
  await expect(option).toBeVisible();await option.click();
  await expect(input).toHaveValue('[@Documents](plugin://documents@openai-primary-runtime) ');
  await expect(input).toBeEditable();
  expect(mock.request('turn/start')).toBeUndefined();
});
