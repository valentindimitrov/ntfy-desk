// Send form: topic, title (optionally the tab's URL), message, attachments, priority and tags (with
// per-topic defaults), and the options under "More options" (click URL, Markdown, delayed delivery).

import { browser, type Browser } from 'wxt/browser';
import { sendToBackground, type Draft } from '@/utils/messages';
import {
  clickUrlError,
  delayError,
  getConfig,
  isHttpUrl,
  publishedTime,
  PublishUncertainError,
  sendAttachment,
  sendNotification,
  splitCredentials,
  type PublishOptions,
} from '@/utils/ntfy';
import {
  SEND_DEFAULTS_KEY,
  isPriority,
  parseRememberedPriority,
  parseRememberedTags,
  parseSendDefaults,
  sameSendDefaults,
  type SendDefaults,
} from '@/utils/send-defaults';
import {
  STORED_FILES_REVISION_KEY,
  addPickedFiles,
  dispatchStoredUpload,
  formatFileSize,
  listStoredFiles,
  readStoredFiles,
  removeStoredFiles,
  type StoredFile,
} from '@/utils/stored-files';
import { pickServer } from '@/utils/servers';
import { createZip } from '@/utils/zip';
import { elements, inboxTopic, isConfigured, isPageMode, saveLocal, saveSync, state, type PageInfo } from './state';
import { clearStatus, moveItem, setupDragAndDrop, showSettingsStatus, showStatus } from './ui';

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
  applySendDefaults();
}

/** Where a message goes: the inbox's topic when one is selected there, else the Send form's own choice */
const sendTopic = (): string => inboxTopic() ?? independentSendTopic();

// ==================
// Priority and tags
// ==================
//
// Until the user sets the priority or tags by hand, they follow the send topic: its send defaults if
// it has any (Settings > Topics), else the priority and tags used last. Once set by hand they belong
// to the message in progress: they stay when the topic changes and are saved in the draft, until the
// message is sent or the user takes the automatic values back ("Use topic defaults" / "Use last used").
// A change by hand is also remembered as "used last" (storage.sync), except on a topic with send
// defaults: there it applies to this message only, so a topic's defaults never become the values of
// the other topics.

/** The priority and tags a new message to the send topic starts with */
function automaticPriorityTags(): SendDefaults {
  return state.topicSendDefaults.get(sendTopic()) ?? { priority: state.rememberedPriority, tags: state.rememberedTags };
}

/** Offer the automatic values back when the ones set by hand differ from them */
function updateDefaultsReset(): void {
  const current = { priority: state.selectedPriority, tags: state.tags };
  elements.sendDefaultsReset.hidden = !state.customPriorityTags || sameSendDefaults(automaticPriorityTags(), current);
  elements.sendDefaultsReset.textContent = state.topicSendDefaults.has(sendTopic()) ? 'Use topic defaults' : 'Use last used';
}

/** Show the send topic's priority and tags, unless the user set them by hand for this message */
export function applySendDefaults(): void {
  if (!state.customPriorityTags) {
    const { priority, tags } = automaticPriorityTags();
    state.selectedPriority = priority;
    state.tags = [...tags];
  }
  updatePriorityUI();
  renderTags();
  updateDefaultsReset();
}

/** The user changed the priority or the tags */
function setByHand(changed: 'priority' | 'tags'): void {
  state.customPriorityTags = true;
  persistDraft();
  if (!state.topicSendDefaults.has(sendTopic())) {
    if (changed === 'priority') {
      state.rememberedPriority = state.selectedPriority;
      void saveSync({ priority: state.selectedPriority });
    } else {
      state.rememberedTags = [...state.tags];
      void saveSync({ lastTags: [...state.tags] });
    }
  }
  updateDefaultsReset();
}

function resetPriorityTags(): void {
  state.customPriorityTags = false;
  applySendDefaults();
  persistDraft();
}

export function updatePriorityUI(): void {
  elements.priorityChips.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
    const selected = Number(chip.dataset.priority) === state.selectedPriority;
    chip.classList.toggle('active', selected);
    chip.setAttribute('aria-pressed', String(selected));
  });
}

function saveTags(): void {
  setByHand('tags');
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
    customPriorityTags: state.customPriorityTags,
    click: elements.clickInput.value,
    markdown: elements.markdownCheckbox.checked,
    delay: delayValue(),
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
  if (draft.topic) state.lastTopic = draft.topic;
  // Priority and tags set by hand come back as they were; otherwise the topic decides (applySendDefaults)
  if (draft.customPriorityTags === true) {
    state.customPriorityTags = true;
    if (isPriority(draft.priority)) state.selectedPriority = draft.priority;
    if (Array.isArray(draft.tags)) state.tags = draft.tags.filter((tag): tag is string => typeof tag === 'string');
  }
  if (typeof draft.click === 'string') elements.clickInput.value = draft.click;
  elements.markdownCheckbox.checked = draft.markdown === true;
  if (typeof draft.delay === 'string') showDelay(draft.delay);
  updateMoreOptions();
}

