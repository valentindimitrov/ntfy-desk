import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  SEND_DEFAULTS_KEY,
  getSendDefaults,
  parseSendDefaults,
  sendDefaultsFit,
  parseTags,
  sameSendDefaults,
  splitTags,
  storedSendDefaults,
} from '@/utils/send-defaults';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('per-topic send defaults', () => {
  it('has none when nothing is stored', async () => {
    expect(await getSendDefaults()).toEqual(new Map());
    for (const stored of [undefined, null, 'alerts', 5, { alerts: { priority: 5, tags: [] } }]) {
      expect(parseSendDefaults(stored)).toEqual(new Map());
    }
  });

  it('reads a list of entries from storage.sync into a Map, and writes it back as a list', async () => {
    const stored = [
      { topic: 'alerts', priority: 5, tags: ['warning', 'server'] },
      { topic: 'notes', priority: 2, tags: [] },
    ];
    await fakeBrowser.storage.sync.set({ [SEND_DEFAULTS_KEY]: stored });
    const defaults = await getSendDefaults();
    expect([...defaults]).toEqual([
      ['alerts', { priority: 5, tags: ['warning', 'server'] }],
      ['notes', { priority: 2, tags: [] }],
    ]);
    expect(storedSendDefaults(defaults)).toEqual(stored);
  });

  it('keeps topics named like object properties as plain keys', () => {
    const defaults = parseSendDefaults([
      { topic: '__proto__', priority: 4, tags: ['a'] },
      { topic: 'constructor', priority: 1, tags: [] },
    ]);
    expect(defaults.get('__proto__')).toEqual({ priority: 4, tags: ['a'] });
    expect(defaults.get('constructor')).toEqual({ priority: 1, tags: [] });
    expect(defaults.get('toString')).toBeUndefined();
  });

  it('drops entries with an invalid topic or priority (another device can write storage.sync)', () => {
    const defaults = parseSendDefaults([
      null,
      'alerts',
      ['alerts', 5],
      { topic: 'a/b?x=1', priority: 3, tags: [] },
      { topic: 'x'.repeat(65), priority: 3, tags: [] },
      { topic: 7, priority: 3, tags: [] },
      { topic: 'zero', priority: 0, tags: [] },
      { topic: 'six', priority: 6, tags: [] },
      { topic: 'half', priority: 2.5, tags: [] },
      { topic: 'text', priority: '5', tags: [] },
      { topic: 'missing' },
      { topic: 'kept', priority: 4 },
    ]);
    expect([...defaults]).toEqual([['kept', { priority: 4, tags: [] }]]);
  });

  it('limits the tags: strings only, trimmed, no commas, no duplicates, 50 characters, 10 tags', () => {
    const [[, entry] = []] = parseSendDefaults([
      {
        topic: 'alerts',
        priority: 3,
        tags: [' a ', 'a', 7, null, '', 'b,c', 'x'.repeat(51), 'y'.repeat(50), ...'defghijklmnop'.split('')],
      },
    ]);
    expect(entry?.tags).toEqual(['a', 'y'.repeat(50), ...'defghijk'.split('')]);
    expect(parseTags('a,b')).toEqual([]);
  });

  it('reads at most 200 entries', () => {
    const stored = Array.from({ length: 250 }, (_, index) => ({ topic: `t${index}`, priority: 3, tags: [] }));
    expect(parseSendDefaults(stored).size).toBe(200);
  });

  it('splits typed tags at commas', () => {
    expect(splitTags(' warning, server ,, warning')).toEqual(['warning', 'server']);
    expect(splitTags('')).toEqual([]);
  });

  it('compares defaults by priority and tag order', () => {
    expect(sameSendDefaults(undefined, undefined)).toBe(true);
    expect(sameSendDefaults({ priority: 3, tags: [] }, undefined)).toBe(false);
    expect(sameSendDefaults({ priority: 3, tags: ['a', 'b'] }, { priority: 3, tags: ['a', 'b'] })).toBe(true);
    expect(sameSendDefaults({ priority: 3, tags: ['a', 'b'] }, { priority: 3, tags: ['b', 'a'] })).toBe(false);
    expect(sameSendDefaults({ priority: 3, tags: [] }, { priority: 4, tags: [] })).toBe(false);
  });

  it('refuses a set too large for one synced item', () => {
    const tags = (topic: number) => Array.from({ length: 10 }, (_, i) => `${topic}-${i}-`.padEnd(50, 'x'));
    const entries = (count: number) =>
      parseSendDefaults(Array.from({ length: count }, (_, i) => ({ topic: `t${i}`, priority: 3, tags: tags(i) })));
    expect(sendDefaultsFit(entries(5))).toBe(true);
    expect(sendDefaultsFit(entries(16))).toBe(false);
  });
});
