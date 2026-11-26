**ntfy Desk** is a client for [ntfy](https://ntfy.sh), the open-source notification service. It sends notifications to your topics and receives them in Firefox. It works with ntfy.sh and with self-hosted ntfy servers. You need a ntfy server and a topic: ntfy Desk does not provide one. It requires Firefox 142 or later; it also runs in Chrome, Edge, Vivaldi and other Chromium browsers 116 or later.

ntfy Desk is an independent, unofficial add-on. It is not affiliated with or endorsed by the ntfy project.

**Receive**

- Live messages from your topics as desktop notifications, with the unread count on the toolbar icon.
- An inbox with a message list per topic, topic filters, unread counts and search.
- A rule per topic: notify for every message, only from a priority you choose, or not at all. The inbox lists the messages either way.
- When Firefox starts, messages that arrived while it was closed are fetched from the server's message cache, within ntfy's replay limits and the inbox's per-topic limit. A topic's first sync fetches the last 24 hours without notifying.
- Markdown, links, and previews of images hosted on your ntfy server.
- Click a notification to open the message's link, or the message in ntfy Desk.

**Send**

- Title, message, priority, tags and file attachments. Several files can go as one ZIP.
- Optional click URL, Markdown formatting and delayed delivery.
- A starting priority and tags for each topic.
- Right-click a page, a selection, an image or a link to send it to a topic.
- A keyboard shortcut that sends the current page. It has no key until you choose one in **Manage Extension Shortcuts**.

**Your server, your data**

- ntfy Desk connects to the ntfy server you configure and, if you set one, a fallback address of that server. There is no analytics, no advertising and no service run by the developer.
- Your access token, or username and password, stay on this device. They are not synced, and they are sent only in the Authorization header to servers you approved on this device.
- Settings can be exported to a file and imported in another browser. The file holds no token, password or messages.

**Also**

- Use it from the toolbar popup or in a full browser tab, with resizable panes.
- Light and dark themes, or follow the system.
- Optional deletion sync per topic.

**Permissions and data**

Firefox lists authentication information, personal communications, browsing activity and website content when you install ntfy Desk. They cover the connection to your ntfy server and what you choose to send: your credentials go to your server, your messages are personal communications, and a page's title, URL, selected text or image is sent only when you send it. Access to websites is optional and requested only after a click: for your ntfy server and its fallback address together when you use credentials or deletion sync, and for the site of an image you send from the right-click menu. Reading your open tabs is optional too: "Use tab" in the add-on's own tab asks for it. Once granted, that tab reads the title and URL of the web page you used last when it opens and when you return to it, and fills them in when "Fill in the current tab" is on or you choose "Use tab".

Use an HTTPS server and a topic with access control for anything sensitive: anyone who can read a public topic receives what is sent to it.

Open source under GPL-3.0. Source code and issue tracker: https://github.com/valentindimitrov/ntfy-desk
