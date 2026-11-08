// Desktop notifications for received messages, and the unread count on the toolbar icon.

import { browser, type Browser } from 'wxt/browser';
import { countUnread, getHistoryState } from './history';
import { openExtensionTab } from './extension-tab';
import { markdownToText } from './markdown';
import { isHttpUrl, type NtfyMessage } from './ntfy';
import { getTopicRules, shouldNotify } from './rules';

const PRIORITY_LABELS: Record<number, string> = {
  1: '⇊ Min',
  2: '↓ Low',
  4: '↑ High',
  5: '⇈ Urgent',
};
const CATCH_UP_PREFIX = 'catch-up:';
const CATCH_UP_ID = 'catch-up-summary';
const CATCH_UP_KEY = 'catchUpSummary';
const MAX_INDIVIDUAL_CATCH_UP = 5;

interface CatchUpSummary {
  count: number;
  topic: string | null;
  urgent: boolean;
}

let summaryQueue: Promise<unknown> = Promise.resolve();

function updateSummary<T>(task: () => Promise<T>): Promise<T> {
  const result = summaryQueue.then(task);
  summaryQueue = result.catch(() => {});
  return result;
}

async function readSummary(): Promise<CatchUpSummary | undefined> {
  const stored = await browser.storage.session.get(CATCH_UP_KEY);
  return stored[CATCH_UP_KEY] as CatchUpSummary | undefined;
}

export interface NotificationButton {
  title: string;
  url: string;
  /** Dismiss the notification when the button is used */
  clear: boolean;
}

/**
 * Buttons of a message's notification: its view actions (http(s) URLs only), then its attachment.
 * Chrome shows at most two. http and broadcast actions are left out: they would make the browser send
 * requests the publisher chose.
 */
export function notificationButtons(message: NtfyMessage): NotificationButton[] {
  const buttons: NotificationButton[] = [];
  for (const action of message.actions ?? []) {
    if (action.action === 'view' && isHttpUrl(action.url)) {
      buttons.push({ title: action.label, url: action.url, clear: action.clear === true });
    }
  }
  if (message.attachment && isHttpUrl(message.attachment.url)) {
    buttons.push({ title: '🔗 Open Attachment', url: message.attachment.url, clear: false });
  }
  return buttons.slice(0, 2);
}

export function showDesktopNotification(message: NtfyMessage): void {
  const label = message.priority ? PRIORITY_LABELS[message.priority] : undefined;
  const options: Browser.notifications.NotificationCreateOptions = {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: (message.title || 'Notification') + (label ? ` [${label}]` : ''),
    message: message.content_type === 'text/markdown' ? markdownToText(message.message || '') : message.message || '',
    contextMessage: `Topic: ${message.topic}`,
    // High and urgent messages stay until dismissed
    requireInteraction: (message.priority ?? 3) >= 4,
  };
  const buttons = notificationButtons(message);
  // Firefox doesn't support notification buttons (BROWSER, not FIREFOX: env flags are strings in tests)
  if (buttons.length > 0 && import.meta.env.BROWSER !== 'firefox') {
    options.buttons = buttons.map(({ title }) => ({ title }));
  }
  void browser.notifications.create(message.id, options);
}

/** A desktop notification for a new message, if its topic's rule allows it */
export async function notifyNewMessage(message: NtfyMessage): Promise<void> {
  if (shouldNotify(message, await getTopicRules())) {
    showDesktopNotification(message);
  }
}

function summaryOptions(summary: CatchUpSummary): Browser.notifications.NotificationCreateOptions {
  return {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: `${summary.count} new notifications`,
    message: summary.topic ? `Open the Inbox for ${summary.topic}` : 'Open the Inbox',
    requireInteraction: summary.urgent,
  };
}

/** Summarize across a whole sync pass and carry forward an open summary across passes. */
export function notifyCatchUp(messages: NtfyMessage[]): Promise<void> {
  return updateSummary(async () => {
    const rules = await getTopicRules();
    const eligible = messages.filter((message) => shouldNotify(message, rules));
    const first = eligible[0];
    if (!first) return;
    const current: CatchUpSummary = {
      count: eligible.length,
      topic: eligible.every(({ topic }) => topic === first.topic) ? first.topic : null,
      urgent: eligible.some(({ priority }) => (priority ?? 3) >= 4),
    };
    const previous = await readSummary();
    if (previous && Object.hasOwn(await browser.notifications.getAll(), CATCH_UP_ID)) {
      const combined = {
        count: previous.count + current.count,
        topic: previous.topic === current.topic ? current.topic : null,
        urgent: previous.urgent || current.urgent,
      };
      if (await browser.notifications.update(CATCH_UP_ID, summaryOptions(combined))) {
        await browser.storage.session.set({ [CATCH_UP_KEY]: combined });
        return;
      }
    }
    if (current.count <= MAX_INDIVIDUAL_CATCH_UP) {
      eligible.forEach(showDesktopNotification);
      return;
    }
    await browser.notifications.create(CATCH_UP_ID, summaryOptions(current));
    await browser.storage.session.set({ [CATCH_UP_KEY]: current });
  });
}

async function findMessage(id: string): Promise<NtfyMessage | undefined> {
  const { receivedNotifications } = await getHistoryState();
  return receivedNotifications.find((message) => message.id === id);
}

/** A notification button: open its URL (http(s) only), and dismiss the notification if the action says so */
export async function handleNotificationButton(notificationId: string, buttonIndex: number): Promise<void> {
  const message = await findMessage(notificationId);
  const button = message ? notificationButtons(message)[buttonIndex] : undefined;
  if (!button || !isHttpUrl(button.url)) return;
  await browser.tabs.create({ url: button.url });
  if (button.clear) {
    await browser.notifications.clear(notificationId);
  }
}

/** A click on the notification: the message's click URL (http(s) only), else the message in the extension's tab */
export async function handleNotificationClick(notificationId: string): Promise<void> {
  if (notificationId === CATCH_UP_ID) {
    const summary = await updateSummary(async () => {
      const summary = await readSummary();
      await browser.notifications.clear(notificationId);
      await browser.storage.session.remove(CATCH_UP_KEY);
      return summary;
    });
    await openExtensionTab({ topic: summary?.topic ?? undefined, allTopics: !summary?.topic });
    return;
  }
  await browser.notifications.clear(notificationId);
  if (notificationId.startsWith(CATCH_UP_PREFIX)) {
    await openExtensionTab({ topic: notificationId.slice(CATCH_UP_PREFIX.length) });
    return;
  }
  const message = await findMessage(notificationId);
  if (message && isHttpUrl(message.click)) {
    await browser.tabs.create({ url: message.click });
  } else {
    await openExtensionTab({ message: notificationId });
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
