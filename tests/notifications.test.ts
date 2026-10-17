import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { callsOf, mockResolved } from './helpers/mock';
import { handleNotificationButton, showDesktopNotification, updateUnreadBadge } from '@/utils/notifications';
import type { NtfyMessage } from '@/utils/ntfy';

type Options = Browser.notifications.NotificationCreateOptions;

const message = (id: string, extra: Partial<NtfyMessage> = {}): NtfyMessage => ({ id, event: 'message', topic: 'alerts', time: 1, ...extra });

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
    expect(options).toMatchObject({ title: 'Disk full [⇈ Urgent]', message: '91%', contextMessage: 'Topic: alerts', requireInteraction: true });
    const low = callsOf<[string, Options]>(create)[1]![1];
    expect(low).toMatchObject({ title: 'Notification [↓ Low]', requireInteraction: false });
  });

  it('offers an attachment button for http(s) attachments only', () => {
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    showDesktopNotification(message('good', { attachment: { url: 'https://ntfy.example/file/a.png' } }));
    showDesktopNotification(message('bad', { attachment: { url: 'javascript:alert(1)' } }));
    const buttons = callsOf<[string, Options]>(create).map(call => call[1].buttons);
    expect(buttons).toEqual([[{ title: '🔗 Open Attachment' }], undefined]);
  });

  it('opens only http(s) attachment URLs from the button', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [message('good', { attachment: { url: 'https://ntfy.example/f' } }), message('bad', { attachment: { url: 'file:///etc/passwd' } })],
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
