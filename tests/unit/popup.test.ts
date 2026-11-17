// @vitest-environment happy-dom
// The real popup page (index.html + main.ts) against the fake browser.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { installIndexedDb, queuedNames, queueFiles } from './helpers/indexed-db';
import { callsOf, mockResolved, mockWebLocks } from './helpers/mock';
import { handlePopupRequest } from '@/utils/messages';
import type { StoredMessage } from '@/utils/history';
import type { NtfyMessage } from '@/utils/ntfy';

// Vitest runs from the project root
const html = readFileSync(resolve('entrypoints/popup/index.html'), 'utf8');
const bodyStart = html.indexOf('>', html.indexOf('<body')) + 1;
const body = html.slice(bodyStart, html.indexOf('</body>')).replace(/<script[^>]*><\/script>/g, '');

let requests: { url: string; headers: Headers; body: unknown }[];
let closed: boolean;

const message = (id: string, topic: string, minutesAgo: number, extra: Partial<NtfyMessage> = {}): StoredMessage => ({
  id,
  event: 'message',
  topic,
  serverOrigin: 'https://ntfy.example',
  time: Math.floor(Date.now() / 1000) - minutesAgo * 60,
  title: id,
  message: `body of ${id}`,
  ...extra,
});

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

async function openPopup(search = ''): Promise<void> {
  history.replaceState(null, '', `/popup.html${search}`);
  await import('@/entrypoints/popup/main');
  await flush();
}

async function openSettings(): Promise<void> {
  $('#settings-btn').click();
  await vi.waitFor(() => expect($('#settings-view').classList.contains('active')).toBe(true));
}

beforeEach(async () => {
  vi.resetModules();
  fakeBrowser.reset();
  mockWebLocks();
  installIndexedDb();
  document.body.innerHTML = body;
  document.body.className = '';
  requests = [];
  closed = false;

  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ name: 'ntfy Desk', version: '0', manifest_version: 3 });
  // The background's handling of the popup's requests (read and delete actions)
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation((async (request: unknown) => {
    const deletion = await handlePopupRequest(request, async () => {});
    return { success: true, deletion };
  }) as never);
  mockResolved(fakeBrowser.permissions, 'contains', true);
  mockResolved(fakeBrowser.tabs, 'query', [{ url: 'https://news.example/story/', title: ' The story ' }]);
  vi.spyOn(window, 'close').mockImplementation(() => {
    closed = true;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, headers: new Headers(init.headers), body: init.body });
      return new Response('', { status: 200 });
    }),
  );

  await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics: 'alerts,coolify,inbox', lastTopic: 'inbox' });
  await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
});

describe('Inbox', () => {
  beforeEach(async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [message('a1', 'alerts', 2, { priority: 5 }), message('a2', 'alerts', 120), message('c1', 'coolify', 60)],
      readMessageIds: ['a2'],
    });
  });

  it('lists the messages of all topics, with a topic list and unread counts', async () => {
    await openPopup();
    const sidebar = [...document.querySelectorAll('.topic-filter-btn')].map((button) => button.textContent);
    expect(sidebar).toEqual(['All topics2', 'alerts1', 'coolify1', 'inbox']);
    const titles = [...document.querySelectorAll('.notification-title')].map((title) => title.textContent);
    expect(titles).toEqual(['a1', 'c1', 'a2']); // newest first
    expect($('.notification-time').textContent).toBe('alerts · 2m ago');
  });

  it('filters by topic, remembers it, and deletes within it only', async () => {
    vi.stubGlobal('confirm', () => true);
    await openPopup('?tab=receive');
    document.querySelectorAll<HTMLElement>('.topic-filter-btn')[1]!.click(); // alerts
    await flush();
    expect([...document.querySelectorAll('.notification-title')].map((t) => t.textContent)).toEqual(['a1', 'a2']);
    expect(await fakeBrowser.storage.local.get('receiveTopicFilter')).toEqual({ receiveTopicFilter: { topic: 'alerts' } });

    $('#delete-all-btn').click();
    await flush();
    const { deletedMessageIds } = await fakeBrowser.storage.local.get('deletedMessageIds');
    expect(deletedMessageIds).toEqual(['a1', 'a2']);
  });

  it('distinguishes a topic named all from the All topics filter', async () => {
    await fakeBrowser.storage.sync.set({ topics: 'all,inbox' });
    await fakeBrowser.storage.local.set({ receiveTopicFilter: null });
    await openPopup('?mode=page');
    const destination = $<HTMLSelectElement>('#topic-select');
    expect(destination.disabled).toBe(false);

    document.querySelectorAll<HTMLButtonElement>('.topic-filter-btn')[1]!.click();
    expect(destination.disabled).toBe(true);
    expect(destination.value).toBe('all');
    await flush();
    expect(await fakeBrowser.storage.local.get('receiveTopicFilter')).toEqual({ receiveTopicFilter: { topic: 'all' } });
  });

  it('shows the connection state and marks topics the credentials can only send to', async () => {
    await fakeBrowser.storage.session.set({
      receiverStatus: {
        state: 'reconnecting',
        server: 'ntfy.example',
        unreadableTopics: ['inbox'],
        unreachable: true,
        retryAt: Date.now() + 30000,
        syncErrors: [['alerts', 'HTTP 502']],
        lastSyncAt: null,
      },
    });
    await openPopup('?tab=receive');
    const lines = [...document.querySelectorAll('.status-line')].map((line) => [line.className, line.textContent]);
    expect(lines).toEqual([
      ['status-line error', "Can't reach ntfy.example, retrying in 30 s"],
      ['status-line warning', "Couldn't fetch missed messages: alerts (HTTP 502)"],
    ]);
    const inbox = [...document.querySelectorAll<HTMLElement>('.topic-filter-btn')].find((b) => b.textContent?.startsWith('inbox'))!;
    expect(inbox.classList.contains('send-only')).toBe(true);
    expect(inbox.textContent).toBe('inboxsend only');
  });

  it('preserves focus and the live-region warning on routine sync updates and refocuses the row after history changes', async () => {
    const status = {
      state: 'connected',
      server: 'ntfy.example',
      unreadableTopics: [],
      syncErrors: [['alerts', 'HTTP 502']],
      lastSyncAt: 1,
    };
    await fakeBrowser.storage.session.set({ receiverStatus: status });
    await openPopup();
    const button = $('.notification-item[data-id="a1"] .delete-btn');
    const warning = $('.status-line.warning');
    expect(warning).toBeTruthy();
    button.focus();
    await fakeBrowser.storage.session.set({ receiverStatus: { ...status, lastSyncAt: 2 } });
    await flush();
    expect(document.activeElement).toBe(button);
    expect($('.status-line.warning')).toBe(warning);

    const { receivedNotifications } = await fakeBrowser.storage.local.get('receivedNotifications');
    await fakeBrowser.storage.local.set({
      receivedNotifications: [message('new', 'alerts', 1), ...(receivedNotifications as NtfyMessage[])],
    });
    await vi.waitFor(() => expect($('.notification-item[data-id="new"]')).toBeTruthy());
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).toBe($('.notification-item[data-id="a1"] .delete-btn'));
  });

  it('keeps the Copy Link tooltip after copying an attachment URL', async () => {
    const url = 'https://ntfy.example/file/document.txt';
    await fakeBrowser.storage.local.set({
      receivedNotifications: [message('file', 'alerts', 1, { attachment: { url, name: 'document.txt' } })],
    });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await openPopup();
    const button = $('.notification-action-btn[title*="Copy"]');
    const hover = () => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const leave = () => button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    vi.useFakeTimers();
    try {
      hover();
      const tooltip = button.dataset.tooltip;
      expect(tooltip).toMatch(/copy/i);
      button.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText).toHaveBeenCalledExactlyOnceWith(url);
      leave();
      hover();
      await vi.advanceTimersByTimeAsync(2050);
      leave();
      hover();
      expect(button.dataset.tooltip).toBe(tooltip);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the click URL from the title and view actions from their buttons', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [
        message('linked', 'alerts', 1, {
          click: 'https://status.example/incident',
          actions: [
            { action: 'view', label: 'Logs', url: 'https://logs.example' },
            { action: 'http', label: 'Restart', url: 'https://api.example/restart' },
          ],
        }),
      ],
    });
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    await openPopup('?tab=receive');
    const item = [...document.querySelectorAll<HTMLElement>('.notification-item')].find((el) => el.dataset.id === 'linked')!;
    expect([...item.querySelectorAll('.notification-view-action')].map((b) => b.textContent)).toEqual(['↗ Logs']); // no http action
    item.querySelector<HTMLElement>('.notification-link')!.click();
    item.querySelector<HTMLElement>('.notification-view-action')!.click();
    expect(create.mock.calls).toEqual([[{ url: 'https://status.example/incident' }], [{ url: 'https://logs.example' }]]);
  });

  it('shows and marks read the message a notification click opened', async () => {
    await fakeBrowser.storage.local.set({ receiveTopicFilter: { topic: 'coolify' } });
    await openPopup('?mode=page&tab=receive&message=a1');
    const focused = $('.notification-item.focused');
    expect(focused.dataset.id).toBe('a1'); // shown although another topic was selected
    await flush();
    const { readMessageIds } = await fakeBrowser.storage.local.get('readMessageIds');
    expect(readMessageIds).toContain('a1');
  });

  it('searches titles, messages, tags and topics', async () => {
    await openPopup('?tab=receive');
    const search = $<HTMLInputElement>('#notifications-search');
    search.value = 'COOLIFY';
    search.dispatchEvent(new Event('input'));
    await flush();
    expect([...document.querySelectorAll('.notification-title')].map((t) => t.textContent)).toEqual(['c1']);

    search.value = 'body a2';
    search.dispatchEvent(new Event('input'));
    await flush();
    expect([...document.querySelectorAll('.notification-title')].map((t) => t.textContent)).toEqual(['a2']);

    search.value = 'nothing like this';
    search.dispatchEvent(new Event('input'));
    await flush();
    expect($('.notifications-empty').textContent).toBe('No messages match the search');
  });

  it('filters the loaded history on search input without reading storage again', async () => {
    await openPopup('?tab=receive');
    const get = vi.spyOn(fakeBrowser.storage.local, 'get');
    const search = $<HTMLInputElement>('#notifications-search');
    search.value = 'coolify';
    search.dispatchEvent(new Event('input'));
    expect([...document.querySelectorAll('.notification-title')].map((t) => t.textContent)).toEqual(['c1']);
    expect(get).not.toHaveBeenCalled();

    // A storage change still reloads the history
    const { receivedNotifications } = await fakeBrowser.storage.local.get('receivedNotifications');
    await fakeBrowser.storage.local.set({
      receivedNotifications: [message('c2', 'coolify', 1), ...(receivedNotifications as NtfyMessage[])],
    });
    await vi.waitFor(() => expect([...document.querySelectorAll('.notification-title')].map((t) => t.textContent)).toEqual(['c2', 'c1']));
  });

  it('shows a visible error when the popup cannot start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fakeBrowser.storage.sync, 'get').mockRejectedValue(new Error('storage unavailable'));
    await openPopup();
    const banner = $('.startup-error');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('ntfy Desk could not start: storage unavailable');
  });

  it('renders Markdown messages, and leaves other messages as plain text', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [
        message('md', 'alerts', 1, { message: '**Disk** at 91%, [logs](https://logs.example)', content_type: 'text/markdown' }),
        message('plain', 'alerts', 2, { message: '**not bold** <b>x</b>' }),
        message('url', 'alerts', 3, { message: 'Build failed: https://ci.example/run/7. javascript:alert(1)' }),
      ],
    });
    await openPopup('?tab=receive');
    const bodies = [...document.querySelectorAll<HTMLElement>('.notification-message')];
    expect(bodies[0]!.querySelector('strong')?.textContent).toBe('Disk');
    expect(bodies[0]!.querySelector('a')?.getAttribute('href')).toBe('https://logs.example');
    expect(bodies[1]!.children).toHaveLength(0);
    expect(bodies[1]!.textContent).toBe('**not bold** <b>x</b>');
    // Newest first: the plain message with a URL is the first one
    const link = bodies.find((body) => body.textContent?.startsWith('Build failed'))!.querySelectorAll('a');
    expect([...link].map((a) => [a.getAttribute('href'), a.target])).toEqual([['https://ci.example/run/7', '_blank']]);
  });

  it('previews image attachments hosted on the server only, while they last', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const image = (url: string, expires = future) => ({ url, type: 'image/png', name: 'shot.png', expires });
    await fakeBrowser.storage.local.set({
      receivedNotifications: [
        message('onServer', 'alerts', 1, { attachment: image('https://ntfy.example/file/abc.png') }),
        message('external', 'alerts', 2, { attachment: image('https://tracker.example/pixel.png') }),
        message('expired', 'alerts', 3, { attachment: image('https://ntfy.example/file/old.png', 1000) }),
        message('notImage', 'alerts', 4, { attachment: { url: 'https://ntfy.example/file/a.zip', type: 'application/zip' } }),
        // Same origin, but an API call (ntfy publishes on GET), not an attachment (review #3)
        message('apiCall', 'alerts', 5, { attachment: image('https://ntfy.example/alerts/publish?message=hi') }),
        message('withQuery', 'alerts', 6, { attachment: image('https://ntfy.example/file/abc.png?x=1') }),
        message('nested', 'alerts', 7, { attachment: image('https://ntfy.example/file/../alerts/publish') }),
      ],
    });
    await openPopup('?tab=receive');
    const withImage = [...document.querySelectorAll<HTMLElement>('.notification-item')].filter((item) =>
      item.querySelector('.notification-image'),
    );
    expect(withImage.map((item) => item.dataset.id)).toEqual(['onServer']);
    expect(withImage[0]!.querySelector('img')!.getAttribute('src')).toBe('https://ntfy.example/file/abc.png');
  });

  it('shows the other messages when a stored message is malformed (security review #3)', async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [{ ...message('bad', 'alerts', 1), actions: {} }, message('good', 'alerts', 2)],
    });
    await openPopup('?tab=receive');
    const titles = [...document.querySelectorAll('.notification-item')].map((item) => item.textContent);
    expect(titles.some((text) => text?.includes('body of bad'))).toBe(true);
    expect(titles.some((text) => text?.includes('body of good'))).toBe(true);
  });

  it('shows a placeholder for a message that fails to render, and the others as usual', async () => {
    await fakeBrowser.storage.local.set({ receivedNotifications: [message('old', 'alerts', 3 * 24 * 60), message('new', 'alerts', 2)] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Only the 3-day-old message formats its time as a date
    vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(() => {
      throw new RangeError('broken');
    });
    await openPopup('?tab=receive');
    const items = [...document.querySelectorAll('.notification-item')].map((item) => item.textContent);
    expect(items).toHaveLength(2);
    expect(items.some((text) => text?.includes('body of new'))).toBe(true);
    expect(items).toContain('This message could not be shown');
  });

  it('keeps the heading in place when the list is empty', async () => {
    await fakeBrowser.storage.local.set({ receiveTopicFilter: { topic: 'inbox' } });
    await openPopup('?tab=receive');
    expect($('.notifications-empty').textContent).toBe('No recent notifications');
    expect($('#notifications-control-bar').style.visibility).toBe('hidden');
  });
});

