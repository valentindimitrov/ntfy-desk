// Keyboard shortcuts declared in the manifest (`commands` in wxt.config.ts). The user rebinds them in
// the browser's own shortcut settings. Opening the popup is a command of its own rather than
// `_execute_action`, which Vivaldi doesn't act on: the background opens the popup, or the tab.

import { browser, type Browser } from 'wxt/browser';
import { sendPage } from './context-menu';
import { openExtensionTab } from './extension-tab';
import { showSendResult } from './notifications';

export const SEND_PAGE_COMMAND = 'send-page';
export const OPEN_POPUP_COMMAND = 'open-popup';

/** The toolbar popup; the extension's tab where the browser can't open the popup from here */
async function openPopup(): Promise<void> {
  try {
    await browser.action.openPopup();
  } catch {
    await openExtensionTab();
  }
}

/** The shortcut grants activeTab, so the active tab's URL and title are readable without `tabs` */
async function activeTab(): Promise<Browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

export async function handleCommand(command: string, tab?: Browser.tabs.Tab): Promise<void> {
  if (command === OPEN_POPUP_COMMAND) {
    await openPopup().catch(() => console.error('Could not open ntfy Desk'));
    return;
  }
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

/** The browser's own "activate the extension" command: listed only if the user gave it a key */
const BROWSER_ACTION_COMMAND = '_execute_action';
const DESCRIPTIONS: Record<string, string> = {
  [OPEN_POPUP_COMMAND]: 'Open ntfy Desk',
  [BROWSER_ACTION_COMMAND]: 'Activate the extension (browser)',
};

/** The current bindings, as the browser reports them; [] if it can't */
export async function getShortcuts(): Promise<ShortcutInfo[]> {
  try {
    const commands = await browser.commands.getAll();
    return commands
      .filter(({ name, shortcut }) => name !== BROWSER_ACTION_COMMAND || Boolean(shortcut))
      .map(({ name = '', description, shortcut }) => ({
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
