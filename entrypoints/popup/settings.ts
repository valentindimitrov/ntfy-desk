// Settings view: server and fallback URL, token or username and password, topics, notification rules,
// include-URL option and theme. Changes save as you type.

import { browser } from 'wxt/browser';
import {
  getConfig,
  hasAuthentication,
  serverOrigins,
  setAccessToken,
  setAuthOrigins,
  setCredentials,
  splitCredentials,
  type Credentials,
} from '@/utils/ntfy';
import { NOTIFY_RULES, NOTIFY_RULES_KEY, RULE_LABELS, isNotifyRule, ruleFor, storedTopicRules, type TopicRules } from '@/utils/rules';
import { SYNC_DELETION_TOPICS_KEY } from '@/utils/sync-modes';
import { updateTopicDropdown } from './send';
import { elements, isConfigured, saveSync, state, type Theme } from './state';
import { debounce, moveItem, setupDragAndDrop, showSettingsStatus } from './ui';

export function applyTheme(): void {
  document.body.setAttribute('data-theme', state.theme);
  updateThemeChips();
}

function updateThemeChips(): void {
  elements.themeChips.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.theme === state.theme);
  });
}

// ntfy answers CORS preflights with Access-Control-Allow-Headers: *, which doesn't cover
// Authorization, so authenticated requests need a host permission for the server.
function serverOriginPattern(apiUrl: string): string | null {
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    // Match patterns have no port and match every port
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

/** Sites of the main and fallback servers, when requests to them send credentials */
function authenticatedPatterns(apiUrl: string, fallbackUrl: string, authenticated: boolean): string[] {
  if (!authenticated) return [];
  const patterns = [apiUrl, fallbackUrl]
    .filter(Boolean)
    .map(serverOriginPattern)
    .filter((pattern): pattern is string => pattern !== null);
  return [...new Set(patterns)];
}

/** Show "Allow access to this server" when authentication is set but a server's site isn't granted */
export async function updateServerAccessUI(
  apiUrl = state.apiUrl,
  fallbackUrl = state.fallbackUrl,
  authenticated = hasAuthentication(state),
): Promise<void> {
  const patterns = authenticatedPatterns(apiUrl, fallbackUrl, authenticated);
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
    await setAuthOrigins(serverOrigins(state.apiUrl, state.fallbackUrl));
    state.heldBackFrom = (await getConfig()).heldBackFrom;
    updateHeldBackUI();
    showSettingsStatus('Token and password are used with this server', 'success');
  } catch {
    showSettingsStatus('Failed to save settings', 'error');
  }
}

function requestServerAccess(): void {
  const apiUrl = splitCredentials(elements.urlInput.value.trim()).url;
  const fallbackUrl = splitCredentials(elements.fallbackUrlInput.value.trim()).url;
  const authenticated = typedAuth();
  const patterns = authenticatedPatterns(apiUrl, fallbackUrl, authenticated);
  if (patterns.length === 0) return;

  // Called directly from the click: permissions.request needs a user gesture
  void browser.permissions.request({ origins: patterns }).then((granted) => {
    showSettingsStatus(granted ? 'Server access granted' : 'Server access not granted', granted ? 'success' : 'error');
    void updateServerAccessUI(apiUrl, fallbackUrl, authenticated);
  });
}

/**
 * user:password@ typed or pasted into a server URL goes into the username and password fields, and
 * the URL keeps the rest: URLs are synced, credentials stay on this device
 */
function moveUrlCredentialsToFields(): { apiUrl: string; fallbackUrl: string } {
  const main = splitCredentials(elements.urlInput.value.trim());
  const fallback = splitCredentials(elements.fallbackUrlInput.value.trim());
  const fromUrl = main.credentials ?? fallback.credentials;
  if (fromUrl) {
    elements.usernameInput.value = fromUrl.username;
    elements.passwordInput.value = fromUrl.password;
  }
  if (main.credentials) elements.urlInput.value = main.url;
  if (fallback.credentials) elements.fallbackUrlInput.value = fallback.url;
  return { apiUrl: main.url, fallbackUrl: fallback.url };
}

