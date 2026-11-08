// Send form: topic, title (optionally the tab's URL), message, attachments, priority and tags.

import { browser, type Browser } from 'wxt/browser';
import { sendToBackground, type Draft } from '@/utils/messages';
import { getConfig, isHttpUrl, sendAttachment, sendNotification, splitCredentials } from '@/utils/ntfy';
import {
  STORED_FILES_KEY,
  addStoredFiles,
  decodeDataUrl,
  formatFileSize,
  readFileAsDataUrl,
  readStoredFiles,
  removeStoredFiles,
  type StoredFile,
} from '@/utils/stored-files';
import { withFallback } from '@/utils/servers';
import { createZip } from '@/utils/zip';
import { elements, inboxTopic, isConfigured, isPageMode, saveLocal, saveSync, state, type PageInfo } from './state';
import { moveItem, setupDragAndDrop, showSettingsStatus, showStatus } from './ui';

export async function setupSendPanel(): Promise<void> {
  const { sendSection, rememberSendPanelCheckbox: checkbox } = elements;
  const [settings, layout] = await Promise.all([
    browser.storage.sync.get('rememberSendPanel').catch((): Record<string, unknown> => ({})),
    browser.storage.local.get('sendPanelOpen').catch((): Record<string, unknown> => ({})),
  ]);
  let remember = settings.rememberSendPanel === true;
  checkbox.checked = remember;
  sendSection.open = !remember || layout.sendPanelOpen !== false;
  let lastOpen = sendSection.open;

  sendSection.addEventListener('toggle', () => {
    const open = sendSection.open;
    if (open === lastOpen) return;
    lastOpen = open;
    if (remember) void saveLocal({ sendPanelOpen: open }).catch(() => {});
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.rememberSendPanel) {
      remember = changes.rememberSendPanel.newValue === true;
      checkbox.checked = remember;
    }
  });
  checkbox.addEventListener('change', async () => {
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    try {
      if (enabled) await saveLocal({ sendPanelOpen: sendSection.open });
      await saveSync({ rememberSendPanel: enabled });
      remember = enabled;
    } catch {
      showSettingsStatus('Failed to save settings', 'error');
    } finally {
      checkbox.checked = remember;
      checkbox.disabled = false;
    }
  });
}

// ==================
// Topic dropdown
// ==================

export function updateTopicOptions(): void {
  const options = state.topics.map((topic) => {
    const option = document.createElement('option');
    option.value = topic;
    option.textContent = topic;
    return option;
  });
  if (options.length === 0) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'No topics configured';
    options.push(empty);
  }
  elements.topicSelect.replaceChildren(...options);
  updateSendTopic();
}

function independentSendTopic(): string {
  const last = state.lastTopic;
  return last && state.topics.includes(last) ? last : (state.topics[0] ?? '');
}

/** A specific inbox topic overrides the independent send choice without overwriting it. */
export function updateSendTopic(): void {
  const topic = inboxTopic();
  elements.topicSelect.value = topic ?? independentSendTopic();
  elements.topicSelect.disabled = topic !== null || !isConfigured();
  elements.sendTopicHint.hidden = topic === null;
  if (topic === null) elements.topicSelect.removeAttribute('aria-describedby');
  else elements.topicSelect.setAttribute('aria-describedby', elements.sendTopicHint.id);
}

// ==================
// Priority and tags
// ==================

export function updatePriorityUI(): void {
  elements.priorityChips.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
    const selected = Number(chip.dataset.priority) === state.selectedPriority;
    chip.classList.toggle('active', selected);
    chip.setAttribute('aria-pressed', String(selected));
  });
}

function saveTags(): void {
  persistDraft();
  void saveSync({ lastTags: [...state.tags] });
}

