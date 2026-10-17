// @vitest-environment happy-dom
// The real popup page (index.html + main.ts) against the fake browser.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { mockResolved } from './helpers/mock';
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
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

async function openPopup(search = ''): Promise<void> {
  history.replaceState(null, '', `/popup.html${search}`);
  await import('@/entrypoints/popup/main');
  await flush();
}

beforeEach(async () => {
  vi.resetModules();
  fakeBrowser.reset();
  document.body.innerHTML = body;
  document.body.className = '';
  requests = [];
  closed = false;

  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ name: 'ntfy Desk', version: '0', manifest_version: 3 });
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
  mockResolved(fakeBrowser.permissions, 'contains', true);
  mockResolved(fakeBrowser.tabs, 'query', [{ url: 'https://news.example/story/' }]);
  vi.spyOn(window, 'close').mockImplementation(() => {
    closed = true;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, headers: new Headers(init.headers), body: init.body });
    return new Response('', { status: 200 });
  }));

  await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics: 'alerts,coolify,inbox', lastTopic: 'inbox' });
  await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
  await fakeBrowser.storage.session.set({ sessionActive: true });
});

describe('Receive tab', () => {
  beforeEach(async () => {
    await fakeBrowser.storage.local.set({
      receivedNotifications: [message('a1', 'alerts', 2, { priority: 5 }), message('a2', 'alerts', 120), message('c1', 'coolify', 60)],
      readMessageIds: ['a2'],
    });
  });

  it('lists the messages of all topics, with a topic list and unread counts', async () => {
    await openPopup('?tab=receive');
    const sidebar = [...document.querySelectorAll('.topic-filter-btn')].map(button => button.textContent);
    expect(sidebar).toEqual(['All topics2', 'alerts1', 'coolify1', 'inbox']);
    const titles = [...document.querySelectorAll('.notification-title')].map(title => title.textContent);
    expect(titles).toEqual(['a1', 'c1', 'a2']); // newest first
    expect($('.notification-time').textContent).toBe('alerts · 2m ago');
    expect(document.body.classList.contains('receive-active')).toBe(true);
  });

  it('filters by topic, remembers it, and deletes within it only', async () => {
    vi.stubGlobal('confirm', () => true);
    await openPopup('?tab=receive');
    document.querySelectorAll<HTMLElement>('.topic-filter-btn')[1]!.click(); // alerts
    await flush();
    expect([...document.querySelectorAll('.notification-title')].map(t => t.textContent)).toEqual(['a1', 'a2']);
    expect(await fakeBrowser.storage.local.get('receiveTopicFilter')).toEqual({ receiveTopicFilter: 'alerts' });

    $('#delete-all-btn').click();
    await flush();
    const { deletedMessageIds } = await fakeBrowser.storage.local.get('deletedMessageIds');
    expect(deletedMessageIds).toEqual(['a1', 'a2']);
  });

  it('keeps the heading in place when the list is empty', async () => {
    await fakeBrowser.storage.local.set({ receiveTopicFilter: 'inbox' });
    await openPopup('?tab=receive');
    expect($('.notifications-empty').textContent).toBe('No recent notifications');
    expect($('#notifications-control-bar').style.visibility).toBe('hidden');
  });
});

describe('Send tab', () => {
  it('puts the tab URL in the title and sends to the selected topic', async () => {
    await fakeBrowser.storage.sync.set({ includeUrl: true });
    await openPopup();
    expect($<HTMLInputElement>('#title-input').value).toBe('https://news.example/story');
    expect($<HTMLSelectElement>('#topic-select').value).toBe('inbox');

    $<HTMLTextAreaElement>('#message-input').value = 'look at this';
    $('#send-btn').click();
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://ntfy.example/inbox');
    expect(requests[0]!.body).toBe('look at this');
    expect(requests[0]!.headers.get('X-Title')).toBe('https://news.example/story');
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer tk_x');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(closed).toBe(true);
  });

  it("doesn't save an automatically filled URL in the draft", async () => {
    await fakeBrowser.storage.sync.set({ includeUrl: true });
    await openPopup();
    const message = $<HTMLTextAreaElement>('#message-input');
    message.value = 'draft text';
    message.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 300));
    const { draftState } = await fakeBrowser.storage.local.get('draftState');
    expect(draftState).toMatchObject({ title: '', message: 'draft text' });
  });

  it('sends two attachments as one ZIP when that option is on', async () => {
    const file = (name: string) => ({ name, type: 'text/plain', size: 5, data: `data:text/plain;base64,${btoa('hello')}` });
    await fakeBrowser.storage.sync.set({ sendAsZipEnabled: true });
    await fakeBrowser.storage.local.set({ storedFiles: [file('a.txt'), file('b.txt')] });
    await openPopup();
    expect(document.querySelectorAll('.file-preview-item')).toHaveLength(2);
    expect($<HTMLInputElement>('#zip-checkbox').checked).toBe(true);

    $('#send-btn').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('Content-Type')).toBe('application/zip');
    expect(requests[0]!.headers.get('X-Filename')).toMatch(/^ntfy-files-\d{8}-\d{6}\.zip$/);
    expect(await fakeBrowser.storage.local.get('storedFiles')).toEqual({});
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(closed).toBe(true); // let the popup's close timer run inside this test
  });

  it('stays open after sending in the extension tab', async () => {
    await openPopup('?mode=page');
    expect(document.body.classList.contains('page-mode')).toBe(true);
    expect($('#popout-btn').style.display).toBe('none');
    $<HTMLTextAreaElement>('#message-input').value = 'x';
    $('#send-btn').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(requests).toHaveLength(1);
    expect(closed).toBe(false);
    expect($('#status').textContent).toBe('Notification sent!');
  });
});

describe('settings', () => {
  it('asks for access to the server when a token is set and access is missing', async () => {
    mockResolved(fakeBrowser.permissions, 'contains', false);
    await openPopup();
    expect($('#settings-btn').classList.contains('highlight')).toBe(true);
    $('#settings-btn').click();
    await flush();
    expect($('#server-access-btn').style.display).toBe('');

    const request = mockResolved(fakeBrowser.permissions, 'request', true);
    $('#server-access-btn').click();
    await flush();
    expect(request).toHaveBeenCalledWith({ origins: ['https://ntfy.example/*'] });
  });

  it('saves the token to local storage, not sync', async () => {
    await openPopup();
    $('#settings-btn').click();
    await flush();
    const token = $<HTMLInputElement>('#token-input');
    token.value = 'tk_new';
    token.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(await fakeBrowser.storage.local.get('accessToken')).toEqual({ accessToken: 'tk_new' });
    expect(await fakeBrowser.storage.sync.get('accessToken')).toEqual({});
  });
});
