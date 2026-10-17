import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  base64UrlEncode,
  CREDENTIALS_KEY,
  buildAuthHeaderValue,
  buildTopicUrl,
  encodeHeaderValue,
  getConfig,
  getNotifications,
  isHttpUrl,
  parseTopics,
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
  it('splits user:password@ from a URL, keeping the rest as written', () => {
    expect(splitCredentials('https://us%C3%A9r:p%40ss@ntfy.example:8443/path?x=1')).toEqual({
      url: 'https://ntfy.example:8443/path?x=1',
      credentials: { username: 'usér', password: 'p@ss' },
    });
    expect(splitCredentials('https://u:p@ss@ntfy.example')).toEqual({
      url: 'https://ntfy.example',
      credentials: { username: 'u', password: 'p@ss' },
    });
    expect(splitCredentials('https://ntfy.example')).toEqual({ url: 'https://ntfy.example', credentials: null });
    expect(splitCredentials('not a url')).toEqual({ url: 'not a url', credentials: null });
  });

  it('moves credentials saved in synced URLs to local storage, and syncs the URLs without them', async () => {
    await fakeBrowser.storage.sync.set({
      apiUrl: 'https://alice:secret@ntfy.lan',
      fallbackUrl: 'https://alice:secret@ntfy.example.com',
      topics: 'a',
    });
    const config = await getConfig();
    expect(config).toMatchObject({
      apiUrl: 'https://ntfy.lan',
      fallbackUrl: 'https://ntfy.example.com',
      credentials: { username: 'alice', password: 'secret' },
    });
    expect(await fakeBrowser.storage.sync.get(['apiUrl', 'fallbackUrl'])).toEqual({
      apiUrl: 'https://ntfy.lan',
      fallbackUrl: 'https://ntfy.example.com',
    });
    expect(await fakeBrowser.storage.local.get(CREDENTIALS_KEY)).toEqual({ [CREDENTIALS_KEY]: { username: 'alice', password: 'secret' } });
    expect(JSON.stringify(await fakeBrowser.storage.sync.get(null))).not.toContain('secret');
  });

  it('keeps credentials already stored locally over ones found in a synced URL', async () => {
    await setCredentials({ username: 'local', password: 'kept' });
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://old:stale@ntfy.lan' });
    expect((await getConfig()).credentials).toEqual({ username: 'local', password: 'kept' });
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
});

describe('authentication', () => {
  it('uses the token, else the username and password, else credentials still in the URL', () => {
    const basic = (pair: string) => `Basic ${Buffer.from(pair).toString('base64')}`;
    const credentials = { username: 'usér', password: 'p@ss' };
    expect(buildAuthHeaderValue({ apiUrl: 'https://ntfy.example', accessToken: 'tk_x', credentials })).toBe('Bearer tk_x');
    expect(buildAuthHeaderValue({ apiUrl: 'https://ntfy.example', accessToken: '', credentials })).toBe(basic('usér:p@ss'));
    expect(buildAuthHeaderValue({ apiUrl: 'https://us%C3%A9r:p%40ss@ntfy.example', accessToken: '' })).toBe(basic('usér:p@ss'));
    expect(buildAuthHeaderValue({ apiUrl: 'https://ntfy.example', accessToken: '', credentials: null })).toBe('');
    expect(buildAuthHeaderValue({ apiUrl: 'not a url', accessToken: '' })).toBe('');
  });

  it('encodes ?auth= as unpadded base64url, as ntfy (Go RawURLEncoding) decodes it', () => {
    for (const value of ['Bearer tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2', 'Basic dXPDqXI6cEBzcw==', 'a', 'ab', '\u00ff\u00fe~?>']) {
      const encoded = base64UrlEncode(value);
      expect(encoded).not.toMatch(/[=+/]/);
      expect(Buffer.from(encoded, 'base64url').toString()).toBe(value);
    }
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

  it('reports HTTP errors', async () => {
    stubFetch('', 403);
    await expect(sendNotification(server, 'inbox', { message: 'x' })).rejects.toThrow('HTTP 403: Forbidden');
  });

  it('parses the poll response and keeps message events only', async () => {
    const lines = [
      { id: 'o', event: 'open', topic: 'a', time: 1 },
      { id: 'm1', event: 'message', topic: 'a', time: 2 },
      { id: 'k', event: 'keepalive', topic: 'a', time: 3 },
    ].map((line) => JSON.stringify(line));
    const calls = stubFetch([...lines, 'not json', ''].join('\n'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messages = await getNotifications(server, 'a', 10);
    expect(calls[0]!.url).toBe('https://ntfy.example/a/json?poll=1&since=10');
    expect(messages.map((m) => m.id)).toEqual(['m1']);
  });
});