describe('Send form', () => {
  it('skips a queued file removed in another view before its upload starts', async () => {
    await queueFiles(['first.txt'], ['removed.txt']);
    await openPopup('?mode=page');
    const { promise, resolve } = Promise.withResolvers<void>();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      await promise;
      return new Response('');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { send } = await import('@/entrypoints/popup/send');
    const { listStoredFiles, removeStoredFiles } = await import('@/utils/stored-files');
    const removed = (await listStoredFiles()).find(({ name }) => name === 'removed.txt')!.id;
    const pending = send();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await removeStoredFiles([removed]);
    resolve();
    await pending;
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init.headers).get('X-Filename'))).toEqual(['first.txt']);
    expect($('#status').textContent).toBe('Notification sent!');
  });

  it('reports a successful publish separately from a persistent draft cleanup warning', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation((async (request: { action: string }) => {
      if (request.action === 'clearDraft') throw new Error('Storage unavailable');
      return { success: true, deletion: await handlePopupRequest(request, async () => {}) };
    }) as never);
    await openPopup();
    $<HTMLTextAreaElement>('#message-input').value = 'Already published';
    const { send } = await import('@/entrypoints/popup/send');
    // setImmediate stays real: fake-indexeddb schedules its events with it
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      await send();
      await vi.advanceTimersByTimeAsync(4000);
      expect(requests).toHaveLength(1);
      expect($('#status').textContent).toBe('Sent, but the draft could not be cleared.');
      expect($<HTMLTextAreaElement>('#message-input').value).toBe('Already published');
      expect(closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps failed attachments and the draft after a partial send, then retries only the failed file', async () => {
    await queueFiles(['sent.txt'], ['retry.txt']);
    await openPopup();
    const sent: string[] = [];
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const name = new Headers(init.headers).get('X-Filename') ?? '';
        sent.push(name);
        return fail && name === 'retry.txt' ? new Response('', { status: 503 }) : new Response('');
      }),
    );
    $<HTMLTextAreaElement>('#message-input').value = 'My draft';
    const { send } = await import('@/entrypoints/popup/send');
    await send();
    expect(sent).toEqual(['sent.txt', 'retry.txt']);
    expect(await queuedNames()).toEqual(['retry.txt']);
    expect(await fakeBrowser.storage.local.get('draftState')).toMatchObject({ draftState: { message: 'My draft' } });
    expect($('#status').textContent).toContain('1 of 2 attachments sent');
    expect($<HTMLButtonElement>('#send-btn').disabled).toBe(false);
    expect(closed).toBe(false);
    fail = false;
    await send();
    expect(sent).toEqual(['sent.txt', 'retry.txt', 'retry.txt']);
    expect(await queuedNames()).toEqual([]);
    expect(await fakeBrowser.storage.local.get('draftState')).toEqual({});
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('selects the fallback before dispatching the saved attachment when the primary is unreachable', async () => {
    await fakeBrowser.storage.sync.set({ fallbackUrl: 'https://fallback.example' });
    await queueFiles(['a.txt']);
    await openPopup('?mode=page');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://ntfy.example/')) throw new TypeError('network error');
      if (url.endsWith('/v1/health')) return Response.json({ healthy: true });
      return new Response('');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { send } = await import('@/entrypoints/popup/send');
    await send();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://ntfy.example/v1/health',
      'https://fallback.example/v1/health',
      'https://fallback.example/inbox',
    ]);
    expect($('#status').textContent).toBe('Notification sent!');
    expect(await queuedNames()).toEqual([]);
  });

  it('preserves the draft and reports uncertainty after a lost publish response', async () => {
    await fakeBrowser.storage.sync.set({ fallbackUrl: 'https://fallback.example' });
    await openPopup('?mode=page');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/health')) return Response.json({ healthy: true });
      throw new TypeError('response connection lost');
    });
    vi.stubGlobal('fetch', fetchMock);
    $<HTMLTextAreaElement>('#message-input').value = 'Check before resending';
    const { send } = await import('@/entrypoints/popup/send');
    await send();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://ntfy.example/v1/health', 'https://ntfy.example/inbox']);
    expect($('#status').textContent).toBe('Delivery is uncertain. Check the Inbox before retrying.');
    expect((await fakeBrowser.storage.local.get('draftState')).draftState).toMatchObject({ message: 'Check before resending' });
  });

  it.each([
    ['fallbackUrl', 'https://new-fallback.example'],
    ['topics', 'alerts'],
  ])('keeps the draft and blocks a send after a change to %s', async (key, value) => {
    await openPopup();
    const input = $<HTMLTextAreaElement>('#message-input');
    input.value = 'Keep this draft';
    await fakeBrowser.storage.sync.set({ [key]: value });
    $('#send-btn').click();
    await vi.waitFor(() => expect($('#status').textContent).toContain('The server or topic changed'));
    expect(requests).toEqual([]);
    expect((await fakeBrowser.storage.local.get('draftState')).draftState).toMatchObject({ message: 'Keep this draft' });
  });

  it("puts the tab's title in the title and its URL in the message, and sends to the selected topic", async () => {
    await fakeBrowser.storage.sync.set({ includeUrl: true });
    await openPopup();
    expect($<HTMLInputElement>('#title-input').value).toBe('The story');
    expect($<HTMLTextAreaElement>('#message-input').value).toBe('https://news.example/story');
    expect($<HTMLSelectElement>('#topic-select').value).toBe('inbox');

    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.url).toBe('https://ntfy.example/inbox');
    expect(requests[0]!.body).toBe('https://news.example/story');
    expect(requests[0]!.headers.get('X-Title')).toBe('The story');
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer tk_x');
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("doesn't save an automatically filled title or URL in the draft", async () => {
    await fakeBrowser.storage.sync.set({ includeUrl: true });
    await openPopup();
    const title = $<HTMLInputElement>('#title-input');
    title.value = 'my title';
    title.dispatchEvent(new Event('input'));
    await vi.waitFor(async () => {
      const { draftState } = await fakeBrowser.storage.local.get('draftState');
      expect(draftState).toMatchObject({ title: 'my title', message: '' });
    });
  });

  it('leaves the title and message empty without "Fill in the current tab"', async () => {
    await openPopup();
    expect($<HTMLInputElement>('#title-input').value).toBe('');
    expect($<HTMLTextAreaElement>('#message-input').value).toBe('');
  });

  it('keeps a message restored from the draft instead of the tab URL', async () => {
    await fakeBrowser.storage.sync.set({ includeUrl: true });
    await fakeBrowser.storage.local.set({ draftState: { title: '', message: 'typed before' } });
    await openPopup();
    expect($<HTMLInputElement>('#title-input').value).toBe('The story');
    expect($<HTMLTextAreaElement>('#message-input').value).toBe('typed before');
  });

  it('restores unsent work when extension session storage was cleared', async () => {
    await fakeBrowser.storage.session.clear();
    await fakeBrowser.storage.local.set({ draftState: { title: 'Unsent draft' } });
    await queueFiles(['saved.txt']);
    await openPopup();
    expect($<HTMLInputElement>('#title-input').value).toBe('Unsent draft');
    expect($('#file-preview').textContent).toContain('saved.txt');
  });

  it('sends two attachments as one ZIP when that option is on', async () => {
    await fakeBrowser.storage.sync.set({ sendAsZipEnabled: true });
    await queueFiles(['a.txt', 'hello'], ['b.txt', 'hello']);
    await openPopup();
    expect(document.querySelectorAll('.file-preview-item')).toHaveLength(2);
    expect($<HTMLInputElement>('#zip-checkbox').checked).toBe(true);

    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.headers.get('Content-Type')).toBe('application/zip');
    expect(requests[0]!.headers.get('X-Filename')).toMatch(/^ntfy-files-\d{8}-\d{6}\.zip$/);
    // Let the popup's close timer run inside this test
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(await queuedNames()).toEqual([]);
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('sends with %s + Enter from the composer only', async (_, modifier) => {
    await openPopup('?mode=page');
    const press = (target: HTMLElement) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifier }));
    const input = $<HTMLTextAreaElement>('#message-input');
    input.value = 'shortcut';
    $('#notifications-search').focus();
    press($('#notifications-search'));
    await flush();
    expect(requests).toEqual([]);
    input.focus();
    press(input);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.body).toBe('shortcut');
  });

  it('sends once when Send is clicked twice quickly (review #10)', async () => {
    await openPopup();
    $<HTMLTextAreaElement>('#message-input').value = 'once';
    $('#send-btn').click();
    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    // Let the popup's close timer run inside this test
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(requests).toHaveLength(1);
  });

  it('sends once when two sends start together, the button aside (review #10)', async () => {
    await openPopup();
    $<HTMLTextAreaElement>('#message-input').value = 'once';
    // The module instance the popup loaded
    const { send } = await import('@/entrypoints/popup/send');
    await Promise.all([send(), send()]);
    expect(requests).toHaveLength(1);
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('uses the active tab of the last focused window when tabs report no last-used time (review #14)', async () => {
    await openPopup('?mode=page');
    mockResolved(fakeBrowser.permissions, 'request', true);
    mockResolved(fakeBrowser.tabs, 'getCurrent', { id: 9 });
    mockResolved(fakeBrowser.windows, 'getLastFocused', { id: 2 });
    mockResolved(fakeBrowser.tabs, 'query', [
      { id: 1, windowId: 1, active: true, url: 'https://other-window.example/' },
      { id: 2, windowId: 2, active: false, url: 'https://background-tab.example/' },
      { id: 3, windowId: 2, active: true, url: 'https://the-page.example/article/', title: 'The article' },
      { id: 9, windowId: 2, active: false, url: 'chrome-extension://id/popup.html' },
    ]);
    $('#tab-url-btn').click();
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('#message-input').value).toBe('https://the-page.example/article'));
    expect($<HTMLInputElement>('#title-input').value).toBe('The article');
  });

  it('stays open after sending in the extension tab', async () => {
    await openPopup('?mode=page');
    expect(document.body.classList.contains('page-mode')).toBe(true);
    expect($('#popout-btn').style.display).toBe('none');
    $<HTMLTextAreaElement>('#message-input').value = 'x';
    $('#send-btn').click();
    await vi.waitFor(() => expect($('#status').textContent).toBe('Notification sent!'));
    expect(requests).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 150)); // past the popup's 100 ms close delay
    expect(closed).toBe(false);
  });
});

