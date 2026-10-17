// Send tab: topic, title (optionally the tab's URL), message, attachments, priority and tags.

import { browser } from 'wxt/browser';
import { isHttpUrl, sendAttachment, sendNotification } from '@/utils/ntfy';
import {
  STORED_FILES_KEY,
  decodeDataUrl,
  formatFileSize,
  persistStoredFiles,
  readFileAsDataUrl,
  readStoredFiles,
  type StoredFile,
} from '@/utils/stored-files';
import { withFallback } from '@/utils/servers';
import { createZip } from '@/utils/zip';
import { elements, isPageMode, saveSync, state } from './state';
import { moveItem, setupDragAndDrop, showStatus } from './ui';

// ==================
// Topic dropdown
// ==================

export function updateTopicDropdown(): void {
  elements.topicSelect.replaceChildren();
  elements.topicDropdownOptions.replaceChildren();

  for (const topic of state.topics) {
    // Hidden select holds the form value
    const option = document.createElement('option');
    option.value = topic;
    option.textContent = topic;
    elements.topicSelect.appendChild(option);

    const customOption = document.createElement('div');
    customOption.className = 'custom-dropdown-option';
    customOption.dataset.value = topic;
    customOption.textContent = topic;
    customOption.addEventListener('click', () => selectTopic(topic));
    elements.topicDropdownOptions.appendChild(customOption);
  }

  if (state.topics.length > 0) {
    const selected = elements.topicSelect.value || state.topics[0]!;
    elements.topicDropdownText.textContent = selected;
    updateDropdownSelection(selected);
  } else {
    elements.topicDropdownText.textContent = 'No topics configured';
  }
}

/** Topic dropdown when nothing is configured */
export function clearTopicDropdown(): void {
  const option = document.createElement('option');
  option.disabled = true;
  option.textContent = 'No topics configured';
  elements.topicSelect.replaceChildren(option);
  elements.topicDropdownText.textContent = 'No topics configured';
  elements.topicDropdownOptions.replaceChildren();
}

export function showTopic(topic: string): void {
  elements.topicSelect.value = topic;
  elements.topicDropdownText.textContent = topic;
  updateDropdownSelection(topic);
}

function selectTopic(topic: string): void {
  showTopic(topic);
  closeTopicDropdown();
  state.lastTopic = topic;
  void saveSync({ lastTopic: topic });
}

function updateDropdownSelection(selected: string): void {
  elements.topicDropdownOptions.querySelectorAll<HTMLElement>('.custom-dropdown-option').forEach(option => {
    option.classList.toggle('selected', option.dataset.value === selected);
  });
}

function closeTopicDropdown(): void {
  elements.topicDropdown.classList.remove('open');
}

// ==================
// Priority and tags
// ==================

export function updatePriorityUI(): void {
  elements.priorityChips.querySelectorAll<HTMLElement>('.chip').forEach(chip => {
    chip.classList.toggle('active', Number(chip.dataset.priority) === state.selectedPriority);
  });
}

function saveTags(): void {
  void saveSync({ lastTags: [...state.tags] });
}

