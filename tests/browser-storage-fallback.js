async page => {
  const origin = new URL(page.url()).origin;
  if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Use a local preview');
  const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => {
      indexedDB.open = () => { throw new DOMException('Blocked for test', 'SecurityError'); };
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === sessionStorage) throw new DOMException('Blocked for test', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    });
    const p = await context.newPage();
    await p.goto(origin);
    await p.locator('#userName').fill('Mobile');
    await p.locator('#roomName').fill('fallback');
    await p.locator('#login-form button').click();
    await p.waitForFunction(() => document.querySelector('#chat-container').style.display !== 'none' && document.querySelector('#connection-status').hidden);
    await p.locator('#history-error').waitFor({ state: 'visible' });
    await p.locator('#session-error').waitFor({ state: 'visible' });
    await p.locator('.input-message-input').first().fill('Storage blocked, chat still works');
    await p.locator('.input-message-input').first().press('Enter');
    await p.getByText('Storage blocked, chat still works', { exact: true }).waitFor();
    await p.screenshot({ path: 'output/playwright/mobile-history.png', fullPage: true });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error('Mobile horizontal overflow');
    console.log('PASS: blocked IndexedDB and session storage degrade gracefully; mobile layout fits');
  } finally { await context.close(); }
}
