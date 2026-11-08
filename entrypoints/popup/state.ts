// State shared by the popup's modules.

import { browser } from 'wxt/browser';
import { getConfig, getStoredAuth, type Credentials, type NtfyMessage } from '@/utils/ntfy';
import { getTopicRules, type TopicRules } from '@/utils/rules';
import type { ReceiverStatus } from '@/utils/status';
import type { StoredFile } from '@/utils/stored-files';
import { getSyncDeletionTopics } from '@/utils/sync-modes';
import { getElements, type Elements } from './dom';

export type Theme = 'light' | 'dark' | 'auto';

/** UI preferences in storage.sync, alongside the server settings from getConfig. */
const SYNC_KEYS = ['theme', 'priority', 'lastTags', 'lastTopic', 'sendAnotherEnabled', 'sendAsZipEnabled'] as const;

export interface PopupState {
  apiUrl: string;
  fallbackUrl: string;
  /** The token and the username and password as stored (the settings form); requests use getConfig */
  accessToken: string;
  credentials: Credentials | null;
  /** Server origins the stored token and password aren't approved for (see getConfig) */
  heldBackFrom: string[];
  topics: string[];
  theme: Theme;
  includeUrl: boolean;
  sendAnotherEnabled: boolean;
  sendAsZipEnabled: boolean;
  lastTopic: string | undefined;
  /** Desktop notification rule per topic */
  notifyRules: TopicRules;
  syncDeletionTopics: Set<string>;
  /** The page the popup was opened on (in the extension's tab: the web page tab used last) */
  page: PageInfo;

  // Send
  tags: string[];
  selectedPriority: number;
  attachments: StoredFile[];
  isSending: boolean;
  /** The tab title last put in the Title field automatically */
  autoTitle: string;
  /** The tab URL last put in the Message field automatically */
  autoMessage: string;

  // Inbox
  receiveFilter: string | null; // null means All topics
  readMessageIds: string[];
  deletedMessageIds: string[];
  /** Messages shown in the inbox, for Mark all read and Delete all */
  currentNotifications: NtfyMessage[];
  /** The background's connection state */
  receiverStatus: ReceiverStatus | null;

  serverAccessMissing: boolean;
}

/** Title and URL of a browser tab */
export interface PageInfo {
  url: string;
  title: string;
}

/** Opened with the header button in a browser tab instead of the toolbar popup */
export const pageParams = new URLSearchParams(location.search);
export const isPageMode = pageParams.get('mode') === 'page';

export const elements: Elements = getElements();

export const state: PopupState = {
  apiUrl: '',
  fallbackUrl: '',
  accessToken: '',
  credentials: null,
  heldBackFrom: [],
  topics: [],
  theme: 'auto',
  includeUrl: false,
  sendAnotherEnabled: false,
  sendAsZipEnabled: false,
  lastTopic: undefined,
  notifyRules: new Map(),
  syncDeletionTopics: new Set(),
  page: { url: '', title: '' },
  tags: [],
  selectedPriority: 3,
  attachments: [],
  isSending: false,
  autoTitle: '',
  autoMessage: '',
  receiveFilter: null,
  readMessageIds: [],
  deletedMessageIds: [],
  currentNotifications: [],
  receiverStatus: null,
  serverAccessMissing: false,
};

export async function loadSettings(): Promise<void> {
  // getConfig first: it moves credentials out of synced URLs, which getStoredAuth then finds
  const [config, items] = await Promise.all([getConfig(), browser.storage.sync.get([...SYNC_KEYS])]);
  const stored = await getStoredAuth();
  state.apiUrl = config.apiUrl;
  state.fallbackUrl = config.fallbackUrl;
  state.accessToken = stored.accessToken;
  state.credentials = stored.credentials;
  state.heldBackFrom = config.heldBackFrom;
  state.topics = config.topics;
  state.includeUrl = config.includeUrl;
  state.theme = items.theme === 'light' || items.theme === 'dark' ? items.theme : 'auto';
  state.sendAnotherEnabled = items.sendAnotherEnabled === true;
  state.sendAsZipEnabled = items.sendAsZipEnabled === true;
  if (typeof items.priority === 'number') {
    state.selectedPriority = items.priority;
  }
  if (typeof items.lastTopic === 'string' && state.topics.includes(items.lastTopic)) {
    state.lastTopic = items.lastTopic;
  }
  if (Array.isArray(items.lastTags)) {
    state.tags = items.lastTags.filter((tag): tag is string => typeof tag === 'string');
  }
  [state.notifyRules, state.syncDeletionTopics] = await Promise.all([getTopicRules(), getSyncDeletionTopics()]);
}

export async function loadReceiveFilter(): Promise<void> {
  const { receiveTopicFilter: stored } = await browser.storage.local.get('receiveTopicFilter');
  // Previous versions stored a plain string and used "all" for All topics.
  if (typeof stored === 'string' && stored !== 'all') state.receiveFilter = stored;
  else if (stored && typeof stored === 'object' && 'topic' in stored && typeof stored.topic === 'string')
    state.receiveFilter = stored.topic;
}

export function inboxTopic(): string | null {
  const topic = state.receiveFilter;
  return topic !== null && state.topics.includes(topic) ? topic : null;
}

export function saveReceiveFilter(topic: string | null): Promise<void> {
  state.receiveFilter = topic;
  return saveLocal({ receiveTopicFilter: topic === null ? null : { topic } });
}

export function saveSync(items: Record<string, unknown>): Promise<void> {
  return browser.storage.sync.set(items);
}

export function saveLocal(items: Record<string, unknown>): Promise<void> {
  return browser.storage.local.set(items);
}

export function isConfigured(): boolean {
  return Boolean(state.apiUrl) && state.topics.length > 0;
}
