// Elements of the popup page (index.html). Looked up once; a missing id is a bug in the page.

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

export function getElements() {
  return {
    // Views
    mainView: byId('main-view'),
    mainContent: byId('main-content'), // Send tab form
    settingsView: byId('settings-view'),

    // Header
    backBtn: byId<HTMLButtonElement>('back-btn'),
    headerText: byId('header-text'),
    openUrlBtn: byId<HTMLButtonElement>('open-url-btn'),
    settingsBtn: byId<HTMLButtonElement>('settings-btn'),
    popoutBtn: byId<HTMLButtonElement>('popout-btn'),

    // Send form
    topicSelect: byId<HTMLSelectElement>('topic-select'),
    topicDropdown: byId('topic-dropdown'),
    topicDropdownSelected: byId('topic-dropdown-selected'),
    topicDropdownText: byId('topic-dropdown-text'),
    topicDropdownOptions: byId('topic-dropdown-options'),
    titleInput: byId<HTMLInputElement>('title-input'),
    tabUrlBtn: byId<HTMLButtonElement>('tab-url-btn'),
    messageInput: byId<HTMLTextAreaElement>('message-input'),
    tagsContainer: byId('tags-container'),
    newTagInput: byId<HTMLInputElement>('new-tag-input'),
    tagInputHint: byId('tag-input-hint'),

    // Attachments
    fileInput: byId<HTMLInputElement>('file-input'),
    fileBtn: byId<HTMLButtonElement>('file-btn'),
    filePreview: byId('file-preview'),
    zipToggle: byId('zip-toggle'),
    zipCheckbox: byId<HTMLInputElement>('zip-checkbox'),

    // Priority and theme chips
    priorityChips: byId('priority-chips'),
    themeChips: byId('theme-chips'),

    // Advanced options
    advancedToggle: byId('advanced-toggle'),
    advancedOptions: byId('advanced-options'),

    // Actions
    sendBtn: byId<HTMLButtonElement>('send-btn'),
    sendAnotherCheckbox: byId<HTMLInputElement>('send-another-checkbox'),

    // Status lines
    status: byId('status'),
    settingsStatus: byId('settings-status'),

    // Settings
    urlInput: byId<HTMLInputElement>('url-input'),
    tokenInput: byId<HTMLInputElement>('token-input'),
    serverAccessBtn: byId<HTMLButtonElement>('server-access-btn'),
    serverAccessHint: byId('server-access-hint'),
    includeUrlCheckbox: byId<HTMLInputElement>('include-url-checkbox'),
    topicsContainer: byId('topics-container'),
    newTopicInput: byId<HTMLInputElement>('new-topic-input'),
    topicInputHint: byId('topic-input-hint'),
    notifyRulesGroup: byId('notify-rules-group'),
    notifyRules: byId('notify-rules'),

    // Receive tab
    notificationsList: byId('notifications-list'),
    topicSidebar: byId('topic-sidebar'),
    notificationsControlBar: byId('notifications-control-bar'),
    connectionStatus: byId('connection-status'),
    markAllReadBtn: byId<HTMLButtonElement>('mark-all-read-btn'),
    deleteAllBtn: byId<HTMLButtonElement>('delete-all-btn'),

    // Tabs
    tabButtons: document.querySelectorAll<HTMLButtonElement>('.tab-btn'),
    tabContents: document.querySelectorAll<HTMLElement>('.tab-content'),

    tooltip: byId('tooltip'),
  };
}

export type Elements = ReturnType<typeof getElements>;
