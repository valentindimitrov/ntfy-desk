import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { mockResolved } from './helpers/mock';
import { getShortcuts, handleCommand, openShortcutSettings } from '@/utils/commands';

let published: { url: string; headers: Headers; body: unknown }[];

const tab = (url: string, title = 'A story') => ({ id: 1, url, title }) as Browser.tabs.Tab;

beforeEach(async () => {
  fakeBrowser.reset();
  published = [];
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ name: 'ntfy Desk', version: '0', manifest_version: 3 });
  vi.spyOn(fakeBrowser.action, 'setBadgeText').mockResolvedValue();
  vi.spyOn(fakeBrowser.action, 'setBadgeBackgroundColor').mockResolvedValue();
  vi.spyOn(fakeBrowser.action, 'setTitle').mockResolvedValue();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      published.push({ url, headers: new Headers(init.headers), body: init.body });
      return new Response('', { status: 200 });
    }),
  );
  await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.example', topics: 'inbox,alerts' });
  await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
});

describe('send-page command', () => {
  it("publishes the tab's URL with its title to the composer's independent topic", async () => {
    await fakeBrowser.storage.sync.set({ lastTopic: 'alerts' });
    await handleCommand('send-page', tab('https://news.example/story/'));
    expect(published).toHaveLength(1);
    expect(published[0]!.url).toBe('https://ntfy.example/alerts');
    expect(published[0]!.body).toBe('https://news.example/story/');
    expect(published[0]!.headers.get('X-Title')).toBe('A story');
    expect(published[0]!.headers.get('Authorization')).toBe('Bearer tk_x');
    expect(fakeBrowser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '✓' });
  });

  it('uses the first topic when there is no last topic, or it is no longer configured', async () => {
    await handleCommand('send-page', tab('https://news.example/a'));
    await fakeBrowser.storage.sync.set({ lastTopic: 'removed' });
    await handleCommand('send-page', tab('https://news.example/b'));
    await fakeBrowser.storage.sync.set({ lastTopic: 42 });
    await handleCommand('send-page', tab('https://news.example/c'));
    expect(published.map(({ url }) => url)).toEqual(Array(3).fill('https://ntfy.example/inbox'));
  });

  it('asks for the active tab when the browser passes none', async () => {
    const query = mockResolved(fakeBrowser.tabs, 'query', [tab('https://docs.example/page', 'Docs')]);
    await handleCommand('send-page');
    expect(query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(published[0]!.body).toBe('https://docs.example/page');
    expect(published[0]!.headers.get('X-Title')).toBe('Docs');
  });

  it.each<[string, Record<string, string>, string]>([
    ['no server', { apiUrl: '' }, 'https://news.example/'],
    ['no topic', { topics: '' }, 'https://news.example/'],
    ['a browser page', {}, 'chrome://extensions/'],
    ['a local file', {}, 'file:///home/me/notes.txt'],
  ])('shows the failure badge and publishes nothing with %s', async (_case, settings, url) => {
    await fakeBrowser.storage.sync.set(settings);
    await handleCommand('send-page', tab(url));
    expect(published).toEqual([]);
    expect(fakeBrowser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '✗' });
  });

  it('shows the failure badge when no tab can be found', async () => {
    mockResolved(fakeBrowser.tabs, 'query', []);
    await handleCommand('send-page');
    expect(published).toEqual([]);
    expect(fakeBrowser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '✗' });
  });

  it('sends without credentials while they are held back from a changed server', async () => {
    await fakeBrowser.storage.local.set({ authOrigins: ['https://old.example'] });
    await handleCommand('send-page', tab('https://news.example/'));
    expect(published[0]!.headers.get('Authorization')).toBeNull();
  });

  it('picks the fallback first and reports an uncertain delivery without retrying', async () => {
    await fakeBrowser.storage.sync.set({ fallbackUrl: 'https://fallback.example' });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/health')) return Response.json({ healthy: true });
      throw new TypeError('response connection lost');
    });
    vi.stubGlobal('fetch', fetchMock);
    await handleCommand('send-page', tab('https://news.example/'));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://ntfy.example/v1/health', 'https://ntfy.example/inbox']);
    expect(fakeBrowser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '?' });
    expect(fakeBrowser.action.setTitle).toHaveBeenLastCalledWith({ title: 'Delivery is uncertain. Check the Inbox before retrying.' });
  });

  it('reports a refused publish as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );
    await handleCommand('send-page', tab('https://news.example/'));
    expect(fakeBrowser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '✗' });
  });

  it('ignores other commands', async () => {
    await handleCommand('something-else', tab('https://news.example/'));
    expect(published).toEqual([]);
    expect(fakeBrowser.action.setBadgeText).not.toHaveBeenCalled();
  });
});

