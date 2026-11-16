// Settings view: server and fallback URL, token or username and password, topics, notification rules,
// badge, notification, history and inbox display preferences, include-URL option, theme and the
// keyboard shortcuts. Per-topic options (message sync, desktop notifications, send defaults) are
// staged until Apply. Backup exports the synced settings to a file and imports one after a confirmation.

import { browser } from 'wxt/browser';
import {
  getConfig,
  getStoredAuth,
  hasAuthentication,
  isHttpUrl,
  isNtfyPathPart,
  parseTopics,
  serverOrigins,
  serverPermissionPattern,
  setAccessToken,
  setAuthOrigins,
  setCredentials,
  splitCredentials,
  type Credentials,
} from '@/utils/ntfy';
import {
  NOTIFY_RULES,
  NOTIFY_RULES_KEY,
  RULE_LABELS,
  getTopicRules,
  isNotifyRule,
  ruleFor,
  storedTopicRules,
  type NotifyRule,
} from '@/utils/rules';
import {
  BackupError,
  THEMES,
  backupFileName,
  buildBackup,
  importSettings,
  previewImport,
  readBackupFile,
  type ImportPreview,
  type ParsedBackup,
} from '@/utils/backup';
import { getShortcuts, openShortcutSettings } from '@/utils/commands';
import { openExtensionTab } from '@/utils/extension-tab';
import { DEFAULT_PREFERENCES, PREFERENCE_KEYS, getPreferences, parsePreferences, type Preferences } from '@/utils/preferences';
import {
  PRIORITIES,
  PRIORITY_LABELS,
  SEND_DEFAULTS_KEY,
  getSendDefaults,
  isPriority,
  sameSendDefaults,
  splitTags,
  storedSendDefaults,
  type SendDefaults,
  sendDefaultsFit,
} from '@/utils/send-defaults';
import { SYNC_DELETION_TOPICS_KEY, getSyncDeletionTopics } from '@/utils/sync-modes';
import { loadNotifications } from './receive';
import { updateTopicOptions } from './send';
import { elements, isConfigured, isPageMode, saveReceiveFilter, saveSync, state, type Theme } from './state';
import { clearStatus, moveItem, setupDragAndDrop, showSettingsStatus } from './ui';

async function editSettings<T>(task: () => Promise<T>): Promise<T> {
  return navigator.locks.request('ntfy-settings', task);
}

export function applyTheme(): void {
  document.body.setAttribute('data-theme', state.theme);
  updateThemeChips();
}

function updateThemeChips(): void {
  elements.themeChips.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.theme === state.theme);
  });
}

/** Show the preferences in their controls, and apply the inbox density (CSS on the body) */
export function applyPreferences(): void {
  const { badgeScope, keepUrgentOnScreen, historyPerTopic, messageTimes, inboxDensity } = state.preferences;
  document.body.dataset.density = inboxDensity;
  elements.badgeScopeSelect.value = badgeScope;
  elements.keepUrgentCheckbox.checked = keepUrgentOnScreen;
  elements.historyLimitSelect.value = String(historyPerTopic);
  elements.messageTimesSelect.value = messageTimes;
  elements.densitySelect.value = inboxDensity;
}

/** A change from this view, another open view or browser sync */
function updatePreferences(stored: Partial<Record<keyof Preferences, unknown>>): void {
  const previous = state.preferences;
  state.preferences = parsePreferences({ ...previous, ...stored });
  applyPreferences();
  if (state.preferences.messageTimes !== previous.messageTimes) void loadNotifications();
}

/** Save the one preference a control edits; an invalid value falls back to the default */
function savePreference<K extends keyof Preferences>(key: K, value: unknown): void {
  const previous = state.preferences[key];
  updatePreferences({ [key]: value });
  void saveSync({ [key]: state.preferences[key] }).catch(() => {
    updatePreferences({ [key]: previous });
    showSettingsStatus('Failed to save settings', 'error');
  });
}

const SHORTCUT_HELP =
  import.meta.env.BROWSER === 'firefox'
    ? 'Open about:addons, select the gear menu, then Manage Extension Shortcuts.'
    : 'Open chrome://extensions/shortcuts in a new tab.';

