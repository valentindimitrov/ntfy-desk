// Regression tests for the findings of the Codex security review (numbers as in that review). Each
// one failed before its fix.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MAX_HISTORY_SIZE, MAX_POLL_EVENTS, getHistoryState, recordMessage, trimHistory } from '@/utils/history';
import {
  AUTH_ORIGINS_KEY,
  MAX_MESSAGE_JSON,
  getConfig,
  getNotifications,
  parseMessage,
  parseMessageJson,
  sendNotification,
  setAuthOrigins,
  splitCredentials,
  type NtfyMessage,
} from '@/utils/ntfy';
import { createReceiver } from '@/utils/receiver';
import { describeStatus, INITIAL_STATUS } from '@/utils/status';
import { FakeStream, installFakeNtfy, type FakeServer } from './helpers/fake-ntfy';

let server: FakeServer;

beforeEach(() => {
  fakeBrowser.reset();
  server = installFakeNtfy();
});

describe('#1 credentials are bound to the servers approved on this device', () => {
  beforeEach(async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.lan', fallbackUrl: 'https://ntfy.example.com', topics: 'a' });
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
  });

  it('approves the current servers once, for settings saved by an earlier version', async () => {
    expect(await getConfig()).toMatchObject({ accessToken: 'tk_x', heldBackFrom: [] });
    expect(await fakeBrowser.storage.local.get(AUTH_ORIGINS_KEY)).toEqual({
      [AUTH_ORIGINS_KEY]: ['https://ntfy.lan', 'https://ntfy.example.com'],
    });
  });

  it("doesn't send the token to a server URL changed through sync, until it is approved", async () => {
    await getConfig();
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://evil.example' });
    const config = await getConfig();
    expect(config).toMatchObject({ accessToken: '', credentials: null, heldBackFrom: ['https://evil.example'] });

    await sendNotification(config, 'a', { message: 'x' });
    expect(server.requests.at(-1)).toEqual({ url: 'https://evil.example/a', auth: null });

    await setAuthOrigins(['https://evil.example', 'https://ntfy.example.com']);
    expect(await getConfig()).toMatchObject({ accessToken: 'tk_x', heldBackFrom: [] });
  });

  it('holds back the username and password too, and the fallback when only it changed', async () => {
    await fakeBrowser.storage.local.set({ accessToken: '', serverCredentials: { username: 'u', password: 'p' } });
    await getConfig();
    await fakeBrowser.storage.sync.set({ fallbackUrl: 'https://other.example' });
    expect(await getConfig()).toMatchObject({ credentials: null, heldBackFrom: ['https://other.example'] });
  });

  it('reports a held-back token in the Receive tab', async () => {
    await getConfig();
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://evil.example' });
    const receiver = createReceiver({ onNewMessage: () => {} });
    await receiver.connect();
    const status = (await fakeBrowser.storage.session.get('receiverStatus')).receiverStatus as typeof INITIAL_STATUS;
    expect(status.authHeldBack).toBe(true);
    expect(FakeStream.instances.at(-1)?.auth).toBeNull();
    expect(describeStatus(status).map((line) => line.text)).toContain(
      'Token and password not sent: the server address changed. Confirm it in the settings',
    );
    receiver.close();
  });
});

describe('#2 removing credentials keeps the host the URL parser sees', () => {
  it('cleans a URL whose @ comes after a backslash with the URL parser', () => {
    const tricky = `https://u:p@trusted.example${String.fromCharCode(92)}path@evil.example`;
    expect(new URL(tricky).host).toBe('trusted.example');
    const { url, credentials } = splitCredentials(tricky);
    expect(new URL(url).host).toBe('trusted.example');
    expect(url).not.toContain('u:p');
    expect(credentials).toEqual({ username: 'u', password: 'p' });
  });
});

describe('#3 malformed messages from the server', () => {
  it('drops fields of the wrong type, and messages without an id, topic or time', () => {
    const raw = { id: 'm1', event: 'message', topic: 'a', time: 1, actions: {}, tags: 'x', priority: 9, attachment: 'y', extra: 1 };
    expect(parseMessage(raw)).toEqual({ id: 'm1', event: 'message', topic: 'a', time: 1 });
    expect(parseMessage({ ...raw, id: 5 })).toBeNull();
    expect(parseMessage({ ...raw, topic: 'x'.repeat(65) })).toBeNull();
    expect(parseMessage({ ...raw, time: '1' })).toBeNull();
    expect(parseMessage(null)).toBeNull();
  });

  it('keeps valid actions and attachments, and leaves out invalid actions', () => {
    const parsed = parseMessage({
      id: 'm1',
      event: 'message',
      topic: 'a',
      time: 1,
      actions: [{ action: 'view', label: 'Open', url: 'https://x.example', clear: true }, { label: 'no action' }, 'junk'],
      attachment: { name: 'a.png', url: 'https://ntfy.example/file/a.png', size: 'big' },
    });
    expect(parsed?.actions).toEqual([{ action: 'view', label: 'Open', url: 'https://x.example', clear: true }]);
    expect(parsed?.attachment).toEqual({ name: 'a.png', url: 'https://ntfy.example/file/a.png' });
  });

  it('cleans messages stored by an earlier version when reading them', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [{ id: 'bad', event: 'message', topic: 'a', time: 1, actions: {} }, { id: 'no-time' }, 'junk'],
    });
    expect((await getHistoryState()).receivedNotifications).toEqual([{ id: 'bad', event: 'message', topic: 'a', time: 1 }]);
  });
});