describe('Send form: per-topic send defaults', () => {
  const priority = () => $('#priority-chips .chip.active').dataset.priority;
  const tags = () => [...document.querySelectorAll('#tags-container .tag-badge')].map((badge) => badge.firstChild?.textContent);
  const reset = () => $<HTMLButtonElement>('#send-defaults-reset');
  const pickTopic = (topic: string) => {
    $<HTMLSelectElement>('#topic-select').value = topic;
    $('#topic-select').dispatchEvent(new Event('change'));
  };
  const pickPriority = (value: number) => $(`#priority-chips .chip[data-priority="${value}"]`).click();
  const addTag = (tag: string) => {
    $<HTMLInputElement>('#new-tag-input').value = tag;
    $('#new-tag-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  };
  const draft = async () => (await fakeBrowser.storage.local.get('draftState')).draftState as Record<string, unknown> | undefined;
  const reopen = async (search = '') => {
    vi.resetModules();
    document.body.innerHTML = body;
    await openPopup(search);
  };

  beforeEach(async () => {
    // "inbox" is the send topic (lastTopic); "alerts" has send defaults
    await fakeBrowser.storage.sync.set({
      priority: 2,
      lastTags: ['last'],
      topicSendDefaults: [{ topic: 'alerts', priority: 5, tags: ['warning', 'server'] }],
    });
  });

  it('shows the priority and tags used last for a topic without defaults, as before', async () => {
    await openPopup();
    expect([priority(), tags()]).toEqual(['2', ['last']]);
    expect(reset().hidden).toBe(true);
    $<HTMLTextAreaElement>('#message-input').value = 'x';
    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.headers.get('X-Priority')).toBe('2');
    expect(requests[0]!.headers.get('X-Tags')).toBe('last');
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("shows a topic's defaults when the popup opens on it, and sends with them", async () => {
    await fakeBrowser.storage.sync.set({ lastTopic: 'alerts' });
    await openPopup('?mode=page');
    expect([priority(), tags()]).toEqual(['5', ['warning', 'server']]);
    $<HTMLTextAreaElement>('#message-input').value = 'x';
    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.url).toBe('https://ntfy.example/alerts');
    expect(requests[0]!.headers.get('X-Priority')).toBe('5');
    expect(requests[0]!.headers.get('X-Tags')).toBe('warning,server');
    // Sending with a topic's defaults doesn't make them the values used last
    expect(await fakeBrowser.storage.sync.get(['priority', 'lastTags'])).toEqual({ priority: 2, lastTags: ['last'] });
  });

  it('follows the send topic: the select, and the inbox topic that overrides it', async () => {
    await openPopup('?mode=page');
    pickTopic('alerts');
    expect([priority(), tags()]).toEqual(['5', ['warning', 'server']]);
    pickTopic('coolify');
    expect([priority(), tags()]).toEqual(['2', ['last']]);

    const inboxTopics = [...document.querySelectorAll<HTMLElement>('.topic-filter-btn')];
    inboxTopics.find((button) => button.textContent === 'alerts')!.click();
    expect($<HTMLSelectElement>('#topic-select').value).toBe('alerts');
    expect([priority(), tags()]).toEqual(['5', ['warning', 'server']]);
    inboxTopics[0]!.click(); // All topics: back to the Send form's own topic
    expect($<HTMLSelectElement>('#topic-select').value).toBe('coolify');
    expect([priority(), tags()]).toEqual(['2', ['last']]);
    await flush();
    // Following the topic is not an edit: nothing was saved as used last or as a draft's own values
    expect(await fakeBrowser.storage.sync.get(['priority', 'lastTags'])).toEqual({ priority: 2, lastTags: ['last'] });
    expect(await draft()).toMatchObject({ customPriorityTags: false });
  });

  it('keeps a priority and tags set by hand when the topic changes, until they are reset', async () => {
    await openPopup('?mode=page');
    pickPriority(4);
    addTag('mine');
    expect([priority(), tags()]).toEqual(['4', ['last', 'mine']]);
    // Equal to what "last used" now is: nothing to take back
    expect(reset().hidden).toBe(true);

    pickTopic('alerts');
    expect([priority(), tags()]).toEqual(['4', ['last', 'mine']]);
    expect(reset().hidden).toBe(false);
    expect(reset().textContent).toBe('Use topic defaults');
    await vi.waitFor(async () => expect(await draft()).toMatchObject({ customPriorityTags: true, priority: 4, tags: ['last', 'mine'] }));

    reset().click();
    expect([priority(), tags()]).toEqual(['5', ['warning', 'server']]);
    expect(reset().hidden).toBe(true);
    pickTopic('inbox');
    expect([priority(), tags()]).toEqual(['4', ['last', 'mine']]); // used last
    await vi.waitFor(async () => expect(await draft()).toMatchObject({ customPriorityTags: false }));
  });

  it('remembers a change by hand as used last, except on a topic with defaults', async () => {
    await openPopup('?mode=page');
    pickPriority(4);
    addTag('mine');
    await flush();
    expect(await fakeBrowser.storage.sync.get(['priority', 'lastTags'])).toEqual({ priority: 4, lastTags: ['last', 'mine'] });

    reset().click(); // nothing differs, but the next topic's defaults apply again
    await reopen('?mode=page');
    await fakeBrowser.storage.local.remove('draftState');
    await reopen('?mode=page');
    pickTopic('alerts');
    expect([priority(), tags()]).toEqual(['5', ['warning', 'server']]);
    pickPriority(1);
    addTag('once');
    $('#tags-container .tag-remove').click(); // "warning"
    await flush();
    expect([priority(), tags()]).toEqual(['1', ['server', 'once']]);
    expect(reset().hidden).toBe(false);
    expect(await fakeBrowser.storage.sync.get(['priority', 'lastTags'])).toEqual({ priority: 4, lastTags: ['last', 'mine'] });
    expect((await fakeBrowser.storage.sync.get('topicSendDefaults')).topicSendDefaults).toEqual([
      { topic: 'alerts', priority: 5, tags: ['warning', 'server'] },
    ]);
  });

  it('restores the priority and tags of a draft that set them by hand, whatever the topic defaults', async () => {
    await openPopup('?mode=page');
    pickTopic('alerts');
    pickPriority(3);
    addTag('draft-tag');
    $<HTMLInputElement>('#title-input').value = 'Unsent';
    $('#title-input').dispatchEvent(new Event('input'));
    await vi.waitFor(async () =>
      expect(await draft()).toMatchObject({
        title: 'Unsent',
        topic: 'alerts',
        priority: 3,
        tags: ['warning', 'server', 'draft-tag'],
        customPriorityTags: true,
      }),
    );

    await reopen();
    expect($<HTMLSelectElement>('#topic-select').value).toBe('alerts');
    expect($<HTMLInputElement>('#title-input').value).toBe('Unsent');
    expect([priority(), tags()]).toEqual(['3', ['warning', 'server', 'draft-tag']]);
    expect(reset().hidden).toBe(false);
    pickTopic('inbox');
    expect([priority(), tags()]).toEqual(['3', ['warning', 'server', 'draft-tag']]);
  });

  it("lets a draft that never set them follow the topic's defaults, also ones changed since", async () => {
    await openPopup('?mode=page');
    pickTopic('alerts');
    $<HTMLInputElement>('#title-input').value = 'Unsent';
    $('#title-input').dispatchEvent(new Event('input'));
    await vi.waitFor(async () => expect(await draft()).toMatchObject({ title: 'Unsent', topic: 'alerts', customPriorityTags: false }));
    await fakeBrowser.storage.sync.set({ topicSendDefaults: [{ topic: 'alerts', priority: 4, tags: ['changed'] }] });

    await reopen();
    expect($<HTMLInputElement>('#title-input').value).toBe('Unsent');
    expect([priority(), tags()]).toEqual(['4', ['changed']]);
  });

  it('ignores invalid priority and tags in a stored draft', async () => {
    await fakeBrowser.storage.local.set({ draftState: { topic: 'coolify', customPriorityTags: true, priority: 9, tags: ['ok', 7] } });
    await openPopup();
    expect([priority(), tags()]).toEqual(['2', ['ok']]);
  });

  it("starts the next message from the topic's defaults again after a send", async () => {
    await openPopup('?mode=page');
    pickTopic('alerts');
    pickPriority(1);
    $<HTMLTextAreaElement>('#message-input').value = 'x';
    $('#send-btn').click();
    await vi.waitFor(() => expect($('#status').textContent).toBe('Notification sent!'));
    expect(requests[0]!.headers.get('X-Priority')).toBe('1');
    expect([priority(), tags()]).toEqual(['5', ['warning', 'server']]);
    expect(reset().hidden).toBe(true);
    expect(await draft()).toBeUndefined();
  });

  it('follows defaults and last-used values changed in another view or through sync, unless set by hand', async () => {
    await openPopup('?mode=page');
    await fakeBrowser.storage.sync.set({ priority: 1, lastTags: ['elsewhere'] });
    await vi.waitFor(() => expect([priority(), tags()]).toEqual(['1', ['elsewhere']]));
    await fakeBrowser.storage.sync.set({ topicSendDefaults: [{ topic: 'inbox', priority: 4, tags: [] }] });
    await vi.waitFor(() => expect([priority(), tags()]).toEqual(['4', []]));
    // An invalid value from another device reads as no defaults
    await fakeBrowser.storage.sync.set({ topicSendDefaults: [{ topic: 'inbox', priority: 11, tags: 'x' }] });
    await vi.waitFor(() => expect([priority(), tags()]).toEqual(['1', ['elsewhere']]));

    pickPriority(3);
    await flush();
    await fakeBrowser.storage.sync.set({ topicSendDefaults: [{ topic: 'inbox', priority: 5, tags: ['late'] }] });
    await flush();
    expect([priority(), tags()]).toEqual(['3', ['elsewhere']]);
    expect(reset().hidden).toBe(false);
  });

  it('reads an invalid stored priority as the default priority', async () => {
    await fakeBrowser.storage.sync.set({ priority: 42, lastTags: 'x' });
    await openPopup();
    expect([priority(), tags()]).toEqual(['3', []]);
  });
});

describe('Send form: more options', () => {
  const click = () => $<HTMLInputElement>('#click-input');
  const markdown = () => $<HTMLInputElement>('#markdown-checkbox');
  const delaySelect = () => $<HTMLSelectElement>('#delay-select');
  const delayInput = () => $<HTMLInputElement>('#delay-input');
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const chooseDelay = (value: string) => {
    delaySelect().value = value;
    delaySelect().dispatchEvent(new Event('change'));
  };
  const fill = (options: { click?: string; markdown?: boolean; delay?: string; custom?: string }) => {
    if (options.click !== undefined) type(click(), options.click);
    if (options.markdown) {
      markdown().checked = true;
      markdown().dispatchEvent(new Event('change'));
    }
    if (options.delay !== undefined) chooseDelay(options.delay);
    if (options.custom !== undefined) type(delayInput(), options.custom);
  };
  const optionHeaders = (headers: Headers) => ['X-Click', 'X-Markdown', 'X-Delay'].map((name) => headers.get(name));
  const draft = async () => (await fakeBrowser.storage.local.get('draftState')).draftState as Record<string, unknown> | undefined;
  /** The server's answer to a publish: the message, delivered `seconds` from now */
  const answerWithDelivery = (seconds: number) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, headers: new Headers(init.headers), body: init.body });
        return Response.json({ id: 'm1', event: 'message', topic: 'inbox', time: Math.floor(Date.now() / 1000) + seconds });
      }),
    );

  it('is closed and empty at first, and sends none of the options', async () => {
    await openPopup('?mode=page');
    expect($<HTMLDetailsElement>('#more-options').open).toBe(false);
    expect($('#more-options-active').textContent).toBe('');
    expect(delayInput().hidden).toBe(true);
    $<HTMLTextAreaElement>('#message-input').value = 'plain';
    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(optionHeaders(requests[0]!.headers)).toEqual([null, null, null]);
  });

  it('sends the click URL, Markdown and delay as headers, and says the message is scheduled', async () => {
    answerWithDelivery(30 * 60);
    await openPopup(); // the toolbar popup, which closes after an immediate send
    fill({ click: 'https://example.com/ticket/7', markdown: true, delay: '30m' });
    expect($('#more-options-active').textContent).toBe('(URL, Markdown, delay)');
    expect($('#delay-hint').textContent).toBe('The server sets the limits: 10 seconds to 3 days by default.');
    $<HTMLTextAreaElement>('#message-input').value = '**later**';
    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.url).toBe('https://ntfy.example/inbox');
    expect(requests[0]!.body).toBe('**later**');
    expect(optionHeaders(requests[0]!.headers)).toEqual(['https://example.com/ticket/7', 'yes', '30m']);

    await vi.waitFor(() =>
      expect($('#status').textContent).toMatch(/^Notification scheduled for .+\. It appears in the Inbox when delivered\.$/),
    );
    await new Promise((resolve) => setTimeout(resolve, 150)); // past the popup's 100 ms close delay
    expect(closed).toBe(false);
    // Cleared like the title and message, with the draft
    expect([click().value, markdown().checked, delaySelect().value]).toEqual(['', false, '']);
    expect($('#more-options-active').textContent).toBe('');
    expect(await draft()).toBeUndefined();
  });

  it('says scheduled without a time when the answer has none', async () => {
    await openPopup('?mode=page');
    fill({ delay: '1h' });
    $('#send-btn').click();
    await vi.waitFor(() => expect($('#status').textContent).toBe('Notification scheduled. It appears in the Inbox when delivered.'));
  });

  it('sends a typed delay, and asks for one when the field is empty', async () => {
    await openPopup('?mode=page');
    fill({ delay: '__custom' });
    expect(delayInput().hidden).toBe(false);
    expect($('#delay-hint').textContent).toContain('"tomorrow 9am" in your time zone');
    $('#send-btn').click();
    await vi.waitFor(() => expect($('#status').textContent).toBe('Enter a delay such as 45m, or choose Now'));
    expect($('#delay-error').textContent).toBe('Enter a delay such as 45m, or choose Now');
    expect(delayInput().getAttribute('aria-invalid')).toBe('true');
    expect($<HTMLDetailsElement>('#more-options').open).toBe(true);
    expect(requests).toEqual([]);

    fill({ custom: ' tomorrow 9am ' });
    expect($('#delay-error').hidden).toBe(true);
    expect(delayInput().hasAttribute('aria-invalid')).toBe(false);
    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.headers.get('X-Delay')).toBe('tomorrow 9am');
    expect(requests[0]!.headers.get('X-Timezone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it.each([
    ['example.com/page', 'Enter a complete http:// or https:// click URL, or leave it empty'],
    ['javascript:alert(1)', 'Enter a complete http:// or https:// click URL, or leave it empty'],
    ['https://me:secret@example.com/', 'Remove the username and password from the click URL'],
  ])('refuses the click URL %s with a visible error, before any request', async (url, problem) => {
    await openPopup('?mode=page');
    fill({ click: url });
    $<HTMLTextAreaElement>('#message-input').value = 'Keep me';
    $('#send-btn').click();
    await vi.waitFor(() => expect($('#status').textContent).toBe(problem));
    expect($('#click-error').textContent).toBe(problem);
    expect($('#click-error').hidden).toBe(false);
    expect(click().getAttribute('aria-invalid')).toBe('true');
    expect($<HTMLDetailsElement>('#more-options').open).toBe(true);
    expect(requests).toEqual([]);
    expect($<HTMLTextAreaElement>('#message-input').value).toBe('Keep me');

    fill({ click: 'https://example.com/page' });
    expect($('#click-error').hidden).toBe(true);
    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.headers.get('X-Click')).toBe('https://example.com/page');
  });

  it('sends the options with each attachment', async () => {
    await queueFiles(['a.txt'], ['b.txt']);
    await openPopup('?mode=page');
    fill({ click: 'https://example.com/', markdown: true, delay: '10m' });
    expect($('#delay-hint').textContent).toContain('It refuses a delay longer than it keeps attachments (3 hours by default).');
    $('#send-btn').click();
    await vi.waitFor(() => expect($('#status').textContent).toBe('2 notifications scheduled. They appear in the Inbox when delivered.'));
    expect(requests.map(({ headers }) => [headers.get('X-Filename'), ...optionHeaders(headers)])).toEqual([
      ['a.txt', 'https://example.com/', 'yes', '10m'],
      ['b.txt', 'https://example.com/', 'yes', '10m'],
    ]);
    expect(await queuedNames()).toEqual([]);
  });

  it('sends the options with the ZIP', async () => {
    await fakeBrowser.storage.sync.set({ sendAsZipEnabled: true });
    await queueFiles(['a.txt'], ['b.txt']);
    answerWithDelivery(3600);
    await openPopup('?mode=page');
    fill({ click: 'https://example.com/', markdown: true, delay: '1h' });
    $('#send-btn').click();
    await vi.waitFor(() => expect($('#status').textContent).toMatch(/^ZIP scheduled for .+\. It appears in the Inbox when delivered\.$/));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('Content-Type')).toBe('application/zip');
    expect(optionHeaders(requests[0]!.headers)).toEqual(['https://example.com/', 'yes', '1h']);
  });

  it("shows the server's reason when it refuses the delay, and keeps the form", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ code: 40006, http: 400, error: 'invalid delay parameter: too large, please refer to the docs' }, { status: 400 }),
      ),
    );
    await openPopup('?mode=page');
    fill({ delay: '__custom', custom: '9 days' });
    $<HTMLTextAreaElement>('#message-input').value = 'Keep me';
    $('#send-btn').click();
    await vi.waitFor(() =>
      expect($('#status').textContent).toBe('Error: HTTP 400: invalid delay parameter: too large, please refer to the docs'),
    );
    expect($<HTMLTextAreaElement>('#message-input').value).toBe('Keep me');
    expect([delaySelect().value, delayInput().value]).toEqual(['__custom', '9 days']);
    expect(await draft()).toMatchObject({ message: 'Keep me', delay: '9 days' });
  });

  it('explains that a delayed message with a lost answer may be scheduled without showing in the Inbox', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('response connection lost');
      }),
    );
    await openPopup('?mode=page');
    fill({ delay: '30m' });
    $('#send-btn').click();
    await vi.waitFor(() =>
      expect($('#status').textContent).toBe(
        'Delivery is uncertain: the server may have scheduled the message. It only appears in the Inbox when it is delivered, so sending again can deliver it twice.',
      ),
    );
    expect($('#status').classList.contains('warning')).toBe(true);
    expect(await draft()).toMatchObject({ delay: '30m' });
  });

  it('saves the options in the draft and restores them', async () => {
    await openPopup('?mode=page');
    fill({ click: 'https://example.com/a', markdown: true, delay: '3h' });
    await vi.waitFor(async () => expect(await draft()).toMatchObject({ click: 'https://example.com/a', markdown: true, delay: '3h' }));

    vi.resetModules();
    document.body.innerHTML = body;
    await openPopup('?mode=page');
    expect([click().value, markdown().checked, delaySelect().value, delayInput().hidden]).toEqual([
      'https://example.com/a',
      true,
      '3h',
      true,
    ]);
    expect($('#more-options-active').textContent).toBe('(URL, Markdown, delay)');

    fill({ delay: '__custom', custom: 'tomorrow 9am' });
    await vi.waitFor(async () => expect(await draft()).toMatchObject({ delay: 'tomorrow 9am' }));
    vi.resetModules();
    document.body.innerHTML = body;
    await openPopup('?mode=page');
    expect([delaySelect().value, delayInput().value, delayInput().hidden]).toEqual(['__custom', 'tomorrow 9am', false]);
  });

  it('ignores malformed options in a stored draft', async () => {
    await fakeBrowser.storage.local.set({ draftState: { message: 'm', click: 7, markdown: 'yes', delay: ['1h'] } });
    await openPopup();
    expect([click().value, markdown().checked, delaySelect().value]).toEqual(['', false, '']);
    expect($<HTMLTextAreaElement>('#message-input').value).toBe('m');
  });

  it('keeps options edited while a send is in progress', async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => promise),
    );
    await openPopup('?mode=page');
    $<HTMLTextAreaElement>('#message-input').value = 'first';
    const { send } = await import('@/entrypoints/popup/send');
    const pending = send();
    await flush();
    fill({ click: 'https://example.com/next' });
    await flush();
    resolve(new Response(''));
    await pending;
    expect(click().value).toBe('https://example.com/next');
    expect(await draft()).toMatchObject({ click: 'https://example.com/next' });
  });

  it('sends the options the form had when Send was pressed, not ones edited while the draft was saved', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('')));
    vi.stubGlobal('fetch', fetchMock);
    await openPopup('?mode=page');
    $<HTMLTextAreaElement>('#message-input').value = 'first';
    const answer = vi.mocked(fakeBrowser.runtime.sendMessage).getMockImplementation() as (request: unknown) => Promise<unknown>;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementation((async (request: { action?: string }) => {
      if (request.action === 'saveDraft') await gate;
      return answer(request);
    }) as never);
    const { send } = await import('@/entrypoints/popup/send');
    const pending = send();
    await flush();
    fill({ click: 'https://example.com/next' });
    release();
    await pending;
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[1]?.body).toBe('first');
    expect(new Headers(post?.[1]?.headers).has('X-Click')).toBe(false);
  });

  it('remembers on this device whether the section is open', async () => {
    await openPopup();
    const section = $<HTMLDetailsElement>('#more-options');
    section.open = true;
    section.dispatchEvent(new Event('toggle'));
    await flush();
    expect(await fakeBrowser.storage.local.get('sendOptionsOpen')).toEqual({ sendOptionsOpen: true });
    expect(await fakeBrowser.storage.sync.get('sendOptionsOpen')).toEqual({});

    vi.resetModules();
    document.body.innerHTML = body;
    await openPopup();
    expect($<HTMLDetailsElement>('#more-options').open).toBe(true);
  });
});

