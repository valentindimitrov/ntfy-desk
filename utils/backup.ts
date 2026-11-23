// Export and import of the settings in storage.sync as a JSON file: a backup, and a way to another
// browser without browser sync. The file never holds the token, the username and password, the
// approved server origins or anything else from storage.local. An imported file is untrusted input:
// every value goes through the validators used when storage is read, and nothing is written raw.

import { browser } from 'wxt/browser';
import {
  AUTH_ORIGINS_KEY,
  getStoredAuth,
  isHttpUrl,
  isNtfyPathPart,
  parseTopics,
  serverOrigins,
  setAuthOrigins,
  withAuthOriginsLock,
  splitCredentials,
} from './ntfy';
import { PREFERENCE_KEYS, parsePreferences, type Preferences } from './preferences';
import { NOTIFY_RULES_KEY, parseTopicRules, type NotifyRule } from './rules';
import {
  DEFAULT_PRIORITY,
  SEND_DEFAULTS_KEY,
  isPriority,
  parseRememberedTags,
  parseSendDefaults,
  sendDefaultsFit,
  storedSendDefaults,
  type Priority,
  type SendDefaults,
} from './send-defaults';
import { SYNC_DELETION_TOPICS_KEY, parseSyncDeletionTopics } from './sync-modes';

export const BACKUP_FORMAT = 'ntfy-desk-settings';
/** A whole number. A file with a higher one is refused; additions an older reader can ignore don't raise it */
export const BACKUP_VERSION = 1;
/** Checked before the file is read or parsed. All of storage.sync holds about 100 KB */
export const MAX_BACKUP_BYTES = 256 * 1024;

export const THEMES = ['light', 'dark', 'auto'] as const;
export type Theme = (typeof THEMES)[number];

/**
 * The settings of storage.sync, validated. The properties are the storage keys; only `topics` differs
 * (a list here, comma-separated in storage).
 */
export interface BackupSettings extends Preferences {
  apiUrl: string;
  fallbackUrl: string;
  topics: string[];
  includeUrl: boolean;
  notifyRules: [string, NotifyRule][];
  syncDeletionTopics: string[];
  topicSendDefaults: ({ topic: string } & SendDefaults)[];
  theme: Theme;
  /** The priority and tags used last, and the Send form's own topic ('' for none) */
  priority: Priority;
  lastTags: string[];
  lastTopic: string;
  sendAnotherEnabled: boolean;
  sendAsZipEnabled: boolean;
  freezeDividers: boolean;
  rememberSendPanel: boolean;
}

/** Every key of storage.sync, each with the name the import confirmation uses for it */
const SETTING_NAMES: Record<keyof BackupSettings, string> = {
  apiUrl: 'server URL',
  fallbackUrl: 'fallback URL',
  topics: 'topics',
  includeUrl: 'fill in the current tab',
  notifyRules: 'desktop notification rules',
  syncDeletionTopics: 'message sync',
  topicSendDefaults: 'send priorities and tags',
  theme: 'theme',
  priority: 'last priority',
  lastTags: 'last tags',
  lastTopic: 'last send topic',
  sendAnotherEnabled: 'send another',
  sendAsZipEnabled: 'send as ZIP',
  freezeDividers: 'freeze dividers',
  rememberSendPanel: 'remember the Send section',
  badgeScope: 'unread badge',
  keepUrgentOnScreen: 'keep urgent notifications on screen',
  historyPerTopic: 'messages kept per topic',
  messageTimes: 'message times',
  inboxDensity: 'density',
  topicLayout: 'topic list layout',
};
export const BACKUP_KEYS = Object.keys(SETTING_NAMES) as (keyof BackupSettings)[];

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** ISO 8601 */
  exportedAt: string;
  settings: BackupSettings;
}

/** A file that can't be imported; the message is shown to the user */
export class BackupError extends Error {}

