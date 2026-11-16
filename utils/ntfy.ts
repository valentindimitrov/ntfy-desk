// ntfy server API: configuration, authentication, publishing, polling and the subscription stream.
// Used by the background script and the popup.

import { browser } from 'wxt/browser';
import { MAX_ATTACHMENT_BYTES } from './stored-files';

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
 * A server URL without userinfo, query parameters or fragments, and the decoded userinfo.
 * Query parameters can carry ntfy authentication too. A bare origin keeps having no trailing slash.
 */
export function splitCredentials(url: string): { url: string; credentials: Credentials | null } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, credentials: null };
  }
  const hasUserinfo = Boolean(parsed.username || parsed.password);
  if (!hasUserinfo && !parsed.href.includes('?') && !parsed.href.includes('#')) {
    return { url, credentials: null };
  }
  const credentials = hasUserinfo ? { username: decodeUserinfo(parsed.username), password: decodeUserinfo(parsed.password) } : null;
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  let clean = parsed.href;
  if (parsed.pathname === '/' && !url.split(/[?#]/, 1)[0]?.endsWith('/')) {
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

/** Host permission match patterns omit ports. */
export function serverPermissionPattern(url: string): string | null {
  if (!isHttpUrl(url)) return null;
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

/**
 * Held while approvals are first recorded and while an import replaces the servers (utils/backup.ts),
 * so neither sees the other half done. Don't call getConfig while holding it.
 */
export function withAuthOriginsLock<T>(task: () => Promise<T>): Promise<T> {
  return navigator.locks.request('ntfy-auth-origins', task);
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

/** A message as ntfy delivers it (JSON stream or poll) */
export interface NtfyMessage {
  id: string;
  time: number;
  event: string;
  topic: string;
  /** ntfy uses this to identify a notification across updates and deletion events. */
  sequence_id?: string;
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

/** Longest message JSON accepted from the server (a line of the stream or of a poll), in characters */
export const MAX_MESSAGE_JSON = 32 * 1024;
/** Longest poll response read, in bytes */
const MAX_POLL_BYTES = 64 * 1024 * 1024;
const MAX_POLL_BUFFER = 4 * 1024 * 1024;
export const MAX_POLL_EVENTS = 1000;
/** ntfy's limits: topic names and message ids of up to 64 characters, at most 3 actions */
const MAX_ID_LENGTH = 64;
const MAX_ACTIONS = 3;
const MAX_TAGS = 20;

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined);
const optionalNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
export const isNtfyPathPart = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_ID_LENGTH && !/[^-A-Za-z0-9_]/.test(value);

/** Default sequences use the message ID. */
export const sequenceOf = (message: NtfyMessage): string => message.sequence_id ?? message.id;

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
  const sequenceId = optionalString(value.sequence_id);
  const validSequenceId = sequenceId && isNtfyPathPart(sequenceId) ? sequenceId : undefined;
  if (value.event === 'message_delete' && !validSequenceId) return null;
  return withoutUndefined<NtfyMessage>({
    id: value.id,
    time,
    event: value.event,
    topic: value.topic,
    sequence_id: validSequenceId,
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

/** A message from one line of JSON (stream or poll); null if it's too long or not a message */
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

/** Read NDJSON one line at a time. Drop oversized lines and cancel at the optional scan limit. */
export async function readLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void> | void,
  { onData, maxBytes = Infinity }: { onData?: () => void; maxBytes?: number } = {},
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let skipping = false;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (!skipping && buffer) await onLine(buffer + decoder.decode());
        return true;
      }
      onData?.();
      const remaining = maxBytes - bytes;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytes += chunk.byteLength;
      buffer += decoder.decode(chunk, { stream: true });

      let start = 0;
      let end: number;
      while ((end = buffer.indexOf('\n', start)) !== -1) {
        if (!skipping && end - start <= MAX_MESSAGE_JSON) await onLine(buffer.slice(start, end));
        skipping = false;
        start = end + 1;
      }
      buffer = buffer.slice(start);
      if (buffer.length > MAX_MESSAGE_JSON) {
        buffer = '';
        skipping = true;
      }
      if (chunk !== value) {
        await reader.cancel();
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface PublishOptions {
  message?: string;
  title?: string;
  priority?: number;
  tags?: string;
  /** http(s) URL opened when the notification is clicked (X-Click) */
  click?: string;
  /** The message is Markdown (X-Markdown) */
  markdown?: boolean;
  /**
   * Deliver later (X-Delay): a duration ("30m", "2 hours", "1 day"), a unix time, an RFC 3339 time
   * or English such as "tomorrow 9am". The server decides what it accepts (10 s to 3 days by default).
   */
  delay?: string;
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
        .filter(isNtfyPathPart)
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
 * in storage.local, so browser sync doesn't copy them. A synced URL is used without userinfo, query
 * string or fragment (cleaned in storage.sync too); credentials found in it are discarded, never used.
 *
 * The token and password are used only with the server origins approved on this device (in its
 * settings): a server URL changed through browser sync gets no credentials until the user confirms
 * (heldBackFrom). Until this device records approvals (the first token or password saved without
 * changing the URLs), the servers configured then are approved.
 */
export async function getConfig(): Promise<NtfyConfig> {
  const [synced, local] = await Promise.all([
    browser.storage.sync.get(['apiUrl', 'fallbackUrl', 'topics', 'includeUrl']),
    browser.storage.local.get(['accessToken', CREDENTIALS_KEY, AUTH_ORIGINS_KEY]),
  ]);
  const main = splitCredentials(isHttpUrl(synced.apiUrl) ? synced.apiUrl : '');
  const fallback = splitCredentials(isHttpUrl(synced.fallbackUrl) ? synced.fallbackUrl : '');
  const stored = local[CREDENTIALS_KEY];
  const credentials = isCredentials(stored) ? stored : null;

  // Remove incomplete URL edits, and userinfo, query strings and fragments from URLs synced from elsewhere.
  const cleanedUrls = {
    ...(synced.apiUrl !== undefined && synced.apiUrl !== main.url && { apiUrl: main.url }),
    ...(synced.fallbackUrl !== undefined && synced.fallbackUrl !== fallback.url && { fallbackUrl: fallback.url }),
  };
  if (Object.keys(cleanedUrls).length > 0) await browser.storage.sync.set(cleanedUrls);

  const accessToken = typeof local.accessToken === 'string' ? local.accessToken : '';
  const origins = serverOrigins(main.url, fallback.url);
  let heldBackFrom: string[] = [];
  if (accessToken || credentials) {
    const approved: unknown = local[AUTH_ORIGINS_KEY];
    if (Array.isArray(approved)) {
      heldBackFrom = origins.filter((origin) => !approved.includes(origin));
    } else if (origins.length > 0) {
      // Not with no server yet: the URL arriving later would then be held back.
      // Checked again under the lock an import holds: this read may have seen an import's servers
      // without the approvals it recorded first, and must not approve those servers.
      heldBackFrom = await withAuthOriginsLock(async () => {
        const [urls, recorded] = await Promise.all([
          browser.storage.sync.get(['apiUrl', 'fallbackUrl']),
          browser.storage.local.get([AUTH_ORIGINS_KEY]),
        ]);
        const now: unknown = recorded[AUTH_ORIGINS_KEY];
        if (Array.isArray(now)) return origins.filter((origin) => !now.includes(origin));
        const current = serverOrigins(...[urls.apiUrl, urls.fallbackUrl].map((url) => splitCredentials(isHttpUrl(url) ? url : '').url));
        // The servers changed meanwhile: nothing is approved by this read, the next one decides
        if (current.length !== origins.length || !current.every((origin) => origins.includes(origin))) return origins;
        await setAuthOrigins(origins);
        return [];
      });
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
 * Authorization header value: Bearer with the access token, else Basic with the username and password;
 * '' without authentication. Userinfo in the URL is never used.
 */
export function buildAuthHeaderValue(server: NtfyServer): string {
  if (server.accessToken) {
    return `Bearer ${server.accessToken}`;
  }
  const credentials = server.credentials;
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
  if (!isNtfyPathPart(topic)) throw new Error('Invalid ntfy topic');
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

/** Longest delay value sent; ntfy's own formats are far shorter */
export const MAX_DELAY_LENGTH = 100;

/** Why a click URL can't be sent ('' if it can): http(s) only, and without a username or password */
export function clickUrlError(value: string): string {
  if (!isHttpUrl(value)) return 'Enter a complete http:// or https:// click URL, or leave it empty';
  const { username, password } = new URL(value);
  // Every subscriber of the topic receives the URL
  return username || password ? 'Remove the username and password from the click URL' : '';
}

/** Why a delay can't be sent ('' if it can). The server checks the format and its own limits. */
export function delayError(value: string): string {
  return value.length > MAX_DELAY_LENGTH ? `Use at most ${MAX_DELAY_LENGTH} characters for the delay` : '';
}

/** ntfy durations ("30m", "2 hours", Go's "1h30m") and unix times: the same moment in every time zone */
const ZONELESS_DELAY = /^(\d+|\d+\s*(d|days?|h|hours?|m|mins?|minutes?|s|secs?|seconds?)|(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+)$/i;

/** The browser's IANA time zone; '' if it isn't known */
function localTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^[\w+\-/]{1,64}$/.test(zone) ? zone : '';
  } catch {
    return '';
  }
}

function setPublishHeaders(headers: Headers, { title, priority, tags, click, markdown, delay }: PublishOptions): void {
  if (title) {
    headers.set('X-Title', encodeHeaderValue(title));
  }
  if (priority && priority !== 3) {
    headers.set('X-Priority', priority.toString());
  }
  if (tags) {
    headers.set('X-Tags', encodeHeaderValue(tags));
  }
  const clickUrl = click?.trim();
  if (clickUrl) {
    const error = clickUrlError(clickUrl);
    if (error) throw new Error(error);
    // As the URL parser writes it: ASCII only, without line breaks
    headers.set('X-Click', encodeHeaderValue(new URL(clickUrl).href));
  }
  if (markdown) {
    headers.set('X-Markdown', 'yes');
  }
  const delayValue = delay?.trim();
  if (delayValue) {
    const error = delayError(delayValue);
    if (error) throw new Error(error);
    headers.set('X-Delay', encodeHeaderValue(delayValue));
    // "tomorrow 9am" means the user's 9am, not the server's (servers before X-Timezone ignore it)
    const zone = ZONELESS_DELAY.test(delayValue) ? '' : localTimeZone();
    if (zone) headers.set('X-Timezone', zone);
  }
}

/** Time limits, so a server that accepts a request but never answers can't stall a sync or a send */
const TIMEOUTS = { check: 10_000, poll: 20_000, publish: 30_000, upload: 120_000, image: 30_000 };

/** The server gave no response: a network error (fetch rejects with a TypeError) or a time limit */
export function isNoResponse(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError'));
}

/** Most of an error response read for ntfy's JSON error, and the longest error text shown */
const MAX_ERROR_BODY = 4096;
const MAX_ERROR_TEXT = 200;

/** The `error` text of ntfy's JSON error body ({"code":42901,"http":429,"error":"..."}); '' if there's none */
async function readErrorText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes <= MAX_ERROR_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      bytes += value.byteLength;
    }
    if (bytes > MAX_ERROR_BODY) {
      await reader.cancel().catch(() => {});
      return '';
    }
    const json: unknown = JSON.parse(new TextDecoder().decode(await new Blob(parts as BlobPart[]).arrayBuffer()));
    const error = isObject(json) ? json.error : undefined;
    if (typeof error !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    const text = error.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…` : text;
  } catch {
    return '';
  } finally {
    reader.releaseLock();
  }
}

/**
 * "HTTP <status>: <ntfy's error text>", else the status text (empty over HTTP/2), else "HTTP <status>".
 * The prefix stays: the receiver reads the status from it and shows only that.
 */
export async function httpError(response: Response): Promise<Error> {
  const detail = (await readErrorText(response)) || response.statusText.trim();
  return new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
}

export class PublishUncertainError extends Error {
  constructor() {
    super('Delivery is uncertain. Check the Inbox before retrying.');
  }
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
  }).catch((error: unknown) => {
    if (isNoResponse(error)) throw new PublishUncertainError();
    throw error;
  });
  if (!response.ok) {
    throw await httpError(response);
  }
  return response;
}

/**
 * The time (unix seconds) of the message a publish created, from the server's answer: for a delayed
 * message, when it will be delivered. undefined if the answer can't be read.
 */
export async function publishedTime(response: Response): Promise<number | undefined> {
  try {
    if (!response.body) return undefined;
    let time: number | undefined;
    await readLines(
      response.body,
      (line) => {
        time ??= parseMessageJson(line)?.time;
      },
      { maxBytes: MAX_MESSAGE_JSON },
    );
    return time;
  } catch {
    return undefined;
  }
}

export function sendNotification(server: NtfyServer, topic: string, options: PublishOptions): Promise<Response> {
  const headers = buildAuthHeaders(server);
  setPublishHeaders(headers, options);
  return post(buildTopicUrl(server.apiUrl, topic), headers, options.message || '', TIMEOUTS.publish);
}

/** Request a sequence deletion. Only the server can determine whether the caller has write access. */
export async function deleteNotification(server: NtfyServer, topic: string, sequence: string, signal: AbortSignal): Promise<Response> {
  if (!isNtfyPathPart(topic) || !isNtfyPathPart(sequence)) throw new Error('Invalid ntfy topic or sequence ID');
  return fetch(`${buildTopicUrl(server.apiUrl, topic)}/${sequence}`, {
    method: 'DELETE',
    headers: buildAuthHeaders(server),
    redirect: 'error',
    signal,
  });
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

  const body = imageResponse.body;
  const type = imageResponse.headers.get('Content-Type') ?? '';
  const tooLarge = () => new Error('Images must be 20 MiB or smaller.');
  if (Number(imageResponse.headers.get('Content-Length')) > MAX_ATTACHMENT_BYTES) {
    await body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const parts: Uint8Array<ArrayBuffer>[] = [];
  if (body) {
    const reader = body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ATTACHMENT_BYTES) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  let filename: string;
  try {
    const lastPart = new URL(imageUrl).pathname.split('/').pop();
    // Without an extension in the URL, take it from the MIME type
    filename = lastPart && lastPart.includes('.') ? lastPart : `image.${type.split(';')[0]?.split('/')[1] || 'png'}`;
  } catch {
    filename = 'image.png';
  }

  return sendAttachment(server, topic, { data: new Blob(parts, { type }), filename, message, title });
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

/**
 * Subscribe to topics: ntfy's JSON stream (GET /<topics>/json) sends each new message as a line, and
 * a keepalive event every 45 s by default. Unlike a WebSocket, it carries the credentials in the
 * Authorization header, never in the URL.
 */
export function openMessageStream(server: NtfyServer, topics: string[], signal: AbortSignal): Promise<Response> {
  if (topics.length === 0 || !topics.every(isNtfyPathPart)) throw new Error('Invalid ntfy topics');
  const headers = buildAuthHeaders(server);
  return fetch(`${new URL(server.apiUrl).origin}/${topics.join(',')}/json`, {
    method: 'GET',
    headers,
    redirect: redirectPolicy(headers),
    cache: 'no-store',
    signal,
  });
}

/** Cached messages of a topic: since is a message id, a unix time, a duration such as '24h', or 'all' */
export async function getNotifications(
  server: NtfyServer,
  topic: string,
  since: string | number = 'all',
  {
    includeDeletions = false,
    signal = AbortSignal.timeout(TIMEOUTS.poll),
    savedMessages = [],
  }: { includeDeletions?: boolean; signal?: AbortSignal; savedMessages?: NtfyMessage[] } = {},
) {
  if (!server.apiUrl) {
    throw new Error('API URL is not configured');
  }

  const headers = buildAuthHeaders(server);
  const url = `${buildTopicUrl(server.apiUrl, topic)}/json?poll=1&since=${since}`;
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: redirectPolicy(headers),
    signal,
  });
  if (!response.ok) {
    throw await httpError(response);
  }

  const retained = new Map<NtfyMessage, { length: number; order: number }>();
  const saved = new Map(savedMessages.map((message) => [message.id, message]));
  const sequences = new Set(savedMessages.map(sequenceOf));
  // A bounded tail is enough for new publishes. Keep older deletions of saved sequences, and the
  // publishes of saved rows (on every topic), in the same order as the tail: within one second, the
  // saved row's position decides whether a deletion applies to it and whether a publish of its
  // sequence is an update of it.
  const protectedEvents = new Map<string, { event: NtfyMessage; order: number }>();
  let order = 0;
  let buffered = 0;
  const truncation = response.headers.get('X-Messages-Truncated');
  const serverTruncated = truncation === '1';
  // A CORS-filtered response can hide a truncation header. An explicit 0 also certifies completeness.
  const truncationKnown = response.type !== 'cors' || truncation === '0' || serverTruncated;
  let truncated = serverTruncated;
  const date = response.headers.get('Date');
  const serverTime = date ? Date.parse(date) : NaN;
  const complete =
    !response.body ||
    (await readLines(
      response.body,
      (line) => {
        const message = parseMessageJson(line);
        if (
          !message ||
          message.topic !== topic ||
          (message.event !== 'message' && !(includeDeletions && message.event === 'message_delete'))
        )
          return;

        const position = order++;
        if (saved.size > 0) {
          const existing = saved.get(message.id);
          const sequence = sequenceOf(message);
          if (message.event === 'message' && existing?.time === message.time && !protectedEvents.has(`publish:${message.id}`)) {
            const { id, topic, time, event, sequence_id } = message;
            protectedEvents.set(`publish:${id}`, { event: { id, topic, time, event, sequence_id }, order: position });
          } else if (message.event === 'message_delete' && sequences.has(sequence)) {
            const { id, topic, time, event, sequence_id } = message;
            protectedEvents.set(`delete:${sequence}`, { event: { id, topic, time, event, sequence_id }, order: position });
          }
        }
        retained.set(message, { length: line.length, order: position });
        buffered += line.length;
        // ntfy sends a topic's replay in time order, with publishes ordered within a second.
        while (retained.size > MAX_POLL_EVENTS || buffered > MAX_POLL_BUFFER) {
          const [oldest, { length }] = retained.entries().next().value!;
          retained.delete(oldest);
          buffered -= length;
          truncated = true;
        }
      },
      { maxBytes: MAX_POLL_BYTES },
    ));
  if (!complete && retained.size === 0) throw new Error('Response too large');
  const byPosition = new Map([...protectedEvents.values()].map(({ event, order }) => [order, event]));
  for (const [event, position] of retained) byPosition.set(position.order, event);
  const full = new Set([...retained.keys()].map(({ id }) => id));
  return {
    events: [...byPosition].sort(([a], [b]) => a - b).map(([, event]) => event),
    /** Publishes of saved rows outside the retained tail: their position only, without content */
    positionOnly: [...protectedEvents.values()]
      .filter(({ event }) => event.event === 'message' && !full.has(event.id))
      .map(({ event }) => event.id),
    serverOrigin: new URL(response.url || url).origin,
    truncated: truncated || !complete,
    scanLimited: !complete,
    serverTruncated,
    truncationKnown,
    serverTime: Number.isFinite(serverTime) ? serverTime : undefined,
  };
}
