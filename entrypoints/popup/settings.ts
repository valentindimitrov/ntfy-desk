// Settings view: server URL, access token, topics, include-URL option and theme. Changes save as you type.

import { browser } from 'wxt/browser';
import { buildAuthHeaderValue, setAccessToken } from '@/utils/ntfy';
import { NOTIFY_RULES, NOTIFY_RULES_KEY, RULE_LABELS, isNotifyRule, ruleFor, storedTopicRules, type TopicRules } from '@/utils/rules';
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
export function serverOriginPattern(apiUrl: string): string | null {
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

/** Sites of the main and fallback servers that send credentials (a token, or user:password in the URL) */
function authenticatedPatterns(apiUrl: string, fallbackUrl: string, accessToken: string): string[] {
  const patterns = [apiUrl, fallbackUrl]
    .filter((url) => url && buildAuthHeaderValue(accessToken, url))
    .map(serverOriginPattern)
    .filter((pattern): pattern is string => pattern !== null);
  return [...new Set(patterns)];
}

/** Show "Allow access to this server" when authentication is set but a server's site isn't granted */
export async function updateServerAccessUI(apiUrl: string, accessToken: string, fallbackUrl = state.fallbackUrl): Promise<void> {
  const patterns = authenticatedPatterns(apiUrl, fallbackUrl, accessToken);
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
  elements.settingsBtn.classList.toggle('highlight', !isConfigured() || missing);
}

function requestServerAccess(): void {
  const apiUrl = elements.urlInput.value.trim();
  const fallbackUrl = elements.fallbackUrlInput.value.trim();
  const patterns = authenticatedPatterns(apiUrl, fallbackUrl, elements.tokenInput.value);
  if (patterns.length === 0) return;

  // Called directly from the click: permissions.request needs a user gesture
  void browser.permissions.request({ origins: patterns }).then((granted) => {
    showSettingsStatus(granted ? 'Server access granted' : 'Server access not granted', granted ? 'success' : 'error');
    void updateServerAccessUI(apiUrl, elements.tokenInput.value, fallbackUrl);
  });
}

async function saveSettings(): Promise<void> {
  const apiUrl = elements.urlInput.value.trim();
  const fallbackUrl = elements.fallbackUrlInput.value.trim();
  const accessToken = elements.tokenInput.value;
  try {
    await saveSync({
      apiUrl,
      fallbackUrl,
      topics: state.topics.join(','),
      theme: state.theme,
      includeUrl: elements.includeUrlCheckbox.checked,
      sendAsZipEnabled: state.sendAsZipEnabled,
    });
    // The token stays in storage.local, so browser sync doesn't copy it to other browsers
    await setAccessToken(accessToken);
    await saveNotifyRules();
    state.apiUrl = apiUrl;
    state.fallbackUrl = fallbackUrl;
    state.accessToken = accessToken;
    state.includeUrl = elements.includeUrlCheckbox.checked;

    // Not a full refresh: that would disturb typing
    updateTopicDropdown();
    renderTopics();
    updateThemeChips();
    void updateServerAccessUI(state.apiUrl, state.accessToken);
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

function renderNotifyRules(): void {
  elements.notifyRulesGroup.style.display = state.topics.length > 0 ? '' : 'none';
  elements.notifyRules.replaceChildren(
    ...state.topics.map((topic) => {
      const row = document.createElement('label');
      row.className = 'notify-rule';

      const name = document.createElement('span');
      name.className = 'notify-rule-topic';
      name.textContent = topic;

      const select = document.createElement('select');
      select.className = 'notify-rule-select';
      select.setAttribute('aria-label', `Desktop notifications for ${topic}`);
      for (const rule of NOTIFY_RULES) {
        const option = document.createElement('option');
        option.value = rule;
        option.textContent = RULE_LABELS[rule];
        select.appendChild(option);
      }
      select.value = ruleFor(state.notifyRules, topic);
      select.addEventListener('change', () => {
        if (!isNotifyRule(select.value)) return;
        state.notifyRules = new Map(state.notifyRules).set(topic, select.value);
        saveNotifyRules().catch(() => showSettingsStatus('Failed to save settings', 'error'));
      });

      row.append(name, select);
      return row;
    }),
  );
}

function renderTopics(): void {
  renderNotifyRules();
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
    state.topics.pop();
    renderTopics();
    void saveSettings();
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
  elements.includeUrlCheckbox.checked = state.includeUrl;
  renderTopics();
  updateThemeChips();
  void updateServerAccessUI(state.apiUrl, state.accessToken);
}

export function setupSettings(): void {
  const debouncedSave = debounce(() => void saveSettings(), 1000);
  elements.urlInput.addEventListener('input', debouncedSave);
  elements.fallbackUrlInput.addEventListener('input', debouncedSave);
  elements.tokenInput.addEventListener('input', debouncedSave);
  elements.includeUrlCheckbox.addEventListener('change', () => void saveSettings());
  elements.serverAccessBtn.addEventListener('click', requestServerAccess);

  elements.newTopicInput.addEventListener('keydown', handleTopicKeydown);
  elements.newTopicInput.addEventListener('input', updateTopicInputHint);
  elements.topicsContainer.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains('topic-remove')) {
      state.topics.splice(Number(target.dataset.index), 1);
      renderTopics();
      void saveSettings();
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
