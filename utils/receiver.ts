// Receiving: one subscription (ntfy's JSON stream) for live messages, and a poll per topic for messages
// missed while the stream was down or the browser closed.

import { browser } from 'wxt/browser';
import {
  getHistoryState,
  getTopicSyncStates,
  invalidateDeletionReplays,
  pruneTopicSyncStates,
  recordDeletionReplay,
  recordMessage,
  recordPoll,
  topicStateForServer,
  type HistorySource,
} from './history';
import { pickServer } from './servers';
import { INITIAL_STATUS, writeReceiverStatus, type ReceiverStatus } from './status';
import {
  buildAuthHeaderValue,
  canReadTopic,
  getConfig,
  getNotifications,
  isNoResponse,
  openMessageStream,
  parseMessageJson,
  readLines,
  serverOrigins,
  type NtfyConfig,
  type NtfyMessage,
} from './ntfy';
import { getSyncDeletionTopics } from './sync-modes';

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
const TRUNCATION_WARNING_TTL = 24 * 60 * 60 * 1000;
const INCOMPLETE_REPLAY_RETRY = 15 * 60 * 1000;
const EMPTY_POLL_OVERLAP = 60;

function sinceEmptyPoll(started: number, emptyPollAt?: number): string {
  if (emptyPollAt === undefined) return INITIAL_SYNC_SINCE;
  const elapsed = Math.ceil((started - emptyPollAt) / 1000);
  return elapsed < 0 ? 'all' : `${elapsed + EMPTY_POLL_OVERLAP}s`;
}

export interface ReceiverEvents {
  /** A message new to the history (not during a topic's first, silent sync) */
  onNewMessage(message: NtfyMessage): void;
  /** A completed catch-up delivers its saved messages together for notification grouping. */
  onCatchUp?(messages: NtfyMessage[]): void;
  /** Stored messages removed by a server deletion or replaced by an update (their desktop notifications go too) */
  onRemoved?(ids: string[]): void;
  /** The subscription opened */
  onConnected?(): void;
}

/** One open (or opening) subscription */
interface Subscription {
  controller: AbortController;
  /** Server, topics and authentication it was opened with, to detect configuration changes */
  key: string;
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

  /** A line of the stream: accept messages and deletions of the subscribed topics only. */
  async function handleLine(line: string, topics: string[], source: HistorySource): Promise<void> {
    const message = parseMessageJson(line);
    if (!message || (message.event !== 'message' && message.event !== 'message_delete') || !topics.includes(message.topic)) {
      return;
    }
    try {
      const { added, removed } = await recordMessage(message, source);
      if (removed.length > 0) events.onRemoved?.(removed);
      if (added.length > 0) events.onNewMessage(message);
    } catch (error) {
      console.error('Error processing a live message:', error);
    }
  }

  /** Subscribe; reconnects when the stream fails, ends or stays silent, until close() or a newer open() */
  function open(config: NtfyConfig, key: string, origins: string[]): void {
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
        const source = { origin: new URL(response.url || config.apiUrl).origin, origins };

        opened = true;
        reconnectDelay = INITIAL_RECONNECT_DELAY;
        setStatus({ state: 'connected', retryAt: null, unreachable: false });
        startKeepalive();
        resetIdleTimer(current);
        void sync();
        events.onConnected?.();

        await readLines(
          response.body,
          async (line) => {
            if (isCurrent()) await handleLine(line, config.topics, source);
          },
          { onData: () => resetIdleTimer(current) },
        );
        console.log('The server ended the subscription. Reconnecting...');
      } catch (error) {
        if (!isCurrent()) return; // closed, or replaced by a newer subscription
        const message = error instanceof Error ? error.message : String(error);
        console.log(`Subscription failed (${message}). Reconnecting...`);
        unreachable = isNoResponse(error) || /^HTTP 5\d\d/.test(message);
      }
      if (!isCurrent()) return;

      // Cleared before the abort, so nothing still reading treats it as current. The abort releases
      // a response body left unread (an HTTP error) or a read loop that ended with an error.
      subscription = null;
      current.controller.abort();
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
    const origins = serverOrigins(config.apiUrl, config.fallbackUrl);
    const key = JSON.stringify([subscribed.apiUrl, origins, topics, buildAuthHeaderValue(subscribed)]);
    if (subscription?.key === key) {
      return;
    }
    if (subscription) {
      console.log('Configuration changed, subscribing again...');
    }
    open(subscribed, key, origins);
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

    const [states, topics, syncDeletions] = await Promise.all([getTopicSyncStates(), getReadableTopics(config), getSyncDeletionTopics()]);
    const origins = serverOrigins(configured.apiUrl, configured.fallbackUrl);
    const topicState = (topic: string) => topicStateForServer(states.get(topic), origins);
    const saved = new Map<string, NtfyMessage[]>();
    // Saved rows of every topic: a poll keeps their position in the server's order (updates, deletions)
    {
      const { receivedNotifications } = await getHistoryState();
      for (const message of receivedNotifications) {
        if (!topics.includes(message.topic) || !origins.includes(message.serverOrigin)) continue;
        const rows = saved.get(message.topic) ?? [];
        rows.push(message);
        saved.set(message.topic, rows);
      }
    }
    const syncErrors = new Map<string, string>();
    const cutoff = Date.now() - TRUNCATION_WARNING_TTL;
    const truncatedTopics = new Set(topics.filter((topic) => (topicState(topic)?.truncatedAt ?? 0) > cutoff));
    const unverifiedDeletionTopics = new Set<string>();
    const catchUpMessages: NtfyMessage[] = [];
    let unreachable = false;

