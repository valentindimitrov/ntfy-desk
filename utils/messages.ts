// Messages from the popup to the background. The background is the only writer of the received
// messages and their read and deleted ids, so actions from several open views (the popup and the
// extension's tab) are applied one at a time instead of overwriting each other's lists.

import { browser } from 'wxt/browser';
import { deleteMessages, setRead } from './history';

export type PopupRequest = { action: 'sync' } | { action: 'setRead'; ids: string[]; read: boolean } | { action: 'delete'; ids: string[] };

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string');

/** The background's handling of a request; null if it isn't one */
export function handlePopupRequest(request: unknown, sync: () => Promise<void>): Promise<void> | null {
  const { action, ids, read } = (request ?? {}) as { action?: unknown; ids?: unknown; read?: unknown };
  if (action === 'sync') return sync();
  if (action === 'setRead' && isIdList(ids) && typeof read === 'boolean') return setRead(ids, read);
  if (action === 'delete' && isIdList(ids)) return deleteMessages(ids);
  return null;
}

/** Send a request to the background; resolves when it has been applied */
export async function sendToBackground(request: PopupRequest): Promise<void> {
  const response = (await browser.runtime.sendMessage(request)) as { success?: boolean } | undefined;
  if (response && response.success === false) {
    throw new Error(`The background couldn't apply ${request.action}`);
  }
}
