// Regression tests for the findings of the Codex review (numbers as in that review). Each one failed
// before its fix. Deterministic: no random timing decides the outcome.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MAX_HISTORY_PER_TOPIC, getHistoryState, getTopicSyncStates, recordMessage } from '@/utils/history';
import { handlePopupRequest } from '@/utils/messages';
import { encodeHeaderValue, isNoResponse, sendAttachment, type NtfyMessage } from '@/utils/ntfy';
import { createReceiver } from '@/utils/receiver';
import { parseTopicRules, ruleFor, storedTopicRules } from '@/utils/rules';
import { withFallback } from '@/utils/servers';
import { FakeStream, installFakeNtfy, sleep, type FakeServer } from './helpers/fake-ntfy';

let server: FakeServer;
let notified: string[];

const newReceiver = () => createReceiver({ onNewMessage: (message) => notified.push(message.id) });
const lastStream = () => FakeStream.instances.at(-1)!;
const path = (url: string) => new URL(url).pathname;

async function configure(topics: string) {
  await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics });
  await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
}

beforeEach(() => {
  fakeBrowser.reset();
  server = installFakeNtfy();
  notified = [];
});

describe('#1 catch-up after a reconnect', () => {
  it('fetches a message missed while disconnected although a newer live message arrived first', async () => {
    await configure('alerts');
    server.publish('alerts', 100);
    const receiver = newReceiver();
    await receiver.sync(); // first, silent sync: watermark 100

    const missed = server.publish('alerts', 150); // published while the stream was down
    const live = server.publish('alerts', 200);
    let releasePolls!: () => void;
    server.pollGate = new Promise((resolve) => (releasePolls = resolve));
    await receiver.connect();
    lastStream().accept(); // starts the catch-up poll, held by the gate
    await lastStream().deliver(live); // arrives before the reconnect's poll
    releasePolls();
    await receiver.sync();

    expect(notified.sort()).toEqual([missed.id, live.id].sort());
    expect((await getTopicSyncStates()).get('alerts')?.since).toBe(200);
    receiver.close();
  });
});

