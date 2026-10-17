// Receiving: one WebSocket subscription for live messages, and a poll per topic for messages
// missed while the socket was down or the browser closed.

import { getTopicSyncStates, initTopicSyncState, pruneTopicSyncStates, recordMessage } from './history';
import {
  base64UrlEncode,
  buildAuthHeaderValue,
  canReadTopic,
  getConfig,
  getNotifications,
  type NtfyConfig,
  type NtfyMessage,
} from './ntfy';

const INITIAL_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 60000;
// Chrome stops an idle extension service worker after 30 s. Since Chrome 116, WebSocket traffic resets
// that timer, but ntfy only sends a keepalive every 45 s by default, so send a small frame of our own.
// ntfy reads and discards client frames of up to 64 bytes.
export const WS_KEEPALIVE_INTERVAL = 20000;
// How long the read-access check of the topics is reused
const READABLE_TOPICS_TTL = 60 * 60 * 1000;
// Window fetched silently the first time a topic is synced
export const INITIAL_SYNC_SINCE = '24h';

export interface ReceiverEvents {
  /** A message new to the history (not during a topic's first, silent sync) */
  onNewMessage(message: NtfyMessage): void;
  /** The socket opened */
  onConnected?(): void;
}

/** url may carry the credentials in ?auth=; logUrl never does */
export function buildWsUrl(config: Pick<NtfyConfig, 'apiUrl' | 'accessToken' | 'topics'>): { url: string; logUrl: string } {
  const apiUrl = /^https?:\/\//i.test(config.apiUrl) ? config.apiUrl : `https://${config.apiUrl}`;

  // Host only, like the HTTP calls: credentials embedded in the URL must not end up in the WebSocket URL
  const urlObj = new URL(apiUrl);
  const scheme = urlObj.protocol === 'http:' ? 'ws:' : 'wss:';
  const logUrl = `${scheme}//${urlObj.host}/${config.topics.join(',')}/ws`;

  // Browsers can't set headers on a WebSocket, so ntfy accepts the Authorization header value in ?auth=
  const auth = buildAuthHeaderValue(config.accessToken, config.apiUrl);
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

  // ntfy rejects a subscription to several topics if any one of them isn't readable, and a topic the
  // token can only send to is a normal setup. So subscribe to, and poll, the readable topics only.
  async function getReadableTopics(config: NtfyConfig): Promise<string[]> {
    const key = JSON.stringify([config.apiUrl, config.accessToken, config.topics]);
    if (readableTopicsCache.key === key && Date.now() - readableTopicsCache.time < READABLE_TOPICS_TTL) {
      return readableTopicsCache.topics;
    }

    const access = await Promise.all(config.topics.map(topic => canReadTopic(config, topic)));
    // A topic the server couldn't be asked about (null) is kept, and the result isn't cached
    const topics = config.topics.filter((_, i) => access[i] !== false);
    const skipped = config.topics.filter((_, i) => access[i] === false);
    if (skipped.length > 0) {
      console.log(`Not receiving from topics without read access: ${skipped.join(', ')}`);
    }
    if (!access.includes(null)) {
      readableTopicsCache = { key, topics, time: Date.now() };
    }
    return topics;
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

      socket.onopen = () => {
        console.log('WebSocket connected successfully.');
        reconnectDelay = INITIAL_RECONNECT_DELAY;
        startKeepalive(socket);
        void sync();
        events.onConnected?.();
      };

      socket.onmessage = async (event: MessageEvent) => {
        try {
          const message = JSON.parse(String(event.data)) as NtfyMessage;
          if (message.event === 'message') {
            console.log('Received notification:', message.id, message.title);
            await handleMessage(message, true);
          }
        } catch (error) {
          console.error('Error processing WebSocket message:', error);
        }
      };

      socket.onclose = (event: CloseEvent) => {
        stopKeepalive();
        console.log(`WebSocket closed. Code: ${event.code}, Reason: ${event.reason}. Reconnecting...`);
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
    const config = await getConfig();
    if (!config.apiUrl || config.topics.length === 0) {
      console.log('ntfy is not configured, skipping WebSocket connection.');
      close();
      return;
    }

    const topics = await getReadableTopics(config);
    if (topics.length === 0) {
      console.log('No configured topic is readable, skipping WebSocket connection.');
      close();
      return;
    }
    const subscription = { ...config, topics };

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
    const config = await getConfig();
    if (!config.apiUrl || config.topics.length === 0) return;

    const states = await getTopicSyncStates();
    const topics = await getReadableTopics(config);

    for (const topic of topics) {
      // A topic synced for the first time gets its recent history without desktop notifications
      const state = states[topic];
      const since = state && state.since !== null ? state.since : INITIAL_SYNC_SINCE;

      try {
        const messages = await getNotifications(config, topic, since);
        messages.sort((a, b) => a.time - b.time);
        for (const message of messages) {
          await handleMessage(message, Boolean(state));
        }
        if (!state) {
          await initTopicSyncState(topic);
        }
      } catch (error) {
        console.error(`Failed to sync missed messages for topic ${topic}:`, (error as Error).message);
      }
    }

    await pruneTopicSyncStates(config.topics);
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