export function renderTags(): void {
  elements.tagsContainer.querySelectorAll('.tag-badge').forEach((badge) => badge.remove());

  state.tags.forEach((tag, index) => {
    const badge = document.createElement('div');
    badge.className = 'tag-badge';
    badge.textContent = tag;
    setupDragAndDrop(badge, index, 'tag', (from, to) => {
      moveItem(state.tags, from, to);
      renderTags();
      saveTags();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tag-remove';
    remove.dataset.index = String(index);
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove tag ${tag}`);
    badge.appendChild(remove);
    elements.tagsContainer.insertBefore(badge, elements.newTagInput);
  });
}

function handleTagKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    const value = elements.newTagInput.value.trim();
    if (value) {
      if (!state.tags.includes(value)) {
        state.tags.push(value);
        renderTags();
        saveTags();
      }
      elements.newTagInput.value = '';
      updateTagInputHint();
    }
  } else if (event.key === 'Backspace' && !elements.newTagInput.value && state.tags.length > 0) {
    // Empty input: Backspace removes the last tag
    state.tags.pop();
    renderTags();
    saveTags();
  }
}

function updateTagInputHint(): void {
  elements.tagInputHint.classList.toggle('visible', elements.newTagInput.value.length > 0);
}

// ==================
// Tab title and URL
// ==================

const NO_PAGE: PageInfo = { url: '', title: '' };

const pageOf = (tab: Browser.tabs.Tab | undefined): PageInfo => ({ url: tab?.url ?? '', title: tab?.title?.trim() ?? '' });

/** Reading another tab needs the optional "tabs" permission (asked for by the "Use tab" button) */
async function getLastBrowsingTab(): Promise<PageInfo> {
  try {
    if (!(await browser.permissions.contains({ permissions: ['tabs'] }))) {
      return NO_PAGE;
    }
    const own = await browser.tabs.getCurrent();
    const tabs = await browser.tabs.query({ windowType: 'normal' });
    const pages = tabs.filter((tab) => tab.id !== own?.id && isHttpUrl(tab.url));
    // Tab.lastAccessed isn't reported by every browser version: without it, the active web page tab
    // of the browser window used last
    if (pages.some((tab) => tab.lastAccessed === undefined)) {
      const window = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
      const active = pages.find((tab) => tab.windowId === window.id && tab.active) ?? pages.find((tab) => tab.active);
      return pageOf(active ?? pages[0]);
    }
    pages.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return pageOf(pages[0]);
  } catch {
    return NO_PAGE;
  }
}

export async function getPage(): Promise<PageInfo> {
  if (isPageMode) {
    // The active tab is this page itself: use the web page tab the user was on last
    return getLastBrowsingTab();
  }
  // The title and URL of the active tab: the activeTab permission allows them while the popup is open
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return pageOf(tab);
}

const withoutTrailingSlash = (url: string) => url.replace(/\/$/, '');

/** Put a field's automatic value in, unless the user typed something else there */
function fill(input: HTMLInputElement | HTMLTextAreaElement, previous: string, value: string): string {
  const current = input.value.trim();
  if (!current || current === previous) {
    input.value = value;
    return value;
  }
  return previous;
}

/**
 * "Fill in the current tab": the tab's title goes in the Title field and its URL in the Message field,
 * both still editable. What the user typed in either field is left alone.
 */
export function applyPagePrefill(force = false): void {
  const isWebPage = (state.includeUrl || force) && isHttpUrl(state.page.url);
  const title = isWebPage ? state.page.title : '';
  const url = isWebPage ? withoutTrailingSlash(state.page.url) : '';
  state.autoTitle = fill(elements.titleInput, state.autoTitle, title);
  state.autoMessage = fill(elements.messageInput, state.autoMessage, url);
}

function useTab(): void {
  // Called directly from the click: permissions.request needs a user gesture
  void browser.permissions.request({ permissions: ['tabs'] }).then(async (granted) => {
    if (!granted) {
      showStatus('Allow reading tabs to use the tab', 'warning');
      return;
    }
    const page = await getLastBrowsingTab();
    if (!page.url) {
      showStatus('No web page tab found', 'warning');
      return;
    }
    state.page = page;
    applyPagePrefill(true);
  });
}

// ==================
// Draft
// ==================

let draftRevision = '';

async function saveDraft(): Promise<string> {
  const revision = crypto.randomUUID();
  draftRevision = revision;
  const draft: Draft = {
    revision,
    // An automatically filled tab title or URL isn't part of the draft: the next popup fills in its own tab's
    title: elements.titleInput.value === state.autoTitle ? '' : elements.titleInput.value,
    message: elements.messageInput.value === state.autoMessage ? '' : elements.messageInput.value,
    topic: independentSendTopic(),
    tags: [...state.tags],
    priority: state.selectedPriority,
  };
  await sendToBackground({ action: 'saveDraft', draft });
  return revision;
}

/** Hand the edit to storage before the popup can close. */
function persistDraft(): void {
  void saveDraft().catch(() => showStatus('Failed to save draft', 'error'));
}

/** Restore the draft; it is kept until a message is sent */
export async function restoreDraft(): Promise<void> {
  const { draftState } = await browser.storage.local.get(['draftState']);
  const draft = draftState as Partial<Draft> | undefined;
  if (!draft) return;

  if (typeof draft.title === 'string') elements.titleInput.value = draft.title;
  if (typeof draft.message === 'string') elements.messageInput.value = draft.message;
  if (Array.isArray(draft.tags)) state.tags = draft.tags;
  if (typeof draft.priority === 'number') state.selectedPriority = draft.priority;
  if (draft.topic) state.lastTopic = draft.topic;
}

// ==================
// Attachments
// ==================

export async function loadAttachments(): Promise<void> {
  try {
    state.attachments = await readStoredFiles();
  } catch (error) {
    console.error('Error loading stored files:', error);
    state.attachments = [];
  }
  renderAttachments();
}

function renderAttachments(): void {
  const { attachments, isSending } = state;
  elements.filePreview.replaceChildren();
  elements.filePreview.classList.toggle('visible', attachments.length > 0);
  elements.fileBtnLabel.textContent = attachments.length > 0 ? `Attach files (${attachments.length})` : 'Attach files';

  attachments.forEach((file) => {
    const preview = document.createElement('div');
    preview.className = 'file-preview-item';

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = '📄';

    const info = document.createElement('div');
    info.className = 'file-info';
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = file.name;
    const size = document.createElement('div');
    size.className = 'file-size';
    size.textContent = formatFileSize(file.size);
    info.append(name, size);

    const remove = document.createElement('button');
    remove.className = 'file-remove';
    remove.dataset.id = file.id;
    remove.title = `Remove ${file.name}`;
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.textContent = '×';
    remove.disabled = isSending;

    preview.append(icon, info, remove);
    elements.filePreview.appendChild(preview);
  });

  elements.fileBtn.disabled = isSending;
  elements.fileInput.disabled = isSending;
  updateZipToggle();
}

function updateZipToggle(): void {
  const canSendAsZip = state.attachments.length > 1;
  elements.zipToggle.classList.toggle('visible', canSendAsZip);
  elements.zipToggle.classList.toggle('disabled', state.isSending);
  elements.zipCheckbox.disabled = state.isSending || !canSendAsZip;
  elements.zipCheckbox.checked = canSendAsZip && state.sendAsZipEnabled;
}

function handleZipToggleChange(): void {
  if (state.attachments.length < 2) {
    elements.zipCheckbox.checked = false;
    return;
  }
  state.sendAsZipEnabled = elements.zipCheckbox.checked;
  saveSync({ sendAsZipEnabled: state.sendAsZipEnabled }).catch((error) => console.error('Error saving ZIP preference:', error));
}

/** The file dialog would close the popup, so files are picked in a small window of their own */
async function openFilePicker(): Promise<void> {
  if (state.isSending) return;
  await saveDraft();

  const url = browser.runtime.getURL(`/filepicker.html?theme=${state.theme}`);
  const width = 450;
  const height = 340;
  try {
    const current = await browser.windows.getCurrent();
    const centred =
      current.left !== undefined && current.top !== undefined && current.width !== undefined && current.height !== undefined
        ? { left: Math.round(current.left + (current.width - width) / 2), top: Math.round(current.top + (current.height - height) / 2) }
        : {};
    await browser.windows.create({ url, type: 'popup', width, height, focused: true, ...centred });
  } catch (error) {
    console.log('Windows API error, opening a tab instead:', error);
    await browser.tabs.create({ url, active: true });
  }
}

async function handleFileSelect(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length === 0 || state.isSending) return;

  try {
    // Read the whole selection before writing, so a read error doesn't append part of it
    const records = await Promise.all(files.map(readFileAsDataUrl));
    await addStoredFiles(records);
    await loadAttachments();
  } catch (error) {
    console.error('Error storing files:', error);
    showStatus(`Failed to attach files: ${(error as Error).message}`, 'error');
  }
}

async function handleAttachmentRemove(event: Event): Promise<void> {
  const button = (event.target as Element).closest<HTMLElement>('.file-remove');
  if (!button || state.isSending) return;

  const id = button.dataset.id;
  if (!id) return;

  try {
    await removeStoredFiles([id]);
    await loadAttachments();
  } catch (error) {
    console.error('Error removing file:', error);
    showStatus(`Failed to remove file: ${(error as Error).message}`, 'error');
  }
}

// ==================
// Send
// ==================

function getZipFilename(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `ntfy-files-${datePart}-${timePart}.zip`;
}

async function finishSuccessfulSend(revision: string, attachmentCount: number, successMessage?: string): Promise<void> {
  if (attachmentCount > 0) {
    elements.fileInput.value = '';
    await loadAttachments();
  }
  await sendToBackground({ action: 'clearDraft', revision });
  const edited = revision !== draftRevision;
  if (!edited) {
    elements.messageInput.value = '';
    elements.titleInput.value = '';
    state.autoTitle = '';
    state.autoMessage = '';
    applyPagePrefill();
  }

  // Close the popup unless "Send another" is checked (the extension's tab stays open)
  if (!edited && !elements.sendAnotherCheckbox.checked && !isPageMode) {
    setTimeout(() => {
      if (draftRevision === revision) window.close();
    }, 100);
  } else {
    showStatus(successMessage ?? (attachmentCount > 1 ? `${attachmentCount} notifications sent!` : 'Notification sent!'), 'success');
  }
}

export async function send(): Promise<void> {
  // Taken before the first await, so a second click can't start a second send
  if (state.isSending) return;
  state.isSending = true;
  elements.sendBtn.disabled = true;
  try {
    await sendNow();
  } catch {
    showStatus('Could not prepare or finish the send. Check the inbox before retrying.', 'error');
  } finally {
    state.isSending = false;
    elements.sendBtn.disabled = false;
    renderAttachments();
  }
}

async function sendNow(): Promise<void> {
  const { apiUrl, fallbackUrl } = state;
  const topic = inboxTopic() ?? independentSendTopic();
  // With "Fill in the current tab", the tab's title and URL are in these fields (applyPagePrefill)
  const message = elements.messageInput.value.trim();
  const title = elements.titleInput.value.trim();
  const tags = state.tags.join(',');
  const priority = state.selectedPriority;

  // Capture the latest values first, so a failed send can be retried
  const revision = await saveDraft();

  let files: StoredFile[];
  try {
    files = await readStoredFiles();
    state.attachments = files;
    renderAttachments();
  } catch (error) {
    showStatus(`Failed to load attachments: ${(error as Error).message}`, 'error');
    return;
  }

  if (!apiUrl) {
    showStatus('Configure ntfy URL in settings', 'warning');
    return;
  }
  if (!topic) {
    showStatus('Select a topic', 'warning');
    return;
  }

  renderAttachments();

  // The fallback server is tried when the main one gives no response
  // getConfig: the token and password only for servers approved on this device
  const servers = await getConfig();
  if (servers.apiUrl !== apiUrl || servers.fallbackUrl !== fallbackUrl || !servers.topics.includes(topic)) {
    showStatus('The server or topic changed. Reopen ntfy Desk before sending.', 'warning');
    return;
  }
  try {
    if (files.length === 0) {
      await withFallback(servers, (server) => sendNotification(server, topic, { message, title, priority, tags }));
      await finishSuccessfulSend(revision, 0);
      return;
    }

    if (files.length > 1 && elements.zipCheckbox.checked) {
      const zip = await createZip(files.map((file) => ({ name: file.name, data: decodeDataUrl(file.data) })));
      const filename = getZipFilename();
      await withFallback(servers, (server) =>
        sendAttachment(server, topic, { data: zip, filename, contentType: 'application/zip', message, title, priority, tags }),
      );
      await removeStoredFiles(files.map((file) => file.id));
      await finishSuccessfulSend(revision, files.length, 'ZIP sent!');
      return;
    }

    // One message per attachment, one at a time
    const failures: { file: StoredFile; error: Error }[] = [];
    for (const file of files) {
      try {
        const data = decodeDataUrl(file.data) as BodyInit;
        await withFallback(servers, (server) =>
          sendAttachment(server, topic, { data, filename: file.name, message, title, priority, tags }),
        );
      } catch (error) {
        failures.push({ file, error: error as Error });
        continue;
      }
      await removeStoredFiles([file.id]);
    }

    if (failures.length > 0) {
      // Failed files stay attached and the form stays as it is, for a retry
      const details = failures.map(({ file, error }) => `${file.name}: ${error.message}`).join('; ');
      showStatus(
        `${files.length - failures.length} of ${files.length} attachment${files.length === 1 ? '' : 's'} sent. Failed: ${details}`,
        'error',
      );
      return;
    }
    await finishSuccessfulSend(revision, files.length);
  } catch (error) {
    showStatus(`Error: ${(error as Error).message}`, 'error');
  }
}

/** Open the server's web app on the selected topic; never with credentials in the address */
function openNtfyUrl(): void {
  const apiUrl = splitCredentials(state.apiUrl).url;
  if (!apiUrl) return;
  const topic = elements.topicSelect.value;
  const base = withoutTrailingSlash(apiUrl);
  void browser.tabs.create({ url: topic && state.topics.includes(topic) ? `${base}/${topic}` : apiUrl });
}

export function setupSend(): void {
  elements.titleInput.addEventListener('input', persistDraft);
  elements.messageInput.addEventListener('input', persistDraft);

  elements.sendBtn.addEventListener('click', () => void send());
  elements.openUrlBtn.addEventListener('click', openNtfyUrl);
  elements.tabUrlBtn.addEventListener('click', useTab);

  elements.sendAnotherCheckbox.addEventListener('change', () => {
    state.sendAnotherEnabled = elements.sendAnotherCheckbox.checked;
    void saveSync({ sendAnotherEnabled: state.sendAnotherEnabled });
  });

  elements.zipCheckbox.addEventListener('change', handleZipToggleChange);
  elements.fileBtn.addEventListener('click', () => void openFilePicker());
  elements.fileInput.addEventListener('change', (event) => void handleFileSelect(event));
  elements.filePreview.addEventListener('click', (event) => void handleAttachmentRemove(event));

  elements.priorityChips.addEventListener('click', (event) => {
    const chip = (event.target as Element).closest<HTMLElement>('.chip');
    if (!chip?.dataset.priority) return;
    state.selectedPriority = Number(chip.dataset.priority);
    updatePriorityUI();
    persistDraft();
    void saveSync({ priority: state.selectedPriority });
  });

  elements.newTagInput.addEventListener('keydown', handleTagKeydown);
  elements.newTagInput.addEventListener('input', updateTagInputHint);
  elements.tagsContainer.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains('tag-remove')) {
      state.tags.splice(Number(target.dataset.index), 1);
      renderTags();
      elements.newTagInput.focus();
      saveTags();
    }
    // A click on the container focuses the input
    if (target === elements.tagsContainer) {
      elements.newTagInput.focus();
    }
  });

  elements.topicSelect.addEventListener('change', () => {
    if (elements.topicSelect.disabled) return;
    state.lastTopic = elements.topicSelect.value;
    void saveSync({ lastTopic: state.lastTopic });
    persistDraft();
  });

  // The file picker window writes the attachments to storage
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORED_FILES_KEY]) {
      void loadAttachments();
    }
  });
}
