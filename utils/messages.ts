// Messages from the popup to the background. The background is the only writer of the received
// messages and their read and deleted ids, so actions from several open views (the popup and the
// extension's tab) are applied one at a time instead of overwriting each other's lists.

import { browser } from 'wxt/browser';
import { deleteReceivedMessages, type DeletionSyncResult } from './delete';
import { setRead } from './history';
import { STORED_FILES_KEY } from './stored-files';

export interface Draft {
  revision: string;
  title: string;
  message: string;
  topic: string;
  tags: string[];
  priority: number;
}

export type PopupRequest =
  | { action: 'sync' }
  | { action: 'setRead'; ids: string[]; read: boolean }
  | { action: 'delete'; ids: string[] }
  | { action: 'prepareDraft' }
  | { action: 'saveDraft'; draft: Draft }
  | { action: 'clearDraft'; revision: string };

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false;
  const { revision, title, message, topic, tags, priority } = value as Partial<Draft>;
  return (
    typeof revision === 'string' &&
    typeof title === 'string' &&
    typeof message === 'string' &&
    typeof topic === 'string' &&
    isStringList(tags) &&
    typeof priority === 'number'
  );
}

let draftQueue: Promise<void> = Promise.resolve();
/** One writer across the popup and tab, so compare-and-clear cannot race with a save. */
function updateDraft(task: () => Promise<void>): Promise<void> {
  const write = draftQueue.then(task);
  draftQueue = write.catch(() => {});
  return write;
}

/** The background's handling of a request; null if it isn't one */
export function handlePopupRequest(request: unknown, sync: () => Promise<void>): Promise<void | DeletionSyncResult> | null {
  const { action, ids, read, draft, revision } = (request ?? {}) as Partial<
    Record<'action' | 'ids' | 'read' | 'draft' | 'revision', unknown>
  >;
  if (action === 'sync') return sync();
  if (action === 'setRead' && isStringList(ids) && typeof read === 'boolean') return setRead(ids, read);
  if (action === 'delete' && isStringList(ids)) return deleteReceivedMessages(ids);
  if (action === 'prepareDraft') {
    return updateDraft(async () => {
      const { sessionActive } = await browser.storage.session.get('sessionActive');
      if (sessionActive) return;
      await browser.storage.local.remove([STORED_FILES_KEY, 'draftState']);
      await browser.storage.session.set({ sessionActive: true });
    });
  }
  if (action === 'saveDraft' && isDraft(draft)) {
    return updateDraft(() => browser.storage.local.set({ draftState: draft }));
  }
  if (action === 'clearDraft' && typeof revision === 'string') {
    return updateDraft(async () => {
      const { draftState } = await browser.storage.local.get('draftState');
      if ((draftState as Partial<Draft> | undefined)?.revision === revision) await browser.storage.local.remove('draftState');
    });
  }
  return null;
}

/** Send a request to the background; resolves when it has been applied */
export async function sendToBackground(request: PopupRequest): Promise<DeletionSyncResult | undefined> {
  const response = (await browser.runtime.sendMessage(request)) as { success?: boolean; deletion?: DeletionSyncResult } | undefined;
  if (response && response.success === false) {
    throw new Error(`The background couldn't apply ${request.action}`);
  }
  return response?.deletion;
}
