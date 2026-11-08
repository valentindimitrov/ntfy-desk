import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { deleteReceivedMessages } from '@/utils/delete';
import { getHistoryState, type StoredMessage } from '@/utils/history';

const origin = 'https://ntfy.example';
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

    expect(await deleteReceivedMessages(['a', 'b', 'c', 'unknown'])).toEqual({ denied: 0, failed: 0 });
    await deleteReceivedMessages(['a']);
    expect((await getHistoryState()).deletedMessageIds).toEqual(['a', 'b', 'c', 'unknown']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${origin}/alerts/same`);
    expect(init).toMatchObject({ method: 'DELETE', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tk_test');
  });

  it('finds a legacy row in a busy replay and skips messages belonging to a different server', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [
        stored('old', { serverOrigin: 'https://old.example', sequence_id: 'shared' }),
        stored('legacy', { serverOrigin: undefined }),
        stored('missing', { serverOrigin: undefined }),
      ],
    });
    const replay = [
      stored('legacy', { sequence_id: 'recovered' }),
      ...Array.from({ length: 1000 }, (_, index) => stored(`new-${index}`, { time: 1235 + index })),
    ]
      .map((message) => JSON.stringify(message))
      .join('\n');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === 'GET' ? new Response(replay) : new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await deleteReceivedMessages(['old', 'legacy', 'missing'])).toEqual({ denied: 0, failed: 2 });
    expect((await getHistoryState()).deletedMessageIds).toEqual(['old', 'legacy', 'missing']);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [`${origin}/alerts/json?poll=1&since=1234`, 'GET'],
      [`${origin}/alerts/recovered`, 'DELETE'],
    ]);
  });

  it('rejects a stored message ID that would escape the delete endpoint', async () => {
    const id = '../outside';
    await fakeBrowser.storage.local.set({ receivedNotifications: [stored(id)] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await deleteReceivedMessages([id])).toEqual({ denied: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
