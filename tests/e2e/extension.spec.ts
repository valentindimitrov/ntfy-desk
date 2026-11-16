import type { Page, Worker } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { expect, test } from './fixtures';
import { startNtfyServer } from './ntfy-server';

async function dragDivider(page: Page, name: string, dx: number): Promise<void> {
  const { x, y, width } = (await page.getByRole('separator', { name }).boundingBox())!;
  const center = x + width / 2;
  await page.mouse.move(center, y + 20);
  await page.mouse.down();
  await page.mouse.move(center + dx, y + 20, { steps: 5 });
  await page.mouse.up();
}

async function waitForInitialSync(worker: Worker, topics: string[]): Promise<void> {
  await expect
    .poll(() =>
      worker.evaluate(async (expected) => {
        const { topicSync } = await chrome.storage.local.get('topicSync');
        const states = topicSync as { topic: string; synced: boolean }[] | undefined;
        return expected.every((topic) => states?.some((state) => state.topic === topic && state.synced));
      }, topics),
    )
    .toBe(true);
}

test.describe('receiving', () => {
  test('keeps a stale local-only delete off the server even if the mode changes during dispatch', async ({
    ntfy,
    configure,
    openPopup,
  }) => {
    await configure({ topics: 'alerts' });
    const page = await openPopup();
    await expect.poll(() => ntfy.subscriptions.length).toBeGreaterThan(0);
    const original = ntfy.publish('alerts', { title: 'Local-only delete', sequence_id: 'keep-on-server' });
    const button = page.getByRole('button', { name: 'Delete Notification', exact: true });
    await expect(button).toBeVisible();
    await page.evaluate(() => {
      const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (async (request: { action: string }) => {
        if (request.action !== 'delete') return sendMessage(request);
        await chrome.storage.sync.set({ syncDeletionTopics: ['alerts'] });
        const reply = (await sendMessage(request)) as { success: boolean };
        document.body.dataset.deleteCompleted = String(reply.success);
        return reply;
      }) as typeof chrome.runtime.sendMessage;
    });
    await button.click();
    await expect
      .poll(() => page.evaluate(async () => (await chrome.storage.local.get('deletedMessageIds')).deletedMessageIds))
      .toEqual([original.id]);
    await expect(page.locator('.notification-item')).toHaveCount(0);
    await expect(page.locator('body')).toHaveAttribute('data-delete-completed', 'true');
    expect(ntfy.messages.filter(({ event }) => event === 'message_delete')).toEqual([]);
  });

  test('catches up after a large replay and keeps its warning across later polls', async ({
    ntfy,
    configure,
    openPopup,
    serviceWorker,
  }) => {
    const body = 'x'.repeat(4000);
    const start = Math.floor(Date.now() / 1000) - 1800;
    for (let index = 0; index < 1200; index++) {
      ntfy.publish('busy', { time: start + index, message: body, title: `Cached event ${index}` });
    }
    await configure({ topics: 'busy' });
    await waitForInitialSync(serviceWorker, ['busy']);

    const page = await openPopup();
    await expect(page.locator('.notification-item')).toHaveCount(100);
    await expect(page.locator('.notification-title').first()).toHaveText('Cached event 1199');
    await expect(page.getByText('Some cached events may have been skipped: busy')).toBeVisible();
  });

  test('keeps history from an unrelated server when the current server deletes the same sequence', async ({
    ntfy,
    configure,
    openPopup,
    serviceWorker,
  }) => {
    const next = await startNtfyServer();
    try {
      await configure({ topics: 'alerts' });
      await serviceWorker.evaluate(() => chrome.storage.sync.set({ syncDeletionTopics: ['alerts'] }));
      const popup = await openPopup();
      await expect.poll(() => ntfy.subscriptions.length).toBeGreaterThan(0);
      const sequence_id = 'deployment';
      ntfy.publish('alerts', { id: 'previous', sequence_id, title: 'Saved from the previous server' });
      await expect(popup.locator('.notification-title')).toHaveText(['Saved from the previous server']);

      await serviceWorker.evaluate(async (apiUrl) => {
        await chrome.storage.local.set({ authOrigins: [new URL(apiUrl).origin] });
        await chrome.storage.sync.set({ apiUrl });
      }, next.url);
      await expect.poll(() => next.subscriptions.length).toBeGreaterThan(0);
      next.publish('alerts', { id: 'current', sequence_id, title: 'Saved from the current server' });
      await expect(popup.locator('.notification-title')).toHaveCount(2);
      next.deleteNotification('alerts', sequence_id);
      await expect(popup.locator('.notification-title')).toHaveText(['Saved from the previous server']);
    } finally {
      await next.close();
    }
  });

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
    await waitForInitialSync(serviceWorker, ['alerts']);

    ntfy.publish('alerts', { title: 'Disk full', message: 'sda at 91%', priority: 4 });
    await expect.poll(async () => (await notified()).map((n) => n.title)).toEqual(['Disk full [↑ High]']);
    await expect.poll(() => serviceWorker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');

    const popup = await openPopup('?tab=receive');
    await expect(popup.locator('.notification-title')).toHaveText(['Disk full']);
    await expect(popup.locator('header #header-connection')).toHaveText(`Connected to ${new URL(ntfy.url).host}`);

    // The poll after connecting must not notify it again
    await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'sync' }));
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

  test('follows the per-topic notification rules', async ({ ntfy, configure, notified, openPopup, serviceWorker }) => {
    await configure({ topics: 'alerts,coolify', notifyRules: { coolify: 'off', alerts: 'high' } });
    await expect.poll(() => ntfy.subscriptions).toEqual([['alerts', 'coolify']]);
    await waitForInitialSync(serviceWorker, ['alerts', 'coolify']);

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
  test('one queued attachment cannot be sent concurrently from two extension tabs', async ({
    configure,
    ntfy,
    openPopup,
    serviceWorker,
  }) => {
    await configure({ topics: 'alerts' });
    await serviceWorker.evaluate(() => {
      const worker = globalThis as unknown as { __ntfyAddPickedFiles: (files: File[]) => Promise<void> };
      return worker.__ntfyAddPickedFiles([new File(['shared'], 'shared.txt', { type: 'text/plain' })]);
    });
    const first = await openPopup('?mode=page');
    const second = await openPopup('?mode=page');
    await expect(first.locator('#file-preview')).toContainText('shared.txt');
    await expect(second.locator('#file-preview')).toContainText('shared.txt');
    let release!: () => void;
    ntfy.publishGate = new Promise((resolve) => (release = resolve));
    try {
      await first.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => ntfy.published.map(({ body }) => body)).toEqual(['shared']);
      await second.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(second.locator('#status')).toHaveText('A send is already in progress in another ntfy Desk window.');
      expect(ntfy.published).toHaveLength(1);
    } finally {
      release();
    }
    await expect(first.locator('#status')).toHaveText('Notification sent!');
    await expect(second.locator('#file-preview')).not.toContainText('shared.txt');
    expect(ntfy.published).toHaveLength(1);
  });

  test('approves a server for the stored token through Settings', async ({ configure, openPopup, ntfy, serviceWorker }) => {
    await configure({ topics: 'alerts', approveOrigins: false });
    const page = await openPopup();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const approve = page.getByRole('button', { name: 'Use them with this server' });
    await expect(approve).toBeVisible();
    expect(ntfy.subscriptions).toEqual([]);
    await approve.click();
    await expect(approve).toBeHidden();
    await expect.poll(() => ntfy.subscriptions).toContainEqual(['alerts']);
    expect(await serviceWorker.evaluate(() => chrome.storage.local.get('authOrigins'))).toEqual({ authOrigins: [ntfy.url] });
  });

  test('opens the attachment chooser by keyboard', async ({ configure, openPopup, context }) => {
    await configure({ topics: 'alerts' });
    const page = await openPopup('?mode=page');
    const [picker] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Attach files' }).click()]);
    const browse = picker.getByRole('button', { name: 'Browse for files' });
    await expect(browse).toBeVisible();
    await picker.keyboard.press('Tab');
    await expect(browse).toBeFocused();
    const [chooser] = await Promise.all([picker.waitForEvent('filechooser'), picker.keyboard.press('Enter')]);
    await chooser.setFiles({ name: 'keyboard.txt', mimeType: 'text/plain', buffer: Buffer.from('chosen by keyboard') });
    await expect(page.locator('#file-preview')).toContainText('keyboard.txt');
  });

  test('preserves a file picked in another window during an attachment upload', async ({
    configure,
    ntfy,
    openPopup,
    context,
    extensionId,
  }) => {
    await configure({ topics: 'alerts' });
    const page = await openPopup('?mode=page');
    await expect(page.locator('#topic-select')).toHaveValue('alerts');
    const pick = async (name: string) => {
      const picker = await context.newPage();
      await picker.goto(`chrome-extension://${extensionId}/filepicker.html`);
      await picker.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
    };
    await pick('first.txt');
    await expect(page.locator('#file-preview')).toContainText('first.txt');
    let release!: () => void;
    ntfy.publishGate = new Promise((resolve) => (release = resolve));
    try {
      await page.locator('#send-btn').click();
      await expect.poll(() => ntfy.published.map(({ body }) => body)).toEqual(['first.txt']);
      await pick('second.txt');
      await expect(page.locator('#file-preview')).toContainText('second.txt');
    } finally {
      release();
    }
    await expect(page.locator('#status')).toHaveText('Notification sent!');
    await expect(page.locator('#file-preview')).toContainText('second.txt');
    await expect(page.locator('#file-preview')).not.toContainText('first.txt');
  });

  test('retains accessible icon names on hover and lets the keyboard remove tags and topics', async ({ configure, openPopup }) => {
    await configure({ topics: 'alerts,backups' });
    const page = await openPopup('?mode=page');
    const settings = page.getByRole('button', { name: 'Settings', exact: true });
    await settings.hover();
    await expect(settings).toBeVisible();
    const tags = page.locator('#new-tag-input');
    await tags.fill('first');
    await tags.press('Enter');
    await tags.fill('second');
    await tags.press('Enter');
    await page.getByRole('button', { name: 'Remove tag first' }).press('Enter');
    await expect(page.getByRole('button', { name: 'Remove tag first' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove tag second' })).toBeVisible();
    await settings.click();
    await page.getByRole('button', { name: 'Remove topic alerts' }).press('Enter');
    await expect(page.getByRole('button', { name: 'Remove topic alerts' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove topic backups' })).toBeVisible();
  });

  test('keeps status text readable in light and dark themes', async ({ configure, openPopup }) => {
    await configure({ topics: 'alerts' });
    const page = await openPopup('?mode=page');
    const ratios = await page.locator('#status').evaluate((status) => {
      const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number);
      const luminance = (color: number[]) =>
        color.reduce((total, value, index) => {
          const channel = value / 255;
          const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          return total + linear * [0.2126, 0.7152, 0.0722][index]!;
        }, 0);
      const result = [];
      for (const theme of ['light', 'dark']) {
        document.body.dataset.theme = theme;
        for (const kind of ['success', 'warning', 'error']) {
          status.setAttribute('class', `status visible ${kind}`);
          const backgrounds = [];
          for (let node: Element | null = status; node; node = node.parentElement) {
            backgrounds.unshift(rgb(getComputedStyle(node).backgroundColor));
          }
          const background = backgrounds.reduce(
            (base, color) => base.map((value, index) => value * (1 - (color[3] ?? 1)) + color[index]! * (color[3] ?? 1)),
            [255, 255, 255],
          );
          const [low, high] = [luminance(background), luminance(rgb(getComputedStyle(status).color))].sort((a, b) => a - b);
          result.push({ theme, kind, ratio: (high! + 0.05) / (low! + 0.05) });
        }
      }
      return result;
    });
    for (const { theme, kind, ratio } of ratios) expect(ratio, `${theme} ${kind}`).toBeGreaterThanOrEqual(4.5);
  });

  test('focuses a notification in the open inbox while preserving the composer', async ({ configure, ntfy, openPopup, serviceWorker }) => {
    await configure({ topics: 'alerts' });
    const page = await openPopup('?mode=page');
    await waitForInitialSync(serviceWorker, ['alerts']);
    const event = ntfy.publish('alerts', { title: 'Notification to focus' });
    await expect(page.locator('.notification-title')).toHaveText('Notification to focus');
    await page.locator('#message-input').fill('Unsent work');
    await page.evaluate(() => {
      document.body.dataset.originalDocument = 'yes';
    });
    await serviceWorker.evaluate((id) => {
      const worker = globalThis as unknown as { __ntfyClickNotification: (id: string) => Promise<void> };
      return worker.__ntfyClickNotification(id);
    }, event.id);
    await expect(page.locator('.notification-item.focused')).toHaveCount(1);
    await expect(page.locator('body')).toHaveAttribute('data-original-document', 'yes');
    await expect(page.locator('#message-input')).toHaveValue('Unsent work');
  });

  test('blocks an open composer from publishing to a replacement server', async ({ configure, ntfy, openPopup, serviceWorker }) => {
    const next = await startNtfyServer();
    try {
      await configure({ topics: 'alerts' });
      const page = await openPopup('?mode=page');
      await expect(page.getByLabel('Send to')).toHaveValue('alerts');
      await page.locator('#message-input').fill('Draft for the original server');
      await serviceWorker.evaluate((authOrigins) => chrome.storage.local.set({ authOrigins }), [ntfy.url, next.url]);
      await configure({ apiUrl: next.url, topics: 'alerts' });

      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('#status')).toHaveText('The server or topic changed. Reopen ntfy Desk before sending.');
      expect(ntfy.published).toEqual([]);
      expect(next.published).toEqual([]);
      await expect((await openPopup('?mode=page')).locator('#message-input')).toHaveValue('Draft for the original server');
    } finally {
      await next.close();
    }
  });

  test('preserves edits made while a send is awaiting a response', async ({ configure, ntfy, openPopup }) => {
    await configure({ topics: 'alerts' });
    const page = await openPopup();
    await expect(page.getByLabel('Send to')).toHaveValue('alerts');
    let release!: () => void;
    ntfy.publishGate = new Promise((resolve) => (release = resolve));
    const message = page.locator('#message-input');
    try {
      await message.fill('First message');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => ntfy.published.map(({ body }) => body)).toEqual(['First message']);
      await message.fill('New draft');
    } finally {
      release();
    }
    await expect(page.locator('#status')).toHaveText('Notification sent!');
    await expect(message).toHaveValue('New draft');
    await expect((await openPopup()).locator('#message-input')).toHaveValue('New draft');
  });

  test('restores draft input from a popup closed in the next task', async ({ configure, openPopup }) => {
    await configure({ topics: 'alerts' });
    const popup = await openPopup();
    await expect(popup.getByLabel('Send to')).toHaveValue('alerts');
    await Promise.all([
      popup.waitForEvent('close'),
      popup.locator('#message-input').evaluate((input: HTMLTextAreaElement) => {
        input.value = 'Latest draft edit';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => window.close(), 0);
      }),
    ]);
    const reopened = await openPopup();
    await expect(reopened.getByLabel('Message', { exact: true })).toHaveValue('Latest draft edit');
  });

  test('keeps the header in place and swaps Settings and Back in the same slot', async ({ configure, ntfy, openPopup }) => {
    await configure({ topics: Array.from({ length: 16 }, (_, index) => 'topic' + index).join(',') });
    for (const mode of ['', '?mode=page']) {
      const page = await openPopup(mode);
      await page.setViewportSize({ width: mode ? 1100 : 800, height: mode ? 720 : 600 });
      const header = page.getByRole('banner');
      const connection = header.getByRole('status');
      const connectedText = `Connected to ${new URL(ntfy.url).host}`;
      const gear = header.getByRole('button', { name: 'Settings' });
      const back = header.getByRole('button', { name: 'Back' });
      const headerPositions = () =>
        Promise.all(
          ['.header-left', '#header-connection', '#popout-btn', '#open-url-btn'].map((selector) => header.locator(selector).boundingBox()),
        );

      await expect(connection).toHaveText(connectedText);
      const positions = await headerPositions();
      const buttonSlot = await gear.boundingBox();
      await gear.press('Enter');
      await expect(page.getByLabel('Server URL', { exact: true })).toBeVisible();
      expect(await page.locator('#settings-view').evaluate((view) => view.scrollHeight > view.clientHeight)).toBe(true);
      await expect(gear).toBeHidden();
      await expect(back).toBeFocused();
      await expect(header.getByText('ntfy Desk', { exact: true })).toBeVisible();
      await expect(connection).toHaveText(connectedText);
      expect(await headerPositions()).toEqual(positions);
      expect(await back.boundingBox()).toEqual(buttonSlot);
      await back.press('Enter');
      await expect(gear).toBeFocused();
      await expect(back).toBeHidden();
      expect(await gear.boundingBox()).toEqual(buttonSlot);
    }
  });

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
    // The shortcut sends only from inside the composer
    const search = page.getByRole('searchbox', { name: 'Search messages' });
    await search.press('Control+Enter');
    await search.press('Meta+Enter');
    await expect(message).toHaveValue('Check disk space');
    expect(ntfy.published).toEqual([]);
    await message.press('Control+Enter');
    await expect(page.locator('#status')).toHaveText('Notification sent!');
    expect(ntfy.published).toMatchObject([{ topic: 'alerts', body: 'Check disk space' }]);
    await message.fill('Sent with Cmd');
    await message.press('Meta+Enter');
    await expect.poll(() => ntfy.published.map(({ body }) => body)).toEqual(['Check disk space', 'Sent with Cmd']);
  });

  test('keeps the toolbar draft when the composer collapses or the inbox topic changes', async ({
    configure,
    openPopup,
    serviceWorker,
  }) => {
    await configure({ topics: 'alerts,backups' });
    await serviceWorker.evaluate(() => chrome.storage.local.set({ receiveTopicFilter: { topic: 'backups' } }));
    const popup = await openPopup();
    await popup.setViewportSize({ width: 800, height: 600 });
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

  test('remembers the Send panel state only when enabled in Settings', async ({ configure, openPopup, serviceWorker }) => {
    await configure({ topics: 'alerts' });
    const popup = await openPopup();
    const panel = popup.locator('#send-section');
    const summary = panel.locator('summary');
    const remember = popup.getByRole('checkbox', { name: 'Remember collapsed/expanded state of section Send notification', exact: true });
    const message = popup.getByLabel('Message', { exact: true });
    const destination = popup.getByLabel('Send to');

    await expect(destination).toHaveValue('alerts');
    await summary.press('Enter');
    await expect(message).toBeHidden();
    await popup.reload();
    await expect(message).toBeVisible();
    await expect(destination).toHaveValue('alerts');

    await summary.press('Enter');
    await popup.locator('#settings-btn').click();
    await expect(remember).not.toBeChecked();
    await remember.check();
    await expect(remember).toBeEnabled();
    await popup.reload();
    await expect(message).toBeHidden();
    await expect(panel).not.toHaveAttribute('open');

    const tab = await openPopup('?mode=page');
    const tabPanel = tab.locator('#send-section');
    await expect(tabPanel).not.toHaveAttribute('open');
    await tabPanel.locator('summary').press('Space');
    await expect.poll(() => serviceWorker.evaluate(() => chrome.storage.local.get('sendPanelOpen'))).toEqual({ sendPanelOpen: true });
    await popup.reload();
    await expect(message).toBeVisible();
    await expect(destination).toHaveValue('alerts');

    await summary.press('Enter');
    await popup.locator('#settings-btn').click();
    await expect(remember).toBeChecked();
    await remember.uncheck();
    await expect(remember).toBeEnabled();
    await popup.reload();
    await expect(message).toBeVisible();
  });

  test('freezes both dividers across views and restores resizing when unfrozen', async ({ configure, openPopup }) => {
    await configure({ topics: 'alerts,backups' });
    const popup = await openPopup();
    await popup.setViewportSize({ width: 800, height: 600 });
    const tab = await openPopup('?mode=page');
    await tab.setViewportSize({ width: 1100, height: 720 });
    const topicsDivider = popup.getByRole('separator', { name: 'Resize topics' });
    const sendDivider = popup.getByRole('separator', { name: 'Resize Send' });
    const tabDividers = tab.getByRole('separator');
    const freeze = popup.getByRole('checkbox', {
      name: 'Freeze dividers between sections All topics, Inbox, and Send notification',
      exact: true,
    });

    await expect(tabDividers).toHaveCount(2);
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', '120');
    await dragDivider(popup, 'Resize topics', 24);
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', '144');
    await popup.locator('#settings-btn').click();
    await expect(freeze).not.toBeChecked();
    await freeze.check();
    for (const divider of await tabDividers.all()) {
      await expect(divider).toHaveAttribute('aria-disabled', 'true');
    }
    await popup.locator('#back-btn').click();
    for (const divider of [topicsDivider, sendDivider]) {
      await expect(divider).toHaveAttribute('aria-disabled', 'true');
      await expect(divider).toHaveAttribute('tabindex', '-1');
    }
    await dragDivider(popup, 'Resize topics', 24);
    await sendDivider.press('ArrowLeft');
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', '144');
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '260');

    await popup.reload();
    await expect(topicsDivider).toHaveAttribute('aria-disabled', 'true');
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', '144');
    await popup.locator('#settings-btn').click();
    await expect(freeze).toBeChecked();
    await freeze.uncheck();
    for (const divider of await tabDividers.all()) {
      await expect(divider).toHaveAttribute('aria-disabled', 'false');
    }
    await popup.locator('#back-btn').click();
    await dragDivider(popup, 'Resize topics', 24);
    await sendDivider.press('ArrowLeft');
    await expect(topicsDivider).toHaveAttribute('aria-valuenow', '168');
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '276');
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
        const mainView = document.querySelector('#main-view');
        const topics = document.querySelector('#topic-sidebar')?.getBoundingClientRect();
        const inbox = document.querySelector('#notifications-section')?.getBoundingClientRect();
        const list = document.querySelector('#notifications-list');
        const topicDivider = document.querySelector('#topic-divider')?.getBoundingClientRect();
        const sendDivider = document.querySelector('#send-divider')?.getBoundingClientRect();
        const sendSection = document.querySelector<HTMLDetailsElement>('#send-section');
        const composer = sendSection?.getBoundingClientRect();
        const card = [...document.querySelectorAll('.notification-item')].find(
          (item) => item.querySelector('.notification-title')?.textContent === 'Container update needed',
        );
        return {
          width: popup.innerWidth,
          height: popup.innerHeight,
          documentFits:
            document.documentElement.scrollWidth === popup.innerWidth && document.documentElement.scrollHeight === popup.innerHeight,
          viewFits: Boolean(mainView && mainView.scrollWidth === mainView.clientWidth && mainView.scrollHeight === mainView.clientHeight),
          scrollableInboxFillsPane: Boolean(
            list &&
            mainView &&
            list.scrollHeight > list.clientHeight &&
            mainView.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom === 12,
          ),
          sideBySide: Boolean(topics && inbox && composer && topics.right <= inbox.left && inbox.right <= composer.left),
          inboxInsets:
            inbox && topicDivider && composer
              ? [inbox.left - topicDivider.right, (sendDivider?.width ? sendDivider.left : composer.left) - inbox.right]
              : null,
          connectionInHeader: document.querySelector('header #header-connection')?.textContent?.startsWith('Connected to '),
          composerOpen: sendSection?.open,
          topicsWidth: topics?.width,
          sendWidth: composer?.width,
          topicsDivider: Boolean(topicDivider?.width),
          sendDivider: Boolean(sendDivider?.width),
          message: card?.querySelector('.notification-message')?.textContent ?? null,
          emptyInbox: document.querySelector('.notifications-empty')?.textContent ?? null,
        };
      });
    const fitted = {
      width: 800,
      height: 600,
      documentFits: true,
      viewFits: true,
      scrollableInboxFillsPane: true,
      sideBySide: true,
      inboxInsets: [12, 12],
      connectionInHeader: true,
      topicsDivider: true,
      message,
      emptyInbox: null,
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
    await tab.evaluate(() => {
      const [popup] = chrome.extension.getViews({ type: 'popup' as Browser.extension.ViewType }) as (typeof window)[];
      const topics = popup?.document.querySelectorAll<HTMLButtonElement>('#topic-sidebar button');
      [...(topics ?? [])].find((button) => button.textContent === 'nightly-backups')?.click();
    });
    await expect.poll(measurePopup).toEqual({
      ...resized,
      message: null,
      emptyInbox: 'No recent notifications',
      scrollableInboxFillsPane: false,
    });
  });

  test('sends a message from the popup with title, priority and tags', async ({ ntfy, configure, openPopup }) => {
    await configure({ topics: 'inbox' });
    const popup = await openPopup();
    await popup.setViewportSize({ width: 800, height: 600 });
    const sendDivider = popup.getByRole('separator', { name: 'Resize Send' });
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '260');
    await sendDivider.press('Home');
    await expect(sendDivider).toHaveAttribute('aria-valuenow', '240');
    await popup.getByRole('button', { name: 'inbox', exact: true }).click();
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
    await expect(popup.locator('#tag-input-hint')).toBeVisible();
    expect(
      await popup
        .locator('#main-view')
        .evaluate((view) => view.scrollWidth === view.clientWidth && view.scrollHeight === view.clientHeight),
    ).toBe(true);
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
    await popup.getByRole('button', { name: 'Save server settings' }).click();
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
  test('keeps the draft when a publish lands but loses its response without reposting to the fallback', async ({
    configure,
    ntfy,
    openPopup,
  }) => {
    const fallback = await startNtfyServer();
    try {
      ntfy.dropPublishResponse = true;
      await configure({ topics: 'alerts', fallbackUrl: fallback.url });
      const page = await openPopup('?mode=page');
      const draft = 'Published before the response connection dropped';
      await page.locator('#message-input').fill(draft);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('#status')).toHaveText('Delivery is uncertain. Check the Inbox before retrying.');
      expect(ntfy.messages).toContainEqual(expect.objectContaining({ message: draft, event: 'message' }));
      expect(fallback.published).toEqual([]);
      await expect(page.locator('#message-input')).toHaveValue(draft);
    } finally {
      await fallback.close();
    }
  });

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
