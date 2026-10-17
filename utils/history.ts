// Received messages (storage.local) and the per-topic sync state that keeps each message from
// being stored or notified twice.

import { browser } from 'wxt/browser';
import type { NtfyMessage } from './ntfy';

/** Received messages kept per topic, so a busy topic doesn't push the others out */
export const MAX_HISTORY_PER_TOPIC = 100;
export const MAX_SEEN_IDS_PER_TOPIC = 200;
/**
 * Deleted ids kept, newest last. They only matter while a deleted message can still come back from a
 * poll (a topic's first, 24 h sync), so old ones can go.
 */
export const MAX_DELETED_IDS = 1000;

/**
 * Per topic: the server time of the newest message seen (the next poll's since=, inclusive) and the
 * ids of the latest messages, to skip the ones a poll returns again. since is null until the
 * topic's first message.
 */
export interface TopicSyncState {
  since: number | null;
  ids: string[];
}

export type TopicSyncStates = Record<string, TopicSyncState>;

export interface HistoryState {
  receivedNotifications: NtfyMessage[];
  readMessageIds: string[];
  deletedMessageIds: string[];
}

// The live socket and the catch-up poll both read-modify-write the history and the sync state.
// Run those updates one at a time so neither overwrites the other's.
let storageQueue: Promise<unknown> = Promise.resolve();
export function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = storageQueue.then(task);
  storageQueue = run.catch(() => {});
  return run;
}

export async function getTopicSyncStates(): Promise<TopicSyncStates> {
  const { topicSyncState } = await browser.storage.local.get(['topicSyncState']);
  return (topicSyncState as TopicSyncStates | undefined) ?? {};
}

export async function getHistoryState(): Promise<HistoryState> {
  const result = await browser.storage.local.get(['receivedNotifications', 'readMessageIds', 'deletedMessageIds']);
  return {
    receivedNotifications: (result.receivedNotifications as NtfyMessage[] | undefined) ?? [],
    readMessageIds: (result.readMessageIds as string[] | undefined) ?? [],
    deletedMessageIds: (result.deletedMessageIds as string[] | undefined) ?? [],
  };
}

/** Keep the newest MAX_HISTORY_PER_TOPIC messages of each topic (the history is newest first) */
export function trimHistory(messages: NtfyMessage[]): NtfyMessage[] {
  const counts = new Map<string, number>();
  return messages.filter((message) => {
    const count = (counts.get(message.topic) ?? 0) + 1;
    counts.set(message.topic, count);
    return count <= MAX_HISTORY_PER_TOPIC;
  });
}

/**
 * The read and deleted id lists without ids that no longer matter: read ids of messages no longer in
 * the history, and all but the newest MAX_DELETED_IDS deleted ids.
 */
export function pruneReadState({
  receivedNotifications,
  readMessageIds,
  deletedMessageIds,
}: HistoryState): Pick<HistoryState, 'readMessageIds' | 'deletedMessageIds'> {
  const inHistory = new Set(receivedNotifications.map((message) => message.id));
  return {
    readMessageIds: readMessageIds.filter((id) => inHistory.has(id)),
    deletedMessageIds: deletedMessageIds.slice(-MAX_DELETED_IDS),
  };
}

/** Messages not deleted and not read */
export function countUnread({ receivedNotifications, readMessageIds, deletedMessageIds }: HistoryState): number {
  return receivedNotifications.filter((n) => !deletedMessageIds.includes(n.id) && !readMessageIds.includes(n.id)).length;
}

/** Resolves to true if the message was added, false if it was already there or deleted */
async function saveToHistory(message: NtfyMessage): Promise<boolean> {
  const { receivedNotifications, deletedMessageIds } = await getHistoryState();
  if (deletedMessageIds.includes(message.id) || receivedNotifications.some((n) => n.id === message.id)) {
    return false;
  }
  const history = trimHistory([message, ...receivedNotifications]);
  await browser.storage.local.set({ receivedNotifications: history });
  return true;
}

/**
 * Record a message from the socket or a poll. Resolves to true if it is new to the history (not
 * seen before and not deleted), which is when a desktop notification is due.
 */
export function recordMessage(message: NtfyMessage): Promise<boolean> {
  return serialized(async () => {
    const states = await getTopicSyncStates();
    const state = states[message.topic] ?? { since: null, ids: [] };
    if (state.ids.includes(message.id)) {
      return false;
    }

    state.ids = [...state.ids, message.id].slice(-MAX_SEEN_IDS_PER_TOPIC);
    if (state.since === null || message.time > state.since) {
      state.since = message.time;
    }
    states[message.topic] = state;
    await browser.storage.local.set({ topicSyncState: states });

    return saveToHistory(message);
  });
}

/** Mark a topic as synced once, so its next poll notifies (its first sync is silent) */
export function initTopicSyncState(topic: string): Promise<void> {
  return serialized(async () => {
    const states = await getTopicSyncStates();
    if (!states[topic]) {
      states[topic] = { since: null, ids: [] };
      await browser.storage.local.set({ topicSyncState: states });
    }
  });
}

/** Forget removed topics, so adding one back starts with a silent sync again */
export function pruneTopicSyncStates(topics: string[]): Promise<void> {
  return serialized(async () => {
    const states = await getTopicSyncStates();
    const stale = Object.keys(states).filter((topic) => !topics.includes(topic));
    if (stale.length > 0) {
      stale.forEach((topic) => delete states[topic]);
      await browser.storage.local.set({ topicSyncState: states });
    }
  });
}
