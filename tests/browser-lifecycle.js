async page => {
  const origin = new URL(page.url()).origin;
  if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Use a local preview');
  const context = await page.context().browser().newContext();
  const p = await context.newPage();
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const room = 'life' + Date.now().toString().slice(-7);
  const ready = async target => {
    await target.waitForFunction(() => document.querySelector('#chat-container').style.display !== 'none' && document.querySelector('#connection-status').hidden);
  };
  const join = async (target, name = 'Alice', roomName = room) => {
    await target.locator('#userName').fill(name);
    if (await target.locator('#roomName').isEditable()) await target.locator('#roomName').fill(roomName);
    await target.locator('#login-form button').click(); await ready(target);
  };
  const send = async (target, text) => {
    await target.locator('.input-message-input').first().fill(text);
    await target.locator('.input-message-input').first().press('Enter');
    await target.getByText(text, {exact:true}).waitFor();
    await target.locator('#history-saving').waitFor({state:'hidden'});
  };
  const rows = target => target.evaluate(() => new Promise((resolve,reject) => {
    const r=indexedDB.open('whisper-history'); r.onerror=()=>reject(r.error); r.onsuccess=()=>{
      const db=r.result;const tx=db.transaction('messages');const q=tx.objectStore('messages').getAll();
      q.onsuccess=()=>resolve(q.result);tx.oncomplete=()=>db.close();
    };
  }));
  let stage = "start";
  try {
    await p.goto(origin);
    check(await p.locator('#retentionDays').count() === 0, 'retention field remains');
    await join(p); await send(p, 'first-session-secret');
    check(!new URL(p.url()).searchParams.has('d'), 'retention URL parameter remains');
    const stored = await rows(p);
    check(stored.length === 1 && !('text' in stored[0]) && stored[0].data, 'history is not encrypted');
    stage = '0: await p.reload();';
    await p.reload(); await ready(p);
    await p.getByText('first-session-secret', {exact:true}).waitFor();
    const invitation = p.url();
    // Independent tab, same identity/room, must not read or clear the first tab's history.
    stage = '1: const other =';
    const other = await context.newPage(); await other.goto(invitation); await join(other);
    check(!(await other.locator('#chat-area').textContent()).includes('first-session-secret'), 'history leaked to another tab');
    await send(other, 'second-session-secret');
    // A fresh tab must not collect another tab while its reload assets are delayed.
    await p.route('**/assets/index-*.js', async route => {
      await new Promise(resolve => setTimeout(resolve, 800)); await route.continue();
    });
    stage = '2: const reload =';
    const reload = p.reload();
    const fresh = await context.newPage(); await fresh.goto(origin);
    await fresh.locator('#userName').waitFor();
    await reload; await ready(p);
    await p.getByText('first-session-secret', {exact:true}).waitFor();
    await p.unroute('**/assets/index-*.js'); await fresh.close();
    stage = '3: await other.close();';
    await other.close();
    await p.reload(); await ready(p);
    await p.getByText('first-session-secret', {exact:true}).waitFor();
    // Explicit exit must destroy this room's key and stored records before rejoining.
    stage = "4: await p.locator('#more-btn')";
    await p.locator('#more-btn').click(); await p.locator('[data-action=exit]').click();
    await p.locator('#login-form').waitFor({state:'visible'});
    check(!(await rows(p)).some(r => r.session === stored[0].session), 'exit left records behind');
    stage = '5: await join(p);\n    check';
    await join(p);
    check(!(await p.locator('#chat-area').textContent()).includes('first-session-secret'), 'exit history restored');
    await send(p, 'leave-secret');
    stage = "6: await p.goto('about:blank');";
    await p.goto('about:blank');
    await p.goBack();
    await p.locator('#login-form').waitFor({state:'visible'});
    stage = "7: await join(p);\n    check(!(await p.locator('#chat-area').textContent()).includes('leave";
    await join(p);
    check(!(await p.locator('#chat-area').textContent()).includes('leave-secret'), 'back navigation restored old history');
    await send(p, 'close-secret');
    const closedURL = p.url(); await p.close();
    stage = '8: const reopened';
    const reopened = await context.newPage(); await reopened.goto(closedURL);
    await reopened.locator('#login-form').waitFor({state:'visible'});
    check(await reopened.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('whisper-tab-vault-v1')).keys).length) === 0, 'closed-tab keys were reused');
    stage = '9: await join(reopened);';
    await join(reopened);
    check(!(await reopened.locator('#chat-area').textContent()).includes('close-secret'), 'closed tab history restored');
    // Internal room switching keeps history; leaving one room clears only that room.
    await send(reopened, 'keep-first-room');
    stage = "10: await reopened.locator('.join-room')";
    await reopened.locator('.join-room').click();
    await reopened.locator('#userName-modal').fill('Alice');
    await reopened.locator('#roomName-modal').fill('other' + room.slice(-7));
    await reopened.locator('#login-form-modal button').click(); await ready(reopened);
    await send(reopened, 'remove-second-room');
    await reopened.locator('#more-btn').click(); await reopened.locator('[data-action=exit]').click();
    await reopened.getByText('keep-first-room', {exact:true}).waitFor();
    stage = '11: await reopened.reload();';
    await reopened.reload(); await ready(reopened);
    await reopened.getByText('keep-first-room', {exact:true}).waitFor();
    check(await reopened.locator('#room-list .room').count() === 1, 'exited room restored');
    console.log('PASS: refresh, encrypted storage, independent tabs, explicit exit, back navigation, close/reopen, multi-room isolation');
  } catch (error) { throw new Error(stage + " :: " + error.message + " :: " + JSON.stringify(await Promise.all(context.pages().map(async p=>({url:p.url(),body:await p.locator("body").innerText().catch(()=>"closed")}))))); } finally { await context.close(); }
}
