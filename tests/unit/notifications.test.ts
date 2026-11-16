import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { callsOf, mockResolved } from './helpers/mock';
import {
  handleNotificationButton,
  handleNotificationClick,
  notificationButtons,
  clearNotifications,
  notifyCatchUp,
  notifyNewMessage,
  showDesktopNotification,
  updateUnreadBadge,
} from '@/utils/notifications';
import type { StoredMessage } from '@/utils/history';
import type { NtfyMessage } from '@/utils/ntfy';

type Options = Browser.notifications.NotificationCreateOptions;

const message = (id: string, extra: Partial<NtfyMessage> = {}): StoredMessage => ({
  id,
  event: 'message',
  topic: 'alerts',
  time: 1,
  serverOrigin: 'https://ntfy.example',
  ...extra,
});

beforeEach(() => {
  fakeBrowser.reset();
});

describe('desktop notifications', () => {
  it('shows the title with the priority, and keeps high priority until dismissed', () => {
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    void showDesktopNotification(message('a', { title: 'Disk full', message: '91%', priority: 5 }));
    void showDesktopNotification(message('b', { priority: 2 }));

    const [id, options] = callsOf<[string, Options]>(create)[0]!;
    expect(id).toBe('a');
    expect(options).toMatchObject({
      title: 'Disk full [⇈ Urgent]',
      message: '91%',
      contextMessage: 'Topic: alerts',
      requireInteraction: true,
    });
    const low = callsOf<[string, Options]>(create)[1]![1];
    expect(low).toMatchObject({ title: 'Notification [↓ Low]', requireInteraction: false });
  });

  it('shows Markdown messages as plain text', () => {
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    void showDesktopNotification(message('md', { message: '**Disk** at [91%](https://x.example)', content_type: 'text/markdown' }));
    expect(callsOf<[string, Options]>(create)[0]![1].message).toBe('Disk at 91%');
  });

  it('offers an attachment button for http(s) attachments only', () => {
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    void showDesktopNotification(message('good', { attachment: { url: 'https://ntfy.example/file/a.png' } }));
    void showDesktopNotification(message('bad', { attachment: { url: 'javascript:alert(1)' } }));
    const buttons = callsOf<[string, Options]>(create).map((call) => call[1].buttons);
    expect(buttons).toEqual([[{ title: '🔗 Open Attachment' }], undefined]);
  });

  it('makes buttons of view actions (http(s) only) and the attachment, at most two', () => {
    const actions = [
      { action: 'http', label: 'Restart', url: 'https://api.example/restart' },
      { action: 'view', label: 'Logs', url: 'https://logs.example', clear: true },
      { action: 'view', label: 'Bad', url: 'javascript:alert(1)' },
      { action: 'view', label: 'Grafana', url: 'https://grafana.example' },
    ];
    expect(notificationButtons(message('a', { actions }))).toEqual([
      { title: 'Logs', url: 'https://logs.example', clear: true },
      { title: 'Grafana', url: 'https://grafana.example', clear: false },
    ]);
    expect(notificationButtons(message('b', { actions: actions.slice(0, 2), attachment: { url: 'https://ntfy.example/f' } }))).toEqual([
      { title: 'Logs', url: 'https://logs.example', clear: true },
      { title: '🔗 Open Attachment', url: 'https://ntfy.example/f', clear: false },
    ]);
  });

  it('opens a view action from its button, and dismisses the notification if the action says so', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [message('a', { actions: [{ action: 'view', label: 'Logs', url: 'https://logs.example', clear: true }] })],
    });
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    const clear = mockResolved(fakeBrowser.notifications, 'clear', true);
    await handleNotificationButton('a', 0);
    expect(create.mock.calls).toEqual([[{ url: 'https://logs.example' }]]);
    expect(clear.mock.calls).toEqual([['a']]);
  });

  it('opens the click URL when the notification is clicked, else the message in the extension tab', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [
        message('withUrl', { click: 'https://status.example/x' }),
        message('plain'),
        message('badUrl', { click: 'file:///x' }),
      ],
    });
    vi.spyOn(fakeBrowser.runtime, 'getURL').mockImplementation(
      ((path: string) => `chrome-extension://id${path}`) as typeof fakeBrowser.runtime.getURL,
    );
    mockResolved(fakeBrowser.runtime, 'getContexts', []);
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    const clear = mockResolved(fakeBrowser.notifications, 'clear', true);

    await handleNotificationClick('withUrl');
    await handleNotificationClick('plain');
    await handleNotificationClick('badUrl');
    const urls = callsOf<[{ url: string }]>(create).map(([{ url }]) => new URL(url));
    expect(urls[0]?.href).toBe('https://status.example/x');
    expect(urls.slice(1).map((url) => new URLSearchParams(url.hash.slice(1)).get('message'))).toEqual(['plain', 'badUrl']);
    expect(clear).toHaveBeenCalledTimes(3);
  });

  it('summarizes a large eligible catch-up and opens its topic in an existing tab without navigation', async () => {
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    mockResolved(fakeBrowser.notifications, 'clear', true);
    mockResolved(fakeBrowser.runtime, 'getContexts', [
      {
        documentUrl: 'chrome-extension://id/popup.html?mode=page&message=old',
        tabId: 7,
        windowId: 3,
      },
    ]);
    vi.spyOn(fakeBrowser.runtime, 'getURL').mockImplementation(
      ((path: string) => `chrome-extension://id${path}`) as typeof fakeBrowser.runtime.getURL,
    );
    const update = mockResolved(fakeBrowser.tabs, 'update', {});
    mockResolved(fakeBrowser.windows, 'update', {});
    await fakeBrowser.storage.sync.set({ notifyRules: [['alerts', 'high']] });
    await notifyCatchUp(Array.from({ length: 9 }, (_, index) => message(String(index), { priority: index < 6 ? 4 : 2 })));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      'catch-up-summary',
      expect.objectContaining({ title: '6 new notifications', requireInteraction: true }),
    );
    await handleNotificationClick('catch-up-summary');
    const [, options] = callsOf<[number, { url: string }]>(update)[0]!;
    const url = new URL(options.url);
    expect(url.search).toBe('?mode=page&message=old');
    expect(new URLSearchParams(url.hash.slice(1)).get('topic')).toBe('alerts');
  });

  it('caps catch-up across topics and adds later batches to the same urgent summary', async () => {
    const id = 'catch-up-summary';
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    const update = mockResolved(fakeBrowser.notifications, 'update', true);
    mockResolved(fakeBrowser.notifications, 'clear', true);
    mockResolved(fakeBrowser.notifications, 'getAll', { [id]: {} });
    mockResolved(fakeBrowser.runtime, 'getContexts', []);
    vi.spyOn(fakeBrowser.runtime, 'getURL').mockImplementation(
      ((path: string) => `chrome-extension://id${path}`) as typeof fakeBrowser.runtime.getURL,
    );
    const open = mockResolved(fakeBrowser.tabs, 'create', {});
    await notifyCatchUp(
      Array.from({ length: 6 }, (_, index) =>
        message(String(index), { topic: index < 3 ? 'alerts' : 'backups', priority: index === 0 ? 5 : 3 }),
      ),
    );
    await notifyCatchUp([message('later')]);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      id,
      expect.objectContaining({ title: '6 new notifications', message: 'Open the Inbox', requireInteraction: true }),
    );
    expect(update).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ title: '7 new notifications', requireInteraction: true }));
    await handleNotificationClick(id);
    const [{ url }] = callsOf<[{ url: string }]>(open)[0]!;
    expect(new URLSearchParams(new URL(url).hash.slice(1)).get('topic')).toBe('');
  });

  it('recreates an active summary with its combined count when the browser has no update API', async () => {
    const id = 'catch-up-summary';
    const create = mockResolved(fakeBrowser.notifications, 'create', id);
    mockResolved(fakeBrowser.notifications, 'getAll', { [id]: {} });
    const original = Object.getOwnPropertyDescriptor(fakeBrowser.notifications, 'update')!;
    Object.defineProperty(fakeBrowser.notifications, 'update', { configurable: true, value: undefined });
    vi.stubEnv('BROWSER', 'firefox');
    try {
      await notifyCatchUp(Array.from({ length: 6 }, (_, index) => message(String(index))));
      await notifyCatchUp([message('later', { topic: 'backups', priority: 4 })]);
      expect(create).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenLastCalledWith(id, expect.objectContaining({ title: '7 new notifications', message: 'Open the Inbox' }));
      expect(callsOf<[string, Options]>(create)[1]![1]).not.toHaveProperty('requireInteraction');
    } finally {
      vi.unstubAllEnvs();
      Object.defineProperty(fakeBrowser.notifications, 'update', original);
    }
  });

  it('omits Chromium-only options from Firefox individual notifications', () => {
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    vi.stubEnv('BROWSER', 'firefox');
    try {
      void showDesktopNotification(message('firefox', { priority: 5, attachment: { url: 'https://ntfy.example/file/a.png' } }));
      const [, options] = callsOf<[string, Options]>(create)[0]!;
      expect(options.title).toBe('Notification [⇈ Urgent]');
      expect(options).not.toHaveProperty('requireInteraction');
      expect(options).not.toHaveProperty('contextMessage');
      expect(options).not.toHaveProperty('buttons');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('opens only http(s) attachment URLs from the button', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [
        message('good', { attachment: { url: 'https://ntfy.example/f' } }),
        message('bad', { attachment: { url: 'file:///etc/passwd' } }),
      ],
    });
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    await handleNotificationButton('bad', 0);
    await handleNotificationButton('good', 0);
    expect(create.mock.calls).toEqual([[{ url: 'https://ntfy.example/f' }]]);
  });
});

