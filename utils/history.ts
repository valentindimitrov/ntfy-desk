// Received messages, read and deleted ids, and the per-topic sync state, all in storage.local. The
// background is their only writer: the live stream, the catch-up polls and the popup's read and
// delete actions (sent as messages) all go through one queue, so no update overwrites another.

import { browser } from 'wxt/browser';
import { parseMessage, sequenceOf, type NtfyMessage } from './ntfy';
import { getSyncDeletionTopics } from './sync-modes';

/** Received messages kept per topic, so a busy topic doesn't push the others out */
export const MAX_HISTORY_PER_TOPIC = 100;
/** Size of all kept messages together, at most (JSON characters); the oldest go first */
export const MAX_HISTORY_SIZE = 8 * 1024 * 1024;
/** Safety cap of a topic's seen ids, if its polls keep failing and live messages keep coming */
const MAX_SEEN_PER_TOPIC = 5000;
/** Older deletions may still race with live delivery after a poll has moved the watermark. */
const MAX_SERVER_DELETIONS_PER_TOPIC = 1000;
/**
 * Deleted ids kept for replay suppression, newest last. Leave room for a single delete of the
 * entire 8 MiB history, even if it consists of the smallest possible stored messages.
 */
export const MAX_DELETED_IDS = 200_000;

/** A topic's sync state */
export interface TopicSyncState {
  topic: string;
  /** Origins configured as aliases of the same ntfy server when this state was recorded. */
  origins: string[];
  /**
   * Catch-up watermark: the newest message time that a completed poll covered, and the next poll's
   * since= (inclusive). Only polls move it, never live messages: a live message newer than messages
   * missed while disconnected must not let the next poll skip them. An empty first poll can seed it.
   */
  since: number | null;
  /** Start of the first empty poll, used when no server timestamp is available. */
  emptyPollAt?: number;
  /** Id and time of every message recorded at or after `since`, to skip those a poll returns again */
  seen: [id: string, time: number][];
  /** Latest server deletion per sequence, bounded so an overlapping replay cannot restore it */
  serverDeletions?: [sequenceId: string, time: number, eventId: string][];
  /** A new generation needs a replay of cached deletions against the saved history. */
  deletionReplay?: { generation: number; complete: boolean; nextSince?: number; retryAt?: number };
  /** The first poll (silent: it loads recent history without notifications) completed */
  synced: boolean;
  /** Last time a bounded replay skipped events, for the inbox warning. */
  truncatedAt?: number;
}

/** Sync states by topic. A Map, so any topic name is a plain key (even "__proto__" or "constructor") */
export type TopicSyncStates = Map<string, TopicSyncState>;

export interface HistoryState {
  receivedNotifications: StoredMessage[];
  readMessageIds: string[];
  deletedMessageIds: string[];
}

export interface StoredMessage extends NtfyMessage {
  /** The origin that delivered the message, assigned by the receiver. */
  serverOrigin: string;
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
          // No origins match no server, so the next poll starts fresh.
          origins: Array.isArray(state.origins) ? state.origins : [],
          since: state.since ?? null,
          emptyPollAt: state.emptyPollAt,
          seen: Array.isArray(state.seen) ? state.seen : [],
          synced: state.synced === true,
          truncatedAt: state.truncatedAt,
          serverDeletions: Array.isArray(state.serverDeletions) ? state.serverDeletions : [],
          deletionReplay: state.deletionReplay,
        });
      }
    }
  }
  return states;
}

const storedStates = (states: TopicSyncStates) => ({ [SYNC_KEY]: [...states.values()] });

/** A stored row: a valid message and the origin that delivered it; null otherwise */
function parseStoredMessage(value: unknown): StoredMessage | null {
  const message = parseMessage(value);
  if (message && value && typeof value === 'object' && 'serverOrigin' in value && typeof value.serverOrigin === 'string') {
    return { ...message, serverOrigin: value.serverOrigin };
  }
  return null;
}

