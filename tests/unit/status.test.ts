import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createReceiver } from '@/utils/receiver';
import { INITIAL_STATUS, describeStatus, getReceiverStatus, retryCountdown, type ReceiverStatus } from '@/utils/status';
import { FakeStream, installFakeNtfy, type FakeServer } from './helpers/fake-ntfy';

let server: FakeServer;

beforeEach(async () => {
  fakeBrowser.reset();
  server = installFakeNtfy();
  await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics: 'alerts,inbox' });
  await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
});

const status = async () => (await getReceiverStatus())!;

describe('receiver status', () => {
  it('goes from connecting to connected, and to reconnecting with a retry time when the stream ends', async () => {
    server.unreadable = ['inbox'];
    const receiver = createReceiver({ onNewMessage: () => {} });
    await receiver.connect();
    expect(await status()).toMatchObject({ state: 'connecting', server: 'ntfy.example', unreadableTopics: ['inbox'], unreachable: false });

    const stream = FakeStream.instances.at(-1)!;
    stream.accept();
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: 'connected', retryAt: null }));

    const before = Date.now();
    stream.end();
    const closed = await vi.waitFor(async () => {
      const closed = await status();
      expect(closed.state).toBe('reconnecting');
      return closed;
    });
    expect(closed.state).toBe('reconnecting');
    expect(closed.retryAt).toBeGreaterThanOrEqual(before + 5000);
    receiver.close();
  });

  it('reports a topic whose poll failed, and an unreachable server on 5xx', async () => {
    const receiver = createReceiver({ onNewMessage: () => {} });
    server.pollStatus = 502;
    await receiver.sync();
    expect(await status()).toMatchObject({
      syncErrors: [
        ['alerts', 'HTTP 502'],
        ['inbox', 'HTTP 502'],
      ],
      unreachable: true,
    });

    server.pollStatus = 200;
    await receiver.sync();
    expect((await status()).syncErrors).toEqual([]);
    // Reached again: a later end of the stream reads as a reconnect, not as "can't reach"
    expect((await status()).unreachable).toBe(false);
  });

  it("doesn't let a slow poll of the previous server clear the new server's unreachable state", async () => {
    await fakeBrowser.storage.local.remove('accessToken');
    const receiver = createReceiver({ onNewMessage: () => {} });
    await receiver.connect();
    let release!: () => void;
    server.pollGate = new Promise((resolve) => (release = resolve));
    const slow = receiver.sync(); // polls ntfy.example, held back

    await fakeBrowser.storage.sync.set({ apiUrl: 'https://other.example' });
    await receiver.connect();
    FakeStream.instances.at(-1)!.refuse(503);
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: 'reconnecting', unreachable: true }));

    release();
    await slow;
    expect((await status()).unreachable).toBe(true);
    receiver.close();
  });

  it('reports when no topic is readable', async () => {
    server.unreadable = ['alerts', 'inbox'];
    await createReceiver({ onNewMessage: () => {} }).connect();
    expect((await status()).state).toBe('no-readable-topics');
  });
});

describe('status text', () => {
  const base: ReceiverStatus = { ...INITIAL_STATUS, server: 'ntfy.example' };

  it('describes each state', () => {
    expect(describeStatus(null)).toEqual([]);
    expect(describeStatus({ ...base, state: 'not-configured' })).toEqual([]);
    expect(describeStatus({ ...base, state: 'connected' })).toEqual([{ text: 'Connected to ntfy.example', level: 'ok' }]);
    expect(describeStatus({ ...base, state: 'connecting' })[0]!.level).toBe('warning');
    expect(describeStatus({ ...base, state: 'no-readable-topics' })[0]!.level).toBe('error');
  });

  it("counts down to the next attempt, and says when the server can't be reached", () => {
    const now = 1_000_000;
    expect(describeStatus({ ...base, state: 'reconnecting', retryAt: now + 9500 })[0]!.text).toBe(
      'Disconnected from ntfy.example, reconnecting',
    );
    expect(retryCountdown(now + 9500, now)).toBe(' in 10 s');
    expect(retryCountdown(now - 1, now)).toBe('…');
    expect(describeStatus({ ...base, state: 'reconnecting', retryAt: now - 1, unreachable: true })[0]).toEqual({
      text: "Can't reach ntfy.example, retrying",
      level: 'error',
    });
  });

  it('lists the topics whose missed messages could not be fetched', () => {
    const lines = describeStatus({ ...base, state: 'connected', syncErrors: [['alerts', 'HTTP 502']] });
    expect(lines[1]).toEqual({ text: "Couldn't fetch missed messages: alerts (HTTP 502)", level: 'warning' });
  });
});
