// Background service worker: context menu, receiving, desktop notifications and the unread badge.
// Listeners are registered synchronously at startup, as MV3 requires.

import { browser } from 'wxt/browser';
import { handleContextMenuClick, updateContextMenu } from '@/utils/context-menu';
import { handleNotificationButton, handleNotificationClick, notifyNewMessage, updateUnreadBadge } from '@/utils/notifications';
import { createReceiver } from '@/utils/receiver';

const ALARM_NAME = 'ws-keepalive';

export default defineBackground(() => {
  const receiver = createReceiver({
    onNewMessage: message => void notifyNewMessage(message),
    onConnected: () => void updateUnreadBadge(),
  });

  // Whenever the service worker starts (browser start, install, or woken by any event)
  void receiver.connect();

  function setUp(): void {
    void updateContextMenu();
    // Reconnects and polls once a minute, also after the service worker was stopped
    void browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }

  browser.runtime.onInstalled.addListener(setUp);
  browser.runtime.onStartup.addListener(setUp);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.topics || changes.apiUrl)) {
      void updateContextMenu();
      void receiver.connect();
    }
    if (area === 'local') {
      if (changes.accessToken) {
        void receiver.connect();
      }
      if (changes.receivedNotifications || changes.readMessageIds || changes.deletedMessageIds) {
        void updateUnreadBadge();
      }
    }
  });

  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM_NAME) {
      void receiver.connect();
      void receiver.sync();
    }
  });

  browser.contextMenus.onClicked.addListener((info, tab) => void handleContextMenuClick(info, tab));
  browser.notifications.onButtonClicked.addListener((id, index) => void handleNotificationButton(id, index));
  browser.notifications.onClicked.addListener(id => void handleNotificationClick(id));

  // The popup asks for a sync when it opens and when the Receive tab is shown
  browser.runtime.onMessage.addListener((request: unknown, _sender, sendResponse) => {
    if ((request as { action?: string } | null)?.action === 'sync') {
      receiver
        .sync()
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    return undefined;
  });
});
