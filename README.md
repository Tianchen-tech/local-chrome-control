# Local Chrome Control / 本地 Chrome 控制

A Chrome extension and local Native Messaging/MCP companion for controlling explicitly authorized tabs from Codex.

**Publication preparation, not yet available in Chrome Web Store.** The first public version supports macOS only and requires Node.js 22.22.2 or later, a separately installed native companion, and a compatible MCP client such as Codex. Installing only the browser extension is insufficient. Windows and Linux are not supported by this installer.

Publisher: Tianchen Shen · Public support: world8866171@gmail.com

- [Installation and troubleshooting](https://tianchen-tech.github.io/local-chrome-control/setup.html)
- [Privacy policy](https://tianchen-tech.github.io/local-chrome-control/privacy.html)
- [Release readiness and reviewer instructions](RELEASE.md)

## Features

Read main-frame DOM snapshots, fill ordinary forms, click, select, scroll and take screenshots of tabs you authorize in the popup. Task leases, snapshot references and request IDs help avoid competing control and accidental duplicate writes. Stop in the popup at any time. Cross-origin navigation and closing a tab revoke authorization.

No arbitrary JavaScript execution, cookie/history export, password entry, file upload or CAPTCHA bypass. Complex iframes and shadow-root controls are not supported. This is an independent project, not an official Google or OpenAI product. No claim of universal compatibility or superior reliability is made.

## Developer / publisher setup

1. Run `npm run package:store`. The ZIP contains the browser extension with manifest.json at its root.
2. Register as a Chrome Web Store developer and upload the ZIP as a draft. This does not publish it.
3. In the dashboard's Package tab, copy the public key into a local text file. Do not use a private key.
4. Run `node scripts/bind-store-key.mjs PUBLIC_KEY_FILE STORE_ITEM_ID` in this release repository. It verifies that the public key produces the exact dashboard item ID. No Chrome configuration changes occur.
5. Commit the bound public manifest and create a companion release archive. Only then is the native companion ready for customer installation.
6. Test a clean macOS installation with the store-assigned ID before submitting for review.

The repository initially has no extension key. Native installation fails closed until the publisher binds the store identity. Do not run the development project's prepare script in this release copy: it can generate a different identity.

## Customer installation (after a bound release exists)

Download the tagged companion release and keep it in a stable directory. Install supported Node.js, then run:

```sh
node scripts/install.mjs
node scripts/install.mjs --install
```

The first command previews changes; the second installs the Native Messaging host for the current macOS user's Google Chrome. Add an MCP stdio server to your client using the absolute Node executable and the absolute path to `server/mcp.mjs` printed by the preview. Follow `skills/control-local-chrome/SKILL.md` for authorization, leases and write recovery.

Install the published browser extension, open a test page, click the extension and choose **允许控制此标签页**. Validate a real snapshot, harmless fill/click and screenshot. Seeing a connection alone is insufficient.

To remove the native host, run `node scripts/install.mjs --uninstall` from the same companion directory, then remove the Chrome extension and MCP entry in their settings. Existing development installs using the same host name may conflict: the installer refuses to overwrite a different origin. Do not delete another installation blindly.
