import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { mockResolved } from './helpers/mock';
import { handleContextMenuClick, updateContextMenu } from '@/utils/context-menu';

type CreateProps = Browser.contextMenus.CreateProperties;

let created: CreateProps[];
let published: { url: string; headers: Headers; body: unknown }[];

beforeEach(async () => {
  fakeBrowser.reset();
  created = [];
  published = [];
  vi.spyOn(fakeBrowser.contextMenus, 'removeAll').mockResolvedValue();
  vi.spyOn(fakeBrowser.contextMenus, 'create').mockImplementation(((props: CreateProps) => {
    created.push(props);
    return props.id ?? '';
  }) as typeof fakeBrowser.contextMenus.create);
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ name: 'ntfy Desk', version: '0', manifest_version: 3 });
  vi.spyOn(fakeBrowser.action, 'setBadgeText').mockResolvedValue();
  vi.spyOn(fakeBrowser.action, 'setBadgeBackgroundColor').mockResolvedValue();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      published.push({ url, headers: new Headers(init.headers), body: init.body });
      return new Response('', { status: 200 });
    }),
  );
  await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', includeUrl: true });
});

const tab = { id: 1, url: 'https://news.example/story/', title: 'A story' } as Browser.tabs.Tab;
const click = (menuItemId: string, extra: Partial<Browser.contextMenus.OnClickData> = {}) =>
  handleContextMenuClick({ menuItemId, editable: false, pageUrl: tab.url!, ...extra } as Browser.contextMenus.OnClickData, tab);

describe('menu', () => {
  it('has one item per kind for a single topic', async () => {
    await fakeBrowser.storage.sync.set({ topics: 'inbox' });
    await updateContextMenu();
    expect(created.map((item) => item.title)).toEqual(['ntfy Desk', 'Page (inbox)', 'Text (inbox)', 'Image (inbox)', 'Link (inbox)']);
  });

  it('has a submenu of topics per kind for several topics', async () => {
    await fakeBrowser.storage.sync.set({ topics: 'inbox,alerts' });
    await updateContextMenu();
    const page = created.filter((item) => item.parentId === 'ntfy-parent-ntfy-send-tab');
    expect(page.map((item) => [item.id, item.title])).toEqual([
      ['ntfy-send-tab-0', 'inbox'],
      ['ntfy-send-tab-1', 'alerts'],
    ]);
  });

  it('is empty without a server or topics', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: '', topics: 'inbox' });
    await updateContextMenu();
    expect(created).toEqual([]);
  });
});

describe('sending', () => {
  it('sends selected text with the page URL as title, to the chosen topic', async () => {
    await fakeBrowser.storage.sync.set({ topics: 'inbox,alerts' });
    await click('ntfy-send-selection-1', { selectionText: 'quoted text' });
    expect(published).toHaveLength(1);
    expect(published[0]!.url).toBe('https://ntfy.example/alerts');
    expect(published[0]!.body).toBe('quoted text');
    expect(published[0]!.headers.get('X-Title')).toBe('https://news.example/story');
  });

  it('sends a link with its text as title and the page URL in the message', async () => {
    await fakeBrowser.storage.sync.set({ topics: 'inbox' });
    mockResolved(fakeBrowser.scripting, 'executeScript', [{ result: '  Read more ', frameId: 0, documentId: '' }]);
    await click('ntfy-send-link', { linkUrl: 'https://other.example/a' });
    expect(published[0]!.headers.get('X-Title')).toBe('Read more');
    expect(published[0]!.body).toBe('https://other.example/a\n\nSent from: https://news.example/story');
  });

  it('sends the page URL with the page title', async () => {
    await fakeBrowser.storage.sync.set({ topics: 'inbox' });
    await click('ntfy-send-tab');
    expect(published[0]!.body).toBe('https://news.example/story/');
    expect(published[0]!.headers.get('X-Title')).toBe('A story');
  });
});
