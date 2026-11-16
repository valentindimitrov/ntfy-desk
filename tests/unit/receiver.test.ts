import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getHistoryState, getTopicSyncStates } from '@/utils/history';
import type { NtfyMessage } from '@/utils/ntfy';
import { MAX_MESSAGE_JSON } from '@/utils/ntfy';
import { KEEPALIVE_INTERVAL, STREAM_IDLE_TIMEOUT, createReceiver } from '@/utils/receiver';
import { getReceiverStatus } from '@/utils/status';
import { mockResolved } from './helpers/mock';
import { FakeStream, installFakeNtfy, type FakeServer } from './helpers/fake-ntfy';

let server: FakeServer;
let notified: NtfyMessage[];

async function configure(topics: string, accessToken = 'tk_test') {
  await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics });
  await fakeBrowser.storage.local.set({ accessToken });
}

function newReceiver() {
  return createReceiver({ onNewMessage: (message) => notified.push(message) });
}

const lastStream = () => FakeStream.instances.at(-1)!;
const path = (url: string) => new URL(url).pathname;

beforeEach(() => {
  fakeBrowser.reset();
  server = installFakeNtfy();
  notified = [];
});

describe('sync and live messages', () => {
  // The bug this guards against: one global since=<id> for all topics moved backwards when topics
  // interleaved, and every re-delivery showed a desktop notification again.
  it.each(Array.from({ length: 10 }, (_, i) => i))('notifies each message exactly once (round %i)', async () => {
    await configure('alerts,backups');
    server.publish('alerts', 9000);
    server.publish('backups', 9500);

    const receiver = newReceiver();
    await receiver.connect();
    const stream = lastStream();
    stream.accept();
    await receiver.sync();
    expect(notified).toEqual([]); // the first sync of a topic is silent

    // Live messages on both topics while polls run concurrently
    const live = [
      server.publish('backups', 10001),
      server.publish('alerts', 10002),
      server.publish('backups', 10003),
      server.publish('alerts', 10003),
    ];
    await Promise.all(live.flatMap((message) => [stream.deliver(message), receiver.sync()]));
    for (let i = 0; i < 3; i++) await receiver.sync();
    expect(notified.map((m) => m.id).sort()).toEqual(live.map((m) => m.id).sort());

    // Published while the stream was down: the next sync delivers it once
    const missed = server.publish('alerts', 10010);
    await receiver.sync();
    await receiver.sync();
    expect(notified.filter((m) => m.id === missed.id)).toHaveLength(1);

    // No history update lost, no duplicates
    const { receivedNotifications } = await getHistoryState();
    expect(receivedNotifications).toHaveLength(7);
    expect(new Set(receivedNotifications.map((m) => m.id)).size).toBe(7);

    // Cursors per topic, and polls by time, never since=<id>
    const states = await getTopicSyncStates();
    expect(states.get('alerts')?.since).toBe(10010);
    expect(states.get('backups')?.since).toBe(10003);
    expect(server.requests.every((r) => !/since=m\d/.test(r.url))).toBe(true);
    expect(server.requests.every((r) => r.auth === 'Bearer tk_test')).toBe(true);
    receiver.close();
  });

  it('syncs a new topic silently and forgets removed topics', async () => {
    await configure('alerts,backups');
    const receiver = newReceiver();
    await receiver.sync();

    server.publish('new', 9999);
    await fakeBrowser.storage.sync.set({ topics: 'alerts,new' });
    await receiver.sync();
    expect(notified).toEqual([]);
    expect([...(await getTopicSyncStates()).keys()].sort()).toEqual(['alerts', 'new']);
  });

  it('notifies the first message of a topic that was empty at its first sync', async () => {
    await configure('empty');
    const receiver = newReceiver();
    await receiver.sync();
    const first = server.publish('empty', 10020);
    await receiver.sync();
    await receiver.sync();
    expect(notified.map((m) => m.id)).toEqual([first.id]);
  });

  it('catches up from an empty poll after more than a day offline', async () => {
    await configure('quiet');
    const receiver = newReceiver();
    await receiver.sync();
    const first = server.publish('quiet', server.now + 1);
    server.now += 2 * 24 * 3600;
    await receiver.sync();
    expect(notified.map(({ id }) => id)).toEqual([first.id]);
  });

  it('uses elapsed time when CORS hides Date and the browser clock is ahead of the server', async () => {
    await configure('quiet', '');
    server.hidePollHeaders = true;
    const clientNow = 200000 * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(clientNow);
    const receiver = newReceiver();
    await receiver.sync();
    expect((await getTopicSyncStates()).get('quiet')).toMatchObject({ since: null, emptyPollAt: clientNow });

    const missed = server.publish('quiet', server.now + 1);
    server.now += 86400;
    clock.mockReturnValue(clientNow + 86400 * 1000);
    await receiver.sync();
    expect(new URL(server.requests.at(-1)!.url).searchParams.get('since')).toBe('86460s');
    expect(notified.map(({ id }) => id)).toEqual([missed.id]);
    expect((await getTopicSyncStates()).get('quiet')?.emptyPollAt).toBeUndefined();
  });

  it('reports newly caught-up messages from every topic as one batch', async () => {
    await configure('alerts,backups');
    const onCatchUp = vi.fn();
    const receiver = createReceiver({ onNewMessage: vi.fn(), onCatchUp });
    await receiver.sync();
    const alert = server.publish('alerts', server.now + 1);
    const backup = server.publish('backups', server.now + 2);
    await receiver.sync();
    expect(onCatchUp).toHaveBeenCalledExactlyOnceWith([alert, backup]);
  });

  it("doesn't re-add or notify a message deleted in the popup", async () => {
    await configure('alerts');
    const receiver = newReceiver();
    await receiver.sync();
    const deleted = server.publish('alerts', 10030);
    await fakeBrowser.storage.local.set({ deletedMessageIds: [deleted.id] });
    await receiver.sync();
    expect(notified).toEqual([]);
    expect((await getHistoryState()).receivedNotifications).toEqual([]);
  });
});

