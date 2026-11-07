# ntfy Desk: notes for agents

Browser extension (WXT 0.21, TypeScript, MV3 for Chrome and Firefox) to send and receive ntfy notifications. User-facing docs: `README.md`. How it works and why (receiving, storage, security model, why not WebSockets): `ARCHITECTURE.md`; update it when the design changes.

## Commands

- `pnpm check`: format check, lint with type checking, and Vitest. Run it before every commit; `pnpm fmt` fixes formatting.
- Lint and format come from Vite+ (`vp lint`, `vp fmt`; settings in `vite.config.ts`, used only by Vite+). Oxlint runs with type-aware rules and the full type check (`typeCheck`), strict with `noUncheckedIndexedAccess`; warnings fail. `pnpm compile` runs `tsc --noEmit` on its own. Markdown isn't formatted.
- `pnpm build` / `pnpm build:firefox`: `.output/chrome-mv3`, `.output/firefox-mv3`.
- `pnpm zip` / `pnpm zip:firefox`: the release zips.
- `pnpm lint:firefox`: builds for Firefox, then runs Mozilla's add-on checks (`web-ext lint`); CI runs them too.
- CI (`.github/workflows/ci.yml`): read-only token by default, write access only in the release job; actions pinned to commit SHAs with the version in a comment, updated by Dependabot (`.github/dependabot.yml`). Keep new actions pinned the same way.
- `pnpm dev`: opens a browser with hot reload. The owner loads `.output/chrome-mv3` unpacked in Vivaldi on the laptop.
- `pnpm test:e2e`: builds, then runs `e2e/` with Playwright Test: the built extension in Playwright's Chromium against `e2e/ntfy-server.ts`, a real HTTP test server with ntfy's JSON stream for subscriptions (it takes credentials in the Authorization header only). One test at a time (several Chromiums at once time out). CI runs it too. Not covered: Firefox, and Chrome's host-permission prompt (the test server allows `Authorization` in CORS; the unit tests cover that path).
- `pnpm browse [--headed]`: builds, then opens the extension's page in `playwright-cli` (mise tool) and prints the extension id. Then drive it with `playwright-cli snapshot`, `click <ref>`, `fill <ref> <text>`, `screenshot`, `close`; output lands in `.playwright-cli/`. Use it to look at UI changes in the real extension rather than a mocked page. `playwright-cli` needs its own Chromium build: `playwright-cli install-browser chromium`.

## Conventions

