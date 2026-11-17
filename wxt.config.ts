import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  // Firefox too (WXT builds Firefox as MV2 by default); Firefox 142+ is required anyway
  manifestVersion: 3,
  // No <link rel="modulepreload"> for shared chunks: Chrome doesn't use them on extension pages ("cross-world
  // extension resource mismatch" on the extensions page), and extension files load from disk anyway
  vite: () => ({ build: { modulePreload: false } }),
  zip: {
    // Test output is git-ignored but not hidden, so it would end up in the sources ZIP of a run that
    // tested first (the Prepare release workflow does)
    excludeSources: ['playwright-report/**', 'test-results/**'],
  },
  hooks: {
    'build:publicAssets': (wxt, files) => {
      for (const name of ['LICENSE', 'NOTICE.md']) {
        files.push({ absoluteSrc: resolve(wxt.config.root, name), relativeDest: name });
      }
    },
  },
  manifest: ({ browser }) => ({
    name: 'ntfy Desk',
    description:
      'Send and receive ntfy notifications: desktop notifications, a message list per topic, file attachments, priority and tags',
    // unlimitedStorage: storage.local holds up to 8 MiB of history plus up to 200,000 deleted ids and the sync
    // state, beyond Chrome's 10 MB storage.local quota. It also lifts the quota for the IndexedDB attachment
    // queue (up to 50 MiB, utils/stored-files.ts).
    permissions: ['activeTab', 'storage', 'unlimitedStorage', 'contextMenus', 'scripting', 'notifications', 'alarms'],
    // tabs: only for "Use tab URL" in the extension's own tab
    optional_permissions: ['tabs'],
    // The ntfy server (authenticated requests) and sites of images sent from the context menu
    optional_host_permissions: ['<all_urls>'],
    // Keyboard shortcuts, rebound in the browser's shortcut settings. Alt+Shift+N is valid in Chrome
    // (Ctrl or Alt required, no Ctrl+Alt) and Firefox and isn't a shortcut of either browser; send-page
    // has no default key, so nothing is published by an accidental key press.
    commands: {
      // Not _execute_action: Vivaldi doesn't open the popup for it; the background opens it instead
      'open-popup': { description: 'Open ntfy Desk', suggested_key: { default: 'Alt+Shift+N' } },
      'send-page': { description: 'Send this page to ntfy' },
    },
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'ntfy-desk@valentindimitrov.github.io',
          strict_min_version: '142.0',
          // ntfy requests can carry credentials, messages and content selected from a page.
          data_collection_permissions: {
            required: ['authenticationInfo', 'personalCommunications', 'browsingActivity', 'websiteContent'],
          },
        },
      },
    }),
  }),
});
