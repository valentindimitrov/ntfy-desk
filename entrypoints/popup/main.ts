// Popup (also opened as a page in its own tab): Send and Receive tabs, and the settings view.

import '@/assets/styles.css';
import { browser } from 'wxt/browser';
import { openExtensionTab } from '@/utils/extension-tab';
import { focusMessage, loadNotifications, setupReceive } from './receive';
import {
  applyPagePrefill,
  cleanUpAfterBrowserRestart,
  clearTopicDropdown,
  getPage,
  loadAttachments,
  renderTags,
  restoreDraft,
  setupSend,
  showTopic,
  updatePriorityUI,
  updateTopicDropdown,
} from './send';
import { applyTheme, populateSettings, setupSettings, updateServerAccessUI } from './settings';
import { elements, isConfigured, isPageMode, loadReceiveState, loadSettings, pageParams, saveLocal, state, type Tab } from './state';
import { setupTooltips } from './ui';

const appName = browser.runtime.getManifest().name;

function requestSync(): void {
  browser.runtime.sendMessage({ action: 'sync' }).catch(() => {
    // The background may be starting; its own alarm syncs anyway
  });
}

function switchTab(tab: Tab): void {
  if (tab === state.activeTab) return;
  state.activeTab = tab;

  elements.tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  elements.tabContents.forEach((content) => content.classList.toggle('active', content.id === `tab-content-${tab}`));
  document.body.classList.toggle('receive-active', tab === 'receive');

  if (tab === 'receive') {
    void loadNotifications();
    requestSync();
  }
}

/** Refresh the main view from the settings */
function updateUI(): void {
  const configured = isConfigured();
  elements.mainView.classList.toggle('disabled', !configured);
  elements.settingsBtn.classList.toggle('highlight', !configured || state.serverAccessMissing || state.heldBackFrom.length > 0);
  elements.openUrlBtn.disabled = !state.apiUrl;

  if (!configured) {
    clearTopicDropdown();
  } else {
    updateTopicDropdown();
    if (state.lastTopic && state.topics.includes(state.lastTopic)) {
      showTopic(state.lastTopic);
    }
  }
  updatePriorityUI();
}

function showSettingsView(): void {
  populateSettings();
  elements.mainView.classList.remove('active');
  elements.settingsView.classList.add('active');
  elements.backBtn.classList.add('visible');
  elements.settingsBtn.style.display = 'none';
  elements.openUrlBtn.style.display = 'none';
  elements.headerText.textContent = 'Settings';
}

function showMainView(): void {
  elements.settingsView.classList.remove('active');
  elements.mainView.classList.add('active');
  elements.backBtn.classList.remove('visible');
  elements.settingsBtn.style.display = '';
  elements.openUrlBtn.style.display = '';
  elements.headerText.textContent = appName;
  updateUI();
  applyPagePrefill();
}

/** Open this page in a browser tab (any size), or switch to that tab if it is already open */
async function openInTab(): Promise<void> {
  await openExtensionTab({ tab: state.activeTab });
  window.close();
}

/** Right Ctrl + Enter sends */
function setupKeyboardShortcut(): void {
  let rightCtrlDown = false;
  document.addEventListener('keydown', (event) => {
    if (event.code === 'ControlRight') {
      rightCtrlDown = true;
    }
    // offsetParent is null while the button or a parent is hidden
    if (event.key === 'Enter' && rightCtrlDown && elements.sendBtn.offsetParent !== null && !elements.sendBtn.disabled) {
      event.preventDefault();
      elements.sendBtn.click();
    }
  });
  document.addEventListener('keyup', (event) => {
    if (event.code === 'ControlRight') {
      rightCtrlDown = false;
    }
  });
  window.addEventListener('blur', () => {
    rightCtrlDown = false;
  });
}

async function init(): Promise<void> {
  await loadSettings();
  state.page = await getPage();
  await loadReceiveState();
  await cleanUpAfterBrowserRestart();
  await restoreDraft();
  await loadAttachments();

  elements.sendAnotherCheckbox.checked = state.sendAnotherEnabled;
  elements.includeUrlCheckbox.checked = state.includeUrl;

  setupSend();
  setupReceive();
  setupSettings();
  setupTooltips();
  setupKeyboardShortcut();
  elements.settingsBtn.addEventListener('click', showSettingsView);
  elements.backBtn.addEventListener('click', showMainView);
  elements.popoutBtn.addEventListener('click', () => void openInTab());
  elements.tabButtons.forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab as Tab)));

  await updateServerAccessUI();
  updateUI();
  applyTheme();
  renderTags();
  elements.headerText.textContent = appName;

  if (isPageMode) {
    document.body.classList.add('page-mode');
    elements.popoutBtn.style.display = 'none';
    elements.tabUrlBtn.style.display = '';
    // Coming back to this tab: the user may have moved on to another page
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') {
        state.page = await getPage();
        applyPagePrefill();
      }
    });
  }
  applyPagePrefill();

  // Opened by a click on a desktop notification: show that message
  const messageId = pageParams.get('message');
  if (messageId) {
    // All topics, saved: reloads of the receive state read the filter back
    state.receiveFilter = 'all';
    await saveLocal({ receiveTopicFilter: 'all' });
    focusMessage(messageId);
  }
  if (pageParams.get('tab') === 'receive') {
    switchTab('receive');
  } else {
    elements.messageInput.focus();
  }
  requestSync();
}

void init();
