// Customization preferences (storage.sync): the unread badge's scope, notification persistence, the
// history limit and the inbox display. A missing or invalid stored value reads as the default.

import { browser } from 'wxt/browser';

export const BADGE_SCOPES = ['all', 'notifying'] as const;
/** all: every topic; notifying: topics whose desktop notification rule isn't off */
export type BadgeScope = (typeof BADGE_SCOPES)[number];

/** Received messages kept per topic, so a busy topic doesn't push the others out */
export const HISTORY_LIMITS = [50, 100, 250, 500] as const;
export type HistoryLimit = (typeof HISTORY_LIMITS)[number];
export const DEFAULT_HISTORY_PER_TOPIC: HistoryLimit = 100;

export const MESSAGE_TIMES = ['relative', 'absolute'] as const;
export type MessageTimes = (typeof MESSAGE_TIMES)[number];

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export interface Preferences {
  badgeScope: BadgeScope;
  /** requireInteraction for high and urgent notifications (Chromium only) */
  keepUrgentOnScreen: boolean;
  historyPerTopic: HistoryLimit;
  messageTimes: MessageTimes;
  inboxDensity: Density;
}

/** The storage.sync keys are the property names */
export const PREFERENCE_KEYS = ['badgeScope', 'keepUrgentOnScreen', 'historyPerTopic', 'messageTimes', 'inboxDensity'] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  badgeScope: 'all',
  keepUrgentOnScreen: true,
  historyPerTopic: DEFAULT_HISTORY_PER_TOPIC,
  messageTimes: 'relative',
  inboxDensity: 'comfortable',
};

function oneOf<T>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function parsePreferences(stored: Record<string, unknown>): Preferences {
  return {
    badgeScope: oneOf(BADGE_SCOPES, stored.badgeScope, DEFAULT_PREFERENCES.badgeScope),
    keepUrgentOnScreen: stored.keepUrgentOnScreen !== false,
    historyPerTopic: oneOf(HISTORY_LIMITS, stored.historyPerTopic, DEFAULT_PREFERENCES.historyPerTopic),
    messageTimes: oneOf(MESSAGE_TIMES, stored.messageTimes, DEFAULT_PREFERENCES.messageTimes),
    inboxDensity: oneOf(DENSITIES, stored.inboxDensity, DEFAULT_PREFERENCES.inboxDensity),
  };
}

export async function getPreferences(): Promise<Preferences> {
  return parsePreferences(await browser.storage.sync.get([...PREFERENCE_KEYS]));
}
