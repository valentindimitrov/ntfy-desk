// Received messages, read and deleted ids, and the per-topic sync state, all in storage.local. The
// background is their only writer: the live socket, the catch-up polls and the popup's read and
// delete actions (sent as messages) all go through one queue, so no update overwrites another.

import { browser } from 'wxt/browser';
import { parseMessage, type NtfyMessage } from './ntfy';

/** Received messages kept per topic, so a busy topic doesn't push the others out */
export const MAX_HISTORY_PER_TOPIC = 100;
/** Size of all kept messages together, at most (JSON characters); the oldest go first */
export const MAX_HISTORY_SIZE = 8 * 1024 * 1024;
/** Safety cap of a topic's seen ids, if its polls keep failing and live messages keep coming */
const MAX_SEEN_PER_TOPIC = 5000;
/**
 * Deleted ids kept, newest last. They only matter while a deleted message can still come back from a
 * poll (a topic's first, 24 h sync), so old ones can go.
 */
export const MAX_DELETED_IDS = 1000;

/** A topic's sync state */
export interface TopicSyncState {
  topic: string;
  /**
   * Catch-up watermark: the newest message time that a completed poll covered, and the next poll's
   * since= (inclusive). Only polls move it, never live messages: a live message newer than messages
   * missed while disconnected must not let the next poll skip them. null until a poll returns one.
   */
  since: number | null;
  /** Id and time of every message recorded at or after `since`, to skip those a poll returns again */
  seen: [id: string, time: number][];
  /** The first poll (silent: it loads recent history without notifications) completed */
  synced: boolean;
}

/** Sync states by topic. A Map, so any topic name is a plain key (even "__proto__" or "constructor") */
export type TopicSyncStates = Map<string, TopicSyncState>;

export interface HistoryState {
  receivedNotifications: NtfyMessage[];
  readMessageIds: string[];
  deletedMessageIds: string[];
}

const SYNC_KEY = 'topicSync';

let storageQueue: Promise<unknown> = Promise.resolve();
/** Run storage updates one at a time */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = storageQueue.then(task);
  storageQueue = run.catch(() => {});
  return run;
}

/** Stored as a list of states rather than an object keyed by topic (see TopicSyncStates) */
export async function getTopicSyncStates(): Promise<TopicSyncStates> {
  const { [SYNC_KEY]: stored } = await browser.storage.local.get([SYNC_KEY]);
  const states: TopicSyncStates = new Map();
  if (Array.isArray(stored)) {
    for (const state of stored as TopicSyncState[]) {
      if (state && typeof state.topic === 'string') {
        states.set(state.topic, {
          topic: state.topic,
          since: state.since ?? null,
          seen: Array.isArray(state.seen) ? state.seen : [],
          synced: state.synced === true,
        });
      }
    }
  }
  return states;
}

const storedStates = (states: TopicSyncStates) => ({ [SYNC_KEY]: [...states.values()] });

export async function getHistoryState(): Promise<HistoryState> {
  const result = await browser.storage.local.get(['receivedNotifications', 'readMessageIds', 'deletedMessageIds']);
  const stored: unknown = result.receivedNotifications;
  return {
    // Checked again on reading: messages stored by an earlier version weren't validated
    receivedNotifications: Array.isArray(stored) ? stored.map(parseMessage).filter((m): m is NtfyMessage => m !== null) : [],
    readMessageIds: (result.readMessageIds as string[] | undefined) ?? [],
    deletedMessageIds: (result.deletedMessageIds as string[] | undefined) ?? [],
  };
}

/**
 * The newest MAX_HISTORY_PER_TOPIC messages of each topic by server time, newest first, up to
 * MAX_HISTORY_SIZE in all. Ordering by time (not by arrival) keeps a late older message from pushing
 * out a newer one.
 */
