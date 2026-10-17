// Receiving: one subscription (ntfy's JSON stream) for live messages, and a poll per topic for messages
// missed while the stream was down or the browser closed.

import { browser } from 'wxt/browser';
import { completePoll, getTopicSyncStates, pruneTopicSyncStates, recordMessage } from './history';
import { pickServer } from './servers';
import { INITIAL_STATUS, writeReceiverStatus, type ReceiverStatus } from './status';
import {
  MAX_MESSAGE_JSON,
  buildAuthHeaderValue,
  canReadTopic,
  getConfig,
  getNotifications,
  isNoResponse,
  openMessageStream,
  parseMessageJson,
  type NtfyConfig,
  type NtfyMessage,
} from './ntfy';

const INITIAL_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 60000;
// Chrome stops an idle extension service worker after 30 s. Data arriving on a fetch stream doesn't
// count as activity, but an extension API call does: call a cheap one while the stream is open.
export const KEEPALIVE_INTERVAL = 20000;
/** Reconnect when the stream brings nothing for this long (ntfy sends a keepalive every 45 s by default) */
export const STREAM_IDLE_TIMEOUT = 150_000;
// How long the read-access check of the topics is reused
const READABLE_TOPICS_TTL = 60 * 60 * 1000;
// Window fetched silently the first time a topic is synced
const INITIAL_SYNC_SINCE = '24h';
/** Newest messages of a topic handled per poll (more than the history keeps, MAX_HISTORY_PER_TOPIC) */
export const MAX_POLL_MESSAGES = 1000;

export interface ReceiverEvents {
  /** A message new to the history (not during a topic's first, silent sync) */
  onNewMessage(message: NtfyMessage): void;
  /** The subscription opened */
  onConnected?(): void;
}

/** One open (or opening) subscription */
interface Subscription {
  controller: AbortController;
  /** Server, topics and authentication it was opened with, to detect configuration changes */
  key: string;
}

/**
 * The lines of a response body, one call to onLine at a time: the next chunk is read only after the
 * lines before it were handled, so a server sending faster than they can be stored is slowed down
 * instead of queued. A line longer than MAX_MESSAGE_JSON is dropped. onData runs for every chunk.
 */
async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => Promise<void>, onData: () => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let skipping = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onData();
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (skipping) {
        skipping = false;
      } else if (line.trim()) {
        await onLine(line);
      }
    }
    if (buffer.length > MAX_MESSAGE_JSON) {
      // Too long for a message: drop it up to its end
      buffer = '';
      skipping = true;
    }
  }
}

