import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MAX_DELETED_IDS, MAX_HISTORY_PER_TOPIC, getHistoryState, pruneReadState, recordMessage, trimHistory } from '@/utils/history';
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
    const busy = receivedNotifications.filter(m => m.topic === 'busy');
    expect(busy).toHaveLength(MAX_HISTORY_PER_TOPIC);
    expect(busy[0]!.id).toBe(`busy-${MAX_HISTORY_PER_TOPIC + 19}`); // newest first
    expect(busy.at(-1)!.id).toBe('busy-20');
    expect(receivedNotifications.some(m => m.id === 'quiet-1')).toBe(true);
  });

  it('trims per topic without reordering', () => {
    const messages = Array.from({ length: MAX_HISTORY_PER_TOPIC + 1 }, (_, i) => message(`a${i}`, 'a'));
    const trimmed = trimHistory([message('b0', 'b'), ...messages]);
    expect(trimmed[0]!.id).toBe('b0');
    expect(trimmed.filter(m => m.topic === 'a')).toHaveLength(MAX_HISTORY_PER_TOPIC);
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
