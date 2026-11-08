async page => {
  const origin = new URL(page.url()).origin;
  if (!['localhost','127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Local preview only');
  const browser = page.context().browser(), contexts = [];
  const useNode = new URL(page.url()).searchParams.get('backend') === 'node';
  const check = (ok, why) => { if (!ok) throw new Error(why); };
  const newPage = async () => { const ctx = await browser.newContext(); contexts.push(ctx); if (useNode) await ctx.addInitScript(() => { const Native = window.WebSocket; window.WebSocket = class extends Native { constructor(url, protocols) { super('ws://127.0.0.1:8088', protocols); } }; }); return ctx.newPage(); };
  const ready = p => p.waitForFunction(() => document.querySelector('#chat-container').style.display !== 'none' && document.querySelector('#connection-status').hidden);
  const join = async (p, url, name, room) => {
    await p.goto(url); await p.locator('#userName').fill(name);
    if (room) { await p.locator('#roomName').fill(room); await p.locator('#password').fill('secret'); }
    await p.locator('#login-form button').click(); await ready(p);
  };
  const share = async (p, full) => {
    await p.evaluate(() => { window.copied = null; Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText: async value => { window.copied = value; }} }); });
    await p.locator('#more-btn').click(); await p.locator(full ? '[data-action=share-history]' : '[data-action=share]').click();
    await p.waitForFunction(() => window.copied); return p.evaluate(() => window.copied);
  };
  const send = async (p, value) => { await p.locator('.input-message-input').first().fill(value); await p.locator('.input-message-input').first().press('Enter'); await p.locator('#history-saving').waitFor({state:'hidden'}); };
  const countReplicas = p => p.evaluate(() => new Promise((resolve,reject) => { const r=indexedDB.open('whisper-history'); r.onsuccess=()=>{const db=r.result;const q=db.transaction('replicas').objectStore('replicas').count(); q.onsuccess=()=>{resolve(q.result);db.close();};}; r.onerror=()=>reject(r.error); }));
  const a = await newPage(), c = await newPage(), d = await newPage(), e = await newPage();
  let stage = 'setup';
  try {
    await join(a, origin, 'Alice', 'scope' + Date.now());
    const normal = await share(a, false);
    for(let i=1;i<=10;i++) await send(a, 'message-' + i);
    await join(c, normal, 'Carol');
    for(let i=11;i<=20;i++) await send(a, 'message-' + i);
    await c.getByText('message-20',{exact:true}).waitFor();await c.locator('#history-saving').waitFor({state:'hidden'});
    const fromA = await share(a,true), fromC = await share(c,true);
    check(fromA!==fromC,'different histories share the same token');
    stage = 'C invitation while A remains online';
    await join(d, fromC, 'Dave');await d.locator('#history-sync').waitFor({state:'hidden'});
    check(await countReplicas(d)===10,'C invitation expanded beyond ten records');
    check(await d.getByText('message-1',{exact:true}).count()===0,'old records leaked');
    check(await d.getByText('message-11',{exact:true}).count()===1,'retained records missing');
    stage = 'A invitation';
    await join(e, fromA, 'Eve');await e.locator('#history-sync').waitFor({state:'hidden'});
    check(await countReplicas(e)===20,'A invitation did not include twenty records');
    stage = 'snapshot gap and live messages';
    await send(a,'between-invite-and-entry');
    const later = await newPage();await join(later,fromC,'Later');await later.locator('#history-sync').waitFor({state:'hidden'});
    check(await countReplicas(later)===10,'old invitation included messages sent after creation');
    await send(a,'after-entry');await later.getByText('after-entry',{exact:true}).waitFor();
    await later.reload();await ready(later);await later.locator('#history-sync').waitFor({state:'hidden'});
    check(await countReplicas(later)===11,'refresh expanded or lost invitation range');
    const nested = await share(later,true), nestedPage = await newPage();
    await join(nestedPage,nested,'Nested');await nestedPage.locator('#history-sync').waitFor({state:'hidden'});
    check(await countReplicas(nestedPage)===11,'re-sharing filled a historical gap');
    console.log('PASS: A shares 20, C shares 10, all donors constrained, frozen snapshot gap, live traffic, refresh, re-sharing');
  } catch(error) {throw new Error(stage+' :: '+error.message);} finally {for(const ctx of contexts)await ctx.close();}
}
