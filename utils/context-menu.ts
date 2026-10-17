// Right-click menu: send the page, selected text, an image or a link to a topic.

import { browser, type Browser } from 'wxt/browser';
import { showSendResult } from './notifications';
import { getConfig, sendImageFromUrl, sendNotification, type NtfyConfig } from './ntfy';
import { withFallback } from './servers';

const PARENT_MENU_ID = 'ntfy-parent';
const SEND_SELECTION_ID = 'ntfy-send-selection';
const SEND_IMAGE_ID = 'ntfy-send-image';
const SEND_LINK_ID = 'ntfy-send-link';
const SEND_TAB_ID = 'ntfy-send-tab';

// The types declare ContextType as an enum; its values are these strings in every browser
type MenuContexts = [Browser.contextMenus.ContextType, ...Browser.contextMenus.ContextType[]];
const contexts = (...values: string[]) => values as MenuContexts;

const KINDS: { id: string; label: string; contexts: MenuContexts }[] = [
  { id: SEND_TAB_ID, label: 'Page', contexts: contexts('all') },
  { id: SEND_SELECTION_ID, label: 'Text', contexts: contexts('selection') },
  { id: SEND_IMAGE_ID, label: 'Image', contexts: contexts('image') },
  { id: SEND_LINK_ID, label: 'Link', contexts: contexts('link') },
];

/** Rebuild the menu from the configured topics: one item per kind, or a submenu of topics per kind */
export async function updateContextMenu(): Promise<void> {
  await browser.contextMenus.removeAll();

  const { apiUrl, topics } = await getConfig();
  if (!apiUrl || topics.length === 0) {
    return;
  }

  browser.contextMenus.create({ id: PARENT_MENU_ID, title: browser.runtime.getManifest().name, contexts: contexts('all') });

  for (const kind of KINDS) {
    if (topics.length === 1) {
      browser.contextMenus.create({
        id: kind.id,
        parentId: PARENT_MENU_ID,
        title: `${kind.label} (${topics[0]})`,
        contexts: kind.contexts,
      });
      continue;
    }
    const submenuId = `${PARENT_MENU_ID}-${kind.id}`;
    browser.contextMenus.create({ id: submenuId, parentId: PARENT_MENU_ID, title: kind.label, contexts: kind.contexts });
    topics.forEach((topic, index) => {
      browser.contextMenus.create({ id: `${kind.id}-${index}`, parentId: submenuId, title: topic, contexts: kind.contexts });
    });
  }
}

/** "Include current tab's URL": the page URL, used as the message title */
function pageUrlTitle(config: NtfyConfig, tab?: Browser.tabs.Tab): string {
  return config.includeUrl && tab?.url ? tab.url.replace(/\/$/, '') : '';
}

function isKind(menuId: string, kindId: string): boolean {
  return menuId === kindId || menuId.startsWith(`${kindId}-`);
}

/** Text of the link with that URL on the page, '' if not found */
async function getLinkText(tab: Browser.tabs.Tab | undefined, linkUrl: string): Promise<string> {
  if (tab?.id === undefined) return '';
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: (targetUrl: string) => {
        // .href is absolute, like targetUrl
        for (const link of document.querySelectorAll('a')) {
          if (link.href === targetUrl) {
            return link.innerText || link.textContent || '';
          }
        }
        return '';
      },
      args: [linkUrl],
    });
    const text = results?.[0]?.result;
    return typeof text === 'string' ? text.trim() : '';
  } catch (error) {
    console.error('Failed to retrieve link text:', error);
    return '';
  }
}

export async function handleContextMenuClick(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab): Promise<void> {
  const menuId = String(info.menuItemId);

  // Ask for access to the image's site while the click still counts as a user gesture
  // (checking permissions.contains first is async and would lose it)
  if (isKind(menuId, SEND_IMAGE_ID) && info.srcUrl?.startsWith('http')) {
    try {
      const granted = await browser.permissions.request({ origins: [`${new URL(info.srcUrl).origin}/*`] });
      if (!granted) {
        console.error('Permission denied to access image origin');
        return;
      }
    } catch (error) {
      // Try anyway: the fetch may still work
      console.error('Failed to request permission:', error);
    }
  }

  const config = await getConfig();
  if (!config.apiUrl || config.topics.length === 0) {
    console.error('ntfy not configured');
    return;
  }

  // One topic: menu ids without an index; several: the topic's index at the end of the id
  const match = menuId.match(/-(\d+)$/);
  const topic = config.topics.length === 1 ? config.topics[0] : match ? config.topics[Number(match[1])] : undefined;
  if (!topic) {
    console.error('Could not determine topic');
    return;
  }

  try {
    if (isKind(menuId, SEND_SELECTION_ID)) {
      await withFallback(config, (server) =>
        sendNotification(server, topic, { message: info.selectionText, title: pageUrlTitle(config, tab) }),
      );
    } else if (isKind(menuId, SEND_IMAGE_ID) && info.srcUrl) {
      const srcUrl = info.srcUrl;
      await withFallback(config, (server) => sendImageFromUrl(server, topic, srcUrl, '', pageUrlTitle(config, tab)));
    } else if (isKind(menuId, SEND_LINK_ID) && info.linkUrl) {
      // The link text is the title, so the page URL goes in the message
      const title = await getLinkText(tab, info.linkUrl);
      const pageUrl = pageUrlTitle(config, tab);
      const message = pageUrl ? `${info.linkUrl}\n\nSent from: ${pageUrl}` : info.linkUrl;
      await withFallback(config, (server) => sendNotification(server, topic, { message, title }));
    } else if (isKind(menuId, SEND_TAB_ID)) {
      await withFallback(config, (server) => sendNotification(server, topic, { message: tab?.url, title: tab?.title }));
    } else {
      return;
    }
    showSendResult(true);
  } catch (error) {
    console.error('Failed to send notification:', error);
    showSendResult(false);
  }
}