describe('updated messages', () => {
  it('replaces a message updated live, notifies the update and reports the replaced one', async () => {
    await configure('alerts');
    const removed: string[][] = [];
    const receiver = createReceiver({ onNewMessage: (message) => notified.push(message), onRemoved: (ids) => removed.push(ids) });
    await receiver.sync(); // first, silent sync
    await receiver.connect();
    const stream = lastStream();
    stream.accept();
    const first = server.publish('alerts', 10001, { sequence_id: 'deploy', message: 'Deploying' });
    await stream.deliver(first);
    const update = server.publish('alerts', 10002, { sequence_id: 'deploy', message: 'Deployed' });
    await stream.deliver(update);
    expect(notified.map(({ id }) => id)).toEqual([first.id, update.id]);
    expect(removed).toEqual([[first.id]]);
    expect((await getHistoryState()).receivedNotifications.map(({ id }) => id)).toEqual([update.id]);

    // The catch-up poll replays both versions: nothing changes and nothing is notified again
    await receiver.sync();
    expect(notified).toHaveLength(2);
    expect((await getHistoryState()).receivedNotifications.map(({ id }) => id)).toEqual([update.id]);
    receiver.close();
  });

  it('keeps a live update when a poll brings the older version it missed', async () => {
    await configure('alerts');
    const receiver = newReceiver();
    await receiver.sync();
    await receiver.connect();
    const stream = lastStream();
    stream.accept();
    server.publish('alerts', 10001, { sequence_id: 'deploy' }); // missed by the stream
    const update = server.publish('alerts', 10002, { sequence_id: 'deploy' });
    await stream.deliver(update);
    await receiver.sync();
    expect(notified.map(({ id }) => id)).toEqual([update.id]);
    expect((await getHistoryState()).receivedNotifications.map(({ id }) => id)).toEqual([update.id]);
    receiver.close();
  });
});