export function renderTags(): void {
  elements.tagsContainer.querySelectorAll('.tag-badge').forEach(badge => badge.remove());

  state.tags.forEach((tag, index) => {
    const badge = document.createElement('div');
    badge.className = 'tag-badge';
    badge.textContent = tag;
    setupDragAndDrop(badge, index, 'tag', (from, to) => {
      moveItem(state.tags, from, to);
      renderTags();
      saveTags();
    });

    const remove = document.createElement('span');
    remove.className = 'tag-remove';
    remove.dataset.index = String(index);
    remove.textContent = '×';
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
// Tab URL as title
// ==================

/** Reading another tab's URL needs the optional "tabs" permission (asked for by the "Use tab URL" button) */
async function getLastBrowsingTabUrl(): Promise<string> {
  try {
    if (!(await browser.permissions.contains({ permissions: ['tabs'] }))) {
      return '';
    }
    const own = await browser.tabs.getCurrent();
    const tabs = await browser.tabs.query({ windowType: 'normal' });
    const pages = tabs.filter(tab => tab.id !== own?.id && isHttpUrl(tab.url));
    pages.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return pages[0]?.url ?? '';
  } catch {
    return '';
  }
}

export async function getPageUrl(): Promise<string> {
  if (isPageMode) {
    // The active tab is this page itself: use the web page tab the user was on last
    return getLastBrowsingTabUrl();
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? '';
}

const withoutTrailingSlash = (url: string) => url.replace(/\/$/, '');

/**
 * "Include current tab's URL" puts the URL in the Title field, where it can still be edited.
 * A title the user typed is left alone.
 */
export function applyUrlTitle(): void {
  const current = elements.titleInput.value.trim();
  if (current && current !== state.autoTitle) {
    return;
  }
  const url = state.includeUrl && isHttpUrl(state.pageUrl) ? withoutTrailingSlash(state.pageUrl) : '';
  elements.titleInput.value = url;
  state.autoTitle = url;
}

function useTabUrl(): void {
  // Called directly from the click: permissions.request needs a user gesture
  void browser.permissions.request({ permissions: ['tabs'] }).then(async granted => {
    if (!granted) {
      showStatus('Allow reading tabs to use the tab URL', 'warning');
      return;
    }
    const url = await getLastBrowsingTabUrl();
    if (!url) {
      showStatus('No web page tab found', 'warning');
      return;
    }
    state.pageUrl = url;
    elements.titleInput.value = withoutTrailingSlash(url);
    state.autoTitle = elements.titleInput.value;
  });
}

// ==================
// Draft
// ==================

interface Draft {
  title: string;
  message: string;
  topic: string;
  tags: string[];
  priority: number;
}

let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

async function saveDraft(): Promise<void> {
  const draft: Draft = {
    // An automatically filled tab URL isn't part of the draft: the next popup fills in its own tab's
    title: elements.titleInput.value === state.autoTitle ? '' : elements.titleInput.value,
    message: elements.messageInput.value,
    topic: elements.topicSelect.value,
    tags: state.tags,
    priority: state.selectedPriority,
  };
  await browser.storage.local.set({ draftState: draft });
}

/** Keep the composer text if the popup closes before sending */
function scheduleDraftSave(): void {
  cancelScheduledDraftSave();
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    saveDraft().catch(error => console.error('Error saving draft:', error));
  }, 250);
}

function cancelScheduledDraftSave(): void {
  if (draftSaveTimer !== null) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
}

async function flushDraftSave(): Promise<void> {
  cancelScheduledDraftSave();
  await saveDraft();
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

/** A new browser session starts without the previous session's attachments and draft */
export async function cleanUpAfterBrowserRestart(): Promise<void> {
  try {
    const { sessionActive } = await browser.storage.session.get(['sessionActive']);
    if (!sessionActive) {
      await browser.storage.local.remove([STORED_FILES_KEY, 'draftState']);
      await browser.storage.session.set({ sessionActive: true });
    }
  } catch (error) {
    console.error('Error checking session state:', error);
  }
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
  elements.mainContent.classList.toggle('has-multiple-attachments', attachments.length > 1);
  elements.fileBtn.textContent = attachments.length > 0 ? `📎 Attach files (${attachments.length})` : '📎 Attach files';

  attachments.forEach((file, index) => {
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
    remove.dataset.index = String(index);
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
  saveSync({ sendAsZipEnabled: state.sendAsZipEnabled }).catch(error => console.error('Error saving ZIP preference:', error));
}

async function setAttachments(files: StoredFile[]): Promise<void> {
  await persistStoredFiles(files);
  state.attachments = files;
  renderAttachments();
}

/** The file dialog would close the popup, so files are picked in a small window of their own */
async function openFilePicker(): Promise<void> {
  if (state.isSending) return;
  await flushDraftSave();

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
    await setAttachments([...(await readStoredFiles()), ...records]);
  } catch (error) {
    console.error('Error storing files:', error);
    showStatus(`Failed to attach files: ${(error as Error).message}`, 'error');
  }
}

async function handleAttachmentRemove(event: Event): Promise<void> {
  const button = (event.target as Element).closest<HTMLElement>('.file-remove');
  if (!button || state.isSending) return;

  const index = Number(button.dataset.index);
  if (!Number.isInteger(index) || index < 0 || index >= state.attachments.length) return;

  try {
    await setAttachments(state.attachments.filter((_, i) => i !== index));
  } catch (error) {
    console.error('Error removing file:', error);
    showStatus(`Failed to remove file: ${(error as Error).message}`, 'error');
  }
}

// ==================
// Send
// ==================

export function getZipFilename(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `ntfy-files-${datePart}-${timePart}.zip`;
}

async function finishSuccessfulSend(attachmentCount: number, successMessage?: string): Promise<void> {
  cancelScheduledDraftSave();
  elements.messageInput.value = '';
  elements.titleInput.value = '';
  state.autoTitle = '';
  applyUrlTitle();

  if (attachmentCount > 0) {
    elements.fileInput.value = '';
    await setAttachments([]);
  }
  await browser.storage.local.remove(['draftState']);
  updatePriorityUI();

  // Close the popup unless "Send another" is checked (the extension's tab stays open)
  if (!elements.sendAnotherCheckbox.checked && !isPageMode) {
    setTimeout(() => window.close(), 100);
  } else {
    showStatus(successMessage ?? (attachmentCount > 1 ? `${attachmentCount} notifications sent!` : 'Notification sent!'), 'success');
  }
}

export async function send(): Promise<void> {
  if (state.isSending) return;

  const topic = elements.topicSelect.value;
  // With "Include current tab's URL", the URL is in the title (applyUrlTitle)
  const message = elements.messageInput.value.trim();
  const title = elements.titleInput.value.trim();
  const tags = state.tags.join(',');
  const priority = state.selectedPriority;

  // Capture the latest values first, so a failed send can be retried
  await flushDraftSave();

  let files: StoredFile[];
  try {
    files = await readStoredFiles();
    state.attachments = files;
    renderAttachments();
  } catch (error) {
    showStatus(`Failed to load attachments: ${(error as Error).message}`, 'error');
    return;
  }

  if (!state.apiUrl) {
    showStatus('Configure ntfy URL in settings', 'warning');
    return;
  }
  if (!topic) {
    showStatus('Select a topic', 'warning');
    return;
  }

  state.isSending = true;
  elements.sendBtn.disabled = true;
  renderAttachments();

  // The fallback server is tried when the main one gives no response
  const servers = { apiUrl: state.apiUrl, fallbackUrl: state.fallbackUrl, accessToken: state.accessToken };
  try {
    if (files.length === 0) {
      await withFallback(servers, server => sendNotification(server, topic, { message, title, priority, tags }));
      await finishSuccessfulSend(0);
      return;
    }

    if (files.length > 1 && elements.zipCheckbox.checked) {
      const zip = await createZip(files.map(file => ({ name: file.name, data: decodeDataUrl(file.data) })));
      const filename = getZipFilename();
      await withFallback(servers, server => sendAttachment(server, topic, { data: zip, filename, contentType: 'application/zip', message, title, priority, tags }));
      await finishSuccessfulSend(files.length, 'ZIP sent!');
      return;
    }

    // One message per attachment, one at a time
    const failures: { file: StoredFile; error: Error }[] = [];
    let remaining = [...files];
    for (const file of files) {
      try {
        const data = decodeDataUrl(file.data) as BodyInit;
        await withFallback(servers, server => sendAttachment(server, topic, { data, filename: file.name, message, title, priority, tags }));
      } catch (error) {
        failures.push({ file, error: error as Error });
        continue;
      }
      remaining = remaining.filter(other => other !== file);
      await setAttachments(remaining);
    }

    if (failures.length > 0) {
      // Failed files stay attached and the form stays as it is, for a retry
      const details = failures.map(({ file, error }) => `${file.name}: ${error.message}`).join('; ');
      showStatus(`${files.length - failures.length} of ${files.length} attachment${files.length === 1 ? '' : 's'} sent. Failed: ${details}`, 'error');
      return;
    }
    await finishSuccessfulSend(files.length);
  } catch (error) {
    showStatus(`Error: ${(error as Error).message}`, 'error');
  } finally {
    state.isSending = false;
    elements.sendBtn.disabled = false;
    renderAttachments();
  }
}

/** Open the server's web app on the selected topic */
function openNtfyUrl(): void {
  if (!state.apiUrl) return;
  const topic = elements.topicSelect.value;
  const base = withoutTrailingSlash(state.apiUrl);
  void browser.tabs.create({ url: topic && state.topics.includes(topic) ? `${base}/${topic}` : state.apiUrl });
}

export function setupSend(): void {
  elements.titleInput.addEventListener('input', scheduleDraftSave);
  elements.messageInput.addEventListener('input', scheduleDraftSave);

  elements.sendBtn.addEventListener('click', () => void send());
  elements.openUrlBtn.addEventListener('click', openNtfyUrl);
  elements.tabUrlBtn.addEventListener('click', useTabUrl);

  elements.sendAnotherCheckbox.addEventListener('change', () => {
    state.sendAnotherEnabled = elements.sendAnotherCheckbox.checked;
    void saveSync({ sendAnotherEnabled: state.sendAnotherEnabled });
  });

  elements.zipCheckbox.addEventListener('change', handleZipToggleChange);
  elements.fileBtn.addEventListener('click', () => void openFilePicker());
  elements.fileInput.addEventListener('change', event => void handleFileSelect(event));
  elements.filePreview.addEventListener('click', event => void handleAttachmentRemove(event));

  elements.priorityChips.addEventListener('click', event => {
    const chip = (event.target as Element).closest<HTMLElement>('.chip');
    if (!chip?.dataset.priority) return;
    state.selectedPriority = Number(chip.dataset.priority);
    updatePriorityUI();
    void saveSync({ priority: state.selectedPriority });
  });

  elements.newTagInput.addEventListener('keydown', handleTagKeydown);
  elements.newTagInput.addEventListener('input', updateTagInputHint);
  elements.tagsContainer.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (target.classList.contains('tag-remove')) {
      state.tags.splice(Number(target.dataset.index), 1);
      renderTags();
      saveTags();
    }
    // A click on the container focuses the input
    if (target === elements.tagsContainer) {
      elements.newTagInput.focus();
    }
  });

  elements.advancedToggle.addEventListener('click', () => {
    const isOpen = elements.advancedOptions.classList.toggle('visible');
    elements.advancedToggle.classList.toggle('open', isOpen);
    elements.mainContent.classList.toggle('advanced-open', isOpen);
  });

  elements.topicDropdownSelected.addEventListener('click', () => elements.topicDropdown.classList.toggle('open'));
  document.addEventListener('click', event => {
    if (!elements.topicDropdown.contains(event.target as Node)) {
      closeTopicDropdown();
    }
  });

  // The file picker window writes the attachments to storage
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORED_FILES_KEY]) {
      void loadAttachments();
    }
  });
}
