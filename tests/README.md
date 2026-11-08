# Regression checks

Run the input-method checks with `node --test tests/input-composition.test.cjs`.

For end-to-end checks, build with `npm run build`, then run `npx wrangler dev --local --port 8787` in a separate terminal. These tests use only a local preview, never the deployed site.

With Playwright CLI installed (or using the Codex Playwright skill wrapper):

```sh
playwright-cli open http://127.0.0.1:8787/
playwright-cli run-code --filename tests/browser-session.js
playwright-cli run-code --filename tests/browser-history-storage.js
playwright-cli run-code --filename tests/browser-storage-fallback.js
playwright-cli run-code --filename tests/browser-media.js
playwright-cli run-code --filename tests/browser-lifecycle.js
```

The session test checks real public/private delivery and refresh. The storage test verifies removal of legacy plaintext records, encrypted recovery without age/count limits, and manual clearing. The media test compares downloaded bytes after refresh, including private files and ZIP archives. The lifecycle test covers explicit exit, back navigation, tab close/reopen, independent tabs and multiple rooms. The fallback test blocks storage and checks a mobile viewport; create `output/playwright` for its screenshot.

These simulate browser input events and mobile layout, not a physical phone keyboard. Test IME behavior on the target phone after deployment.
