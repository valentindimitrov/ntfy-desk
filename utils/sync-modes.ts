import { browser } from 'wxt/browser';

/** A list of topics that follow server deletion events. All other topics keep received messages. */
export const SYNC_DELETION_TOPICS_KEY = 'syncDeletionTopics';

export async function getSyncDeletionTopics(): Promise<Set<string>> {
  const { [SYNC_DELETION_TOPICS_KEY]: stored } = await browser.storage.sync.get(SYNC_DELETION_TOPICS_KEY);
  return new Set(Array.isArray(stored) ? stored.filter((topic): topic is string => typeof topic === 'string') : []);
}