export interface SanitizedSettings {
  settings: BackupSettings;
  /** Settings the input had a value for that was invalid or too large: they get their default instead */
  skipped: string[];
  /** A server URL had a username, password, query string or fragment, which was removed and not used */
  urlPartsRemoved: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** storage.sync holds at most 8,192 bytes per item (key and JSON value); kept a little below, as sendDefaultsFit */
const MAX_ITEM_BYTES = 8000;
const fitsSyncItem = (key: string, value: unknown) => byteLength(key + JSON.stringify(value)) <= MAX_ITEM_BYTES;

/**
 * Validated settings from untrusted values (storage.sync as read, or the `settings` of a file).
 * Unknown keys are ignored. A missing value is the default; so is an invalid one, which is also named
 * in `skipped`. Per-topic entries of topics that aren't in the list are dropped.
 */
export function sanitizeSettings(raw: Record<string, unknown>): SanitizedSettings {
  const skipped: string[] = [];
  let urlPartsRemoved = false;
  const skip = (key: keyof BackupSettings, detail = '') => void skipped.push(SETTING_NAMES[key] + detail);

  const serverUrl = (key: 'apiUrl' | 'fallbackUrl'): string => {
    const value = raw[key];
    if (value === undefined || value === '') return '';
    const typed = typeof value === 'string' ? value.trim() : '';
    if (!isHttpUrl(typed)) {
      skip(key);
      return '';
    }
    // Credentials found in a URL are discarded, never used
    const { url } = splitCredentials(typed);
    if (!isHttpUrl(url) || !fitsSyncItem(key, url)) {
      skip(key);
      return '';
    }
    if (url !== typed) urlPartsRemoved = true;
    return url;
  };
  const apiUrl = serverUrl('apiUrl');
  const fallbackUrl = serverUrl('fallbackUrl');

  let topics: string[] = [];
  if (Array.isArray(raw.topics)) {
    const valid = new Set<string>();
    let invalid = 0;
    for (const topic of raw.topics as unknown[]) {
      if (typeof topic === 'string' && isNtfyPathPart(topic)) valid.add(topic);
      else invalid++;
    }
    topics = [...valid];
    if (invalid > 0) skip('topics', ` (${invalid} invalid ${invalid === 1 ? 'name' : 'names'})`);
    if (!fitsSyncItem('topics', topics.join(','))) {
      topics = [];
      skip('topics', ' (too many to store)');
    }
  } else if (raw.topics !== undefined) {
    skip('topics');
  }
  const listed = new Set(topics);

  /** A list setting: skipped when it isn't a list, lost entries (invalid or repeated) or doesn't fit */
  const list = <T>(key: keyof BackupSettings, parse: (value: unknown[]) => T[], keep: (entry: T) => boolean): T[] => {
    const value = raw[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      skip(key);
      return [];
    }
    const parsed = parse(value);
    const kept = parsed.filter(keep);
    if (!fitsSyncItem(key, kept)) {
      skip(key, ' (too large to store)');
      return [];
    }
    if (parsed.length < value.length) skip(key, ' (some entries)');
    return kept;
  };

  const notifyRules = list(
    NOTIFY_RULES_KEY,
    (value) => [...parseTopicRules(value)],
    ([topic]) => listed.has(topic),
  );
  const syncDeletionTopics = list(
    SYNC_DELETION_TOPICS_KEY,
    (value) => [...parseSyncDeletionTopics(value)],
    (topic) => listed.has(topic),
  );
  let topicSendDefaults = list(
    SEND_DEFAULTS_KEY,
    (value) => storedSendDefaults(parseSendDefaults(value)),
    ({ topic }) => listed.has(topic),
  );
  if (!sendDefaultsFit(parseSendDefaults(topicSendDefaults))) {
    topicSendDefaults = [];
    skip(SEND_DEFAULTS_KEY, ' (too large to store)');
  }
  const lastTags = list('lastTags', parseRememberedTags, () => true);

  const flag = (key: 'includeUrl' | 'sendAnotherEnabled' | 'sendAsZipEnabled' | 'freezeDividers' | 'rememberSendPanel'): boolean => {
    const value = raw[key];
    if (value !== undefined && typeof value !== 'boolean') skip(key);
    return value === true;
  };

  let theme: Theme = 'auto';
  if ((THEMES as readonly unknown[]).includes(raw.theme)) theme = raw.theme as Theme;
  else if (raw.theme !== undefined) skip('theme');

  let priority: Priority = DEFAULT_PRIORITY;
  if (isPriority(raw.priority)) priority = raw.priority;
  else if (raw.priority !== undefined) skip('priority');

  // A topic that isn't in the list is dropped like the per-topic entries
  if (raw.lastTopic !== undefined && typeof raw.lastTopic !== 'string') skip('lastTopic');
  const lastTopic = typeof raw.lastTopic === 'string' && listed.has(raw.lastTopic) ? raw.lastTopic : '';

  const preferences = parsePreferences(raw);
  for (const key of PREFERENCE_KEYS) {
    if (raw[key] !== undefined && raw[key] !== preferences[key]) skip(key);
  }

  return {
    settings: {
      apiUrl,
      fallbackUrl,
      topics,
      includeUrl: flag('includeUrl'),
      notifyRules,
      syncDeletionTopics,
      topicSendDefaults,
      theme,
      priority,
      lastTags,
      lastTopic,
      sendAnotherEnabled: flag('sendAnotherEnabled'),
      sendAsZipEnabled: flag('sendAsZipEnabled'),
      freezeDividers: flag('freezeDividers'),
      rememberSendPanel: flag('rememberSendPanel'),
      ...preferences,
    },
    skipped,
    urlPartsRemoved,
  };
}

/** The settings as they are in storage.sync now, validated as the app reads them */
export async function readSyncedSettings(): Promise<BackupSettings> {
  const stored = await browser.storage.sync.get([...BACKUP_KEYS]);
  return sanitizeSettings({ ...stored, topics: parseTopics(stored.topics) }).settings;
}

/** The export: only storage.sync is read, so no credential or message can end up in it */
export async function buildBackup(now = new Date()): Promise<BackupFile> {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now.toISOString(), settings: await readSyncedSettings() };
}

