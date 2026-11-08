async page => {
  const origin = new URL(page.url()).origin;
  if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Use a local preview');
  const context = await page.context().browser().newContext();
  const p = await context.newPage();
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  try {
    // Seed the old plaintext schema before loading the application.
    await p.route(origin + '/seed', route => route.fulfill({contentType:'text/html',body:'seed'}));
    await p.goto(origin + '/seed');
    await p.evaluate(() => new Promise((resolve,reject) => {
      const r=indexedDB.open('whisper-history',2);
      r.onupgradeneeded=()=>{
        const m=r.result.createObjectStore('messages',{keyPath:'id'});m.createIndex('scope','scope');
        m.put({id:'legacy',scope:'old',text:'legacy-plaintext'});
        r.result.createObjectStore('attachments',{keyPath:'id'}).put({id:'legacy-file',data:new Blob(['legacy-bytes'])});
      };
      r.onsuccess=()=>{r.result.close();resolve();};r.onerror=()=>reject(r.error);
    }));
    await p.goto(origin);
    await p.locator('#userName').fill('StoreUser');await p.locator('#roomName').fill('store');
    await p.locator('#login-form button').click();
    await p.waitForFunction(()=>document.querySelector('#chat-container').style.display!=='none'&&document.querySelector('#connection-status').hidden);
    await p.locator('.input-message-input').first().fill('current');await p.locator('.input-message-input').first().press('Enter');
    await p.locator('#history-saving').waitFor({state:'hidden'});
    await p.evaluate(async () => {
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('whisper-history');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const records=await new Promise(resolve=>{const q=db.transaction('messages').objectStore('messages').getAll();q.onsuccess=()=>resolve(q.result);});
      if(records.some(r=>r.text))throw new Error('Legacy plaintext not removed');
      const attachmentCount=await new Promise(resolve=>{const q=db.transaction('attachments').objectStore('attachments').count();q.onsuccess=()=>resolve(q.result);});
      if(attachmentCount)throw new Error('Legacy attachments not removed');
      const vault=JSON.parse(sessionStorage.getItem('whisper-tab-vault-v1'));
      const scope=records[0].scope;
      const key=await crypto.subtle.importKey('raw',new Uint8Array(vault.keys[scope]),'AES-GCM',false,['encrypt']);
      const rows=await Promise.all(Array.from({length:1005},async(_,i)=>{
        const id='seed-'+i,iv=crypto.getRandomValues(new Uint8Array(12));
        const message={id,type:'me',msgType:'text',text:'seed-'+i,timestamp:Date.now()-40*86400000+i};
        const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(scope+':'+id+':message')},key,new TextEncoder().encode(JSON.stringify(message)));
        return {id,scope,session:vault.id,iv,data};
      }));
      await new Promise((resolve,reject)=>{const tx=db.transaction('messages','readwrite');rows.forEach(r=>tx.objectStore('messages').put(r));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
    });
    await p.reload();
    await p.getByText('seed-1004',{exact:true}).waitFor();
    check(await p.locator('#chat-area .bubble.me').count()===1006,'history was limited by age or count');
    console.log('PASS: plaintext v2 migration removed, no age/count limit, encrypted history restored');
  } finally { await context.close(); }
}