// ==================
// More options: click URL, Markdown, delayed delivery
// ==================

/** The Deliver choice that shows the free text field */
const CUSTOM_DELAY = '__custom';

/** The delay to send: a listed duration, the typed value, or '' for now */
function delayValue(): string {
  const choice = elements.delaySelect.value;
  return choice === CUSTOM_DELAY ? elements.delayInput.value.trim() : choice;
}

function showDelay(delay: string): void {
  const listed = delay !== CUSTOM_DELAY && [...elements.delaySelect.options].some((option) => option.value === delay);
  elements.delaySelect.value = listed ? delay : CUSTOM_DELAY;
  elements.delayInput.value = listed ? '' : delay;
}

function showFieldError(input: HTMLElement, target: HTMLElement, problem: string): void {
  target.textContent = problem;
  target.hidden = !problem;
  if (problem) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/** The delay field and hint for the current choice, and the options in use on the summary line */
function updateMoreOptions(): void {
  const custom = elements.delaySelect.value === CUSTOM_DELAY;
  const delayed = custom || elements.delaySelect.value !== '';
  elements.delayInput.hidden = !custom;
  elements.delayHint.hidden = !delayed;
  elements.delayHint.textContent = delayed
    ? `The server sets the limits: 10 seconds to 3 days by default.${
        state.attachments.length > 0 ? ' It refuses a delay longer than it keeps attachments (3 hours by default).' : ''
      }${custom ? ' A duration, or a time such as "tomorrow 9am" in your time zone.' : ''}`
    : '';
  const active = [elements.clickInput.value.trim() && 'URL', elements.markdownCheckbox.checked && 'Markdown', delayed && 'delay'].filter(
    Boolean,
  );
  elements.moreOptionsActive.textContent = active.length > 0 ? `(${active.join(', ')})` : '';
}

function clearMoreOptions(): void {
  elements.clickInput.value = '';
  elements.markdownCheckbox.checked = false;
  showDelay('');
  showFieldError(elements.clickInput, elements.clickError, '');
  showFieldError(elements.delayInput, elements.delayError, '');
  updateMoreOptions();
}

/**
 * The options to publish with; null, with the problem shown at its field, if one can't be sent.
 * Only what the browser can judge is checked here: the server's error text is shown for the rest.
 */
function readMoreOptions(): Pick<PublishOptions, 'click' | 'markdown' | 'delay'> | null {
  const click = elements.clickInput.value.trim();
  const delay = delayValue();
  const clickProblem = click ? clickUrlError(click) : '';
  const delayProblem =
    elements.delaySelect.value === CUSTOM_DELAY && !delay ? 'Enter a delay such as 45m, or choose Now' : delayError(delay);
  showFieldError(elements.clickInput, elements.clickError, clickProblem);
  showFieldError(elements.delayInput, elements.delayError, delayProblem);
  const problem = clickProblem || delayProblem;
  if (problem) {
    elements.moreOptions.open = true;
    (clickProblem ? elements.clickInput : elements.delayInput).focus();
    showStatus(problem, 'error');
    return null;
  }
  return { click, markdown: elements.markdownCheckbox.checked, delay };
}

/** Whether "More options" is open is kept on this device */
export async function setupMoreOptions(): Promise<void> {
  const { moreOptions } = elements;
  const { sendOptionsOpen } = await browser.storage.local.get('sendOptionsOpen').catch((): Record<string, unknown> => ({}));
  moreOptions.open = sendOptionsOpen === true;
  let lastOpen = moreOptions.open;
  moreOptions.addEventListener('toggle', () => {
    if (moreOptions.open === lastOpen) return;
    lastOpen = moreOptions.open;
    void saveLocal({ sendOptionsOpen: lastOpen }).catch(() => {});
  });
}

const DELIVERY_TIME: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

/** A lost answer to a delayed publish: the Inbox can't tell whether it arrived until it is delivered */
const UNCERTAIN_SCHEDULE =
  'Delivery is uncertain: the server may have scheduled the message. It only appears in the Inbox when it is delivered, so sending again can deliver it twice.';

function uncertainText(error: PublishUncertainError, delayed: boolean): string {
  return delayed ? UNCERTAIN_SCHEDULE : error.message;
}

// ==================
// Attachments
// ==================

export async function loadAttachments(): Promise<void> {
  try {
    state.attachments = await listStoredFiles();
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
  updateMoreOptions();
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
    await addPickedFiles(files);
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

interface SentResult {
  revision: string;
  attachmentCount: number;
  zip?: boolean;
  filesNotCleared?: boolean;
  /** Sent with a delay: when the server will deliver it (unix seconds), if its answer said so */
  scheduled?: { time?: number };
}

function successText({ attachmentCount, zip, scheduled }: SentResult): string {
  if (!scheduled) {
    if (zip) return 'ZIP sent!';
    return attachmentCount > 1 ? `${attachmentCount} notifications sent!` : 'Notification sent!';
  }
  const what = zip ? 'ZIP' : attachmentCount > 1 ? `${attachmentCount} notifications` : 'Notification';
  const { time } = scheduled;
  // Only a time that is still ahead: a server that ignored the delay answers with the current time
  const when = time && time * 1000 > Date.now() ? ` for ${new Date(time * 1000).toLocaleString(undefined, DELIVERY_TIME)}` : '';
  return `${what} scheduled${when}. ${attachmentCount > 1 && !zip ? 'They appear' : 'It appears'} in the Inbox when delivered.`;
}

async function finishSuccessfulSend(result: SentResult): Promise<void> {
  const { revision, attachmentCount, filesNotCleared = false, scheduled } = result;
  const sent = scheduled ? 'Scheduled' : 'Sent';
  if (attachmentCount > 0) {
    elements.fileInput.value = '';
    await loadAttachments();
  }
  try {
    await sendToBackground({ action: 'clearDraft', revision });
  } catch {
    showStatus(
      filesNotCleared ? `${sent}, but the sent files and draft could not be cleared.` : `${sent}, but the draft could not be cleared.`,
      'warning',
    );
    return;
  }
  const edited = revision !== draftRevision;
  if (!edited) {
    elements.messageInput.value = '';
    elements.titleInput.value = '';
    state.autoTitle = '';
    state.autoMessage = '';
    applyPagePrefill();
    // The next message starts from the topic's priority and tags again, without the options of this one
    clearMoreOptions();
    state.customPriorityTags = false;
    applySendDefaults();
  }

  if (filesNotCleared) {
    showStatus(`${sent}, but some uploaded files could not be cleared.`, 'warning');
  } else if (!edited && !scheduled && !elements.sendAnotherCheckbox.checked && !isPageMode) {
    setTimeout(() => {
      if (draftRevision === revision) window.close();
    }, 100);
  } else {
    // A scheduled message keeps the popup open: this line is the only sign of it until delivery
    showStatus(successText(result), 'success');
  }
}

export async function send(): Promise<void> {
  // Taken before the first await, so a second click can't start a second send
  if (state.isSending) return;
  clearStatus(elements.status);
  state.isSending = true;
  elements.sendBtn.disabled = true;
  try {
    // The toolbar popup and extension tabs share attachments and a saved draft.
    await navigator.locks.request('ntfy-publish', { ifAvailable: true }, async (lock) => {
      if (lock) await sendNow();
      else showStatus('A send is already in progress in another ntfy Desk window.', 'warning');
    });
  } catch {
    showStatus('Could not prepare or finish the send. Check the inbox before retrying.', 'error');
  } finally {
    state.isSending = false;
    elements.sendBtn.disabled = false;
    renderAttachments();
  }
}

async function clearSentFiles(ids: string[]): Promise<boolean> {
  try {
    await removeStoredFiles(ids);
    return true;
  } catch {
    return false;
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

  // Every field is read before the first await, so an edit made while the draft is being saved
  // belongs to the next message, not to this one
  const more = readMoreOptions();

  // Capture the latest values first, so a failed send can be retried
  const revision = await saveDraft();
  if (!more) return;
  const options: PublishOptions = { message, title, priority, tags, ...more };
  const delayed = Boolean(more.delay);
  // The delivery time of a delayed message, from the first answer that says it
  let deliveryTime: number | undefined;
  const noteDelivery = async (response: Response): Promise<void> => {
    if (delayed) deliveryTime ??= await publishedTime(response);
  };
  const scheduled = () => (delayed ? { time: deliveryTime } : undefined);

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

  // getConfig: the token and password only for servers approved on this device
  const servers = await getConfig();
  if (servers.apiUrl !== apiUrl || servers.fallbackUrl !== fallbackUrl || !servers.topics.includes(topic)) {
    showStatus('The server or topic changed. Reopen ntfy Desk before sending.', 'warning');
    return;
  }
  try {
    const server = await pickServer(servers);
    if (files.length === 0) {
      await noteDelivery(await sendNotification(server, topic, options));
      await finishSuccessfulSend({ revision, attachmentCount: 0, scheduled: scheduled() });
      return;
    }

    if (files.length > 1 && elements.zipCheckbox.checked) {
      while (files.length > 1) {
        const ids = files.map(({ id }) => id);
        const entries = await Promise.all(files.map(async (file) => ({ name: file.name, data: await file.blob.arrayBuffer() })));
        const zip = await createZip(entries);
        const filename = getZipFilename();
        const sent = await dispatchStoredUpload(ids, () =>
          sendAttachment(server, topic, { ...options, data: zip, filename, contentType: 'application/zip' }).then(noteDelivery),
        );
        if (sent) {
          const filesNotCleared = !(await clearSentFiles(ids));
          await finishSuccessfulSend({ revision, attachmentCount: files.length, zip: true, filesNotCleared, scheduled: scheduled() });
          return;
        }
        // A file disappeared during compression. Rebuild using only the original IDs still queued.
        const current = new Set((await listStoredFiles()).map(({ id }) => id));
        files = files.filter(({ id }) => current.has(id));
      }
    }

    // One message per attachment, one at a time
    const failures: { file: StoredFile; error: Error }[] = [];
    let sent = 0;
    let filesNotCleared = false;
    for (const file of files) {
      try {
        // slice(): the same bytes without the picked file's type, so fetch adds no Content-Type
        // header (ntfy can take text/markdown there as the message format); ntfy detects the type itself
        const data = file.blob.slice();
        const dispatched = await dispatchStoredUpload([file.id], () =>
          sendAttachment(server, topic, { ...options, data, filename: file.name }).then(noteDelivery),
        );
        if (!dispatched) continue;
      } catch (error) {
        failures.push({ file, error: error as Error });
        continue;
      }
      sent++;
      if (!(await clearSentFiles([file.id]))) filesNotCleared = true;
    }

    if (failures.length > 0) {
      // Failed files stay attached and the form stays as it is, for a retry
      const details = failures
        .map(({ file, error }) => `${file.name}: ${error instanceof PublishUncertainError ? uncertainText(error, delayed) : error.message}`)
        .join(' · ');
      const uncertain = failures.some(({ error }) => error instanceof PublishUncertainError);
      showStatus(
        `${sent} of ${files.length} attachment${files.length === 1 ? '' : 's'} ${uncertain ? 'confirmed' : delayed ? 'scheduled' : 'sent'}. ${details}${filesNotCleared ? ' Some uploaded files could not be cleared.' : ''}`,
        uncertain ? 'warning' : 'error',
      );
      return;
    }
    if (sent === 0) {
      await loadAttachments();
      showStatus('All selected attachments were removed before sending.', 'warning');
      return;
    }
    await finishSuccessfulSend({ revision, attachmentCount: sent, filesNotCleared, scheduled: scheduled() });
  } catch (error) {
    if (error instanceof PublishUncertainError) showStatus(uncertainText(error, delayed), 'warning');
    else showStatus(`Error: ${(error as Error).message}`, 'error');
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
    const priority = Number(chip.dataset.priority);
    if (!isPriority(priority)) return;
    state.selectedPriority = priority;
    updatePriorityUI();
    setByHand('priority');
  });
  elements.sendDefaultsReset.addEventListener('click', resetPriorityTags);

  elements.clickInput.addEventListener('input', () => {
    showFieldError(elements.clickInput, elements.clickError, '');
    updateMoreOptions();
    persistDraft();
  });
  elements.markdownCheckbox.addEventListener('change', () => {
    updateMoreOptions();
    persistDraft();
  });
  elements.delaySelect.addEventListener('change', () => {
    showFieldError(elements.delayInput, elements.delayError, '');
    updateMoreOptions();
    persistDraft();
    if (elements.delaySelect.value === CUSTOM_DELAY) elements.delayInput.focus();
  });
  elements.delayInput.addEventListener('input', () => {
    showFieldError(elements.delayInput, elements.delayError, '');
    persistDraft();
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
    applySendDefaults();
    persistDraft();
  });

  // The file picker window and other views change the queue and then its revision
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORED_FILES_REVISION_KEY]) {
      void loadAttachments();
    }
    if (area !== 'sync') return;
    // Send defaults and the values used last, changed in the settings, another view or through sync
    const defaults = changes[SEND_DEFAULTS_KEY];
    if (defaults) state.topicSendDefaults = parseSendDefaults(defaults.newValue);
    if (changes.priority) state.rememberedPriority = parseRememberedPriority(changes.priority.newValue);
    if (changes.lastTags) state.rememberedTags = parseRememberedTags(changes.lastTags.newValue);
    if (defaults || changes.priority || changes.lastTags) applySendDefaults();
  });
}
