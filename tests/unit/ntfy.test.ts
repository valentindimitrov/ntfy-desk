import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { installFakeNtfy } from './helpers/fake-ntfy';
import {
  CREDENTIALS_KEY,
  buildAuthHeaderValue,
  buildTopicUrl,
  canReadTopic,
  clickUrlError,
  delayError,
  encodeHeaderValue,
  getConfig,
  getNotifications,
  isHttpUrl,
  openMessageStream,
  parseTopics,
  publishedTime,
  sendAttachment,
  sendNotification,
  setAccessToken,
  setCredentials,
  splitCredentials,
} from '@/utils/ntfy';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('credentials in server URLs', () => {
  it('splits userinfo and discards queries and fragments while preserving the server path', () => {
    expect(splitCredentials('https://us%C3%A9r:p%40ss@ntfy.example:8443/path?auth=synthetic#fragment')).toEqual({
      url: 'https://ntfy.example:8443/path',
      credentials: { username: 'usér', password: 'p@ss' },
    });
    expect(splitCredentials('https://u:p@ss@ntfy.example')).toEqual({
      url: 'https://ntfy.example',
      credentials: { username: 'u', password: 'p@ss' },
    });
    expect(splitCredentials('https://ntfy.example')).toEqual({ url: 'https://ntfy.example', credentials: null });
    expect(splitCredentials('not a url')).toEqual({ url: 'not a url', credentials: null });
  });

  it('strips userinfo from synced URLs without adopting it as credentials', async () => {
    await fakeBrowser.storage.sync.set({
      apiUrl: 'https://alice:secret@ntfy.lan',
      fallbackUrl: 'https://alice:secret@ntfy.example.com',
      topics: 'a',
    });
    const config = await getConfig();
    expect(config).toMatchObject({
      apiUrl: 'https://ntfy.lan',
      fallbackUrl: 'https://ntfy.example.com',
      credentials: null,
    });
    expect(await fakeBrowser.storage.sync.get(['apiUrl', 'fallbackUrl'])).toEqual({
      apiUrl: 'https://ntfy.lan',
      fallbackUrl: 'https://ntfy.example.com',
    });
    expect(await fakeBrowser.storage.local.get(CREDENTIALS_KEY)).toEqual({});
    expect(JSON.stringify(await fakeBrowser.storage.sync.get(null))).not.toContain('secret');
    expect(JSON.stringify(await fakeBrowser.storage.local.get(null))).not.toContain('secret');
  });

  it('keeps using the credentials stored locally when a synced URL carries others', async () => {
    await setCredentials({ username: 'local', password: 'kept' });
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://old:stale@ntfy.lan' });
    expect((await getConfig()).credentials).toEqual({ username: 'local', password: 'kept' });
  });

  it('strips queries and fragments from synced URLs even without userinfo', async () => {
    await fakeBrowser.storage.sync.set({
      apiUrl: 'https://ntfy.example?auth=synthetic',
      fallbackUrl: 'https://fallback.example/app?x=1#synthetic',
    });
    const expected = { apiUrl: 'https://ntfy.example', fallbackUrl: 'https://fallback.example/app' };
    expect(await getConfig()).toMatchObject(expected);
    expect(await fakeBrowser.storage.sync.get(null)).toEqual(expected);
  });

  it('removes the credentials when both fields are empty', async () => {
    await setCredentials({ username: 'a', password: 'b' });
    await setCredentials({ username: '', password: '' });
    expect(await fakeBrowser.storage.local.get(CREDENTIALS_KEY)).toEqual({});
  });
});

describe('configuration', () => {
  it('reads the server and topics from sync, and the token from local storage only', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics: ' a, b ,,c', includeUrl: true, accessToken: 'tk_synced' });
    await setAccessToken('tk_local');
    expect(await getConfig()).toEqual({
      apiUrl: 'https://ntfy.example',
      fallbackUrl: '',
      accessToken: 'tk_local',
      credentials: null,
      heldBackFrom: [],
      topics: ['a', 'b', 'c'],
      includeUrl: true,
    });
    expect(await fakeBrowser.storage.sync.get('accessToken')).toEqual({ accessToken: 'tk_synced' }); // never read from or written to sync
  });

  it('defaults to nothing configured', async () => {
    expect(await getConfig()).toEqual({
      apiUrl: '',
      fallbackUrl: '',
      accessToken: '',
      credentials: null,
      heldBackFrom: [],
      topics: [],
      includeUrl: false,
    });
    expect(parseTopics(undefined)).toEqual([]);
  });

  it('loads only valid topic names from synced settings', async () => {
    await fakeBrowser.storage.sync.set({ topics: `alerts, alerts/publish?message=synthetic#, ../admin, __proto__, ${'a'.repeat(65)}` });
    expect((await getConfig()).topics).toEqual(['alerts', '__proto__']);
  });
});

