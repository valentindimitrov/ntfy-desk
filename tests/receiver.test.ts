import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getHistoryState, getTopicSyncStates } from '@/utils/history';
import type { NtfyMessage } from '@/utils/ntfy';
import { buildWsUrl, createReceiver, WS_KEEPALIVE_INTERVAL } from '@/utils/receiver';
import { FakeWebSocket, installFakeNtfy, sleep, type FakeServer } from './helpers/fake-ntfy';

let server: FakeServer;
let notified: NtfyMessage[];

async function configure(topics: string, accessToken = 'tk_test') {
  await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics });
  await fakeBrowser.storage.local.set({ accessToken });
}

function newReceiver() {
  return createReceiver({ onNewMessage: (message) => notified.push(message) });
}

const lastSocket = () => FakeWebSocket.instances.at(-1)!;
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
    const ws = lastSocket();
    ws.accept();
    await receiver.sync();
    await sleep(10);
    expect(notified).toEqual([]); // the first sync of a topic is silent

    // Live messages on both topics while polls run concurrently
    const live = [
      server.publish('backups', 10001),
      server.publish('alerts', 10002),
      server.publish('backups', 10003),
      server.publish('alerts', 10003),
    ];
    for (const message of live) {
      void ws.deliver(message);
      void receiver.sync();
    }
    await sleep(30);
    for (let i = 0; i < 3; i++) await receiver.sync();
    await sleep(30);
    expect(notified.map((m) => m.id).sort()).toEqual(live.map((m) => m.id).sort());

    // Published while the socket was down: the next sync delivers it once
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
    expect(states.alerts?.since).toBe(10010);
    expect(states.backups?.since).toBe(10003);
    expect(server.requests.every((r) => !/since=m\d/.test(r.url))).toBe(true);
    expect(server.requests.every((r) => r.auth === 'Bearer tk_test')).toBe(true);
  });

  it('syncs a new topic silently and forgets removed topics', async () => {
    await configure('alerts,backups');
    const receiver = newReceiver();
    await receiver.sync();

    server.publish('new', 9999);
    await fakeBrowser.storage.sync.set({ topics: 'alerts,new' });
    await receiver.sync();
    expect(notified).toEqual([]);
    expect(Object.keys(await getTopicSyncStates()).sort()).toEqual(['alerts', 'new']);
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

describe('topics the credentials can only send to', () => {
  // ntfy rejects a multi-topic subscription with 403 if any topic isn't readable
  it('leaves them out of the subscription and the polls', async () => {
    await configure('alerts,coolify,inbox');
    server.unreadable = ['inbox'];
    const receiver = newReceiver();

    await receiver.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(path(lastSocket().url)).toBe('/alerts,coolify/ws');

    await receiver.sync();
    const polled = server.requests.filter((r) => r.url.includes('/json')).map((r) => path(r.url));
    expect(polled.some((p) => p.startsWith('/inbox'))).toBe(false);
  });

  it('reuses the check, and re-checks when the topics change', async () => {
    await configure('alerts,coolify,inbox');
    server.unreadable = ['inbox'];
    const receiver = newReceiver();
    await receiver.connect();
    lastSocket().accept();

    const authCalls = () => server.requests.filter((r) => r.url.endsWith('/auth')).length;
    const before = authCalls();
    await receiver.connect();
    expect(authCalls()).toBe(before);
    expect(FakeWebSocket.instances).toHaveLength(1); // same socket kept

    await fakeBrowser.storage.sync.set({ topics: 'alerts,inbox' });
    await receiver.connect();
    expect(path(lastSocket().url)).toBe('/alerts/ws');

    await fakeBrowser.storage.sync.set({ topics: 'inbox' });
    const sockets = FakeWebSocket.instances.length;
    await receiver.connect();
    expect(FakeWebSocket.instances).toHaveLength(sockets); // nothing readable: no socket
  });

  it("keeps a topic the server couldn't be asked about, and asks again next time", async () => {
    await configure('alerts,inbox');
    server.authDown = true;
    const receiver = newReceiver();
    await receiver.connect();
    expect(path(lastSocket().url)).toBe('/alerts,inbox/ws');

    server.authDown = false;
    server.unreadable = ['inbox'];
    lastSocket().accept();
    await receiver.connect();
    expect(path(lastSocket().url)).toBe('/alerts/ws');
  });
});

describe('WebSocket', () => {
  it('passes the credentials as unpadded base64url in ?auth=, with the host only', () => {
    const decode = (url: string) => Buffer.from(new URL(url).searchParams.get('auth')!, 'base64url').toString();

    const bearer = buildWsUrl({ apiUrl: 'https://ntfy.example/', topics: ['a', 'b'], accessToken: 'tk_x' });
    expect(bearer.logUrl).toBe('wss://ntfy.example/a,b/ws');
    expect(decode(bearer.url)).toBe('Bearer tk_x');
    expect(new URL(bearer.url).searchParams.get('auth')).not.toMatch(/[=+/]/);

    const basic = buildWsUrl({ apiUrl: 'http://us%C3%A9r:p%40ss@ntfy.lan:8080', topics: ['a'], accessToken: '' });
    expect(basic.logUrl).toBe('ws://ntfy.lan:8080/a/ws');
    expect(basic.url).not.toContain('@');
    expect(decode(basic.url)).toBe(`Basic ${Buffer.from('usér:p@ss').toString('base64')}`);

    expect(buildWsUrl({ apiUrl: 'ntfy.example', topics: ['a'], accessToken: '' }).url).toBe('wss://ntfy.example/a/ws');
  });

  it('never logs the credentials', async () => {
    await configure('alerts', 'tk_secret');
    const logs: string[] = [];
    for (const method of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    }
    const receiver = newReceiver();
    await receiver.connect();
    lastSocket().onerror?.({ target: lastSocket() });
    lastSocket().onclose?.({ code: 1006, reason: '' });
    receiver.close();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes('auth=') || line.includes('tk_secret'))).toBe(false);
  });

  it('sends a keepalive frame while open, and stops after closing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await configure('alerts');
      const receiver = newReceiver();
      await receiver.connect();
      const ws = lastSocket();
      ws.accept();
      vi.advanceTimersByTime(WS_KEEPALIVE_INTERVAL * 3);
      expect(ws.sent).toEqual(['keepalive', 'keepalive', 'keepalive']);
      // ntfy discards client frames of up to 64 bytes
      expect(ws.sent.every((frame) => frame.length <= 64)).toBe(true);

      receiver.close();
      vi.advanceTimersByTime(WS_KEEPALIVE_INTERVAL * 3);
      expect(ws.sent).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
