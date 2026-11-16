import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  MAX_DELETED_IDS,
  MAX_HISTORY_PER_TOPIC,
  deleteMessages,
  getHistoryState,
  pruneReadState,
  recordMessage,
  recordPoll,
  trimHistory,
  type StoredMessage,
} from '@/utils/history';

const server = 'https://ntfy.example';
const defaultSource = { origin: server, origins: [server] };
const message = (id: string, topic: string, time = 1): StoredMessage => ({ id, event: 'message', topic, time, serverOrigin: server });

beforeEach(() => {
  fakeBrowser.reset();
});

describe('history limit', () => {
  it('keeps the newest messages of each topic, so a busy topic does not push the others out', async () => {
    await recordMessage(message('quiet-1', 'quiet'), defaultSource);
    for (let i = 0; i < MAX_HISTORY_PER_TOPIC + 20; i++) {
      await recordMessage(message(`busy-${i}`, 'busy', i), defaultSource);
    }
    const { receivedNotifications } = await getHistoryState();
    const busy = receivedNotifications.filter((m) => m.topic === 'busy');
    expect(busy).toHaveLength(MAX_HISTORY_PER_TOPIC);
    expect(busy[0]!.id).toBe(`busy-${MAX_HISTORY_PER_TOPIC + 19}`); // newest first
    expect(busy.at(-1)!.id).toBe('busy-20');
    expect(receivedNotifications.some((m) => m.id === 'quiet-1')).toBe(true);
  });

  it('trims per topic without reordering', () => {
    const messages = Array.from({ length: MAX_HISTORY_PER_TOPIC + 1 }, (_, i) => message(`a${i}`, 'a'));
    const trimmed = trimHistory([message('b0', 'b'), ...messages]);
    expect(trimmed[0]!.id).toBe('b0');
    expect(trimmed.filter((m) => m.topic === 'a')).toHaveLength(MAX_HISTORY_PER_TOPIC);
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
