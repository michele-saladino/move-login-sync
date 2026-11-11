# Move Login Sync

A Chrome extension (Manifest V3) that keeps **cookies** and **localStorage** in sync between two domains, so logging in on one logs you in on the other.

Core logic is TypeScript (`src/core`, `src/background`, `src/content`); the settings UI is Vue 3 (`src/options`).

> ⚠️ Syncing cookies shares your logged-in session between the two domains. Only use it with sites you control or trust.

## Getting started

Requirements: Node 20+ and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm build        # type-check + build into dist/
pnpm test         # unit tests (vitest)
pnpm dev          # rebuild on change (reload the extension in chrome://extensions after a rebuild)
```

Load it in Chrome:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. Click the extension icon to open the settings page.

## Usage

1. Enter **Domain A** and **Domain B** (e.g. `example.com` and `example.org`). Subdomains are included automatically.
2. Pick a **direction**: both ways, A → B only, or B → A only.
3. Choose what to sync (cookies, localStorage) and optionally restrict it with name filters, e.g. `session*, token`. Empty means everything.
4. Tick **Enabled** and click **Save**. Chrome asks for access to those two domains only — grant it.
5. Reload any tabs of the two domains that were already open.

Use **Copy A → B now** / **Copy B → A now** for a one-time copy of everything that exists today (e.g. you are already logged in on A). The localStorage part needs an open tab on the source domain.

The **Activity** panel lists recent sync events and errors.

## How it works

```
 cookies.onChanged ──► background service worker ──► chrome.cookies.set / remove on the other domain

 tab on A ─ content script ─┐                            ┌─ content script ─ tab on B
   (diffs localStorage)     ├─► background ◄─ shared ────┤   (applies changes)
                            │   (chrome.storage.local)   │
```

### Cookies (`src/core/cookies.ts`)

- The background worker listens to `chrome.cookies.onChanged`. When a cookie on one domain is set or explicitly deleted, it is mirrored on the other domain with the same name, value, path, flags, `SameSite` and expiry.
- The domain suffix is rewritten, so `.app.a.com` becomes `.app.b.com`. Host-only cookies stay host-only.
- **Loop prevention:** a cookie is only written if the target does not already hold an identical one. The echo event from our own write therefore does nothing.
- Only explicit deletions are mirrored; the "overwrite" event Chrome fires while updating a cookie is ignored.

### localStorage (`src/core/storageSync.ts`, `src/content/index.ts`)

localStorage belongs to a single origin and can only be read from a page, so:

- A **content script** is registered dynamically for the two configured domains (no `<all_urls>` at install time). It snapshots `localStorage`, diffs it (on the `storage` event, on tab visibility changes and every second), and reports changes to the background worker.
- The background worker stores the last known value of every key in `chrome.storage.local` (deletions are kept as tombstones) and forwards changes to all open tabs of the *other* domain, which apply them.
- When a tab loads it sends its full state and receives whatever it is missing. This is why a tab opened later catches up even when no tab of the other domain is open.
- Writes made by the extension are not reported back, and unchanged values are dropped, so there are no echo loops.

### Permissions

`cookies`, `storage`, `scripting`, plus **optional** host permissions requested at save time for exactly the two domains you enter.

## Limitations

- Same-tab localStorage changes are detected by polling (about 1 s), because a content script cannot hook the page's own `setItem`.
- Conflicts resolve as last-write-wins. When a tab loads, the remembered value wins over that tab's own value for the same key.
- `HttpOnly`/`Secure` cookies are mirrored, but a site may still reject a session that is bound to its own domain, IP or user agent.
- Cookies in other Chrome profiles or incognito are not touched.
- Changing the domain pair clears the remembered localStorage state.

## Project layout

```
public/manifest.json         extension manifest
options.html, src/options/   Vue settings UI
src/background/index.ts      service worker: message routing, content-script registration
src/content/index.ts         localStorage watcher/applier (built as a standalone IIFE)
src/core/                    types, matching helpers, cookie + localStorage sync, config/log
vite.config.ts               builds options page + background
vite.content.config.ts       builds content.js
```