export function trimHistory(messages: NtfyMessage[]): NtfyMessage[] {
  const counts = new Map<string, number>();
  let size = 0;
  return [...messages]
    .sort((a, b) => b.time - a.time)
    .filter((message) => {
      const count = (counts.get(message.topic) ?? 0) + 1;
      counts.set(message.topic, count);
      if (count > MAX_HISTORY_PER_TOPIC) return false;
      size += JSON.stringify(message).length;
      return size <= MAX_HISTORY_SIZE;
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

function newState(topic: string): TopicSyncState {
  return { topic, since: null, seen: [], synced: false };
}

/** Seen entries that still matter: at or after the watermark (polls are inclusive), capped */
function pruneSeen(state: TopicSyncState): void {
  const since = state.since;
  const kept = since === null ? state.seen : state.seen.filter(([, time]) => time >= since);
  state.seen = kept.slice(-MAX_SEEN_PER_TOPIC);
}

/**
 * Record a message from the socket or a poll. Resolves to true if it is new to the history (not seen
 * before and not deleted), which is when a desktop notification is due. The sync state and the
 * history are written together, so a failed write can't mark a message seen without storing it.
 */
export function recordMessage(message: NtfyMessage): Promise<boolean> {
  return serialized(async () => {
    const [states, history] = await Promise.all([getTopicSyncStates(), getHistoryState()]);
    const state = states.get(message.topic) ?? newState(message.topic);
    if (state.seen.some(([id]) => id === message.id)) {
      return false;
    }
    state.seen.push([message.id, message.time]);
    pruneSeen(state);
    states.set(message.topic, state);

    const isNew = !history.deletedMessageIds.includes(message.id) && !history.receivedNotifications.some((n) => n.id === message.id);
    const receivedNotifications = isNew ? trimHistory([message, ...history.receivedNotifications]) : history.receivedNotifications;
    const pruned = pruneReadState({ ...history, receivedNotifications });
    await browser.storage.local.set({ ...storedStates(states), receivedNotifications, ...pruned });
    return isNew;
  });
}

/**
 * A topic's poll completed: mark the topic synced and move its watermark to the newest message the
 * poll returned (messages recorded meanwhile by the socket are newer or seen, so nothing is skipped).
 */
export function completePoll(topic: string, newestTime: number | null): Promise<void> {
  return serialized(async () => {
    const states = await getTopicSyncStates();
    const state = states.get(topic) ?? newState(topic);
    state.synced = true;
    if (newestTime !== null && (state.since === null || newestTime > state.since)) {
      state.since = newestTime;
    }
    pruneSeen(state);
    states.set(topic, state);
    await browser.storage.local.set(storedStates(states));
  });
}

/** Forget removed topics, so adding one back starts with a silent sync again */
export function pruneTopicSyncStates(topics: string[]): Promise<void> {
  return serialized(async () => {
    const states = await getTopicSyncStates();
    const stale = [...states.keys()].filter((topic) => !topics.includes(topic));
    if (stale.length > 0) {
      stale.forEach((topic) => states.delete(topic));
      await browser.storage.local.set(storedStates(states));
    }
  });
}

/** Read actions from the popup: mark messages read or unread */
export function setRead(ids: string[], read: boolean): Promise<void> {
  return serialized(async () => {
    const { readMessageIds } = await getHistoryState();
    const updated = read ? [...new Set([...readMessageIds, ...ids])] : readMessageIds.filter((id) => !ids.includes(id));
    await browser.storage.local.set({ readMessageIds: updated });
  });
}

/** Delete actions from the popup: hide messages (kept as deleted ids so polls don't bring them back) */
export function deleteMessages(ids: string[]): Promise<void> {
  return serialized(async () => {
    const history = await getHistoryState();
    const deletedMessageIds = [...new Set([...history.deletedMessageIds, ...ids])];
    const readMessageIds = history.readMessageIds.filter((id) => !ids.includes(id));
    await browser.storage.local.set(pruneReadState({ ...history, deletedMessageIds, readMessageIds }));
  });
}
