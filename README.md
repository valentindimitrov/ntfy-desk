# <img src="public/icon/48.png" alt="" width="40" height="40" style="vertical-align: middle;"> ntfy Desk

A browser extension for [ntfy](https://ntfy.sh): send notifications to your topics, and receive them as desktop notifications with a message list per topic. Works with ntfy.sh and self-hosted servers. Chrome, Edge, Vivaldi and other Chromium browsers, and Firefox (142+).

> [!NOTE]
> This is an unofficial extension and is not affiliated with the ntfy project.

## Features

- **Receive**. Live messages arrive over ntfy's JSON stream. The toolbar icon shows the unread count. When the browser starts, the extension catches up on messages still in the server's cache. High and urgent desktop notifications request to stay visible until dismissed.
- **Notification rules per topic**: all, from a priority up, or off; the messages are still listed.
- **Clickable notifications**. A click opens the message's link or highlights the message in the extension tab. Chromium can show up to two buttons for view actions and attachments.
- **Connection state**. The header shows the active connection. The inbox shows reconnects, unreachable servers, send-only topics and failed fetches.
- **Received messages**. The inbox shows full messages, topic filters, unread counts, search and per-topic deletion sync. Links open in a new tab, Markdown is rendered, and images hosted on your server can be previewed.
- **Send and receive on one page**. The toolbar popup and wide extension tab put the inbox on the left and the Send form on the right. Select **Send notification** to collapse it into a slim rail on the right. Enable **Remember collapsed/expanded state of section Send notification** in Settings to reopen it as you left it. The Send form follows the selected inbox topic. Choose **All topics** to pick a different destination.
- **Send**: title, message, priority, tags, and one or more file attachments, sent separately or as one ZIP.
- **Context menu**: right-click to send the page, selected text, an image or a link.
- **Tab title and URL**: with "Fill in the current tab", the page's title is put in the Title field and its URL in the Message field.
- **Resizable panes**. Drag the dividers on either side of the inbox, or focus a divider and use the arrow keys. The toolbar popup and browser tab remember their pane widths separately. Select **Freeze dividers between sections All topics, Inbox, and Send notification** in Settings to lock them in both views.
- **Open in a tab**. Open ntfy Desk in its own browser tab to use the full viewport.
- **Keyboard**. Right Ctrl + Enter sends when focus is in the expanded Send form.
- **Dark mode**, and no tracking.

## Install

The current build version is **1.0.0**. Install from a local build or a CI build artifact.

1. From this checkout, run `pnpm install`. Then run `pnpm build` for Chromium or `pnpm zip:firefox` for Firefox. Successful CI runs also upload both ZIPs as the `ntfy-desk` artifact.
2. **Chromium**. Open the browser's extensions page, turn on Developer mode, and choose **Load unpacked**. Select `.output/chrome-mv3` or the extracted Chromium ZIP folder.
3. **Firefox**. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the Firefox ZIP. This installation lasts until Firefox restarts.

## Setup

In the settings (gear icon):

1. **Server URL**: `https://ntfy.sh`, or your own server. Settings keep the last saved addresses until both URL fields are empty or contain valid HTTP(S) URLs. Credentials in a valid URL move into the local username and password fields.
2. **Fallback URL** (optional): another address of the same server, e.g. the public URL when the main one is a LAN address. Receiving switches to it while the main server doesn't answer (checked every minute) and back when it returns; sending retries on it when the main server gives no response.
3. **Access Token**, or **Username and password**. Enter credentials in these fields so they are stored on this device only. The extension uses them only with server origins approved on this device. A server URL changed through browser sync requires confirmation before requests to it use your credentials. The settings warn if an `http://` connection would send credentials unencrypted.
4. **Allow access to this server**: appears when a token or credentials are set. ntfy's CORS headers don't allow the `Authorization` header, so the extension needs permission for the server's site (both sites, with a fallback URL) to send authenticated requests.
5. **Topics**: the topics to send to and receive from. The extension receives from the topics your credentials can read; a topic you can only send to is used for sending only.
6. **Topic settings** lists message sync and desktop notification rules for each topic. Choose **Apply** to save both columns together. **Keep received messages** is the default and keeps deletes on this device. Enabling **Sync server deletions** checks the configured server's saved messages against deletion events still available in ntfy's cache and follows future deletion events. Switching to an unrelated server preserves the previous server's history. Delete and Delete all also request deletion of the corresponding sequence on the server. If the server denies the request or the extension cannot confirm it, the local copy is removed and the inbox shows a warning. [ntfy deletion API](https://docs.ntfy.sh/publish/#deleting-notifications)
7. **Fill in the current tab**: puts the page's title in the Title field and its URL in the Message field (from the context menu, the page URL becomes the title). In the extension's own tab, **Use tab** fills in the page you were on last (it asks once for permission to read tabs).

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
pnpm lint:firefox   # build and run Mozilla's add-on checks
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
