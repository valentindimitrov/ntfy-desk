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
const CATCH_UP_ID = 'catch-up-summary';
const CATCH_UP_KEY = 'catchUpSummary';
const MAX_INDIVIDUAL_CATCH_UP = 5;

interface CatchUpSummary {
  count: number;
  topic: string | null;
  urgent: boolean;
}

let notificationQueue: Promise<unknown> = Promise.resolve();

/**
 * One queue for creating, summarizing and dismissing notifications: a dismissal requested while a
 * notification is still being prepared (its topic rule is read first) runs after it is shown.
 */
function updateSummary<T>(task: () => Promise<T>): Promise<T> {
  const result = notificationQueue.then(task);
  notificationQueue = result.catch(() => {});
  return result;
}

const MAX_DISMISSED = 5000;
/**
 * Ids dismissed in this run of the background (read, deleted or replaced), newest last. A message is
 * announced at most once, so one dismissed before its notification was queued is never shown.
 */
const dismissed = new Set<string>();

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

export async function showDesktopNotification(message: NtfyMessage): Promise<void> {
  const label = message.priority ? PRIORITY_LABELS[message.priority] : undefined;
  const options: Browser.notifications.NotificationCreateOptions = {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: (message.title || 'Notification') + (label ? ` [${label}]` : ''),
    message: message.content_type === 'text/markdown' ? markdownToText(message.message || '') : message.message || '',
  };
  // Firefox rejects Chromium-only notification options.
  if (import.meta.env.BROWSER !== 'firefox') {
    options.contextMessage = `Topic: ${message.topic}`;
    options.requireInteraction = (message.priority ?? 3) >= 4;
    const buttons = notificationButtons(message);
    if (buttons.length > 0) options.buttons = buttons.map(({ title }) => ({ title }));
  }
  await browser.notifications.create(message.id, options);
}

/** A desktop notification for a new message, if its topic's rule allows it */
export function notifyNewMessage(message: NtfyMessage): Promise<void> {
  return updateSummary(async () => {
    if (shouldNotify(message, await getTopicRules()) && !dismissed.has(message.id)) {
      await showDesktopNotification(message);
    }
  });
}

function summaryOptions(summary: CatchUpSummary): Browser.notifications.NotificationCreateOptions {
  return {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: `${summary.count} new notifications`,
    message: summary.topic ? `Open the Inbox for ${summary.topic}` : 'Open the Inbox',
    ...(import.meta.env.BROWSER !== 'firefox' && { requireInteraction: summary.urgent }),
  };
}

/** Summarize across a whole sync pass and carry forward an open summary across passes. */
export function notifyCatchUp(messages: NtfyMessage[]): Promise<void> {
  return updateSummary(async () => {
    const rules = await getTopicRules();
    const eligible = messages.filter((message) => shouldNotify(message, rules) && !dismissed.has(message.id));
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
      const options = summaryOptions(combined);
      // Firefox replaces an existing notification on create and has no update method.
      const updated =
        typeof browser.notifications.update === 'function'
          ? await browser.notifications.update(CATCH_UP_ID, options)
          : await browser.notifications.create(CATCH_UP_ID, options);
      if (updated) {
        await browser.storage.session.set({ [CATCH_UP_KEY]: combined });
        return;
      }
    }
    if (current.count <= MAX_INDIVIDUAL_CATCH_UP) {
      await Promise.all(eligible.map(showDesktopNotification));
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

/** Dismiss the desktop notifications of these messages (read, deleted or replaced). Never rejects. */
export function clearNotifications(ids: string[]): Promise<void> {
  for (const id of ids) {
    dismissed.delete(id);
    dismissed.add(id);
  }
  for (const id of dismissed) {
    if (dismissed.size <= MAX_DISMISSED) break;
    dismissed.delete(id);
  }
  return updateSummary(async () => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await browser.notifications.clear(id);
        } catch {
          // No such notification, or notifications unavailable: nothing to dismiss
        }
      }),
    );
  });
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

let sendResultTimer: ReturnType<typeof setTimeout> | undefined;

/** A temporary result on the toolbar after a context-menu send. */
export function showSendResult(result: boolean | 'uncertain'): void {
  clearTimeout(sendResultTimer);
  const uncertain = result === 'uncertain';
  const name = browser.runtime.getManifest().name;
  void browser.action.setTitle({ title: uncertain ? 'Delivery is uncertain. Check the Inbox before retrying.' : name });
  void browser.action.setBadgeText({ text: uncertain ? '?' : result ? '✓' : '✗' });
  void browser.action.setBadgeBackgroundColor({ color: uncertain ? '#ad6000' : result ? '#4CAF50' : '#f44336' });
  sendResultTimer = setTimeout(
    () => {
      if (uncertain) void browser.action.setTitle({ title: name });
      void updateUnreadBadge();
    },
    uncertain ? 6000 : 2000,
  );
}