describe('settings', () => {
  it('asks before leaving unsaved server and credential edits', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    await openPopup();
    await openSettings();
    const input = $<HTMLInputElement>('#url-input');
    input.value = 'https://unsaved.example';
    $<HTMLInputElement>('#token-input').value = 'tk_synthetic_unsaved';
    $('#back-btn').click();
    expect($('#settings-view').classList.contains('active')).toBe(true);
    expect(input.value).toBe('https://unsaved.example');
    $('#back-btn').click();
    expect($('#settings-view').classList.contains('active')).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await fakeBrowser.storage.sync.get('apiUrl')).toEqual({ apiUrl: 'https://ntfy.example' });
    expect(await fakeBrowser.storage.local.get('accessToken')).toEqual({ accessToken: 'tk_x' });
  });

  it('saves a theme change without restoring stale topics or authentication', async () => {
    await openPopup('?mode=page');
    await openSettings();
    await fakeBrowser.storage.sync.set({ topics: 'alerts,inbox,new-topic' });
    await fakeBrowser.storage.local.set({ accessToken: 'tk_synthetic_rotated' });
    $('.chip[data-theme="dark"]').click();
    await vi.waitFor(async () =>
      expect(await fakeBrowser.storage.sync.get(['theme', 'topics'])).toEqual({
        theme: 'dark',
        topics: 'alerts,inbox,new-topic',
      }),
    );
    expect(await fakeBrowser.storage.local.get('accessToken')).toEqual({ accessToken: 'tk_synthetic_rotated' });
  });

  it('requires an explicit server save and refuses to overwrite a newer connection', async () => {
    await openPopup();
    await openSettings();
    const input = $<HTMLInputElement>('#url-input');
    input.value = 'https://partial.example';
    input.dispatchEvent(new Event('input'));
    $('.chip[data-theme="dark"]').click();
    await flush();
    expect(await fakeBrowser.storage.sync.get('apiUrl')).toEqual({ apiUrl: 'https://ntfy.example' });
    expect(await fakeBrowser.storage.local.get('authOrigins')).toEqual({ authOrigins: ['https://ntfy.example'] });
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://changed.example' });
    $('#save-server-settings').click();
    await vi.waitFor(() => expect($('#settings-status').textContent).toContain('changed in another view'));
    expect(await fakeBrowser.storage.sync.get('apiUrl')).toEqual({ apiUrl: 'https://changed.example' });
    expect(await fakeBrowser.storage.local.get('authOrigins')).toEqual({ authOrigins: ['https://ntfy.example'] });
  });

  it('asks for access to the server when a token is set and access is missing', async () => {
    mockResolved(fakeBrowser.permissions, 'contains', false);
    await openPopup();
    expect($('#settings-btn').classList.contains('highlight')).toBe(true);
    await openSettings();
    await flush();
    expect($('#server-access-btn').style.display).toBe('');

    const request = mockResolved(fakeBrowser.permissions, 'request', true);
    $('#server-access-btn').click();
    await flush();
    expect(request).toHaveBeenCalledWith({ origins: ['https://ntfy.example/*'] });
  });

  it('asks for access to both the main and the fallback server', async () => {
    await fakeBrowser.storage.sync.set({ fallbackUrl: 'https://ntfy.lan:8080' });
    mockResolved(fakeBrowser.permissions, 'contains', false);
    await openPopup();
    await openSettings();
    await flush();
    expect($<HTMLInputElement>('#fallback-url-input').value).toBe('https://ntfy.lan:8080');
    const request = mockResolved(fakeBrowser.permissions, 'request', true);
    $('#server-access-btn').click();
    await flush();
    expect(request).toHaveBeenCalledWith({ origins: ['https://ntfy.example/*', 'https://ntfy.lan/*'] });
  });

  it('moves user:password@ from a typed URL into the username and password, kept locally', async () => {
    await openPopup();
    await openSettings();
    await flush();
    const url = $<HTMLInputElement>('#url-input');
    url.value = 'https://alice:s%40cret@ntfy.lan';
    url.dispatchEvent(new Event('input'));
    $('#save-server-settings').click();
    await vi.waitFor(async () => expect(await fakeBrowser.storage.sync.get('apiUrl')).toEqual({ apiUrl: 'https://ntfy.lan' }), {
      timeout: 3000,
    });

    expect(url.value).toBe('https://ntfy.lan');
    expect($<HTMLInputElement>('#username-input').value).toBe('alice');
    expect($<HTMLInputElement>('#password-input').value).toBe('s@cret');
    expect($<HTMLInputElement>('#password-input').type).toBe('password');
    expect(await fakeBrowser.storage.local.get('serverCredentials')).toEqual({
      serverCredentials: { username: 'alice', password: 's@cret' },
    });
    expect(JSON.stringify(await fakeBrowser.storage.sync.get(null))).not.toContain('cret');
  });

  it.each([
    ['#url-input', 'https://example-user:dummy-text@'],
    ['#fallback-url-input', 'example-user:dummy-text@ntfy.example'],
  ])('keeps an invalid URL edit in %s out of sync storage', async (selector, value) => {
    await openPopup();
    await openSettings();
    const before = await fakeBrowser.storage.sync.get(null);
    const input = $<HTMLInputElement>(selector);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    $('#save-server-settings').click();
    await vi.waitFor(() => expect($('#settings-status').textContent).toContain('Enter a complete'), { timeout: 3000 });
    expect(await fakeBrowser.storage.sync.get(null)).toEqual(before);
  });

  it('asks for server access with a username and password, without a token', async () => {
    await fakeBrowser.storage.local.set({ accessToken: '', serverCredentials: { username: 'alice', password: 'secret' } });
    mockResolved(fakeBrowser.permissions, 'contains', false);
    await openPopup();
    await openSettings();
    await flush();
    expect($<HTMLInputElement>('#username-input').value).toBe('alice');
    expect($('#server-access-btn').style.display).toBe('');
  });

  it('opens the server in a tab without userinfo, a query string or a fragment', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://alice:synthetic@ntfy.example?auth=synthetic#synthetic' });
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    await openPopup();
    $('#open-url-btn').click();
    await flush();
    expect(create.mock.calls).toEqual([[{ url: 'https://ntfy.example/inbox' }]]);
  });

  it('drops the query from a server URL typed in settings before syncing it', async () => {
    await openPopup();
    await openSettings();
    const input = $<HTMLInputElement>('#url-input');
    input.value = 'https://ntfy.lan?auth=synthetic#synthetic';
    input.dispatchEvent(new Event('input'));
    $('#save-server-settings').click();
    await vi.waitFor(async () => expect(await fakeBrowser.storage.sync.get('apiUrl')).toEqual({ apiUrl: 'https://ntfy.lan' }), {
      timeout: 3000,
    });
    expect(input.value).toBe('https://ntfy.lan');
  });

  it('rejects a malformed topic typed in settings', async () => {
    await openPopup();
    await openSettings();
    const input = $<HTMLInputElement>('#new-topic-input');
    input.value = 'alerts/publish?message=synthetic#';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect($('#settings-status').textContent).toContain('Use up to 64');
    expect(await fakeBrowser.storage.sync.get('topics')).toEqual({ topics: 'alerts,coolify,inbox' });
  });

  it('holds back the token from a server changed through sync, until confirmed (security review #1)', async () => {
    await import('@/utils/ntfy').then((ntfy) => ntfy.getConfig()); // approves https://ntfy.example
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://evil.example' });
    await openPopup();
    await openSettings();
    await flush();
    expect($('#held-back-box').style.display).toBe('');
    expect($('#held-back-text').textContent).toContain('https://evil.example');

    // Saving another setting doesn't approve the changed server
    $<HTMLButtonElement>('.chip[data-theme="dark"]').click();
    await flush();
    expect(await fakeBrowser.storage.local.get('authOrigins')).toEqual({ authOrigins: ['https://ntfy.example'] });

    $('#held-back-btn').click();
    await flush();
    expect(await fakeBrowser.storage.local.get('authOrigins')).toEqual({ authOrigins: ['https://evil.example'] });
    expect($('#held-back-box').style.display).toBe('none');
  });

  it('sends without the token while it is held back', async () => {
    await import('@/utils/ntfy').then((ntfy) => ntfy.getConfig());
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://evil.example' });
    await openPopup();
    $<HTMLTextAreaElement>('#message-input').value = 'hi';
    $('#send-btn').click();
    await vi.waitFor(() => expect(requests.some((r) => r.url === 'https://evil.example/inbox')).toBe(true));
    expect(requests.find((r) => r.url === 'https://evil.example/inbox')?.headers.has('Authorization')).toBe(false);
  });

  it('warns when credentials would go over http:// (security review #5)', async () => {
    await openPopup();
    await openSettings();
    await flush();
    const url = $<HTMLInputElement>('#url-input');
    expect($('#insecure-warning').style.display).toBe('none');
    url.value = 'http://192.168.2.38:8080';
    url.dispatchEvent(new Event('input'));
    expect($('#insecure-warning').style.display).toBe('');

    const token = $<HTMLInputElement>('#token-input');
    token.value = '';
    token.dispatchEvent(new Event('input'));
    expect($('#insecure-warning').style.display).toBe('none');
  });

  it('saves the token to local storage, not sync', async () => {
    await openPopup();
    await openSettings();
    await flush();
    const token = $<HTMLInputElement>('#token-input');
    token.value = 'tk_new';
    token.dispatchEvent(new Event('input'));
    $('#save-server-settings').click();
    await vi.waitFor(async () => expect(await fakeBrowser.storage.local.get('accessToken')).toEqual({ accessToken: 'tk_new' }), {
      timeout: 3000,
    });
    expect(await fakeBrowser.storage.sync.get('accessToken')).toEqual({});
  });

  it('sets a desktop notification rule per topic, and drops the rule of a removed topic', async () => {
    await openPopup();
    await openSettings();
    await flush();
    const selects = [...document.querySelectorAll<HTMLSelectElement>('#topic-settings-rows td:nth-child(3) select')];
    expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual([
      'Desktop notifications for alerts',
      'Desktop notifications for coolify',
      'Desktop notifications for inbox',
    ]);
    expect(selects.every((select) => select.value === 'all')).toBe(true);

    selects[1]!.value = 'off';
    selects[1]!.dispatchEvent(new Event('change'));
    selects[0]!.value = 'high';
    selects[0]!.dispatchEvent(new Event('change'));
    await flush();
    expect(await fakeBrowser.storage.sync.get('notifyRules')).toEqual({});
    $('#apply-topic-settings').click();
    await flush();
    expect(await fakeBrowser.storage.sync.get('notifyRules')).toEqual({
      notifyRules: [
        ['alerts', 'high'],
        ['coolify', 'off'],
      ],
    });

    // Remove "alerts" (the first topic badge)
    $('.topic-remove').click();
    await flush();
    expect(await fakeBrowser.storage.sync.get('notifyRules')).toEqual({ notifyRules: [['coolify', 'off']] });
  });

  it('loads and saves message sync modes per topic', async () => {
    await fakeBrowser.storage.sync.set({ syncDeletionTopics: ['coolify'] });
    await openPopup();
    await openSettings();
    const selects = [...document.querySelectorAll<HTMLSelectElement>('#topic-settings-rows td:nth-child(2) select')];
    expect(selects.map((select) => [select.getAttribute('aria-label'), select.value])).toEqual([
      ['Message sync for alerts', 'keep'],
      ['Message sync for coolify', 'sync'],
      ['Message sync for inbox', 'keep'],
    ]);

    selects[0]!.value = 'sync';
    selects[0]!.dispatchEvent(new Event('change'));
    await flush();
    expect(await fakeBrowser.storage.sync.get('syncDeletionTopics')).toEqual({ syncDeletionTopics: ['coolify'] });
    $('#apply-topic-settings').click();
    await flush();
    expect(await fakeBrowser.storage.sync.get('syncDeletionTopics')).toEqual({ syncDeletionTopics: ['coolify', 'alerts'] });

    $('.topic-remove').click();
    await flush();
    expect(await fakeBrowser.storage.sync.get('syncDeletionTopics')).toEqual({ syncDeletionTopics: ['coolify'] });
  });

  it('stages send defaults per topic until Apply, and drops them with a removed topic', async () => {
    await fakeBrowser.storage.sync.set({ topicSendDefaults: [{ topic: 'coolify', priority: 4, tags: ['deploy'] }] });
    await openPopup();
    await openSettings();
    await flush();
    const priorities = () => [...document.querySelectorAll<HTMLSelectElement>('#topic-settings-rows td:nth-child(4) select')];
    const tagFields = () => [...document.querySelectorAll<HTMLInputElement>('#topic-settings-rows td:nth-child(5) input')];
    const stored = async () => (await fakeBrowser.storage.sync.get('topicSendDefaults')).topicSendDefaults;
    expect(priorities().map((select) => [select.getAttribute('aria-label'), select.value])).toEqual([
      ['Send priority for alerts', ''],
      ['Send priority for coolify', '4'],
      ['Send priority for inbox', ''],
    ]);
    expect(tagFields().map((input) => [input.getAttribute('aria-label'), input.value, input.disabled])).toEqual([
      ['Send tags for alerts', '', true],
      ['Send tags for coolify', 'deploy', false],
      ['Send tags for inbox', '', true],
    ]);
    expect([...priorities()[0]!.options].map((option) => option.textContent)).toEqual([
      'Last used',
      'Min',
      'Low',
      'Default',
      'High',
      'Urgent',
    ]);
    expect($<HTMLButtonElement>('#apply-topic-settings').disabled).toBe(true);

    priorities()[0]!.value = '5';
    priorities()[0]!.dispatchEvent(new Event('change'));
    expect(tagFields()[0]!.disabled).toBe(false);
    tagFields()[0]!.value = ' warning, server ,, warning';
    tagFields()[0]!.dispatchEvent(new Event('input'));
    priorities()[1]!.value = '';
    priorities()[1]!.dispatchEvent(new Event('change'));
    expect(tagFields()[1]!.disabled).toBe(true);
    expect($<HTMLButtonElement>('#apply-topic-settings').disabled).toBe(false);
    await flush();
    expect(await stored()).toEqual([{ topic: 'coolify', priority: 4, tags: ['deploy'] }]);

    $('#apply-topic-settings').click();
    await vi.waitFor(() => expect($('#topic-settings-status').textContent).toBe('Applied.'));
    expect(await stored()).toEqual([{ topic: 'alerts', priority: 5, tags: ['warning', 'server'] }]);
    expect(tagFields()[0]!.value).toBe('warning, server');
    expect($<HTMLButtonElement>('#apply-topic-settings').disabled).toBe(true);
    // Other per-topic settings were not invented along the way
    expect(await fakeBrowser.storage.sync.get(['notifyRules', 'syncDeletionTopics'])).toEqual({ notifyRules: [], syncDeletionTopics: [] });

    // Remove "alerts" (the first topic badge)
    $('.topic-remove').click();
    await vi.waitFor(async () => expect(await stored()).toEqual([]));
  });

  it('undoes a staged send default that is set back to the saved one, and leaves the others alone on Apply', async () => {
    await fakeBrowser.storage.sync.set({ topicSendDefaults: [{ topic: 'coolify', priority: 4, tags: ['deploy'] }] });
    await openPopup();
    await openSettings();
    await flush();
    const priority = $<HTMLSelectElement>('#topic-settings-rows tr:nth-child(2) td:nth-child(4) select');
    priority.value = '1';
    priority.dispatchEvent(new Event('change'));
    expect($<HTMLButtonElement>('#apply-topic-settings').disabled).toBe(false);
    priority.value = '4';
    priority.dispatchEvent(new Event('change'));
    expect($<HTMLButtonElement>('#apply-topic-settings').disabled).toBe(true);

    // Applying a rule only doesn't rewrite the send defaults (another view may be editing them)
    const set = vi.spyOn(fakeBrowser.storage.sync, 'set');
    const rule = $<HTMLSelectElement>('#topic-settings-rows td:nth-child(3) select');
    rule.value = 'off';
    rule.dispatchEvent(new Event('change'));
    $('#apply-topic-settings').click();
    await vi.waitFor(() => expect($('#topic-settings-status').textContent).toBe('Applied.'));
    expect(set.mock.calls.flatMap(([items]) => Object.keys(items))).not.toContain('topicSendDefaults');
  });

  it('applies new send defaults to the Send form at once', async () => {
    await openPopup('?mode=page');
    await openSettings();
    await flush();
    const priority = $<HTMLSelectElement>('#topic-settings-rows tr:nth-child(3) td:nth-child(4) select'); // inbox, the send topic
    priority.value = '4';
    priority.dispatchEvent(new Event('change'));
    $('#apply-topic-settings').click();
    await vi.waitFor(() => expect($('#topic-settings-status').textContent).toBe('Applied.'));
    expect($('#priority-chips .chip.active').dataset.priority).toBe('4');
  });

  const select = (id: string) => $<HTMLSelectElement>(id);
  const choose = (id: string, value: string) => {
    select(id).value = value;
    select(id).dispatchEvent(new Event('change'));
  };
  const PREFERENCES = ['badgeScope', 'keepUrgentOnScreen', 'historyPerTopic', 'messageTimes', 'inboxDensity'];

  it('groups the settings under headings', async () => {
    await openPopup();
    await openSettings();
    const headings = [...document.querySelectorAll('#settings-view .settings-section > h2')].map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Server',
      'Topics',
      'Notifications',
      'Inbox',
      'Sending',
      'Appearance and layout',
      'Keyboard shortcuts',
      'Backup',
    ]);
    for (const section of document.querySelectorAll('#settings-view .settings-section')) {
      expect(document.getElementById(section.getAttribute('aria-labelledby')!)?.tagName).toBe('H2');
    }
    for (const control of document.querySelectorAll<HTMLSelectElement>('#settings-view select.form-select')) {
      expect(document.querySelector(`label[for="${control.id}"]`)?.textContent).toBeTruthy();
    }
  });

  it('shows the defaults, and the default in place of an invalid stored value', async () => {
    await fakeBrowser.storage.sync.set({ badgeScope: 7, historyPerTopic: 99, messageTimes: 'iso', inboxDensity: 'compact' });
    await openPopup();
    expect(document.body.dataset.density).toBe('compact');
    await openSettings();
    expect(select('#badge-scope-select').value).toBe('all');
    expect($<HTMLInputElement>('#keep-urgent-checkbox').checked).toBe(true);
    expect(select('#history-limit-select').value).toBe('100');
    expect(select('#message-times-select').value).toBe('relative');
    expect(select('#density-select').value).toBe('compact');
    expect([...select('#history-limit-select').options].map((option) => option.value)).toEqual(['50', '100', '250', '500']);
  });

  it('saves only the preference each control edits', async () => {
    await openPopup();
    await openSettings();
    const set = vi.spyOn(fakeBrowser.storage.sync, 'set');
    choose('#badge-scope-select', 'notifying');
    $<HTMLInputElement>('#keep-urgent-checkbox').click();
    choose('#history-limit-select', '500');
    choose('#message-times-select', 'absolute');
    choose('#density-select', 'compact');
    await flush();
    expect(set.mock.calls.map(([items]) => items)).toEqual([
      { badgeScope: 'notifying' },
      { keepUrgentOnScreen: false },
      { historyPerTopic: 500 },
      { messageTimes: 'absolute' },
      { inboxDensity: 'compact' },
    ]);
    expect(await fakeBrowser.storage.sync.get(['topics', 'apiUrl'])).toEqual({
      apiUrl: 'https://ntfy.example',
      topics: 'alerts,coolify,inbox',
    });
  });

  it('restores the control and reports it when a preference cannot be saved', async () => {
    await openPopup();
    await openSettings();
    vi.spyOn(fakeBrowser.storage.sync, 'set').mockRejectedValueOnce(new Error('quota'));
    choose('#density-select', 'compact');
    await vi.waitFor(() => expect($('#settings-status').textContent).toBe('Failed to save settings'));
    expect(select('#density-select').value).toBe('comfortable');
    expect(document.body.dataset.density).toBe('comfortable');
  });

  it('shows message times as the local date and time when set so, also for a recent message', async () => {
    const recent = message('recent', 'alerts', 5);
    await fakeBrowser.storage.local.set({ receivedNotifications: [recent] });
    await openPopup();
    expect($('.notification-time').textContent).toBe('alerts · 5m ago');
    expect(document.body.dataset.density).toBe('comfortable');

    await openSettings();
    choose('#message-times-select', 'absolute');
    const absolute = new Date(recent.time * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    await vi.waitFor(() => expect($('.notification-time').textContent).toBe(`alerts · ${absolute}`));
    expect(absolute).toContain(String(new Date(recent.time * 1000).getFullYear()));
  });

  it('follows preferences changed in another view or through sync, without a reload', async () => {
    await fakeBrowser.storage.local.set({ receivedNotifications: [message('recent', 'alerts', 5)] });
    await openPopup('?mode=page');
    await fakeBrowser.storage.sync.set({ inboxDensity: 'compact', messageTimes: 'absolute', historyPerTopic: 250 });
    await vi.waitFor(() => expect(document.body.dataset.density).toBe('compact'));
    await vi.waitFor(() => expect($('.notification-time').textContent).not.toContain('ago'));
    expect(select('#history-limit-select').value).toBe('250');
    expect(select('#density-select').value).toBe('compact');

    // An invalid value, and a removed key, read as the defaults
    await fakeBrowser.storage.sync.set({ inboxDensity: 'tiny' });
    await fakeBrowser.storage.sync.remove(['messageTimes', 'historyPerTopic']);
    await vi.waitFor(() => expect(document.body.dataset.density).toBe('comfortable'));
    await vi.waitFor(() => expect($('.notification-time').textContent).toBe('alerts · 5m ago'));
    expect(select('#history-limit-select').value).toBe('100');
    expect(await fakeBrowser.storage.sync.get(PREFERENCES)).toEqual({ inboxDensity: 'tiny' }); // reading never writes
  });

  it('keeps the inbox counts of every topic whatever the badge counts', async () => {
    await fakeBrowser.storage.sync.set({ badgeScope: 'notifying', notifyRules: [['coolify', 'off']] });
    await fakeBrowser.storage.local.set({ receivedNotifications: [message('a1', 'alerts', 2), message('c1', 'coolify', 3)] });
    await openPopup();
    const sidebar = [...document.querySelectorAll('.topic-filter-btn')].map((button) => button.textContent);
    expect(sidebar).toEqual(['All topics2', 'alerts1', 'coolify🔕1', 'inbox']);
  });

  it('hides the keep-on-screen setting in Firefox, which has no such notification option', async () => {
    await openPopup();
    expect($('#keep-urgent-group').hidden).toBe(false);

    vi.resetModules();
    document.body.innerHTML = body;
    vi.stubEnv('BROWSER', 'firefox');
    try {
      await openPopup();
      expect($('#keep-urgent-group').hidden).toBe(true);
      expect($('#badge-scope-select').closest<HTMLElement>('.form-group')!.hidden).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lists the keyboard shortcuts and opens the browser page that changes them', async () => {
    const getAll = mockResolved(fakeBrowser.commands, 'getAll', [
      { name: '_execute_action', description: '', shortcut: 'Alt+Shift+N' },
      { name: 'send-page', description: 'Send this page to ntfy', shortcut: '' },
    ]);
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    await openPopup('?mode=page');
    await openSettings();
    await flush();
    const rows = () =>
      [...document.querySelectorAll('#shortcut-list dt')].map((name) => [name.textContent, name.nextElementSibling?.textContent]);
    expect(rows()).toEqual([
      ['Open ntfy Desk', 'Alt+Shift+N'],
      ['Send this page to ntfy', 'Not set'],
    ]);
    expect($('#shortcut-list kbd').textContent).toBe('Alt+Shift+N');

    $('#shortcut-settings-btn').click();
    await flush();
    expect(create.mock.calls).toEqual([[{ url: 'chrome://extensions/shortcuts' }]]);

    // Back from the browser's page with a new binding
    getAll.mockResolvedValue([{ name: 'send-page', description: 'Send this page to ntfy', shortcut: 'Ctrl+Shift+U' }]);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(rows()).toEqual([['Send this page to ntfy', 'Ctrl+Shift+U']]));
  });

  it('says where the shortcut settings are when the browser cannot open them', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockRejectedValue(new Error('blocked') as never);
    await openPopup('?mode=page');
    await openSettings();
    expect($('#shortcut-list').children).toHaveLength(0); // the fake browser reports no bindings
    $('#shortcut-settings-btn').click();
    await vi.waitFor(() => expect($('#shortcut-hint').textContent).toContain('chrome://extensions/shortcuts'));
  });

  it('marks topics with notifications off in the Receive tab', async () => {
    await fakeBrowser.storage.sync.set({ notifyRules: [['coolify', 'off']] });
    await openPopup('?tab=receive');
    const coolify = [...document.querySelectorAll('.topic-filter-btn')].find((b) => b.textContent?.startsWith('coolify'))!;
    expect(coolify.querySelector('.topic-muted')?.textContent).toBe('🔕');
  });
});

