# ntfy Desk privacy policy

ntfy Desk sends and receives notifications through the ntfy server you configure. The developer collects no data: it has no analytics, advertising, or developer-operated service, and nothing is sent to the developer. The data flows below go to services you choose or use: your ntfy server, sites you send images from, and your browser's sync service.

## What leaves your browser

- **Your ntfy server.** ntfy Desk uses the configured server and optional fallback to check access, subscribe to topics, and fetch missed messages in the background. Requests that need authentication send your token or username and password in the Authorization header to server origins you approve on this device.
- **Content you send.** Sending a notification transfers its topic, title, message, priority, tags and attachments to the selected ntfy server, and the options you set under **More options**: a click URL, the Markdown format and a delivery delay. A delivery time such as "tomorrow 9am" also sends your browser's time zone name (for example Europe/Berlin), so the server delivers it at your local time. If you use tab prefill or a right-click command, a notification can include a page title, URL, selected text, link text or image. Use HTTPS and access-controlled topics for sensitive content. Your server operator controls server logs, retention and who can read your topics. [ntfy topic access](https://docs.ntfy.sh/config/#access-control)
- **Sites you interact with.** Sending an image from a page may request access to its site and download the image for the notification. Clicking links opens their destinations in your browser. Image previews in the inbox load from the ntfy server's attachment route.
- **Browser sync.** If your browser syncs extension preferences, it can sync server addresses, topic names and preferences through its sync service. The addresses are stored without embedded credentials.
- **Settings files you export.** **Export settings** saves a file to your downloads with your server addresses, topic names and preferences. It is created in the browser and sent nowhere. It contains no token, username, password or messages. Topic names can be enough to read a topic on a server without access control, so share the file with that in mind. Importing a file reads it in the browser; your stored credentials are not sent to a server from an imported file until you confirm it in Settings.

## What stays in extension storage

The browser stores credentials and approved server origins, received history and read state, drafts, queued attachments, and pane layout on this device. The inbox keeps up to 100 messages per topic (50 to 500, as set in Settings) within its total history size limit. Drafts and queued attachments clear when the browser starts. A confirmed send clears the sent draft or attachments, while edits or new files added during the send stay available.

You can clear saved credentials in Settings and remove messages from the inbox. **Sync server deletions** also requests deletion on your ntfy server when enabled for the topic and allowed by the server. To remove remaining local extension data, remove the extension from the browser. Data held by your browser's sync service or ntfy server is subject to that service's controls.

## Browser permissions

ntfy Desk uses browser storage for settings and messages, alarms to reconnect and catch up, and notifications for desktop alerts. The context menu and access to the active tab provide the page content you choose to send: the toolbar popup reads the active tab's title and URL when it opens, to fill them in when **Fill in the current tab** is on or you choose **Use tab**. Optional tab access is requested by **Use tab** in the extension's own tab. Once granted, that page reads the title and URL of the web page you used last when it opens and when you return to it, and fills them in when **Fill in the current tab** is on or you choose **Use tab**; they leave the browser only if you send them. Optional site access supports authenticated ntfy connections, deletion replay and image downloads. ntfy Desk doesn't run in private windows, so nothing from private browsing is stored.

Firefox's installation disclosure lists authentication information, personal communications, browsing activity and website content. These categories cover the ntfy connection and what you choose to send. Website content and page details are sent through the relevant Send or right-click action.

For privacy questions, use the [ntfy Desk issue tracker](https://github.com/valentindimitrov/ntfy-desk/issues). Keep credentials, private topic names and notification contents out of public reports.
