// Background service worker: context menu, receiving, desktop notifications and the unread badge.
// Listeners are registered synchronously at startup, as MV3 requires.

import { browser } from 'wxt/browser';
import { handleContextMenuClick, updateContextMenu } from '@/utils/context-menu';
import { handleNotificationButton, handleNotificationClick, notifyNewMessage, updateUnreadBadge } from '@/utils/notifications';
import { handlePopupRequest } from '@/utils/messages';
import { AUTH_ORIGINS_KEY, CREDENTIALS_KEY } from '@/utils/ntfy';
import { createReceiver } from '@/utils/receiver';
import { SYNC_DELETION_TOPICS_KEY } from '@/utils/sync-modes';

const ALARM_NAME = 'receiver';
/** The alarm's name while receiving used a WebSocket; cleared on update */
const OLD_ALARM_NAME = 'ws-keepalive';

export default defineBackground(() => {
  const receiver = createReceiver({
    onNewMessage: (message) => void notifyNewMessage(message),
    onConnected: () => void updateUnreadBadge(),
  });

  // Whenever the service worker starts (browser start, install, or woken by any event)
  void receiver.connect();

  function setUp(): void {
    void updateContextMenu();
    // Reconnects and polls once a minute, also after the service worker was stopped
    void browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    void browser.alarms.clear(OLD_ALARM_NAME);
  }

  browser.runtime.onInstalled.addListener(setUp);
  browser.runtime.onStartup.addListener(setUp);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.topics || changes.apiUrl || changes.fallbackUrl)) {
      void updateContextMenu();
      void receiver.connect();
    }
    if (area === 'sync' && changes[SYNC_DELETION_TOPICS_KEY]) void receiver.sync();
    if (area === 'local') {
      if (changes.accessToken || changes[CREDENTIALS_KEY] || changes[AUTH_ORIGINS_KEY]) {
        void receiver.connect();
      }
      if (changes.receivedNotifications || changes.readMessageIds || changes.deletedMessageIds) {
        void updateUnreadBadge();
      }
    }
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      void receiver.connect();
      void receiver.sync();
    }
  });

  browser.contextMenus.onClicked.addListener((info, tab) => void handleContextMenuClick(info, tab));
  browser.notifications.onButtonClicked.addListener((id, index) => void handleNotificationButton(id, index));
  browser.notifications.onClicked.addListener((id) => void handleNotificationClick(id));

  // From the popup: a sync (when it opens, and on the Receive tab), and read and delete actions
  browser.runtime.onMessage.addListener((request: unknown, _sender, sendResponse) => {
    const task = handlePopupRequest(request, () => receiver.sync());
    if (!task) return undefined;
    task.then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
    return true;
  });
});
