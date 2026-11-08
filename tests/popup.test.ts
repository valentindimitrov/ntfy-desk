// @vitest-environment happy-dom
// The real popup page (index.html + main.ts) against the fake browser.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { mockResolved, mockWebLocks } from './helpers/mock';
import { handlePopupRequest } from '@/utils/messages';
import type { NtfyMessage } from '@/utils/ntfy';

// Vitest runs from the project root
const html = readFileSync(resolve('entrypoints/popup/index.html'), 'utf8');
const bodyStart = html.indexOf('>', html.indexOf('<body')) + 1;
const body = html.slice(bodyStart, html.indexOf('</body>')).replace(/<script[^>]*><\/script>/g, '');

let requests: { url: string; headers: Headers; body: unknown }[];
let closed: boolean;

const message = (id: string, topic: string, minutesAgo: number, extra: Partial<NtfyMessage> = {}): NtfyMessage => ({
  id,
  event: 'message',
  topic,
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

  it('distinguishes a topic named all from the legacy All topics filter', async () => {
    await fakeBrowser.storage.sync.set({ topics: 'all,inbox' });
    await fakeBrowser.storage.local.set({ receiveTopicFilter: 'all' });
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
    await fakeBrowser.storage.local.set({ receiveTopicFilter: 'coolify' });
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
    await fakeBrowser.storage.local.set({ receiveTopicFilter: 'inbox' });
    await openPopup('?tab=receive');
    expect($('.notifications-empty').textContent).toBe('No recent notifications');
    expect($('#notifications-control-bar').style.visibility).toBe('hidden');
  });
});

describe('Send form', () => {
  it('skips a queued file removed in another view before its upload starts', async () => {
    const file = (id: string) => ({ id, name: `${id}.txt`, type: 'text/plain', size: 1, data: 'data:text/plain;base64,eA==' });
    await fakeBrowser.storage.local.set({ storedFiles: [file('first'), file('removed')] });
    await openPopup('?mode=page');
    const { promise, resolve } = Promise.withResolvers<void>();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      await promise;
      return new Response('');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { send } = await import('@/entrypoints/popup/send');
    const { removeStoredFiles } = await import('@/utils/stored-files');
    const pending = send();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await removeStoredFiles(['removed']);
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
    vi.useFakeTimers();
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
    const file = (name: string) => ({ name, type: 'text/plain', size: 1, data: 'data:text/plain;base64,eA==' });
    await fakeBrowser.storage.local.set({ storedFiles: [file('sent.txt'), file('retry.txt')] });
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
    expect(await fakeBrowser.storage.local.get(['storedFiles', 'draftState'])).toMatchObject({
      storedFiles: [{ name: 'retry.txt' }],
      draftState: { message: 'My draft' },
    });
    expect($('#status').textContent).toContain('1 of 2 attachments sent');
    expect($<HTMLButtonElement>('#send-btn').disabled).toBe(false);
    expect(closed).toBe(false);
    fail = false;
    await send();
    expect(sent).toEqual(['sent.txt', 'retry.txt', 'retry.txt']);
    expect(await fakeBrowser.storage.local.get(['storedFiles', 'draftState'])).toEqual({});
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('sends the saved attachment on the fallback after a network failure on the main server', async () => {
    await fakeBrowser.storage.sync.set({ fallbackUrl: 'https://fallback.example' });
    await fakeBrowser.storage.local.set({
      storedFiles: [{ name: 'a.txt', type: 'text/plain', size: 1, data: 'data:text/plain;base64,eA==' }],
    });
    await openPopup('?mode=page');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://ntfy.example/')) throw new TypeError('network error');
      return new Response('');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { send } = await import('@/entrypoints/popup/send');
    await send();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://ntfy.example/inbox', 'https://fallback.example/inbox']);
    expect($('#status').textContent).toBe('Notification sent!');
    expect(await fakeBrowser.storage.local.get('storedFiles')).toEqual({});
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
    await fakeBrowser.storage.local.set({
      draftState: { title: 'Unsent draft' },
      storedFiles: [{ name: 'saved.txt', type: 'text/plain', size: 1, data: 'data:text/plain;base64,eA==' }],
    });
    await openPopup();
    expect($<HTMLInputElement>('#title-input').value).toBe('Unsent draft');
    expect($('#file-preview').textContent).toContain('saved.txt');
  });

  it('sends two attachments as one ZIP when that option is on', async () => {
    const file = (name: string) => ({ name, type: 'text/plain', size: 5, data: `data:text/plain;base64,${btoa('hello')}` });
    await fakeBrowser.storage.sync.set({ sendAsZipEnabled: true });
    await fakeBrowser.storage.local.set({ storedFiles: [file('a.txt'), file('b.txt')] });
    await openPopup();
    expect(document.querySelectorAll('.file-preview-item')).toHaveLength(2);
    expect($<HTMLInputElement>('#zip-checkbox').checked).toBe(true);

    $('#send-btn').click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.headers.get('Content-Type')).toBe('application/zip');
    expect(requests[0]!.headers.get('X-Filename')).toMatch(/^ntfy-files-\d{8}-\d{6}\.zip$/);
    // Let the popup's close timer run inside this test
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(await fakeBrowser.storage.local.get('storedFiles')).toEqual({});
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

  it('marks topics with notifications off in the Receive tab', async () => {
    await fakeBrowser.storage.sync.set({ notifyRules: [['coolify', 'off']] });
    await openPopup('?tab=receive');
    const coolify = [...document.querySelectorAll('.topic-filter-btn')].find((b) => b.textContent?.startsWith('coolify'))!;
    expect(coolify.querySelector('.topic-muted')?.textContent).toBe('🔕');
  });
});
