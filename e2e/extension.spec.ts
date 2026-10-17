import { expect, test } from './fixtures';

test.describe('receiving', () => {
  test('a published message becomes one desktop notification, a listed message and an unread count', async ({
    ntfy,
    configure,
    notified,
    openPopup,
    serviceWorker,
  }) => {
    await configure({ topics: 'alerts' });
    await expect.poll(() => ntfy.subscriptions).toEqual([['alerts']]);

    ntfy.publish('alerts', { title: 'Disk full', message: 'sda at 91%', priority: 4 });
    await expect.poll(async () => (await notified()).map((n) => n.title)).toEqual(['Disk full [↑ High]']);
    await expect.poll(() => serviceWorker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');

    const popup = await openPopup('?tab=receive');
    await expect(popup.locator('.notification-title')).toHaveText(['Disk full']);
    await expect(popup.locator('.status-line')).toHaveText(`Connected to ${new URL(ntfy.url).host}`);

    // The poll after connecting must not notify it again
    await serviceWorker.evaluate(() => chrome.runtime.sendMessage({ action: 'sync' }).catch(() => {}));
    await popup.waitForTimeout(1000);
    expect(await notified()).toHaveLength(1);
  });

  test('subscribes to the readable topics only, and marks the others as send only', async ({ ntfy, configure, openPopup }) => {
    ntfy.unreadable.add('inbox');
    await configure({ topics: 'alerts,inbox' });
    await expect.poll(() => ntfy.subscriptions).toEqual([['alerts']]);

    const popup = await openPopup('?tab=receive');
    await expect(popup.locator('.topic-filter-btn', { hasText: 'inbox' })).toContainText('send only');
  });

  test('fetches messages published while disconnected, and notifies them once', async ({ ntfy, configure, notified, serviceWorker }) => {
    await configure({ topics: 'alerts' });
    await expect.poll(() => ntfy.subscriptions.length).toBe(1);
    // A topic's first sync is silent (it loads history): wait until it is done
    await expect
      .poll(() =>
        serviceWorker.evaluate(
          async () =>
            ((await chrome.storage.local.get('topicSync')).topicSync as { topic: string; synced: boolean }[] | undefined)?.some(
              (state) => state.topic === 'alerts' && state.synced,
            ) === true,
        ),
      )
      .toBe(true);

    ntfy.dropConnections();
    ntfy.publish('alerts', { title: 'While away' });
    // The extension reconnects after 5 s and polls what it missed
    await expect.poll(async () => (await notified()).map((n) => n.title), { timeout: 15_000 }).toEqual(['While away']);
    await expect.poll(() => ntfy.subscriptions.length, { timeout: 15_000 }).toBe(2);
  });

  test('follows the per-topic notification rules', async ({ ntfy, configure, notified, openPopup }) => {
    await configure({ topics: 'alerts,coolify', notifyRules: { coolify: 'off', alerts: 'high' } });
    await expect.poll(() => ntfy.subscriptions).toEqual([['alerts', 'coolify']]);

    ntfy.publish('coolify', { title: 'Deployed', priority: 5 });
    ntfy.publish('alerts', { title: 'Low', priority: 2 });
    ntfy.publish('alerts', { title: 'Urgent', priority: 5 });
    await expect.poll(async () => (await notified()).map((n) => n.title)).toEqual(['Urgent [⇈ Urgent]']);

    // All three are still listed
    const popup = await openPopup('?tab=receive');
    await expect(popup.locator('.notification-item')).toHaveCount(3);
  });
});

test.describe('sending', () => {
  test('sends a message from the popup with title, priority and tags', async ({ ntfy, configure, openPopup }) => {
    await configure({ topics: 'inbox' });
    const popup = await openPopup('?mode=page');
    await popup.locator('#title-input').fill('Grüße');
    await popup.locator('#message-input').fill('Hello from the popup');
    await popup.locator('#advanced-toggle').click();
    await popup.locator('#priority-chips .chip[data-priority="4"]').click();
    await popup.locator('#new-tag-input').fill('laptop');
    await popup.locator('#new-tag-input').press('Enter');
    await popup.locator('#send-btn').click();

    await expect(popup.locator('#status')).toHaveText('Notification sent!');
    expect(ntfy.published).toEqual([
      { topic: 'inbox', body: 'Hello from the popup', headers: { title: 'Grüße', priority: '4', tags: 'laptop' } },
    ]);
  });

  test('saves the settings typed in the settings view, with the token in local storage', async ({ ntfy, openPopup, serviceWorker }) => {
    const popup = await openPopup();
    await popup.locator('#settings-btn').click();
    await popup.locator('#url-input').fill(ntfy.url);
    await popup.locator('#token-input').fill(ntfy.token);
    await popup.locator('#new-topic-input').fill('alerts');
    await popup.locator('#new-topic-input').press('Enter');

    // Saved and picked up by the background: it subscribes
    await expect.poll(() => ntfy.subscriptions, { timeout: 15_000 }).toEqual([['alerts']]);
    const stored = await serviceWorker.evaluate(async () => ({
      sync: await chrome.storage.sync.get(['apiUrl', 'topics', 'accessToken']),
      local: await chrome.storage.local.get(['accessToken']),
    }));
    expect(stored).toEqual({ sync: { apiUrl: ntfy.url, topics: 'alerts' }, local: { accessToken: ntfy.token } });
  });
});

test.describe('fallback server', () => {
  test('receives through the fallback while the main server is down', async ({ ntfy, configure, notified, openPopup }) => {
    // Nothing listens on port 9: the main server is down
    await configure({ apiUrl: 'http://127.0.0.1:9', fallbackUrl: ntfy.url, topics: 'alerts' });
    await expect.poll(() => ntfy.subscriptions, { timeout: 15_000 }).toEqual([['alerts']]);

    ntfy.publish('alerts', { title: 'Via fallback' });
    await expect.poll(async () => (await notified()).map((n) => n.title)).toEqual(['Via fallback']);

    const popup = await openPopup('?tab=receive');
    await expect(popup.locator('.status-line').first()).toHaveText(`Connected to ${new URL(ntfy.url).host} (fallback)`);
  });
});