describe('dismissal order', () => {
  it('never shows a notification dismissed while or before it was prepared', async () => {
    const order: string[] = [];
    vi.spyOn(fakeBrowser.notifications, 'create').mockImplementation(((id: string) => {
      order.push(`create ${id}`);
      return Promise.resolve(id);
    }) as never);
    vi.spyOn(fakeBrowser.notifications, 'clear').mockImplementation(((id: string) => {
      order.push(`clear ${id}`);
      return Promise.resolve(true);
    }) as never);

    // The topic rule is still being read when the message is marked read
    const shown = notifyNewMessage(message('pending'));
    const cleared = clearNotifications(['pending']);
    await Promise.all([shown, cleared]);
    // Dismissed before it was shown: it isn't shown at all, and the dismissal still runs
    expect(order).toEqual(['clear pending']);

    await clearNotifications(['early']);
    await notifyNewMessage(message('early'));
    await notifyCatchUp([message('early')]);
    expect(order.filter((entry) => entry.startsWith('create'))).toEqual([]);

    // One not dismissed is shown, and a later dismissal follows it
    await Promise.all([notifyNewMessage(message('kept')), Promise.resolve().then(() => undefined)]);
    await clearNotifications(['kept']);
    expect(order.slice(-2)).toEqual(['create kept', 'clear kept']);
  });
});

describe('unread badge', () => {
  it('counts messages neither read nor deleted', async () => {
    const setText = vi.spyOn(fakeBrowser.action, 'setBadgeText').mockResolvedValue();
    vi.spyOn(fakeBrowser.action, 'setBadgeBackgroundColor').mockResolvedValue();
    await fakeBrowser.storage.local.set({
      receivedNotifications: [message('a'), message('b'), message('c')],
      readMessageIds: ['a'],
      deletedMessageIds: ['b'],
    });
    await updateUnreadBadge();
    expect(setText).toHaveBeenLastCalledWith({ text: '1' });

    await fakeBrowser.storage.local.set({ readMessageIds: ['a', 'c'] });
    await updateUnreadBadge();
    expect(setText).toHaveBeenLastCalledWith({ text: '' });
  });
});
