import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { notifyNewMessage } from '@/utils/notifications';
import type { NtfyMessage } from '@/utils/ntfy';
import { getTopicRules, shouldNotify, type TopicRules } from '@/utils/rules';
import { callsOf, mockResolved } from './helpers/mock';

const message = (topic: string, priority?: number): NtfyMessage => ({ id: `${topic}-${priority}`, event: 'message', topic, time: 1, priority });

beforeEach(() => {
  fakeBrowser.reset();
});

describe('notification rules', () => {
  const rules: TopicRules = { alerts: 'high', coolify: 'off', backups: 'default', pager: 'urgent' };

  it('pops up from the topic level up; all priorities without a rule', () => {
    expect(shouldNotify(message('alerts', 4), rules)).toBe(true);
    expect(shouldNotify(message('alerts', 3), rules)).toBe(false);
    expect(shouldNotify(message('alerts'), rules)).toBe(false); // no priority means 3
    expect(shouldNotify(message('backups'), rules)).toBe(true);
    expect(shouldNotify(message('backups', 2), rules)).toBe(false);
    expect(shouldNotify(message('pager', 5), rules)).toBe(true);
    expect(shouldNotify(message('pager', 4), rules)).toBe(false);
    expect(shouldNotify(message('coolify', 5), rules)).toBe(false);
    expect(shouldNotify(message('other', 1), rules)).toBe(true);
  });

  it('ignores invalid stored rules', async () => {
    await fakeBrowser.storage.sync.set({ notifyRules: { alerts: 'high', bad: 'loud', worse: 3 } });
    expect(await getTopicRules()).toEqual({ alerts: 'high' });
  });

  it('decides the desktop notification for a new message', async () => {
    const create = mockResolved(fakeBrowser.notifications, 'create', '');
    await fakeBrowser.storage.sync.set({ notifyRules: { coolify: 'off' } });
    await notifyNewMessage(message('coolify', 5));
    await notifyNewMessage(message('alerts', 2));
    expect(callsOf<[string]>(create).map(call => call[0])).toEqual(['alerts-2']);
  });
});
