// The extension's own tab (the popup page with mode=page): opened from the popup's header button and
// from a click on a desktop notification.

import { browser, type Browser } from 'wxt/browser';

const pageUrl = () => browser.runtime.getURL('/popup.html?mode=page');

/** Tab and window of the extension's tab, if it is open (needs runtime.getContexts; else null) */
async function findExtensionTab(): Promise<{ tabId: number; windowId: number } | null> {
  if (!browser.runtime.getContexts) return null;
  // The types declare ContextType as an enum; its value is this string in every browser
  const contexts = await browser.runtime.getContexts({ contextTypes: ['TAB' as Browser.runtime.ContextType] });
  const open = contexts.find((context) => context.documentUrl?.startsWith(pageUrl()));
  return open ? { tabId: open.tabId, windowId: open.windowId } : null;
}

/**
 * Switch to the extension's tab, or open it. With a message, the tab (re)loads showing that message
 * on the Receive tab.
 */
export async function openExtensionTab(options: { tab?: 'send' | 'receive'; message?: string } = {}): Promise<void> {
  const params = new URLSearchParams();
  if (options.tab) params.set('tab', options.tab);
  if (options.message) params.set('message', options.message);
  const url = `${pageUrl()}&${params}`;

  const open = await findExtensionTab();
  if (open) {
    await browser.tabs.update(open.tabId, options.message ? { active: true, url } : { active: true });
    await browser.windows.update(open.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url });
}
