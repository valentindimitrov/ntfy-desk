// The extension's own tab (the popup page with mode=page): opened from the popup's header button and
// from a click on a desktop notification.

import { browser, type Browser } from 'wxt/browser';

const pageUrl = () => browser.runtime.getURL('/popup.html?mode=page');

/** Tab and window of the extension's tab, if it is open (needs runtime.getContexts; else null) */
async function findExtensionTab(): Promise<{ tabId: number; windowId: number; url: string } | null> {
  if (!browser.runtime.getContexts) return null;
  // The types declare ContextType as an enum; its value is this string in every browser
  const contexts = await browser.runtime.getContexts({ contextTypes: ['TAB' as Browser.runtime.ContextType] });
  const open = contexts.find((context) => context.documentUrl?.startsWith(pageUrl()));
  return open?.documentUrl ? { tabId: open.tabId, windowId: open.windowId, url: open.documentUrl } : null;
}

/**
 * Switch to the extension's tab, or open it. With a message, the inbox highlights it. With settings,
 * the tab shows that group of the Settings (import and export need a page that stays open).
 */
export async function openExtensionTab({
  message,
  topic,
  allTopics,
  settings,
}: { message?: string; topic?: string; allTopics?: boolean; settings?: 'backup' } = {}): Promise<void> {
  const open = await findExtensionTab();
  const url = new URL(open?.url ?? pageUrl());
  const link: Record<string, string> | null = settings
    ? { settings }
    : message
      ? { message }
      : topic || allTopics
        ? { topic: topic ?? '' }
        : null;
  if (link) {
    // A new fragment focuses the Inbox (or the settings group) without reloading the composer, even on a repeated click.
    url.hash = new URLSearchParams({ ...link, focus: crypto.randomUUID() }).toString();
  }
  if (open) {
    await browser.tabs.update(open.tabId, link ? { active: true, url: url.href } : { active: true });
    await browser.windows.update(open.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url: url.href });
}
