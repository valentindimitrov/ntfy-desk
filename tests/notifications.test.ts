import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { callsOf, mockResolved } from './helpers/mock';
import {
  handleNotificationButton,
  handleNotificationClick,
  notificationButtons,
  notifyCatchUp,
  showDesktopNotification,
  updateUnreadBadge,
} from '@/utils/notifications';
import type { NtfyMessage } from '@/utils/ntfy';

type Options = Browser.notifications.NotificationCreateOptions;

const message = (id: string, extra: Partial<NtfyMessage> = {}): NtfyMessage => ({
  id,
  event: 'message',
  topic: 'alerts',
  time: 1,
  ...extra,
});

beforeEach(() => {
  fakeBrowser.reset();
});

describe('desktop notifications', () => {
  it('shows the title with the priority, and keeps high priority until dismissed', () => {
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    showDesktopNotification(message('a', { title: 'Disk full', message: '91%', priority: 5 }));
    showDesktopNotification(message('b', { priority: 2 }));

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
    showDesktopNotification(message('md', { message: '**Disk** at [91%](https://x.example)', content_type: 'text/markdown' }));
    expect(callsOf<[string, Options]>(create)[0]![1].message).toBe('Disk at 91%');
  });

  it('offers an attachment button for http(s) attachments only', () => {
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    showDesktopNotification(message('good', { attachment: { url: 'https://ntfy.example/file/a.png' } }));
    showDesktopNotification(message('bad', { attachment: { url: 'javascript:alert(1)' } }));
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
    expect(create).toHaveBeenCalledWith('catch-up:alerts', expect.objectContaining({ title: '6 new notifications' }));
    await handleNotificationClick('catch-up:alerts');
    const [, options] = callsOf<[number, { url: string }]>(update)[0]!;
    const url = new URL(options.url);
    expect(url.search).toBe('?mode=page&message=old');
    expect(new URLSearchParams(url.hash.slice(1)).get('topic')).toBe('alerts');
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