describe('settings: tabs and links', () => {
  const TABS = ['server', 'topics', 'messages', 'appearance', 'more'];
  const tab = (key: string) => $<HTMLButtonElement>(`#settings-tab-${key}`);
  const panel = (key: string) => $(`#settings-panel-${key}`);
  const selectedTab = () => TABS.filter((key) => tab(key).getAttribute('aria-selected') === 'true');
  const shownPanels = () => TABS.filter((key) => !panel(key).hidden);

  /** One tab selected and in the Tab order, its panel the only one shown */
  function expectShown(key: string): void {
    expect(selectedTab()).toEqual([key]);
    expect(shownPanels()).toEqual([key]);
    for (const other of TABS) {
      expect(tab(other).getAttribute('aria-selected')).toBe(String(other === key));
      expect(tab(other).tabIndex).toBe(other === key ? 0 : -1);
    }
  }

  function press(key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    return event;
  }

  it('puts every group of settings on one of five tabs', async () => {
    await openPopup();
    await openSettings();
    const tablist = $('#settings-tabs');
    expect(tablist.getAttribute('role')).toBe('tablist');
    expect(tablist.getAttribute('aria-label')).toBe('Settings categories');
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((button) => button.textContent.trim())).toEqual(['Server', 'Topics', 'Messages', 'Appearance', 'More']);
    expect(tabs.map((button) => button.dataset.tab)).toEqual(TABS);
    for (const key of TABS) {
      expect(tab(key).type).toBe('button');
      expect(tab(key).getAttribute('aria-controls')).toBe(panel(key).id);
      expect(panel(key).getAttribute('role')).toBe('tabpanel');
      expect(panel(key).getAttribute('aria-labelledby')).toBe(tab(key).id);
    }
    const headings = (key: string) => [...panel(key).querySelectorAll('.settings-section > h2')].map((heading) => heading.textContent);
    expect(Object.fromEntries(TABS.map((key) => [key, headings(key)]))).toEqual({
      server: ['Server'],
      topics: ['Topics'],
      messages: ['Notifications', 'Inbox', 'Sending'],
      appearance: ['Appearance and layout'],
      more: ['Keyboard shortcuts', 'Backup'],
    });
    // No group is left outside the tabs; the status line and the links are, so every tab shows them
    for (const section of document.querySelectorAll('#settings-view .settings-section')) {
      expect(section.closest('.settings-panel')).not.toBeNull();
    }
    expect($('#settings-status').closest('.settings-panel')).toBeNull();
    expect($('.settings-links').closest('.settings-panel')).toBeNull();
    expect($('#topic-settings-rows').closest('.settings-panel')).toBe(panel('topics'));
  });

  it('shows one tab at a time, selected with a click', async () => {
    await openPopup();
    await openSettings();
    expectShown('server');
    for (const key of ['topics', 'messages', 'appearance', 'more', 'server']) {
      tab(key).click();
      expectShown(key);
    }
  });

  it('moves between the tabs with the arrow keys, Home and End, focus following', async () => {
    await openPopup();
    await openSettings();
    tab('server').focus();
    const steps: [string, string][] = [
      ['ArrowRight', 'topics'],
      ['ArrowRight', 'messages'],
      ['ArrowRight', 'appearance'],
      ['ArrowRight', 'more'],
      ['ArrowRight', 'server'],
      ['ArrowLeft', 'more'],
      ['ArrowLeft', 'appearance'],
      ['Home', 'server'],
      ['End', 'more'],
    ];
    for (const [key, expected] of steps) {
      expect(press(key).defaultPrevented).toBe(true);
      expectShown(expected);
      expect(document.activeElement).toBe(tab(expected));
    }
    // Other keys are left to the browser
    for (const key of ['ArrowDown', 'a', 'Tab']) {
      expect(press(key).defaultPrevented).toBe(false);
      expectShown('more');
    }
    // Arrow keys in a field of a panel don't switch tabs
    tab('server').click();
    $('#url-input').focus();
    expect(press('ArrowRight').defaultPrevented).toBe(false);
    expect(press('End').defaultPrevented).toBe(false);
    expectShown('server');
  });

  it('keeps what was typed and staged in a tab while another one is shown', async () => {
    await openPopup();
    await openSettings();
    $<HTMLInputElement>('#url-input').value = 'https://typed.example';
    $<HTMLInputElement>('#token-input').value = 'tk_synthetic_typed';
    tab('topics').click();
    $<HTMLInputElement>('#new-topic-input').value = 'half-typed';
    const rule = $<HTMLSelectElement>('[aria-label="Desktop notifications for alerts"]');
    rule.value = 'off';
    rule.dispatchEvent(new Event('change'));
    expect($<HTMLButtonElement>('#apply-topic-settings').disabled).toBe(false);

    for (const key of ['messages', 'appearance', 'more', 'server']) tab(key).click();
    expectShown('server');
    expect($<HTMLInputElement>('#url-input').value).toBe('https://typed.example');
    expect($<HTMLInputElement>('#token-input').value).toBe('tk_synthetic_typed');
    tab('topics').click();
    expect($<HTMLInputElement>('#new-topic-input').value).toBe('half-typed');
    expect($<HTMLSelectElement>('[aria-label="Desktop notifications for alerts"]')).toBe(rule);
    expect(rule.value).toBe('off');
    expect($<HTMLButtonElement>('#apply-topic-settings').disabled).toBe(false);
    // Nothing was saved by switching
    expect(await fakeBrowser.storage.sync.get(['apiUrl', 'notifyRules'])).toEqual({ apiUrl: 'https://ntfy.example' });

    // Staged in one tab, applied after a visit to another; the server fields are saved from their own tab
    $('#apply-topic-settings').click();
    await vi.waitFor(() => expect($('#topic-settings-status').textContent).toBe('Applied.'));
    expect(await fakeBrowser.storage.sync.get('notifyRules')).toEqual({ notifyRules: [['alerts', 'off']] });
    expect($<HTMLInputElement>('#url-input').value).toBe('https://typed.example');
  });

  it('reopens Settings on the tab used last', async () => {
    await openPopup();
    await openSettings();
    tab('appearance').click();
    $('#back-btn').click();
    expect($('#settings-view').classList.contains('active')).toBe(false);
    await openSettings();
    expectShown('appearance');
    expect(document.activeElement).toBe($('#back-btn'));
    for (const key of TABS) {
      expect(tab(key).classList.contains('attention')).toBe(false);
      expect(tab(key).hasAttribute('aria-describedby')).toBe(false);
    }
  });

  it('opens Settings on Server, and marks that tab, while the credentials are held back', async () => {
    await import('@/utils/ntfy').then((ntfy) => ntfy.getConfig()); // approves https://ntfy.example
    await openPopup();
    await openSettings();
    tab('appearance').click();
    $('#back-btn').click();

    await fakeBrowser.storage.sync.set({ apiUrl: 'https://evil.example' });
    await openSettings();
    expectShown('server');
    expect($('#held-back-box').style.display).toBe('');
    expect(tab('server').classList.contains('attention')).toBe(true);
    expect(tab('server').getAttribute('aria-describedby')).toBe('settings-tab-attention');
    expect($('#settings-tab-attention').textContent).toBe('Needs attention');
    expect($('#settings-tab-attention').hidden).toBe(true);
    expect(tab('topics').classList.contains('attention')).toBe(false);

    // The mark stays while another tab is open, and goes with the confirmation
    tab('more').click();
    expect(tab('server').classList.contains('attention')).toBe(true);
    tab('server').click();
    $('#held-back-btn').click();
    await vi.waitFor(() => expect(tab('server').classList.contains('attention')).toBe(false));
    expect(tab('server').hasAttribute('aria-describedby')).toBe(false);
    expect(tab('server').textContent.trim()).toBe('Server');
  });

  it('opens Settings on Server when server access is missing or no server is set', async () => {
    mockResolved(fakeBrowser.permissions, 'contains', false);
    await openPopup();
    await openSettings();
    tab('messages').click();
    $('#back-btn').click();
    await openSettings();
    expectShown('server');
    expect(tab('server').classList.contains('attention')).toBe(true);

    mockResolved(fakeBrowser.permissions, 'contains', true);
    await fakeBrowser.storage.local.set({ accessToken: '' });
    await fakeBrowser.storage.sync.set({ apiUrl: '', topics: '' });
    tab('messages').click();
    $('#back-btn').click();
    await openSettings();
    expectShown('server');
    // Nothing set up yet: the server is missing under Server, the topics under Topics
    expect(TABS.filter((key) => tab(key).classList.contains('attention'))).toEqual(['server', 'topics']);
    expect($('#settings-btn').classList.contains('highlight')).toBe(true);

    // A topic added: the Topics mark goes, the Server one stays
    tab('topics').click();
    const input = $<HTMLInputElement>('#new-topic-input');
    input.value = 'alerts';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(TABS.filter((key) => tab(key).classList.contains('attention'))).toEqual(['server']));
    expectShown('topics');
  });

  it('opens the More tab from the backup link, whichever tab was open', async () => {
    await openPopup('?mode=page');
    location.hash = 'settings=backup&focus=1';
    window.dispatchEvent(new Event('hashchange'));
    await vi.waitFor(() => expect($('#settings-view').classList.contains('active')).toBe(true));
    await vi.waitFor(() => expect(document.activeElement).toBe($('#import-settings-btn')));
    expectShown('more');
    expect($('#settings-backup').closest('.settings-panel')).toBe(panel('more'));

    tab('topics').click();
    location.hash = 'settings=backup&focus=2';
    window.dispatchEvent(new Event('hashchange'));
    await vi.waitFor(() => expect(document.activeElement).toBe($('#import-settings-btn')));
    expectShown('more');
    location.hash = '';
  });

  it('links to the repository, the website and the issues, each in a new tab', async () => {
    await openPopup();
    await openSettings();
    const nav = $('nav.settings-links');
    expect(nav.getAttribute('aria-label')).toBe('About ntfy Desk');
    const links = [...nav.querySelectorAll<HTMLAnchorElement>('a')];
    expect(
      links.map((link) => ({ text: link.textContent.trim(), name: link.getAttribute('aria-label'), href: link.getAttribute('href') })),
    ).toEqual([
      { text: 'GitHub', name: 'ntfy Desk on GitHub', href: 'https://github.com/valentindimitrov/ntfy-desk' },
      { text: 'Website', name: 'ntfy Desk website', href: 'https://ntfy-desk.minddevops.eu' },
      { text: 'Contact', name: 'Contact: ntfy Desk issues on GitHub', href: 'https://github.com/valentindimitrov/ntfy-desk/issues' },
    ]);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel.split(' ').toSorted()).toEqual(['noopener', 'noreferrer']);
      // The visible label is part of the accessible name (whatever the case); the icon is decoration
      expect(link.getAttribute('aria-label')?.toLowerCase()).toContain(link.textContent.trim().toLowerCase());
      expect(link.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
    }
    // Shown with every tab
    for (const key of TABS) {
      tab(key).click();
      expect(nav.closest('[hidden]')).toBeNull();
    }
  });
});

