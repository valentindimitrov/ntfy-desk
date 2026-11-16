import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { deleteReceivedMessages } from '@/utils/delete';
import { getHistoryState, type StoredMessage } from '@/utils/history';
import { handlePopupRequest } from '@/utils/messages';

const origin = 'https://ntfy.example';
const intent = (...ids: string[]) => ({ ids, apiUrl: origin, fallbackUrl: '' });
const stored = (id: string, extra: Partial<StoredMessage> = {}): StoredMessage => ({
  id,
  event: 'message',
  time: 1234,
  topic: 'alerts',
  serverOrigin: origin,
  ...extra,
});

beforeEach(async () => {
  fakeBrowser.reset();
  await fakeBrowser.storage.sync.set({ apiUrl: origin, topics: 'alerts,backups', syncDeletionTopics: ['alerts'] });
});

describe('outbound deletion sync', () => {
  it('deletes each opted-in sequence once and keeps other deletions local', async () => {
    await fakeBrowser.storage.local.set({
      accessToken: 'tk_test',
      receivedNotifications: [
        stored('a', { sequence_id: 'same' }),
        stored('b', { sequence_id: 'same' }),
        stored('c', { topic: 'backups' }),
      ],
    });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await deleteReceivedMessages(['a', 'b', 'c', 'unknown'], intent('a', 'b'))).toEqual({ denied: 0, failed: 0 });
    await deleteReceivedMessages(['a'], intent('a'));
    expect((await getHistoryState()).deletedMessageIds).toEqual(['a', 'b', 'c', 'unknown']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${origin}/alerts/same`);
    expect(init).toMatchObject({ method: 'DELETE', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tk_test');
  });

  it('counts a message delivered by another server as failed and deletes only the verified one', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [stored('old', { serverOrigin: 'https://old.example', sequence_id: 'shared' }), stored('current')],
    });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await deleteReceivedMessages(['old', 'current'], intent('old', 'current'))).toEqual({ denied: 0, failed: 1 });
    expect((await getHistoryState()).deletedMessageIds).toEqual(['old', 'current']);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([[`${origin}/alerts/current`, 'DELETE']]);
  });

  it('rejects a stored message ID that would escape the delete endpoint', async () => {
    const id = '../outside';
    await fakeBrowser.storage.local.set({ receivedNotifications: [stored(id)] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await deleteReceivedMessages([id], intent(id))).toEqual({ denied: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps stale local-only actions local after sync is enabled in another view', async () => {
    await fakeBrowser.storage.local.set({ receivedNotifications: [stored('stale'), stored('bulk')] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sync = vi.fn();
    await handlePopupRequest({ action: 'delete', ids: ['stale'] }, sync);
    await handlePopupRequest({ action: 'delete', ids: ['bulk'] }, sync);
    expect((await getHistoryState()).deletedMessageIds).toEqual(['stale', 'bulk']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ apiUrl: 'https://replacement.example' }, { syncDeletionTopics: [] }])(
    'keeps an approved server delete local after the destination or sync mode changes (%j)',
    async (changes) => {
      await fakeBrowser.storage.local.set({ receivedNotifications: [stored('shown')] });
      await fakeBrowser.storage.sync.set<Record<string, unknown>>(changes);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      expect(await deleteReceivedMessages(['shown'], intent('shown'))).toEqual({ denied: 0, failed: 0, skipped: 1 });
      expect((await getHistoryState()).deletedMessageIds).toEqual(['shown']);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('desktop notifications of read and deleted messages', () => {
  it('dismisses them when messages are marked read or deleted, but not when marked unread', async () => {
    await fakeBrowser.storage.local.set({ receivedNotifications: [stored('a'), stored('b'), stored('c')] });
    const clear = vi.spyOn(fakeBrowser.notifications, 'clear').mockResolvedValue(true as never);
    const sync = vi.fn();
    await handlePopupRequest({ action: 'setRead', ids: ['a'], read: true }, sync);
    await handlePopupRequest({ action: 'setRead', ids: ['a'], read: false }, sync);
    await handlePopupRequest({ action: 'delete', ids: ['b', 'c'] }, sync);
    await vi.waitFor(() => expect(clear.mock.calls).toEqual([['a'], ['b'], ['c']]));
  });

  it('applies the read or delete action even when dismissing fails', async () => {
    await fakeBrowser.storage.local.set({ receivedNotifications: [stored('a'), stored('b')] });
    vi.spyOn(fakeBrowser.notifications, 'clear').mockRejectedValue(new Error('no notifications'));
    const sync = vi.fn();
    await handlePopupRequest({ action: 'setRead', ids: ['a'], read: true }, sync);
    await handlePopupRequest({ action: 'delete', ids: ['b'] }, sync);
    expect(await getHistoryState()).toMatchObject({ readMessageIds: ['a'], deletedMessageIds: ['b'] });
  });
});
