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
    mainContent: byId('main-content'), // Send form
    sendSection: byId<HTMLDetailsElement>('send-section'),
    inbox: byId('inbox'),
    settingsView: byId('settings-view'),

    // Header
    backBtn: byId<HTMLButtonElement>('back-btn'),
    headerText: byId('header-text'),
    headerConnection: byId('header-connection'),
    openUrlBtn: byId<HTMLButtonElement>('open-url-btn'),
    settingsBtn: byId<HTMLButtonElement>('settings-btn'),
    popoutBtn: byId<HTMLButtonElement>('popout-btn'),

    // Send form
    topicSelect: byId<HTMLSelectElement>('topic-select'),
    sendTopicHint: byId('send-topic-hint'),
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
    fallbackUrlInput: byId<HTMLInputElement>('fallback-url-input'),
    tokenInput: byId<HTMLInputElement>('token-input'),
    usernameInput: byId<HTMLInputElement>('username-input'),
    passwordInput: byId<HTMLInputElement>('password-input'),
    serverAccessBtn: byId<HTMLButtonElement>('server-access-btn'),
    serverAccessHint: byId('server-access-hint'),
    insecureWarning: byId('insecure-warning'),
    heldBackBox: byId('held-back-box'),
    heldBackText: byId('held-back-text'),
    heldBackBtn: byId<HTMLButtonElement>('held-back-btn'),
    includeUrlCheckbox: byId<HTMLInputElement>('include-url-checkbox'),
    topicsContainer: byId('topics-container'),
    newTopicInput: byId<HTMLInputElement>('new-topic-input'),
    topicInputHint: byId('topic-input-hint'),
    notifyRulesGroup: byId('notify-rules-group'),
    notifyRules: byId('notify-rules'),
    syncModesGroup: byId('sync-modes-group'),
    syncModes: byId('sync-modes'),

    // Inbox
    notificationsList: byId('notifications-list'),
    topicSidebar: byId('topic-sidebar'),
    notificationsControlBar: byId('notifications-control-bar'),
    connectionStatus: byId('connection-status'),
    receiveActionStatus: byId('receive-action-status'),
    notificationsSearch: byId<HTMLInputElement>('notifications-search'),
    markAllReadBtn: byId<HTMLButtonElement>('mark-all-read-btn'),
    deleteAllBtn: byId<HTMLButtonElement>('delete-all-btn'),

    tooltip: byId('tooltip'),
  };
}

export type Elements = ReturnType<typeof getElements>;
