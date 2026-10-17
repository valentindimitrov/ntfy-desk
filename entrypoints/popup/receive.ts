// Receive tab: topic list with unread counts, and the received messages with read and delete actions.

import { browser } from 'wxt/browser';
import { getHistoryState } from '@/utils/history';
import { isHttpUrl, type NtfyMessage } from '@/utils/ntfy';
import { elements, isConfigured, loadReceiveState, saveLocal, state } from './state';
import { showStatus } from './ui';

function emptyMessage(text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'notifications-empty';
  div.textContent = text;
  return div;
}

export function formatTime(unixTime: number, now = new Date()): string {
  const date = new Date(unixTime * 1000);
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** All topics, then each configured topic, with unread counts */
function renderTopicSidebar(messages: NtfyMessage[]): void {
  const unreadCount = (topic: string) =>
    messages.filter(m => (topic === 'all' || m.topic === topic) && !state.readMessageIds.includes(m.id)).length;

  elements.topicSidebar.replaceChildren(
    ...['all', ...state.topics].map(topic => {
      const button = document.createElement('button');
      button.className = 'topic-filter-btn';
      button.classList.toggle('active', topic === state.receiveFilter);

      const name = document.createElement('span');
      name.className = 'topic-filter-name';
      name.textContent = topic === 'all' ? 'All topics' : topic;
      button.appendChild(name);

      const count = unreadCount(topic);
      if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'topic-unread-count';
        badge.textContent = String(count);
        button.appendChild(badge);
      }

      button.addEventListener('click', () => {
        state.receiveFilter = topic;
        saveLocal({ receiveTopicFilter: topic }).catch(() => {});
        void loadNotifications();
      });
      return button;
    }),
  );
}

function renderMessage(message: NtfyMessage): HTMLElement {
  const item = document.createElement('div');
  item.className = 'notification-item';
  item.dataset.priority = String(message.priority ?? 3);
  const isRead = state.readMessageIds.includes(message.id);
  item.classList.toggle('read', isRead);

  const header = document.createElement('div');
  header.className = 'notification-header';
  const title = document.createElement('span');
  title.className = 'notification-title';
  title.textContent = message.title || 'Notification';
  const time = document.createElement('span');
  time.className = 'notification-time';
  time.textContent = `${message.topic} · ${formatTime(message.time)}`;
  header.append(title, time);

  const body = document.createElement('div');
  body.className = 'notification-message';
  body.textContent = message.message || '';

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

  const readButton = document.createElement('button');
  readButton.className = 'notification-action-btn read-btn';
  readButton.textContent = '✓';
  readButton.title = isRead ? 'Mark as Unread' : 'Mark as Read';
  readButton.addEventListener('click', () => void toggleRead(message.id, item, readButton));
  actions.appendChild(readButton);

  const attachmentUrl = message.attachment?.url;
  if (isHttpUrl(attachmentUrl)) {
    const linkButton = document.createElement('button');
    linkButton.className = 'notification-action-btn link-btn';
    linkButton.textContent = '🔗';
    linkButton.title = 'Copy Attachment Link';
    linkButton.addEventListener('click', () => void copyLink(attachmentUrl, linkButton));
    actions.appendChild(linkButton);
  }

  const deleteButton = document.createElement('button');
  deleteButton.className = 'notification-action-btn delete-btn';
  deleteButton.textContent = '×';
  deleteButton.title = 'Delete Notification';
  deleteButton.addEventListener('click', () => void deleteMessage(message.id, item));
  actions.appendChild(deleteButton);

  footer.appendChild(actions);
  item.append(header, body, footer);
  return item;
}

