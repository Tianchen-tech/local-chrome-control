# Local Chrome Control 0.3.1 — reviewer instructions

Chrome Web Store item: `mppejcndepnklbbjjjdgbobmjfhhddfe`.
The publisher has saved a draft. This candidate has not been submitted, approved or published in the store.

## Requirements and download

Use Chrome 125+, Node.js 22.22.2+, macOS or Windows, and a local MCP client capable of invoking STDIO tools. No website account, website credentials, subscription or paid model API is required to test the MCP tools directly. The extension requires a separately installed local Native Messaging companion; installing only the extension will not provide control.

- [Companion ZIP](https://github.com/Tianchen-tech/local-chrome-control/releases/download/v0.3.1-store.1/local-chrome-control-0.3.1-store-companion.zip)
- [Release and SHA-256](https://github.com/Tianchen-tech/local-chrome-control/releases/tag/v0.3.1-store.1)
- [Setup and migration](https://tianchen-tech.github.io/local-chrome-control/setup.html)
- [Privacy disclosure](https://tianchen-tech.github.io/local-chrome-control/privacy.html)
- Support: world8866171@gmail.com

## Install the matching companion

1. Extract the companion to a stable local directory. Open a terminal in that directory. No `npm install` is needed to run it.
2. macOS: run `node scripts/prepare.mjs`, then `node scripts/install.mjs` to preview. Windows: run `node scripts/windows-setup.mjs` to preview. Check that `allowed_extension` is exactly `chrome-extension://mppejcndepnklbbjjjdgbobmjfhhddfe/`.
3. macOS: run `node scripts/install.mjs --install`. Windows: run `node scripts/windows-setup.mjs --install`. The installer registers this user's host and refuses to overwrite another installation. If using the developer preview, uninstall its registration from its original directory first. Its extension ID is different.
4. Configure your local MCP client using the absolute Node executable and `server/mcp.mjs` path printed by the preview. The generated `.mcp.json` contains those local paths.
5. Test the browser extension attached to this store item. Before store availability, the extracted `extension` folder can be loaded in an isolated test Chrome profile via `chrome://extensions` → Developer mode → Load unpacked. Its public key gives the same store ID. Loading unpacked does not prove installation from the store.

## Consent and synthetic acceptance

1. Run `node scripts/fixture-modes.mjs` in another terminal. It serves synthetic pages on loopback ports 19320/19321. No real account, payment, outgoing message or external website is involved.
2. Open `http://127.0.0.1:19320/?mode=standard` in the test Chrome profile. In the extension popup, choose Standard mode, read the pre-grant data disclosure and personally click **允许控制此标签页** (Allow control of this tab).
3. Invoke `sessions_list`, then `tabs_list` with the selected `session_id`. The authorized fixture should appear. Use `tab_claim` with that session, the fixture's `tab_id` and a task name; keep the returned `lease_id`.
4. Invoke `page_snapshot` using the session, tab and lease. For a `page_fill` or `page_click`, supply the latest returned `snapshot_id` and element `ref`, plus a unique `request_id`. Fill the ordinary input and rich text; click the counter once. Read a new snapshot after every mutation. The counter must be **1**, and the rich-text event should show trusted browser input. Also inspect open Shadow DOM, the same-origin iframe and menu roles. `page_screenshot` returns a viewport JPEG.
5. Call `tab_release`, then use the popup's Stop control button. The tab must disappear from the authorized list; subsequent control must be rejected.
6. Optional extended-mode test: personally reauthorize the synthetic tab in Extended mode with an empty blacklist. The cross-origin iframe and link to the second fixture site should work within this tab's grant. Other tabs remain unauthorized. A blacklist blocks DOM operations by source; it does not redact iframe pixels in screenshots.
7. Optional read-only test: reauthorize in Read-only mode. Snapshot and screenshot are available, but fill or click must be rejected.

If a write times out, first invoke `request_status` using its request ID and inspect a fresh snapshot. Do not replay an uncertain write. Password input, file upload, arbitrary JavaScript and browser-internal/store pages are intentionally unsupported.

## Verification boundary

The source baseline is `69965e61019be9573fb0046e38e22d5f079441c1`. The candidate binds a public key, adds visible pre-grant disclosure, and packages an extension-only ZIP and matching companion. It preserves the browser code uploaded by the publisher.

Store CI exercises clean per-user registration, repeat installation, the registered native launcher, real local IPC and a real MCP process, using a **simulated Chrome message endpoint**; it also rejects the developer origin and removes the registration. The browser probe separately uses the production BrowserAdapter over real CDP in a disposable profile. These checks are not a full Chrome Store installation test. Developer-preview Windows 11 tests are documented separately and are not counted as store-identity tests. Personal Chrome configurations and final store installation require the manual flow above.
