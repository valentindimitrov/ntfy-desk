// Export and import of the synced settings (utils/backup.ts): what a file holds, what a file can't
// make the extension store, and that an import never gets the stored token sent to a new server.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  BACKUP_FORMAT,
  BACKUP_KEYS,
  BACKUP_VERSION,
  BackupError,
  MAX_BACKUP_BYTES,
  backupFileName,
  buildBackup,
  importSettings,
  parseBackup,
  previewImport,
  readBackupFile,
  sanitizeSettings,
  type BackupSettings,
} from '@/utils/backup';
import { AUTH_ORIGINS_KEY, getConfig } from '@/utils/ntfy';

/** Every key of storage.sync with a value that isn't its default */
const SYNCED = {
  apiUrl: 'https://ntfy.lan',
  fallbackUrl: 'https://ntfy.example.com/base',
  topics: 'alerts,backups,__proto__',
  includeUrl: true,
  notifyRules: [
    ['backups', 'high'],
    ['__proto__', 'off'],
  ],
  syncDeletionTopics: ['alerts'],
  topicSendDefaults: [{ topic: 'alerts', priority: 5, tags: ['warning', 'skull'] }],
  theme: 'dark',
  priority: 4,
  lastTags: ['tada'],
  lastTopic: 'backups',
  sendAnotherEnabled: true,
  sendAsZipEnabled: true,
  freezeDividers: true,
  rememberSendPanel: true,
  badgeScope: 'notifying',
  keepUrgentOnScreen: false,
  historyPerTopic: 250,
  messageTimes: 'absolute',
  inboxDensity: 'compact',
  topicLayout: 'top',
};
const SETTINGS = { ...SYNCED, topics: ['alerts', 'backups', '__proto__'] } as unknown as BackupSettings;

/** Everything the extension keeps outside storage.sync, with recognisable values */
const LOCAL = {
  accessToken: 'tk_secret_token',
  serverCredentials: { username: 'secret-user', password: 'secret-password' },
  authOrigins: ['https://ntfy.lan', 'https://ntfy.example.com'],
  receivedNotifications: [{ id: 'm1', event: 'message', topic: 'alerts', time: 1, message: 'secret-message' }],
  readMessageIds: ['secret-read-id'],
  deletedMessageIds: ['secret-deleted-id'],
  topicSync: [{ topic: 'alerts', since: 1, seen: [], synced: true, origins: ['https://ntfy.lan'] }],
  draftState: { title: 'secret-draft' },
  receiveTopicFilter: { topic: 'alerts' },
  storedFilesRevision: 'secret-revision',
  popupTopicsPaneWidth: 123,
  popupSendPaneWidth: 124,
  topicsPaneWidth: 125,
  sendPaneWidth: 126,
  sendPanelOpen: false,
  sendOptionsOpen: true,
};

const file = (settings: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: '2026-11-01T10:00:00.000Z', settings, ...extra });

/** Import as the settings view does: preview, then write */
async function importFile(text: string): Promise<void> {
  const { settings } = parseBackup(text);
  await importSettings(settings, (await previewImport(settings)).baseline);
}

const message = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BackupError);
    return (error as Error).message;
  }
  throw new Error('Expected a BackupError');
};

beforeEach(() => {
  fakeBrowser.reset();
});

