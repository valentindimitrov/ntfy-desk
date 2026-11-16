import { deleteMessages } from './history';
import { clearNotifications } from './notifications';
import { deleteNotification, getConfig, sequenceOf, serverOrigins } from './ntfy';
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

/** Apply the local delete first, then ask ntfy to delete eligible sequences. */
export async function deleteReceivedMessages(ids: string[], intent?: ServerDeletionIntent): Promise<DeletionSyncResult> {
  const messages = await deleteMessages(ids);
  void clearNotifications(ids);
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

  // Only messages delivered by the configured server or its fallback can be deleted there.
  const targets = new Map<string, { topic: string; sequence: string }>();
  for (const message of eligible) {
    if (!origins.includes(message.serverOrigin)) {
      result.failed++;
      continue;
    }
    const sequence = sequenceOf(message);
    targets.set(`${message.topic}/${sequence}`, { topic: message.topic, sequence });
  }
  if (targets.size === 0) return result;

  const server = await pickServer(config);

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