describe('#4 a hostile server cannot fill storage', () => {
  it('ignores live messages of topics that are not subscribed', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics: 'alerts' });
    const receiver = createReceiver({ onNewMessage: () => {} });
    await receiver.connect();
    const stream = FakeStream.instances.at(-1)!;
    stream.accept();
    await stream.deliver({ id: 'x1', event: 'message', topic: 'invented', time: 1 });
    await stream.deliver({ id: 'a1', event: 'message', topic: 'alerts', time: 1 });
    expect((await getHistoryState()).receivedNotifications.map((m) => m.id)).toEqual(['a1']);
    receiver.close();
  });

  it('keeps only messages of the polled topic, and rejects oversized lines and responses', async () => {
    const line = (message: object) => JSON.stringify(message);
    const body = [
      line({ id: 'a1', event: 'message', topic: 'a', time: 1 }),
      line({ id: 'b1', event: 'message', topic: 'b', time: 1 }),
      line({ id: 'big', event: 'message', topic: 'a', time: 1, message: 'x'.repeat(MAX_MESSAGE_JSON) }),
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    expect((await getNotifications({ apiUrl: 'https://ntfy.example', accessToken: '' }, 'a', 0)).map((m) => m.id)).toEqual(['a1']);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(5 * 1024 * 1024))),
    );
    await expect(getNotifications({ apiUrl: 'https://ntfy.example', accessToken: '' }, 'a', 0)).rejects.toThrow('Response too large');
  });

  it('handles the newest MAX_POLL_EVENTS of a poll only', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics: 'a' });
    for (let i = 0; i < MAX_POLL_EVENTS + 5; i++) server.publish('a', 10000 + i);
    const notified: string[] = [];
    const receiver = createReceiver({ onNewMessage: (m) => notified.push(m.id) });
    await receiver.sync(); // first, silent sync
    await fakeBrowser.storage.local.set({ topicSync: [{ topic: 'a', since: 1, seen: [], synced: true }] });
    await fakeBrowser.storage.local.remove(['receivedNotifications']);
    await receiver.sync();
    expect(notified).toHaveLength(MAX_POLL_EVENTS);
    expect(notified).not.toContain('m1');
  });

  it('caps the size of the history, dropping the oldest messages first', () => {
    const big = 'x'.repeat(MAX_MESSAGE_JSON - 200);
    const messages: NtfyMessage[] = Array.from({ length: 400 }, (_, i) => ({
      id: `m${i}`,
      event: 'message',
      topic: `t${i % 10}`,
      time: i,
      message: big,
    }));
    const kept = trimHistory(messages);
    expect(kept.reduce((size, m) => size + JSON.stringify(m).length, 0)).toBeLessThanOrEqual(MAX_HISTORY_SIZE);
    expect(kept[0]?.id).toBe('m399');
    expect(kept.some((m) => m.id === 'm0')).toBe(false);
  });

  it('parses one stream or poll line with the same checks', async () => {
    expect(parseMessageJson('not json')).toBeNull();
    expect(parseMessageJson(JSON.stringify({ id: 'm', event: 'message', topic: 'a', time: 1 }))).not.toBeNull();
    expect(await recordMessage({ id: 'ok', event: 'message', topic: 'a', time: 1 })).toBe(true);
  });
});

describe('#7 a malformed escape in a synced URL', () => {
  it("doesn't stop the move of the credentials out of storage.sync", async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://user:bad%@ntfy.example', topics: 'a' });
    const config = await getConfig();
    expect(config.apiUrl).toBe('https://ntfy.example');
    expect(config.credentials).toEqual({ username: 'user', password: 'bad%' });
    expect(JSON.stringify(await fakeBrowser.storage.sync.get(null))).not.toContain('bad');
  });
});

describe('redirects of authenticated requests', () => {
  it('refuses them when the request carries credentials, and follows them otherwise', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return new Response('');
      }),
    );
    await sendNotification({ apiUrl: 'https://ntfy.example', accessToken: 'tk_x' }, 'a', { message: 'x' });
    await getNotifications({ apiUrl: 'https://ntfy.example', accessToken: 'tk_x' }, 'a', 0);
    await sendNotification({ apiUrl: 'https://ntfy.example', accessToken: '' }, 'a', { message: 'x' });
    expect(calls.map((init) => init.redirect)).toEqual(['error', 'error', 'follow']);
  });
});

describe('#1 approval without a server yet', () => {
  it('approves the first server URL when the token was saved before it', async () => {
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
    expect((await getConfig()).heldBackFrom).toEqual([]);
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics: 'a' });
    expect(await getConfig()).toMatchObject({ accessToken: 'tk_x', heldBackFrom: [] });
  });
});
