// Per-topic send defaults (storage.sync): the priority and tags the composer starts a message with
// for a topic. A topic without an entry uses the priority and tags used last (`priority`, `lastTags`).

import { browser } from 'wxt/browser';
import { isNtfyPathPart } from './ntfy';

export const SEND_DEFAULTS_KEY = 'topicSendDefaults';

export const PRIORITIES = [1, 2, 3, 4, 5] as const;
export type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_PRIORITY: Priority = 3;
export const PRIORITY_LABELS: Record<Priority, string> = { 1: 'Min', 2: 'Low', 3: 'Default', 4: 'High', 5: 'Urgent' };

/** Limits for values another device can write through browser sync */
export const MAX_DEFAULT_TAGS = 10;
export const MAX_TAG_LENGTH = 50;
const MAX_ENTRIES = 200;

export interface SendDefaults {
  priority: Priority;
  /** In order, without duplicates; may be empty (the topic then starts without tags) */
  tags: string[];
}
/** Defaults by topic. A Map, so any topic name is a plain key (even "__proto__" or "constructor") */
export type TopicSendDefaults = Map<string, SendDefaults>;

export function isPriority(value: unknown): value is Priority {
  return (PRIORITIES as readonly unknown[]).includes(value);
}

/** Usable tags of a list: trimmed strings without commas (ntfy separates tags with them), no duplicates */
export function parseTags(value: unknown, maxTags = MAX_DEFAULT_TAGS): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (tag && tag.length <= MAX_TAG_LENGTH && !tag.includes(',') && !tags.includes(tag)) tags.push(tag);
    if (tags.length === maxTags) break;
  }
  return tags;
}

/** Tags typed as "a, b, c" */
export function splitTags(text: string): string[] {
  return parseTags(text.split(','));
}

/** storage.sync `priority`: the priority used last; the default for anything else */
export function parseRememberedPriority(stored: unknown): Priority {
  return isPriority(stored) ? stored : DEFAULT_PRIORITY;
}

/** storage.sync `lastTags`: the tags used last */
export function parseRememberedTags(stored: unknown): string[] {
  return Array.isArray(stored) ? stored.filter((tag): tag is string => typeof tag === 'string') : [];
}

/** Stored as a list of { topic, priority, tags } (not an object keyed by topic); invalid entries are dropped */
export function parseSendDefaults(stored: unknown): TopicSendDefaults {
  const defaults: TopicSendDefaults = new Map();
  if (!Array.isArray(stored)) return defaults;
  for (const entry of stored.slice(0, MAX_ENTRIES) as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { topic, priority, tags } = entry as Record<string, unknown>;
    if (typeof topic !== 'string' || !isNtfyPathPart(topic) || !isPriority(priority)) continue;
    defaults.set(topic, { priority, tags: parseTags(tags) });
  }
  return defaults;
}

export function storedSendDefaults(defaults: TopicSendDefaults): ({ topic: string } & SendDefaults)[] {
  return [...defaults].map(([topic, { priority, tags }]) => ({ topic, priority, tags: [...tags] }));
}

/** storage.sync holds at most 8,192 bytes per item (key and JSON value); kept a little below */
const MAX_STORED_BYTES = 8000;

/** Whether the defaults fit in their storage.sync item */
export function sendDefaultsFit(defaults: TopicSendDefaults): boolean {
  const json = JSON.stringify(storedSendDefaults(defaults));
  return new TextEncoder().encode(SEND_DEFAULTS_KEY + json).length <= MAX_STORED_BYTES;
}

export async function getSendDefaults(): Promise<TopicSendDefaults> {
  const { [SEND_DEFAULTS_KEY]: stored } = await browser.storage.sync.get([SEND_DEFAULTS_KEY]);
  return parseSendDefaults(stored);
}

export function sameSendDefaults(a: SendDefaults | undefined, b: SendDefaults | undefined): boolean {
  if (!a || !b) return a === b;
  return a.priority === b.priority && a.tags.length === b.tags.length && a.tags.every((tag, index) => tag === b.tags[index]);
}
