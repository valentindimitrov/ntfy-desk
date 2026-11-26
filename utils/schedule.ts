import { browser } from 'wxt/browser';

/** The alarm that reconnects and polls once a minute, also after the service worker was stopped */
export const RECEIVER_ALARM = 'receiver';

export function createReceiverAlarm(): Promise<void> {
  return browser.alarms.create(RECEIVER_ALARM, { periodInMinutes: 1 });
}

/**
 * Install and browser start create the alarm, but a browser can drop alarms (Firefox does when an add-on is
 * disabled and enabled again, which fires neither event): without it, nothing wakes the receiver after a
 * dropped stream. The background checks at every start and runs `setUp` when the alarm is missing.
 */
export async function ensureReceiverAlarm(setUp: () => void): Promise<void> {
  if (!(await browser.alarms.get(RECEIVER_ALARM))) setUp();
}
