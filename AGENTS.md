# ntfy Desk: notes for agents

Browser extension (WXT 0.21, TypeScript, MV3 for Chrome and Firefox) to send and receive ntfy notifications. User-facing docs: `README.md`.

## Commands

- `pnpm check`: type check (`tsc --noEmit`, strict with `noUncheckedIndexedAccess`) and Vitest. Run it before every commit.
- `pnpm build` / `pnpm build:firefox`: `.output/chrome-mv3`, `.output/firefox-mv3`.
- `pnpm zip` / `pnpm zip:firefox`: the release zips.
- `pnpm dev`: opens a browser with hot reload. The owner loads `.output/chrome-mv3` unpacked in Vivaldi on the laptop.

## Conventions

- Extension APIs: `import { browser, type Browser } from 'wxt/browser'`, promise style only (Firefox's `browser` has no callbacks). Types come from `@types/chrome`; methods with a callback overload need `mockResolved` from `tests/helpers/mock.ts` in tests.
- Enums in the types (`contextMenus.ContextType`, `runtime.ContextType`) are passed as their string values, cast to the enum type: the enum objects don't exist at runtime in every browser.
- Storage: settings in `storage.sync`; the access token and everything else (received messages, read and deleted ids, per-topic sync state, attachments, draft) in `storage.local`. Never put the token in `storage.sync`.
- Never log a WebSocket URL with `?auth=`, or an error or event object that contains it; `buildWsUrl` returns a `logUrl` for logging.
- Messages from the server are rendered with `textContent` only; URLs from messages are opened or copied only if `isHttpUrl`.
- Tests: `tests/*.test.ts`. `tests/helpers/fake-ntfy.ts` is a fake ntfy server (fetch) and WebSocket; popup tests load the real `index.html` in happy-dom.

## Behaviour that is easy to break

- ntfy rejects a multi-topic WebSocket with 403 if any topic isn't readable: the receiver checks `/<topic>/auth` and subscribes to readable topics only.
- Each topic's sync cursor is a server time (`since=<unix time>`, inclusive) plus the latest ids; never a global `since=<id>` (ids are global across topics, and an expired id replays the whole cache).
- A topic's first sync is silent; afterwards a desktop notification is shown only for messages new to the history.
- The 20 s client keepalive keeps Chrome's service worker alive (ntfy's default keepalive is 45 s; Chrome's idle limit is 30 s).

## Roadmap

Update the status here when an item lands. Each item comes with tests.

| # | Improvement | Status |
|---|---|---|
| 1 | History: a limit per topic instead of 50 across all topics; prune the read and deleted id lists | Done: 100 per topic; the popup prunes the id lists |
| 2 | Connection state in the Receive tab: connected, reconnecting, server unreachable, topics without read access, sync errors | Done: `utils/status.ts`, written by the receiver to storage.session |
| 3 | Per-topic desktop notification rules: all, from a priority up, or off (the topic stays listed) | Done: `utils/rules.ts`, set in the settings, 🔕 in the topic list |
| 4 | Clickable notifications: the message's `click` URL, or the message in the extension's tab; `view` actions as buttons. `http` and `broadcast` actions stay out (they would make the browser send requests the publisher chose). | Done: `notificationButtons`, `handleNotificationClick`, `utils/extension-tab.ts`; no buttons in Firefox (unsupported) |
| 5 | Fallback server URL (e.g. LAN first, the public URL when it doesn't answer) for receiving and sending | Planned |
| 6 | Receive tab: search, image attachment previews (attachments on the ntfy server only), Markdown messages rendered safely (no `innerHTML`) | Planned |
| 7 | Run-test the Firefox build in Firefox | Not started: only `web-ext lint` so far |
