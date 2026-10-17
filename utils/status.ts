// The receiver's connection state, for the Receive tab. The background is its only writer; it lives in
// storage.session, so a browser restart starts without a stale state.

import { browser } from 'wxt/browser';

export type ConnectionState = 'not-configured' | 'no-readable-topics' | 'connecting' | 'connected' | 'reconnecting';

export interface ReceiverStatus {
  state: ConnectionState;
  /** Host of the server in use */
  server: string;
  /** The server in use is the fallback URL */
  usingFallback: boolean;
  /** Topics the credentials can't read: used for sending only */
  unreadableTopics: string[];
  /** The server didn't answer (network error or 5xx) at the last check or poll */
  unreachable: boolean;
  /** When the next reconnect attempt is due (ms since the epoch) */
  retryAt: number | null;
  /** Topics whose last poll failed, with the error (a list: topic names aren't safe object keys) */
  syncErrors: [topic: string, error: string][];
  /** End of the last poll of all topics (ms since the epoch) */
  lastSyncAt: number | null;
}

export const STATUS_KEY = 'receiverStatus';

export const INITIAL_STATUS: ReceiverStatus = {
  state: 'not-configured',
  server: '',
  usingFallback: false,
  unreadableTopics: [],
  unreachable: false,
  retryAt: null,
  syncErrors: [],
  lastSyncAt: null,
};

export async function getReceiverStatus(): Promise<ReceiverStatus | null> {
  const result = await browser.storage.session.get([STATUS_KEY]);
  return (result[STATUS_KEY] as ReceiverStatus | undefined) ?? null;
}

export function writeReceiverStatus(status: ReceiverStatus): Promise<void> {
  return browser.storage.session.set({ [STATUS_KEY]: status });
}

export interface StatusLine {
  text: string;
  level: 'ok' | 'warning' | 'error';
}

/** What the Receive tab shows for a status; null when there is nothing to show */
export function describeStatus(status: ReceiverStatus | null, now = Date.now()): StatusLine[] {
  if (!status || status.state === 'not-configured') {
    return [];
  }

  const lines: StatusLine[] = [];
  const host = (status.server || 'the server') + (status.usingFallback ? ' (fallback)' : '');
  const retry = status.retryAt && status.retryAt > now ? ` in ${Math.ceil((status.retryAt - now) / 1000)} s` : '';
  switch (status.state) {
    case 'connected':
      lines.push({ text: `Connected to ${host}`, level: 'ok' });
      break;
    case 'connecting':
      lines.push({ text: `Connecting to ${host}…`, level: 'warning' });
      break;
    case 'reconnecting':
      lines.push(
        status.unreachable
          ? { text: `Can't reach ${host}, retrying${retry || '…'}`, level: 'error' }
          : { text: `Disconnected from ${host}, reconnecting${retry || '…'}`, level: 'warning' },
      );
      break;
    case 'no-readable-topics':
      lines.push({ text: 'No topic can be read with these credentials', level: 'error' });
      break;
  }

  const failed = Array.isArray(status.syncErrors) ? status.syncErrors : [];
  if (failed.length > 0) {
    const details = failed.map(([topic, error]) => `${topic} (${error})`).join(', ');
    lines.push({ text: `Couldn't fetch missed messages: ${details}`, level: 'warning' });
  }
  return lines;
}
