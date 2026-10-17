// Receiving: one WebSocket subscription for live messages, and a poll per topic for messages
// missed while the socket was down or the browser closed.

import { completePoll, getTopicSyncStates, pruneTopicSyncStates, recordMessage } from './history';
import { pickServer } from './servers';
import { INITIAL_STATUS, writeReceiverStatus, type ReceiverStatus } from './status';
import {
  base64UrlEncode,
  buildAuthHeaderValue,
  canReadTopic,
  getConfig,
  getNotifications,
  isNoResponse,
  type NtfyConfig,
  type NtfyMessage,
} from './ntfy';

const INITIAL_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 60000;
// Chrome stops an idle extension service worker after 30 s, and WebSocket traffic resets that timer,
// but ntfy only sends a keepalive every 45 s by default, so send a small frame of our own.
// ntfy reads and discards client frames of up to 64 bytes.
export const WS_KEEPALIVE_INTERVAL = 20000;
// How long the read-access check of the topics is reused
const READABLE_TOPICS_TTL = 60 * 60 * 1000;
// Window fetched silently the first time a topic is synced
const INITIAL_SYNC_SINCE = '24h';

export interface ReceiverEvents {
  /** A message new to the history (not during a topic's first, silent sync) */
  onNewMessage(message: NtfyMessage): void;
  /** The socket opened */
  onConnected?(): void;
}

/** url may carry the credentials in ?auth=; logUrl never does */
export function buildWsUrl(config: Pick<NtfyConfig, 'apiUrl' | 'accessToken' | 'topics'> & Partial<Pick<NtfyConfig, 'credentials'>>): {
  url: string;
  logUrl: string;
} {
  const apiUrl = /^https?:\/\//i.test(config.apiUrl) ? config.apiUrl : `https://${config.apiUrl}`;

  // Host only, like the HTTP calls: credentials embedded in the URL must not end up in the WebSocket URL
  const urlObj = new URL(apiUrl);
  const scheme = urlObj.protocol === 'http:' ? 'ws:' : 'wss:';
  const logUrl = `${scheme}//${urlObj.host}/${config.topics.join(',')}/ws`;

  // Browsers can't set headers on a WebSocket, so ntfy accepts the Authorization header value in ?auth=
  const auth = buildAuthHeaderValue(config);
  const url = auth ? `${logUrl}?auth=${base64UrlEncode(auth)}` : logUrl;

  return { url, logUrl };
}

export function createReceiver(events: ReceiverEvents) {
  let ws: WebSocket | null = null;
  let wsUrl: string | null = null; // URL the current socket was opened with, to detect configuration changes
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
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

  function startKeepalive(socket: WebSocket): void {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send('keepalive');
      }
    }, WS_KEEPALIVE_INTERVAL);
  }

  function stopKeepalive(): void {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function close(): void {
    stopKeepalive();
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
      wsUrl = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;

    console.log(`Scheduling WebSocket reconnect in ${reconnectDelay / 1000}s...`);
    setStatus({ state: 'reconnecting', retryAt: Date.now() + reconnectDelay });
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

  function open(config: NtfyConfig): void {
    close();

    try {
      const { url, logUrl } = buildWsUrl(config);
      console.log('Connecting WebSocket to:', logUrl);
      const socket = new WebSocket(url);
      ws = socket;
      wsUrl = url;
      let opened = false;

      if (status.state !== 'reconnecting') {
        setStatus({ state: 'connecting', server: hostOf(config.apiUrl), retryAt: null });
      } else {
        setStatus({ server: hostOf(config.apiUrl) });
      }

      socket.onopen = () => {
        console.log('WebSocket connected successfully.');
        opened = true;
        reconnectDelay = INITIAL_RECONNECT_DELAY;
        setStatus({ state: 'connected', retryAt: null, unreachable: false });
        startKeepalive(socket);
        void sync();
        events.onConnected?.();
      };

      socket.onmessage = async (event: MessageEvent) => {
        try {
          const message = JSON.parse(String(event.data)) as NtfyMessage;
          if (message.event === 'message') {
            console.log('Received notification:', message.id);
            await handleMessage(message, true);
          }
        } catch (error) {
          console.error('Error processing WebSocket message:', error);
        }
      };

      socket.onclose = (event: CloseEvent) => {
        stopKeepalive();
        console.log(`WebSocket closed. Code: ${event.code}, Reason: ${event.reason}. Reconnecting...`);
        // Refused before it opened (e.g. 403 after read access to a topic was revoked): check the
        // topics' access again instead of reusing the cached result
        if (!opened) {
          readableTopicsCache = { key: null, topics: [], time: 0 };
        }
        scheduleReconnect();
      };

      // Don't log the event or the exception: they contain the URL, and with it the ?auth= credentials
      socket.onerror = () => {
        console.error('WebSocket error');
      };
    } catch (error) {
      console.error('Failed to create WebSocket:', (error as Error).name);
      scheduleReconnect();
    }
  }

  /** Open the socket, or reopen it if the server, credentials or readable topics changed */
  async function connect(): Promise<void> {
    const generation = ++connectGeneration;
    const superseded = () => generation !== connectGeneration;

    const config = await getConfig();
    if (superseded()) return;
    if (!config.apiUrl || config.topics.length === 0) {
      console.log('ntfy is not configured, skipping WebSocket connection.');
      close();
      setStatus({ ...INITIAL_STATUS });
      return;
    }

    // Main server, or the fallback if the main one doesn't answer; checked again at every connect
    // (the alarm calls it each minute), so it switches back when the main server returns
    const server = await pickServer(config);
    if (superseded()) return;
    activeApiUrl = server.apiUrl;
    setStatus({ usingFallback: server.isFallback });
    const onServer = { ...config, apiUrl: server.apiUrl };

    const topics = await getReadableTopics(onServer);
    if (superseded()) return;
    if (topics.length === 0) {
      console.log('No configured topic is readable, skipping WebSocket connection.');
      close();
      setStatus({ state: 'no-readable-topics', server: hostOf(server.apiUrl), retryAt: null });
      return;
    }
    const subscription = { ...onServer, topics };

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      let expectedUrl: string | null = null;
      try {
        expectedUrl = buildWsUrl(subscription).url;
      } catch {
        // Invalid server URL: reconnect, which fails and retries
      }
      if (wsUrl === expectedUrl) {
        return;
      }
      console.log('Configuration changed, reconnecting WebSocket...');
    }

    open(subscription);
  }

  async function runSync(): Promise<void> {
    const configured = await getConfig();
    if (!configured.apiUrl || configured.topics.length === 0) return;
    // The server the socket uses; before the first connect, pick one
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
        const messages = await getNotifications(config, topic, since);
        messages.sort((a, b) => a.time - b.time);
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

  /** Fetch missed messages; concurrent callers (socket open, alarm, popup) share the sync already running */
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

export type Receiver = ReturnType<typeof createReceiver>;