describe('export', () => {
  it('covers exactly the storage.sync keys of the storage table in ARCHITECTURE.md', () => {
    const row = readFileSync(resolve('ARCHITECTURE.md'), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('| `storage.sync` |'));
    const documented = [...(row?.split('|')[2] ?? '').matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1] ?? '');
    expect([...BACKUP_KEYS].sort()).toEqual([...documented].sort());
    expect(documented.length).toBeGreaterThan(15);
  });

  it('writes the format, the version, the date and every synced setting', async () => {
    await fakeBrowser.storage.sync.set(SYNCED);
    const backup = await buildBackup(new Date('2026-11-17T08:30:00Z'));
    expect(backup).toEqual({ format: 'ntfy-desk-settings', version: 1, exportedAt: '2026-11-17T08:30:00.000Z', settings: SETTINGS });
    expect(backupFileName(new Date(2026, 10, 7))).toBe('ntfy-desk-settings-2026-11-07.json');
  });

  it('exports defaults for an empty storage', async () => {
    expect((await buildBackup()).settings).toEqual({
      apiUrl: '',
      fallbackUrl: '',
      topics: [],
      includeUrl: false,
      notifyRules: [],
      syncDeletionTopics: [],
      topicSendDefaults: [],
      theme: 'auto',
      priority: 3,
      lastTags: [],
      lastTopic: '',
      sendAnotherEnabled: false,
      sendAsZipEnabled: false,
      freezeDividers: false,
      rememberSendPanel: false,
      badgeScope: 'all',
      keepUrgentOnScreen: true,
      historyPerTopic: 100,
      messageTimes: 'relative',
      inboxDensity: 'comfortable',
      topicLayout: 'side',
    });
  });

  it('never contains a credential, an approval or anything from local or session storage', async () => {
    await fakeBrowser.storage.sync.set(SYNCED);
    await fakeBrowser.storage.local.set(LOCAL);
    await fakeBrowser.storage.session.set({ receiverStatus: { state: 'connected', server: 'secret-status' } });
    const backup = await buildBackup();
    const text = JSON.stringify(backup);

    expect(Object.keys(backup).sort()).toEqual(['exportedAt', 'format', 'settings', 'version']);
    expect(Object.keys(backup.settings).sort()).toEqual([...BACKUP_KEYS].sort());
    for (const key of [...Object.keys(LOCAL), 'receiverStatus']) expect(text).not.toContain(`"${key}"`);
    expect(text).not.toMatch(/secret|tk_/);
  });

  it('exports server URLs without userinfo, query string or fragment, even if storage holds them', async () => {
    await fakeBrowser.storage.sync.set({
      apiUrl: 'https://user:secret-password@ntfy.lan/?auth=secret-auth#secret-fragment',
      fallbackUrl: 'javascript:alert(1)',
      topics: 'alerts',
    });
    const backup = await buildBackup();
    expect(backup.settings).toMatchObject({ apiUrl: 'https://ntfy.lan/', fallbackUrl: '' });
    expect(JSON.stringify(backup)).not.toMatch(/secret|user/);
  });

  it('leaves out invalid stored values and per-topic entries of topics that are gone', async () => {
    await fakeBrowser.storage.sync.set({
      topics: 'alerts, not a topic,backups',
      notifyRules: [['alerts', 'high'], ['gone', 'off'], ['backups', 'loud'], 'x'],
      syncDeletionTopics: ['gone', 'backups', 7],
      topicSendDefaults: [
        { topic: 'gone', priority: 2, tags: [] },
        { topic: 'alerts', priority: 9, tags: [] },
        { topic: 'backups', priority: 2, tags: ['a,b', 'ok'] },
      ],
      theme: 'neon',
      historyPerTopic: 7,
      lastTopic: 'gone',
    });
    expect((await buildBackup()).settings).toMatchObject({
      topics: ['alerts', 'backups'],
      notifyRules: [['alerts', 'high']],
      syncDeletionTopics: ['backups'],
      topicSendDefaults: [{ topic: 'backups', priority: 2, tags: ['ok'] }],
      theme: 'auto',
      historyPerTopic: 100,
      lastTopic: '',
    });
  });
});