/** The received messages of all topics, like the unread badge counts them, filtered by the topic list */
export async function loadNotifications(): Promise<void> {
  if (!isConfigured()) {
    elements.notificationsList.replaceChildren(emptyMessage('Configure server and topics to view notifications'));
    return;
  }

  try {
    const { receivedNotifications } = await getHistoryState();
    const all = receivedNotifications.filter(m => !state.deletedMessageIds.includes(m.id));

    if (state.receiveFilter !== 'all' && !state.topics.includes(state.receiveFilter)) {
      state.receiveFilter = 'all';
    }
    renderTopicSidebar(all);

    const shown = state.receiveFilter === 'all' ? all : all.filter(m => m.topic === state.receiveFilter);
    state.currentNotifications = shown;
    // Hidden rather than removed, so the heading doesn't move
    elements.notificationsControlBar.style.visibility = shown.length > 0 ? 'visible' : 'hidden';

    if (shown.length === 0) {
      elements.notificationsList.replaceChildren(emptyMessage('No recent notifications'));
      return;
    }
    shown.sort((a, b) => b.time - a.time);
    elements.notificationsList.replaceChildren(...shown.map(renderMessage));
  } catch (error) {
    console.error('Error loading notifications:', error);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'notifications-error';
    errorDiv.textContent = `Error: ${(error as Error).message}`;
    elements.notificationsList.replaceChildren(errorDiv);
  }
}

async function toggleRead(id: string, item: HTMLElement, button: HTMLElement): Promise<void> {
  const index = state.readMessageIds.indexOf(id);
  if (index > -1) {
    state.readMessageIds.splice(index, 1);
  } else {
    state.readMessageIds.push(id);
  }
  item.classList.toggle('read', index === -1);
  button.title = index === -1 ? 'Mark as Unread' : 'Mark as Read';
  try {
    await saveLocal({ readMessageIds: state.readMessageIds });
  } catch (error) {
    console.error('Error saving readMessageIds:', error);
  }
}

async function deleteMessage(id: string, item: HTMLElement): Promise<void> {
  try {
    if (!state.deletedMessageIds.includes(id)) {
      state.deletedMessageIds.push(id);
      await saveLocal({ deletedMessageIds: state.deletedMessageIds });
    }
    item.remove();

    const readIndex = state.readMessageIds.indexOf(id);
    if (readIndex > -1) {
      state.readMessageIds.splice(readIndex, 1);
      await saveLocal({ readMessageIds: state.readMessageIds });
    }
    if (elements.notificationsList.children.length === 0) {
      elements.notificationsList.replaceChildren(emptyMessage('No recent notifications'));
    }
  } catch (error) {
    console.error('Error deleting notification locally:', error);
    showStatus('Failed to delete notification', 'error');
  }
}

async function copyLink(url: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    const originalTitle = button.title;
    button.title = 'Copied!';
    button.style.color = 'var(--primary-light)';
    showStatus('Attachment link copied!', 'success');
    setTimeout(() => {
      button.title = originalTitle;
      button.style.color = '';
    }, 2000);
  } catch (error) {
    console.error('Failed to copy link:', error);
    showStatus('Failed to copy link', 'error');
  }
}

async function markAllRead(): Promise<void> {
  const unread = state.currentNotifications.filter(m => !state.readMessageIds.includes(m.id));
  if (unread.length === 0) return;
  state.readMessageIds.push(...unread.map(m => m.id));
  try {
    await saveLocal({ readMessageIds: state.readMessageIds });
    showStatus('All marked as read', 'success');
  } catch (error) {
    console.error('Error saving readMessageIds:', error);
    showStatus('Failed to mark all as read', 'error');
  }
}

async function deleteAll(): Promise<void> {
  if (state.currentNotifications.length === 0) return;
  const scope = state.receiveFilter === 'all' ? '' : ` in topic "${state.receiveFilter}"`;
  if (!confirm(`Are you sure you want to delete all notifications${scope}?`)) {
    return;
  }

  const ids = state.currentNotifications.map(m => m.id);
  state.deletedMessageIds = [...new Set([...state.deletedMessageIds, ...ids])];
  state.readMessageIds = state.readMessageIds.filter(id => !ids.includes(id));
  try {
    await saveLocal({ deletedMessageIds: state.deletedMessageIds, readMessageIds: state.readMessageIds });
    showStatus('All notifications deleted', 'success');
  } catch (error) {
    console.error('Error performing bulk delete:', error);
    showStatus('Failed to delete all', 'error');
  }
}

export function setupReceive(): void {
  elements.markAllReadBtn.addEventListener('click', () => void markAllRead());
  elements.deleteAllBtn.addEventListener('click', () => void deleteAll());

  // New messages from the background, and read or delete actions from another popup or tab
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.receivedNotifications || changes.readMessageIds || changes.deletedMessageIds)) {
      void loadReceiveState().then(loadNotifications);
    }
  });
}