export function backupFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `ntfy-desk-settings-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

export interface ParsedBackup extends SanitizedSettings {
  /** When the file says it was exported; null when it doesn't say so readably */
  exportedAt: Date | null;
}

const TOO_LARGE = `This file is too large to be an ntfy Desk settings file (over ${MAX_BACKUP_BYTES / 1024} KiB).`;

/** The text of a settings file, checked and validated; throws a BackupError for a file that can't be used */
export function parseBackup(text: string): ParsedBackup {
  if (text.length > MAX_BACKUP_BYTES || byteLength(text) > MAX_BACKUP_BYTES) throw new BackupError(TOO_LARGE);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError('This file is not valid JSON.');
  }
  if (!isRecord(data) || data.format !== BACKUP_FORMAT) throw new BackupError('This is not an ntfy Desk settings file.');
  const { version, settings, exportedAt } = data;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new BackupError('This settings file has no usable version number.');
  }
  if (version > BACKUP_VERSION) {
    throw new BackupError(
      `This settings file was made by a newer version of ntfy Desk (format ${version}; this version reads format ${BACKUP_VERSION}). Update the extension, then import it again.`,
    );
  }
  if (!isRecord(settings)) throw new BackupError('This settings file contains no settings.');
  const exported = typeof exportedAt === 'string' && exportedAt.length <= 40 ? new Date(exportedAt) : null;
  return { ...sanitizeSettings(settings), exportedAt: exported && !Number.isNaN(exported.getTime()) ? exported : null };
}

/** The size is checked before the file is read */
export async function readBackupFile(file: Blob): Promise<ParsedBackup> {
  if (file.size > MAX_BACKUP_BYTES) throw new BackupError(TOO_LARGE);
  return parseBackup(await file.text());
}

export interface ImportPreview {
  apiUrl: { from: string; to: string };
  fallbackUrl: { from: string; to: string };
  topics: { from: number; to: number };
  /** Messages kept per topic: lowering it deletes older messages */
  historyPerTopic: { from: number; to: number };
  /** Imported server origins the stored token or password won't be sent to until the user confirms */
  heldBackFrom: string[];
  /** The current settings, to notice a change between this preview and the import */
  baseline: string;
}

/** Whether a token or password is stored, and the origins approved for them (null: none recorded yet) */
async function storedApproval(): Promise<{ authenticated: boolean; approved: unknown[] | null }> {
  const [auth, local] = await Promise.all([getStoredAuth(), browser.storage.local.get(AUTH_ORIGINS_KEY)]);
  const approved: unknown = local[AUTH_ORIGINS_KEY];
  return { authenticated: Boolean(auth.accessToken || auth.credentials), approved: Array.isArray(approved) ? approved : null };
}

/** What an import would change, for the confirmation; writes nothing */
export async function previewImport(settings: BackupSettings): Promise<ImportPreview> {
  const [current, { authenticated, approved }] = await Promise.all([readSyncedSettings(), storedApproval()]);
  // Without recorded approvals, the servers configured now are the approved ones (see importSettings)
  const allowed = approved ?? serverOrigins(current.apiUrl, current.fallbackUrl);
  return {
    apiUrl: { from: current.apiUrl, to: settings.apiUrl },
    fallbackUrl: { from: current.fallbackUrl, to: settings.fallbackUrl },
    topics: { from: current.topics.length, to: settings.topics.length },
    historyPerTopic: { from: current.historyPerTopic, to: settings.historyPerTopic },
    heldBackFrom: authenticated ? serverOrigins(settings.apiUrl, settings.fallbackUrl).filter((origin) => !allowed.includes(origin)) : [],
    baseline: JSON.stringify(current),
  };
}

/**
 * Replace the settings in storage.sync with validated ones, in one write: every key is set, so nothing
 * of the previous settings stays. Call it under the settings lock. `baseline` is the preview's: the
 * import stops if the settings changed since the user saw what it would replace.
 *
 * An import never approves a server for a token or password, stored now or saved later. With approvals
 * recorded, getConfig holds the credentials back from an imported origin that isn't among them. Without
 * (they are recorded the first time getConfig runs with credentials and a server), getConfig would
 * approve whatever servers it finds next, which would be the imported ones: so the servers configured
 * before the import are recorded first, possibly none, whether or not credentials are stored yet. Both
 * writes happen under the lock getConfig takes to record approvals, so a concurrent read can't see the
 * imported servers without them.
 */
export async function importSettings(settings: BackupSettings, baseline: string): Promise<void> {
  // Validated again here, so nothing reaches storage that didn't go through the validators
  const { settings: valid } = sanitizeSettings({ ...settings });
  await withAuthOriginsLock(async () => {
    const [current, { approved }] = await Promise.all([readSyncedSettings(), storedApproval()]);
    if (JSON.stringify(current) !== baseline) {
      throw new BackupError('The settings changed while the import was waiting. Choose the file again.');
    }
    if (!approved) await setAuthOrigins(serverOrigins(current.apiUrl, current.fallbackUrl));
    await browser.storage.sync.set({ ...valid, topics: valid.topics.join(',') });
  });
}
