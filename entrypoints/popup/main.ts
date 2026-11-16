// Popup and full-page view: inbox, send form, and settings.

import '@/assets/styles.css';
import { browser } from 'wxt/browser';
import { openExtensionTab } from '@/utils/extension-tab';
import { setupPaneDividers } from './pane-dividers';
import { focusMessage, loadNotifications, setupReceive } from './receive';
import {
  applyPagePrefill,
  getPage,
  loadAttachments,
  renderTags,
  restoreDraft,
  setupSend,
  setupSendPanel,
  updatePriorityUI,
  updateTopicOptions,
} from './send';
import { applyPreferences, applyTheme, hasUnsavedServerEdits, populateSettings, setupSettings, updateServerAccessUI } from './settings';
import { elements, isConfigured, isPageMode, loadReceiveFilter, loadSettings, pageParams, saveReceiveFilter, state } from './state';
import { setupTooltips, showStatus } from './ui';

const appName = browser.runtime.getManifest().name;

function requestSync(): void {
  browser.runtime.sendMessage({ action: 'sync' }).catch(() => {
    // The background may be starting; its own alarm syncs anyway
  });
}

/** Refresh the main view from the settings */
function updateUI(): void {
  const configured = isConfigured();
  elements.mainView.classList.toggle('disabled', !configured);
  elements.settingsBtn.classList.toggle('highlight', !configured || state.serverAccessMissing || state.heldBackFrom.length > 0);
  elements.openUrlBtn.disabled = !state.apiUrl;

  updateTopicOptions();
  updatePriorityUI();
}

async function showSettingsView(): Promise<void> {
  await populateSettings();
  elements.mainView.classList.remove('active');
  elements.settingsView.classList.add('active');
  elements.backBtn.focus();
}

function showMainView(): void {
  if (elements.saveServerSettings.disabled) return;
  if (hasUnsavedServerEdits() && !confirm('Discard unsaved server settings?')) return;
  elements.settingsView.classList.remove('active');
  elements.mainView.classList.add('active');
  elements.settingsBtn.focus();
  updateUI();
  void loadNotifications();
  applyPagePrefill();
}

async function focusInboxFromLink(params: URLSearchParams): Promise<void> {
  const message = params.get('message');
  const topic = params.get('topic');
  if (!message && topic === null) return;
  elements.notificationsSearch.value = '';
  if (message) focusMessage(message);
  await saveReceiveFilter(message || !state.topics.includes(topic ?? '') ? null : topic);
  updateUI();
  // Keep a settings form in progress. Its inbox will already be focused when the user returns.
  if (elements.mainView.classList.contains('active')) await loadNotifications();
}

/** Open this page in a browser tab (any size), or switch to that tab if it is already open */
async function openInTab(): Promise<void> {
  await openExtensionTab();
  window.close();
}

/** Ctrl + Enter (either Ctrl key) or Cmd + Enter sends while focus is in the composer. */
function setupKeyboardShortcut(): void {
  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      elements.sendSection.open &&
      elements.mainContent.contains(document.activeElement) &&
      elements.sendBtn.offsetParent !== null &&
      !elements.sendBtn.disabled
    ) {
      event.preventDefault();
      elements.sendBtn.click();
    }
  });
}

async function init(): Promise<void> {
  if (isPageMode) {
    document.body.classList.add('page-mode');
    elements.popoutBtn.style.display = 'none';
    elements.tabUrlBtn.style.display = '';
  }

  await Promise.all([setupPaneDividers(), setupSendPanel()]);
  await loadSettings();
  state.page = await getPage();
  await loadReceiveFilter();
  await restoreDraft();
  await loadAttachments();

  elements.sendAnotherCheckbox.checked = state.sendAnotherEnabled;
  elements.includeUrlCheckbox.checked = state.includeUrl;

  applyPreferences();
  setupSend();
  setupReceive();
  setupSettings();
  setupTooltips();
  setupKeyboardShortcut();
  elements.settingsBtn.addEventListener('click', () => void showSettingsView().catch(() => showStatus('Could not open Settings', 'error')));
  elements.backBtn.addEventListener('click', showMainView);
  elements.popoutBtn.addEventListener('click', () => void openInTab());

  await updateServerAccessUI();
  updateUI();
  applyTheme();
  renderTags();
  elements.headerText.textContent = appName;

  if (isPageMode) {
    const focusFromHash = () => focusInboxFromLink(new URLSearchParams(location.hash.slice(1)));
    window.addEventListener('hashchange', () => void focusFromHash());
    if (location.hash) await focusFromHash();
    else await focusInboxFromLink(pageParams);
    // Coming back to this tab: the user may have moved on to another page
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') {
        state.page = await getPage();
        applyPagePrefill();
      }
    });
  }
  applyPagePrefill();

  requestSync();
}

/** A failed start would leave a half-built page without a word: say so at the top of the page. */
function showStartupError(error: unknown): void {
  console.error('ntfy Desk could not start:', error);
  const banner = document.createElement('div');
  banner.className = 'status visible error startup-error';
  banner.setAttribute('role', 'alert');
  banner.textContent = `ntfy Desk could not start: ${error instanceof Error ? error.message : String(error)}. Close and reopen it.`;
  document.body.prepend(banner);
}

init().catch(showStartupError);
