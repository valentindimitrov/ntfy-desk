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
    topicDivider: byId('topic-divider'),
    sendDivider: byId('send-divider'),
    sendSection: byId<HTMLDetailsElement>('send-section'),
    mainContent: byId('main-content'), // Send form
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
    sendDefaultsReset: byId<HTMLButtonElement>('send-defaults-reset'),

    // More options
    moreOptions: byId<HTMLDetailsElement>('more-options'),
    moreOptionsActive: byId('more-options-active'),
    clickInput: byId<HTMLInputElement>('click-input'),
    clickError: byId('click-error'),
    markdownCheckbox: byId<HTMLInputElement>('markdown-checkbox'),
    delaySelect: byId<HTMLSelectElement>('delay-select'),
    delayInput: byId<HTMLInputElement>('delay-input'),
    delayHint: byId('delay-hint'),
    delayError: byId('delay-error'),

    // Attachments
    fileInput: byId<HTMLInputElement>('file-input'),
    fileBtn: byId<HTMLButtonElement>('file-btn'),
    fileBtnLabel: byId('file-btn-label'),
    filePreview: byId('file-preview'),
    zipToggle: byId('zip-toggle'),
    zipCheckbox: byId<HTMLInputElement>('zip-checkbox'),

    // Priority and theme chips
    priorityChips: byId('priority-chips'),
    themeChips: byId('theme-chips'),

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
    saveServerSettings: byId<HTMLButtonElement>('save-server-settings'),
    serverAccessHint: byId('server-access-hint'),
    insecureWarning: byId('insecure-warning'),
    heldBackBox: byId('held-back-box'),
    heldBackText: byId('held-back-text'),
    heldBackBtn: byId<HTMLButtonElement>('held-back-btn'),
    includeUrlCheckbox: byId<HTMLInputElement>('include-url-checkbox'),
    badgeScopeSelect: byId<HTMLSelectElement>('badge-scope-select'),
    keepUrgentGroup: byId('keep-urgent-group'),
    keepUrgentCheckbox: byId<HTMLInputElement>('keep-urgent-checkbox'),
    historyLimitSelect: byId<HTMLSelectElement>('history-limit-select'),
    messageTimesSelect: byId<HTMLSelectElement>('message-times-select'),
    densitySelect: byId<HTMLSelectElement>('density-select'),
    shortcutList: byId('shortcut-list'),
    shortcutSettingsBtn: byId<HTMLButtonElement>('shortcut-settings-btn'),
    shortcutHint: byId('shortcut-hint'),
    backupSection: byId('settings-backup'),
    exportSettingsBtn: byId<HTMLButtonElement>('export-settings-btn'),
    importSettingsBtn: byId<HTMLButtonElement>('import-settings-btn'),
    importSettingsInput: byId<HTMLInputElement>('import-settings-input'),
    importConfirm: byId('import-confirm'),
    importConfirmTitle: byId('import-confirm-title'),
    importConfirmList: byId('import-confirm-list'),
    importConfirmBtn: byId<HTMLButtonElement>('import-confirm-btn'),
    importCancelBtn: byId<HTMLButtonElement>('import-cancel-btn'),
    freezeDividersCheckbox: byId<HTMLInputElement>('freeze-dividers-checkbox'),
    rememberSendPanelCheckbox: byId<HTMLInputElement>('remember-send-panel-checkbox'),
    topicsContainer: byId('topics-container'),
    newTopicInput: byId<HTMLInputElement>('new-topic-input'),
    topicInputHint: byId('topic-input-hint'),
    topicSettingsGroup: byId('topic-settings-group'),
    topicSettingsRows: byId('topic-settings-rows'),
    applyTopicSettings: byId<HTMLButtonElement>('apply-topic-settings'),
    topicSettingsStatus: byId('topic-settings-status'),

    // Inbox
    notificationsSection: byId('notifications-section'),
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
