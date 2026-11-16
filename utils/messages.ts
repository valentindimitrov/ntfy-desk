// Messages from the popup to the background. The background is the only writer of the received
// messages and their read and deleted ids, so actions from several open views (the popup and the
// extension's tab) are applied one at a time instead of overwriting each other's lists.

import { browser } from 'wxt/browser';
import { deleteReceivedMessages, type DeletionSyncResult, type ServerDeletionIntent } from './delete';
import { setRead } from './history';
import { clearNotifications } from './notifications';
import { clearStoredFiles } from './stored-files';

export interface Draft {
  revision: string;
  title: string;
  message: string;
  topic: string;
  tags: string[];
  priority: number;
  /**
   * The priority or tags were set by hand for this message: they are restored as they are. Otherwise
   * the composer shows the topic's send defaults, or the values used last.
   */
  customPriorityTags: boolean;
  /** More options: the click URL as typed, Markdown, and the delay ('' for none) */
  click: string;
  markdown: boolean;
  delay: string;
}

export type PopupRequest =
  | { action: 'sync' }
  | { action: 'setRead'; ids: string[]; read: boolean }
  | { action: 'delete'; ids: string[]; server?: ServerDeletionIntent }
  | { action: 'saveDraft'; draft: Draft }
  | { action: 'clearDraft'; revision: string };

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function isServerDeletionIntent(value: unknown): value is ServerDeletionIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<ServerDeletionIntent>;
  return isStringList(intent.ids) && typeof intent.apiUrl === 'string' && typeof intent.fallbackUrl === 'string';
}

function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false;
  const { revision, title, message, topic, tags, priority, customPriorityTags, click, markdown, delay } = value as Partial<Draft>;
  return (
    typeof revision === 'string' &&
    typeof title === 'string' &&
    typeof message === 'string' &&
    typeof topic === 'string' &&
    isStringList(tags) &&
    typeof priority === 'number' &&
    typeof customPriorityTags === 'boolean' &&
    typeof click === 'string' &&
    typeof markdown === 'boolean' &&
    typeof delay === 'string'
  );
}

let draftQueue: Promise<void> = Promise.resolve();
/** One writer across the popup and tab, so compare-and-clear cannot race with a save. */
function updateDraft(task: () => Promise<void>): Promise<void> {
  const write = draftQueue.then(task);
  draftQueue = write.catch(() => {});
  return write;
}

/** Clear unsent work only when the browser profile starts, including after a crash. */
export function clearComposerOnStartup(): Promise<void> {
  return updateDraft(async () => {
    // storedFiles: the attachment queue of earlier builds (data URLs), now in IndexedDB
    await browser.storage.local.remove(['draftState', 'storedFiles']);
    await clearStoredFiles();
  });
}

/** The background's handling of a request; null if it isn't one */
export function handlePopupRequest(request: unknown, sync: () => Promise<void>): Promise<void | DeletionSyncResult> | null {
  const { action, ids, read, draft, revision, server } = (request ?? {}) as Partial<
    Record<'action' | 'ids' | 'read' | 'draft' | 'revision' | 'server', unknown>
  >;
  if (action === 'sync') return sync();
  if (action === 'setRead' && isStringList(ids) && typeof read === 'boolean') {
    // A message marked read no longer needs its desktop notification
    return setRead(ids, read).then(() => (read ? void clearNotifications(ids) : undefined));
  }
  if (action === 'delete' && isStringList(ids) && (server === undefined || isServerDeletionIntent(server))) {
    return deleteReceivedMessages(ids, server);
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
