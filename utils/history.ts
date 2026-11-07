// Received messages, read and deleted ids, and the per-topic sync state, all in storage.local. The
// background is their only writer: the live stream, the catch-up polls and the popup's read and
// delete actions (sent as messages) all go through one queue, so no update overwrites another.

import { browser } from 'wxt/browser';
import { parseMessage, type NtfyMessage } from './ntfy';
import { getSyncDeletionTopics } from './sync-modes';

/** Received messages kept per topic, so a busy topic doesn't push the others out */
export const MAX_HISTORY_PER_TOPIC = 100;
/** Size of all kept messages together, at most (JSON characters); the oldest go first */
export const MAX_HISTORY_SIZE = 8 * 1024 * 1024;
/** Safety cap of a topic's seen ids, if its polls keep failing and live messages keep coming */
const MAX_SEEN_PER_TOPIC = 5000;
/** Newest events handled per poll (more than the history keeps) */
export const MAX_POLL_EVENTS = 1000;
/** Older deletions may still race with live delivery after a poll has moved the watermark. */
const MAX_SERVER_DELETIONS_PER_TOPIC = 1000;
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
  /** Latest server deletion per sequence, bounded so an overlapping replay cannot restore it */
  serverDeletions?: [sequenceId: string, time: number, eventId: string][];
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
          serverDeletions: Array.isArray(state.serverDeletions) ? state.serverDeletions : [],
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

const sequenceOf = (message: NtfyMessage) => message.sequence_id ?? message.id;

/** Apply one live event or a whole poll and return new messages eligible for a notification. */
function recordEvents(topic: string, events: NtfyMessage[], poll: boolean): Promise<NtfyMessage[]> {
  return serialized(async () => {
    const [states, history, syncDeletionTopics] = await Promise.all([getTopicSyncStates(), getHistoryState(), getSyncDeletionTopics()]);
    const syncDeletions = syncDeletionTopics.has(topic);
    const state = states.get(topic) ?? newState(topic);
    const accepted = events.filter(
      (event) => event.event === 'message' || (syncDeletions && event.sequence_id && event.event === 'message_delete'),
    );
    const ordered = poll ? accepted.sort((a, b) => a.time - b.time).slice(-MAX_POLL_EVENTS) : accepted;
    const seen = new Set(state.seen.map(([id]) => id));
    const localDeletes = new Set(history.deletedMessageIds);
    // Oldest first so that reversing the map before trimming preserves newest-first ties.
    const messages = new Map([...history.receivedNotifications].reverse().map((message) => [message.id, message]));
    const deletions = new Map((state.serverDeletions ?? []).map(([sequence, time, id]) => [sequence, { time, id }]));
    const pollOrder = new Map(poll && syncDeletions ? ordered.map((event, index) => [event.id, index]) : []);
    const added: NtfyMessage[] = [];
    let changed = false;
    let recorded = false;

    for (const [index, event] of ordered.entries()) {
      const sequence = sequenceOf(event);
      const deletion = deletions.get(sequence);
      const deletionIndex = deletion && pollOrder.get(deletion.id);
      // For events in the same second, only a message following the deletion revives the sequence.
      const deletedByServer =
        syncDeletions &&
        deletion &&
        (event.time < deletion.time || (poll && event.time === deletion.time && (deletionIndex === undefined || deletionIndex > index)));

      // Earlier versions did not save sequence IDs. Recover them from a replay before deduplication.
      const stored = messages.get(event.id);
      if (event.event === 'message' && stored?.topic === topic && !stored.sequence_id && event.sequence_id) {
        if (deletedByServer) messages.delete(event.id);
        else messages.set(event.id, { ...stored, sequence_id: event.sequence_id });
        changed = true;
      }

      if (seen.has(event.id)) continue;
      seen.add(event.id);
      state.seen.push([event.id, event.time]);
      recorded = true;

      if (event.event === 'message_delete') {
        if (
          deletion &&
          (event.id === deletion.id || event.time < deletion.time || (event.time === deletion.time && (deletionIndex ?? -1) > index))
        ) {
          continue;
        }
        deletions.delete(sequence);
        deletions.set(sequence, { time: event.time, id: event.id });
        for (const message of messages.values()) {
          if (message.topic !== topic || sequenceOf(message) !== sequence || message.time > event.time) continue;
          // For equal timestamps, a message later in this replay revives the sequence. It may
          // already be in history if the stream delivered it while the poll was in flight.
          if (message.time === event.time && (pollOrder.get(message.id) ?? -1) > index) continue;
          messages.delete(message.id);
          changed = true;
        }
      } else {
        if (deletedByServer || messages.has(event.id) || localDeletes.has(event.id)) continue;
        messages.set(event.id, event);
        added.push(event);
        changed = true;
      }
    }

    if (!poll && !recorded && !changed) return [];
    const notify = !poll || state.synced;
    if (poll) {
      state.synced = true;
      const newestTime = ordered.at(-1)?.time;
      if (newestTime !== undefined && (state.since === null || newestTime > state.since)) state.since = newestTime;
    }
    pruneSeen(state);
    state.serverDeletions = [...deletions].slice(-MAX_SERVER_DELETIONS_PER_TOPIC).map(([sequence, { time, id }]) => [sequence, time, id]);
    states.set(topic, state);

    // Persist history and the watermark together, so a failed write never loses a notification.
    if (changed) {
      const receivedNotifications = trimHistory([...messages.values()].reverse());
      await browser.storage.local.set({
        ...storedStates(states),
        receivedNotifications,
        ...pruneReadState({ ...history, receivedNotifications }),
      });
    } else {
      await browser.storage.local.set(storedStates(states));
    }
    return notify ? added.filter((message) => messages.has(message.id)) : [];
  });
}

/** Resolves to true if a live notification was new to the history. */
export async function recordMessage(message: NtfyMessage): Promise<boolean> {
  return (await recordEvents(message.topic, [message], false)).length > 0;
}

/** A completed poll advances the watermark and applies replayed messages and deletions together. */
export function recordPoll(topic: string, events: NtfyMessage[]): Promise<NtfyMessage[]> {
  return recordEvents(topic, events, true);
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
