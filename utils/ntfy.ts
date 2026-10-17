// ntfy server API: configuration, authentication, publishing and polling.
// Used by the background script and the popup.

import { browser } from 'wxt/browser';

/** Username and password for Basic authentication (used when there's no access token) */
export interface Credentials {
  username: string;
  password: string;
}

export interface NtfyConfig {
  /** Server URL, without credentials */
  apiUrl: string;
  /** Another URL of the same server, used when apiUrl doesn't answer ('' for none); without credentials */
  fallbackUrl: string;
  accessToken: string;
  /** For both URLs (they are the same server); null without */
  credentials: Credentials | null;
  topics: string[];
  includeUrl: boolean;
}

/** The server and authentication a request needs */
export type NtfyServer = Pick<NtfyConfig, 'apiUrl' | 'accessToken'> & { credentials?: Credentials | null };

/** Where the username and password live: storage.local, so browser sync doesn't copy them */
export const CREDENTIALS_KEY = 'serverCredentials';

/**
 * A server URL without user:password@, and the credentials it carried (decoded). The rest of the URL
 * is kept as written.
 */
export function splitCredentials(url: string): { url: string; credentials: Credentials | null } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, credentials: null };
  }
  if (!parsed.username && !parsed.password) {
    return { url, credentials: null };
  }
  const credentials = { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) };
  // Everything after the userinfo, as written (URL.toString() would add a trailing slash). The
  // userinfo ends at the last @ before the path, as the URL parser reads it.
  const authorityStart = url.indexOf('//') + 2;
  const pathStart = url.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = pathStart === -1 ? url.length : authorityStart + pathStart;
  const rest = url.slice(url.lastIndexOf('@', authorityEnd) + 1);
  return { url: `${parsed.protocol}//${rest}`, credentials };
}

function isCredentials(value: unknown): value is Credentials {
  const candidate = value as Partial<Credentials> | null;
  return typeof candidate?.username === 'string' && typeof candidate.password === 'string';
}

/** Save the username and password (storage.local), or remove them when both are empty */
export async function setCredentials(credentials: Credentials | null): Promise<void> {
  if (credentials && (credentials.username || credentials.password)) {
    await browser.storage.local.set({ [CREDENTIALS_KEY]: credentials });
  } else {
    await browser.storage.local.remove([CREDENTIALS_KEY]);
  }
}

export interface NtfyAttachment {
  name?: string;
  type?: string;
  size?: number;
  expires?: number;
  url: string;
}

/** An action button of a message (https://docs.ntfy.sh/publish/#action-buttons) */
export interface NtfyAction {
  id?: string;
  /** view, http or broadcast (other values may come with newer servers) */
  action: string;
  label: string;
  url?: string;
  /** Dismiss the notification when the action is used */
  clear?: boolean;
}

/** A message as ntfy delivers it (JSON stream, poll or WebSocket) */
export interface NtfyMessage {
  id: string;
  time: number;
  event: string;
  topic: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  /** URL to open when the notification is clicked */
  click?: string;
  actions?: NtfyAction[];
  attachment?: NtfyAttachment;
  expires?: number;
  /** text/markdown for Markdown messages */
  content_type?: string;
}

export interface PublishOptions {
  message?: string;
  title?: string;
  priority?: number;
  tags?: string;
}

export interface AttachmentOptions extends PublishOptions {
  data: BodyInit;
  filename: string;
  /** Explicit MIME type for the attachment */
  contentType?: string;
}

export function parseTopics(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((topic) => topic.trim())
        .filter(Boolean)
    : [];
}

/**
 * Server URLs and topics come from storage.sync; the access token and the username and password stay
 * in storage.local, so browser sync doesn't copy them. A synced URL that still carries user:password@
 * (saved by an earlier version) is moved: credentials to storage.local, the URL without them.
 */
export async function getConfig(): Promise<NtfyConfig> {
  const [synced, local] = await Promise.all([
    browser.storage.sync.get(['apiUrl', 'fallbackUrl', 'topics', 'includeUrl']),
    browser.storage.local.get(['accessToken', CREDENTIALS_KEY]),
  ]);
  const main = splitCredentials(typeof synced.apiUrl === 'string' ? synced.apiUrl : '');
  const fallback = splitCredentials(typeof synced.fallbackUrl === 'string' ? synced.fallbackUrl : '');
  const stored = local[CREDENTIALS_KEY];
  const credentials = isCredentials(stored) ? stored : (main.credentials ?? fallback.credentials);

  if (main.credentials || fallback.credentials) {
    if (!isCredentials(stored)) {
      await setCredentials(credentials);
    }
    await browser.storage.sync.set({ apiUrl: main.url, fallbackUrl: fallback.url });
  }

  return {
    apiUrl: main.url,
    fallbackUrl: fallback.url,
    accessToken: typeof local.accessToken === 'string' ? local.accessToken : '',
    credentials,
    topics: parseTopics(synced.topics),
    includeUrl: synced.includeUrl === true,
  };
}