    function reportSyncError(topic: string, error: unknown, prefix = ''): boolean {
      const message = error instanceof Error ? error.message : '';
      const httpStatus = /^HTTP [1-5]\d\d\b/.exec(message)?.[0];
      const noResponse = isNoResponse(error);
      const detail = noResponse ? 'no response' : (httpStatus ?? (message === 'Response too large' ? message : 'request failed'));
      console.error(`Failed to sync topic ${topic}:`, detail);
      syncErrors.set(topic, prefix + detail);
      return noResponse || httpStatus?.startsWith('HTTP 5') === true;
    }

    for (const topic of topics) {
      const state = topicState(topic);
      const savedMessages = saved.get(topic) ?? [];
      const includeDeletions = syncDeletions.has(topic);
      const progress = state?.deletionReplay;
      if (includeDeletions && !progress?.complete && (progress?.retryAt ?? 0) <= Date.now()) {
        try {
          // Not Math.min(...rows): the row count follows a setting, and a spread has an argument limit
          const oldest = savedMessages.reduce((min, { time }) => Math.min(min, time), Infinity);
          const since = Math.max(1, Math.floor(progress?.nextSince ?? oldest));
          const replay = Number.isFinite(since)
            ? await getNotifications(config, topic, since, { includeDeletions, savedMessages })
            : {
                events: [],
                serverOrigin: new URL(apiUrl).origin,
                truncated: false,
                scanLimited: false,
                serverTruncated: false,
                truncationKnown: true,
              };
          if (!origins.includes(replay.serverOrigin)) throw new Error('Unexpected server origin');
          const complete = !replay.scanLimited && !replay.serverTruncated && replay.truncationKnown;
          const last = replay.events.at(-1)?.time ?? since;
          const canContinue = replay.scanLimited && !replay.serverTruncated && last > since;
          const removed = await recordDeletionReplay(
            topic,
            replay.events,
            { origin: replay.serverOrigin, origins },
            progress?.generation ?? 0,
            replay.truncated,
            {
              complete,
              nextSince: canContinue ? last : progress?.nextSince,
              retryAt: !complete && !canContinue ? Date.now() + INCOMPLETE_REPLAY_RETRY : undefined,
            },
          );
          if (removed.length > 0) events.onRemoved?.(removed);
          if (replay.truncated) truncatedTopics.add(topic);
          if (!replay.truncationKnown) unverifiedDeletionTopics.add(topic);
        } catch (error) {
          // The next sync retries the replay. A large or failed replay must not stop regular catch-up.
          unreachable = reportSyncError(topic, error, 'deletion replay: ') || unreachable;
        }
      }

      try {
        const started = Date.now();
        const watermark = state?.since ?? null;
        const emptyPollAt = state?.emptyPollAt;
        const since = watermark ?? sinceEmptyPoll(started, emptyPollAt);
        const replay = await getNotifications(config, topic, since, { includeDeletions, savedMessages });
        // A single second can fill even the scan limit. Skip that second only if the
        // bounded replay couldn't move the inclusive cursor forward.
        const empty = watermark === null && replay.events.length === 0 && !replay.truncated;
        const emptyStart =
          empty && replay.serverTime !== undefined ? Math.max(1, Math.floor(replay.serverTime / 1000) - EMPTY_POLL_OVERLAP) : undefined;
        const advanceTo =
          replay.scanLimited && typeof since === 'number' && replay.events.every((event) => event.time <= since)
            ? Math.floor(since) + 1
            : emptyStart;
        const { added: messages, removed } = await recordPoll(
          topic,
          replay.events,
          { origin: replay.serverOrigin, origins },
          {
            truncated: replay.truncated,
            positionOnly: replay.positionOnly,
            advanceTo,
            emptyPollAt: empty ? (emptyPollAt ?? started) : emptyPollAt,
          },
        );
        if (replay.truncated) truncatedTopics.add(topic);
        if (includeDeletions && !replay.truncationKnown) unverifiedDeletionTopics.add(topic);
        if (removed.length > 0) events.onRemoved?.(removed);
        if (events.onCatchUp) catchUpMessages.push(...messages);
        else for (const message of messages) events.onNewMessage(message);
      } catch (error) {
        unreachable = reportSyncError(topic, error) || unreachable;
      }
    }
    if (catchUpMessages.length) {
      const { receivedNotifications } = await getHistoryState();
      const retained = new Set(receivedNotifications.map(({ id }) => id));
      events.onCatchUp?.(catchUpMessages.filter(({ id }) => retained.has(id)));
    }

    setStatus({
      syncErrors: [...syncErrors],
      truncatedTopics: [...truncatedTopics],
      unverifiedDeletionTopics: [...unverifiedDeletionTopics],
      lastSyncAt: Date.now(),
      ...(unreachable && { unreachable: true }),
    });
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

  async function replayDeletions(topics: string[]): Promise<void> {
    const config = await getConfig();
    await invalidateDeletionReplays(topics, serverOrigins(config.apiUrl, config.fallbackUrl));
    // A poll already in flight may have captured the old mode. Follow it with a fresh one.
    await syncInFlight?.catch(() => {});
    await sync();
  }

  return { connect, sync, close, replayDeletions };
}
