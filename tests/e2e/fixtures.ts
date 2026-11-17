// Playwright fixtures: Chromium with the isolated E2E build and a test ntfy server.
// Extensions need a persistent context and Playwright's own Chromium (branded Chrome no longer loads
// unpacked extensions from the command line).

import { resolve } from 'node:path';
import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { startNtfyServer, type NtfyTestServer } from './ntfy-server';

const EXTENSION_PATH = resolve('.output/chrome-mv3-e2e');

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
    approveOrigins?: boolean;
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
      args: ['--screen-info={1200x900}', `--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    // Record the desktop notifications Chrome created; a failed create is recorded as a failure
    await worker.evaluate(() => {
      const recorded: { id: string; title: string; message: string }[] = [];
      const failed: string[] = [];
      Object.assign(globalThis, { __notified: recorded, __notifyFailed: failed });
      const create = chrome.notifications.create.bind(chrome.notifications);
      chrome.notifications.create = (async (id: string, options: Browser.notifications.NotificationCreateOptions) => {
        try {
          const created = await create(id, options);
          recorded.push({ id, title: options.title, message: options.message });
          return created;
        } catch (error) {
          failed.push(`${id}: ${String(error)}`);
          throw error;
        }
      }) as typeof chrome.notifications.create;
    });
    await use(worker);
    const failed = await worker.evaluate(() => (globalThis as unknown as { __notifyFailed: string[] }).__notifyFailed);
    expect(failed).toEqual([]);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  configure: async ({ serviceWorker, ntfy }, use) => {
    await use(async ({ apiUrl = ntfy.url, fallbackUrl = '', topics, token = ntfy.token, notifyRules = {}, approveOrigins = true }) => {
      const authOrigins = [...new Set([apiUrl, fallbackUrl].filter(Boolean).map((url) => new URL(url).origin))];
      await serviceWorker.evaluate(
        async ({ apiUrl, fallbackUrl, topics, token, notifyRules, authOrigins, approveOrigins }) => {
          const existing = await chrome.storage.local.get('authOrigins');
          await chrome.storage.local.set({
            accessToken: token,
            authOrigins: approveOrigins ? [] : (existing.authOrigins ?? []),
          });
          // Rules are stored as a list of [topic, rule]
          await chrome.storage.sync.set({ apiUrl, fallbackUrl, topics, notifyRules: Object.entries(notifyRules) });
          if (approveOrigins) await chrome.storage.local.set({ authOrigins });
        },
        { apiUrl, fallbackUrl, topics, token, notifyRules, authOrigins, approveOrigins },
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
      // The popup marks itself ready once its listeners are attached: a key pressed earlier is lost
      await page.locator('body[data-ready="true"]').waitFor();
      return page;
    });
  },
});

export { expect };