describe('import: round trip', () => {
  it('restores an export after a reset, in one storage.sync write', async () => {
    await fakeBrowser.storage.sync.set(SYNCED);
    const text = JSON.stringify(await buildBackup(), null, 2);
    await fakeBrowser.storage.sync.clear();
    const set = vi.spyOn(fakeBrowser.storage.sync, 'set');
    const remove = vi.spyOn(fakeBrowser.storage.sync, 'remove');

    await importFile(text);
    expect(await fakeBrowser.storage.sync.get()).toEqual(SYNCED);
    expect(set).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect((await buildBackup()).settings).toEqual(SETTINGS);
  });

  it('replaces instead of merging: a setting the file lacks returns to its default', async () => {
    await fakeBrowser.storage.sync.set(SYNCED);
    await importFile(file({ apiUrl: 'https://ntfy.lan', topics: ['inbox'] }));
    const stored = await fakeBrowser.storage.sync.get();
    expect(Object.keys(stored).sort()).toEqual([...BACKUP_KEYS].sort());
    expect(stored).toEqual({
      apiUrl: 'https://ntfy.lan',
      fallbackUrl: '',
      topics: 'inbox',
      includeUrl: false,
      notifyRules: [],
      syncDeletionTopics: [],
      topicSendDefaults: [],
      theme: 'auto',
      priority: 3,
      lastTags: [],
      lastTopic: '',
      sendAnotherEnabled: false,
      sendAsZipEnabled: false,
      freezeDividers: false,
      rememberSendPanel: false,
      badgeScope: 'all',
      keepUrgentOnScreen: true,
      historyPerTopic: 100,
      messageTimes: 'relative',
      inboxDensity: 'comfortable',
      topicLayout: 'side',
    });
  });

  it('drops per-topic entries of topics that are not in the imported list', async () => {
    const { settings, skipped } = parseBackup(
      file({
        topics: ['alerts'],
        notifyRules: [
          ['alerts', 'high'],
          ['other', 'off'],
        ],
        syncDeletionTopics: ['other', 'alerts'],
        topicSendDefaults: [
          { topic: 'other', priority: 1, tags: [] },
          { topic: 'alerts', priority: 2, tags: ['a'] },
        ],
        lastTopic: 'other',
      }),
    );
    expect(settings).toMatchObject({
      notifyRules: [['alerts', 'high']],
      syncDeletionTopics: ['alerts'],
      topicSendDefaults: [{ topic: 'alerts', priority: 2, tags: ['a'] }],
      lastTopic: '',
    });
    expect(skipped).toEqual([]);
  });

  it('leaves storage.local alone and ignores keys it does not know, wherever they are', async () => {
    await fakeBrowser.storage.local.set(LOCAL);
    await importFile(
      file(
        {
          apiUrl: 'https://ntfy.lan',
          topics: ['alerts'],
          accessToken: 'tk_from_file',
          serverCredentials: { username: 'x', password: 'y' },
          authOrigins: ['https://evil.example'],
          receivedNotifications: [],
          somethingNew: { nested: true },
        },
        { accessToken: 'tk_from_file', authOrigins: ['https://evil.example'], extra: 1 },
      ),
    );
    expect(await fakeBrowser.storage.local.get()).toEqual(LOCAL);
    expect(Object.keys(await fakeBrowser.storage.sync.get()).sort()).toEqual([...BACKUP_KEYS].sort());
    expect(await fakeBrowser.storage.session.get()).toEqual({});
  });
});

describe('import: files that are refused', () => {
  it('refuses a file over the size limit before reading it', async () => {
    const text = vi.fn(async () => '{}');
    await expect(readBackupFile({ size: MAX_BACKUP_BYTES + 1, text } as unknown as Blob)).rejects.toThrow(/too large/);
    expect(text).not.toHaveBeenCalled();
    // And text over the limit, whatever the size said
    expect(message(() => parseBackup(file({ topics: ['a'] }, { padding: 'é'.repeat(MAX_BACKUP_BYTES / 2) })))).toMatch(/too large/);
    await expect(readBackupFile(new Blob([file({ topics: ['a'] })]))).resolves.toMatchObject({ settings: { topics: ['a'] } });
  });

  it('refuses text that is not JSON', () => {
    for (const text of ['', 'not json', '{"format": "ntfy-desk-settings",', '\u0000']) {
      expect(message(() => parseBackup(text))).toBe('This file is not valid JSON.');
    }
  });

  it('refuses JSON that is not an ntfy Desk settings file', () => {
    for (const text of ['null', '[]', '"ntfy-desk-settings"', '7', '{}', '{"format":"other","version":1,"settings":{}}', '{"version":1}']) {
      expect(message(() => parseBackup(text))).toBe('This is not an ntfy Desk settings file.');
    }
  });

  it('refuses a file of a newer format version, and one without a usable version', () => {
    expect(message(() => parseBackup(file({}, { version: BACKUP_VERSION + 1 })))).toMatch(
      /made by a newer version of ntfy Desk \(format 2; this version reads format 1\)/,
    );
    for (const version of [undefined, null, '1', 1.5, 0, -1, Number.NaN]) {
      expect(message(() => parseBackup(file({}, { version })))).toBe('This settings file has no usable version number.');
    }
  });

  it('refuses a file whose settings are not an object', () => {
    for (const settings of [undefined, null, [], 'x', 7]) {
      expect(message(() => parseBackup(file(settings)))).toBe('This settings file contains no settings.');
    }
  });

  it('writes nothing for a refused file', async () => {
    await fakeBrowser.storage.sync.set(SYNCED);
    await expect(importFile(file({}, { version: 2 }))).rejects.toThrow(BackupError);
    expect(await fakeBrowser.storage.sync.get()).toEqual(SYNCED);
  });
});

