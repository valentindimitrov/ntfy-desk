// Playwright fixtures: Chromium with the built extension (.output/chrome-mv3) and a test ntfy server.
// Extensions need a persistent context and Playwright's own Chromium (branded Chrome no longer loads
// unpacked extensions from the command line).

import { resolve } from 'node:path';
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { startNtfyServer, type NtfyTestServer } from './ntfy-server';

const EXTENSION_PATH = resolve('.output/chrome-mv3');

export interface Notified {
  id: string;
  title: string;
  message: string;
}

interface Fixtures {
  ntfy: NtfyTestServer;
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  /** Settings written to the extension's storage, as the settings view saves them */
  configure: (settings: {
    apiUrl?: string;
    fallbackUrl?: string;
    topics: string;
    token?: string;
    notifyRules?: Record<string, string>;
  }) => Promise<void>;
  /** Desktop notifications the extension created (recorded in the service worker) */
  notified: () => Promise<Notified[]>;
  /** The extension's popup page in a tab; search like '?tab=receive' */
  openPopup: (search?: string) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  ntfy: async ({}, use) => {
    const server = await startNtfyServer();
    await use(server);
    await server.close();
  },

  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    // Record desktop notifications (headless Chromium may not show them)
    await worker.evaluate(() => {
      const recorded: { id: string; title: string; message: string }[] = [];
      (globalThis as unknown as { __notified: typeof recorded }).__notified = recorded;
      const create = chrome.notifications.create.bind(chrome.notifications);
      chrome.notifications.create = ((id: string, options: Browser.notifications.NotificationCreateOptions) => {
        recorded.push({ id, title: options.title, message: options.message });
        return create(id, options).catch(() => id);
      }) as typeof chrome.notifications.create;
    });
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  configure: async ({ serviceWorker, ntfy }, use) => {
    await use(async ({ apiUrl = ntfy.url, fallbackUrl = '', topics, token = ntfy.token, notifyRules = {} }) => {
      await serviceWorker.evaluate(
        async ({ apiUrl, fallbackUrl, topics, token, notifyRules }) => {
          await chrome.storage.local.set({ accessToken: token });
          await chrome.storage.sync.set({ apiUrl, fallbackUrl, topics, notifyRules });
        },
        { apiUrl, fallbackUrl, topics, token, notifyRules },
      );
    });
  },

  notified: async ({ serviceWorker }, use) => {
    await use(() => serviceWorker.evaluate(() => (globalThis as unknown as { __notified: Notified[] }).__notified));
  },

  openPopup: async ({ context, extensionId }, use) => {
    await use(async (search = '') => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html${search}`);
      return page;
    });
  },
});

export const expect = test.expect;
