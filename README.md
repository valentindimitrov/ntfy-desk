# <img src="public/icon/48.png" alt="" width="40" height="40" style="vertical-align: middle;"> ntfy Desk

A browser extension for [ntfy](https://ntfy.sh): send notifications to your topics, and receive them as desktop notifications with a message list per topic. Works with ntfy.sh and self-hosted servers. Chrome, Edge, Vivaldi and other Chromium browsers (116+), and Firefox (142+).

> [!NOTE]
> This is an unofficial extension and is not affiliated with the ntfy project.

## Features

- **Receive**: live messages over a WebSocket, as desktop notifications, with an unread count on the icon. Messages published while the browser was closed are fetched when it starts. High and urgent priority notifications stay until dismissed.
- **Notification rules per topic**: all, from a priority up, or off; the messages are still listed.
- **Clickable notifications**: a click opens the message's link, or the message in the extension's tab; `view` actions become buttons.
- **Connection state**: the Receive tab shows whether it's connected, reconnecting or can't reach the server, topics you can only send to, and failed fetches.
- **Received messages**: the Receive tab lists the messages of all topics, with a topic list on the left (unread counts per topic), mark as read and delete (kept locally).
- **Send**: title, message, priority, tags, and one or more file attachments, sent separately or as one ZIP.
- **Context menu**: right-click to send the page, selected text, an image or a link.
- **Tab URL as title**: with "Include current tab's URL", the page's URL is put in the Title field.
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
3. **Access Token**: if your server needs one. It is stored locally and isn't copied to other browsers by browser sync. Credentials in the server URL (`https://user:password@host`) work too.
4. **Allow access to this server**: appears when a token or credentials are set. ntfy's CORS headers don't allow the `Authorization` header, so the extension needs permission for the server's site (both sites, with a fallback URL) to send authenticated requests.
5. **Topics**: the topics to send to and receive from. The extension receives from the topics your credentials can read; a topic you can only send to is used for sending only.
6. **Include current tab's URL**: puts the page URL in the message title. In the extension's own tab, **Use tab URL** fills in the page you were on last (it asks once for permission to read tabs).

### Receiving and the browser

Chrome stops an idle extension service worker after 30 seconds; WebSocket traffic keeps it running (Chrome 116+). ntfy's keepalive is 45 seconds by default, so the extension sends a small frame every 20 seconds. Missed messages are also polled once a minute.

Browsers can't set headers on a WebSocket, so the credentials go in ntfy's `?auth=` query parameter. The extension never logs that URL, but the browser itself logs failed WebSocket connections with the full URL (e.g. on the extensions page's Errors list). Don't share screenshots of those errors.

## Development

Built with [WXT](https://wxt.dev) and TypeScript; tests use [Vitest](https://vitest.dev) with WXT's fake browser.

```bash
pnpm install
pnpm dev            # Chrome with hot reload (pnpm dev:firefox for Firefox)
pnpm check          # type check + tests
pnpm build          # .output/chrome-mv3, load it unpacked
pnpm zip            # .output/ntfy-desk-<version>-chrome.zip (pnpm zip:firefox)
```

Code layout:

- `entrypoints/background.ts`: listeners of the service worker.
- `entrypoints/popup/`: the popup (also the page opened in a tab): `send.ts`, `receive.ts`, `settings.ts`.
- `entrypoints/filepicker/`: the window for picking files (the popup closes when a file dialog opens).
- `utils/`: ntfy API (`ntfy.ts`), receiving (`receiver.ts`, `history.ts`), notifications and badge, context menu, ZIP.
- `tests/`: Vitest tests, including a fake ntfy server that follows ntfy v2.29's `since=` semantics.

## Credits

ntfy Desk is based on:

- [Send to ntfy](https://github.com/TheDuffman85/send_to_ntfy_extension) by TheDuffman85: the sending extension (popup, context menu, attachments, ZIP).
- [Ntfy-for-chrome](https://github.com/paulhybryant/Ntfy-for-chrome) by paulhybryant: receiving (WebSocket, message list, unread badge, desktop notifications).

Both are GPL-3.0, and so is ntfy Desk.

## License

[GNU General Public License v3.0](LICENSE)