/** The current bindings, as the browser reports them */
async function renderShortcuts(): Promise<void> {
  const shortcuts = await getShortcuts();
  elements.shortcutList.replaceChildren(
    ...shortcuts.flatMap(({ description, shortcut }) => {
      const name = document.createElement('dt');
      name.textContent = description;
      const binding = document.createElement('dd');
      const key = document.createElement(shortcut ? 'kbd' : 'span');
      key.className = shortcut ? 'shortcut-key' : 'shortcut-unset';
      key.textContent = shortcut || 'Not set';
      binding.append(key);
      return [name, binding];
    }),
  );
}

async function changeShortcuts(): Promise<void> {
  if (!(await openShortcutSettings())) elements.shortcutHint.textContent = `Could not open the shortcut settings. ${SHORTCUT_HELP}`;
}

const verifiesDeletions = () => state.topics.some((topic) => state.syncDeletionTopics.has(topic));

/** Access can be needed for credentials or for the server's replay metadata. */
function serverAccessPatterns(apiUrl: string, fallbackUrl: string, authenticated: boolean): string[] {
  if (!authenticated && !verifiesDeletions()) return [];
  const patterns = [apiUrl, fallbackUrl]
    .filter(Boolean)
    .map(serverPermissionPattern)
    .filter((pattern): pattern is string => pattern !== null);
  return [...new Set(patterns)];
}

/** Show "Allow access to this server" when authentication is set but a server's site isn't granted */
export async function updateServerAccessUI(
  apiUrl = state.apiUrl,
  fallbackUrl = state.fallbackUrl,
  authenticated = hasAuthentication(state),
): Promise<void> {
  const patterns = serverAccessPatterns(apiUrl, fallbackUrl, authenticated);
  let missing = false;
  if (patterns.length > 0) {
    try {
      missing = !(await browser.permissions.contains({ origins: patterns }));
    } catch {
      missing = false;
    }
  }

  state.serverAccessMissing = missing;
  elements.serverAccessBtn.style.display = missing ? '' : 'none';
  elements.serverAccessHint.style.display = missing ? '' : 'none';
  elements.serverAccessHint.textContent = verifiesDeletions()
    ? 'Allows ntfy Desk to verify cached deletions'
    : 'Needed to send and receive with authentication';
  elements.settingsBtn.classList.toggle('highlight', !isConfigured() || missing || state.heldBackFrom.length > 0);
}

const typedAuth = () => Boolean(elements.tokenInput.value || elements.usernameInput.value || elements.passwordInput.value);

