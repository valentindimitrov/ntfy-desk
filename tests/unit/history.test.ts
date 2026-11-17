import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  MAX_DELETED_IDS,
  MAX_HISTORY_SIZE,
  applyHistoryLimit,
  countUnread,
  deleteMessages,
  getHistoryState,
  pruneReadState,
  recordMessage,
  recordPoll,
  setRead,
  trimHistory,
  type StoredMessage,
} from '@/utils/history';
import { DEFAULT_HISTORY_PER_TOPIC } from '@/utils/preferences';

const server = 'https://ntfy.example';
const defaultSource = { origin: server, origins: [server] };
const message = (id: string, topic: string, time = 1): StoredMessage => ({ id, event: 'message', topic, time, serverOrigin: server });

beforeEach(() => {
  fakeBrowser.reset();
});

describe('history limit', () => {
  it('keeps the newest messages of each topic, so a busy topic does not push the others out', async () => {
    await recordMessage(message('quiet-1', 'quiet'), defaultSource);
    for (let i = 0; i < DEFAULT_HISTORY_PER_TOPIC + 20; i++) {
      await recordMessage(message(`busy-${i}`, 'busy', i), defaultSource);
    }
    const { receivedNotifications } = await getHistoryState();
    const busy = receivedNotifications.filter((m) => m.topic === 'busy');
    expect(busy).toHaveLength(DEFAULT_HISTORY_PER_TOPIC);
    expect(busy[0]!.id).toBe(`busy-${DEFAULT_HISTORY_PER_TOPIC + 19}`); // newest first
    expect(busy.at(-1)!.id).toBe('busy-20');
    expect(receivedNotifications.some((m) => m.id === 'quiet-1')).toBe(true);
  });

  it('trims per topic without reordering', () => {
    const messages = Array.from({ length: DEFAULT_HISTORY_PER_TOPIC + 1 }, (_, i) => message(`a${i}`, 'a'));
    const trimmed = trimHistory([message('b0', 'b'), ...messages]);
    expect(trimmed[0]!.id).toBe('b0');
    expect(trimmed.filter((m) => m.topic === 'a')).toHaveLength(DEFAULT_HISTORY_PER_TOPIC);
  });
});