describe('server deletions', () => {
  it.each([false, true])('keeps older relevant deletions in a large poll (replay already complete: %s)', async (complete) => {
    await configure('alerts');
    const receiver = newReceiver();
    const old = server.publish('alerts', 9999, { sequence_id: 'older' });
    await receiver.sync();
    await fakeBrowser.storage.sync.set({ syncDeletionTopics: ['alerts'] });
    if (complete) await receiver.sync();
    server.publish('alerts', 10000, { event: 'message_delete', sequence_id: 'older' });
    for (let i = 0; i < 1100; i++) server.publish('alerts', 10001 + i);
    await receiver.sync();
    expect((await getHistoryState()).receivedNotifications.some(({ id }) => id === old.id)).toBe(false);
    // The old row would also be outside the 100-row history cap. Verify the delete was applied.
    expect((await getTopicSyncStates()).get('alerts')?.serverDeletions?.some(([sequence]) => sequence === 'older')).toBe(true);
  });

  it('keeps deletion replay incomplete when the server truncated it', async () => {
    await configure('alerts');
    const receiver = newReceiver();
    server.publish('alerts', 9999);
    await receiver.sync();
    await fakeBrowser.storage.sync.set({ syncDeletionTopics: ['alerts'] });
    server.pollTruncated = true;
    await receiver.sync();
    expect((await getTopicSyncStates()).get('alerts')?.deletionReplay?.complete).toBe(false);
    expect((await getReceiverStatus())?.truncatedTopics).toEqual(['alerts']);
  });

  it('applies visible deletes and keeps replay pending until truncation can be verified', async () => {
    await configure('alerts', '');
    const receiver = newReceiver();
    server.publish('alerts', 9998, { sequence_id: 'deleted' });
    const kept = server.publish('alerts', 9999);
    await receiver.sync();
    await fakeBrowser.storage.sync.set({ syncDeletionTopics: ['alerts'] });
    server.publish('alerts', 10000, { event: 'message_delete', sequence_id: 'deleted' });
    server.hidePollHeaders = true;
    await receiver.sync();
    expect((await getHistoryState()).receivedNotifications.map(({ id }) => id)).toEqual([kept.id]);
    expect((await getTopicSyncStates()).get('alerts')?.deletionReplay?.complete).toBe(false);
    expect((await getReceiverStatus())?.unverifiedDeletionTopics).toEqual(['alerts']);

    server.hidePollHeaders = false;
    await receiver.replayDeletions(['alerts']);
    expect((await getTopicSyncStates()).get('alerts')?.deletionReplay?.complete).toBe(true);
    expect((await getReceiverStatus())?.unverifiedDeletionTopics).toEqual([]);
  });

  it('checks saved messages for deletions before the watermark after enabling sync during a poll', async () => {
    await configure('alerts');
    const receiver = newReceiver();
    const old = server.publish('alerts', 9900, { sequence_id: 'old-alert' });
    await receiver.sync();
    server.publish('alerts', 9910, { event: 'message_delete', sequence_id: 'old-alert' });
    const kept = server.publish('alerts', 9920);
    await receiver.sync();
    // A replay may contain older publishes too. They should not reappear as new messages.
    server.publish('alerts', 9905);
    expect((await getTopicSyncStates()).get('alerts')?.since).toBe(9920);
    expect((await getHistoryState()).receivedNotifications.map((message) => message.id)).toContain(old.id);
    notified = [];

    const { promise, resolve } = Promise.withResolvers<void>();
    server.pollGate = promise;
    const requests = server.requests.length;
    const pending = receiver.sync();
    await vi.waitFor(() => expect(server.requests.slice(requests).some(({ url }) => url.includes('since=9920'))).toBe(true));
    await fakeBrowser.storage.sync.set({ syncDeletionTopics: ['alerts'] });
    const replay = receiver.replayDeletions(['alerts']);
    resolve();
    await Promise.all([pending, replay]);

    expect((await getHistoryState()).receivedNotifications.map((message) => message.id)).toEqual([kept.id]);
    expect(notified).toEqual([]);
    expect((await getTopicSyncStates()).get('alerts')?.since).toBe(9920);
    const backfills = () => server.requests.slice(requests).filter(({ url }) => url.includes('since=9900')).length;
    expect(backfills()).toBe(1);
    await receiver.sync();
    expect(backfills()).toBe(1);
  });

  it('follows live deletions only for the matching topic when opted in', async () => {
    await configure('alerts,backups');
    await fakeBrowser.storage.sync.set({ syncDeletionTopics: ['alerts'] });
    const receiver = newReceiver();
    const sequence_id = 'shared';
    const old = server.publish('alerts', 9999, { sequence_id });
    const kept = server.publish('backups', 9999, { sequence_id });
    await receiver.sync();
    await fakeBrowser.storage.local.set({ readMessageIds: [old.id, kept.id] });
    await receiver.connect();
    const stream = lastStream();
    stream.accept();

    await stream.deliver(server.publish('backups', 10001, { event: 'message_delete', sequence_id }));
    await stream.deliver({ id: 'invalid', topic: 'alerts', time: 10001, event: 'message_delete' });
    await stream.deliver({ id: 'foreign', topic: 'foreign', time: 10001, event: 'message_delete', sequence_id });
    expect((await getHistoryState()).receivedNotifications.map((message) => message.id)).toEqual([kept.id, old.id]);

    await stream.deliver(server.publish('alerts', 10002, { event: 'message_delete', sequence_id }));
    await receiver.sync();
    const history = await getHistoryState();
    expect(history.receivedNotifications.map((message) => message.id)).toEqual([kept.id]);
    expect(history.readMessageIds).toEqual([kept.id]);
    expect(notified).toEqual([]);
    receiver.close();
  });

  it('catches up on deletions, skips deleted notifications, and allows a same-second revival', async () => {
    await configure('alerts');
    await fakeBrowser.storage.sync.set({ syncDeletionTopics: ['alerts'] });
    const receiver = newReceiver();
    const existing = server.publish('alerts', 9999);
    await receiver.sync();

    const sequence_id = 'deploy';
    server.publish('alerts', 10000, { event: 'message_delete', sequence_id: existing.id });
    server.publish('alerts', 10001, { sequence_id });
    server.publish('alerts', 10001, { event: 'message_delete', sequence_id });
    const revived = server.publish('alerts', 10001, { sequence_id });
    await receiver.sync();
    await receiver.sync();

    expect((await getHistoryState()).receivedNotifications).toEqual([{ ...revived, serverOrigin: 'https://ntfy.example' }]);
    expect(notified).toEqual([revived]);
  });

  it('keeps a live deletion when a stale replay returns an unseen message from the same second', async () => {
    await configure('alerts');
    await fakeBrowser.storage.sync.set({ syncDeletionTopics: ['alerts'] });
    const receiver = newReceiver();
    await receiver.connect();
    const stream = lastStream();
    stream.accept();
    await receiver.sync();

    const sequence_id = 'deploy';
    server.publish('alerts', 10001, { sequence_id });
    await stream.deliver({ id: 'not-cached-yet', time: 10001, event: 'message_delete', topic: 'alerts', sequence_id });
    await receiver.sync();
    expect((await getHistoryState()).receivedNotifications).toEqual([]);
    expect(notified).toEqual([]);
    receiver.close();
  });
});

