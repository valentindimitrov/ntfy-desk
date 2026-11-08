import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  // Firefox too (WXT builds Firefox as MV2 by default); Firefox 142+ is required anyway
  manifestVersion: 3,
  // No <link rel="modulepreload"> for shared chunks: Chrome doesn't use them on extension pages ("cross-world
  // extension resource mismatch" on the extensions page), and extension files load from disk anyway
  vite: () => ({ build: { modulePreload: false } }),
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
    // unlimitedStorage: picked attachments wait in storage.local as data URLs (utils/stored-files.ts)
    permissions: ['activeTab', 'storage', 'unlimitedStorage', 'contextMenus', 'scripting', 'notifications', 'alarms'],
    // tabs: only for "Use tab URL" in the extension's own tab
    optional_permissions: ['tabs'],
    // The ntfy server (authenticated requests) and sites of images sent from the context menu
    optional_host_permissions: ['<all_urls>'],
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
