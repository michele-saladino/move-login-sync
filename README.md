# Move Login Sync

A Chrome extension (Manifest V3) that keeps **cookies** and **localStorage** aligned across a **group of domains**, so logging in on one site logs you in on the others.

Core logic is TypeScript (`src/core`, `src/background`, `src/content`); the menu UI is Vue 3 (`src/popup`).

> ⚠️ Syncing cookies shares logged-in sessions between sites. Only use it with sites you control or trust.

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
3. Pin the extension and click its icon: the menu floats over the current page as a transparent, blurred glass panel (Esc, ✕, clicking the page or the icon again closes it).

## Usage

Click the icon to open the menu. On pages Chrome doesn't let extensions touch (`chrome://…`, the Web Store) it opens the same UI in a small window instead.

1. **+ New group** creates a group (rename it by clicking its name).
2. Inside the group:
   - **+ Add current site** adds the site of the tab you are on (`www.` is dropped; subdomains are always included).
   - The text field adds any other URL or domain manually.
3. Chrome asks for access to each domain you add. Grant it — a site without access shows a **Grant access** button and will not sync.
4. Once a group has two or more sites, all of them are kept aligned (cookies and localStorage, both ways, between every pair).
5. **☆ Star** a site to make it the source of truth: it is mirrored to all the other sites immediately (and on every later change), and changes on the other sites are no longer written back. Unstar it to return to two-way alignment. Starring replaces the group's remembered localStorage with the starred site's, so stale values from the other sites don't come back.
6. The toggle pauses a group; 🗑 deletes it. **Options** lets you turn cookies / localStorage off and restrict them with name filters such as `session*, token` (empty = everything).
7. **⇄** next to a site copies everything that site has *right now* to the other sites of the group (useful when you are already logged in on one and want to align the rest immediately). The localStorage part needs an open tab on that site.

Rules: a domain can belong to one group only, and domains can't be nested (`a.com` and `app.a.com`) since subdomains are already covered.

## How it works

```
 cookies.onChanged ──► background service worker ──► chrome.cookies.set / remove on every other domain of the group

 tab on A ─ content script ─┐                            ┌─ content script ─ tab on B / C …
   (diffs localStorage)     ├─► background ◄─ shared ────┤   (applies changes)
                            │   (chrome.storage.local, per group)
```

### Cookies (`src/core/cookies.ts`)

- The background worker listens to `chrome.cookies.onChanged`. When a cookie on a group domain is set or explicitly deleted, it is mirrored to every other domain of the group with the same name, value, path, flags, `SameSite` and expiry.
- The domain suffix is rewritten, so `.app.a.com` becomes `.app.b.com`. Host-only cookies stay host-only.
- **Loop prevention:** a cookie is only written if the target already holds an identical one, so the echo events from our own writes do nothing.
- Only explicit deletions are mirrored; the "overwrite" event Chrome fires while updating a cookie is ignored.

### localStorage (`src/core/storageSync.ts`, `src/content/index.ts`)

localStorage belongs to a single origin and can only be read from a page, so:

- A **content script** is registered dynamically for the domains of active groups (no `<all_urls>` at install time). It snapshots `localStorage`, diffs it (on the `storage` event, on tab visibility changes and every second) and reports changes to the background worker.
- The background worker remembers the last value of every key per group in `chrome.storage.local` (deletions are kept as tombstones) and forwards changes to all open tabs of the group's *other* domains, which apply them.
- When a tab loads it sends its full state and receives whatever it is missing, so a tab opened later catches up even if no other tab of the group is open.
- Writes made by the extension are not reported back and unchanged values are dropped, so there are no echo loops.

### The overlay menu (`src/background/overlay.ts`)

A browser-action popup can't be transparent, so the icon injects (via `activeTab`) an `<iframe>` of `popup.html` floating over the page. The blur and tint are applied to the iframe *element* — `backdrop-filter` inside an iframe cannot see the page behind it — and the iframe document itself is transparent. The iframe reports its content height so the panel fits it.

### Permissions

`cookies`, `storage`, `scripting`, `activeTab` (to inject the overlay into the tab you clicked on), plus **optional** host permissions requested per domain when you add it. If Chrome closes the popup while showing its permission prompt, the background worker notices the grant and starts syncing anyway.

## Security note

`popup.html` has to be web-accessible so it can be shown over pages, which means a hostile page could embed it and try to trick you into clicking. Adding a domain to a group does nothing until Chrome's own permission prompt for that domain is accepted — read that prompt, and never allow a domain you don't recognise.

## Limitations

- Same-tab localStorage changes are detected by polling (about 1 s), because a content script cannot hook the page's own `setItem`.
- Conflicts resolve as last-write-wins. When a tab loads, the remembered value wins over that tab's own value for the same key.
- A site may still reject a copied session if it is bound to its own domain, IP or user agent.
- Cookies in other Chrome profiles or incognito are not touched.

## Project layout

```
public/manifest.json         extension manifest
popup.html, src/popup/       Vue menu UI (groups, domains, options)
src/background/index.ts      service worker: message routing, content-script registration, icon click
src/background/overlay.ts    injected function that floats the menu over the page
src/content/index.ts         localStorage watcher/applier (built as a standalone IIFE)
src/core/                    types, matching helpers, cookie + localStorage sync, config/log
vite.config.ts               builds popup + background
vite.content.config.ts       builds content.js
```
