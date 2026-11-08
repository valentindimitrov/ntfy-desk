# <img src="public/icon/48.png" alt="" width="40" height="40" style="vertical-align: middle;"> ntfy Desk

A browser extension for [ntfy](https://ntfy.sh): send notifications to your topics, and receive them as desktop notifications with a message list per topic. Works with ntfy.sh and self-hosted servers. Chrome, Edge, Vivaldi and other Chromium browsers, and Firefox (142+).

> [!NOTE]
> This is an unofficial extension and is not affiliated with the ntfy project.

## Features

- **Receive**. Live messages arrive over ntfy's JSON stream. The toolbar icon shows the unread count. When the browser starts, the extension catches up on messages still in the server's cache. High and urgent desktop notifications request to stay visible until dismissed.
- **Notification rules per topic**. Show all, set a minimum priority, or turn desktop notifications off. The inbox still lists the messages. A catch-up with more than five eligible notifications across the inbox shows one summary. Later catch-up adds to an open summary.
- **Clickable notifications**. A click opens the message's link or highlights the message in the extension tab without reloading the composer. A summary opens the topic it covers or All topics when it covers several. Chromium can show up to two buttons for view actions and attachments.
- **Connection state**. The header shows the active connection. The inbox shows reconnects, unreachable servers, send-only topics and failed fetches.
- **Received messages**. The inbox shows full messages, topic filters, unread counts, search and per-topic deletion sync. Links open in a new tab, Markdown is rendered, and images hosted on your server can be previewed.
- **Send and receive on one page**. The toolbar popup and wide extension tab put the inbox on the left and the Send form on the right. Select **Send notification** to collapse it into a slim rail on the right. Enable **Remember collapsed/expanded state of section Send notification** in Settings to reopen it as you left it. The Send form follows the selected inbox topic. Choose **All topics** to pick a different destination.
- **Send**. Add a title, message, priority, tags and attachments. In the attachment window, tab to **Browse for files** and press Enter or Space. The queue accepts up to 100 files, with a 20 MiB limit per file and 50 MiB total. Right-click image sends also have a 20 MiB limit. You can keep editing while a send finishes, and one composer window can send at a time. Files removed before upload are skipped. New files and uploads without confirmation stay available in the queue. ZIPs rename duplicate entries so each file can be extracted. If the server or selected topic changes in another view or through browser sync, reopen ntfy Desk and check the destination before sending.
- **Context menu**: right-click to send the page, selected text, an image or a link.
- **Tab title and URL**: with "Fill in the current tab", the page's title is put in the Title field and its URL in the Message field.
- **Resizable panes**. Drag the dividers on either side of the inbox, or focus a divider and use the arrow keys. The toolbar popup and browser tab remember their pane widths separately. Select **Freeze dividers between sections All topics, Inbox, and Send notification** in Settings to lock them in both views.
- **Open in a tab**. Open ntfy Desk in its own browser tab to use the full viewport.
- **Keyboard**. Right Ctrl + Enter sends when focus is in the expanded Send form.
- **Dark mode**. See the [privacy policy](PRIVACY.md) for data and permissions.

## Install

Published versions, extension ZIPs and matching source archives are available on [GitHub Releases](https://github.com/valentindimitrov/ntfy-desk/releases) when a release is published. For preview builds, use the `ntfy-desk` artifact on a successful [CI run](https://github.com/valentindimitrov/ntfy-desk/actions/workflows/ci.yml). Downloading a CI artifact requires signing in to GitHub with access to the repository.

- **Chromium**. Download and extract the `-chrome.zip` file. Open the browser's extensions page, turn on **Developer mode**, then choose **Load unpacked** and select the folder containing `manifest.json`.
- **Firefox 142 or later**. For a permanent installation, use a signed add-on when one becomes available. The Firefox ZIP from GitHub is for [temporary testing](#load-a-local-build). [Firefox signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

## Setup

In the settings (gear icon):

Use an HTTPS server and a topic with access controls for sensitive messages. Anyone who can read a public topic can receive what you send to it. Start with a harmless test message. [ntfy quick start](https://docs.ntfy.sh/)

1. **Server URL**. Use `https://ntfy.sh` or your own server. Choose **Save server settings** to commit the URLs and credentials together. The back arrow asks before discarding unsaved changes to those fields. Both URL fields accept a valid HTTP(S) address or an empty value. Username and password in the URL move into local fields. Query strings and fragments are discarded.
2. **Fallback URL** (optional). Use another address of the same server, such as its public address when the main address is on your LAN. Receiving checks for the main server's return every minute. Sending chooses the reachable address before publishing. If the response goes missing, the composer keeps the draft and asks you to check the inbox before retrying. Right-click sends show a `?` on the toolbar when delivery is uncertain.
3. **Access Token**, or **Username and password**. Enter credentials in these fields so they are stored on this device only. The extension uses them only with server origins approved on this device. A server URL changed through browser sync requires confirmation before requests to it use your credentials. The settings warn if an `http://` connection would send credentials unencrypted.
4. **Allow access to this server** appears when credentials or deletion sync are configured and host access is missing. Access lets the extension send authenticated requests and read replay headers that the browser may otherwise hide. This applies to both sites when you use a fallback URL.
5. **Topics**: enter names of up to 64 letters, digits, dashes or underscores. The extension receives from the topics your credentials can read. Topics with write-only access appear as send only.
6. **Topic settings** lists message sync and desktop notification rules for each topic. Choose **Apply** to save both columns together. **Keep received messages** is the default and keeps deletes on this device. **Sync server deletions** checks saved messages against deletion events still available in ntfy's cache and follows future deletion events. Switching to an unrelated server preserves the previous server's history. Delete and Delete all request server deletion only for the messages the inbox indicated would also be deleted on the server, while the same server is still configured and deletion sync remains enabled. The local copy is removed even if the server denies deletion or the extension skips it or cannot confirm it. In those cases the inbox shows a warning. [ntfy deletion API](https://docs.ntfy.sh/publish/#deleting-notifications)
7. **Fill in the current tab**: puts the page's title in the Title field and its URL in the Message field (from the context menu, the page URL becomes the title). In the extension's own tab, **Use tab** fills in the page you were on last (it asks once for permission to read tabs).

### Receiving and the browser

The extension subscribes with ntfy's JSON stream (`/<topics>/json`), which sends the credentials in the `Authorization` header like every other request, never in the URL. (A WebSocket can't carry headers, so it would need them in the URL, where browser error lists and proxy access logs keep them.)

Chrome stops an idle extension service worker after 30 seconds, and data arriving on the stream doesn't count as activity, so the extension makes a small extension API call every 20 seconds while subscribed. If nothing arrives for 2½ minutes (ntfy sends a keepalive every 45 seconds by default), it reconnects. Missed messages are also polled once a minute. A large catch-up can omit cached events when it reaches the extension's limits or ntfy truncates the response. The inbox shows a warning for the affected topics. [ntfy replay limits](https://docs.ntfy.sh/subscribe/api/#replay-limits)

Behind a reverse proxy, turn off response buffering for ntfy (nginx: `proxy_buffering off;`, as ntfy's docs recommend), or live messages only arrive with the next poll.

## Development

Built with [WXT](https://wxt.dev) and TypeScript. [ARCHITECTURE.md](ARCHITECTURE.md) describes how the extension works and why. Unit tests use [Vitest](https://vitest.dev) with WXT's fake browser; end-to-end tests use [Playwright](https://playwright.dev) with the built extension and a test ntfy server; [Vite+](https://viteplus.dev) lints and formats.

Use Node.js **24** and pnpm **12.14.0**, as in CI. For a reproducible build, start from the tag or source ZIP matching the extension package and install from the lockfile.

```bash
pnpm install --frozen-lockfile
pnpm dev            # Chrome with hot reload (pnpm dev:firefox for Firefox)
pnpm check          # format check, lint with type checking (Vite+), unit tests (Vitest)
pnpm test:e2e       # isolated .output/chrome-mv3-e2e build and Playwright tests
pnpm browse         # build, then open the extension in playwright-cli
pnpm build          # .output/chrome-mv3, load it unpacked
pnpm zip            # .output/ntfy-desk-<version>-chrome.zip (pnpm zip:firefox)
pnpm lint:firefox   # build and run Mozilla's add-on checks
```

For end-to-end tests, install the browser once with `pnpm exec playwright install chromium`. On a clean Linux runner, use `pnpm exec playwright install --with-deps chromium`. The interactive `pnpm browse` command uses the separate `playwright-cli` tool and its own browser install (`playwright-cli install-browser chromium`).

### Load a local build

- **Chromium**. Run `pnpm build` and load `.output/chrome-mv3` from the browser's extensions page.
- **Firefox**. Run `pnpm build:firefox`. Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `.output/firefox-mv3/manifest.json`. You can also select the Firefox ZIP. The temporary installation lasts until Firefox restarts.

`pnpm zip` produces the Chromium ZIP. `pnpm zip:firefox` produces the Firefox ZIP and a matching sources ZIP for review and distribution. The release workflow publishes these three files together. For Mozilla submission, provide the sources ZIP and the Firefox build instructions above. [Mozilla source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)

Code layout:

- `entrypoints/background.ts`: listeners of the service worker.
- `entrypoints/popup/`: the popup (also the page opened in a tab): `send.ts`, `receive.ts`, `settings.ts`.
- `entrypoints/filepicker/`: the window for picking files (the popup closes when a file dialog opens).
- `utils/`: ntfy API (`ntfy.ts`), receiving (`receiver.ts`, `history.ts`), notifications and badge, context menu, ZIP.
- `tests/unit/` contains the Vitest suite and a fake ntfy server that follows ntfy v2.29's `since=` semantics.
- `tests/e2e/` contains the Playwright suite and its HTTP test ntfy server.
- `scripts/browse.ts` opens the extension in an interactive browser via `pnpm browse`.

## Credits

ntfy Desk is based on:

- [Send to ntfy](https://github.com/TheDuffman85/send_to_ntfy_extension) by TheDuffman85: the sending extension (popup, context menu, attachments, ZIP).
- [Ntfy-for-chrome](https://github.com/paulhybryant/Ntfy-for-chrome) by paulhybryant: receiving (WebSocket, message list, unread badge, desktop notifications).

Both are GPL-3.0, and so is ntfy Desk.

## License

[GNU General Public License v3.0](LICENSE). The bundled Roboto fonts use Apache-2.0. See the [license notices](NOTICE.md) for attribution and license files.
