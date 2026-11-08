async page => {
 const origin=new URL(page.url()).origin;
 if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw new Error('Local preview only');
 const ctx=await page.context().browser().newContext();const p=await ctx.newPage();
 const ready=()=>p.waitForFunction(()=>document.querySelector('#chat-container')?.style.display!=='none'&&document.querySelector('#connection-status')?.hidden);
 const send=async text=>{await p.locator('.input-message-input').first().fill(text);await p.locator('.input-message-input').first().press('Enter');await p.locator('#history-saving').waitFor({state:'hidden'});};
 try {
  await p.route(origin+'/before',r=>r.fulfill({contentType:'text/html',body:'Previous page'}));
  await p.goto(origin+'/before');await p.goto(origin);
  await p.locator('#userName').fill('ChromeUser');await p.locator('#roomName').fill('traverse'+Date.now());await p.locator('#login-form button').click();await ready();
  await send('return-within-window');
  const identity=await p.evaluate(()=>JSON.parse(sessionStorage.getItem('whisper-tab-vault-v1')).id);
  await p.goBack();await p.getByText('Previous page').waitFor();await p.goForward();await ready();
  await p.getByText('return-within-window',{exact:true}).waitFor();
  if(await p.evaluate(()=>JSON.parse(sessionStorage.getItem('whisper-tab-vault-v1')).id)!==identity)throw new Error('History traversal lost same-tab identity');
  await p.goBack();await p.getByText('Previous page').waitFor();await new Promise(resolve=>setTimeout(resolve,11000));await p.goForward();await ready();
  if((await p.locator('#chat-area').innerText()).includes('return-within-window'))throw new Error('Expired history revived after room was empty');
  await send('new-room-session');await p.reload();await ready();await p.getByText('new-room-session',{exact:true}).waitFor();
  await p.locator('#more-btn').click();await p.locator('[data-action=exit]').click();await p.locator('#login-form').waitFor({state:'visible'});
  await p.goBack();await p.goForward();await p.locator('#login-form').waitFor({state:'visible'});
  if(await p.evaluate(()=>sessionStorage.getItem('whisper-session-v1')))throw new Error('Explicit exit revived credentials');
  console.log('PASS: back/forward restores room; within-grace records recover; empty-room expiry drops records; explicit exit remains logged out');
 }finally{await ctx.close();}
}