export async function getHistoryState(): Promise<HistoryState> {
  const result = await browser.storage.local.get(['receivedNotifications', 'readMessageIds', 'deletedMessageIds']);
  const stored: unknown = result.receivedNotifications;
  return {
    // Checked again on reading: storage is not trusted to hold only what this code wrote
    receivedNotifications: Array.isArray(stored) ? stored.map(parseStoredMessage).filter((m): m is StoredMessage => m !== null) : [],
    readMessageIds: (result.readMessageIds as string[] | undefined) ?? [],
    deletedMessageIds: (result.deletedMessageIds as string[] | undefined) ?? [],
  };
}

/**
 * The newest MAX_HISTORY_PER_TOPIC messages of each topic by server time, newest first, up to
 * MAX_HISTORY_SIZE in all. Ordering by time (not by arrival) keeps a late older message from pushing
 * out a newer one.
 */
export function trimHistory<T extends NtfyMessage>(messages: T[]): T[] {
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
  const read = new Set(readMessageIds);
  const deleted = new Set(deletedMessageIds);
  return receivedNotifications.filter((n) => !deleted.has(n.id) && !read.has(n.id)).length;
}

function newState(topic: string, origins: string[]): TopicSyncState {
  return { topic, origins, since: null, seen: [], synced: false };
}

/** A different server needs a fresh poll. */
export function topicStateForServer(state: TopicSyncState | undefined, origins: string[]): TopicSyncState | undefined {
  return state?.origins.some((origin) => origins.includes(origin)) ? state : undefined;
}

/** Seen entries that still matter: at or after the watermark (polls are inclusive), capped */
function pruneSeen(state: TopicSyncState): void {
  const since = state.since;
  const kept = since === null ? state.seen : state.seen.filter(([, time]) => time >= since);
  state.seen = kept.slice(-MAX_SEEN_PER_TOPIC);
}

export interface HistorySource {
  origin: string;
  origins: string[];
}

interface PollCoverage {
  truncated?: boolean;
  /** Ids of publishes that only give a saved row's position in the poll (no content: never stored) */
  positionOnly?: string[];
  advanceTo?: number;
  emptyPollAt?: number;
}

export interface RecordResult {
  /** New messages saved in the history and eligible for a desktop notification */
  added: NtfyMessage[];
  /** Ids of stored messages removed by a server deletion or replaced by an update of their sequence */
  removed: string[];
}

const NOTHING: RecordResult = { added: [], removed: [] };

/**
 * Apply one live event or a replay. A message replaces older stored versions of its sequence from the
 * same server (ntfy's notification updates); an older version arriving late is dropped.
 */
