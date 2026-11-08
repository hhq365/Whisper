async page => {
 const origin=new URL(page.url()).origin;
 if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw new Error('Local preview only');
 const ctx=await page.context().browser().newContext({viewport:{width:1280,height:800}});
 
 await ctx.addInitScript(()=>{window.navigation?.addEventListener('navigate',e=>sessionStorage.setItem('debug-navigate',JSON.stringify({type:e.navigationType,url:e.destination.url,here:location.href,same:e.destination.sameDocument})));window.addEventListener('pagehide',e=>sessionStorage.setItem('debug-hide',JSON.stringify({persisted:e.persisted,vault:JSON.parse(sessionStorage.getItem('whisper-tab-vault-v1'))?.resumeURL})));});
 const p=await ctx.newPage();
 const ready=()=>p.waitForFunction(()=>document.querySelector('#chat-container').style.display!=='none'&&document.querySelector('#connection-status').hidden);
 try {
  await p.goto(origin);await p.locator('#userName').fill('RefreshUser');await p.locator('#roomName').fill('reload'+Date.now());await p.locator('#login-form button').click();await ready();
  await p.locator('.input-message-input').first().fill('refresh-keeps-this-message');await p.locator('.input-message-input').first().press('Enter');await p.locator('#history-saving').waitFor({state:'hidden'});
  const before=await p.evaluate(()=>JSON.parse(sessionStorage.getItem('whisper-tab-vault-v1')).id);
  await p.goto(p.url());
  await p.waitForFunction(()=>document.querySelector('#userName')||document.querySelector('#chat-container').style.display!=='none');
  const after=await p.evaluate(()=>JSON.parse(sessionStorage.getItem('whisper-tab-vault-v1')).id);
  if(before!==after)throw new Error('Same-URL navigation discarded the session: '+await p.evaluate(()=>JSON.stringify({navigate:sessionStorage.getItem('debug-navigate'),hide:sessionStorage.getItem('debug-hide'),type:performance.getEntriesByType('navigation')[0]?.type})));
  await ready();await p.getByText('refresh-keeps-this-message',{exact:true}).waitFor();
  await p.locator('#more-btn').click();await p.locator('[data-action=exit]').click();await p.locator('#login-form').waitFor({state:'visible'});await p.reload();await p.locator('#login-form').waitFor({state:'visible'});
  if(await p.evaluate(()=>sessionStorage.getItem('whisper-session-v1')))throw new Error('Explicit exit resurrected session');
  console.log('PASS: same-URL Chrome navigation retains identity and messages; explicit exit stays logged out');
 }finally{await ctx.close();}
}