describe('topics the credentials can only send to', () => {
  // ntfy rejects a multi-topic subscription with 403 if any topic isn't readable
  it('leaves them out of the subscription and the polls', async () => {
    await configure('alerts,coolify,inbox');
    server.unreadable = ['inbox'];
    const receiver = newReceiver();

    await receiver.connect();
    expect(FakeStream.instances).toHaveLength(1);
    expect(path(lastStream().url)).toBe('/alerts,coolify/json');

    await receiver.sync();
    const polled = server.requests.filter((r) => r.url.includes('/json')).map((r) => path(r.url));
    expect(polled.some((p) => p.startsWith('/inbox'))).toBe(false);
  });

  it('reuses the check, and re-checks when the topics change', async () => {
    await configure('alerts,coolify,inbox');
    server.unreadable = ['inbox'];
    const receiver = newReceiver();
    await receiver.connect();
    lastStream().accept();

    const authCalls = () => server.requests.filter((r) => r.url.endsWith('/auth')).length;
    const before = authCalls();
    await receiver.connect();
    expect(authCalls()).toBe(before);
    expect(FakeStream.instances).toHaveLength(1); // same stream kept

    await fakeBrowser.storage.sync.set({ topics: 'alerts,inbox' });
    await receiver.connect();
    expect(path(lastStream().url)).toBe('/alerts/json');

    await fakeBrowser.storage.sync.set({ topics: 'inbox' });
    const streams = FakeStream.instances.length;
    await receiver.connect();
    expect(FakeStream.instances).toHaveLength(streams); // nothing readable: no stream
  });

  it("keeps a topic the server couldn't be asked about, and asks again next time", async () => {
    await configure('alerts,inbox');
    server.authDown = true;
    const receiver = newReceiver();
    await receiver.connect();
    expect(path(lastStream().url)).toBe('/alerts,inbox/json');

    server.authDown = false;
    server.unreadable = ['inbox'];
    lastStream().accept();
    await receiver.connect();
    expect(path(lastStream().url)).toBe('/alerts/json');
  });
});