function recordEvents(
  topic: string,
  events: NtfyMessage[],
  {
    source,
    poll = false,
    replayGeneration,
    replayProgress,
    coverage,
  }: {
    source: HistorySource;
    poll?: boolean;
    replayGeneration?: number;
    replayProgress?: Pick<NonNullable<TopicSyncState['deletionReplay']>, 'complete' | 'nextSince' | 'retryAt'>;
    coverage?: PollCoverage;
  },
): Promise<RecordResult> {
  return serialized(async () => {
    const [states, history, syncDeletionTopics] = await Promise.all([getTopicSyncStates(), getHistoryState(), getSyncDeletionTopics()]);
    const serverOrigin = source.origin;
    const deletionOrigins = source.origins.includes(source.origin) ? source.origins : [];
    const syncDeletions = deletionOrigins.length > 0 && syncDeletionTopics.has(topic);
    const state = topicStateForServer(states.get(topic), source.origins) ?? newState(topic, source.origins);
    const replay = replayGeneration !== undefined;
    if (replay && (!syncDeletions || replayGeneration !== (state.deletionReplay?.generation ?? 0))) return NOTHING;
    state.origins = source.origins;
    const accepted = events.filter(
      (event) => event.event === 'message' || (syncDeletions && event.sequence_id && event.event === 'message_delete'),
    );
    const ordered = poll ? accepted.sort((a, b) => a.time - b.time) : accepted;
    const seen = new Set(state.seen.map(([id]) => id));
    const localDeletes = new Set(history.deletedMessageIds);
    // Oldest first so that reversing the map before trimming preserves newest-first ties.
    const messages = new Map([...history.receivedNotifications].reverse().map((message) => [message.id, message]));
    const deletions = new Map((state.serverDeletions ?? []).map(([sequence, time, id]) => [sequence, { time, id }]));
    // Server order within a poll (ntfy orders a topic's replay by time, publishes within a second in order)
    const pollOrder = new Map(poll ? ordered.map((event, index) => [event.id, index]) : []);
    // Stored rows of this topic by sequence, for updates
    const bySequence = new Map<string, Set<string>>();
    const indexRow = (message: StoredMessage) => {
      if (message.topic !== topic) return;
      const ids = bySequence.get(sequenceOf(message)) ?? new Set<string>();
      ids.add(message.id);
      bySequence.set(sequenceOf(message), ids);
    };
    messages.forEach(indexRow);
    const removeRow = (message: StoredMessage) => {
      messages.delete(message.id);
      bySequence.get(sequenceOf(message))?.delete(message.id);
      removed.push(message.id);
    };
    // Main and fallback origins are aliases; a row delivered by an unrelated server is never replaced.
    const sameServer = (origin: string) => origin === serverOrigin || deletionOrigins.includes(origin);
    /** Whether this event is a later version than a stored row of its sequence */
    const isLaterThan = (event: NtfyMessage, index: number, row: StoredMessage) => {
      if (event.time !== row.time) return event.time > row.time;
      // Same second: in a poll, server order decides, and a row the poll didn't return arrived live
      // after it was answered. A live event arrives in publish order, after the rows stored before it.
      if (!poll) return true;
      const rowIndex = pollOrder.get(row.id);
      return rowIndex !== undefined && index > rowIndex;
    };
    // Within a poll, only the last publish of a sequence is its current version, even when that one
    // isn't stored (deleted here, or already seen): an earlier one must not come back in its place.
    const lastVersion = new Map<string, number>();
    if (poll) ordered.forEach((event, index) => event.event === 'message' && lastVersion.set(sequenceOf(event), index));
    const positionOnly = new Set(coverage?.positionOnly);
    const added: NtfyMessage[] = [];
    const removed: string[] = [];
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

      // A deletion replay applies deletions only; publishes in it just give their position in the
      // server's order. Ordinary delivery is left to catch-up.
      if (replay && event.event === 'message') continue;
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
          if (!deletionOrigins.includes(message.serverOrigin)) continue;
          // For equal timestamps, a message later in this replay revives the sequence. It may
          // already be in history if the stream delivered it while the poll was in flight.
          if (message.time === event.time && (pollOrder.get(message.id) ?? -1) > index) continue;
          removeRow(message);
          changed = true;
        }
      } else {
        if (deletedByServer || messages.has(event.id) || localDeletes.has(event.id) || positionOnly.has(event.id)) continue;
        if (poll && lastVersion.get(sequence) !== index) continue;
        const versions = [...(bySequence.get(sequence) ?? [])]
          .map((id) => messages.get(id))
          .filter((row): row is StoredMessage => row !== undefined && sameServer(row.serverOrigin));
        // An older version arriving late (a poll overlapping live delivery) is neither stored nor notified.
        if (versions.some((row) => !isLaterThan(event, index, row))) continue;
        versions.forEach(removeRow);
        const row = { ...event, serverOrigin };
        messages.set(event.id, row);
        indexRow(row);
        added.push(event);
        changed = true;
      }
    }

    if (!poll && !recorded && !changed) return NOTHING;
    const notify = !poll || state.synced;
    if (coverage?.truncated) state.truncatedAt = Date.now();
    if (replay) {
      state.deletionReplay = { generation: replayGeneration, ...(replayProgress ?? { complete: true }) };
    } else if (poll) {
      state.synced = true;
      const newestTime = Math.max(ordered.at(-1)?.time ?? -Infinity, coverage?.advanceTo ?? -Infinity);
      if (Number.isFinite(newestTime) && (state.since === null || newestTime > state.since)) state.since = newestTime;
      state.emptyPollAt = ordered.length === 0 ? (state.emptyPollAt ?? coverage?.emptyPollAt) : undefined;
    }
    pruneSeen(state);
    state.serverDeletions = [...deletions].slice(-MAX_SERVER_DELETIONS_PER_TOPIC).map(([sequence, { time, id }]) => [sequence, time, id]);
    states.set(topic, state);

    // Persist history and the watermark together, so a failed write never loses a notification.
    let storedIds: Set<string> | undefined;
    if (changed) {
      const receivedNotifications = trimHistory([...messages.values()].reverse());
      if (notify && added.length > 0) storedIds = new Set(receivedNotifications.map(({ id }) => id));
      await browser.storage.local.set({
        ...storedStates(states),
        receivedNotifications,
        ...pruneReadState({ ...history, receivedNotifications }),
      });
    } else {
      await browser.storage.local.set(storedStates(states));
    }
    return { added: storedIds ? added.filter((message) => storedIds.has(message.id)) : [], removed };
  });
}

