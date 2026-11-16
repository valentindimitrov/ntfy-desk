# ntfy Desk privacy policy

ntfy Desk sends and receives notifications through the ntfy server you configure. It has no analytics, advertising, or developer-operated service.

## What leaves your browser

- **Your ntfy server.** ntfy Desk uses the configured server and optional fallback to check access, subscribe to topics, and fetch missed messages in the background. Requests that need authentication send your token or username and password in the Authorization header to server origins you approve on this device.
- **Content you send.** Sending a notification transfers its topic, title, message, priority, tags and attachments to the selected ntfy server. If you use tab prefill or a right-click command, a notification can include a page title, URL, selected text, link text or image. Use HTTPS and access-controlled topics for sensitive content. Your server operator controls server logs, retention and who can read your topics. [ntfy topic access](https://docs.ntfy.sh/config/#access-control)
- **Sites you interact with.** Sending an image from a page may request access to its site and download the image for the notification. Clicking links opens their destinations in your browser. Image previews in the inbox load from the ntfy server's attachment route.
- **Browser sync.** If your browser syncs extension preferences, it can sync server addresses, topic names and preferences through its sync service. The addresses are stored without embedded credentials.
- **Settings files you export.** **Export settings** saves a file to your downloads with your server addresses, topic names and preferences. It is created in the browser and sent nowhere. It contains no token, username, password or messages. Topic names can be enough to read a topic on a server without access control, so share the file with that in mind. Importing a file reads it in the browser; your stored credentials are not sent to a server from an imported file until you confirm it in Settings.

## What stays in extension storage

The browser stores credentials and approved server origins, received history and read state, drafts, queued attachments, and pane layout on this device. The inbox keeps up to 100 messages per topic (50 to 500, as set in Settings) within its total history size limit. Drafts and queued attachments clear when the browser starts. A confirmed send clears the sent draft or attachments, while edits or new files added during the send stay available.

You can clear saved credentials in Settings and remove messages from the inbox. **Sync server deletions** also requests deletion on your ntfy server when enabled for the topic and allowed by the server. To remove remaining local extension data, remove the extension from the browser. Data held by your browser's sync service or ntfy server is subject to that service's controls.

## Browser permissions

ntfy Desk uses browser storage for settings and messages, alarms to reconnect and catch up, and notifications for desktop alerts. The context menu and access to the active tab provide the page content you choose to send. Optional tab access supports **Use tab** in the extension page, and optional site access supports authenticated ntfy connections, deletion replay and image downloads.

Firefox's installation disclosure lists authentication information, personal communications, browsing activity and website content. These categories cover the ntfy connection and what you choose to send. Website content and page details are sent through the relevant Send or right-click action.

For privacy questions, use the [ntfy Desk issue tracker](https://github.com/valentindimitrov/ntfy-desk/issues). Keep credentials, private topic names and notification contents out of public reports.
