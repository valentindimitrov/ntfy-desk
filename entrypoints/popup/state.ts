// State shared by the popup's modules.

import { browser } from 'wxt/browser';
import { getConfig, parseTopics, type NtfyMessage } from '@/utils/ntfy';
import type { StoredFile } from '@/utils/stored-files';
import { getElements, type Elements } from './dom';

export type Theme = 'light' | 'dark' | 'auto';
export type Tab = 'send' | 'receive';

/** Settings in storage.sync, except the access token (storage.local) */
export const SYNC_KEYS = ['topics', 'apiUrl', 'theme', 'priority', 'lastTags', 'lastTopic', 'sendAnotherEnabled', 'includeUrl', 'sendAsZipEnabled'] as const;

export interface PopupState {
  apiUrl: string;
  accessToken: string;
  topics: string[];
  theme: Theme;
  includeUrl: boolean;
  sendAnotherEnabled: boolean;
  sendAsZipEnabled: boolean;
  lastTopic: string | undefined;
  /** URL of the page the popup was opened on (in the extension's tab: the web page tab used last) */
  pageUrl: string;

  // Send tab
  tags: string[];
  selectedPriority: number;
  attachments: StoredFile[];
  isSending: boolean;
  /** The tab URL last put in the Title field automatically */
  autoTitle: string;

  // Receive tab
  activeTab: Tab;
  receiveFilter: string; // a topic, or 'all'
  readMessageIds: string[];
  deletedMessageIds: string[];
  /** Messages shown on the Receive tab, for Mark all read and Delete all */
  currentNotifications: NtfyMessage[];

  serverAccessMissing: boolean;
}

/** Opened with the header button in a browser tab instead of the toolbar popup */
export const pageParams = new URLSearchParams(location.search);
export const isPageMode = pageParams.get('mode') === 'page';

export const elements: Elements = getElements();

export const state: PopupState = {
  apiUrl: '',
  accessToken: '',
  topics: [],
  theme: 'auto',
  includeUrl: false,
  sendAnotherEnabled: false,
  sendAsZipEnabled: false,
  lastTopic: undefined,
  pageUrl: '',
  tags: [],
  selectedPriority: 3,
  attachments: [],
  isSending: false,
  autoTitle: '',
  activeTab: 'send',
  receiveFilter: 'all',
  readMessageIds: [],
  deletedMessageIds: [],
  currentNotifications: [],
  serverAccessMissing: false,
};

export async function loadSettings(): Promise<void> {
  const [config, items] = await Promise.all([getConfig(), browser.storage.sync.get([...SYNC_KEYS])]);
  state.apiUrl = config.apiUrl;
  state.accessToken = config.accessToken;
  state.topics = parseTopics(items.topics);
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
}

export async function loadReceiveState(): Promise<void> {
  const result = await browser.storage.local.get(['readMessageIds', 'deletedMessageIds', 'receiveTopicFilter']);
  state.readMessageIds = (result.readMessageIds as string[] | undefined) ?? [];
  state.deletedMessageIds = (result.deletedMessageIds as string[] | undefined) ?? [];
  state.receiveFilter = typeof result.receiveTopicFilter === 'string' ? result.receiveTopicFilter : 'all';
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