describe('open-popup command', () => {
  it('opens the toolbar popup, without publishing anything', async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    Object.assign(fakeBrowser.action, { openPopup: open });
    await handleCommand('open-popup', tab('https://news.example/'));
    expect(open).toHaveBeenCalledOnce();
    expect(published).toEqual([]);
  });

  it("opens the extension's tab where the browser can't open the popup", async () => {
    Object.assign(fakeBrowser.action, { openPopup: vi.fn().mockRejectedValue(new Error('no active window')) });
    vi.spyOn(fakeBrowser.runtime, 'getURL').mockImplementation(
      ((path: string) => `chrome-extension://id${path}`) as typeof fakeBrowser.runtime.getURL,
    );
    mockResolved(fakeBrowser.runtime, 'getContexts', []);
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    await handleCommand('open-popup');
    expect(create).toHaveBeenCalledOnce();
    expect(JSON.stringify(create.mock.calls)).toContain('popup.html?mode=page');
  });
});

describe('shortcut list and settings', () => {
  it('lists the bindings with a name for the popup command and an empty key when unset', async () => {
    mockResolved(fakeBrowser.commands, 'getAll', [
      { name: 'open-popup', description: '', shortcut: 'Alt+Shift+N' },
      { name: 'send-page', description: 'Send this page to ntfy', shortcut: '' },
      // Chromium also reports its own command for the toolbar button; without a key it isn't listed
      { name: '_execute_action', description: '', shortcut: '' },
    ]);
    expect(await getShortcuts()).toEqual([
      { name: 'open-popup', description: 'Open ntfy Desk', shortcut: 'Alt+Shift+N' },
      { name: 'send-page', description: 'Send this page to ntfy', shortcut: '' },
    ]);
  });

  it('lists nothing when the browser cannot report the bindings', async () => {
    vi.spyOn(fakeBrowser.commands, 'getAll').mockRejectedValue(new Error('unavailable') as never);
    expect(await getShortcuts()).toEqual([]);
  });

  it("opens Chromium's shortcut page in a tab, which has no API for it", async () => {
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    expect(await openShortcutSettings()).toBe(true);
    expect(create.mock.calls).toEqual([[{ url: 'chrome://extensions/shortcuts' }]]);
  });

  it("uses Firefox's commands.openShortcutSettings, and reports when it is missing or fails", async () => {
    const create = mockResolved(fakeBrowser.tabs, 'create', {});
    const commands = fakeBrowser.commands as { openShortcutSettings?: () => Promise<void> };
    vi.stubEnv('BROWSER', 'firefox');
    try {
      expect(await openShortcutSettings()).toBe(false); // an older Firefox
      const open = vi.fn(async () => {});
      commands.openShortcutSettings = open;
      expect(await openShortcutSettings()).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
      commands.openShortcutSettings = vi.fn(async () => {
        throw new Error('refused');
      });
      expect(await openShortcutSettings()).toBe(false);
      expect(create).not.toHaveBeenCalled();
    } finally {
      delete commands.openShortcutSettings;
      vi.unstubAllEnvs();
    }
  });
});
