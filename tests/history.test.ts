import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  MAX_DELETED_IDS,
  MAX_HISTORY_PER_TOPIC,
  getHistoryState,
  pruneReadState,
  recordMessage,
  recordPoll,
  trimHistory,
} from '@/utils/history';
import type { NtfyMessage } from '@/utils/ntfy';

const message = (id: string, topic: string, time = 1): NtfyMessage => ({ id, event: 'message', topic, time });

beforeEach(() => {
  fakeBrowser.reset();
});

describe('history limit', () => {
  it('keeps the newest messages of each topic, so a busy topic does not push the others out', async () => {
    await recordMessage(message('quiet-1', 'quiet'));
    for (let i = 0; i < MAX_HISTORY_PER_TOPIC + 20; i++) {
      await recordMessage(message(`busy-${i}`, 'busy', i));
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
    await recordPoll('alerts', [deletion('fallback-delete', 5)], { origin: fallback, origins });
    expect(await historyIds()).toEqual([]);

    await recordPoll('alerts', [publish('other', 3)], { origin: other, origins: [other] });
    expect(await historyIds()).toEqual(['other']);
  });

  it('requires a matching publish to attribute originless history before deletion', async () => {
    await recordMessage(publish('legacy', 4));
    const source = { origin: main, origins };
    await recordMessage(deletion('delete', 5), source);
    expect(await historyIds()).toEqual(['legacy']);

    await recordPoll('alerts', [publish('legacy', 4), deletion('delete', 5)], source);
    expect(await historyIds()).toEqual([]);
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
});
