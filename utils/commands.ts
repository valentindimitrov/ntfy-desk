// Keyboard shortcuts declared in the manifest (`commands` in wxt.config.ts). The user rebinds them in
// the browser's own shortcut settings; `_execute_action` (open the popup) is handled by the browser.

import { browser, type Browser } from 'wxt/browser';
import { sendPage } from './context-menu';
import { showSendResult } from './notifications';

export const SEND_PAGE_COMMAND = 'send-page';

/** The shortcut grants activeTab, so the active tab's URL and title are readable without `tabs` */
async function activeTab(): Promise<Browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

export async function handleCommand(command: string, tab?: Browser.tabs.Tab): Promise<void> {
  if (command !== SEND_PAGE_COMMAND) return;
  try {
    await sendPage(tab?.url ? tab : await activeTab());
  } catch (error) {
    console.error('Failed to send the page:', error instanceof Error ? error.name : 'error');
    showSendResult(false);
  }
}

export interface ShortcutInfo {
  name: string;
  description: string;
  /** '' when no key is assigned */
  shortcut: string;
}

const DESCRIPTIONS: Record<string, string> = { _execute_action: 'Open ntfy Desk' };

/** The current bindings, as the browser reports them; [] if it can't */
export async function getShortcuts(): Promise<ShortcutInfo[]> {
  try {
    const commands = await browser.commands.getAll();
    return commands.map(({ name = '', description, shortcut }) => ({
      name,
      description: description || DESCRIPTIONS[name] || name,
      shortcut: shortcut ?? '',
    }));
  } catch {
    return [];
  }
}

type OpenShortcutSettings = () => Promise<void>;

/**
 * Open the browser's page for changing extension shortcuts. Firefox (137+) has
 * commands.openShortcutSettings; Chromium has no API for it, but lets an extension open
 * chrome://extensions/shortcuts in a tab. False if neither worked.
 */
export async function openShortcutSettings(): Promise<boolean> {
  try {
    const open = (browser.commands as { openShortcutSettings?: OpenShortcutSettings }).openShortcutSettings;
    if (typeof open === 'function') {
      await open.call(browser.commands);
      return true;
    }
    if (import.meta.env.BROWSER === 'firefox') return false;
    await browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
    return true;
  } catch {
    return false;
  }
}
