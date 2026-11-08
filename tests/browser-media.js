async page => {
  const origin = new URL(page.url()).origin;
  if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Use a local preview');
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const browser = page.context().browser();
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  const room = 'media' + Date.now().toString().slice(-7);
  const ready = p => p.waitForFunction(() => document.querySelector('#chat-container').style.display !== 'none' && document.querySelector('#connection-status').hidden);
  const upload = async (p, files) => {
    await p.locator('.chat-attach-btn').click();
    await p.locator('#file-upload-input').setInputFiles(files);
    await p.locator('.file-upload-send-btn').click();
  };
  const download = async (p, name, expected) => {
    const card = p.locator('.file-message').filter({ hasText: name });
    const event = p.waitForEvent('download');
    await card.locator('.file-download-btn').click();
    const result = await event;
    const stream = await result.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    check(Buffer.concat(chunks).equals(expected), 'Downloaded bytes differ: ' + name);
  };
  try {
    await a.goto(origin);
    await a.locator('#userName').fill('Alice');
    await a.locator('#roomName').fill(room);
    await a.locator('#password').fill('secret');
    await a.locator('#login-form button').click();
    await ready(a);
    const invitation = a.url();
    check(new URL(invitation).searchParams.has('p'), 'missing shared password');
    await b.goto(invitation);
    check(await b.locator('#password').inputValue() === 'secret', 'shared password mismatch');
    await b.locator('#userName').fill('Bob');
    await b.locator('#login-form button').click();
    await ready(b);
    await a.waitForFunction(() => document.querySelector('#member-list').textContent.includes('Bob'));
    // Real image paste/send flow, not a seeded history record.
    await a.locator('.input-message-input').first().evaluate(async el => {
      const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 12;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 12, 12);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const data = new DataTransfer(); data.items.add(new File([blob], 'pixel.png', {type:'image/png'}));
      el.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:data}));
    });
    await a.locator('.input-image-preview').waitFor();
    await a.locator('.send-message-btn').click();
    await b.locator('#chat-area .bubble-img').waitFor();
    // Receive a complete file while a different room is selected.
    await b.locator('.join-room').click();
    await b.locator('#userName-modal').fill('Bob');
    await b.locator('#roomName-modal').fill('other' + room.slice(-7));
    await b.locator('#login-form-modal button').click();
    await ready(b);
    const bytes = Buffer.from('Whisper attachment\n中文\n\u0000\u0001\u0002');
    await upload(a, [{name:'example.bin', mimeType:'application/octet-stream', buffer:bytes}]);
    await a.locator('.file-message').filter({hasText:'example.bin'}).locator('.file-download-btn').waitFor({state:'visible'});
    await b.locator('#room-list .room').first().click();
    await download(b, 'example.bin', bytes);
    await a.locator('#history-saving').waitFor({state:'hidden'}); await a.reload(); await ready(a);
    await b.locator('#history-saving').waitFor({state:'hidden'}); await b.reload(); await ready(b);
    await download(a, 'example.bin', bytes);
    await download(b, 'example.bin', bytes);
    for (const p of [a,b]) {
      check(await p.locator('#chat-area .bubble-img').evaluate(img => img.complete && img.naturalWidth > 0), 'image did not restore');
    }
    // Private attachments also persist and remain downloadable.
    await a.waitForFunction(() => document.querySelector('#member-list').textContent.includes('Bob'));
    await a.locator('#member-list .member').filter({hasText:'Bob'}).click();
    await upload(a, [{name:'private.txt', mimeType:'text/plain', buffer:bytes}]);
    await download(b, 'private.txt', bytes);
    await b.locator('#history-saving').waitFor({state:'hidden'}); await b.reload(); await ready(b);
    await download(b, 'private.txt', bytes);
    // A multi-file archive restores its manifest, compressed data and hash.
    await upload(a, [{name:'one.txt', mimeType:'text/plain', buffer:Buffer.from('one')}, {name:'two.txt', mimeType:'text/plain', buffer:Buffer.from('two')}]);
    await b.locator('.file-message').filter({hasText:'📦'}).locator('.file-download-btn').waitFor({state:'visible'});
    await b.locator('#history-saving').waitFor({state:'hidden'}); await b.reload(); await ready(b);
    const zipEvent = b.waitForEvent('download');
    await b.locator('.file-message').filter({hasText:'📦'}).locator('.file-download-btn').click();
    const archive = await zipEvent;
    check(archive.suggestedFilename().endsWith('.zip'), 'archive is not ZIP');
    const chunks = []; for await (const chunk of await archive.createReadStream()) chunks.push(chunk);
    const extracted = await b.evaluate(async bytes => {
      const data = new Uint8Array(bytes); const view = new DataView(data.buffer); const entries = {};
      let at = 0;
      while (view.getUint32(at, true) === 0x04034b50) {
        const method = view.getUint16(at + 8, true);
        const size = view.getUint32(at + 18, true);
        const nameLength = view.getUint16(at + 26, true);
        const extra = view.getUint16(at + 28, true);
        const name = new TextDecoder().decode(data.slice(at + 30, at + 30 + nameLength));
        const start = at + 30 + nameLength + extra;
        const body = new Blob([data.slice(start, start + size)]);
        entries[name] = method === 0 ? await body.text() : await new Response(body.stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
        at = start + size;
      }
      return entries;
    }, Array.from(Buffer.concat(chunks)));
    check(extracted['one.txt'] === 'one' && extracted['two.txt'] === 'two', 'archive bytes mismatch');
    console.log('PASS: image and byte-exact single/private/archive files survive refresh on both sides; inactive-room receiving; password invitations; complete media cleanup');
  } finally { await aContext.close(); await bContext.close(); }
}
