import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { RECEIVER_ALARM, createReceiverAlarm, ensureReceiverAlarm } from '@/utils/schedule';

describe('receiver alarm', () => {
  beforeEach(() => fakeBrowser.reset());

  it('runs the set-up when the alarm is missing, for example after the browser dropped it', async () => {
    const setUp = vi.fn(() => void createReceiverAlarm());
    await ensureReceiverAlarm(setUp);
    expect(setUp).toHaveBeenCalledTimes(1);
    expect((await fakeBrowser.alarms.get(RECEIVER_ALARM))?.periodInMinutes).toBe(1);
  });

  it('leaves an existing alarm alone', async () => {
    await createReceiverAlarm();
    const setUp = vi.fn();
    await ensureReceiverAlarm(setUp);
    expect(setUp).not.toHaveBeenCalled();
  });
});
