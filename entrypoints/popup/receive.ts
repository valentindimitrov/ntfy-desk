// Inbox: topic list with unread counts, connection status, search, and the received messages
// (Markdown, links, image previews, the click URL on the title, view actions) with read and delete actions.

import { browser } from 'wxt/browser';
import { getHistoryState } from '@/utils/history';
import { isHttpUrl, type NtfyMessage } from '@/utils/ntfy';
import { linkify, renderMarkdown } from '@/utils/markdown';
import { sendToBackground } from '@/utils/messages';
import type { DeletionSyncResult, ServerDeletionIntent } from '@/utils/delete';
import { ruleFor } from '@/utils/rules';
import { STATUS_KEY, describeStatus, getReceiverStatus, retryCountdown, type ReceiverStatus } from '@/utils/status';
import { SYNC_DELETION_TOPICS_KEY, parseSyncDeletionTopics } from '@/utils/sync-modes';
import { updateSendTopic } from './send';
import { elements, inboxTopic, isConfigured, saveReceiveFilter, state } from './state';
import { clearStatus, showReceiveStatus } from './ui';

function emptyMessage(text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'notifications-empty';
  div.textContent = text;
  return div;
}

function formatTime(unixTime: number, now = new Date()): string {
  const date = new Date(unixTime * 1000);
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** All topics, then each configured topic, with unread counts */
function renderTopicSidebar(messages: NtfyMessage[], selected: string | null): void {
  const unreadCount = (topic: string | null) =>
    messages.filter((m) => (topic === null || m.topic === topic) && !state.readMessageIds.has(m.id)).length;

  elements.topicSidebar.replaceChildren(
    ...[null, ...state.topics].map((topic) => {
      const button = document.createElement('button');
      button.className = 'topic-filter-btn';
      button.dataset.topic = topic ?? '';
      button.classList.toggle('active', topic === selected);
      button.setAttribute('aria-pressed', String(topic === selected));

      const name = document.createElement('span');
      name.className = topic === null ? 'topic-filter-name all-topics-label' : 'topic-filter-name';
      name.textContent = topic ?? 'All topics';
      button.appendChild(name);

      if (topic !== null && ruleFor(state.notifyRules, topic) === 'off') {
        const muted = document.createElement('span');
        muted.className = 'topic-muted';
        muted.textContent = '🔕';
        muted.title = 'Desktop notifications off';
        button.appendChild(muted);
      }

      if (topic !== null && state.receiverStatus?.unreadableTopics.includes(topic)) {
        button.classList.add('send-only');
        button.title = 'No read access: this topic is used for sending only';
        const label = document.createElement('span');
        label.className = 'topic-send-only';
        label.textContent = 'send only';
        button.appendChild(label);
      }

      const count = unreadCount(topic);
      if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'topic-unread-count';
        badge.textContent = String(count);
        button.appendChild(badge);
      }

      button.addEventListener('click', () => {
        saveReceiveFilter(topic).catch(() => {});
        updateSendTopic();
        state.currentNotifications = [];
        void loadNotifications();
      });
      return button;
    }),
  );
}

// The message a click on its desktop notification opened: highlighted in every render, scrolled
// to and marked read once
let focusedId: string | null = null;
let pendingFocus = false;

export function focusMessage(id: string): void {
  focusedId = id;
  pendingFocus = true;
}

function applyPendingFocus(): void {
  if (!pendingFocus || !focusedId) return;
  const id = focusedId;
  const item = [...elements.notificationsList.querySelectorAll<HTMLElement>('.notification-item')].find((el) => el.dataset.id === id);
  if (!item) return;
  pendingFocus = false;
  item.scrollIntoView({ block: 'center' });
  if (!state.readMessageIds.has(id)) {
    const readButton = item.querySelector<HTMLElement>('.read-btn');
    if (readButton) void toggleRead(id, item, readButton);
  }
}

