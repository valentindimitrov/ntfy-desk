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
  /** Topics whose catch-up or deletion replay was limited recently */
  truncatedTopics: string[];
  /** End of the last poll of all topics (ms since the epoch) */
  lastSyncAt: number | null;
  /** The token or password isn't sent: the server changed outside this browser's settings */
  authHeldBack: boolean;
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
  truncatedTopics: [],
  lastSyncAt: null,
  authHeldBack: false,
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
export function describeStatus(status: ReceiverStatus | null): StatusLine[] {
  if (!status || status.state === 'not-configured') {
    return [];
  }

  const lines: StatusLine[] = [];
  const host = (status.server || 'the server') + (status.usingFallback ? ' (fallback)' : '');
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
          ? { text: `Can't reach ${host}, retrying`, level: 'error' }
          : { text: `Disconnected from ${host}, reconnecting`, level: 'warning' },
      );
      break;
    case 'no-readable-topics':
      lines.push({ text: 'No topic can be read with these credentials', level: 'error' });
      break;
  }

  if (status.authHeldBack) {
    lines.push({ text: 'Token and password not sent: the server address changed. Confirm it in the settings', level: 'error' });
  }

  const failed = Array.isArray(status.syncErrors) ? status.syncErrors : [];
  if (failed.length > 0) {
    const details = failed.map(([topic, error]) => `${topic} (${error})`).join(', ');
    lines.push({ text: `Couldn't fetch missed messages: ${details}`, level: 'warning' });
  }
  if (status.truncatedTopics?.length > 0) {
    lines.push({ text: `Some cached events may have been skipped: ${status.truncatedTopics.join(', ')}`, level: 'warning' });
  }
  return lines;
}

export function retryCountdown(retryAt: number | null, now = Date.now()): string {
  return retryAt && retryAt > now ? ` in ${Math.ceil((retryAt - now) / 1000)} s` : '…';
}