async function saveSettings(): Promise<void> {
  const { apiUrl, fallbackUrl } = moveUrlCredentialsToFields();
  const accessToken = elements.tokenInput.value;
  const typed: Credentials = { username: elements.usernameInput.value, password: elements.passwordInput.value };
  const credentials = typed.username || typed.password ? typed : null;
  try {
    await saveSync({
      apiUrl,
      fallbackUrl,
      topics: state.topics.join(','),
      theme: state.theme,
      includeUrl: elements.includeUrlCheckbox.checked,
      sendAsZipEnabled: state.sendAsZipEnabled,
    });
    // The token and the credentials stay in storage.local, so browser sync doesn't copy them
    await setAccessToken(accessToken);
    await setCredentials(credentials);
    // Server URLs saved here are approved for them; a server changed elsewhere (held back) stays
    // unapproved until confirmed, also when another setting is saved meanwhile
    const urlsEdited = apiUrl !== state.apiUrl || fallbackUrl !== state.fallbackUrl;
    if (state.heldBackFrom.length === 0 || urlsEdited) {
      await setAuthOrigins(serverOrigins(apiUrl, fallbackUrl));
    }
    await saveNotifyRules();
    state.apiUrl = apiUrl;
    state.fallbackUrl = fallbackUrl;
    state.accessToken = accessToken;
    state.credentials = credentials;
    state.includeUrl = elements.includeUrlCheckbox.checked;
    state.heldBackFrom = (await getConfig()).heldBackFrom;

    // Not a full refresh: that would disturb typing
    updateTopicDropdown();
    renderTopics();
    updateThemeChips();
    updateHeldBackUI();
    updateInsecureWarning();
    void updateServerAccessUI();
  } catch {
    showSettingsStatus('Failed to save settings', 'error');
  }
}

/** One rule per configured topic; rules of removed topics are dropped */
function saveNotifyRules(): Promise<void> {
  const rules: TopicRules = new Map();
  for (const topic of state.topics) {
    const rule = state.notifyRules.get(topic);
    if (rule) rules.set(topic, rule);
  }
  state.notifyRules = rules;
  return saveSync({ [NOTIFY_RULES_KEY]: storedTopicRules(rules) });
}

function saveSyncModes(): Promise<void> {
  const topics = state.topics.filter((topic) => state.syncDeletionTopics.has(topic));
  state.syncDeletionTopics = new Set(topics);
  return saveSync({ [SYNC_DELETION_TOPICS_KEY]: topics });
}

function renderTopicSelects(
  group: HTMLElement,
  container: HTMLElement,
  label: string,
  options: [value: string, label: string][],
  valueFor: (topic: string) => string,
  onChange: (topic: string, value: string) => Promise<void>,
): void {
  group.style.display = state.topics.length > 0 ? '' : 'none';
  container.replaceChildren(
    ...state.topics.map((topic) => {
      const row = document.createElement('label');
      row.className = 'topic-setting';

      const name = document.createElement('span');
      name.className = 'topic-setting-name';
      name.textContent = topic;

      const select = document.createElement('select');
      select.className = 'topic-setting-select';
      select.setAttribute('aria-label', `${label} for ${topic}`);
      for (const [value, text] of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
      }
      select.value = valueFor(topic);
      select.addEventListener('change', () => {
        onChange(topic, select.value).catch(() => showSettingsStatus('Failed to save settings', 'error'));
      });

      row.append(name, select);
      return row;
    }),
  );
}

