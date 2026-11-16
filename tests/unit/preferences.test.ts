import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_PREFERENCES, getPreferences, parsePreferences } from '@/utils/preferences';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('preferences', () => {
  it("defaults to today's behaviour when nothing is stored", async () => {
    expect(await getPreferences()).toEqual({
      badgeScope: 'all',
      keepUrgentOnScreen: true,
      historyPerTopic: 100,
      messageTimes: 'relative',
      inboxDensity: 'comfortable',
    });
  });

  it('reads valid stored values from storage.sync', async () => {
    const stored = {
      badgeScope: 'notifying',
      keepUrgentOnScreen: false,
      historyPerTopic: 500,
      messageTimes: 'absolute',
      inboxDensity: 'compact',
    };
    await fakeBrowser.storage.sync.set(stored);
    expect(await getPreferences()).toEqual(stored);
  });

  it('falls back to the default for each invalid value, keeping the valid ones', () => {
    expect(
      parsePreferences({
        badgeScope: 'none',
        keepUrgentOnScreen: 'no',
        historyPerTopic: 5000,
        messageTimes: ['absolute'],
        inboxDensity: 'compact',
      }),
    ).toEqual({ ...DEFAULT_PREFERENCES, inboxDensity: 'compact' });
    // A number stored as text, a fraction, or a prototype key is not one of the choices
    for (const historyPerTopic of ['250', 250.5, -1, 0, null, Infinity, '__proto__']) {
      expect(parsePreferences({ historyPerTopic }).historyPerTopic).toBe(100);
    }
  });
});
