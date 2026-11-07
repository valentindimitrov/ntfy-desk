import type { Browser } from 'wxt/browser';
import { expect, test } from './fixtures';

test.describe('receiving', () => {
  test('syncs server deletions only for topics opted in through settings', async ({ ntfy, configure, openPopup, serviceWorker }) => {
    await configure({ topics: 'alerts,backups' });
    await expect.poll(() => ntfy.subscriptions).toEqual([['alerts', 'backups']]);

    const popup = await openPopup('?tab=receive');
    await popup.locator('#settings-btn').click();
    const alertsMode = popup.getByLabel('Message sync for alerts');
    const backupsMode = popup.getByLabel('Message sync for backups');
    await expect(alertsMode).toHaveValue('keep');
    await expect(backupsMode).toHaveValue('keep');
    await alertsMode.selectOption('sync');
    await expect
      .poll(() => serviceWorker.evaluate(() => chrome.storage.sync.get('syncDeletionTopics')))
      .toEqual({ syncDeletionTopics: ['alerts'] });
    await popup.locator('#back-btn').click();

    const sequence_id = 'deploy';
    ntfy.publish('alerts', { title: 'Synced', sequence_id });
    ntfy.publish('backups', { title: 'Kept', sequence_id });
    await expect(popup.locator('.notification-title')).toHaveCount(2);
    await expect.poll(() => serviceWorker.evaluate(() => chrome.action.getBadgeText({}))).toBe('2');

    ntfy.deleteNotification('backups', sequence_id);
    ntfy.deleteNotification('alerts', sequence_id);
    await expect(popup.locator('.notification-title')).toHaveText(['Kept']);
    await expect.poll(() => serviceWorker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  });

  test('deletes opted-in sequences on the server and reports denied deletes in Receive', async ({
    ntfy,
    configure,
    openPopup,
    serviceWorker,
  }) => {
    ntfy.readOnly.add('readonly');
    await configure({ topics: 'alerts,backups,readonly' });
    await serviceWorker.evaluate(() => chrome.storage.sync.set({ syncDeletionTopics: ['alerts', 'readonly'] }));
    await expect.poll(() => ntfy.subscriptions).toEqual([['alerts', 'backups', 'readonly']]);

    const popup = await openPopup('?tab=receive');
    ntfy.publish('alerts', { title: 'One sequence', sequence_id: 'custom-sequence' });
    await expect(popup.locator('.notification-title')).toHaveText(['One sequence']);
    await popup.locator('.delete-btn').click();
    const serverDeletions = () =>
      ntfy.messages.filter((event) => event.event === 'message_delete').map((event) => [event.topic, event.sequence_id]);
    await expect.poll(serverDeletions).toEqual([['alerts', 'custom-sequence']]);

    const other = ntfy.publish('alerts', { title: 'Another alert' });
    ntfy.publish('backups', { title: 'Local only' });
    ntfy.publish('readonly', { title: 'Denied' });
    await expect(popup.locator('.notification-title')).toHaveCount(3);
    popup.once('dialog', (dialog) => dialog.accept());
    await popup.locator('#delete-all-btn').click();

    await expect(popup.locator('.notification-title')).toHaveCount(0);
    const status = popup.locator('#receive-action-status');
    await expect(status).toHaveText('Deleted here. The server denied deletion.');
    await expect(status).toBeVisible();
    expect(serverDeletions()).toEqual([
      ['alerts', 'custom-sequence'],
      ['alerts', other.id],
    ]);
  });

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
    await expect(popup.locator('header #header-connection')).toHaveText(`Connected to ${new URL(ntfy.url).host}`);

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
  test('shows the inbox beside Send and switches between linked and independent destinations', async ({ ntfy, configure, openPopup }) => {
    await configure({ topics: 'alerts,backups' });
    const page = await openPopup('?mode=page');
    await page.setViewportSize({ width: 1100, height: 720 });
    const inbox = page.getByRole('region', { name: 'Inbox' });
    const message = page.getByLabel('Message', { exact: true });
    const destination = page.getByLabel('Send to');
    await expect(inbox).toBeVisible();
    await expect(message).toBeVisible();
    expect((await inbox.boundingBox())!.x).toBeLessThan((await message.boundingBox())!.x);

    await destination.selectOption('backups');
    await message.fill('Check disk space');
    await page.getByRole('button', { name: 'alerts', exact: true }).click();
    await expect(destination).toHaveValue('alerts');
    await expect(destination).toBeDisabled();
    await page.getByRole('button', { name: 'All topics', exact: true }).click();
    await expect(destination).toHaveValue('backups');
    await expect(destination).toBeEnabled();
    await expect(message).toHaveValue('Check disk space');

    await page.getByRole('button', { name: 'alerts', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search messages' }).press('ControlRight+Enter');
    await expect(message).toHaveValue('Check disk space');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Notification sent!');
    expect(ntfy.published).toMatchObject([{ topic: 'alerts', body: 'Check disk space' }]);
  });

  test('keeps a draft in the toolbar composer when the inbox topic changes', async ({ configure, openPopup, serviceWorker }) => {
    await configure({ topics: 'alerts,backups' });
    await serviceWorker.evaluate(() => chrome.storage.local.set({ receiveTopicFilter: { topic: 'backups' } }));
    const popup = await openPopup();
    await popup.setViewportSize({ width: 768, height: 496 });
    const message = popup.getByLabel('Message', { exact: true });
    const destination = popup.getByLabel('Send to');
    await expect(message).toBeVisible();
    await expect(destination).toHaveValue('backups');
    await expect(destination).toBeDisabled();

    await message.fill('Keep this draft');
    await popup.getByRole('button', { name: 'All topics', exact: true }).click();
    await expect(destination).toBeEnabled();
    await expect(message).toHaveValue('Keep this draft');
  });

  test('the native toolbar popup opens wide with topics, inbox, and Send side by side', async ({
    configure,
    ntfy,
    openPopup,
    serviceWorker,
  }) => {
    const topic = 'w'.repeat(64);
    await configure({ topics: topic + ',nightly-backups,container-alerts,build-notifications' });
    for (let index = 0; index < 7; index++) {
      ntfy.publish('container-alerts', { title: 'Earlier alert ' + index, message: 'Short alert.' });
    }
    const message = 'Review this container update. '.repeat(20).trimEnd();
    ntfy.publish(topic, { title: 'Container update needed', message });
    const tab = await openPopup('?mode=page');
    await expect(tab.locator('.notification-title')).toHaveCount(8);

    // Opening popup.html in a tab bypasses native popup sizing.
    await serviceWorker.evaluate(() => chrome.action.openPopup());
    const measurePopup = () =>
      tab.evaluate(() => {
        const [popup] = chrome.extension.getViews({ type: 'popup' as Browser.extension.ViewType }) as (typeof window)[];
        if (!popup) return null;
        const { document } = popup;
        const topics = document.querySelector('#topic-sidebar')?.getBoundingClientRect();
        const inbox = document.querySelector('#notifications-section')?.getBoundingClientRect();
        const composer = document.querySelector('.send-section')?.getBoundingClientRect();
        const card = [...document.querySelectorAll('.notification-item')].find(
          (item) => item.querySelector('.notification-title')?.textContent === 'Container update needed',
        );
        return {
          width: popup.innerWidth,
          documentFits: document.documentElement.scrollWidth === popup.innerWidth,
          sideBySide: Boolean(topics && inbox && composer && topics.right <= inbox.left && inbox.right <= composer.left),
          connectionInHeader: document.querySelector('header #header-connection')?.textContent?.startsWith('Connected to '),
          advancedOpen: document.querySelector('#advanced-options')?.classList.contains('visible'),
          message: card?.querySelector('.notification-message')?.textContent,
        };
      });
    const fitted = { width: 768, documentFits: true, sideBySide: true, connectionInHeader: true, message };
    await expect.poll(measurePopup).toEqual({ ...fitted, advancedOpen: false });
    await tab.evaluate(() => {
      const [popup] = chrome.extension.getViews({ type: 'popup' as Browser.extension.ViewType }) as (typeof window)[];
      popup?.document.querySelector<HTMLElement>('#advanced-toggle')?.click();
    });
    await expect.poll(measurePopup).toEqual({ ...fitted, advancedOpen: true });
  });

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
    await expect(popup.locator('header #header-connection')).toHaveText(`Connected to ${new URL(ntfy.url).host} (fallback)`);
  });
});
