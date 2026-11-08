// Run against the local Wrangler preview using playwright-cli run-code --filename.
async page => {
  await page.setViewportSize({width:1280,height:800});
  const origin = new URL(page.url()).origin;
  if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Use a local preview');
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const suffix = Date.now().toString().slice(-7);
  const room = 'test' + suffix;
  const join = async (p, name, roomName, password) => {
    await p.locator('#userName').fill(name);
    await p.locator('#roomName').fill(roomName);
    await p.locator('#password').fill(password);
    await p.locator('#login-form button[type=submit]').click();
    await p.waitForFunction(() => document.querySelector('#chat-container').style.display !== 'none' && document.querySelector('#connection-status').hidden);
  };
  await page.evaluate(() => sessionStorage.removeItem('whisper-session-v1'));
  await page.goto(origin);
  await join(page, 'Alice', room, 'secret');
  check(new URL(page.url()).searchParams.has('r'), 'room URL missing');
  check(new URL(page.url()).searchParams.has('p'), 'password missing from invitation');
  const invitation = page.url();
  const guest = await page.context().browser().newContext();
  const other = await guest.newPage();
  try {
    await other.goto(invitation);
    check(await other.locator('#roomName').inputValue() === room, 'invitation room');
    check(!(await other.locator('#password').isEditable()), 'invitation password not locked');
    check(await other.locator('#password').inputValue() === 'secret', 'password not restored');
    await other.locator('#userName').fill('Bob');
    await other.locator('#login-form button[type=submit]').click();
    await other.waitForFunction(() => document.querySelector('#connection-status').hidden && document.querySelector('#chat-container').style.display !== 'none');
    await page.waitForFunction(() => document.querySelector('#member-list').textContent.includes('Bob'));
    await page.locator('.input-message-input').first().fill('hello-' + suffix);
    await page.locator('.input-message-input').first().press('Enter');
    await other.getByText('hello-' + suffix, { exact: true }).waitFor();
    await page.locator('#history-saving').waitFor({state:'hidden'}); await page.reload();
    await page.getByText('hello-' + suffix, { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#connection-status').hidden);
    check(await page.locator('#chat-area .bubble.me').count() === 1, 'duplicate own history');
    await other.locator('#history-saving').waitFor({state:'hidden'}); await other.reload();
    await other.getByText('hello-' + suffix, { exact: true }).waitFor();
    // Private history must survive without restoring a stale private connection.
    await page.waitForFunction(() => document.querySelector('#member-list').textContent.includes('Bob'));
    await page.locator('#member-list .member').filter({ hasText: 'Bob' }).click();
    await page.locator('.input-message-input').first().fill('private-' + suffix);
    await page.locator('.input-message-input').first().press('Enter');
    await other.getByText('private-' + suffix, { exact: true }).waitFor();
    await page.locator('#history-saving').waitFor({state:'hidden'}); await page.reload();
    await page.getByText('private-' + suffix, { exact: false }).first().waitFor();
    check((await page.locator('#chat-area').textContent()).includes('Bob'), 'private recipient lost');
    await page.locator('#more-btn').click();
    await page.locator('[data-action=exit]').click();
    await page.locator('#login-form').waitFor({ state: 'visible' });
    await page.locator('#history-saving').waitFor({state:'hidden'}); await page.reload();
    await page.locator('#login-form').waitFor({ state: 'visible' });
    check(await page.evaluate(() => sessionStorage.getItem('whisper-session-v1')) === null, 'exit session retained');
    check(new URL(page.url()).search === '', 'exit URL retained');
    console.log('PASS: invitation, password entry, real encrypted public/private delivery, refresh, no duplicate replay, explicit exit');
  } finally { await guest.close(); }
}
