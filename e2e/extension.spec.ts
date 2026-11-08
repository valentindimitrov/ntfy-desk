import type { Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { expect, test } from './fixtures';

async function dragDivider(page: Page, name: string, dx: number): Promise<void> {
  const { x, y, width } = (await page.getByRole('separator', { name }).boundingBox())!;
  const center = x + width / 2;
  await page.mouse.move(center, y + 20);
  await page.mouse.down();
  await page.mouse.move(center + dx, y + 20, { steps: 5 });
  await page.mouse.up();
}

test.describe('receiving', () => {
  test('applies the topic table and replays cached deletions for existing messages', async ({
    ntfy,
    configure,
    openPopup,
    serviceWorker,
  }) => {
    await configure({ topics: 'alerts' });
    const popup = await openPopup();
    const old = ntfy.publish('alerts', { title: 'Old alert' });
    await expect(popup.locator('.notification-title')).toHaveText('Old alert');
    const deletion = ntfy.deleteNotification('alerts', old.id);
    ntfy.publish('alerts', { title: 'Current alert', time: deletion.time + 1 });
    await expect
      .poll(async () => {
        // A sync request can join a startup poll that began before these events were published.
        await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'sync' }));
        return serviceWorker.evaluate(async () => {
          const { topicSync } = await chrome.storage.local.get('topicSync');
          return (topicSync as { since: number }[] | undefined)?.[0]?.since;
        });
      })
      .toBe(deletion.time + 1);
    await expect(popup.locator('.notification-title')).toHaveCount(2);

    const actionStyle = (button: Element) => {
      const { backgroundColor, borderRadius, color, fontSize, fontWeight, padding } = getComputedStyle(button);
      return { backgroundColor, borderRadius, color, fontSize, fontWeight, padding };
    };
    const sendStyle = await popup.locator('#send-btn').evaluate(actionStyle);
    expect(await popup.locator('#file-btn').evaluate(actionStyle)).toEqual(sendStyle);
    await popup.locator('#settings-btn').click();
    const table = popup.getByRole('table', { name: 'Topic settings' });
    await expect(table.getByRole('columnheader')).toHaveText(['Topic', 'Message sync', 'Desktop notifications']);
    await table.getByLabel('Message sync for alerts').selectOption('sync');
    await table.getByLabel('Desktop notifications for alerts').selectOption('off');
    expect(await serviceWorker.evaluate(() => chrome.storage.sync.get('syncDeletionTopics'))).toEqual({});
    const apply = popup.getByRole('button', { name: 'Apply', exact: true });
    await expect.poll(() => apply.evaluate(actionStyle)).toEqual(sendStyle);
    await apply.click();
    await expect(popup.locator('#topic-settings-status')).toContainText('Applied');
    await popup.locator('#back-btn').click();
    await expect(popup.locator('.notification-title')).toHaveText(['Current alert']);
    await expect(popup.locator('.topic-muted')).toBeVisible();
  });

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
    await popup.getByRole('button', { name: 'Apply', exact: true }).click();
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

  test('keeps the toolbar draft when the composer collapses or the inbox topic changes', async ({
    configure,
    openPopup,
    serviceWorker,
  }) => {
    await configure({ topics: 'alerts,backups' });
    await serviceWorker.evaluate(() => chrome.storage.local.set({ receiveTopicFilter: { topic: 'backups' } }));
    const popup = await openPopup();
    await popup.setViewportSize({ width: 800, height: 580 });
    const message = popup.getByLabel('Message', { exact: true });
    const destination = popup.getByLabel('Send to');
    await expect(message).toBeVisible();
    await expect(destination).toHaveValue('backups');
    await expect(destination).toBeDisabled();

    const topicsDivider = popup.getByRole('separator', { name: 'Resize topics' });
    const sendDivider = popup.getByRole('separator', { name: 'Resize Send' });
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', '120');
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '260');
    await dragDivider(popup, 'Resize topics', 32);
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', '152');
    await dragDivider(popup, 'Resize Send', -32);
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '292');

    await message.fill('Keep this draft');
    const inbox = popup.getByRole('region', { name: 'Inbox' });
    const openWidth = (await inbox.boundingBox())!.width;
    const summary = popup.locator('#send-section summary');
    await summary.press('Enter');
    await expect(message).toBeHidden();
    await expect(sendDivider).toBeHidden();
    await expect(inbox).toBeVisible();
    expect((await inbox.boundingBox())!.width).toBeGreaterThan(openWidth);
    const rail = (await summary.boundingBox())!;
    expect(rail.width).toBeLessThanOrEqual(44);
    expect(rail.x + rail.width).toBeCloseTo(800);
    await summary.press('Space');
    await expect(message).toBeVisible();
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '292');
    await popup.getByRole('button', { name: 'All topics', exact: true }).click();
    await expect(destination).toBeEnabled();
    await expect(message).toHaveValue('Keep this draft');

    await popup.reload();
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', '152');
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '292');
    const tab = await openPopup('?mode=page');
    await tab.setViewportSize({ width: 1600, height: 900 });
    await expect(tab.getByRole('separator', { name: 'Resize topics' })).toHaveAttribute('aria-valuenow', '144');
    await expect(tab.getByRole('separator', { name: 'Resize Send' })).toHaveAttribute('aria-valuenow', '512');
  });

  test('resizes both tab dividers and restores pane widths after reload and viewport changes', async ({ configure, openPopup }) => {
    await configure({ topics: 'alerts,backups' });
    const page = await openPopup('?mode=page');
    await page.setViewportSize({ width: 1600, height: 900 });
    const topicsDivider = page.getByRole('separator', { name: 'Resize topics' });
    const sendDivider = page.getByRole('separator', { name: 'Resize Send' });
    const topics = page.getByRole('navigation', { name: 'Topics' });
    const send = page.locator('#send-section');
    const inbox = page.locator('#notifications-section');
    await expect(topicsDivider).toBeVisible();
    await expect(sendDivider).toBeVisible();
    const bounds = (await page.locator('#main-view').boundingBox())!;
    expect(bounds).toMatchObject({ x: 0, width: 1600 });
    expect(bounds.y + bounds.height).toBe(900);
    const topicsWidth = (await topics.boundingBox())!.width;
    const sendWidth = Math.round((await send.boundingBox())!.width);
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', String(topicsWidth));
    await expect(sendDivider).toHaveAttribute('aria-valuenow', String(sendWidth));
    await dragDivider(page, 'Resize topics', 80);
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', String(topicsWidth + 80));
    expect(Math.round((await send.boundingBox())!.width)).toBe(sendWidth);
    await dragDivider(page, 'Resize Send', -80);
    await expect(sendDivider).toHaveAttribute('aria-valuenow', String(sendWidth + 80));
    expect((await topics.boundingBox())!.width).toBe(topicsWidth + 80);
    await sendDivider.press('ArrowRight');
    await expect(sendDivider).toHaveAttribute('aria-valuenow', String(sendWidth + 64));

    const summary = send.locator('summary');
    const openInboxWidth = (await inbox.boundingBox())!.width;
    await summary.click();
    await expect(sendDivider).toBeHidden();
    expect((await inbox.boundingBox())!.width).toBeGreaterThan(openInboxWidth);
    await summary.click();
    await expect(sendDivider).toHaveAttribute('aria-valuenow', String(sendWidth + 64));

    await page.reload();
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', String(topicsWidth + 80));
    await expect(sendDivider).toHaveAttribute('aria-valuenow', String(sendWidth + 64));
    await page.setViewportSize({ width: 960, height: 900 });
    await expect(sendDivider).toBeVisible();
    expect((await inbox.boundingBox())!.width).toBeGreaterThanOrEqual(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(960);
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(topicsDivider).toBeHidden();
    await expect(sendDivider).toBeVisible();
    await page.setViewportSize({ width: 740, height: 900 });
    await expect(sendDivider).toBeHidden();
    expect((await inbox.boundingBox())!.y).toBeLessThan((await send.boundingBox())!.y);
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', String(topicsWidth + 80));
    await expect(sendDivider).toHaveAttribute('aria-valuenow', String(sendWidth + 64));
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
        const sendSection = document.querySelector<HTMLDetailsElement>('#send-section');
        const composer = sendSection?.getBoundingClientRect();
        const card = [...document.querySelectorAll('.notification-item')].find(
          (item) => item.querySelector('.notification-title')?.textContent === 'Container update needed',
        );
        return {
          width: popup.innerWidth,
          taller: popup.innerHeight >= 550,
          documentFits: document.documentElement.scrollWidth === popup.innerWidth,
          sideBySide: Boolean(topics && inbox && composer && topics.right <= inbox.left && inbox.right <= composer.left),
          connectionInHeader: document.querySelector('header #header-connection')?.textContent?.startsWith('Connected to '),
          composerOpen: sendSection?.open,
          topicsWidth: topics?.width,
          sendWidth: composer?.width,
          topicsDivider: Boolean(document.querySelector('#topic-divider')?.getBoundingClientRect().width),
          sendDivider: Boolean(document.querySelector('#send-divider')?.getBoundingClientRect().width),
          message: card?.querySelector('.notification-message')?.textContent,
        };
      });
    const fitted = {
      width: 800,
      taller: true,
      documentFits: true,
      sideBySide: true,
      connectionInHeader: true,
      topicsDivider: true,
      message,
    };
    await expect.poll(measurePopup).toEqual({ ...fitted, composerOpen: true, sendDivider: true, topicsWidth: 120, sendWidth: 260 });
    await tab.evaluate(() => {
      const [popup] = chrome.extension.getViews({ type: 'popup' as Browser.extension.ViewType }) as (typeof window)[];
      if (!popup) return;
      popup.document.querySelector('#topic-divider')?.dispatchEvent(new popup.KeyboardEvent('keydown', { key: 'ArrowRight' }));
      popup.document.querySelector('#send-divider')?.dispatchEvent(new popup.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });
    const resized = { ...fitted, composerOpen: true, sendDivider: true, topicsWidth: 136, sendWidth: 276 };
    await expect.poll(measurePopup).toEqual(resized);
    const toggleComposer = () =>
      tab.evaluate(() => {
        const [popup] = chrome.extension.getViews({ type: 'popup' as Browser.extension.ViewType }) as (typeof window)[];
        popup?.document.querySelector<HTMLElement>('#send-section summary')?.click();
      });
    await toggleComposer();
    await expect.poll(measurePopup).toEqual({ ...resized, composerOpen: false, sendDivider: false, sendWidth: 44 });
    await toggleComposer();
    await expect.poll(measurePopup).toEqual(resized);
  });

  test('sends a message from the popup with title, priority and tags', async ({ ntfy, configure, openPopup }) => {
    await configure({ topics: 'inbox' });
    const popup = await openPopup();
    await popup.setViewportSize({ width: 800, height: 580 });
    const sendDivider = popup.getByRole('separator', { name: 'Resize Send' });
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '260');
    await sendDivider.press('Home');
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '240');
    const priority = popup.getByRole('group', { name: 'Priority' });
    const buttons = priority.getByRole('button');
    await expect(buttons).toHaveText(['', '', '', '', '']);
    const rowPositions = await buttons.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
    expect(new Set(rowPositions).size).toBe(1);
    const defaultPriority = priority.getByRole('button', { name: 'Default' });
    await expect(defaultPriority).toHaveAttribute('aria-pressed', 'true');
    await popup.locator('#title-input').fill('Grüße');
    await popup.locator('#message-input').fill('Hello from the popup');
    const highPriority = priority.getByRole('button', { name: 'High' });
    await highPriority.hover();
    await expect(popup.locator('#tooltip')).toHaveText('High');
    await highPriority.click();
    await expect(highPriority).toHaveAttribute('aria-pressed', 'true');
    await expect(defaultPriority).toHaveAttribute('aria-pressed', 'false');
    const tags = popup.getByLabel('Tags', { exact: true });
    await tags.fill('laptop');
    await tags.press('Enter');
    await popup.getByLabel('Send another').check();
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
