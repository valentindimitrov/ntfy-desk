// Code passed to serviceWorker.evaluate() runs in the extension's service worker, where the global
// chrome is the extension API (WXT's types for it).

import type { browser } from 'wxt/browser';

declare global {
  const chrome: typeof browser;
}
