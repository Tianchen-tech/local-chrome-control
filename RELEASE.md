> This is the 0.3.1 developer preview (macOS and Windows), with a fixed development public key. The checklist below is historical 0.1.1 Chrome Web Store preparation; it does not certify or publish this preview. Store identity binding and clean installation remain required for a future store release.

# Chrome Web Store publication checklist — 0.1.1

Approved choices: Tianchen Shen; world8866171@gmail.com; free extension; Public searchable listing; all supported distribution regions; GitHub repository and GitHub Pages for public documentation.

## Completed preparation

- Separate browser-only ZIP; root manifest; no local absolute paths, developer key or server inside the browser upload.
- macOS companion source and public-key/ID binding tool, with installation blocked while the key is absent.
- Public privacy, setup and support documents; permission justifications and listing draft.
- Installed development copy remains unchanged.

## Still required before submission

- Developer registration, fee payment, email verification and any dashboard-required account security steps by the account owner.
- Draft ZIP upload to obtain the actual item ID and public key.
- Bind that identity, create a tagged companion release and replace the setup-page pending-release notice with a working download link.
- Validate a clean macOS user/profile setup with the bound extension and companion. Do not count existing developer-profile tests as this check.
- Required store imagery: 128px icon, 440×280 small promotional image, and at least one compliant 1280×800 (or permitted 640×400) real screenshot. Icon and small promotional image are prepared; final real screenshots still need preparation.
- Verify all public links and the listing's actual fields; developer personally reviews data-use disclosures/certifications and submits.

## Reviewer instructions

No website account is required for an ordinary synthetic test. macOS, Node.js ≥22.22.2 and a compatible MCP client are required. The extension does not operate until the local companion is installed and a tab is authorized in its popup. Provide a tagged, store-ID-bound download before submission; an unbound source checkout is not an installation-ready companion.

On a harmless HTTPS page or local HTML fixture, authorize the tab; MCP sessions_list → choose session → tabs_list → tab_claim → page_snapshot. Fill a non-sensitive field and click a harmless button using fresh snapshot refs and unique request IDs. Verify with a new snapshot or screenshot. Stop in popup and confirm subsequent actions fail. Release the lease afterwards. Never use credentials, financial transactions or third-party access-control bypass as a review test.

Current source was exercised in local development tests and a controlled comparison. This release copy has not yet passed a clean installation using the store identity. Public marketing must not claim that the controlled comparison establishes long-term or universal superiority over another extension.
