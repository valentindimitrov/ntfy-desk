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
  /**
   * Origins of the configured servers that the stored token or password isn't approved for (the server
   * URL changed outside this browser's settings, e.g. through browser sync). While it isn't empty,
   * accessToken and credentials are empty: nothing is sent until the user confirms.
   */
  heldBackFrom: string[];
  topics: string[];
  includeUrl: boolean;
}

/** The server and authentication a request needs */
export type NtfyServer = Pick<NtfyConfig, 'apiUrl' | 'accessToken'> & { credentials?: Credentials | null };

/** Where the username and password live: storage.local, so browser sync doesn't copy them */
export const CREDENTIALS_KEY = 'serverCredentials';
/** Server origins the token and password are approved for (storage.local) */
export const AUTH_ORIGINS_KEY = 'authOrigins';

function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape such as "%" alone: keep it as typed
    return value;
  }
}

/**
 * A server URL without user:password@, and the credentials it carried (decoded). The URL parser
 * removes them, so the result points where the browser would send the request (a URL edited by hand
 * could put an @ where the parser doesn't expect one). A bare origin keeps having no trailing slash.
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
  const credentials = { username: decodeUserinfo(parsed.username), password: decodeUserinfo(parsed.password) };
  parsed.username = '';
  parsed.password = '';
  let clean = parsed.href;
  if (parsed.pathname === '/' && !parsed.search && !parsed.hash && !url.endsWith('/')) {
    clean = clean.slice(0, -1);
  }
  return { url: clean, credentials };
}

/** Origins of the main and fallback servers ('' and invalid URLs left out) */
export function serverOrigins(...urls: string[]): string[] {
  const origins = urls.flatMap((url) => {
    try {
      return url ? [new URL(url).origin] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(origins)];
}

/** Approve the token and password for these server origins */
export async function setAuthOrigins(origins: string[]): Promise<void> {
  await browser.storage.local.set({ [AUTH_ORIGINS_KEY]: origins });
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

/** Longest message JSON accepted from the server (a WebSocket frame or a poll line), in characters */
export const MAX_MESSAGE_JSON = 32 * 1024;
/** Longest poll response read, in bytes */
const MAX_POLL_BYTES = 4 * 1024 * 1024;
/** ntfy's limits: topic names and message ids of up to 64 characters, at most 3 actions */
const MAX_ID_LENGTH = 64;
const MAX_ACTIONS = 3;
const MAX_TAGS = 20;

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined);
const optionalNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;

function parseAction(value: unknown): NtfyAction | null {
  if (!isObject(value) || typeof value.action !== 'string' || typeof value.label !== 'string') {
    return null;
  }
  return {
    id: optionalString(value.id),
    action: value.action,
    label: value.label,
    url: optionalString(value.url),
    clear: value.clear === true ? true : undefined,
  };
}

function parseAttachment(value: unknown): NtfyAttachment | undefined {
  if (!isObject(value) || typeof value.url !== 'string') {
    return undefined;
  }
  return {
    name: optionalString(value.name),
    type: optionalString(value.type),
    size: optionalNumber(value.size),
    expires: optionalNumber(value.expires),
    url: value.url,
  };
}

/** The object without its undefined fields, as the server leaves out the ones it doesn't send */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/**
 * A message from the server (or from storage) with the fields the extension uses, each of the expected
 * type; null if it isn't a usable message. Unknown fields are dropped, so a hostile or broken server
 * can't store values the popup would fail to render.
 */
export function parseMessage(value: unknown): NtfyMessage | null {
  if (!isObject(value) || !isId(value.id) || !isId(value.topic) || typeof value.event !== 'string') {
    return null;
  }
  const time = optionalNumber(value.time);
  if (time === undefined) {
    return null;
  }
  const priority = optionalNumber(value.priority);
  const attachment = parseAttachment(value.attachment);
  return withoutUndefined<NtfyMessage>({
    id: value.id,
    time,
    event: value.event,
    topic: value.topic,
    title: optionalString(value.title),
    message: optionalString(value.message),
    priority: priority !== undefined && Number.isInteger(priority) && priority >= 1 && priority <= 5 ? priority : undefined,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, MAX_TAGS) : undefined,
    click: optionalString(value.click),
    actions: Array.isArray(value.actions)
      ? value.actions
          .map(parseAction)
          .filter((action): action is NtfyAction => action !== null)
          .map(withoutUndefined)
          .slice(0, MAX_ACTIONS)
      : undefined,
    attachment: attachment && withoutUndefined(attachment),
    expires: optionalNumber(value.expires),
    content_type: optionalString(value.content_type),
  });
}

/** A message from one line of JSON (WebSocket frame or poll line); null if it's too long or not a message */
export function parseMessageJson(json: string): NtfyMessage | null {
  if (json.length > MAX_MESSAGE_JSON) {
    return null;
  }
  try {
    return parseMessage(JSON.parse(json));
  } catch {
    return null;
  }
}

/** A response body as text, up to maxBytes; a longer body is cancelled with an error */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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

/** The token and the username and password as stored, for the settings form; getConfig is for requests */
export async function getStoredAuth(): Promise<Pick<NtfyConfig, 'accessToken' | 'credentials'>> {
  const local = await browser.storage.local.get(['accessToken', CREDENTIALS_KEY]);
  const stored = local[CREDENTIALS_KEY];
  return {
    accessToken: typeof local.accessToken === 'string' ? local.accessToken : '',
    credentials: isCredentials(stored) ? stored : null,
  };
}

/**
 * Server URLs and topics come from storage.sync; the access token and the username and password stay
 * in storage.local, so browser sync doesn't copy them. A synced URL that still carries user:password@
 * (saved by an earlier version) is moved: credentials to storage.local, the URL without them.
 *
 * The token and password are used only with the server origins approved on this device (in its
 * settings): a server URL changed through browser sync gets no credentials until the user confirms
 * (heldBackFrom). Without approvals stored yet (an earlier version), the current servers are approved.
 */
export async function getConfig(): Promise<NtfyConfig> {
  const [synced, local] = await Promise.all([
    browser.storage.sync.get(['apiUrl', 'fallbackUrl', 'topics', 'includeUrl']),
    browser.storage.local.get(['accessToken', CREDENTIALS_KEY, AUTH_ORIGINS_KEY]),
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

  const accessToken = typeof local.accessToken === 'string' ? local.accessToken : '';
  const origins = serverOrigins(main.url, fallback.url);
  let heldBackFrom: string[] = [];
  if (accessToken || credentials) {
    const approved: unknown = local[AUTH_ORIGINS_KEY];
    if (Array.isArray(approved)) {
      heldBackFrom = origins.filter((origin) => !approved.includes(origin));
    } else if (origins.length > 0) {
      // Not with no server yet: the URL arriving later would then be held back
      await setAuthOrigins(origins);
    }
  }
  const held = heldBackFrom.length > 0;

  return {
    apiUrl: main.url,
    fallbackUrl: fallback.url,
    accessToken: held ? '' : accessToken,
    credentials: held ? null : credentials,
    heldBackFrom,
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

/**
 * No redirects with credentials: the browser drops the Authorization header on a redirect to another
 * origin, but keeps it on the same origin, where a redirect could reach any path (ntfy publishes on GET)
 */
function redirectPolicy(headers: Headers): RequestRedirect {
  return headers.has('Authorization') ? 'error' : 'follow';
}

async function post(url: string, headers: Headers, body: BodyInit, timeout: number): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    redirect: redirectPolicy(headers),
    signal: AbortSignal.timeout(timeout),
  });
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
    const headers = buildAuthHeaders(server);
    const response = await fetch(`${buildTopicUrl(server.apiUrl, topic)}/auth`, {
      method: 'GET',
      headers,
      redirect: redirectPolicy(headers),
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

  const headers = buildAuthHeaders(server);
  const response = await fetch(`${buildTopicUrl(server.apiUrl, topic)}/json?poll=1&since=${since}`, {
    method: 'GET',
    headers,
    redirect: redirectPolicy(headers),
    signal: AbortSignal.timeout(TIMEOUTS.poll),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const text = await readLimited(response, MAX_POLL_BYTES);
  // NDJSON; keep valid message events of this topic only (not open or keepalive)
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map(parseMessageJson)
    .filter((message): message is NtfyMessage => message !== null && message.event === 'message' && message.topic === topic);
}