/** Warn when credentials would go to a server over plain http:// */
function updateInsecureWarning(): void {
  const insecure = [elements.urlInput.value, elements.fallbackUrlInput.value].some((url) => /^\s*http:\/\//i.test(url));
  elements.insecureWarning.style.display = insecure && typedAuth() ? '' : 'none';
}

/** The stored token and password aren't sent to a server that changed outside these settings */
function updateHeldBackUI(): void {
  const held = state.heldBackFrom;
  elements.heldBackBox.style.display = held.length > 0 ? '' : 'none';
  elements.heldBackText.textContent =
    held.length > 0
      ? `The server address changed outside these settings (e.g. through browser sync) to ${held.join(', ')}. Your token and password aren't sent there until you confirm.`
      : '';
  elements.settingsBtn.classList.toggle('highlight', !isConfigured() || state.serverAccessMissing || held.length > 0);
}

/** The user confirms the current servers for the token and password */
async function approveServers(): Promise<void> {
  try {
    await editSettings(async () => {
      const saved = await getConfig();
      if (saved.apiUrl !== state.apiUrl || saved.fallbackUrl !== state.fallbackUrl) throw new Error('Settings changed');
      await setAuthOrigins(serverOrigins(saved.apiUrl, saved.fallbackUrl));
      state.heldBackFrom = [];
    });
    updateHeldBackUI();
    showSettingsStatus('Token and password are used with this server', 'success');
  } catch {
    showSettingsStatus('Could not approve this server. Reopen Settings and try again.', 'error');
  }
}

function requestServerAccess(): void {
  const { apiUrl, fallbackUrl } = state;
  const authenticated = hasAuthentication(state);
  const patterns = serverAccessPatterns(apiUrl, fallbackUrl, authenticated);
  if (patterns.length === 0) return;

  // Called directly from the click: permissions.request needs a user gesture
  void browser.permissions.request({ origins: patterns }).then((granted) => {
    showSettingsStatus(granted ? 'Server access granted' : 'Server access not granted', granted ? 'success' : 'error');
    void updateServerAccessUI(apiUrl, fallbackUrl, authenticated);
  });
}

/**
 * user:password@ typed or pasted into a server URL goes into the username and password fields, and
 * query strings and fragments are discarded before the URL is synced
 */
function readServerEdits(): Pick<typeof state, 'apiUrl' | 'fallbackUrl' | 'accessToken' | 'credentials'> | null {
  const apiUrl = elements.urlInput.value.trim();
  const fallbackUrl = elements.fallbackUrlInput.value.trim();
  if ((apiUrl && !isHttpUrl(apiUrl)) || (fallbackUrl && !isHttpUrl(fallbackUrl))) return null;
  const main = splitCredentials(apiUrl);
  const fallback = splitCredentials(fallbackUrl);
  const typed: Credentials = { username: elements.usernameInput.value, password: elements.passwordInput.value };
  return {
    apiUrl: main.url,
    fallbackUrl: fallback.url,
    accessToken: elements.tokenInput.value,
    credentials: main.credentials ?? fallback.credentials ?? (typed.username || typed.password ? typed : null),
  };
}

const sameCredentials = (a: Credentials | null, b: Credentials | null) => a?.username === b?.username && a?.password === b?.password;

export function hasUnsavedServerEdits(): boolean {
  return (
    elements.urlInput.value.trim() !== state.apiUrl ||
    elements.fallbackUrlInput.value.trim() !== state.fallbackUrl ||
    elements.tokenInput.value !== state.accessToken ||
    elements.usernameInput.value !== (state.credentials?.username ?? '') ||
    elements.passwordInput.value !== (state.credentials?.password ?? '')
  );
}

async function saveServerSettings(): Promise<void> {
  clearStatus(elements.settingsStatus);
  const draft = readServerEdits();
  if (!draft) {
    showSettingsStatus('Enter a complete http:// or https:// server URL, or leave the field empty', 'error');
    return;
  }
  const { apiUrl, fallbackUrl, accessToken, credentials } = draft;
  elements.saveServerSettings.disabled = true;
  try {
    await editSettings(async () => {
      const saved = await getConfig();
      const auth = await getStoredAuth();
      if (
        saved.apiUrl !== state.apiUrl ||
        saved.fallbackUrl !== state.fallbackUrl ||
        auth.accessToken !== state.accessToken ||
        !sameCredentials(auth.credentials, state.credentials)
      ) {
        showSettingsStatus('Server settings changed in another view. Reopen Settings before saving.', 'warning');
        return;
      }
      const urlsEdited = apiUrl !== saved.apiUrl || fallbackUrl !== saved.fallbackUrl;
      // Hold existing authentication while changing the destination.
      if (urlsEdited) await setAuthOrigins([]);
      if (accessToken !== auth.accessToken) await setAccessToken(accessToken);
      if (!sameCredentials(credentials, auth.credentials)) await setCredentials(credentials);
      if (urlsEdited) {
        await saveSync({ apiUrl, fallbackUrl });
        await setAuthOrigins(serverOrigins(apiUrl, fallbackUrl));
      }
      Object.assign(state, draft);
      state.heldBackFrom = (await getConfig()).heldBackFrom;
      fillServerFields();
      updateHeldBackUI();
      updateInsecureWarning();
      void updateServerAccessUI();
      showSettingsStatus('Server settings saved', 'success');
    });
  } catch {
    showSettingsStatus('Failed to save settings', 'error');
  } finally {
    elements.saveServerSettings.disabled = false;
  }
}

const pendingModes = new Map<string, boolean>();
const pendingRules = new Map<string, NotifyRule>();
/** Send defaults edited and not applied yet; null removes a topic's defaults */
const pendingDefaults = new Map<string, SendDefaults | null>();
let applyingTopicSettings = false;

async function refreshTopics(): Promise<void> {
  const [{ topics }, modes, rules, defaults] = await Promise.all([
    browser.storage.sync.get('topics'),
    getSyncDeletionTopics(),
    getTopicRules(),
    getSendDefaults(),
  ]);
  state.topics = parseTopics(topics);
  state.syncDeletionTopics = modes;
  state.notifyRules = rules;
  state.topicSendDefaults = defaults;
  renderTopics();
  updateTopicOptions();
}

function updateApplyButton(): void {
  elements.applyTopicSettings.disabled =
    applyingTopicSettings || (pendingModes.size === 0 && pendingRules.size === 0 && pendingDefaults.size === 0);
}

function topicEdited(): void {
  elements.topicSettingsStatus.textContent = '';
  updateApplyButton();
}

function topicSelect(label: string, options: [string, string][], value: string, onChange: (value: string) => void): HTMLTableCellElement {
  const cell = document.createElement('td');
  const select = document.createElement('select');
  select.className = 'topic-setting-select';
  select.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener('change', () => {
    onChange(select.value);
    topicEdited();
  });
  cell.append(select);
  return cell;
}

/**
 * A topic's send defaults: the priority select ("Last used" for none) and the tags that go with it.
 * The tags field is only in use with a priority: together they are what the Send form starts with.
 */
function sendDefaultsCells(topic: string): HTMLTableCellElement[] {
  const saved = state.topicSendDefaults.get(topic);
  const shown = pendingDefaults.has(topic) ? (pendingDefaults.get(topic) ?? undefined) : saved;

  const tagsCell = document.createElement('td');
  const tags = document.createElement('input');
  tags.type = 'text';
  tags.className = 'topic-setting-input';
  tags.setAttribute('aria-label', `Send tags for ${topic}`);
  tags.autocomplete = 'off';
  tags.spellcheck = false;
  tags.value = shown ? shown.tags.join(', ') : '';
  const showTagsState = (enabled: boolean) => {
    tags.disabled = !enabled;
    tags.placeholder = enabled ? 'None' : 'Last used';
  };
  showTagsState(shown !== undefined);
  tagsCell.append(tags);

  const stage = () => {
    const priority = Number(select.value);
    const edited = isPriority(priority) ? { priority, tags: splitTags(tags.value) } : undefined;
    showTagsState(edited !== undefined);
    if (sameSendDefaults(edited, saved)) pendingDefaults.delete(topic);
    else pendingDefaults.set(topic, edited ?? null);
    topicEdited();
  };
  const priorityCell = topicSelect(
    `Send priority for ${topic}`,
    [['', 'Last used'], ...PRIORITIES.map((priority): [string, string] => [String(priority), PRIORITY_LABELS[priority]])],
    shown ? String(shown.priority) : '',
    () => stage(),
  );
  const select = priorityCell.querySelector('select')!;
  tags.addEventListener('input', stage);
  return [priorityCell, tagsCell];
}

function renderTopicSettings(): void {
  elements.topicSettingsGroup.hidden = state.topics.length === 0;
  elements.topicSettingsRows.replaceChildren(
    ...state.topics.map((topic) => {
      const row = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      name.textContent = topic;
      const enabled = state.syncDeletionTopics.has(topic);
      const rule = ruleFor(state.notifyRules, topic);
      row.append(
        name,
        topicSelect(
          `Message sync for ${topic}`,
          [
            ['keep', 'Keep received messages'],
            ['sync', 'Sync server deletions'],
          ],
          (pendingModes.get(topic) ?? enabled) ? 'sync' : 'keep',
          (value) => {
            const sync = value === 'sync';
            if (sync === enabled) pendingModes.delete(topic);
            else pendingModes.set(topic, sync);
          },
        ),
        topicSelect(
          `Desktop notifications for ${topic}`,
          NOTIFY_RULES.map((value) => [value, RULE_LABELS[value]]),
          pendingRules.get(topic) ?? rule,
          (value) => {
            if (!isNotifyRule(value)) return;
            if (value === rule) pendingRules.delete(topic);
            else pendingRules.set(topic, value);
          },
        ),
        ...sendDefaultsCells(topic),
      );
      return row;
    }),
  );
  updateApplyButton();
}

class SendDefaultsTooLarge extends Error {}

async function applyTopicSettings(): Promise<void> {
  applyingTopicSettings = true;
  updateApplyButton();
  elements.topicSettingsRows.inert = true;
  try {
    // Merge only edited fields so applying a draft cannot overwrite unrelated synced settings.
    const enabledDeletions = await editSettings(async () => {
      const [{ topics }, modes, rules, defaults] = await Promise.all([
        browser.storage.sync.get('topics'),
        getSyncDeletionTopics(),
        getTopicRules(),
        getSendDefaults(),
      ]);
      let enabled = false;
      for (const topic of parseTopics(topics)) {
        const mode = pendingModes.get(topic);
        if (mode === true) {
          enabled ||= !modes.has(topic);
          modes.add(topic);
        } else if (mode === false) {
          modes.delete(topic);
        }
        const rule = pendingRules.get(topic);
        if (rule !== undefined) rules.set(topic, rule);
        const sendDefaults = pendingDefaults.get(topic);
        if (sendDefaults) defaults.set(topic, sendDefaults);
        else if (sendDefaults === null) defaults.delete(topic);
      }
      if (pendingDefaults.size > 0 && !sendDefaultsFit(defaults)) throw new SendDefaultsTooLarge();
      await saveSync({
        [SYNC_DELETION_TOPICS_KEY]: [...modes],
        [NOTIFY_RULES_KEY]: storedTopicRules(rules),
        ...(pendingDefaults.size > 0 && { [SEND_DEFAULTS_KEY]: storedSendDefaults(defaults) }),
      });
      return enabled;
    });
    pendingModes.clear();
    pendingRules.clear();
    pendingDefaults.clear();
    await refreshTopics();
    void updateServerAccessUI();
    elements.topicSettingsStatus.textContent = enabledDeletions ? 'Applied. Cached deletion check requested.' : 'Applied.';
  } catch (error) {
    elements.topicSettingsStatus.textContent =
      error instanceof SendDefaultsTooLarge
        ? 'Nothing applied: the send tags of all topics together are too long to sync. Shorten or remove some.'
        : 'Could not apply topic settings. Try again.';
  } finally {
    applyingTopicSettings = false;
    elements.topicSettingsRows.inert = false;
    updateApplyButton();
  }
}

function renderTopics(): void {
  renderTopicSettings();
  elements.topicsContainer.querySelectorAll('.topic-badge').forEach((badge) => badge.remove());

  const shown = state.topics;
  shown.forEach((topic, index) => {
    const badge = document.createElement('div');
    badge.className = 'topic-badge';
    badge.textContent = topic;
    setupDragAndDrop(badge, index, 'topic', (from, to) => {
      void changeTopics((current) => moveItem(current, current.indexOf(shown[from] ?? ''), current.indexOf(shown[to] ?? '')));
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'topic-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove topic ${topic}`);
    remove.addEventListener('click', () => {
      elements.newTopicInput.focus();
      void removeTopic(topic);
    });
    badge.appendChild(remove);
    elements.topicsContainer.insertBefore(badge, elements.newTopicInput);
  });
}

async function changeTopics(edit: (topics: string[]) => void, removed?: string): Promise<void> {
  try {
    await editSettings(async () => {
      const [{ topics }, modes, rules, defaults] = await Promise.all([
        browser.storage.sync.get('topics'),
        getSyncDeletionTopics(),
        getTopicRules(),
        getSendDefaults(),
      ]);
      const current = parseTopics(topics);
      edit(current);
      const updates: Record<string, unknown> = { topics: current.join(',') };
      if (removed && modes.delete(removed)) updates[SYNC_DELETION_TOPICS_KEY] = [...modes];
      if (removed && rules.delete(removed)) updates[NOTIFY_RULES_KEY] = storedTopicRules(rules);
      if (removed && defaults.delete(removed)) updates[SEND_DEFAULTS_KEY] = storedSendDefaults(defaults);
      await saveSync(updates);
    });
    await refreshTopics();
  } catch {
    showSettingsStatus('Failed to save topics', 'error');
  }
}

async function removeTopic(topic: string): Promise<void> {
  if (applyingTopicSettings) return;
  if (state.receiveFilter === topic) void saveReceiveFilter(null).catch(() => {});
  pendingModes.delete(topic);
  pendingRules.delete(topic);
  pendingDefaults.delete(topic);
  await changeTopics((current) => {
    const index = current.indexOf(topic);
    if (index >= 0) current.splice(index, 1);
  }, topic);
}

function handleTopicKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    const value = elements.newTopicInput.value.trim();
    if (value) {
      if (!isNtfyPathPart(value)) {
        showSettingsStatus('Use up to 64 letters, numbers, dashes or underscores for a topic', 'error');
        return;
      }
      void changeTopics((current) => {
        if (!current.includes(value)) current.push(value);
      });
      elements.newTopicInput.value = '';
      updateTopicInputHint();
    }
  } else if (event.key === 'Backspace' && !elements.newTopicInput.value && state.topics.length > 0) {
    // Empty input: Backspace removes the last topic
    const last = state.topics.at(-1);
    if (last) void removeTopic(last);
  }
}

function updateTopicInputHint(): void {
  elements.topicInputHint.classList.toggle('visible', elements.newTopicInput.value.length > 0);
}

function fillServerFields(): void {
  elements.urlInput.value = state.apiUrl;
  elements.fallbackUrlInput.value = state.fallbackUrl;
  elements.tokenInput.value = state.accessToken;
  elements.usernameInput.value = state.credentials?.username ?? '';
  elements.passwordInput.value = state.credentials?.password ?? '';
}

// ==================
// Backup: export and import
// ==================

/** The file picked for import, validated, and what it would change; null when nothing waits for confirmation */
let pendingImport: { backup: ParsedBackup; preview: ImportPreview } | null = null;

/** The toolbar popup can't keep a file dialog open: the Backup group of the extension's tab takes over */
async function continueInTab(): Promise<void> {
  try {
    await openExtensionTab({ settings: 'backup' });
    window.close();
  } catch {
    showSettingsStatus('Could not open ntfy Desk in a tab. Open it with the header button, then use Backup there.', 'error');
  }
}

/**
 * A download of text the page made itself: a Blob URL on a link with `download`, which needs no
 * permission. Firefox's toolbar popup hands it to the tab instead: the popup closes when a save
 * dialog takes the focus, which discards the Blob before it is written.
 */
async function exportSettings(): Promise<void> {
  if (!isPageMode && import.meta.env.BROWSER === 'firefox') return continueInTab();
  try {
    const name = backupFileName();
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(await buildBackup(), null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showSettingsStatus(`Settings exported as ${name}`, 'success');
  } catch {
    showSettingsStatus('Could not export the settings', 'error');
  }
}

function closeImportConfirm(): void {
  pendingImport = null;
  elements.importConfirm.hidden = true;
  elements.importConfirmList.replaceChildren();
}

const shownUrl = (url: string) => url || 'none';
const replaced = (from: string, to: string) => (from === to ? `${to} (unchanged)` : `${to} (now ${from})`);

/** What the import will change, for the user to confirm. The file's values are shown with textContent only. */
function showImportConfirm(fileName: string): void {
  if (!pendingImport) return;
  const { backup, preview } = pendingImport;
  const shortName = fileName.length > 80 ? `${fileName.slice(0, 77)}…` : fileName;
  const exported = backup.exportedAt ? `, exported ${backup.exportedAt.toLocaleString()}` : '';
  elements.importConfirmTitle.textContent = `Replace the settings with those from ${shortName}${exported}?`;
  const lines = [
    `Server URL: ${replaced(shownUrl(preview.apiUrl.from), shownUrl(preview.apiUrl.to))}`,
    `Fallback URL: ${replaced(shownUrl(preview.fallbackUrl.from), shownUrl(preview.fallbackUrl.to))}`,
    `Topics: ${replaced(String(preview.topics.from), String(preview.topics.to))}`,
    'All other settings are replaced too: topic settings, notifications, inbox, sending, appearance and layout. A setting the file lacks returns to its default.',
    'Your token and password stay as they are. Received messages are not part of the file.',
  ];
  if (preview.historyPerTopic.to < preview.historyPerTopic.from) {
    lines.push(
      `Messages kept per topic: ${preview.historyPerTopic.to} (now ${preview.historyPerTopic.from}). Older messages beyond ${preview.historyPerTopic.to} per topic are deleted.`,
    );
  }
  if (preview.heldBackFrom.length > 0) {
    lines.push(`Your token and password aren't sent to ${preview.heldBackFrom.join(', ')} until you confirm that under Server.`);
  }
  if (backup.urlPartsRemoved) lines.push('A username, password, query string or fragment in a server URL of the file is ignored.');
  if (backup.skipped.length > 0) lines.push(`Not valid in the file, so not imported: ${backup.skipped.join(', ')}.`);
  elements.importConfirmList.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement('li');
      item.textContent = line;
      return item;
    }),
  );
  elements.importConfirm.hidden = false;
  elements.importConfirmTitle.focus();
}