export function createReceiver(events: ReceiverEvents) {
  let subscription: Subscription | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = INITIAL_RECONNECT_DELAY;
  let readableTopicsCache: { key: string | null; topics: string[]; time: number } = { key: null, topics: [], time: 0 };
  let syncInFlight: Promise<void> | null = null;
  let status: ReceiverStatus = { ...INITIAL_STATUS };
  /** Server picked at the last connect (main or fallback), also used by the polls */
  let activeApiUrl: string | null = null;
  /**
   * Each connect() takes the next number; one that finds a newer number after an await stops, so an
   * attempt started before a settings change can't subscribe with the old settings.
   */
  let connectGeneration = 0;

  /** The receiver is the only writer of the status, so it keeps the current one in memory */
  function setStatus(patch: Partial<ReceiverStatus>): void {
    status = { ...status, ...patch };
    writeReceiverStatus(status).catch((error) => console.error('Failed to save the connection status:', error));
  }

  // ntfy rejects a subscription to several topics if any one of them isn't readable, and a topic the
  // token can only send to is a normal setup. So subscribe to, and poll, the readable topics only.
  async function getReadableTopics(config: NtfyConfig): Promise<string[]> {
    const key = JSON.stringify([config.apiUrl, config.accessToken, config.credentials, config.topics]);
    if (readableTopicsCache.key === key && Date.now() - readableTopicsCache.time < READABLE_TOPICS_TTL) {
      return readableTopicsCache.topics;
    }

    const access = await Promise.all(config.topics.map((topic) => canReadTopic(config, topic)));
    // A topic the server couldn't be asked about (null) is kept, and the result isn't cached
    const topics = config.topics.filter((_, i) => access[i] !== false);
    const skipped = config.topics.filter((_, i) => access[i] === false);
    if (skipped.length > 0) {
      console.log(`Not receiving from topics without read access: ${skipped.join(', ')}`);
    }
    const unreachable = access.includes(null);
    if (!unreachable) {
      readableTopicsCache = { key, topics, time: Date.now() };
    }
    setStatus({ unreadableTopics: skipped, unreachable });
    return topics;
  }

  function hostOf(apiUrl: string): string {
    try {
      return new URL(/^https?:\/\//i.test(apiUrl) ? apiUrl : `https://${apiUrl}`).host;
    } catch {
      return apiUrl;
    }
  }

  function startKeepalive(): void {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      try {
        browser.runtime.getPlatformInfo().catch(() => {});
      } catch {
        // Not available (tests): nothing to keep alive
      }
    }, KEEPALIVE_INTERVAL);
  }

  function stopKeepalive(): void {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  /** (Re)start the idle limit of a subscription: aborted when nothing arrives within STREAM_IDLE_TIMEOUT */
  function resetIdleTimer(current: Subscription): void {
    stopIdleTimer();
    idleTimer = setTimeout(() => {
      console.log('No data from the server for too long, reconnecting...');
      current.controller.abort(new DOMException('No data from the server', 'TimeoutError'));
    }, STREAM_IDLE_TIMEOUT);
  }

  function stopIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function close(): void {
    stopKeepalive();
    stopIdleTimer();
    if (subscription) {
      // Cleared first: the reading loop sees it isn't current any more and doesn't reconnect
      const { controller } = subscription;
      subscription = null;
      controller.abort();
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(unreachable = false): void {
    if (reconnectTimer) return;

    console.log(`Scheduling reconnect in ${reconnectDelay / 1000}s...`);
    setStatus({ state: 'reconnecting', retryAt: Date.now() + reconnectDelay, ...(unreachable && { unreachable: true }) });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      void connect();
    }, reconnectDelay);
  }

  async function handleMessage(message: NtfyMessage, notify: boolean): Promise<void> {
    const isNew = await recordMessage(message);
    if (isNew && notify) {
      events.onNewMessage(message);
    }
  }

  /** A line of the stream: valid messages of the subscribed topics only, so the server can't fill storage with others */
  async function handleLine(line: string, topics: string[]): Promise<void> {
    const message = parseMessageJson(line);
    if (!message || message.event !== 'message' || !topics.includes(message.topic)) {
      return;
    }
    try {
      console.log('Received notification:', message.id);
      await handleMessage(message, true);
    } catch (error) {
      console.error('Error processing a live message:', error);
    }
  }

  /** Subscribe; reconnects when the stream fails, ends or stays silent, until close() or a newer open() */
  function open(config: NtfyConfig, key: string): void {
    close();
    const current: Subscription = { controller: new AbortController(), key };
    subscription = current;
    const isCurrent = () => subscription === current;

    console.log(`Subscribing to ${config.topics.join(',')} on ${hostOf(config.apiUrl)}`);
    if (status.state !== 'reconnecting') {
      setStatus({ state: 'connecting', server: hostOf(config.apiUrl), retryAt: null });
    } else {
      setStatus({ server: hostOf(config.apiUrl) });
    }

    void (async () => {
      let opened = false;
      let unreachable = false;
      try {
        const response = await openMessageStream(config, config.topics, current.controller.signal);
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }
        if (!isCurrent()) return;

        opened = true;
        reconnectDelay = INITIAL_RECONNECT_DELAY;
        setStatus({ state: 'connected', retryAt: null, unreachable: false });
        startKeepalive();
        resetIdleTimer(current);
        void sync();
        events.onConnected?.();

        await readLines(
          response.body,
          (line) => handleLine(line, config.topics),
          () => resetIdleTimer(current),
        );
        console.log('The server ended the subscription. Reconnecting...');
      } catch (error) {
        if (!isCurrent()) return; // closed, or replaced by a newer subscription
        const message = error instanceof Error ? error.message : String(error);
        console.log(`Subscription failed (${message}). Reconnecting...`);
        unreachable = isNoResponse(error) || /^HTTP 5\d\d/.test(message);
      }
      if (!isCurrent()) return;

      subscription = null;
      stopKeepalive();
      stopIdleTimer();
      // Refused before it opened (e.g. 403 after read access to a topic was revoked): check the
      // topics' access again instead of reusing the cached result
      if (!opened) {
        readableTopicsCache = { key: null, topics: [], time: 0 };
      }
      scheduleReconnect(unreachable);
    })();
  }

  /** Subscribe, or subscribe again if the server, credentials or readable topics changed */
  async function connect(): Promise<void> {
    const generation = ++connectGeneration;
    const superseded = () => generation !== connectGeneration;

    const config = await getConfig();
    if (superseded()) return;
    if (!config.apiUrl || config.topics.length === 0) {
      console.log('ntfy is not configured, not subscribing.');
      close();
      setStatus({ ...INITIAL_STATUS });
      return;
    }

    // Main server, or the fallback if the main one doesn't answer; checked again at every connect
    // (the alarm calls it each minute), so it switches back when the main server returns
    const server = await pickServer(config);
    if (superseded()) return;
    activeApiUrl = server.apiUrl;
    setStatus({ usingFallback: server.isFallback, authHeldBack: config.heldBackFrom.length > 0 });
    const onServer = { ...config, apiUrl: server.apiUrl };

    const topics = await getReadableTopics(onServer);
    if (superseded()) return;
    if (topics.length === 0) {
      console.log('No configured topic is readable, not subscribing.');
      close();
      setStatus({ state: 'no-readable-topics', server: hostOf(server.apiUrl), retryAt: null });
      return;
    }
    const subscribed = { ...onServer, topics };
    const key = JSON.stringify([subscribed.apiUrl, topics, buildAuthHeaderValue(subscribed)]);
    if (subscription?.key === key) {
      return;
    }
    if (subscription) {
      console.log('Configuration changed, subscribing again...');
    }
    open(subscribed, key);
  }

  async function runSync(): Promise<void> {
    const configured = await getConfig();
    if (!configured.apiUrl || configured.topics.length === 0) return;
    // The server the subscription uses; before the first connect, pick one
    const apiUrl =
      activeApiUrl && [configured.apiUrl, configured.fallbackUrl].includes(activeApiUrl)
        ? activeApiUrl
        : (await pickServer(configured)).apiUrl;
    const config = { ...configured, apiUrl };

    const states = await getTopicSyncStates();
    const topics = await getReadableTopics(config);
    const syncErrors: [topic: string, error: string][] = [];
    let unreachable = false;

    for (const topic of topics) {
      const state = states.get(topic);
      const since = state?.since ?? INITIAL_SYNC_SINCE;
      // A topic's first poll loads its recent history without desktop notifications
      const notify = state?.synced === true;

      try {
        // Oldest first, and only the newest MAX_POLL_MESSAGES
        const messages = (await getNotifications(config, topic, since)).sort((a, b) => a.time - b.time).slice(-MAX_POLL_MESSAGES);
        for (const message of messages) {
          await handleMessage(message, notify);
        }
        await completePoll(topic, messages.at(-1)?.time ?? null);
      } catch (error) {
        const message = (error as Error).message;
        console.error(`Failed to sync missed messages for topic ${topic}:`, message);
        // No response (network error or timeout) or a 5xx: the server didn't answer
        const noResponse = isNoResponse(error);
        unreachable ||= noResponse || /^HTTP 5\d\d/.test(message);
        syncErrors.push([topic, noResponse ? 'no response' : message.replace(/:\s*$/, '')]);
      }
    }

    setStatus({ syncErrors, lastSyncAt: Date.now(), ...(unreachable && { unreachable: true }) });
    // The topics configured now: they may have changed during the poll
    await pruneTopicSyncStates((await getConfig()).topics);
  }

  /** Fetch missed messages; concurrent callers (stream open, alarm, popup) share the sync already running */
  function sync(): Promise<void> {
    if (!syncInFlight) {
      syncInFlight = runSync().finally(() => {
        syncInFlight = null;
      });
    }
    return syncInFlight;
  }

  return { connect, sync, close };
}
