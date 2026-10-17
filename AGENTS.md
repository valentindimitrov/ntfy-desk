# ntfy Desk: notes for agents

Browser extension (WXT 0.21, TypeScript, MV3 for Chrome and Firefox) to send and receive ntfy notifications. User-facing docs: `README.md`.

## Commands

- `pnpm check`: format check, lint with type checking, and Vitest. Run it before every commit; `pnpm fmt` fixes formatting.
- Lint and format come from Vite+ (`vp lint`, `vp fmt`; settings in `vite.config.ts`, used only by Vite+). Oxlint runs with type-aware rules and the full type check (`typeCheck`), strict with `noUncheckedIndexedAccess`; warnings fail. `pnpm compile` runs `tsc --noEmit` on its own. Markdown isn't formatted.
- `pnpm build` / `pnpm build:firefox`: `.output/chrome-mv3`, `.output/firefox-mv3`.
- `pnpm zip` / `pnpm zip:firefox`: the release zips.
- `pnpm dev`: opens a browser with hot reload. The owner loads `.output/chrome-mv3` unpacked in Vivaldi on the laptop.
- `pnpm test:e2e`: builds, then runs `e2e/` with Playwright Test: the built extension in Playwright's Chromium against `e2e/ntfy-server.ts`, a real HTTP and WebSocket test server. One test at a time (several Chromiums at once time out). CI runs it too. Not covered: Firefox, and Chrome's host-permission prompt (the test server allows `Authorization` in CORS; the unit tests cover that path).
- `pnpm browse [--headed]`: builds, then opens the extension's page in `playwright-cli` (mise tool) and prints the extension id. Then drive it with `playwright-cli snapshot`, `click <ref>`, `fill <ref> <text>`, `screenshot`, `close`; output lands in `.playwright-cli/`. Use it to look at UI changes in the real extension rather than a mocked page. `playwright-cli` needs its own Chromium build: `playwright-cli install-browser chromium`.

## Conventions

- Extension APIs: `import { browser, type Browser } from 'wxt/browser'`, promise style only (Firefox's `browser` has no callbacks). Types come from `@types/chrome`; methods with a callback overload need `mockResolved` from `tests/helpers/mock.ts` in tests.
- Enums in the types (`contextMenus.ContextType`, `runtime.ContextType`) are passed as their string values, cast to the enum type: the enum objects don't exist at runtime in every browser.
- Storage: settings in `storage.sync`; the access token and everything else (received messages, read and deleted ids, per-topic sync state, attachments, draft) in `storage.local`. Never put the token in `storage.sync`.
- Never log a WebSocket URL with `?auth=`, or an error or event object that contains it; `buildWsUrl` returns a `logUrl` for logging.
- Messages from the server are rendered with `textContent` only (Markdown through `utils/markdown.ts`, which builds nodes); URLs from messages are opened, linked or copied only if `isHttpUrl`; images are previewed only from the ntfy server's own origin.
- Unit tests: `tests/*.test.ts` (Vitest). `tests/helpers/fake-ntfy.ts` is a fake ntfy server (fetch) and WebSocket; popup tests load the real `index.html` in happy-dom. End-to-end tests: `e2e/*.spec.ts`; the fixtures in `e2e/fixtures.ts` give the service worker (`serviceWorker.evaluate` runs in it), `configure`, `notified` (desktop notifications recorded in the worker) and `openPopup`.

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
| 5 | Fallback server URL (e.g. LAN first, the public URL when it doesn't answer) for receiving and sending | Done: `utils/servers.ts` (`/v1/health`; sending retries on network errors only) |
| 6 | Receive tab: search, image attachment previews (attachments on the ntfy server only), Markdown messages rendered safely (no `innerHTML`) | Done: `matchesSearch`, `previewableImage` (receive.ts), `utils/markdown.ts` |
| 7 | Run-test the Firefox build in Firefox | Open: `web-ext lint` passes; `web-ext run` can't attach while another Firefox instance is running. Close Firefox, then `pnpm dev:firefox` |