describe('subscription stream', () => {
  it('sends the credentials in the Authorization header, never in the URL', async () => {
    await configure('a,b', 'tk_x');
    const receiver = newReceiver();
    await receiver.connect();
    expect(lastStream().url).toBe('https://ntfy.example/a,b/json');
    expect(lastStream().auth).toBe('Bearer tk_x');
    receiver.close();

    await fakeBrowser.storage.local.set({ accessToken: '', serverCredentials: { username: 'usér', password: 'p@ss' } });
    await receiver.connect();
    expect(lastStream().auth).toBe(`Basic ${Buffer.from('usér:p@ss').toString('base64')}`);
    expect(lastStream().url).toBe('https://ntfy.example/a,b/json');
    receiver.close();
  });

  it.each(['bearer', 'basic'])('never logs %s credentials on a failed subscription', async (kind) => {
    const username = 'synthetic-user';
    const password = 'synthetic-password';
    const encoded = btoa(`${username}:${password}`);
    await configure('alerts', kind === 'bearer' ? 'tk_secret' : '');
    if (kind === 'basic') await fakeBrowser.storage.local.set({ serverCredentials: { username, password } });
    const logs: string[] = [];
    for (const method of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    }
    const receiver = newReceiver();
    await receiver.connect();
    expect(lastStream().auth).toBe(kind === 'bearer' ? 'Bearer tk_secret' : `Basic ${encoded}`);
    lastStream().refuse(401);
    await vi.waitFor(async () => expect((await getReceiverStatus())?.state).toBe('reconnecting'));
    receiver.close();
    expect(logs.length).toBeGreaterThan(0);
    for (const value of ['tk_secret', username, password, encoded]) expect(logs.join('\n')).not.toContain(value);
  });

  it('aborts a refused subscription so its response body is released, and reconnects once', async () => {
    await configure('alerts');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const receiver = newReceiver();
      await receiver.connect();
      const refused = lastStream();
      refused.refuse(503);
      await vi.waitFor(async () => expect((await getReceiverStatus())?.state).toBe('reconnecting'));
      expect(refused.aborted).toBe(true);
      const opened = FakeStream.instances.length;
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(FakeStream.instances.length).toBe(opened + 1));
      await vi.advanceTimersByTimeAsync(100);
      expect(FakeStream.instances.length).toBe(opened + 1);
      receiver.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads messages split across chunks, and drops a line that is too long', async () => {
    await configure('alerts');
    const receiver = newReceiver();
    await receiver.sync(); // first, silent sync
    await receiver.connect();
    const stream = lastStream();
    stream.accept();
    const line = JSON.stringify({ id: 'split', event: 'message', topic: 'alerts', time: 10001 });
    await stream.send(line.slice(0, 20));
    await stream.send(`${line.slice(20)}\n{"event":"keepalive","id":"k","topic":"alerts","time":1}\n`);
    await stream.send('x'.repeat(MAX_MESSAGE_JSON + 10));
    await stream.send(`still the long line\n${JSON.stringify({ id: 'after', event: 'message', topic: 'alerts', time: 10002 })}\n`);
    expect(notified.map((m) => m.id)).toEqual(['split', 'after']);
    receiver.close();
  });

  it('subscribes again when the server ends the stream', async () => {
    await configure('alerts');
    const receiver = newReceiver();
    await receiver.connect();
    lastStream().accept();
    await vi.waitFor(async () => expect((await getReceiverStatus())?.state).toBe('connected'));
    lastStream().end();
    await vi.waitFor(async () => expect((await getReceiverStatus())?.state).toBe('reconnecting'));
    await receiver.connect(); // the reconnect timer or the alarm
    expect(FakeStream.instances).toHaveLength(2);
    receiver.close();
    expect(lastStream().aborted).toBe(true);
  });

  it('calls an extension API while open, to keep the service worker running, and stops after closing', async () => {
    const ping = mockResolved(fakeBrowser.runtime, 'getPlatformInfo', { os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await configure('alerts');
      const receiver = newReceiver();
      await receiver.connect();
      lastStream().accept();
      await vi.waitFor(async () => expect((await getReceiverStatus())?.state).toBe('connected'));
      vi.advanceTimersByTime(KEEPALIVE_INTERVAL * 3);
      expect(ping).toHaveBeenCalledTimes(3);

      receiver.close();
      vi.advanceTimersByTime(KEEPALIVE_INTERVAL * 3);
      expect(ping).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribes again when nothing arrives for STREAM_IDLE_TIMEOUT', async () => {
    await configure('alerts');
    const receiver = newReceiver();
    await receiver.connect();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stream = lastStream();
      stream.accept();
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT - 1000);
      await stream.send('{"event":"keepalive"}\n');
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT - 1000);
      expect(stream.aborted).toBe(false); // the keepalive restarted the limit

      await vi.advanceTimersByTimeAsync(2000);
      expect(stream.aborted).toBe(true);
      expect(((await fakeBrowser.storage.session.get('receiverStatus')).receiverStatus as { state: string }).state).toBe('reconnecting');

      // A stream that never sends anything is given up too
      await receiver.connect(); // the reconnect timer or the alarm
      const silent = lastStream();
      expect(silent).not.toBe(stream);
      silent.accept();
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT + 1000);
      expect(silent.aborted).toBe(true);
    } finally {
      receiver.close();
      vi.useRealTimers();
    }
  });
});