/** A live event: `added` holds the message if it was new to the history. */
export function recordMessage(message: NtfyMessage, source: HistorySource): Promise<RecordResult> {
  return recordEvents(message.topic, [message], { source });
}

/** A completed poll advances the watermark and applies replayed messages and deletions together. */
export function recordPoll(topic: string, events: NtfyMessage[], source: HistorySource, coverage?: PollCoverage): Promise<RecordResult> {
  return recordEvents(topic, events, { source, poll: true, coverage });
}

export async function recordDeletionReplay(
  topic: string,
  events: NtfyMessage[],
  source: HistorySource,
  generation: number,
  truncated = false,
  progress?: Pick<NonNullable<TopicSyncState['deletionReplay']>, 'complete' | 'nextSince' | 'retryAt'>,
): Promise<string[]> {
  const { removed } = await recordEvents(topic, events, {
    source,
    poll: true,
    replayGeneration: generation,
    replayProgress: progress,
    coverage: { truncated },
  });
  return removed;
}

/** Mark newly enabled topics pending, including when an older replay is still in flight. */
export function invalidateDeletionReplays(topics: string[], origins: string[]): Promise<void> {
  return serialized(async () => {
    const states = await getTopicSyncStates();
    for (const topic of topics) {
      const state = topicStateForServer(states.get(topic), origins) ?? newState(topic, origins);
      state.deletionReplay = { generation: (state.deletionReplay?.generation ?? 0) + 1, complete: false };
      states.set(topic, state);
    }
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

/** Delete actions from the popup: remove rows and keep their ids to suppress replays. */
export function deleteMessages(ids: string[]): Promise<StoredMessage[]> {
  return serialized(async () => {
    const history = await getHistoryState();
    const requested = new Set(ids);
    const alreadyDeleted = new Set(history.deletedMessageIds);
    const messages = history.receivedNotifications.filter((message) => requested.has(message.id) && !alreadyDeleted.has(message.id));
    const receivedNotifications = history.receivedNotifications.filter(
      (message) => !requested.has(message.id) && !alreadyDeleted.has(message.id),
    );
    const deletedMessageIds = [...new Set([...history.deletedMessageIds, ...ids])];
    await browser.storage.local.set({
      receivedNotifications,
      ...pruneReadState({ ...history, receivedNotifications, deletedMessageIds }),
    });
    return messages;
  });
}