describe('settings: backup', () => {
  const backupFile = (settings: unknown, name = 'ntfy-desk-settings-2026-11-01.json', extra: Record<string, unknown> = {}) =>
    new File(
      [JSON.stringify({ format: 'ntfy-desk-settings', version: 1, exportedAt: '2026-11-01T10:00:00.000Z', settings, ...extra })],
      name,
      {
        type: 'application/json',
      },
    );

  /** The file dialog's result: the chosen file on the input, then its change event */
  async function pick(file: File): Promise<void> {
    const input = $<HTMLInputElement>('#import-settings-input');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    await flush();
  }

  const confirmLines = () => [...document.querySelectorAll('#import-confirm-list li')].map((line) => line.textContent);
  const IMPORTED = {
    apiUrl: 'https://imported.example',
    fallbackUrl: 'https://imported-fallback.example',
    topics: ['alerts', 'news'],
    notifyRules: [['news', 'off']],
    topicSendDefaults: [{ topic: 'news', priority: 2, tags: ['newspaper'] }],
    theme: 'dark',
    includeUrl: true,
    sendAnotherEnabled: true,
    historyPerTopic: 500,
    inboxDensity: 'compact',
    freezeDividers: true,
    lastTopic: 'news',
  };

  it('downloads the settings as a JSON file from the extension tab, without the token', async () => {
    await fakeBrowser.storage.local.set({ serverCredentials: { username: 'secret-user', password: 'secret-password' } });
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:settings';
    });
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    await openPopup('?mode=page');
    await openSettings();
    $('#export-settings-btn').click();
    await vi.waitFor(() => expect(clicked).toHaveLength(1));

    expect(clicked[0]).toEqual({ href: 'blob:settings', download: expect.stringMatching(/^ntfy-desk-settings-\d{4}-\d\d-\d\d\.json$/) });
    const text = await blobs[0]!.text();
    expect(blobs[0]!.type).toBe('application/json');
    expect(JSON.parse(text)).toMatchObject({
      format: 'ntfy-desk-settings',
      version: 1,
      settings: { apiUrl: 'https://ntfy.example', topics: ['alerts', 'coolify', 'inbox'], lastTopic: 'inbox' },
    });
    expect(text).not.toMatch(/tk_x|secret|accessToken|serverCredentials|authOrigins/);
    expect($('#settings-status').textContent).toMatch(/^Settings exported as ntfy-desk-settings-/);
    expect(document.querySelector('a[download]')).toBeNull();
    expect($('#backup-hint').textContent).toContain('never holds the token');
    expect($('#backup-hint').textContent).not.toContain('safe to share');
  });

  it('downloads from the toolbar popup too (Chromium), and sends the import to the extension tab', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:settings');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    mockResolved(fakeBrowser.runtime, 'getContexts', []);
    await openPopup();
    await openSettings();
    $('#export-settings-btn').click();
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(create).not.toHaveBeenCalled();
    expect(closed).toBe(false);

    // A file dialog would close the popup: the Backup group of the tab takes over
    $('#import-settings-btn').click();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(inputClick).not.toHaveBeenCalled();
    const [{ url }] = callsOf<[{ url: string }]>(create)[0]!;
    expect(url).toMatch(/\/popup\.html\?mode=page#settings=backup&focus=/);
  });

  it("hands the export to the extension tab from Firefox's toolbar popup", async () => {
    vi.stubEnv('BROWSER', 'firefox');
    try {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:settings');
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      const create = mockResolved(fakeBrowser.tabs, 'create', {});
      mockResolved(fakeBrowser.runtime, 'getContexts', []);
      await openPopup();
      await openSettings();
      $('#export-settings-btn').click();
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(click).not.toHaveBeenCalled();
      expect(callsOf<[{ url: string }]>(create)[0]![0].url).toMatch(/\/popup\.html\?mode=page#settings=backup&focus=/);

      // The tab can't be opened: the popup stays and says what to do
      closed = false;
      create.mockRejectedValue(new Error('blocked'));
      $('#export-settings-btn').click();
      await vi.waitFor(() => expect($('#settings-status').textContent).toContain('Could not open ntfy Desk in a tab'));
      expect(closed).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('opens the file dialog directly in the extension tab, and the Backup group from a link', async () => {
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    await openPopup('?mode=page');
    expect($('#settings-view').classList.contains('active')).toBe(false);
    location.hash = 'settings=backup&focus=1';
    window.dispatchEvent(new Event('hashchange'));
    await vi.waitFor(() => expect($('#settings-view').classList.contains('active')).toBe(true));
    await vi.waitFor(() => expect(document.activeElement).toBe($('#import-settings-btn')));

    // A link arriving again leaves a form in progress alone
    $<HTMLInputElement>('#url-input').value = 'https://typed.example';
    location.hash = 'settings=backup&focus=2';
    window.dispatchEvent(new Event('hashchange'));
    await flush();
    expect($<HTMLInputElement>('#url-input').value).toBe('https://typed.example');

    $('#import-settings-btn').click();
    expect(inputClick).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    location.hash = '';
  });

  it('shows what an import replaces and writes nothing until it is confirmed', async () => {
    await fakeBrowser.storage.local.set({ accessToken: '' });
    await openPopup('?mode=page');
    await openSettings();
    const before = await fakeBrowser.storage.sync.get();
    expect($('#import-confirm').hidden).toBe(true);
    await pick(backupFile(IMPORTED));

    expect($('#import-confirm').hidden).toBe(false);
    expect($('#import-confirm-title').textContent).toMatch(
      /^Replace the settings with those from ntfy-desk-settings-2026-11-01\.json, exported .*2026.*\?$/,
    );
    expect(confirmLines()).toEqual([
      'Server URL: https://imported.example (now https://ntfy.example)',
      'Fallback URL: https://imported-fallback.example (now none)',
      'Topics: 2 (now 3)',
      'All other settings are replaced too: topic settings, notifications, inbox, sending, appearance and layout. A setting the file lacks returns to its default.',
      'Your token and password stay as they are. Received messages are not part of the file.',
    ]);
    expect(await fakeBrowser.storage.sync.get()).toEqual(before);

    $('#import-cancel-btn').click();
    await flush();
    expect($('#import-confirm').hidden).toBe(true);
    expect(confirmLines()).toEqual([]);
    // Nothing is left to confirm
    $('#import-confirm-btn').click();
    await flush();
    expect(await fakeBrowser.storage.sync.get()).toEqual(before);
  });

  it('replaces the settings on confirmation and shows them in the form and the views at once', async () => {
    await fakeBrowser.storage.local.set({ accessToken: '' });
    await fakeBrowser.storage.sync.set({ notifyRules: [['coolify', 'off']], badgeScope: 'notifying', messageTimes: 'absolute' });
    await openPopup('?mode=page');
    await openSettings();
    // Server edits in progress don't survive the import either
    $<HTMLInputElement>('#url-input').value = 'https://typed.example';
    await pick(backupFile(IMPORTED));
    $('#import-confirm-btn').click();
    await vi.waitFor(() => expect($('#settings-status').textContent).toBe('Settings imported'));
    // The confirmation that had the focus is gone: it returns to the Import button
    expect(document.activeElement).toBe($('#import-settings-btn'));

    expect(await fakeBrowser.storage.sync.get()).toMatchObject({
      apiUrl: 'https://imported.example',
      fallbackUrl: 'https://imported-fallback.example',
      topics: 'alerts,news',
      notifyRules: [['news', 'off']],
      topicSendDefaults: [{ topic: 'news', priority: 2, tags: ['newspaper'] }],
      syncDeletionTopics: [],
      badgeScope: 'all',
      messageTimes: 'relative',
      historyPerTopic: 500,
      lastTopic: 'news',
    });
    expect($('#import-confirm').hidden).toBe(true);
    expect($<HTMLInputElement>('#url-input').value).toBe('https://imported.example');
    expect($<HTMLInputElement>('#fallback-url-input').value).toBe('https://imported-fallback.example');
    expect([...document.querySelectorAll('.topic-badge')].map((badge) => badge.firstChild?.textContent)).toEqual(['alerts', 'news']);
    expect($<HTMLSelectElement>('[aria-label="Desktop notifications for news"]').value).toBe('off');
    expect($<HTMLSelectElement>('[aria-label="Send priority for news"]').value).toBe('2');
    expect($<HTMLSelectElement>('#history-limit-select').value).toBe('500');
    expect($<HTMLSelectElement>('#badge-scope-select').value).toBe('all');
    expect($<HTMLInputElement>('#include-url-checkbox').checked).toBe(true);
    expect($<HTMLInputElement>('#send-another-checkbox').checked).toBe(true);
    expect($<HTMLInputElement>('#freeze-dividers-checkbox').checked).toBe(true);
    expect(document.body.dataset.theme).toBe('dark');
    expect(document.body.dataset.density).toBe('compact');

    // No stale form state: saving the server settings now keeps the imported servers
    $('#save-server-settings').click();
    await vi.waitFor(() => expect($('#settings-status').textContent).toBe('Server settings saved'));
    expect(await fakeBrowser.storage.sync.get(['apiUrl', 'fallbackUrl'])).toEqual({
      apiUrl: 'https://imported.example',
      fallbackUrl: 'https://imported-fallback.example',
    });

    // Back in the main view, the Send form offers the imported topics and the imported last topic
    vi.stubGlobal('confirm', () => true);
    $('#back-btn').click();
    await flush();
    const destination = $<HTMLSelectElement>('#topic-select');
    expect([...destination.options].map((option) => option.value)).toEqual(['alerts', 'news']);
    expect(destination.value).toBe('news');
  });

  it('holds the stored token back from an imported server until it is confirmed under Server', async () => {
    // The token is stored and this device never recorded approvals: the first-time approval must not apply
    expect(await fakeBrowser.storage.local.get()).toEqual({ accessToken: 'tk_x' });
    await openPopup('?mode=page');
    await fakeBrowser.storage.local.remove('authOrigins');
    await openSettings();
    $('#settings-tab-more').click();
    await pick(backupFile({ apiUrl: 'https://evil.example', topics: ['inbox'] }));
    expect(confirmLines()).toContain("Your token and password aren't sent to https://evil.example until you confirm that under Server.");
    $('#import-confirm-btn').click();
    await vi.waitFor(() =>
      expect($('#settings-status').textContent).toBe(
        'Settings imported. Confirm the server under Server before your token and password are used.',
      ),
    );
    expect($('#settings-status').className).toContain('warning');
    // The button that confirms the server is under Server: that tab opens, focus on the button
    expect($('#settings-tab-server').getAttribute('aria-selected')).toBe('true');
    expect($('#settings-panel-server').hidden).toBe(false);
    expect($('#settings-panel-more').hidden).toBe(true);
    expect(document.activeElement).toBe($('#held-back-btn'));
    expect($('#settings-tab-server').classList.contains('attention')).toBe(true);
    expect(await fakeBrowser.storage.local.get()).toEqual({ accessToken: 'tk_x', authOrigins: ['https://ntfy.example'] });
    expect($('#held-back-box').style.display).toBe('');
    expect($('#held-back-text').textContent).toContain('https://evil.example');
    expect($<HTMLInputElement>('#token-input').value).toBe('tk_x');

    // A send from this view goes out without the token
    vi.stubGlobal('confirm', () => true);
    $('#back-btn').click();
    await flush();
    $<HTMLTextAreaElement>('#message-input').value = 'hi';
    $('#send-btn').click();
    await vi.waitFor(() => expect(requests.some((r) => r.url === 'https://evil.example/inbox')).toBe(true));
    expect(requests.filter((r) => r.url.startsWith('https://evil.example')).some((r) => r.headers.has('Authorization'))).toBe(false);

    // The existing confirmation approves it
    await openSettings();
    $('#held-back-btn').click();
    await flush();
    expect(await fakeBrowser.storage.local.get('authOrigins')).toEqual({ authOrigins: ['https://evil.example'] });
  });

  it('names what a file holds that is not imported, and shows file text as text', async () => {
    await openPopup('?mode=page');
    await openSettings();
    await pick(
      backupFile(
        { apiUrl: 'https://user:pass@ntfy.example/?auth=x', topics: ['inbox', '<b>bold</b>'], theme: 'neon', historyPerTopic: 7 },
        '<img src=x onerror=alert(1)>.json',
      ),
    );
    expect($('#import-confirm-title').textContent).toContain('<img src=x onerror=alert(1)>.json');
    expect($('#import-confirm').querySelector('img, b')).toBeNull();
    expect(confirmLines().slice(0, 3)).toEqual([
      'Server URL: https://ntfy.example/ (now https://ntfy.example)',
      'Fallback URL: none (unchanged)',
      'Topics: 1 (now 3)',
    ]);
    expect(confirmLines().slice(-2)).toEqual([
      'A username, password, query string or fragment in a server URL of the file is ignored.',
      'Not valid in the file, so not imported: topics (1 invalid name), theme, messages kept per topic.',
    ]);
    // The same origin as the approved one: nothing is held back
    expect(confirmLines().join(' ')).not.toContain("aren't sent");
  });

  it('refuses a file that is not a settings file, without a confirmation', async () => {
    await openPopup('?mode=page');
    await openSettings();
    const before = await fakeBrowser.storage.sync.get();
    const refused: [File, string][] = [
      [new File(['not json'], 'notes.json'), 'This file is not valid JSON.'],
      [new File(['{"format":"other"}'], 'other.json'), 'This is not an ntfy Desk settings file.'],
      [backupFile({}, 'newer.json', { version: 2 }), 'This settings file was made by a newer version of ntfy Desk'],
      [new File(['x'.repeat(256 * 1024 + 1)], 'huge.json'), 'This file is too large to be an ntfy Desk settings file (over 256 KiB).'],
    ];
    for (const [file, text] of refused) {
      await pick(file);
      expect($('#settings-status').textContent).toContain(text);
      expect($('#settings-status').className).toContain('error');
      expect($('#import-confirm').hidden).toBe(true);
    }
    // A refused file replaces a confirmation that was waiting
    await pick(backupFile(IMPORTED));
    expect($('#import-confirm').hidden).toBe(false);
    await pick(new File(['[]'], 'list.json'));
    expect($('#import-confirm').hidden).toBe(true);
    $('#import-confirm-btn').click();
    await flush();
    expect(await fakeBrowser.storage.sync.get()).toEqual(before);
  });

  it('stops when the settings changed while the confirmation was open', async () => {
    await openPopup('?mode=page');
    await openSettings();
    await pick(backupFile(IMPORTED));
    await fakeBrowser.storage.sync.set({ topics: 'alerts,coolify,inbox,added' });
    $('#import-confirm-btn').click();
    await vi.waitFor(() =>
      expect($('#settings-status').textContent).toBe('The settings changed while the import was waiting. Choose the file again.'),
    );
    expect($('#import-confirm').hidden).toBe(true);
    expect(await fakeBrowser.storage.sync.get(['apiUrl', 'topics'])).toEqual({
      apiUrl: 'https://ntfy.example',
      topics: 'alerts,coolify,inbox,added',
    });
  });

  it('waits for the settings lock, so an import cannot interleave with another settings edit', async () => {
    await openPopup('?mode=page');
    await openSettings();
    await pick(backupFile(IMPORTED));
    let release = () => {};
    const held = navigator.locks.request('ntfy-settings', () => new Promise<void>((resolve) => (release = resolve)));
    await flush();
    $('#import-confirm-btn').click();
    await flush();
    expect(await fakeBrowser.storage.sync.get('apiUrl')).toEqual({ apiUrl: 'https://ntfy.example' });
    expect($<HTMLButtonElement>('#import-confirm-btn').disabled).toBe(true);
    release();
    await held;
    await vi.waitFor(() => expect($('#settings-status').textContent).toContain('Settings imported'));
    expect(await fakeBrowser.storage.sync.get('apiUrl')).toEqual({ apiUrl: 'https://imported.example' });
  });
});