describe('#4 sync state and history are written together', () => {
  it('stores a message on retry after a failed write instead of treating it as seen', async () => {
    const message: NtfyMessage = { id: 'm1', event: 'message', topic: 'alerts', time: 1 };
    // The first write fails; later ones go through to the real storage
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementationOnce(() => Promise.reject(new Error('quota')));
    await expect(recordMessage(message)).rejects.toThrow('quota');

    expect(await recordMessage(message)).toBe(true);
    expect((await getHistoryState()).receivedNotifications.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('#5 many messages in the same second', () => {
  it('notifies each of 250 messages with one timestamp once, however often it polls', async () => {
    await configure('alerts');
    const receiver = newReceiver();
    await receiver.sync(); // first, silent sync
    const burst = Array.from({ length: 250 }, () => server.publish('alerts', 5000));
    for (let i = 0; i < 4; i++) await receiver.sync();
    expect(notified).toHaveLength(250);
    expect(new Set(notified)).toEqual(new Set(burst.map((m) => m.id)));
  });
});

describe('#6 a connect started before a settings change', () => {
  it("doesn't subscribe with the old settings", async () => {
    await configure('alerts');
    let release!: () => void;
    server.authGate = new Promise((resolve) => (release = resolve));
    const receiver = newReceiver();
    const stale = receiver.connect(); // waits on the read-access check

    await fakeBrowser.storage.sync.set({ apiUrl: '' }); // the server is removed
    await receiver.connect();
    release();
    await stale;
    expect(FakeStream.instances).toEqual([]);
  });
});

describe('#7 read access revoked for one topic', () => {
  it('checks access again after a refused subscription, and keeps receiving the other topics', async () => {
    await configure('alerts,inbox');
    const receiver = newReceiver();
    await receiver.connect();
    expect(path(lastStream().url)).toBe('/alerts,inbox/json');

    server.unreadable = ['inbox'];
    lastStream().refuse(403); // refused before it opened
    await sleep(10);
    await receiver.connect();
    expect(path(lastStream().url)).toBe('/alerts/json');
    receiver.close();
  });
});

describe('#8 the history limit keeps the newest messages by time', () => {
  it("doesn't let a late older message push out a newer one", async () => {
    for (let i = 0; i < MAX_HISTORY_PER_TOPIC; i++) {
      await recordMessage({ id: `new${i}`, event: 'message', topic: 'alerts', time: 1000 + i });
    }
    await recordMessage({ id: 'late', event: 'message', topic: 'alerts', time: 1 });
    const ids = (await getHistoryState()).receivedNotifications.map((m) => m.id);
    expect(ids).toHaveLength(MAX_HISTORY_PER_TOPIC);
    expect(ids).not.toContain('late');
    expect(ids[0]).toBe(`new${MAX_HISTORY_PER_TOPIC - 1}`);
  });
});

describe('#9 multi-line text in headers', () => {
  it('sends an attachment with a multi-line message (RFC 2047-encoded)', async () => {
    expect(Buffer.from(encodeHeaderValue('line 1\nline 2').slice(10, -2), 'base64').toString()).toBe('line 1\nline 2');
    await expect(
      sendAttachment({ apiUrl: 'https://ntfy.example', accessToken: 'tk_x' }, 'inbox', {
        data: new Uint8Array(1),
        filename: 'a.txt',
        message: 'line 1\nline 2',
      }),
    ).resolves.toBeDefined();
  });
});

describe('#11 topic names that are Object.prototype properties', () => {
  it('records messages and keeps rules for topics named constructor and __proto__', async () => {
    for (const topic of ['constructor', '__proto__', 'toString']) {
      expect(await recordMessage({ id: `m-${topic}`, event: 'message', topic, time: 1 })).toBe(true);
    }
    expect([...(await getTopicSyncStates()).keys()].sort()).toEqual(['__proto__', 'constructor', 'toString']);

    const rules = parseTopicRules(storedTopicRules(new Map([['__proto__', 'off']])));
    expect(ruleFor(rules, '__proto__')).toBe('off');
    expect(ruleFor(rules, 'constructor')).toBe('all');
  });
});

describe('#12 read and delete actions from several views', () => {
  it('applies concurrent actions one after the other, so none is lost', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: ['a', 'b', 'c', 'd'].map((id) => ({ id, event: 'message', topic: 'alerts', time: 1 })),
    });
    await Promise.all([
      handlePopupRequest({ action: 'setRead', ids: ['a'], read: true }, async () => {}),
      handlePopupRequest({ action: 'setRead', ids: ['b'], read: true }, async () => {}),
      handlePopupRequest({ action: 'delete', ids: ['c'] }, async () => {}),
      handlePopupRequest({ action: 'delete', ids: ['d'] }, async () => {}),
    ]);
    const { readMessageIds, deletedMessageIds } = await getHistoryState();
    expect(readMessageIds.sort()).toEqual(['a', 'b']);
    expect(deletedMessageIds.sort()).toEqual(['c', 'd']);
  });

  it('ignores malformed requests', () => {
    expect(handlePopupRequest({ action: 'delete', ids: [1] }, async () => {})).toBeNull();
    expect(handlePopupRequest({ action: 'setRead', ids: ['a'] }, async () => {})).toBeNull();
    expect(handlePopupRequest(null, async () => {})).toBeNull();
  });
});

describe('draft cleanup from several views', () => {
  it('clears the sent revision only if it is still current', async () => {
    const sync = async () => {};
    const draft = { title: '', message: 'Sending this', topic: 'alerts', tags: [], priority: 3, revision: 'first' };
    const next = { ...draft, message: 'Draft from a second view', revision: 'second' };
    await handlePopupRequest({ action: 'saveDraft', draft }, sync);
    await Promise.all([
      handlePopupRequest({ action: 'saveDraft', draft: next }, sync),
      handlePopupRequest({ action: 'clearDraft', revision: 'first' }, sync),
    ]);
    expect(await fakeBrowser.storage.local.get('draftState')).toEqual({ draftState: next });
    await handlePopupRequest({ action: 'clearDraft', revision: 'second' }, sync);
    expect(await fakeBrowser.storage.local.get('draftState')).toEqual({});
  });
});

describe('#13 requests that never answer', () => {
  it('gives every request a time limit, and retries a send on the fallback after one', async () => {
    await configure('alerts');
    await newReceiver().sync();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);

    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    expect(isNoResponse(timeout)).toBe(true);
    const servers: string[] = [];
    await withFallback({ apiUrl: 'https://main.example', fallbackUrl: 'https://fallback.example', accessToken: '' }, async (s) => {
      servers.push(s.apiUrl);
      if (s.apiUrl === 'https://main.example') throw timeout;
    });
    expect(servers).toEqual(['https://main.example', 'https://fallback.example']);
  });
});