async function pickImportFile(): Promise<void> {
  const file = elements.importSettingsInput.files?.[0];
  elements.importSettingsInput.value = '';
  if (!file) return;
  closeImportConfirm();
  clearStatus(elements.settingsStatus);
  try {
    const backup = await readBackupFile(file);
    pendingImport = { backup, preview: await previewImport(backup.settings) };
    showImportConfirm(file.name);
  } catch (error) {
    closeImportConfirm();
    showSettingsStatus(error instanceof BackupError ? error.message : 'Could not read the file', 'error');
  }
}

async function confirmImport(): Promise<void> {
  const pending = pendingImport;
  if (!pending || elements.importConfirmBtn.disabled) return;
  elements.importConfirmBtn.disabled = true;
  try {
    await editSettings(() => importSettings(pending.backup.settings, pending.preview.baseline));
    closeImportConfirm();
    // The form, the topic table and this view's state now show what was imported, not what was there
    // before: a later "Save server settings" starts from the imported values.
    await populateSettings();
    state.lastTopic = pending.backup.settings.lastTopic || undefined;
    const held = state.heldBackFrom.length > 0;
    showSettingsStatus(
      held ? 'Settings imported. Confirm the server under Server before your token and password are used.' : 'Settings imported',
      held ? 'warning' : 'success',
    );
  } catch (error) {
    closeImportConfirm();
    showSettingsStatus(error instanceof BackupError ? error.message : 'Could not import the settings. Nothing was changed.', 'error');
  } finally {
    elements.importConfirmBtn.disabled = false;
  }
}