function renderTopics(): void {
  renderTopicSelects(
    elements.notifyRulesGroup,
    elements.notifyRules,
    'Desktop notifications',
    NOTIFY_RULES.map((rule) => [rule, RULE_LABELS[rule]]),
    (topic) => ruleFor(state.notifyRules, topic),
    async (topic, value) => {
      if (!isNotifyRule(value)) return;
      state.notifyRules.set(topic, value);
      await saveNotifyRules();
    },
  );
  renderTopicSelects(
    elements.syncModesGroup,
    elements.syncModes,
    'Message sync',
    [
      ['keep', 'Keep received messages'],
      ['sync', 'Sync server deletions'],
    ],
    (topic) => (state.syncDeletionTopics.has(topic) ? 'sync' : 'keep'),
    (topic, value) => {
      if (value === 'sync') state.syncDeletionTopics.add(topic);
      else state.syncDeletionTopics.delete(topic);
      return saveSyncModes();
    },
  );
  elements.topicsContainer.querySelectorAll('.topic-badge').forEach((badge) => badge.remove());

  state.topics.forEach((topic, index) => {
    const badge = document.createElement('div');
    badge.className = 'topic-badge';
    badge.textContent = topic;
    setupDragAndDrop(badge, index, 'topic', (from, to) => {
      moveItem(state.topics, from, to);
      renderTopics();
      void saveSettings();
    });

    const remove = document.createElement('span');
    remove.className = 'topic-remove';
    remove.dataset.index = String(index);
    remove.textContent = '×';
    badge.appendChild(remove);
    elements.topicsContainer.insertBefore(badge, elements.newTopicInput);
  });
}

function removeTopic(index: number): void {
  const [topic] = state.topics.splice(index, 1);
  if (topic === undefined) return;
  if (state.syncDeletionTopics.delete(topic)) {
    saveSyncModes().catch(() => showSettingsStatus('Failed to save settings', 'error'));
  }
  renderTopics();
  void saveSettings();
}

function handleTopicKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    const value = elements.newTopicInput.value.trim();
    if (value) {
      if (!state.topics.includes(value)) {
        state.topics.push(value);
        renderTopics();
        void saveSettings();
      }
      elements.newTopicInput.value = '';
      updateTopicInputHint();
    }
  } else if (event.key === 'Backspace' && !elements.newTopicInput.value && state.topics.length > 0) {
    // Empty input: Backspace removes the last topic
    removeTopic(state.topics.length - 1);
  }
}

function updateTopicInputHint(): void {
  elements.topicInputHint.classList.toggle('visible', elements.newTopicInput.value.length > 0);
}

/** Fill the form from the current settings, when the view opens */
export function populateSettings(): void {
  elements.urlInput.value = state.apiUrl;
  elements.fallbackUrlInput.value = state.fallbackUrl;
  elements.tokenInput.value = state.accessToken;
  elements.usernameInput.value = state.credentials?.username ?? '';
  elements.passwordInput.value = state.credentials?.password ?? '';
  elements.includeUrlCheckbox.checked = state.includeUrl;
  renderTopics();
  updateThemeChips();
  updateHeldBackUI();
  updateInsecureWarning();
  void updateServerAccessUI();
}

export function setupSettings(): void {
  const debouncedSave = debounce(() => void saveSettings(), 1000);
  elements.urlInput.addEventListener('input', debouncedSave);
  elements.fallbackUrlInput.addEventListener('input', debouncedSave);
  elements.tokenInput.addEventListener('input', debouncedSave);
  elements.usernameInput.addEventListener('input', debouncedSave);
  elements.passwordInput.addEventListener('input', debouncedSave);
  elements.includeUrlCheckbox.addEventListener('change', () => void saveSettings());
  elements.serverAccessBtn.addEventListener('click', requestServerAccess);
  elements.heldBackBtn.addEventListener('click', () => void approveServers());
  for (const input of [elements.urlInput, elements.fallbackUrlInput, elements.tokenInput, elements.usernameInput, elements.passwordInput]) {
    input.addEventListener('input', updateInsecureWarning);
  }

  elements.newTopicInput.addEventListener('keydown', handleTopicKeydown);
  elements.newTopicInput.addEventListener('input', updateTopicInputHint);
  elements.topicsContainer.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains('topic-remove')) {
      removeTopic(Number(target.dataset.index));
    }
    // A click on the container focuses the input
    if (target === elements.topicsContainer) {
      elements.newTopicInput.focus();
    }
  });

  elements.themeChips.addEventListener('click', (event) => {
    const theme = (event.target as Element).closest<HTMLElement>('.chip')?.dataset.theme;
    if (theme !== 'light' && theme !== 'dark' && theme !== 'auto') return;
    state.theme = theme satisfies Theme;
    applyTheme();
    void saveSettings();
  });
}
