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
  const a = await newPage(), b = await newPage(), c = await newPage();
  let stage = "start";
  try {
    stage = '0: await join(a, origin';
    await join(a, origin, 'Alice', 'shared' + Date.now());
    stage = '1: await send(a,';
    const normal = await share(a, false); let full;
    const early = await newPage(); await join(early, normal, 'Early');
    for (let i = 0; i < 10; i++) await send(a, 'old-public-' + i);
    await early.getByText('old-public-9', {exact:true}).waitFor();
    await join(b, normal, 'Bob');
    await b.locator('#history-sync').waitFor({state:'hidden'});
    check(await countReplicas(b) === 0, 'ordinary member stored pre-join history');
    for (let i = 0; i < 10; i++) await send(a, 'after-join-' + i);
    await b.getByText('after-join-9', {exact:true}).waitFor();
    await a.locator('.input-message-input').first().evaluate(async el => {
      const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;canvas.getContext('2d').fillRect(0,0,8,8);
      const blob=await new Promise(r=>canvas.toBlob(r));const data=new DataTransfer();data.items.add(new File([blob],'pixel.png',{type:'image/png'}));
      el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    });
    await a.locator('.input-image-preview').waitFor(); await a.locator('.send-message-btn').click(); await a.locator('#history-saving').waitFor({state:'hidden'});
    const payload = Buffer.from('public file survives author leaving\n中文');
    await a.locator('.chat-attach-btn').click(); await a.locator('#file-upload-input').setInputFiles([{name:'history.txt',mimeType:'text/plain',buffer:payload}]); await a.locator('.file-upload-send-btn').click();
    await a.locator('.file-download-btn').waitFor(); await a.locator('#history-saving').waitFor({state:'hidden'});
    check(new URL(normal).searchParams.has('p') && !new URL(normal).searchParams.has('h'), 'normal share params');
    full = await share(a, true);
    check(new URL(full).searchParams.has('h'), 'full share token');
    await b.locator('.file-download-btn').waitFor();
    await b.locator('#history-saving').waitFor({state:'hidden'});
    check(await countReplicas(b) === 12, 'member must hold only 10 new texts, image and file');
    check(!(await b.locator('#chat-area').textContent()).includes('old-public'), 'normal share leaked old text');
    // A history invite while original holders remain can still retrieve all 22 records.
    const all = await newPage(); await join(all, full, 'All');
    await all.getByText('old-public-9', {exact:true}).waitFor();
    await all.locator('#history-sync').waitFor({state:'hidden'});
    check(await countReplicas(all) === 22, 'history invite lost available records');
    await all.close();
    await a.waitForFunction(()=>document.querySelector('#member-list').textContent.includes('Bob'));
    await a.locator('#member-list .member').filter({hasText:'Bob'}).click(); await send(a, 'private-never-shared');
    await b.getByText('private-never-shared',{exact:true}).waitFor();
    stage = '4: await a.close();';
    await early.close(); await a.close();
    // Simulate an invisible replica from the previous client version; refresh must remove it.
    await b.evaluate(() => new Promise((resolve, reject) => {
      const r = indexedDB.open('whisper-history');
      r.onsuccess = () => {
        const db = r.result, tx = db.transaction('replicas', 'readwrite'), store = tx.objectStore('replicas');
        const q = store.getAll();
        q.onsuccess = () => store.put({ ...q.result[0], id: 'legacy-hidden', seq: 1 });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    }));
    stage = '5: await b.reload();';
    await b.reload(); await ready(b);
    check(!(await b.locator('#chat-area').textContent()).includes('old-public'), 'refresh upgraded normal access');
    check(await countReplicas(b) === 12, 'refresh changed the join boundary');
    stage = '6: await join(c, full';
    await join(c, full, 'Carol');
    stage = "7: await c.getByText('old-public'";
    await c.getByText('after-join-9',{exact:true}).waitFor(); await c.locator('.bubble-img').waitFor();
    await c.locator('#history-sync').waitFor({state:'hidden'});
    check(await countReplicas(c) === 12, 'history invite recovered records whose holders left');
    check(!(await c.locator('#chat-area').textContent()).includes('old-public'), 'lost early history resurfaced');
    check(await c.locator('#chat-area .bubble').filter({hasText:'after-join-'}).count() === 10, 'expected exactly 10 retained text messages');
    check(!(await c.locator('#chat-area').textContent()).includes('private-never-shared'), 'private history leaked');
    const download = c.waitForEvent('download'); await c.locator('.file-message').filter({hasText:'history.txt'}).locator('.file-download-btn').click();
    const file = await download, chunks=[]; for await (const chunk of await file.createReadStream()) chunks.push(chunk);
    check(Buffer.concat(chunks).equals(payload), 'historical file bytes mismatch');
    await send(b, 'new-public'); await c.getByText('new-public',{exact:true}).waitFor();
    stage = '8: await b.close();';
    await b.close(); await c.locator('#history-saving').waitFor({state:'hidden'}); await c.reload(); await ready(c);
    await c.getByText('after-join-9',{exact:true}).waitFor();
    stage = '9: await c.close();';
    await c.close();
    // Last member is gone. An old invitation cannot recreate the lost browser copies.
    await new Promise(resolve => setTimeout(resolve, 11000));
    stage = '10: const d = await newPage();';
    const d = await newPage(); await join(d, full, 'Dave');
    check(!(await d.locator('#chat-area').textContent()).includes('old-public'), 'empty room restored expired history');
    check(await countReplicas(d) === 0, 'new epoch contains old replicas');
    stage = 'd send'; await send(d, 'fresh-epoch'); stage = 'd reload'; await d.reload(); await ready(d); stage = 'd restored text'; await d.getByText('fresh-epoch',{exact:true}).waitFor();
    stage = 'slow refresh expires';
    await d.route('**/assets/index-*.js', async route => { await new Promise(resolve => setTimeout(resolve, 11000)); await route.continue(); });
    await d.reload(); await ready(d);
    check(!(await d.locator('#chat-area').textContent()).includes('fresh-epoch'), 'slow refresh revived expired room');
    console.log('PASS: normal/full shares, password, peer handoff, join-boundary storage and refresh, private exclusion, image/file bytes, sole refresh, empty-room expiry');
  } catch (error) { throw new Error(stage + " :: " + error.message + " :: pages=" + JSON.stringify(await Promise.all(contexts.flatMap(ctx=>ctx.pages()).map(async p=>({url:p.url(),body:await p.locator("body").innerText().catch(()=>"closed")}))))); } finally { for (const context of contexts) await context.close(); }
}
