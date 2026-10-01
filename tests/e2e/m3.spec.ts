import {test,expect} from '@playwright/test';

test('an idle session reconnects automatically after the first stream request fails',async({page})=>{
 let streams=0;
 await page.route('**/api/v1/sessions/*/events?after_seq=*',async route=>{streams++;if(streams===1)await route.abort('failed');else await route.continue();});
 await page.goto('/runs/seed_s05');await page.getByRole('button',{name:'新建会话'}).click();
 await expect(page.getByText('本机消息通道已连接',{exact:true})).toBeVisible({timeout:10000});
 expect(streams).toBeGreaterThanOrEqual(2);
 await expect(page.locator('.diagnosis-message.user')).toHaveCount(0);
});

test('late snapshot from another session does not overwrite the selected session',async({page})=>{
 const key=crypto.randomUUID();
 const create=async(label:string)=>{const response=await page.request.post('http://127.0.0.1:4174/api/v1/sessions',{headers:{'Idempotency-Key':key+label},data:{run_id:'seed_s05'}});return (await response.json()).data.id as string;};
 const a=await create('a'),b=await create('b');
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let delayed=false;
 await page.route(`**/api/v1/sessions/${a}`,async route=>{if(!delayed){delayed=true;await gate;}await route.continue();});
 await page.goto('/runs/seed_s05');
 await page.getByRole('combobox',{name:'诊断会话'}).selectOption(a);
 await expect.poll(()=>delayed).toBe(true);
 await page.getByRole('combobox',{name:'诊断会话'}).selectOption(b);release();
 await expect(page.getByRole('combobox',{name:'诊断会话'})).toHaveValue(b);
 await expect(page.getByText('本机消息通道已连接',{exact:true})).toBeVisible();
 expect(await page.locator('.diagnosis-message.user').count()).toBe(0);
});

test('a lost submit response can be retried without creating a second user message',async({page})=>{
 await page.goto('/runs/seed_s04');await page.getByRole('button',{name:'新建会话'}).click();
 let dropped=false;
 await page.route('**/api/v1/sessions/*/messages',async route=>{if(!dropped){dropped=true;await route.fetch();await route.abort('failed');}else await route.continue();});
 const compose=page.getByRole('textbox',{name:'诊断问题'});await compose.fill('请求响应丢失测试');await page.getByRole('button',{name:'发送'}).click();
 await expect(page.locator('.inline-error').first()).toBeVisible();
 await page.getByRole('button',{name:'发送'}).click();
 await expect(page.locator('.diagnosis-message.user')).toHaveCount(1);
 await expect(page.locator('.diagnosis-result')).toBeVisible();
});

test('a log citation outside the visible log slice opens context with the exact log highlighted',async({page})=>{
 await page.goto('/runs/seed_s04');await page.getByRole('button',{name:'新建会话'}).click();
 await expect(page.getByText('本机消息通道已连接',{exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'诊断问题'}).fill('这次为什么失败？');await page.getByRole('button',{name:'发送'}).click();
 await expect(page.locator('.diagnosis-result')).toBeVisible();
 await page.locator('.evidence-links button').nth(1).click();
 const dialog=page.getByRole('dialog',{name:'证据详情'});await expect(dialog).toBeVisible();
 await expect(dialog.locator('.highlight')).toContainText('ReadTimeout');
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});

test('refresh from an in-progress snapshot replays the completed turn once',async({page})=>{
 const key=crypto.randomUUID();const create=await page.request.post('http://127.0.0.1:4174/api/v1/sessions',{headers:{'Idempotency-Key':key},data:{run_id:'seed_s05'}});
 const id=(await create.json()).data.id as string;
 const sent=await page.request.post(`http://127.0.0.1:4174/api/v1/sessions/${id}/messages`,{headers:{'Idempotency-Key':key+'-turn'},data:{content:'这次故障能确定原因吗？'}});
 expect(sent.status()).toBe(202);
 let full:{data:{turns:{status:string}[];messages:{role:string}[];tool_calls:unknown[];results:unknown[];last_event_seq:number}}|undefined;
 await expect.poll(async()=>{full=await (await page.request.get(`http://127.0.0.1:4174/api/v1/sessions/${id}`)).json();return full!.data.turns.at(-1)?.status;}).toBe('COMPLETED');
 const stale=structuredClone(full!);stale.data.turns[0]!.status='RUNNING';stale.data.results=[];stale.data.tool_calls=[];stale.data.messages=stale.data.messages.filter(x=>x.role==='user');stale.data.last_event_seq=0;
 let delivered=false;await page.route(`**/api/v1/sessions/${id}`,async route=>{if(!delivered){delivered=true;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(stale)});}else await route.continue();});
 await page.goto('/runs/seed_s05');
 await expect(page.locator('.diagnosis-result')).toBeVisible();
 await expect(page.locator('.diagnosis-message.user')).toHaveCount(1);
 await expect(page.locator('.diagnosis-message.assistant')).toHaveCount(1);
 expect(delivered).toBe(true);
});

test('information-poor demo makes unavailable diagnostics and retry eligibility explicit',async({page})=>{
 await page.goto('/runs/seed_s05');
 const scope=page.getByRole('note',{name:'诊断能力范围'});
 await expect(scope).toContainText('不能提高日志级别');
 await expect(scope).toContainText('不能调取未记录的堆栈');
 await expect(scope).toContainText('S05 演示数据没有更详细的日志或堆栈');
 await expect(scope).toContainText('当前运行不支持模拟重试');
});

test('citation button toggles its popover and a closed loading response cannot reopen it',async({page})=>{
 await page.goto('/runs/seed_s04');await page.getByRole('button',{name:'新建会话'}).click();
 await expect(page.getByText('本机消息通道已连接',{exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'诊断问题'}).fill('这次为什么失败？');await page.getByRole('button',{name:'发送'}).click();
 await expect(page.locator('.diagnosis-result')).toBeVisible();
 const first=page.locator('.evidence-links button').first(),second=page.locator('.evidence-links button').nth(1);
 const dialog=page.getByRole('dialog',{name:'证据详情'});
 await first.click();await expect(dialog.getByRole('heading',{name:/证据 ·/})).toBeVisible();
 await first.click();await expect(dialog).toHaveCount(0);
 await expect(page.locator('.diagnosis-result')).toBeVisible();await expect(page.locator('.diagnosis-message.user')).toHaveCount(1);
 await first.click();await expect(dialog.getByRole('heading',{name:/证据 ·/})).toBeVisible();
 await second.click();await expect(dialog.locator('.highlight')).toContainText('ReadTimeout');
 await expect(dialog).toHaveCount(1);await page.getByRole('button',{name:'关闭引用',exact:true}).click();await expect(dialog).toHaveCount(0);
 await first.click();await expect(dialog).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);

 let release!:()=>void,requested=false;const gate=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/v1/sessions/*/evidence/*',async route=>{requested=true;await gate;await route.continue();});
 try{
  await first.click();await expect.poll(()=>requested).toBe(true);await expect(dialog.getByRole('status')).toHaveText('正在加载证据…');
  await first.click();await expect(dialog).toHaveCount(0);
  const response=page.waitForResponse(r=>r.url().includes('/evidence/'));release();await response;
  await expect(dialog).toHaveCount(0);await expect(page.locator('.diagnosis-result')).toBeVisible();
 }finally{release();}
});
