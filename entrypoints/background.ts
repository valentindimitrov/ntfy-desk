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
import { RECEIVER_ALARM, createReceiverAlarm, ensureReceiverAlarm } from '@/utils/schedule';
import { addPickedFiles } from '@/utils/stored-files';
import { SYNC_DELETION_TOPICS_KEY, getSyncDeletionTopics, parseSyncDeletionTopics } from '@/utils/sync-modes';

/**
 * Runs a task nobody waits for. A failure (a storage or notification API error) is logged as a warning
 * instead of an "Uncaught (in promise)" error on the browser's extension page.
 */
function background(task: Promise<unknown>, what: string): void {
  task.catch(() => console.warn(`Could not ${what}`));
}

export default defineBackground(() => {
  const receiver = createReceiver({
    onNewMessage: (message) => background(notifyNewMessage(message), 'show a notification'),
    onCatchUp: (messages) => background(notifyCatchUp(messages), 'show catch-up notifications'),
    onConnected: () => background(updateUnreadBadge(), 'update the unread badge'),
    onRemoved: (ids) => background(clearNotifications(ids), 'dismiss notifications'),
  });
  const connect = () => background(receiver.connect(), 'connect to the server');

  // Whenever the service worker starts (browser start, install, or woken by any event)
  connect();

  function setUp(): void {
    background(updateContextMenu(), 'update the context menu');
    // Reconnects and polls once a minute, also after the service worker was stopped
    background(createReceiverAlarm(), 'schedule the receiver');
  }

  // Also at every start: a browser can drop the alarm without an install or startup event
  background(ensureReceiverAlarm(setUp), 'check the receiver schedule');

  browser.runtime.onInstalled.addListener(setUp);
  browser.runtime.onStartup.addListener(() => {
    background(clearComposerOnStartup(), 'reset the composer on browser startup');
    setUp();
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.topics || changes.apiUrl || changes.fallbackUrl)) {
      background(updateContextMenu(), 'update the context menu');
      connect();
    }
    const deletionModes = changes[SYNC_DELETION_TOPICS_KEY];
    if (area === 'sync' && deletionModes) {
      const before = parseSyncDeletionTopics(deletionModes.oldValue);
      const enabled = [...parseSyncDeletionTopics(deletionModes.newValue)].filter((topic) => !before.has(topic));
      if (enabled.length > 0) background(receiver.replayDeletions(enabled), 'replay deletions');
    }
    // The badge can leave out topics whose desktop notifications are off
    if (area === 'sync' && (changes.badgeScope || changes[NOTIFY_RULES_KEY])) background(updateUnreadBadge(), 'update the unread badge');
    // A lower "Messages kept per topic" trims the stored history at once, through the history's queue
    if (area === 'sync' && changes.historyPerTopic) {
      background(applyHistoryLimit().then(clearNotifications), 'apply the history limit');
    }
    if (area === 'local') {
      if (changes.accessToken || changes[CREDENTIALS_KEY] || changes[AUTH_ORIGINS_KEY]) {
        connect();
      }
      if (changes.receivedNotifications || changes.readMessageIds || changes.deletedMessageIds) {
        background(updateUnreadBadge(), 'update the unread badge');
      }
    }
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECEIVER_ALARM) {
      connect();
      background(receiver.sync(), 'catch up on missed messages');
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

  browser.contextMenus.onClicked.addListener((info, tab) => background(handleContextMenuClick(info, tab), 'send from the context menu'));
  browser.commands.onCommand.addListener((command, tab) => background(handleCommand(command, tab), 'run the keyboard shortcut'));
  browser.notifications.onButtonClicked.addListener((id, index) =>
    background(handleNotificationButton(id, index), 'open the notification button'),
  );
  browser.notifications.onClicked.addListener((id) => background(handleNotificationClick(id), 'open the notification'));
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
