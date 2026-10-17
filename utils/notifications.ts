// Desktop notifications for received messages, and the unread count on the toolbar icon.

import { browser, type Browser } from 'wxt/browser';
import { countUnread, getHistoryState } from './history';
import { isHttpUrl, type NtfyMessage } from './ntfy';
import { getTopicRules, shouldNotify } from './rules';

const PRIORITY_LABELS: Record<number, string> = {
  1: '⇊ Min',
  2: '↓ Low',
  4: '↑ High',
  5: '⇈ Urgent',
};

export function showDesktopNotification(message: NtfyMessage): void {
  const label = message.priority ? PRIORITY_LABELS[message.priority] : undefined;
  const options: Browser.notifications.NotificationCreateOptions = {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: (message.title || 'Notification') + (label ? ` [${label}]` : ''),
    message: message.message || '',
    contextMessage: `Topic: ${message.topic}`,
    // High and urgent messages stay until dismissed
    requireInteraction: (message.priority ?? 3) >= 4,
  };
  if (message.attachment && isHttpUrl(message.attachment.url)) {
    options.buttons = [{ title: '🔗 Open Attachment' }];
  }
  void browser.notifications.create(message.id, options);
}

/** A desktop notification for a new message, if its topic's rule allows it */
export async function notifyNewMessage(message: NtfyMessage): Promise<void> {
  if (shouldNotify(message, await getTopicRules())) {
    showDesktopNotification(message);
  }
}

/** "Open Attachment" button: open the attachment of that message, http(s) only */
export async function handleNotificationButton(notificationId: string, buttonIndex: number): Promise<void> {
  if (buttonIndex !== 0) return;
  const { receivedNotifications } = await getHistoryState();
  const url = receivedNotifications.find(n => n.id === notificationId)?.attachment?.url;
  if (isHttpUrl(url)) {
    await browser.tabs.create({ url });
  }
}

export async function updateUnreadBadge(): Promise<void> {
  const unread = countUnread(await getHistoryState());
  await browser.action.setBadgeText({ text: unread > 0 ? unread.toString() : '' });
  if (unread > 0) {
    await browser.action.setBadgeBackgroundColor({ color: '#f44336' });
  }
}

/** A short ✓ or ✗ after a context-menu send, then the unread count again */
export function showSendResult(success: boolean): void {
  void browser.action.setBadgeText({ text: success ? '✓' : '✗' });
  void browser.action.setBadgeBackgroundColor({ color: success ? '#4CAF50' : '#f44336' });
  setTimeout(() => void updateUnreadBadge(), 2000);
}