describe('import: values that are not imported', () => {
  it('gives every value of the wrong type its default and names it', () => {
    const wrong = Object.fromEntries(BACKUP_KEYS.map((key) => [key, { toString: 'x' }]));
    const { settings, skipped } = parseBackup(file(wrong));
    expect(settings).toEqual(sanitizeSettings({}).settings);
    expect(skipped).toHaveLength(BACKUP_KEYS.length);

    const alsoWrong = parseBackup(
      file({ topics: 'alerts,backups', includeUrl: 'true', priority: '4', historyPerTopic: 250.5, keepUrgentOnScreen: 0, lastTags: 'a' }),
    );
    expect(alsoWrong.settings).toEqual(sanitizeSettings({}).settings);
    expect([...alsoWrong.skipped].sort()).toEqual(
      [
        'topics',
        'last tags',
        'fill in the current tab',
        'last priority',
        'keep urgent notifications on screen',
        'messages kept per topic',
      ].sort(),
    );
  });

  it('imports valid topic names only', () => {
    const { settings, skipped } = parseBackup(
      file({
        topics: ['alerts', 'has space', 'a/b', '', 'x'.repeat(65), 7, null, 'alerts', '../admin', 'a,b', '__proto__', 'ok_Topic-1'],
        lastTopic: 'a/b',
      }),
    );
    expect(settings.topics).toEqual(['alerts', '__proto__', 'ok_Topic-1']);
    expect(settings.lastTopic).toBe('');
    expect(skipped).toEqual(['topics (8 invalid names)']);
  });

  it('refuses a topic list too long for one synced item', () => {
    const topics = Array.from({ length: 200 }, (_, index) => `${'t'.repeat(60)}${index}`);
    const { settings, skipped } = parseBackup(file({ topics, notifyRules: [[topics[0], 'off']] }));
    expect(settings.topics).toEqual([]);
    expect(settings.notifyRules).toEqual([]);
    expect(skipped).toEqual(['topics (too many to store)']);
  });

  it('imports http(s) server URLs only', () => {
    for (const url of [
      'javascript:alert(1)',
      'ftp://ntfy.lan',
      'ntfy.lan',
      'https://',
      'file:///etc/passwd',
      7,
      null,
      ['https://a.example'],
    ]) {
      const { settings, skipped } = parseBackup(file({ apiUrl: url, fallbackUrl: url }));
      expect([settings.apiUrl, settings.fallbackUrl, skipped]).toEqual(['', '', ['server URL', 'fallback URL']]);
    }
    expect(parseBackup(file({ apiUrl: `https://ntfy.lan/${'p'.repeat(9000)}` }))).toMatchObject({
      settings: { apiUrl: '' },
      skipped: ['server URL'],
    });
    expect(parseBackup(file({ apiUrl: ' https://ntfy.lan:8443/base ', fallbackUrl: '' }))).toMatchObject({
      settings: { apiUrl: 'https://ntfy.lan:8443/base', fallbackUrl: '' },
      skipped: [],
      urlPartsRemoved: false,
    });
  });

  it('strips userinfo, query strings and fragments from server URLs and never keeps the credentials', async () => {
    await fakeBrowser.storage.local.set({ accessToken: 'tk_mine', authOrigins: ['https://ntfy.lan'] });
    const text = file({
      apiUrl: 'https://file-user:file-password@ntfy.lan',
      fallbackUrl: 'https://ntfy.example.com/?auth=QmVhcmVyIHRrX2ZpbGU#frag',
      topics: ['alerts'],
    });
    const parsed = parseBackup(text);
    expect(parsed).toMatchObject({
      settings: { apiUrl: 'https://ntfy.lan', fallbackUrl: 'https://ntfy.example.com/' },
      skipped: [],
      urlPartsRemoved: true,
    });
    await importFile(text);
    expect(JSON.stringify(await fakeBrowser.storage.sync.get())).not.toMatch(/file-user|file-password|auth=|frag/);
    expect(await fakeBrowser.storage.local.get()).toEqual({ accessToken: 'tk_mine', authOrigins: ['https://ntfy.lan'] });
    expect((await getConfig()).credentials).toBeNull();
  });

  it('does not import send defaults too large for one synced item, and keeps the rest', () => {
    const topics = Array.from({ length: 30 }, (_, index) => `topic-${index}`);
    const tags = Array.from({ length: 10 }, (_, index) => `${'g'.repeat(48)}${index}`);
    const { settings, skipped } = parseBackup(
      file({ topics, topicSendDefaults: topics.map((topic) => ({ topic, priority: 4, tags })), notifyRules: [['topic-1', 'off']] }),
    );
    expect(settings.topicSendDefaults).toEqual([]);
    expect(settings.notifyRules).toEqual([['topic-1', 'off']]);
    expect(skipped).toEqual(['send priorities and tags (too large to store)']);
  });

  it('drops invalid entries of the per-topic lists and says so', () => {
    const { settings, skipped } = parseBackup(
      file({
        topics: ['alerts', 'backups'],
        notifyRules: [['alerts', 'loud'], ['backups', 'urgent'], 'alerts'],
        syncDeletionTopics: ['alerts', 7, { topic: 'backups' }],
        topicSendDefaults: [
          { topic: 'alerts', priority: 6, tags: [] },
          { topic: 'backups', priority: 1, tags: ['fine', 'a,b', 7, 'x'.repeat(51)] },
        ],
        lastTags: ['ok', 7],
      }),
    );
    expect(settings).toMatchObject({
      notifyRules: [['backups', 'urgent']],
      syncDeletionTopics: ['alerts'],
      topicSendDefaults: [{ topic: 'backups', priority: 1, tags: ['fine'] }],
      lastTags: ['ok'],
    });
    expect(skipped).toEqual([
      'desktop notification rules (some entries)',
      'message sync (some entries)',
      'send priorities and tags (some entries)',
      'last tags (some entries)',
    ]);
  });

  it('never writes a raw value: what reaches storage is what the validators returned', async () => {
    const hostile = {
      apiUrl: 'javascript:alert(1)',
      topics: ['ok', '<img src=x onerror=alert(1)>'],
      notifyRules: { __proto__: { polluted: true } },
      theme: { toString: () => 'dark' },
      lastTags: 'x'.repeat(100),
      historyPerTopic: 1e9,
      __proto__: { polluted: true },
      constructor: { prototype: { polluted: true } },
    };
    await importFile(`{"format":"ntfy-desk-settings","version":1,"settings":${JSON.stringify(hostile)},"__proto__":{"polluted":true}}`);
    expect(await fakeBrowser.storage.sync.get()).toEqual({ ...sanitizeSettings({}).settings, topics: 'ok' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('import: credentials and server approval', () => {
  const importServer = (apiUrl: string, fallbackUrl = '') => importFile(file({ apiUrl, fallbackUrl, topics: ['alerts'] }));
  const approvals = async () => (await fakeBrowser.storage.local.get(AUTH_ORIGINS_KEY))[AUTH_ORIGINS_KEY] as unknown;

  it('holds the token back from an imported server that is not approved on this device', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.lan', topics: 'alerts' });
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x', authOrigins: ['https://ntfy.lan'] });
    const { settings } = parseBackup(file({ apiUrl: 'https://evil.example', fallbackUrl: 'https://ntfy.lan', topics: ['alerts'] }));
    expect((await previewImport(settings)).heldBackFrom).toEqual(['https://evil.example']);

    await importServer('https://evil.example', 'https://ntfy.lan');
    expect(await approvals()).toEqual(['https://ntfy.lan']);
    expect(await getConfig()).toMatchObject({
      apiUrl: 'https://evil.example',
      accessToken: '',
      credentials: null,
      heldBackFrom: ['https://evil.example'],
    });
  });

  it('holds a username and password back too', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.lan', topics: 'alerts' });
    await fakeBrowser.storage.local.set({ serverCredentials: { username: 'u', password: 'p' }, authOrigins: ['https://ntfy.lan'] });
    await importServer('https://evil.example');
    expect(await getConfig()).toMatchObject({ credentials: null, heldBackFrom: ['https://evil.example'] });
  });

  it('keeps using the token with imported servers that are already approved', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.lan', topics: 'alerts' });
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x', authOrigins: ['https://ntfy.lan', 'https://ntfy.example.com'] });
    const { settings } = parseBackup(
      file({ apiUrl: 'https://ntfy.example.com', fallbackUrl: 'https://ntfy.lan/base', topics: ['alerts'] }),
    );
    expect((await previewImport(settings)).heldBackFrom).toEqual([]);
    await importServer('https://ntfy.example.com', 'https://ntfy.lan/base');
    expect(await getConfig()).toMatchObject({ accessToken: 'tk_x', heldBackFrom: [] });
    expect(await approvals()).toEqual(['https://ntfy.lan', 'https://ntfy.example.com']);
  });

  it('cannot use the first-time approval: with no approvals recorded, the servers before the import are the approved ones', async () => {
    // A token saved on a device that never recorded approvals: getConfig approves the servers it finds
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.lan', topics: 'alerts' });
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
    expect(await approvals()).toBeUndefined();
    const { settings } = parseBackup(file({ apiUrl: 'https://evil.example', topics: ['alerts'] }));
    expect((await previewImport(settings)).heldBackFrom).toEqual(['https://evil.example']);
    expect(await approvals()).toBeUndefined(); // a preview writes nothing

    await importServer('https://evil.example');
    expect(await approvals()).toEqual(['https://ntfy.lan']);
    expect(await getConfig()).toMatchObject({ accessToken: '', credentials: null, heldBackFrom: ['https://evil.example'] });
    expect(await approvals()).toEqual(['https://ntfy.lan']);
  });

  it('cannot use the first-time approval when no server was configured either', async () => {
    // The control: without an import, the first server arriving for a stored token is approved
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x', serverCredentials: { username: 'u', password: 'p' } });
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://first.example', topics: 'alerts' });
    expect(await getConfig()).toMatchObject({ accessToken: 'tk_x', heldBackFrom: [] });

    fakeBrowser.reset();
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x', serverCredentials: { username: 'u', password: 'p' } });
    expect((await getConfig()).heldBackFrom).toEqual([]);
    expect(await approvals()).toBeUndefined();

    await importServer('https://evil.example', 'https://evil-fallback.example');
    expect(await approvals()).toEqual([]);
    expect(await getConfig()).toMatchObject({
      accessToken: '',
      credentials: null,
      heldBackFrom: ['https://evil.example', 'https://evil-fallback.example'],
    });
    expect(await approvals()).toEqual([]);
  });

  it('records the approvals before the imported servers are stored', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.lan', topics: 'alerts' });
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
    const order: string[] = [];
    const localSet = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
    const syncSet = fakeBrowser.storage.sync.set.bind(fakeBrowser.storage.sync);
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation((async (items: Record<string, unknown>) => {
      order.push(`local ${JSON.stringify(items)}`);
      return localSet(items);
    }) as never);
    vi.spyOn(fakeBrowser.storage.sync, 'set').mockImplementation((async (items: Record<string, unknown>) => {
      order.push(`sync ${String(items.apiUrl)}`);
      return syncSet(items);
    }) as never);
    await importServer('https://evil.example');
    expect(order.at(-1)).toBe('sync https://evil.example');
    expect(order.slice(0, -1).at(-1)).toBe('local {"authOrigins":["https://ntfy.lan"]}');
  });

  it('needs no approval when no token or password is stored, and a token saved later is held back from the imported server', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.lan', topics: 'alerts' });
    const { settings } = parseBackup(file({ apiUrl: 'https://other.example', topics: ['alerts'] }));
    expect((await previewImport(settings)).heldBackFrom).toEqual([]);
    await importServer('https://other.example');
    // The servers from before the import are the approved ones, not the imported server
    expect(await approvals()).toEqual(['https://ntfy.lan']);
    expect(await getConfig()).toMatchObject({ apiUrl: 'https://other.example', accessToken: '', heldBackFrom: [] });

    await fakeBrowser.storage.local.set({ accessToken: 'tk_later' });
    expect(await getConfig()).toMatchObject({ accessToken: '', heldBackFrom: ['https://other.example'] });
  });

  it('does not let a read that raced with the import approve the imported server', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.lan', topics: 'alerts' });
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
    // A getConfig whose local read ran before the import and whose synced read ran after it
    const localGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (keys?: unknown) => Promise<Record<string, unknown>>;
    const syncGet = fakeBrowser.storage.sync.get.bind(fakeBrowser.storage.sync) as (keys?: unknown) => Promise<Record<string, unknown>>;
    const stale = await localGet(['accessToken', 'serverCredentials', AUTH_ORIGINS_KEY]);
    await importServer('https://evil.example');
    vi.spyOn(fakeBrowser.storage.local, 'get').mockImplementationOnce((() => Promise.resolve(stale)) as never);
    vi.spyOn(fakeBrowser.storage.sync, 'get').mockImplementation(((keys: unknown) => syncGet(keys)) as never);
    expect(await getConfig()).toMatchObject({ apiUrl: 'https://evil.example', accessToken: '', heldBackFrom: ['https://evil.example'] });
    expect(await approvals()).toEqual(['https://ntfy.lan']);
  });

  it('never approves an origin named by the file', async () => {
    await fakeBrowser.storage.sync.set({ apiUrl: 'https://ntfy.lan', topics: 'alerts' });
    await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
    await importFile(
      file(
        { apiUrl: 'https://evil.example', topics: ['alerts'], authOrigins: ['https://evil.example'] },
        { authOrigins: ['https://evil.example'] },
      ),
    );
    expect(await approvals()).toEqual(['https://ntfy.lan']);
  });
});

