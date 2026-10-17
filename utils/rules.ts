// Per-topic desktop notification rules (storage.sync). A message below its topic's level is still
// stored, listed and counted as unread, without a desktop notification.

import { browser } from 'wxt/browser';
import type { NtfyMessage } from './ntfy';

export const NOTIFY_RULES = ['all', 'default', 'high', 'urgent', 'off'] as const;
export type NotifyRule = (typeof NOTIFY_RULES)[number];
/** Rules by topic. A Map, so any topic name is a plain key (even "__proto__" or "constructor") */
export type TopicRules = Map<string, NotifyRule>;

export const NOTIFY_RULES_KEY = 'notifyRules';

export const RULE_LABELS: Record<NotifyRule, string> = {
  all: 'All',
  default: 'Default and higher',
  high: 'High and urgent',
  urgent: 'Urgent only',
  off: 'Off',
};

/** Lowest priority that shows a desktop notification (ntfy priorities are 1-5, 3 when not set) */
const MIN_PRIORITY: Record<NotifyRule, number> = { all: 1, default: 3, high: 4, urgent: 5, off: 6 };

export function isNotifyRule(value: unknown): value is NotifyRule {
  return typeof value === 'string' && (NOTIFY_RULES as readonly string[]).includes(value);
}

/** Stored as a list of [topic, rule] (not an object keyed by topic) */
export function parseTopicRules(stored: unknown): TopicRules {
  const rules: TopicRules = new Map();
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && isNotifyRule(entry[1])) {
        rules.set(entry[0], entry[1]);
      }
    }
  }
  return rules;
}

export function storedTopicRules(rules: TopicRules): [string, NotifyRule][] {
  return [...rules.entries()];
}

export async function getTopicRules(): Promise<TopicRules> {
  const { [NOTIFY_RULES_KEY]: stored } = await browser.storage.sync.get([NOTIFY_RULES_KEY]);
  return parseTopicRules(stored);
}

export function ruleFor(rules: TopicRules, topic: string): NotifyRule {
  return rules.get(topic) ?? 'all';
}

export function shouldNotify(message: NtfyMessage, rules: TopicRules): boolean {
  return (message.priority ?? 3) >= MIN_PRIORITY[ruleFor(rules, message.topic)];
}
