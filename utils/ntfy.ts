// ntfy server API: configuration, authentication, publishing and polling.
// Used by the background script and the popup.

import { browser } from 'wxt/browser';

export interface NtfyConfig {
  apiUrl: string;
  /** Another URL of the same server, used when apiUrl doesn't answer ('' for none) */
  fallbackUrl: string;
  accessToken: string;
  topics: string[];
  includeUrl: boolean;
}

/** The server and credentials a request needs */
export type NtfyServer = Pick<NtfyConfig, 'apiUrl' | 'accessToken'>;

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

/** Server URL and topics come from storage.sync; the access token stays in storage.local, so browser sync doesn't copy it */
export async function getConfig(): Promise<NtfyConfig> {
  const [synced, local] = await Promise.all([
    browser.storage.sync.get(['apiUrl', 'fallbackUrl', 'topics', 'includeUrl']),
    browser.storage.local.get(['accessToken']),
  ]);
  return {
    apiUrl: typeof synced.apiUrl === 'string' ? synced.apiUrl : '',
    fallbackUrl: typeof synced.fallbackUrl === 'string' ? synced.fallbackUrl : '',
    accessToken: typeof local.accessToken === 'string' ? local.accessToken : '',
    topics: parseTopics(synced.topics),
    includeUrl: synced.includeUrl === true,
  };
}

export async function setAccessToken(accessToken: string): Promise<void> {
  await browser.storage.local.set({ accessToken: accessToken || '' });
}

export function base64Encode(value: string): string {
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

/** Authorization header value: Bearer token, or Basic from credentials in the server URL; '' without authentication */
export function buildAuthHeaderValue(accessToken: string, apiUrl: string): string {
  if (accessToken) {
    return `Bearer ${accessToken}`;
  }
  if (apiUrl) {
    try {
      const url = new URL(apiUrl);
      if (url.username || url.password) {
        const username = decodeURIComponent(url.username);
        const password = decodeURIComponent(url.password);
        return `Basic ${base64Encode(`${username}:${password}`)}`;
      }
    } catch {
      // Invalid URL: no authentication
    }
  }
  return '';
}

export function buildAuthHeaders(accessToken: string, apiUrl: string): Headers {
  const headers = new Headers();
  const auth = buildAuthHeaderValue(accessToken, apiUrl);
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

/** Header value, RFC 2047-encoded if it contains non-ASCII characters */
export function encodeHeaderValue(value: string | undefined): string {
  if (!value) return '';
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(value)) {
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

async function post(url: string, headers: Headers, body: BodyInit): Promise<Response> {
  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response;
}

export function sendNotification(server: NtfyServer, topic: string, options: PublishOptions): Promise<Response> {
  const headers = buildAuthHeaders(server.accessToken, server.apiUrl);
  setPublishHeaders(headers, options);
  return post(buildTopicUrl(server.apiUrl, topic), headers, options.message || '');
}

export function sendAttachment(server: NtfyServer, topic: string, options: AttachmentOptions): Promise<Response> {
  const headers = buildAuthHeaders(server.accessToken, server.apiUrl);
  headers.set('X-Filename', encodeHeaderValue(options.filename));
  if (options.contentType) {
    headers.set('Content-Type', options.contentType);
  }
  if (options.message) {
    headers.set('X-Message', encodeHeaderValue(options.message));
  }
  setPublishHeaders(headers, options);
  return post(buildTopicUrl(server.apiUrl, topic), headers, options.data);
}

/** Fetch an image and send it as attachment */
export async function sendImageFromUrl(
  server: NtfyServer,
  topic: string,
  imageUrl: string,
  message?: string,
  title?: string,
): Promise<Response> {
  const imageResponse = await fetch(imageUrl);
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
      headers: buildAuthHeaders(server.accessToken, server.apiUrl),
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
    headers: buildAuthHeaders(server.accessToken, server.apiUrl),
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
