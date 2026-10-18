# <img src="public/icon/48.png" alt="" width="40" height="40" style="vertical-align: middle;"> ntfy Desk

A browser extension for [ntfy](https://ntfy.sh): send notifications to your topics, and receive them as desktop notifications with a message list per topic. Works with ntfy.sh and self-hosted servers. Chrome, Edge, Vivaldi and other Chromium browsers, and Firefox (142+).

> [!NOTE]
> This is an unofficial extension and is not affiliated with the ntfy project.

## Features

- **Receive**: live messages over ntfy's JSON stream, as desktop notifications, with an unread count on the icon. Messages published while the browser was closed are fetched when it starts. High and urgent priority notifications stay until dismissed.
- **Notification rules per topic**: all, from a priority up, or off; the messages are still listed.
- **Clickable notifications**: a click opens the message's link, or the message in the extension's tab; `view` actions become buttons.
- **Connection state**: the Receive tab shows whether it's connected, reconnecting or can't reach the server, topics you can only send to, and failed fetches.
- **Received messages**: the Receive tab lists the messages of all topics, with a topic list on the left (unread counts per topic), search, mark as read and delete (kept locally). Links in messages open in a new tab, Markdown messages are rendered, and image attachments hosted on your server are previewed.
- **Send**: title, message, priority, tags, and one or more file attachments, sent separately or as one ZIP.
- **Context menu**: right-click to send the page, selected text, an image or a link.
- **Tab title and URL**: with "Fill in the current tab", the page's title is put in the Title field and its URL in the Message field.
- **Open in a tab**: the extension also opens as a page in its own browser tab, for a larger view.
- **Keyboard**: Right Ctrl + Enter sends.
- **Dark mode**, and no tracking.

## Install

ntfy Desk isn't in the extension stores yet.

1. Download the latest `ntfy-desk-*-chrome.zip` (or `-firefox.zip`) from [Releases](https://github.com/valentindimitrov/ntfy-desk/releases), or build it yourself (below).
2. Chrome/Vivaldi/Edge: unzip it, open the extensions page (`chrome://extensions`, `vivaldi://extensions`), turn on Developer mode, and **Load unpacked** the unzipped folder.
   Firefox: open `about:debugging#/runtime/this-firefox` and **Load Temporary Add-on**, choosing the zip.

## Setup

In the settings (gear icon):

1. **Server URL**: `https://ntfy.sh`, or your own server.
2. **Fallback URL** (optional): another address of the same server, e.g. the public URL when the main one is a LAN address. Receiving switches to it while the main server doesn't answer (checked every minute) and back when it returns; sending retries on it when the main server gives no response.
3. **Access Token**, or **Username and password**: if your server needs them. Both are stored on this device only and aren't copied to other browsers by browser sync. Credentials typed into a server URL (`https://user:password@host`) move to the username and password fields; the URL is synced without them.
   They are used only with the server addresses saved in this browser's settings. If the server URL changes elsewhere (browser sync from another browser), the settings say so, and nothing is sent to the new address until you confirm it. With an `http://` address the settings warn you: the token or password would go over the network unencrypted.
4. **Allow access to this server**: appears when a token or credentials are set. ntfy's CORS headers don't allow the `Authorization` header, so the extension needs permission for the server's site (both sites, with a fallback URL) to send authenticated requests.
5. **Topics**: the topics to send to and receive from. The extension receives from the topics your credentials can read; a topic you can only send to is used for sending only.
6. **Fill in the current tab**: puts the page's title in the Title field and its URL in the Message field (from the context menu, the page URL becomes the title). In the extension's own tab, **Use tab** fills in the page you were on last (it asks once for permission to read tabs).

### Receiving and the browser

The extension subscribes with ntfy's JSON stream (`/<topics>/json`), which sends the credentials in the `Authorization` header like every other request, never in the URL. (A WebSocket can't carry headers, so it would need them in the URL, where browser error lists and proxy access logs keep them.)

Chrome stops an idle extension service worker after 30 seconds, and data arriving on the stream doesn't count as activity, so the extension makes a small extension API call every 20 seconds while subscribed. If nothing arrives for 2½ minutes (ntfy sends a keepalive every 45 seconds by default), it reconnects. Missed messages are also polled once a minute.

Behind a reverse proxy, turn off response buffering for ntfy (nginx: `proxy_buffering off;`, as ntfy's docs recommend), or live messages only arrive with the next poll.

## Development

Built with [WXT](https://wxt.dev) and TypeScript. [ARCHITECTURE.md](ARCHITECTURE.md) describes how the extension works and why. Unit tests use [Vitest](https://vitest.dev) with WXT's fake browser; end-to-end tests use [Playwright](https://playwright.dev) with the built extension and a test ntfy server; [Vite+](https://viteplus.dev) lints and formats.

```bash
pnpm install
pnpm dev            # Chrome with hot reload (pnpm dev:firefox for Firefox)
pnpm check          # format check, lint with type checking (Vite+), unit tests (Vitest)
pnpm test:e2e       # build, then end-to-end tests (Playwright, Chromium)
pnpm browse         # build, then open the extension in playwright-cli
pnpm build          # .output/chrome-mv3, load it unpacked
pnpm zip            # .output/ntfy-desk-<version>-chrome.zip (pnpm zip:firefox)
```

Code layout:

- `entrypoints/background.ts`: listeners of the service worker.
- `entrypoints/popup/`: the popup (also the page opened in a tab): `send.ts`, `receive.ts`, `settings.ts`.
- `entrypoints/filepicker/`: the window for picking files (the popup closes when a file dialog opens).
- `utils/`: ntfy API (`ntfy.ts`), receiving (`receiver.ts`, `history.ts`), notifications and badge, context menu, ZIP.
- `tests/`: Vitest tests, including a fake ntfy server that follows ntfy v2.29's `since=` semantics.
- `e2e/`: Playwright tests and the test ntfy server; `scripts/browse.ts`: `pnpm browse`.

## Credits

ntfy Desk is based on:

- [Send to ntfy](https://github.com/TheDuffman85/send_to_ntfy_extension) by TheDuffman85: the sending extension (popup, context menu, attachments, ZIP).
- [Ntfy-for-chrome](https://github.com/paulhybryant/Ntfy-for-chrome) by paulhybryant: receiving (WebSocket, message list, unread badge, desktop notifications).

Both are GPL-3.0, and so is ntfy Desk.

## License

[GNU General Public License v3.0](LICENSE)