/** Whether a message contains every word of the search */
function matchesSearch(message: NtfyMessage, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [message.title, message.message, message.topic, ...(message.tags ?? []), message.attachment?.name].join(' ').toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * Image attachments are previewed only when the ntfy server hosts them, at its attachment route
 * (/file/<name>, no query) and before they expire. Other URLs on the server's origin could be API
 * calls (ntfy publishes on GET /<topic>/publish?message=...), which a preview would request.
 */
function previewableImage(message: NtfyMessage, serverUrls: string[], now = Date.now()): string | null {
  const attachment = message.attachment;
  if (!attachment?.type?.startsWith('image/') || !isHttpUrl(attachment.url)) return null;
  if (attachment.expires && attachment.expires * 1000 < now) return null;
  const url = new URL(attachment.url);
  if (!/^\/file\/[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/.test(url.pathname) || url.search || url.username || url.password) return null;
  const origin = url.origin;
  const onServer = serverUrls.some((url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  });
  return onServer ? attachment.url : null;
}

function openUrl(url: string): void {
  void browser.tabs.create({ url });
}

function renderMessage(message: NtfyMessage): HTMLElement {
  const item = document.createElement('div');
  item.className = 'notification-item';
  item.dataset.id = message.id;
  item.classList.toggle('focused', message.id === focusedId);
  item.dataset.priority = String(message.priority ?? 3);
  const isRead = state.readMessageIds.has(message.id);
  item.classList.toggle('read', isRead);

  const header = document.createElement('div');
  header.className = 'notification-header';
  // With a click URL (http(s) only), the title opens it
  const clickUrl = message.click;
  const title = document.createElement(isHttpUrl(clickUrl) ? 'button' : 'span');
  title.className = 'notification-title';
  title.textContent = message.title || 'Notification';
  if (isHttpUrl(clickUrl)) {
    title.classList.add('notification-link');
    title.title = clickUrl;
    title.addEventListener('click', () => openUrl(clickUrl));
  }
  const time = document.createElement('span');
  time.className = 'notification-time';
  time.textContent = `${message.topic} · ${formatTime(message.time)}`;
  header.append(title, time);

  const body = document.createElement('div');
  body.className = 'notification-message';
  if (message.content_type === 'text/markdown') {
    body.classList.add('markdown');
    body.append(renderMarkdown(message.message || ''));
  } else {
    body.append(linkify(message.message || ''));
  }

  const imageUrl = previewableImage(message, [state.apiUrl, state.fallbackUrl]);
  let preview: HTMLElement | null = null;
  if (imageUrl) {
    const image = document.createElement('img');
    image.className = 'notification-image';
    image.src = imageUrl;
    image.alt = message.attachment?.name ?? 'Image attachment';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('click', () => openUrl(imageUrl));
    preview = image;
  }

  const footer = document.createElement('div');
  footer.className = 'notification-footer';
  if (message.tags && message.tags.length > 0) {
    const tags = document.createElement('div');
    tags.className = 'notification-tags';
    for (const tag of message.tags) {
      const span = document.createElement('span');
      span.className = 'notification-tag';
      span.textContent = tag;
      tags.appendChild(span);
    }
    footer.appendChild(tags);
  }

  const actions = document.createElement('div');
  actions.className = 'notification-actions';

  // View actions (http(s) only); http and broadcast actions are left out
  for (const action of message.actions ?? []) {
    const url = action.url;
    if (action.action !== 'view' || !isHttpUrl(url)) continue;
    const button = document.createElement('button');
    button.className = 'notification-view-action';
    button.textContent = `↗ ${action.label}`;
    button.title = url;
    button.addEventListener('click', () => openUrl(url));
    actions.appendChild(button);
  }

  const readButton = document.createElement('button');
  readButton.className = 'notification-action-btn read-btn';
  readButton.textContent = '✓';
  readButton.title = isRead ? 'Mark as Unread' : 'Mark as Read';
  readButton.setAttribute('aria-label', readButton.title);
  readButton.addEventListener('click', () => void toggleRead(message.id, item, readButton));
  actions.appendChild(readButton);

  const attachmentUrl = message.attachment?.url;
  if (isHttpUrl(attachmentUrl)) {
    const linkButton = document.createElement('button');
    linkButton.className = 'notification-action-btn link-btn';
    linkButton.textContent = '🔗';
    linkButton.title = 'Copy Attachment Link';
    linkButton.setAttribute('aria-label', linkButton.title);
    linkButton.addEventListener('click', () => void copyLink(attachmentUrl, linkButton));
    actions.appendChild(linkButton);
  }

  const deleteButton = document.createElement('button');
  deleteButton.className = 'notification-action-btn delete-btn';
  deleteButton.textContent = '×';
  const server = serverDeletionIntent([message]);
  deleteButton.title = server ? 'Delete here and on the server (if allowed)' : 'Delete Notification';
  deleteButton.setAttribute('aria-label', deleteButton.title);
  deleteButton.addEventListener('click', () => void deleteMessage(message.id, item, server));
  actions.appendChild(deleteButton);

  footer.appendChild(actions);
  item.append(header, body, ...(preview ? [preview] : []), footer);
  return item;
}

function restoreInboxFocus(previous: Element | null): void {
  if (!previous || previous.isConnected) return;
  const topic = previous.closest<HTMLElement>('.topic-filter-btn')?.dataset.topic;
  if (topic !== undefined) {
    const buttons = [...elements.topicSidebar.querySelectorAll<HTMLButtonElement>('.topic-filter-btn')];
    (buttons.find((button) => button.dataset.topic === topic) ?? buttons[0] ?? elements.notificationsSearch).focus();
    return;
  }
  const row = previous.closest<HTMLElement>('.notification-item');
  if (!row?.dataset.id) return;
  const controls = 'button,a[href]';
  const index = [...row.querySelectorAll(controls)].indexOf(previous);
  const replacement = [...elements.notificationsList.querySelectorAll<HTMLElement>('.notification-item')].find(
    (item) => item.dataset.id === row.dataset.id,
  );
  (replacement?.querySelectorAll<HTMLElement>(controls)[index] ?? elements.notificationsSearch).focus();
}

/** A message, or a placeholder if it can't be rendered, so one bad message doesn't hide the others */
function renderMessageSafely(message: NtfyMessage): HTMLElement {
  try {
    return renderMessage(message);
  } catch (error) {
    console.error('Error rendering message:', message.id, error);
    const item = document.createElement('div');
    item.className = 'notification-item';
    item.textContent = 'This message could not be shown';
    return item;
  }
}

function showLoadError(error: unknown): void {
  console.error('Error loading notifications:', error);
  const errorDiv = document.createElement('div');
  errorDiv.className = 'notifications-error';
  errorDiv.textContent = `Error: ${(error as Error).message}`;
  elements.notificationsList.replaceChildren(errorDiv);
}

/** Read the history from storage, then render it */
export async function loadNotifications(): Promise<void> {
  if (!isConfigured()) {
    renderNotifications();
    return;
  }
  try {
    const { receivedNotifications, readMessageIds, deletedMessageIds } = await getHistoryState();
    state.history = receivedNotifications;
    state.readMessageIds = new Set(readMessageIds);
    state.deletedMessageIds = new Set(deletedMessageIds);
  } catch (error) {
    showLoadError(error);
    return;
  }
  renderNotifications();
}

/** The received messages of all topics, like the unread badge counts them, filtered by the topic list and search */
function renderNotifications(): void {
  if (!isConfigured()) {
    elements.topicSidebar.replaceChildren();
    elements.notificationsControlBar.style.visibility = 'hidden';
    state.currentNotifications = [];
    elements.notificationsList.replaceChildren(emptyMessage('Configure server and topics to view notifications'));
    return;
  }

  try {
    const all = state.history.filter((m) => !state.deletedMessageIds.has(m.id));
    const focused = document.activeElement;

    const topic = inboxTopic();
    renderTopicSidebar(all, topic);

    const inTopic = topic === null ? all : all.filter((m) => m.topic === topic);
    const query = elements.notificationsSearch.value;
    const shown = inTopic.filter((m) => matchesSearch(m, query));
    state.currentNotifications = shown;
    // Hidden rather than removed, so the heading doesn't move
    elements.notificationsControlBar.style.visibility = shown.length > 0 ? 'visible' : 'hidden';

    if (shown.length === 0) {
      elements.notificationsList.replaceChildren(
        emptyMessage(inTopic.length > 0 ? 'No messages match the search' : 'No recent notifications'),
      );
      restoreInboxFocus(focused);
      return;
    }
    shown.sort((a, b) => b.time - a.time);
    elements.notificationsList.replaceChildren(...shown.map(renderMessageSafely));
    restoreInboxFocus(focused);
    applyPendingFocus();
  } catch (error) {
    showLoadError(error);
  }
}

async function toggleRead(id: string, item: HTMLElement, button: HTMLElement): Promise<void> {
  clearStatus(elements.receiveActionStatus);
  const read = !state.readMessageIds.has(id);
  if (read) state.readMessageIds.add(id);
  else state.readMessageIds.delete(id);
  item.classList.toggle('read', read);
  button.title = read ? 'Mark as Unread' : 'Mark as Read';
  button.setAttribute('aria-label', button.title);
  try {
    await sendToBackground({ action: 'setRead', ids: [id], read });
  } catch (error) {
    console.error('Error saving the read state:', error);
  }
}

function serverDeletionIntent(messages: NtfyMessage[]): ServerDeletionIntent | undefined {
  const ids = messages.filter((message) => state.syncDeletionTopics.has(message.topic)).map(({ id }) => id);
  return ids.length ? { ids, apiUrl: state.apiUrl, fallbackUrl: state.fallbackUrl } : undefined;
}

async function deleteMessage(id: string, item: HTMLElement, server?: ServerDeletionIntent): Promise<void> {
  clearStatus(elements.receiveActionStatus);
  try {
    // Shown at once; the background applies it and the storage change refreshes every open view
    state.deletedMessageIds.add(id);
    state.readMessageIds.delete(id);
    item.remove();
    showDeletionResult(await sendToBackground({ action: 'delete', ids: [id], server }));
    if (elements.notificationsList.children.length === 0) {
      elements.notificationsList.replaceChildren(emptyMessage('No recent notifications'));
    }
  } catch (error) {
    console.error('Error deleting notification locally:', error);
    showReceiveStatus('Failed to delete notification', 'error');
  }
}

function showDeletionResult(result: DeletionSyncResult | undefined, success?: string): void {
  if (result?.failed) {
    showReceiveStatus('Deleted here. Some server deletions could not be confirmed.', 'warning');
  } else if (result?.denied) {
    showReceiveStatus('Deleted here. The server denied deletion.', 'warning');
  } else if (result?.skipped) {
    showReceiveStatus('Deleted here. Server deletion was skipped because settings changed.', 'warning');
  } else if (success) {
    showReceiveStatus(success, 'success');
  }
}

async function copyLink(url: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    button.style.color = 'var(--primary-light)';
    showReceiveStatus('Attachment link copied!', 'success');
    setTimeout(() => {
      button.style.color = '';
    }, 2000);
  } catch (error) {
    console.error('Failed to copy link:', error);
    showReceiveStatus('Failed to copy link', 'error');
  }
}

async function markAllRead(): Promise<void> {
  clearStatus(elements.receiveActionStatus);
  const unread = state.currentNotifications.filter((m) => !state.readMessageIds.has(m.id));
  if (unread.length === 0) return;
  for (const { id } of unread) state.readMessageIds.add(id);
  try {
    await sendToBackground({ action: 'setRead', ids: unread.map((m) => m.id), read: true });
    showReceiveStatus('All marked as read', 'success');
  } catch (error) {
    console.error('Error saving readMessageIds:', error);
    showReceiveStatus('Failed to mark all as read', 'error');
  }
}

async function deleteAll(): Promise<void> {
  if (state.currentNotifications.length === 0) return;
  const topic = inboxTopic();
  const scope = topic === null ? '' : ` in topic "${topic}"`;
  const ids = state.currentNotifications.map((m) => m.id);
  const server = serverDeletionIntent(state.currentNotifications);
  const serverNotice = server ? ' This also deletes on the server for topics with deletion sync enabled, when allowed.' : '';
  if (!confirm(`Are you sure you want to delete all notifications${scope}?${serverNotice}`)) {
    return;
  }

  clearStatus(elements.receiveActionStatus);
  for (const id of ids) {
    state.deletedMessageIds.add(id);
    state.readMessageIds.delete(id);
  }
  try {
    showDeletionResult(await sendToBackground({ action: 'delete', ids, server }), 'All notifications deleted');
  } catch (error) {
    console.error('Error performing bulk delete:', error);
    showReceiveStatus('Failed to delete all', 'error');
  }
}

/** Connection status in the header, with warnings and errors above the list. */
function renderConnectionStatus(): void {
  const lines = describeStatus(state.receiverStatus);
  const connected = lines[0]?.level === 'ok' ? lines.shift() : undefined;
  const connection = connected?.text ?? '';
  elements.headerConnection.hidden = !connected;
  if (elements.headerConnection.textContent !== connection) {
    elements.headerConnection.textContent = connection;
    elements.headerConnection.title = connection;
    elements.headerConnection.setAttribute('aria-label', connection);
  }
  const children = [...elements.connectionStatus.children] as HTMLElement[];
  lines.forEach(({ text, level }, index) => {
    const previous = children[index];
    const className = `status-line ${level}`;
    if (previous?.dataset.text === text && previous.className === className) return;
    const line = document.createElement('div');
    line.className = className;
    line.dataset.text = text;
    line.textContent = text;
    if (index === 0 && state.receiverStatus?.state === 'reconnecting') {
      const countdown = document.createElement('span');
      countdown.className = 'retry-countdown';
      countdown.setAttribute('aria-hidden', 'true');
      countdown.textContent = retryCountdown(state.receiverStatus.retryAt);
      line.append(countdown);
    }
    if (previous) previous.replaceWith(line);
    else elements.connectionStatus.append(line);
  });
  children.slice(lines.length).forEach((line) => line.remove());
}

async function loadConnectionStatus(): Promise<void> {
  state.receiverStatus = await getReceiverStatus();
  renderConnectionStatus();
  void loadNotifications(); // the topic list marks send-only topics
}

export function setupReceive(): void {
  void loadConnectionStatus();
  // The reconnect countdown
  setInterval(() => {
    const countdown = elements.connectionStatus.querySelector('.retry-countdown');
    if (countdown) countdown.textContent = retryCountdown(state.receiverStatus?.retryAt ?? null);
  }, 1000);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[STATUS_KEY]) {
      const previouslyUnreadable = state.receiverStatus?.unreadableTopics.join(',') ?? '';
      state.receiverStatus = (changes[STATUS_KEY].newValue as ReceiverStatus | undefined) ?? null;
      renderConnectionStatus();
      if ((state.receiverStatus?.unreadableTopics.join(',') ?? '') !== previouslyUnreadable) void loadNotifications();
    }
    if (area === 'sync' && changes[SYNC_DELETION_TOPICS_KEY]) {
      state.syncDeletionTopics = parseSyncDeletionTopics(changes[SYNC_DELETION_TOPICS_KEY].newValue);
      void loadNotifications();
    }
  });

  elements.markAllReadBtn.addEventListener('click', () => void markAllRead());
  // Searching re-filters the history already loaded; storage changes below reload it
  elements.notificationsSearch.addEventListener('input', renderNotifications);
  elements.deleteAllBtn.addEventListener('click', () => void deleteAll());

  // New messages from the background, and read or delete actions from another popup or tab
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.receivedNotifications || changes.readMessageIds || changes.deletedMessageIds)) {
      void loadNotifications();
    }
  });
}