/** Refresh shared settings when opening the editor, leaving the draft untouched. */
export async function populateSettings(): Promise<void> {
  clearStatus(elements.settingsStatus);
  closeImportConfirm();
  const [config, { theme }] = await Promise.all([getConfig(), browser.storage.sync.get('theme')]);
  const auth = await getStoredAuth();
  Object.assign(state, {
    apiUrl: config.apiUrl,
    fallbackUrl: config.fallbackUrl,
    heldBackFrom: config.heldBackFrom,
    includeUrl: config.includeUrl,
    ...auth,
    theme: theme === 'dark' || theme === 'light' ? theme : 'auto',
  });
  pendingModes.clear();
  pendingRules.clear();
  pendingDefaults.clear();
  elements.topicSettingsStatus.textContent = '';
  fillServerFields();
  elements.includeUrlCheckbox.checked = state.includeUrl;
  state.preferences = await getPreferences().catch(() => state.preferences);
  applyPreferences();
  void renderShortcuts();
  await refreshTopics();
  applyTheme();
  updateHeldBackUI();
  updateInsecureWarning();
  void updateServerAccessUI();
}

export function setupSettings(): void {
  const saveSetting = (patch: Record<string, unknown>) => {
    void saveSync(patch).catch(() => showSettingsStatus('Failed to save settings', 'error'));
  };
  elements.saveServerSettings.addEventListener('click', () => void saveServerSettings());
  elements.includeUrlCheckbox.addEventListener('change', () => {
    state.includeUrl = elements.includeUrlCheckbox.checked;
    saveSetting({ includeUrl: state.includeUrl });
  });
  elements.badgeScopeSelect.addEventListener('change', () => savePreference('badgeScope', elements.badgeScopeSelect.value));
  elements.keepUrgentCheckbox.addEventListener('change', () => savePreference('keepUrgentOnScreen', elements.keepUrgentCheckbox.checked));
  elements.historyLimitSelect.addEventListener('change', () =>
    savePreference('historyPerTopic', Number(elements.historyLimitSelect.value)),
  );
  elements.messageTimesSelect.addEventListener('change', () => savePreference('messageTimes', elements.messageTimesSelect.value));
  elements.densitySelect.addEventListener('change', () => savePreference('inboxDensity', elements.densitySelect.value));
  // requireInteraction is Chromium-only: Firefox has no such option
  elements.keepUrgentGroup.hidden = import.meta.env.BROWSER === 'firefox';
  elements.shortcutSettingsBtn.addEventListener('click', () => void changeShortcuts());
  // Chromium has no event for a changed shortcut: read them again when the user comes back
  window.addEventListener('focus', () => {
    if (elements.settingsView.classList.contains('active')) void renderShortcuts();
  });
  elements.applyTopicSettings.addEventListener('click', () => void applyTopicSettings());
  elements.exportSettingsBtn.addEventListener('click', () => void exportSettings());
  // Called directly from the click: opening a file dialog needs a user gesture
  elements.importSettingsBtn.addEventListener('click', () => {
    if (isPageMode) elements.importSettingsInput.click();
    else void continueInTab();
  });
  elements.importSettingsInput.addEventListener('change', () => void pickImportFile());
  elements.importConfirmBtn.addEventListener('click', () => void confirmImport());
  elements.importCancelBtn.addEventListener('click', () => {
    closeImportConfirm();
    elements.importSettingsBtn.focus();
  });
  elements.serverAccessBtn.addEventListener('click', requestServerAccess);
  elements.heldBackBtn.addEventListener('click', () => void approveServers());
  for (const input of [elements.urlInput, elements.fallbackUrlInput, elements.tokenInput, elements.usernameInput, elements.passwordInput]) {
    input.addEventListener('input', updateInsecureWarning);
  }

  elements.newTopicInput.addEventListener('keydown', handleTopicKeydown);
  elements.newTopicInput.addEventListener('input', updateTopicInputHint);
  elements.topicsContainer.addEventListener('click', (event) => {
    // A click on the container focuses the input
    if (event.target === elements.topicsContainer) {
      elements.newTopicInput.focus();
    }
  });

  elements.themeChips.addEventListener('click', (event) => {
    const theme = (event.target as Element).closest<HTMLElement>('.chip')?.dataset.theme;
    if (theme !== 'light' && theme !== 'dark' && theme !== 'auto') return;
    state.theme = theme satisfies Theme;
    applyTheme();
    saveSetting({ theme });
  });
  browser.storage.onChanged.addListener((changes, area) => {
    // Changed in another view, by an import or through browser sync
    if (area === 'sync' && changes.theme) {
      const theme = changes.theme.newValue;
      state.theme = (THEMES as readonly unknown[]).includes(theme) ? (theme as Theme) : 'auto';
      applyTheme();
    }
    if (area === 'sync' && changes.includeUrl) {
      state.includeUrl = changes.includeUrl.newValue === true;
      elements.includeUrlCheckbox.checked = state.includeUrl;
    }
    if (area === 'sync' && changes.sendAnotherEnabled) {
      state.sendAnotherEnabled = changes.sendAnotherEnabled.newValue === true;
      elements.sendAnotherCheckbox.checked = state.sendAnotherEnabled;
    }
    if (area === 'sync' && changes.sendAsZipEnabled) state.sendAsZipEnabled = changes.sendAsZipEnabled.newValue === true;
    if (area === 'sync' && PREFERENCE_KEYS.some((key) => changes[key])) {
      // A removed key reads as its default
      updatePreferences(
        Object.fromEntries(
          PREFERENCE_KEYS.filter((key) => changes[key]).map((key) => [key, changes[key]?.newValue ?? DEFAULT_PREFERENCES[key]]),
        ),
      );
    }
    if (
      area === 'sync' &&
      elements.settingsView.classList.contains('active') &&
      (changes.topics || changes[SYNC_DELETION_TOPICS_KEY] || changes[NOTIFY_RULES_KEY] || changes[SEND_DEFAULTS_KEY])
    ) {
      void refreshTopics().catch(() => showSettingsStatus('Could not refresh topics', 'error'));
    }
  });
}