export async function setAccessToken(accessToken: string): Promise<void> {
  await browser.storage.local.set({ accessToken: accessToken || '' });
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Encode a string as ntfy's ?auth= query parameter expects it: base64url without padding
 * (Go's base64.RawURLEncoding) of the whole Authorization header value
 */
export function base64UrlEncode(value: string): string {
  return base64Encode(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Authorization header value: Bearer with the access token, else Basic with the username and password
 * (else with credentials still in the URL); '' without authentication
 */
export function buildAuthHeaderValue(server: NtfyServer): string {
  if (server.accessToken) {
    return `Bearer ${server.accessToken}`;
  }
  const credentials = server.credentials ?? splitCredentials(server.apiUrl).credentials;
  if (credentials && (credentials.username || credentials.password)) {
    return `Basic ${base64Encode(`${credentials.username}:${credentials.password}`)}`;
  }
  return '';
}

export function hasAuthentication(server: NtfyServer): boolean {
  return buildAuthHeaderValue(server) !== '';
}

function buildAuthHeaders(server: NtfyServer): Headers {
  const headers = new Headers();
  const auth = buildAuthHeaderValue(server);
  if (auth) {
    headers.set('Authorization', auth);
  }
  return headers;
}

/** Whether a URL from a received message is safe to open or copy: http(s) only */
export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string') {
    return false;
  }
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Topic URL on the server's origin (a path or credentials in the server URL are dropped) */
export function buildTopicUrl(apiUrl: string, topic: string): string {
  return `${new URL(apiUrl).origin}/${topic}`;
}

/**
 * Header value, RFC 2047-encoded if it contains non-ASCII or control characters (a header can't hold
 * a line break, so a multi-line message would make Headers.set throw; ntfy decodes it back)
 */
export function encodeHeaderValue(value: string | undefined): string {
  if (!value) return '';
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7E]/.test(value)) {
    return `=?utf-8?B?${base64Encode(value)}?=`;
  }
  return value;
}

function setPublishHeaders(headers: Headers, { title, priority, tags }: PublishOptions): void {
  if (title) {
    headers.set('X-Title', encodeHeaderValue(title));
  }
  if (priority && priority !== 3) {
    headers.set('X-Priority', priority.toString());
  }
  if (tags) {
    headers.set('X-Tags', encodeHeaderValue(tags));
  }
}

/** Time limits, so a server that accepts a request but never answers can't stall a sync or a send */
const TIMEOUTS = { check: 10_000, poll: 20_000, publish: 30_000, upload: 120_000, image: 30_000 };

/** The server gave no response: a network error (fetch rejects with a TypeError) or a time limit */
export function isNoResponse(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError'));
}

async function post(url: string, headers: Headers, body: BodyInit, timeout: number): Promise<Response> {
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response;
}

export function sendNotification(server: NtfyServer, topic: string, options: PublishOptions): Promise<Response> {
  const headers = buildAuthHeaders(server);
  setPublishHeaders(headers, options);
  return post(buildTopicUrl(server.apiUrl, topic), headers, options.message || '', TIMEOUTS.publish);
}

export function sendAttachment(server: NtfyServer, topic: string, options: AttachmentOptions): Promise<Response> {
  const headers = buildAuthHeaders(server);
  headers.set('X-Filename', encodeHeaderValue(options.filename));
  if (options.contentType) {
    headers.set('Content-Type', options.contentType);
  }
  if (options.message) {
    headers.set('X-Message', encodeHeaderValue(options.message));
  }
  setPublishHeaders(headers, options);
  return post(buildTopicUrl(server.apiUrl, topic), headers, options.data, TIMEOUTS.upload);
}

/** Fetch an image and send it as attachment */
export async function sendImageFromUrl(
  server: NtfyServer,
  topic: string,
  imageUrl: string,
  message?: string,
  title?: string,
): Promise<Response> {
  const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(TIMEOUTS.image) });
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch image: ${imageResponse.status}`);
  }

  const imageBlob = await imageResponse.blob();
  const imageBuffer = await imageBlob.arrayBuffer();

  let filename: string;
  try {
    const lastPart = new URL(imageUrl).pathname.split('/').pop();
    // Without an extension in the URL, take it from the MIME type
    filename = lastPart && lastPart.includes('.') ? lastPart : `image.${imageBlob.type.split('/')[1] || 'png'}`;
  } catch {
    filename = 'image.png';
  }

  return sendAttachment(server, topic, { data: imageBuffer, filename, message, title });
}

/** Whether the credentials can read a topic (ntfy's GET /<topic>/auth); null if the server couldn't be asked */
export async function canReadTopic(server: NtfyServer, topic: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${buildTopicUrl(server.apiUrl, topic)}/auth`, {
      method: 'GET',
      headers: buildAuthHeaders(server),
      signal: AbortSignal.timeout(TIMEOUTS.check),
    });
    if (response.ok) {
      return true;
    }
    if (response.status === 401 || response.status === 403) {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

/** Cached messages of a topic: since is a message id, a unix time, a duration such as '24h', or 'all' */
export async function getNotifications(server: NtfyServer, topic: string, since: string | number = 'all'): Promise<NtfyMessage[]> {
  if (!server.apiUrl) {
    throw new Error('API URL is not configured');
  }

  const response = await fetch(`${buildTopicUrl(server.apiUrl, topic)}/json?poll=1&since=${since}`, {
    method: 'GET',
    headers: buildAuthHeaders(server),
    signal: AbortSignal.timeout(TIMEOUTS.poll),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const text = await response.text();
  // NDJSON; keep message events only (not open or keepalive)
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as NtfyMessage;
      } catch (error) {
        console.error('Failed to parse notification line:', error);
        return null;
      }
    })
    .filter((message): message is NtfyMessage => message !== null && message.event === 'message');
}