describe('messages kept per topic (setting)', () => {
  const stored = async (topic: string) => (await getHistoryState()).receivedNotifications.filter((m) => m.topic === topic);
  const poll = (topic: string, count: number, firstTime = 1) =>
    recordPoll(
      topic,
      Array.from({ length: count }, (_, i) => message(`${topic}-${i}`, topic, firstTime + i)),
      defaultSource,
    );

  it.each([50, 250, 500])('keeps the newest %i messages of a topic', async (limit) => {
    await fakeBrowser.storage.sync.set({ historyPerTopic: limit });
    await poll('busy', limit + 30);
    const busy = await stored('busy');
    expect(busy).toHaveLength(limit);
    expect(busy[0]!.id).toBe(`busy-${limit + 29}`);
    expect(busy.at(-1)!.id).toBe('busy-30');
  });

  it('keeps 100 when the stored value is not one of the choices', async () => {
    await fakeBrowser.storage.sync.set({ historyPerTopic: 100000 });
    await poll('busy', 130);
    expect(await stored('busy')).toHaveLength(DEFAULT_HISTORY_PER_TOPIC);
  });

  it('still applies the overall size limit on top of 500 per topic', () => {
    const big = 'x'.repeat(30000);
    const messages = Array.from({ length: 500 }, (_, i) => ({ ...message(`m${i}`, 'a', i), message: big }));
    const kept = trimHistory(messages, 500);
    expect(kept.length).toBeLessThan(500);
    expect(kept.reduce((size, m) => size + JSON.stringify(m).length, 0)).toBeLessThanOrEqual(MAX_HISTORY_SIZE);
    expect(kept[0]!.id).toBe('m499');
  });

  it('trims every topic at once when the limit is lowered, with the read ids of the removed messages', async () => {
    await fakeBrowser.storage.sync.set({ historyPerTopic: 250 });
    await poll('a', 250);
    await poll('b', 60);
    await setRead(['a-0', 'a-249', 'b-0', 'b-59'], true);

    await fakeBrowser.storage.sync.set({ historyPerTopic: 50 });
    const removed = await applyHistoryLimit();
    expect(removed).toHaveLength(200 + 10);
    expect(removed).toContain('a-0');
    expect(removed).toContain('b-9');
    expect((await stored('a')).map((m) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => `a-${249 - i}`));
    expect(await stored('b')).toHaveLength(50);
    expect((await getHistoryState()).readMessageIds).toEqual(['a-249', 'b-59']);
  });

  it('removes nothing when the limit is raised, and a later poll does not bring trimmed messages back', async () => {
    await fakeBrowser.storage.sync.set({ historyPerTopic: 50 });
    await poll('a', 80, 1000);
    await fakeBrowser.storage.sync.set({ historyPerTopic: 500 });
    const write = vi.spyOn(fakeBrowser.storage.local, 'set');
    expect(await applyHistoryLimit()).toEqual([]);
    expect(write).not.toHaveBeenCalled();

    // The next poll is inclusive of the watermark: it returns the newest message again, and one new one
    await recordPoll('a', [message('a-79', 'a', 1079), message('new', 'a', 1080)], defaultSource);
    const ids = (await stored('a')).map((m) => m.id);
    expect(ids).toHaveLength(51);
    expect(ids[0]).toBe('new');
    expect(ids).not.toContain('a-29');
  });

  it('does not store trimmed messages of the newest dropped second again, but accepts a new one from that second', async () => {
    await fakeBrowser.storage.sync.set({ historyPerTopic: 50 });
    // 80 messages in one second: 30 are dropped, all at the time of the ones kept
    await recordPoll(
      'a',
      Array.from({ length: 80 }, (_, i) => message(`same-${i}`, 'a', 2000)),
      defaultSource,
    );
    const keptBefore = (await stored('a')).map((m) => m.id);
    const { topicSync } = await fakeBrowser.storage.local.get('topicSync');
    await fakeBrowser.storage.local.set({ topicSync: (topicSync as { seen: unknown[] }[]).map((state) => ({ ...state, seen: [] })) });
    await fakeBrowser.storage.sync.set({ historyPerTopic: 500 });

    const replay = [...Array.from({ length: 80 }, (_, i) => message(`same-${i}`, 'a', 2000)), message('fresh', 'a', 2000)];
    const { added } = await recordPoll('a', replay, defaultSource);
    expect(added.map(({ id }) => id)).toEqual(['fresh']);
    expect((await stored('a')).map((m) => m.id).sort()).toEqual([...keptBefore, 'fresh'].sort());
  });

  it('does not store trimmed messages again once their ids are forgotten and the limit is raised', async () => {
    await fakeBrowser.storage.sync.set({ historyPerTopic: 50 });
    await poll('a', 80, 1000);
    // The seen ids are lost (their cache is capped while polls keep failing)
    const { topicSync } = await fakeBrowser.storage.local.get('topicSync');
    await fakeBrowser.storage.local.set({ topicSync: (topicSync as { seen: unknown[] }[]).map((state) => ({ ...state, seen: [] })) });
    await fakeBrowser.storage.sync.set({ historyPerTopic: 500 });

    const { added } = await recordPoll('a', [message('a-10', 'a', 1010), message('late', 'a', 1079)], defaultSource);
    expect(added.map(({ id }) => id)).toEqual(['late']);
    expect((await stored('a')).map((m) => m.id)).not.toContain('a-10');
  });

  it('waits its turn behind a write in progress, so neither overwrites the other', async () => {
    await fakeBrowser.storage.sync.set({ historyPerTopic: 50 });
    const [, removed] = await Promise.all([poll('a', 80), applyHistoryLimit(), recordMessage(message('live', 'a', 5000), defaultSource)]);
    expect(removed).toEqual([]); // the poll's own write already applied the limit
    const ids = (await stored('a')).map((m) => m.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('live');
  });
});

describe('server deletion provenance', () => {
  const main = 'https://ntfy.example';
  const fallback = 'https://fallback.example';
  const other = 'https://other.example';
  const origins = [main, fallback];
  const publish = (id: string, time: number) => ({ ...message(id, 'alerts', time), sequence_id: 'deploy' });
  const deletion = (id: string, time: number) => ({ ...publish(id, time), event: 'message_delete' });
  const historyIds = async () => (await getHistoryState()).receivedNotifications.map(({ id }) => id);

  beforeEach(async () => {
    await fakeBrowser.storage.sync.set({ syncDeletionTopics: ['alerts'] });
  });

  it('shares deletions across fallback aliases and discards tombstones on a server switch', async () => {
    await recordMessage(publish('main', 4), { origin: main, origins });
    // The removed id is reported, so its desktop notification can be dismissed
    expect(await recordPoll('alerts', [deletion('fallback-delete', 5)], { origin: fallback, origins })).toEqual({
      added: [],
      removed: ['main'],
    });
    expect(await historyIds()).toEqual([]);

    await recordPoll('alerts', [publish('other', 3)], { origin: other, origins: [other] });
    expect(await historyIds()).toEqual(['other']);
  });

  it('leaves rows delivered by an unrelated server when the configured server deletes the sequence', async () => {
    await recordMessage(publish('elsewhere', 4), { origin: other, origins: [other] });
    await recordMessage(deletion('delete', 5), { origin: main, origins });
    expect(await historyIds()).toEqual(['elsewhere']);
  });

  it('drops stored rows without the origin that delivered them', async () => {
    const originless: Partial<StoredMessage> = message('originless', 'alerts');
    delete originless.serverOrigin;
    await fakeBrowser.storage.local.set({ receivedNotifications: [originless, message('kept', 'alerts')] });
    expect(await historyIds()).toEqual(['kept']);
  });
});

describe('updated messages (same sequence ID)', () => {
  const main = 'https://ntfy.example';
  const fallback = 'https://fallback.example';
  const other = 'https://other.example';
  const source = { origin: main, origins: [main, fallback] };
  const version = (id: string, time: number, sequence_id = 'deploy') => ({ ...message(id, 'alerts', time), sequence_id });
  const historyIds = async () => (await getHistoryState()).receivedNotifications.map(({ id }) => id);

  it('keeps only the updated message, also on topics without deletion sync, and reports the replaced one', async () => {
    await recordMessage(version('v1', 4), source);
    expect(await recordMessage(version('v2', 5), source)).toEqual({ added: [version('v2', 5)], removed: ['v1'] });
    expect(await historyIds()).toEqual(['v2']);
  });

  it('treats the main and fallback origins as one server, and leaves rows of an unrelated server', async () => {
    await recordMessage(version('v1', 4), source);
    await recordMessage(version('v2', 5), { origin: fallback, origins: [main, fallback] });
    expect(await historyIds()).toEqual(['v2']);

    await recordMessage(version('elsewhere', 6), { origin: other, origins: [other] });
    expect(await historyIds()).toEqual(['elsewhere', 'v2']);
  });

  it('drops an older version arriving late, without notifying it', async () => {
    await recordMessage(version('v2', 5), source);
    expect(await recordMessage(version('v1', 4), source)).toEqual({ added: [], removed: [] });
    expect(await recordPoll('alerts', [version('v1', 4), version('v2', 5)], source)).toEqual({ added: [], removed: [] });
    expect(await historyIds()).toEqual(['v2']);
  });

  it('orders versions of the same second by their position in a poll', async () => {
    await recordPoll('alerts', [], source); // first sync
    const result = await recordPoll('alerts', [version('v1', 5), version('v2', 5)], source);
    expect(result.added.map(({ id }) => id)).toEqual(['v2']);
    expect(await historyIds()).toEqual(['v2']);

    // A same-second row the poll did not return arrived live after it: the poll's version is older
    await recordMessage(version('v3', 6), source);
    await recordPoll('alerts', [version('v4', 6)], source);
    expect(await historyIds()).toEqual(['v3']);
    // A live version in the same second arrives after the stored one
    await recordMessage(version('v5', 6), source);
    expect(await historyIds()).toEqual(['v5']);
  });

  it('never merges messages without a sequence ID, which use their own id', async () => {
    await recordMessage(message('a', 'alerts', 5), source);
    await recordMessage(message('b', 'alerts', 5), source);
    expect((await historyIds()).sort()).toEqual(['a', 'b']);
  });

  it('shows an update of a locally deleted message, and keeps the deleted id suppressed', async () => {
    await recordMessage(version('v1', 4), source);
    await deleteMessages(['v1']);
    await recordMessage(version('v2', 5), source);
    await recordPoll('alerts', [version('v1', 4)], source);
    expect(await historyIds()).toEqual(['v2']);
  });
});

describe('read and deleted ids', () => {
  it('counts unread messages of every topic, or only of the topics that count', () => {
    const history = {
      receivedNotifications: [message('a1', 'a'), message('a2', 'a'), message('b1', 'b'), message('b2', 'b'), message('b3', 'b')],
      readMessageIds: ['a1'],
      deletedMessageIds: ['b1'],
    };
    expect(countUnread(history)).toBe(3);
    expect(countUnread(history, (topic) => topic !== 'b')).toBe(1);
  });

  it('drops read ids of messages no longer in the history, and old deleted ids', () => {
    const deleted = Array.from({ length: MAX_DELETED_IDS + 5 }, (_, i) => `d${i}`);
    const pruned = pruneReadState({
      receivedNotifications: [message('kept', 'a')],
      readMessageIds: ['kept', 'gone'],
      deletedMessageIds: deleted,
    });
    expect(pruned.readMessageIds).toEqual(['kept']);
    expect(pruned.deletedMessageIds).toHaveLength(MAX_DELETED_IDS);
    expect(pruned.deletedMessageIds[0]).toBe('d5'); // the oldest go first
  });

  it('removes a large bulk selection atomically and suppresses a later replay of every row', async () => {
    const removed = Array.from({ length: 1100 }, (_, i) => message(`deleted-${i}`, `topic-${i % 11}`));
    const kept = message('kept', 'other');
    await fakeBrowser.storage.local.set({
      receivedNotifications: [...removed, kept],
      readMessageIds: [removed[0]!.id, kept.id],
    });
    await deleteMessages(removed.map(({ id }) => id));
    expect(await getHistoryState()).toMatchObject({ receivedNotifications: [kept], readMessageIds: [kept.id] });

    const source = { origin: 'https://ntfy.example', origins: ['https://ntfy.example'] };
    for (let i = 0; i < 11; i++) {
      const topic = `topic-${i}`;
      await recordPoll(
        topic,
        removed.filter((row) => row.topic === topic),
        source,
      );
    }
    expect((await getHistoryState()).receivedNotifications).toEqual([kept]);
  });
});

describe('updates in a poll', () => {
  const version = (id: string, time: number) => ({ ...message(id, 'alerts', time), sequence_id: 'job' });
  const historyIds = async () => (await getHistoryState()).receivedNotifications.map(({ id }) => id);

  it('does not bring back an older version after the latest one was deleted here', async () => {
    await recordMessage(version('latest', 6), defaultSource);
    await deleteMessages(['latest']);
    // An overlapping poll returns the version missed while disconnected, then the deleted one
    const { added } = await recordPoll('alerts', [version('older', 5), version('latest', 6)], defaultSource);
    expect(added).toEqual([]);
    expect(await historyIds()).toEqual([]);
  });

  it('still stores a version published after the deleted one', async () => {
    await recordMessage(version('latest', 6), defaultSource);
    await deleteMessages(['latest']);
    await recordPoll('alerts', [version('latest', 6), version('newer', 7)], defaultSource);
    expect(await historyIds()).toEqual(['newer']);
  });

  it('never stores a publish that only gives a position', async () => {
    await recordPoll('alerts', [version('gone', 5), message('other', 'alerts', 5)], defaultSource, { positionOnly: ['gone'] });
    expect(await historyIds()).toEqual(['other']);
  });
});
