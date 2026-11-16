// Background service worker: context menu, keyboard commands, receiving, desktop notifications and
// the unread badge.
// Listeners are registered synchronously at startup, as MV3 requires.

import { browser } from 'wxt/browser';
import { handleCommand } from '@/utils/commands';
import { handleContextMenuClick, updateContextMenu } from '@/utils/context-menu';
import { applyHistoryLimit } from '@/utils/history';
import {
  clearNotifications,
  handleNotificationButton,
  handleNotificationClick,
  notifyCatchUp,
  notifyNewMessage,
  updateUnreadBadge,
} from '@/utils/notifications';
import { clearComposerOnStartup, handlePopupRequest } from '@/utils/messages';
import { AUTH_ORIGINS_KEY, CREDENTIALS_KEY, getConfig, serverPermissionPattern } from '@/utils/ntfy';
import { createReceiver } from '@/utils/receiver';
import { NOTIFY_RULES_KEY } from '@/utils/rules';
import { addPickedFiles } from '@/utils/stored-files';
import { SYNC_DELETION_TOPICS_KEY, getSyncDeletionTopics, parseSyncDeletionTopics } from '@/utils/sync-modes';

const ALARM_NAME = 'receiver';

export default defineBackground(() => {
  const receiver = createReceiver({
    onNewMessage: (message) => void notifyNewMessage(message),
    onCatchUp: (messages) => void notifyCatchUp(messages).catch(() => console.warn('Could not show catch-up notifications')),
    onConnected: () => void updateUnreadBadge(),
    onRemoved: (ids) => void clearNotifications(ids),
  });

  // Whenever the service worker starts (browser start, install, or woken by any event)
  void receiver.connect();

  function setUp(): void {
    void updateContextMenu();
    // Reconnects and polls once a minute, also after the service worker was stopped
    void browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }

  browser.runtime.onInstalled.addListener(setUp);
  browser.runtime.onStartup.addListener(() => {
    void clearComposerOnStartup().catch(() => console.error('Could not reset the composer on browser startup'));
    setUp();
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.topics || changes.apiUrl || changes.fallbackUrl)) {
      void updateContextMenu();
      void receiver.connect();
    }
    const deletionModes = changes[SYNC_DELETION_TOPICS_KEY];
    if (area === 'sync' && deletionModes) {
      const before = parseSyncDeletionTopics(deletionModes.oldValue);
      const enabled = [...parseSyncDeletionTopics(deletionModes.newValue)].filter((topic) => !before.has(topic));
      if (enabled.length > 0) void receiver.replayDeletions(enabled);
    }
    // The badge can leave out topics whose desktop notifications are off
    if (area === 'sync' && (changes.badgeScope || changes[NOTIFY_RULES_KEY])) void updateUnreadBadge();
    // A lower "Messages kept per topic" trims the stored history at once, through the history's queue
    if (area === 'sync' && changes.historyPerTopic) {
      void applyHistoryLimit()
        .then(clearNotifications)
        .catch(() => console.warn('Could not apply the history limit'));
    }
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

  browser.permissions.onAdded.addListener(({ origins }) => {
    if (!origins?.length) return;
    void (async () => {
      const { apiUrl, fallbackUrl, topics } = await getConfig();
      if (![apiUrl, fallbackUrl].some((url) => origins.includes(serverPermissionPattern(url) ?? ''))) return;
      const enabled = await getSyncDeletionTopics();
      await receiver.replayDeletions(topics.filter((topic) => enabled.has(topic)));
    })().catch(() => console.warn('Could not recheck deletion sync after granting server access'));
  });

  browser.contextMenus.onClicked.addListener((info, tab) => void handleContextMenuClick(info, tab));
  browser.commands.onCommand.addListener((command, tab) => void handleCommand(command, tab));
  browser.notifications.onButtonClicked.addListener((id, index) => void handleNotificationButton(id, index));
  browser.notifications.onClicked.addListener((id) => void handleNotificationClick(id));
  if (import.meta.env.MODE === 'e2e') {
    Object.assign(globalThis, {
      __ntfyClickNotification: handleNotificationClick,
      __ntfyAddPickedFiles: addPickedFiles,
      __ntfyRunCommand: handleCommand,
    });
  }

  // From the popup: a sync (when it opens, and on the Receive tab), and read and delete actions
  browser.runtime.onMessage.addListener((request: unknown, _sender, sendResponse) => {
    const task = handlePopupRequest(request, () => receiver.sync());
    if (!task) return undefined;
    task.then((deletion) => sendResponse({ success: true, deletion })).catch(() => sendResponse({ success: false }));
    return true;
  });
});