describe('import: confirmation', () => {
  it('previews the server URLs and topic counts without writing anything', async () => {
    await fakeBrowser.storage.sync.set(SYNCED);
    const before = await fakeBrowser.storage.sync.get();
    const set = vi.spyOn(fakeBrowser.storage.sync, 'set');
    const { settings } = parseBackup(file({ apiUrl: 'https://new.example', topics: ['a', 'b', 'c', 'd'] }));
    expect(await previewImport(settings)).toMatchObject({
      apiUrl: { from: 'https://ntfy.lan', to: 'https://new.example' },
      fallbackUrl: { from: 'https://ntfy.example.com/base', to: '' },
      topics: { from: 3, to: 4 },
      heldBackFrom: [],
    });
    expect(set).not.toHaveBeenCalled();
    expect(await fakeBrowser.storage.sync.get()).toEqual(before);
  });

  it('stops when the settings changed between the preview and the confirmation', async () => {
    await fakeBrowser.storage.sync.set(SYNCED);
    const { settings } = parseBackup(file({ apiUrl: 'https://new.example', topics: ['a'] }));
    const { baseline } = await previewImport(settings);
    await fakeBrowser.storage.sync.set({ topics: 'alerts,backups,added-meanwhile' });
    await expect(importSettings(settings, baseline)).rejects.toThrow('The settings changed while the import was waiting');
    expect(await fakeBrowser.storage.sync.get()).toEqual({ ...SYNCED, topics: 'alerts,backups,added-meanwhile' });
  });

  it('validates again when writing: settings handed over unvalidated are not stored raw', async () => {
    const forged = {
      ...SETTINGS,
      apiUrl: 'https://u:p@evil.example/?auth=x',
      topics: ['ok', 'a/b'],
      theme: 'neon',
    } as unknown as BackupSettings;
    await importSettings(forged, (await previewImport(forged)).baseline);
    expect(await fakeBrowser.storage.sync.get(['apiUrl', 'topics', 'theme'])).toEqual({
      apiUrl: 'https://evil.example/',
      topics: 'ok',
      theme: 'auto',
    });
  });
});