- Extension APIs: `import { browser, type Browser } from 'wxt/browser'`, promise style only (Firefox's `browser` has no callbacks). Types come from `@types/chrome`; methods with a callback overload need `mockResolved` from `tests/helpers/mock.ts` in tests.
- Enums in the types (`contextMenus.ContextType`, `runtime.ContextType`) are passed as their string values, cast to the enum type: the enum objects don't exist at runtime in every browser.
- Storage: settings in `storage.sync`; the access token and everything else (received messages, read and deleted ids, per-topic sync state, attachments, draft) in `storage.local`. The username and password (`serverCredentials`) are local too. Never put the token or credentials in `storage.sync`: server URLs are synced without user:password@, and `getConfig` moves credentials found in a synced URL to `storage.local`. Never put credentials in a tab's address ("Open in ntfy" strips them). Strip credentials from a URL with the URL parser (`splitCredentials`), never by slicing the string.
- The token and password are bound to the server origins approved on this device (`authOrigins` in `storage.local`): saving server URLs in this browser's settings approves them; a URL changed elsewhere (browser sync) gets no credentials until the user confirms in the settings. `getConfig` enforces it (`heldBackFrom`, empty token and credentials), so requests take their authentication from `getConfig`; `getStoredAuth` is for the settings form only. Authenticated requests refuse redirects (`redirect: 'error'`).
- The background is the only writer of the received messages, the read and deleted ids and the sync state, through one queue (`serialized` in `utils/history.ts`). The popup sends read and delete actions as messages (`utils/messages.ts`); it never saves those lists itself.
- Data keyed by topic is stored as a list (`[topic, value]` entries, or objects with a `topic` field) and read into a `Map`: topic names such as `__proto__` and `constructor` are valid in ntfy and break plain objects.
- Every request has a time limit (`TIMEOUTS` in `utils/ntfy.ts`); `isNoResponse` treats network errors and time limits alike (the fallback server is tried on both).
- Header values are RFC 2047-encoded when they contain anything outside printable ASCII, including line breaks.
- Live messages come from ntfy's JSON stream (`openMessageStream`, GET `/<topics>/json`), not a WebSocket: a WebSocket can't carry headers, so it would need the credentials in the URL (`?auth=`), where browser error lists and proxy access logs record them. Never put credentials in a URL.
- Everything from the server is untrusted: messages go through `parseMessage` / `parseMessageJson` (types checked, unknown fields dropped) before they are stored, and again when the history is read. Limits include `MAX_MESSAGE_JSON` per event, `MAX_POLL_BYTES` per poll response, `MAX_POLL_EVENTS` per poll, and `MAX_HISTORY_PER_TOPIC` and `MAX_HISTORY_SIZE` for stored messages. Only messages of subscribed or polled topics are stored. The stream is read one chunk at a time, after the lines before it are stored, so a flooding server is slowed down rather than queued. The Receive tab renders each message on its own (`renderMessageSafely`).
- Messages from the server are rendered with `textContent` only (Markdown through `utils/markdown.ts`, which builds nodes; bare URLs through its `linkify`); URLs from messages are opened, linked or copied only if `isHttpUrl`; images are previewed only from the ntfy server's own origin.
- Desktop notifications get buttons for a message's `view` actions only (`notificationButtons`); `http` and `broadcast` actions stay out, since they would make the browser send requests the publisher chose. Firefox shows no notification buttons.
- Unit tests: `tests/*.test.ts` (Vitest). `tests/helpers/fake-ntfy.ts` is a fake ntfy server (fetch, with `FakeStream` for subscriptions: accept, refuse, deliver, end); popup tests load the real `index.html` in happy-dom. End-to-end tests: `e2e/*.spec.ts`; the fixtures in `e2e/fixtures.ts` give the service worker (`serviceWorker.evaluate` runs in it), `configure`, `notified` (desktop notifications recorded in the worker) and `openPopup`.

## Behaviour that is easy to break

- ntfy rejects a multi-topic subscription with 403 if any topic isn't readable: the receiver checks `/<topic>/auth` and subscribes to readable topics only.
- Each topic's sync state is a catch-up watermark (`since=<unix time>`, inclusive) plus the id and time of every message at or after it; never a global `since=<id>` (ids are global across topics, and an expired id replays the whole cache).
- Only a completed poll moves the watermark, never a live message: a live message newer than messages missed while disconnected must not let the next poll skip them. The sync state and the history are written in one storage write.
- Deletion sync is opt-in per topic (`syncDeletionTopics`). The background applies ntfy's `message_delete` events from the stream and poll by sequence ID and topic. Preserve replay order for events in the same second so a later publish can revive a sequence. Popup deletes on opted-in topics also request deletion from the configured server when the message's origin is known or can be verified. Use `getConfig` for credentials and let ntfy enforce write access.
- History is ordered by server time before the per-topic limit applies; a connect() that an await made stale (settings changed meanwhile) stops; a subscription refused before it opened discards the cached read-access check.
- Image previews only load the server's attachment route (`/file/<name>`, no query): other same-origin URLs can be API calls (ntfy publishes on GET).
- A topic's first sync is silent; afterwards a desktop notification is shown only for messages new to the history.
- Chrome stops an idle service worker after 30 s, and data arriving on a fetch stream doesn't count as activity (tested: stopped after ~30 s with data every 20 s), but an extension API call does: the receiver calls `runtime.getPlatformInfo` every 20 s while subscribed (tested: alive for 8+ minutes). A stream has no close event when the connection dies silently, so it is given up after `STREAM_IDLE_TIMEOUT` without data (ntfy's keepalive is 45 s by default).

## Roadmap

Open items; remove a row when it lands (the design goes to `ARCHITECTURE.md` if it matters). Each item comes with tests.

| # | Improvement | Status |
|---|---|---|
| 7 | Run-test the Firefox build in Firefox | Open: `web-ext lint` passes; `web-ext run` can't attach while another Firefox instance is running. Close Firefox, then `pnpm dev:firefox` |
| 8 | Releases: set up the release pipeline once testing (#7) is complete | TODO: no releases yet; don't tag or publish one. `ci.yml` already has a `release` job (on a `v*` tag, publishes the zips), untried |

## Skills

User-only skills (they don't load by themselves); `review-agent-context` keeps this list. Read a skill's `SKILL.md` when its line applies.

- Not needed here: `web-perf` (a browser extension; Core Web Vitals don't apply).
