import { deleteMessages, type StoredMessage } from './history';
import { deleteNotification, getConfig, getNotifications, isNtfyPathPart, sequenceOf, serverOrigins, type NtfyServer } from './ntfy';
import { pickServer } from './servers';
import { getSyncDeletionTopics } from './sync-modes';

export interface DeletionSyncResult {
  denied: number;
  failed: number;
  skipped?: number;
}

/** The IDs and destination the inbox showed as server deletions before the user acted. */
export interface ServerDeletionIntent {
  ids: string[];
  apiUrl: string;
  fallbackUrl: string;
}

/** Verify older messages whose source origin was not saved. One bounded replay per topic. */
async function verifyLegacyMessages(server: NtfyServer, messages: StoredMessage[], origins: string[]): Promise<Map<string, string>> {
  const topics = new Map<string, number>();
  for (const message of messages) {
    if (!message.serverOrigin && isNtfyPathPart(message.topic)) {
      topics.set(message.topic, Math.min(topics.get(message.topic) ?? Infinity, message.time));
    }
  }

  const wanted = new Map(messages.map((message) => [message.id, message]));
  const messageIds = new Set(wanted.keys());
  const sequences = new Map<string, string>();
  const signal = AbortSignal.timeout(10_000);
  for (const [topic, time] of topics) {
    if (signal.aborted) break;
    try {
      const { events, serverOrigin } = await getNotifications(server, topic, Math.max(1, Math.floor(time)), { signal, messageIds });
      if (!origins.includes(serverOrigin)) continue;
      for (const event of events) {
        const stored = wanted.get(event.id);
        if (stored?.topic === topic && stored.time === event.time) sequences.set(event.id, sequenceOf(event));
      }
    } catch {
      // Without verification, the local delete still applies and the caller reports the unsynced deletion.
    }
  }
  return sequences;
}

/** Apply the local delete first, then ask ntfy to delete eligible sequences. */
export async function deleteReceivedMessages(ids: string[], intent?: ServerDeletionIntent): Promise<DeletionSyncResult> {
  const messages = await deleteMessages(ids);
  const result: DeletionSyncResult = { denied: 0, failed: 0 };
  if (!intent || messages.length === 0) return result;

  const approved = new Set(intent.ids);
  const selected = messages.filter((message) => approved.has(message.id));
  if (selected.length === 0) return result;

  const [config, syncedTopics] = await Promise.all([getConfig(), getSyncDeletionTopics()]);
  if (config.apiUrl !== intent.apiUrl || config.fallbackUrl !== intent.fallbackUrl) return { ...result, skipped: selected.length };
  const origins = serverOrigins(config.apiUrl, config.fallbackUrl);
  const eligible = selected.filter((message) => syncedTopics.has(message.topic) && config.topics.includes(message.topic));
  if (eligible.length !== selected.length) result.skipped = selected.length - eligible.length;
  if (eligible.length === 0) return result;
  if (!config.apiUrl || config.heldBackFrom.length > 0) return { ...result, failed: eligible.length };

  const server = await pickServer(config);
  const legacy = await verifyLegacyMessages(server, eligible, origins);
  const targets = new Map<string, { topic: string; sequence: string }>();
  for (const message of eligible) {
    const sequence = message.serverOrigin
      ? origins.includes(message.serverOrigin)
        ? sequenceOf(message)
        : undefined
      : legacy.get(message.id);
    if (!sequence) {
      result.failed++;
      continue;
    }
    targets.set(`${message.topic}/${sequence}`, { topic: message.topic, sequence });
  }

  // Bounded concurrency for Delete all. A timed-out write may already have applied on the server.
  const pending = [...targets.values()];
  const signal = AbortSignal.timeout(20_000);
  const concurrency = 6;
  for (let index = 0; index < pending.length; index += concurrency) {
    if (signal.aborted) {
      result.failed += pending.length - index;
      break;
    }
    await Promise.all(
      pending.slice(index, index + concurrency).map(async ({ topic, sequence }) => {
        try {
          const response = await deleteNotification(server, topic, sequence, signal);
          if (response.status === 401 || response.status === 403) result.denied++;
          else if (!response.ok) result.failed++;
        } catch {
          result.failed++;
        }
      }),
    );
  }
  return result;
}