describe('authentication', () => {
  it('uses the token, else the username and password, else credentials still in the URL', () => {
    const basic = (pair: string) => `Basic ${Buffer.from(pair).toString('base64')}`;
    const credentials = { username: 'usér', password: 'p@ss' };
    expect(buildAuthHeaderValue({ apiUrl: 'https://ntfy.example', accessToken: 'tk_x', credentials })).toBe('Bearer tk_x');
    expect(buildAuthHeaderValue({ apiUrl: 'https://ntfy.example', accessToken: '', credentials })).toBe(basic('usér:p@ss'));
    // Userinfo left in a URL is never used
    expect(buildAuthHeaderValue({ apiUrl: 'https://us%C3%A9r:p%40ss@ntfy.example', accessToken: '' })).toBe('');
    expect(buildAuthHeaderValue({ apiUrl: 'https://ntfy.example', accessToken: '', credentials: null })).toBe('');
    expect(buildAuthHeaderValue({ apiUrl: 'not a url', accessToken: '' })).toBe('');
  });
});

describe('helpers', () => {
  it('builds topic URLs on the origin only', () => {
    expect(buildTopicUrl('https://u:p@ntfy.example:8443/some/path/', 'alerts')).toBe('https://ntfy.example:8443/alerts');
  });

  it('encodes non-ASCII header values as RFC 2047', () => {
    expect(encodeHeaderValue('plain')).toBe('plain');
    expect(encodeHeaderValue('Grüße')).toBe(`=?utf-8?B?${Buffer.from('Grüße').toString('base64')}?=`);
    expect(encodeHeaderValue(undefined)).toBe('');
  });

  it('only accepts http(s) URLs from messages', () => {
    expect(isHttpUrl('https://ntfy.example/file/x.png')).toBe(true);
    expect(isHttpUrl('http://lan/x')).toBe(true);
    for (const url of ['javascript:alert(1)', 'chrome://settings', 'file:///C:/x', 'data:text/html,x', '', undefined, 'not a url', 42]) {
      expect(isHttpUrl(url)).toBe(false);
    }
  });
});

describe('requests', () => {
  function stubFetch(body = '', status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(body, { status, statusText: status === 200 ? 'OK' : 'Forbidden' });
      }),
    );
    return calls;
  }
  const server = { apiUrl: 'https://ntfy.example', accessToken: 'tk_x' };

  it('publishes a message with headers for title, priority and tags', async () => {
    const calls = stubFetch();
    await sendNotification(server, 'inbox', { message: 'hello', title: 'Hi ü', priority: 5, tags: 'a,b' });
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe('https://ntfy.example/inbox');
    expect(calls[0]!.init.body).toBe('hello');
    expect(headers.get('Authorization')).toBe('Bearer tk_x');
    expect(headers.get('X-Title')).toMatch(/^=\?utf-8\?B\?/);
    expect(headers.get('X-Priority')).toBe('5');
    expect(headers.get('X-Tags')).toBe('a,b');
  });

  it("doesn't send the default priority", async () => {
    const calls = stubFetch();
    await sendNotification(server, 'inbox', { message: 'x', priority: 3 });
    expect(new Headers(calls[0]!.init.headers).has('X-Priority')).toBe(false);
  });

  it('sends an attachment with its filename, message and content type', async () => {
    const calls = stubFetch();
    await sendAttachment(server, 'inbox', {
      data: new Uint8Array([1, 2]),
      filename: 'ä.zip',
      contentType: 'application/zip',
      message: 'm',
    });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('X-Filename')).toMatch(/^=\?utf-8\?B\?/);
    expect(headers.get('Content-Type')).toBe('application/zip');
    expect(headers.get('X-Message')).toBe('m');
  });

  it('sends no click, Markdown or delay header unless asked', async () => {
    const calls = stubFetch();
    await sendNotification(server, 'inbox', { message: 'x', click: '', markdown: false, delay: '' });
    await sendAttachment(server, 'inbox', { data: new Uint8Array([1]), filename: 'a.txt', click: ' ', delay: ' ' });
    for (const { init } of calls) {
      const headers = new Headers(init.headers);
      for (const name of ['X-Click', 'X-Markdown', 'X-Delay', 'X-Timezone']) expect(headers.has(name)).toBe(false);
    }
  });

  it('publishes the click URL, Markdown and delay as headers, never in the URL', async () => {
    const calls = stubFetch();
    await sendNotification(server, 'inbox', {
      message: '**hello**',
      click: ' https://example.com/päge?q=a b ',
      markdown: true,
      delay: ' 30m ',
    });
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe('https://ntfy.example/inbox');
    expect(calls[0]!.init.body).toBe('**hello**');
    // As the URL parser writes it: ASCII, so it needs no RFC 2047 encoding
    expect(headers.get('X-Click')).toBe('https://example.com/p%C3%A4ge?q=a%20b');
    expect(headers.get('X-Markdown')).toBe('yes');
    expect(headers.get('X-Delay')).toBe('30m');
    expect(headers.has('X-Timezone')).toBe(false);
  });

  it('sends the same options with an attachment', async () => {
    const calls = stubFetch();
    await sendAttachment(server, 'inbox', {
      data: new Uint8Array([1, 2]),
      filename: 'a.txt',
      message: 'm',
      click: 'https://example.com/',
      markdown: true,
      delay: '1h',
    });
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe('https://ntfy.example/inbox');
    expect(headers.get('X-Filename')).toBe('a.txt');
    expect(headers.get('X-Click')).toBe('https://example.com/');
    expect(headers.get('X-Markdown')).toBe('yes');
    expect(headers.get('X-Delay')).toBe('1h');
  });

  it("names the browser's time zone for a delivery time, not for a duration or a unix time", async () => {
    const calls = stubFetch();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const delay of ['30m', '2 days', '45 Minutes', '1h30m', '1767225600', 'tomorrow 9am', '2026-12-01T09:00:00']) {
      await sendNotification(server, 'inbox', { message: 'x', delay });
    }
    const zones = calls.map(({ init }) => new Headers(init.headers).get('X-Timezone'));
    expect(zones).toEqual([null, null, null, null, null, zone, zone]);
  });

  it('RFC 2047-encodes a delay with characters outside printable ASCII', async () => {
    const calls = stubFetch();
    await sendNotification(server, 'inbox', { message: 'x', delay: 'demain 9h\nX-Injected: 1 é' });
    const delay = new Headers(calls[0]!.init.headers).get('X-Delay')!;
    expect(delay).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(new Headers(calls[0]!.init.headers).has('X-Injected')).toBe(false);
  });

  it('refuses a click URL that is not http(s) or carries credentials, and an overlong delay, before any request', () => {
    const calls = stubFetch();
    for (const click of ['javascript:alert(1)', 'example.com', 'mailto:a@example.com', 'ftp://example.com/x']) {
      expect(clickUrlError(click)).toMatch(/http:\/\/ or https:\/\//);
      expect(() => sendNotification(server, 'inbox', { message: 'x', click })).toThrow(/click URL/);
    }
    expect(clickUrlError('https://user:secret@example.com/')).toMatch(/username and password/);
    expect(() => sendNotification(server, 'inbox', { message: 'x', click: 'https://user:secret@example.com/' })).toThrow(/click URL/);
    expect(clickUrlError('https://example.com/a?b=c#d')).toBe('');
    expect(delayError('x'.repeat(100))).toBe('');
    expect(delayError('x'.repeat(101))).toMatch(/at most 100 characters/);
    expect(() => sendNotification(server, 'inbox', { message: 'x', delay: 'x'.repeat(101) })).toThrow(/at most 100/);
    expect(calls).toEqual([]);
  });

  it('reports HTTP errors', async () => {
    stubFetch('', 403);
    await expect(sendNotification(server, 'inbox', { message: 'x' })).rejects.toThrow('HTTP 403: Forbidden');
  });

  it('blocks malformed topics at the request boundary', async () => {
    const calls = stubFetch();
    const topic = 'alerts/publish?message=synthetic#';
    expect(await canReadTopic(server, topic)).toBeNull();
    await expect(getNotifications(server, topic)).rejects.toThrow('Invalid ntfy topic');
    expect(() => sendNotification(server, topic, {})).toThrow('Invalid ntfy topic');
    expect(() => openMessageStream(server, ['alerts', topic], new AbortController().signal)).toThrow('Invalid ntfy topics');
    expect(calls).toEqual([]);
  });

  it('parses the poll response and keeps message events only', async () => {
    const lines = [
      { id: 'o', event: 'open', topic: 'a', time: 1 },
      { id: 'm1', event: 'message', topic: 'a', time: 2 },
      { id: 'k', event: 'keepalive', topic: 'a', time: 3 },
    ].map((line) => JSON.stringify(line));
    const calls = stubFetch([...lines, 'not json', ''].join('\n'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events: messages } = await getNotifications(server, 'a', 10);
    expect(calls[0]!.url).toBe('https://ntfy.example/a/json?poll=1&since=10');
    expect(messages.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('HTTP error messages', () => {
  const server = { apiUrl: 'https://ntfy.example', accessToken: '' };
  const respond = (response: () => Response) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    );
  const publishError = async () => {
    try {
      await sendNotification(server, 'inbox', { message: 'x' });
    } catch (error) {
      return (error as Error).message;
    }
    return 'sent';
  };

  it("shows ntfy's error text when the status text is empty (HTTP/2)", async () => {
    respond(() => Response.json({ code: 42901, http: 429, error: 'limit reached: too many requests' }, { status: 429 }));
    expect(await publishError()).toBe('HTTP 429: limit reached: too many requests');
    await expect(getNotifications(server, 'inbox')).rejects.toThrow('HTTP 429: limit reached: too many requests');
  });

  it('falls back to the status text, then to the status alone', async () => {
    respond(() => new Response('<html>busy</html>', { status: 503, statusText: 'Service Unavailable' }));
    expect(await publishError()).toBe('HTTP 503: Service Unavailable');
    respond(() => new Response('', { status: 429 }));
    expect(await publishError()).toBe('HTTP 429');
    respond(() => Response.json({ error: { nested: 'object' } }, { status: 400 }));
    expect(await publishError()).toBe('HTTP 400');
  });

  it('caps the body it reads and the text it shows, as plain text', async () => {
    respond(() => Response.json({ error: 'x'.repeat(8000) }, { status: 400 }));
    expect(await publishError()).toBe('HTTP 400');
    respond(() => Response.json({ error: `line\n<b>bold</b>${'y'.repeat(400)}` }, { status: 400 }));
    const message = await publishError();
    expect(message.startsWith('HTTP 400: line <b>bold</b>yyy')).toBe(true);
    expect(message.length).toBeLessThanOrEqual('HTTP 400: '.length + 200);
  });
});

describe('publish options against the fake ntfy server', () => {
  const server = { apiUrl: 'https://ntfy.example', accessToken: 'tk_x' };

  it('schedules a delayed message: the answer carries its delivery time, and it is not in the cache yet', async () => {
    const fake = installFakeNtfy();
    const response = await sendNotification(server, 'inbox', {
      message: 'later',
      click: 'https://example.com/a',
      markdown: true,
      delay: '30m',
    });
    expect(await publishedTime(response)).toBe(fake.now + 30 * 60);
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]!.headers.get('X-Delay')).toBe('30m');
    expect(fake.scheduled).toMatchObject([{ message: 'later', click: 'https://example.com/a', content_type: 'text/markdown' }]);
    expect((await getNotifications(server, 'inbox')).events).toEqual([]);
  });

  it('delivers at once without a delay', async () => {
    const fake = installFakeNtfy();
    const response = await sendNotification(server, 'inbox', { message: 'now' });
    expect(await publishedTime(response)).toBe(fake.now);
    expect((await getNotifications(server, 'inbox')).events).toMatchObject([{ message: 'now' }]);
  });

  it("passes on the server's reason for a delay it refuses", async () => {
    const fake = installFakeNtfy();
    const refused = async (options: Parameters<typeof sendNotification>[2]) =>
      sendNotification(server, 'inbox', { message: 'x', ...options }).then(
        () => 'sent',
        (error: Error) => error.message,
      );
    expect(await refused({ delay: 'whenever' })).toBe('HTTP 400: invalid delay parameter: unable to parse delay');
    expect(await refused({ delay: '5s' })).toBe('HTTP 400: invalid delay parameter: too small, please refer to the docs');
    expect(await refused({ delay: '4d' })).toBe('HTTP 400: invalid delay parameter: too large, please refer to the docs');
    await expect(sendAttachment(server, 'inbox', { data: new Uint8Array([1]), filename: 'a.txt', delay: '1d' })).rejects.toThrow(
      'HTTP 400: invalid request: attachment expiry before delayed delivery date',
    );
    expect(fake.published).toEqual([]);
  });

  it('reads no delivery time from an answer that is not a message', async () => {
    expect(await publishedTime(new Response(''))).toBeUndefined();
    expect(await publishedTime(new Response('<html>'))).toBeUndefined();
    expect(await publishedTime(new Response(null))).toBeUndefined();
    expect(await publishedTime(Response.json({ id: 'm', event: 'message', topic: 'a', time: 'soon' }))).toBeUndefined();
  });
});
