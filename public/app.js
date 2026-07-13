const persistedDesktopPreferences = window.localleafDesktop?.preferences;
if (persistedDesktopPreferences && typeof persistedDesktopPreferences === "object" && !Array.isArray(persistedDesktopPreferences)) {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("localleaf.")) localStorage.removeItem(key);
  }
  Object.entries(persistedDesktopPreferences).forEach(([key, value]) => {
    if (key.startsWith("localleaf.") && typeof value === "string") localStorage.setItem(key, value);
  });
}

function desktopPreferenceSnapshot() {
  const values = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("localleaf.")) values[key] = localStorage.getItem(key) || "";
  }
  return values;
}

let lastDesktopPreferenceSnapshot = JSON.stringify(desktopPreferenceSnapshot());
let hasSavedDesktopPreferences = persistedDesktopPreferences !== null;
function persistDesktopPreferences() {
  if (typeof window.localleafDesktop?.savePreferences !== "function") return;
  const values = desktopPreferenceSnapshot();
  const serialized = JSON.stringify(values);
  if (serialized === lastDesktopPreferenceSnapshot && hasSavedDesktopPreferences) return;
  lastDesktopPreferenceSnapshot = serialized;
  hasSavedDesktopPreferences = true;
  window.localleafDesktop.savePreferences(values);
}

if (typeof window.localleafDesktop?.savePreferences === "function") {
  window.setInterval(persistDesktopPreferences, 750);
  window.addEventListener("pagehide", persistDesktopPreferences);
}

const clientId = crypto.randomUUID();
const initialParams = new URLSearchParams(location.search);
const initialHostToken = initialParams.get("host") || initialParams.get("hostToken") || sessionStorage.getItem("localleaf.hostToken") || "";
const initialGuestToken = initialParams.get("token") || sessionStorage.getItem("localleaf.guestToken") || "";
if (initialHostToken) sessionStorage.setItem("localleaf.hostToken", initialHostToken);
if (initialGuestToken) sessionStorage.setItem("localleaf.guestToken", initialGuestToken);
if (initialParams.has("host") || initialParams.has("hostToken") || initialParams.has("token")) {
  const visibleParams = new URLSearchParams(initialParams);
  visibleParams.delete("host");
  visibleParams.delete("hostToken");
  visibleParams.delete("token");
  const visibleQuery = visibleParams.toString();
  history.replaceState({}, "", `${location.pathname}${visibleQuery ? `?${visibleQuery}` : ""}${location.hash}`);
}
const startsNarrow = window.matchMedia("(max-width: 1020px)").matches;
const startsMobile = window.matchMedia("(max-width: 640px)").matches;
const platformName = String(navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
const SIDEBAR_SECTION_LAYOUT_VERSION = "2";
const JOIN_REQUEST_SOUND_URL = "/assets/sounds/join-request.ogg";
const PROJECT_SEARCH_MAX_RESULTS = 300;
const PROJECT_SEARCH_MAX_RESULTS_PER_FILE = 50;
const PROJECT_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_SCOPE_STORAGE_KEY = "localleaf.searchScope.v2";
const RECENT_PROJECTS_STORAGE_KEY = "localleaf.recentProjects.v1";
const RECENT_PROJECTS_LIMIT = 3;
const LAYOUT_STATE_STORAGE_VERSION = "4";
const AI_PERMISSIONS_STORAGE_KEY = "localleaf.aiPermissions.v1";
const AI_SESSIONS_STORAGE_KEY = "localleaf.aiSessions.v1";
const AI_SESSIONS_MIGRATION_STORAGE_KEY = "localleaf.aiSessions.projectStoreMigrated.v1";
const AI_PROVIDER_ENABLE_STORAGE_KEY = "localleaf.aiProviderEnabled.v1";
const AI_MODEL_ENABLE_STORAGE_KEY = "localleaf.aiModelEnabled.v1";
const AI_MODEL_GROUP_STORAGE_KEY = "localleaf.aiModelGroups.v1";
const EDITOR_MODE_STORAGE_KEY = "localleaf.editorModeByFile.v1";
const TUNNEL_PROVIDER_STORAGE_KEY = "localleaf.tunnelProvider.v1";
const LOCALLEAF_SITE_URL = "https://sethwhenton.github.io/localleaf/";
const AI_WELCOME_MESSAGE = "Ask me about LaTeX errors, rewrites, tables, or project structure. File edits will be tracked in Changes.";
const SUPPORTED_PROJECT_FILE_EXTENSIONS = new Set([
  ".tex",
  ".bib",
  ".bst",
  ".cls",
  ".sty",
  ".clo",
  ".cfg",
  ".def",
  ".ldf",
  ".bbx",
  ".cbx",
  ".bbl",
  ".txt",
  ".md",
  ".latex",
  ".tikz",
  ".csv",
  ".dat",
  ".json",
  ".asy",
  ".py",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".pdf",
  ".eps"
]);
const SUPPORTED_PROJECT_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".pdf",
  ".eps"
]);
const SUPPORTED_PROJECT_SPECIAL_FILENAMES = new Set(["latexmkrc", "makefile", ".latexmkrc"]);
const shouldResetSidebarSectionLayout = localStorage.getItem("localleaf.sidebarSectionLayoutVersion") !== SIDEBAR_SECTION_LAYOUT_VERSION;
const initialTheme = localStorage.getItem("localleaf.theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("runtime-electron", /\bElectron\//i.test(navigator.userAgent));
document.documentElement.classList.toggle("platform-mac", platformName.includes("mac"));
document.documentElement.classList.toggle("platform-win", platformName.includes("win"));
document.documentElement.classList.toggle("theme-dark", initialTheme === "dark");
document.documentElement.classList.toggle("theme-light", initialTheme !== "dark");
requestAnimationFrame(() => syncDesktopTheme(initialTheme));
localStorage.setItem("localleaf.editorMode", "code");
if (localStorage.getItem("localleaf.layoutStateVersion") !== LAYOUT_STATE_STORAGE_VERSION) {
  localStorage.setItem("localleaf.logsVisible", "1");
  localStorage.setItem("localleaf.layoutStateVersion", LAYOUT_STATE_STORAGE_VERSION);
}

function createAiWelcomeMessage() {
  return {
    id: "welcome",
    role: "assistant",
    message: AI_WELCOME_MESSAGE
  };
}

function createAiSession(title = "New session") {
  const now = Date.now();
  return {
    id: `session-${now}-${Math.random().toString(16).slice(2)}`,
    title,
    createdAt: now,
    updatedAt: now,
    lastPreview: "Ready to help with this project.",
    messageCount: 0,
    changeCount: 0,
    messages: [createAiWelcomeMessage()]
  };
}

function normalizeAiSession(session) {
  const fallback = createAiSession();
  const messages = Array.isArray(session?.messages) && session.messages.length
    ? session.messages.map((message) => message?.id === "welcome" ? createAiWelcomeMessage() : { ...message })
    : [createAiWelcomeMessage()];
  return {
    ...fallback,
    ...session,
    id: String(session?.id || fallback.id),
    title: String(session?.title || fallback.title || "New session").replace(/\s+/g, " ").trim().slice(0, 64) || "New session",
    createdAt: Number(session?.createdAt || fallback.createdAt),
    updatedAt: Number(session?.updatedAt || session?.createdAt || fallback.updatedAt),
    lastPreview: String(session?.lastPreview || "").trim() || sessionPreviewFromMessages(messages),
    messageCount: Number(session?.messageCount || messages.filter((message) => message.id !== "welcome").length),
    changeCount: Number(session?.changeCount || 0),
    messages
  };
}

function fallbackAiSessionState() {
  const session = createAiSession("First session");
  return { projectKey: "", projectName: "", sessions: [session], currentSessionId: session.id };
}

function readLegacyAiSessionState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_SESSIONS_STORAGE_KEY) || "{}");
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions.filter((session) => session?.id && Array.isArray(session.messages)).map(normalizeAiSession)
      : [];
    if (sessions.length) {
      const currentSessionId = sessions.some((session) => session.id === parsed.currentSessionId)
        ? parsed.currentSessionId
        : sessions[0].id;
      return { projectKey: "", projectName: "", sessions, currentSessionId };
    }
  } catch {
    // Fall through to a fresh local session when storage is unavailable or malformed.
  }
  return fallbackAiSessionState();
}

const initialAiSessionState = readLegacyAiSessionState();

function readBooleanMap(storageKey) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeBooleanMap(storageKey, value) {
  localStorage.setItem(storageKey, JSON.stringify(value || {}));
}

const app = document.querySelector("#app");
const local = {
  appState: null,
  selectedFile: null,
  editorContent: "",
  saving: false,
  saveTimer: null,
  joinRequestId: null,
  joinRequestAudio: null,
  notifiedJoinRequests: new Set(),
  hostToken: initialHostToken,
  guestToken: initialGuestToken,
  userName: initialParams.get("name") || "Host",
  userId: "",
  view: initialParams.get("view") || "",
  pendingViewTransition: null,
  viewMotionTimer: null,
  hostRailEntrancePending: true,
  pendingHostRailMotion: "",
  hostRailMotionTimer: null,
  editingNow: false,
  events: null,
  eventDisconnectTimer: null,
  sessionActionsMenuAbortController: null,
  sessionGuestMenuAbortController: null,
  sessionGuestRoles: {},
  sessionGuestBusy: {},
  sessionGuestErrors: {},
  sessionGuestStatus: "",
  sessionGuestFocusPending: false,
  sessionAccessRoleTarget: "",
  collabSocket: null,
  collabReconnectTimer: null,
  collabHeartbeatTimer: null,
  collabLostTimer: null,
  collabPresence: [],
  pendingCollabSaves: new Map(),
  collabSaveSequence: 0,
  applyingRemoteEdit: false,
  shownJoinRequests: new Set(),
  saveStatus: "Saved",
  pendingSave: false,
  savePromise: null,
  codeEditor: null,
  visualEditor: null,
  editorMode: "code",
  editorSuggestions: null,
  selectedFolder: "",
  draggedTreePath: "",
  draggedTreeKind: "",
  treeClipboardPath: "",
  treeContextMenu: null,
  renamingTreePath: "",
  renamingTreeKind: "",
  renameSaving: false,
  renameError: "",
  treeCreateDraft: null,
  treeCreateFocus: false,
  collapsedFolders: new Set(),
  imagesCollapsed: true,
  fileFilter: "",
  focusFileSearch: false,
  sidebarWidth: Number(localStorage.getItem("localleaf.sidebarWidth") || 280),
  sourcePaneWidth: Number(localStorage.getItem("localleaf.sourcePaneWidth") || 0),
  rightRailWidth: Number(localStorage.getItem("localleaf.rightRailWidth") || 280),
  logsHeight: Number(localStorage.getItem("localleaf.logsHeight") || 124),
  fileSectionHeight: shouldResetSidebarSectionLayout ? 0 : Number(localStorage.getItem("localleaf.fileSectionHeight") || 0),
  imageSectionHeight: shouldResetSidebarSectionLayout ? 0 : Number(localStorage.getItem("localleaf.imageSectionHeight") || 0),
  sidebarSectionLayoutNeedsDefault: shouldResetSidebarSectionLayout,
  sidebarSectionLayoutAutoSized: shouldResetSidebarSectionLayout,
  editorOpenLayoutPrepared: false,
  resizingSidebar: false,
  resizingSidebarSection: "",
  resizingSplit: false,
  resizingRightRail: false,
  resizingLogs: false,
  sidebarVisible: localStorage.getItem("localleaf.sidebarVisible") !== "0" && !startsMobile,
  sourcePaneVisible: localStorage.getItem("localleaf.sourcePaneVisible") !== "0",
  previewPaneVisible: localStorage.getItem("localleaf.previewPaneVisible") !== "0",
  rightRailVisible: localStorage.getItem("localleaf.rightRailVisible") !== "0" && !startsNarrow,
  rightRailTab: ["chat", "ai", "changes"].includes(localStorage.getItem("localleaf.rightRailTab"))
    ? localStorage.getItem("localleaf.rightRailTab")
    : "chat",
  logsVisible: localStorage.getItem("localleaf.logsVisible") !== "0",
  pdfScale: Number(localStorage.getItem("localleaf.pdfScale") || 1),
  pdfAnnotateMode: false,
  pdfAnnotationPopover: null,
  pdfSourceStatus: "",
  pdfSourceNavigator: null,
  searchOpen: false,
  searchQuery: "",
  searchReplace: "",
  searchMatchCase: false,
  searchWholeWord: false,
  searchRegex: false,
  searchStatus: "",
  searchScope: localStorage.getItem(SEARCH_SCOPE_STORAGE_KEY) === "file" ? "file" : "project",
  searchResults: [],
  searchResultIndex: -1,
  searchLoading: false,
  searchTruncated: false,
  searchRunId: 0,
  searchTimer: null,
  editorMoreMenuOpen: false,
  visualSearchIndex: 0,
  tablePickerOpen: false,
  editorStyleMenuOpen: false,
  visualAutocomplete: null,
  visualInsertAfterBlock: null,
  pendingPreviewScroll: null,
  pinnedCompileErrors: [],
  pinnedCompileWarnings: [],
  compileDiagnostics: [],
  clearedWarningVersion: null,
  compileBusy: false,
  compilePhase: "",
  compileRunId: 0,
  updateInfo: null,
  updateCheckStarted: false,
  updateChecking: false,
  updateInstalling: false,
  updateInstallStatus: "",
  updateDismissedVersion: localStorage.getItem("localleaf.updateDismissedVersion") || "",
  autoUpdateChecks: localStorage.getItem("localleaf.autoUpdateChecks") !== "0",
  joinRequestSoundEnabled: localStorage.getItem("localleaf.joinRequestSoundEnabled") !== "0",
  preferredTunnelProviderId: localStorage.getItem(TUNNEL_PROVIDER_STORAGE_KEY) || "",
  tunnelProviderPreferenceLoaded: localStorage.getItem(TUNNEL_PROVIDER_STORAGE_KEY) !== null,
  sessionTunnelProviderOverrideId: null,
  sessionProviderMenuAbortController: null,
  tunnelProviderSwitchBusy: false,
  sessionStartBusy: false,
  sessionStopBusy: false,
  theme: initialTheme,
  hostRailCollapsed: localStorage.getItem("localleaf.hostRailCollapsed") === "1",
  settingsSection: "general",
  settingsModelSearch: "",
  aiPrompt: "",
  aiBusy: false,
  aiActivityMessage: "",
  aiActiveRunCount: 0,
  aiActiveRunId: "",
  aiActiveRunSessionId: "",
  aiRunControllers: new Set(),
  aiStopRequested: false,
  aiQuickAction: "",
  aiModelPickerOpen: false,
  aiModelSearch: "",
  activeCursorSdkModelId: localStorage.getItem("localleaf.activeCursorSdkModelId") || "",
  aiSessionMenuOpen: false,
  aiSessionMoreMenuOpen: false,
  aiSessionActionMenuId: "",
  aiSessionSearch: "",
  aiSessionCreating: false,
  aiSessionCreateError: "",
  aiSessionSwitchTargetId: "",
  aiSessionNewId: "",
  aiSessionRenamingId: "",
  aiSessionRenameValue: "",
  aiSessionRenameError: "",
  aiSessionDeleteId: "",
  aiSessionDeletingId: "",
  aiSessionActivationRequestId: 0,
  aiSessionProjectRequestGeneration: 0,
  aiTranscriptSwitching: false,
  aiAnnouncement: "",
  aiContextPopoverOpen: false,
  aiContextUpdating: false,
  aiSessionState: window.LocalLeafAiSessionState?.createState(initialAiSessionState) || null,
  aiSessionsProjectKey: initialAiSessionState.projectKey || "",
  aiSessionsProjectName: initialAiSessionState.projectName || "",
  aiQueuedPromptMenuOpenId: "",
  aiChatNeedsJump: false,
  aiChatPinnedToBottom: true,
  aiForceScrollBottom: true,
  aiQueueingEnabled: localStorage.getItem("localleaf.aiQueueingEnabled") !== "0",
  aiQueuedPrompts: [],
  aiEditingQueuedPromptId: "",
  aiExpandedRuns: new Set(),
  aiExpandedChanges: new Set(),
  aiExpandedDiffs: new Set(),
  aiReviewNavigator: null,
  aiReviewOpenSequence: 0,
  aiReviewStatus: null,
  aiCompileRepairAttempts: {},
  aiCompileVerifying: false,
  aiSessions: initialAiSessionState.sessions,
  aiCurrentSessionId: initialAiSessionState.currentSessionId,
  aiProviderEnabled: readBooleanMap(AI_PROVIDER_ENABLE_STORAGE_KEY),
  aiModelEnabled: readBooleanMap(AI_MODEL_ENABLE_STORAGE_KEY),
  aiModelGroupOpen: readBooleanMap(AI_MODEL_GROUP_STORAGE_KEY),
  providerTestBusy: "",
  providerDialogTest: null,
  providerInlineTests: {},
  aiMessages: (initialAiSessionState.sessions.find((session) => session.id === initialAiSessionState.currentSessionId)?.messages || [createAiWelcomeMessage()]).map((message) => ({ ...message })),
  aiChangeHistory: [],
  aiPermissions: readAiPermissions(),
  modelActionBusy: "",
  homeImportFiles: [],
  homeImportDragActive: false,
  homeImportBusy: false,
  homeImportStatus: "",
  appNotice: null,
  appNoticeTimer: null,
  sessionEndedReason: "The host has ended the session.",
  sessionEndedDetail: "Ask the host to start it again."
};

function route() {
  const joinMatch = location.pathname.match(/^\/join\/([^/]+)$/);
  if (joinMatch) {
    return { view: "join", code: joinMatch[1] };
  }
  if (local.view) return { view: local.view };
  return { view: "home" };
}

async function api(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };
  if (local.guestToken) {
    headers["x-localleaf-token"] = local.guestToken;
  }
  if (local.hostToken) {
    headers["x-localleaf-host-token"] = local.hostToken;
  }

  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  const signal = options.signal || controller?.signal;
  let response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      headers,
      signal,
      body: Object.prototype.hasOwnProperty.call(options, "rawBody")
        ? options.rawBody
        : options.body
          ? JSON.stringify(options.body)
          : undefined
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(options.signal?.aborted ? "Request stopped." : "Request timed out.");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: response.ok ? "Unexpected response from LocalLeaf." : "Unexpected response from the LocalLeaf host." };
  }
  if (!response.ok) {
    const error = new Error(payload.error || response.statusText);
    Object.assign(error, payload, { status: response.status });
    throw error;
  }
  return payload;
}

function authUrl(path) {
  const tokenName = local.guestToken ? "token" : local.hostToken ? "host" : "";
  const tokenValue = local.guestToken || local.hostToken || "";
  if (!tokenName || !tokenValue) return path;
  const hashIndex = path.indexOf("#");
  const beforeHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
  const separator = beforeHash.includes("?") ? "&" : "?";
  return `${beforeHash}${separator}${tokenName}=${encodeURIComponent(tokenValue)}${hash}`;
}

function readAiPermissions() {
  const defaults = {
    askBeforeEdits: true,
    yoloMode: false,
    localModelOnly: false,
    rewriteTools: true,
    multiFileEdits: false,
    fileManagement: false,
    fileUploads: false,
    shellCommands: false,
    binaryFiles: false
  };
  try {
    const next = { ...defaults, ...JSON.parse(localStorage.getItem(AI_PERMISSIONS_STORAGE_KEY) || "{}") };
    if (next.yoloMode) next.askBeforeEdits = false;
    else next.askBeforeEdits = true;
    return next;
  } catch {
    return defaults;
  }
}

function saveAiPermissions() {
  localStorage.setItem(AI_PERMISSIONS_STORAGE_KEY, JSON.stringify(local.aiPermissions));
}

function setAiPermissionMode(mode = "default") {
  const isYolo = mode === "yolo";
  local.aiPermissions.yoloMode = isYolo;
  local.aiPermissions.askBeforeEdits = !isYolo;
  saveAiPermissions();
}

function toggleAiPermissionMode() {
  setAiPermissionMode(local.aiPermissions.yoloMode ? "default" : "yolo");
}

function syncAiPermissionInputs(root = document) {
  root.querySelectorAll?.("[data-ai-permission]").forEach((input) => {
    const key = input.dataset.aiPermission;
    if (key && Object.prototype.hasOwnProperty.call(local.aiPermissions, key)) {
      input.checked = Boolean(local.aiPermissions[key]);
    }
  });
}

function recentProjects() {
  try {
    const items = JSON.parse(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY) || "[]");
    return Array.isArray(items)
      ? items
        .filter((item) => item?.root)
        .sort((left, right) => Number(right.openedAt || 0) - Number(left.openedAt || 0))
        .slice(0, RECENT_PROJECTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function rememberRecentProject(project = local.appState?.project) {
  if (!project?.root) return;
  const next = [
    {
      name: project.name || "LocalLeaf Project",
      root: project.root,
      sizeLabel: project.sizeLabel || "",
      openedAt: Date.now()
    },
    ...recentProjects().filter((item) => item.root !== project.root)
  ].slice(0, RECENT_PROJECTS_LIMIT);
  localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(next));
}

function aiState() {
  return local.appState?.ai || local.appState?.aiModels || {
    storagePath: "",
    activeModel: "",
    download: null,
    models: [
      {
        id: "qwen35-08b-light",
        name: "Qwen3.5 0.8B Light",
        sizeLabel: "~560 MB",
        status: "available",
        description: "Fastest option for older PCs. Good for short explanations and simple rewrites."
      },
      {
        id: "qwen35-2b-recommended",
        name: "Qwen3.5 2B Recommended",
        sizeLabel: "~1.3 GB",
        status: "available",
        description: "Better LaTeX fixes, tables, and academic rewriting for most laptops."
      }
    ],
    permissions: local.aiPermissions
  };
}

function aiModels() {
  const state = aiState();
  return Array.isArray(state.models) ? state.models : [];
}

function aiProviders() {
  const state = aiState();
  const byId = new Map();
  const templates = Array.isArray(state.providerTemplates) ? state.providerTemplates : [];
  const serverProviders = Array.isArray(state.providers) ? state.providers : [];
  [...templates, ...serverProviders].forEach((provider) => {
    if (!provider?.id) return;
    byId.set(provider.id, {
      id: provider.id,
      name: provider.name || provider.displayName || provider.id,
      kind: provider.custom ? "custom" : "provider",
      custom: Boolean(provider.custom),
      builtin: Boolean(provider.builtin),
      hasApiKey: Boolean(provider.hasApiKey),
      status: provider.status || (provider.hasApiKey ? "configured" : "not_configured"),
      description: provider.description || provider.baseUrl || "Bring your own key for hosted AI models.",
      baseUrl: provider.baseUrl || provider.url || "",
      models: Array.isArray(provider.models) ? provider.models : [],
      test: provider.test || null
    });
  });
  return [...byId.values()];
}

function isProviderConnected(provider) {
  if (!provider) return false;
  const status = provider.status || "not_configured";
  return Boolean(
    provider.hasApiKey
    || status === "configured"
    || status === "ready"
    || status === "failed"
    || (!provider.builtin && provider.custom)
  );
}

function isProviderEnabled(provider) {
  if (!isProviderConnected(provider)) return false;
  return local.aiProviderEnabled[provider.id] !== false;
}

function setProviderEnabled(providerId, enabled) {
  if (!providerId) return;
  local.aiProviderEnabled[providerId] = Boolean(enabled);
  writeBooleanMap(AI_PROVIDER_ENABLE_STORAGE_KEY, local.aiProviderEnabled);
}

function modelToggleKey(providerId, modelId) {
  return `${providerId || "local"}/${modelId || "default"}`;
}

function isModelEnabled(providerId, modelId) {
  return local.aiModelEnabled[modelToggleKey(providerId, modelId)] !== false;
}

function setModelEnabled(providerId, modelId, enabled) {
  local.aiModelEnabled[modelToggleKey(providerId, modelId)] = Boolean(enabled);
  writeBooleanMap(AI_MODEL_ENABLE_STORAGE_KEY, local.aiModelEnabled);
}

function isProviderModelGroupOpen(providerId) {
  if (!providerId) return true;
  if (local.settingsModelSearch.trim()) return true;
  return local.aiModelGroupOpen[providerId] !== false;
}

function toggleProviderModelGroup(providerId) {
  if (!providerId) return false;
  local.aiModelGroupOpen[providerId] = !isProviderModelGroupOpen(providerId);
  writeBooleanMap(AI_MODEL_GROUP_STORAGE_KEY, local.aiModelGroupOpen);
  return isProviderModelGroupOpen(providerId);
}

function clearProviderModelGroupMotion(panel) {
  if (!panel) return;
  if (panel._localleafModelGroupMotionFrame) {
    cancelAnimationFrame(panel._localleafModelGroupMotionFrame);
    panel._localleafModelGroupMotionFrame = null;
  }
  if (panel._localleafModelGroupMotionTimer) {
    clearTimeout(panel._localleafModelGroupMotionTimer);
    panel._localleafModelGroupMotionTimer = null;
  }
  if (panel._localleafModelGroupMotionEnd) {
    panel.removeEventListener("transitionend", panel._localleafModelGroupMotionEnd);
    panel._localleafModelGroupMotionEnd = null;
  }
  panel.classList.remove("is-revealing", "is-hiding");
}

function providerModelGroupExpandedHeight(panel) {
  const style = getComputedStyle(panel);
  const borderHeight = Number.parseFloat(style.borderTopWidth || "0")
    + Number.parseFloat(style.borderBottomWidth || "0");
  return Math.ceil(panel.scrollHeight + borderHeight);
}

function updateProviderModelGroupDisclosure(button, expanded) {
  const group = button?.closest(".settings-provider-model-group");
  const controlledId = button?.getAttribute("aria-controls") || "";
  const panel = (controlledId && document.getElementById(controlledId))
    || group?.querySelector(".settings-provider-models");
  if (!button || !group || !panel) return;

  const scrollContainer = group.closest(".settings-options");
  const scrollTop = scrollContainer?.scrollTop || 0;
  const preserveFocus = document.activeElement === button;
  const providerName = button.dataset.providerModelName || "Provider";
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  const wasHidden = panel.hidden;
  const currentHeight = wasHidden ? 0 : panel.getBoundingClientRect().height;
  const restoreInteractionContext = () => {
    if (scrollContainer) scrollContainer.scrollTop = scrollTop;
    if (preserveFocus && (!document.activeElement || document.activeElement === document.body)) {
      button.focus({ preventScroll: true });
    }
  };

  clearProviderModelGroupMotion(panel);
  button.classList.toggle("open", expanded);
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  button.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${providerName} models`);
  button.title = `${expanded ? "Collapse" : "Expand"} models`;
  group.classList.toggle("open", expanded);
  group.classList.toggle("collapsed", !expanded);

  if (expanded) {
    panel.hidden = false;
    panel.removeAttribute("inert");
    panel.style.maxHeight = `${currentHeight}px`;
    if (wasHidden) panel.classList.add("is-collapsed");
    if (reducedMotion) {
      panel.classList.remove("is-collapsed");
      panel.style.removeProperty("max-height");
      restoreInteractionContext();
      return;
    }
    let targetHeight = currentHeight;
    panel.classList.add("is-revealing");
    const finishReveal = (event) => {
      if (event?.target && event.target !== panel) return;
      if (event?.propertyName && event.propertyName !== "max-height") return;
      clearProviderModelGroupMotion(panel);
      if (button.getAttribute("aria-expanded") === "true") {
        panel.classList.remove("is-collapsed");
        panel.style.maxHeight = `${targetHeight}px`;
      }
      restoreInteractionContext();
    };
    panel._localleafModelGroupMotionEnd = finishReveal;
    panel.addEventListener("transitionend", finishReveal);
    panel._localleafModelGroupMotionFrame = requestAnimationFrame(() => {
      targetHeight = providerModelGroupExpandedHeight(panel);
      panel._localleafModelGroupMotionFrame = requestAnimationFrame(() => {
        panel._localleafModelGroupMotionFrame = null;
        panel.classList.remove("is-collapsed");
        panel.style.maxHeight = `${targetHeight}px`;
      });
    });
    panel._localleafModelGroupMotionTimer = setTimeout(() => finishReveal(), 560);
    restoreInteractionContext();
    return;
  }

  panel.setAttribute("inert", "");
  panel.style.maxHeight = `${currentHeight}px`;
  const finishHide = (event) => {
    if (event?.target && event.target !== panel) return;
    if (event?.propertyName && event.propertyName !== "max-height") return;
    clearProviderModelGroupMotion(panel);
    if (button.getAttribute("aria-expanded") === "false") {
      panel.classList.add("is-collapsed");
      panel.style.maxHeight = "0px";
      panel.hidden = true;
    }
    restoreInteractionContext();
  };
  if (reducedMotion) {
    panel.classList.add("is-collapsed");
    panel.style.maxHeight = "0px";
    finishHide();
    return;
  }
  panel.classList.add("is-hiding");
  panel._localleafModelGroupMotionEnd = finishHide;
  panel.addEventListener("transitionend", finishHide);
  panel._localleafModelGroupMotionFrame = requestAnimationFrame(() => {
    panel._localleafModelGroupMotionFrame = requestAnimationFrame(() => {
      panel._localleafModelGroupMotionFrame = null;
      panel.classList.add("is-collapsed");
      panel.style.maxHeight = "0px";
    });
  });
  panel._localleafModelGroupMotionTimer = setTimeout(() => finishHide(), 560);
  restoreInteractionContext();
}

function providerModelEntries(provider) {
  return (provider?.models?.length ? provider.models : ["default"]).map((model) => {
    const id = typeof model === "string" ? model : model.id || model.name || "default";
    const name = typeof model === "string" ? model : model.name || model.id || "Default model";
    return {
      id,
      name,
      contextWindowTokens: typeof model === "string" ? null : model.contextWindowTokens || null,
      contextWindow: typeof model === "string" ? null : model.contextWindow || null
    };
  });
}

function connectedAiProviders() {
  return aiProviders().filter(isProviderConnected);
}

function popularAiProviders() {
  return aiProviders().filter((provider) => !isProviderConnected(provider));
}

function modelPickerItems() {
  const localItems = aiModels().filter((model) => modelStatus(model) === "installed" && isModelEnabled("localleaf-local", model.id)).map((model) => ({
    providerId: "localleaf-local",
    modelId: model.id,
    label: model.name || model.id,
    providerName: "Local",
    detail: model.sizeLabel || "Local model",
    contextWindowTokens: model.contextWindowTokens || null,
    contextWindow: model.contextWindow || null
  }));
  if (local.aiPermissions.localModelOnly) return localItems;
  const providerItems = connectedAiProviders().filter(isProviderEnabled).flatMap((provider) => {
    return providerModelEntries(provider).filter((model) => isModelEnabled(provider.id, model.id)).map((model) => {
      return {
        providerId: provider.id,
        modelId: model.id,
        label: model.name,
        providerName: provider.name,
        detail: provider.name,
        contextWindowTokens: model.contextWindowTokens || null,
        contextWindow: model.contextWindow || null
      };
    });
  });
  return [...localItems, ...providerItems];
}

function modelStatus(model) {
  if (model.installed || model.status === "installed" || model.status === "active") return "installed";
  if (model.status === "downloading") return "downloading";
  if (model.status === "paused") return "paused";
  if (model.status === "failed") return "failed";
  return "available";
}

function activeAiProviderModel() {
  const state = aiState();
  const installedLocal = aiModels().find((item) => modelStatus(item) === "installed" && isModelEnabled("localleaf-local", item.id));
  if (local.aiPermissions.localModelOnly) {
    return installedLocal
      ? {
        providerId: "localleaf-local",
        modelId: installedLocal.id,
        providerName: "Local",
        modelName: installedLocal.name,
        label: `Local / ${installedLocal.name}`,
        contextWindowTokens: installedLocal.contextWindowTokens || null,
        contextWindow: installedLocal.contextWindow || null
      }
      : {
        providerId: "localleaf-local",
        modelId: "",
        providerName: "Local",
        modelName: "Fallback",
        label: "Local / Fallback",
        contextWindowTokens: null,
        contextWindow: null
      };
  }
  if (local.activeCursorSdkModelId && aiProviders().some((provider) => provider.id === "cursor" && isProviderConnected(provider))) {
    return {
      providerId: "cursor",
      modelId: local.activeCursorSdkModelId,
      providerName: "Cursor",
      modelName: local.activeCursorSdkModelId === "composer-2" ? "Composer 2" : local.activeCursorSdkModelId,
      label: `Cursor / ${local.activeCursorSdkModelId === "composer-2" ? "Composer 2" : local.activeCursorSdkModelId}`,
      contextWindowTokens: null,
      contextWindow: { mode: "provider_default", effectiveTokens: null }
    };
  }
  if (state.activeModel && typeof state.activeModel === "object") {
    const providerId = state.activeModel.providerId || "local";
    const modelId = state.activeModel.modelId || state.activeModel.id || "";
    const provider = aiProviders().find((item) => item.id === providerId);
    if (!providerId || providerId === "local" || providerId === "localleaf-local" || !provider || (isProviderEnabled(provider) && isModelEnabled(providerId, modelId))) {
      return {
        providerId,
        modelId,
        providerName: state.activeModel.providerName || (state.activeModel.local ? "Local" : "Provider"),
        modelName: state.activeModel.name || state.activeModel.modelId || "No model active",
        label: `${state.activeModel.providerName || (state.activeModel.local ? "Local" : "Provider")} / ${state.activeModel.name || state.activeModel.modelId || "No model active"}`,
        contextWindowTokens: state.activeModel.contextWindowTokens || null,
        contextWindow: state.activeModel.contextWindow || null
      };
    }
  }
  const firstAvailable = modelPickerItems()[0];
  if (firstAvailable) {
    return {
      providerId: firstAvailable.providerId,
      modelId: firstAvailable.modelId,
      providerName: firstAvailable.providerName || firstAvailable.detail || "Provider",
      modelName: firstAvailable.label,
      label: `${firstAvailable.providerName || firstAvailable.detail || "Provider"} / ${firstAvailable.label}`,
      contextWindowTokens: firstAvailable.contextWindowTokens || null,
      contextWindow: firstAvailable.contextWindow || null
    };
  }
  const activeProviderId = state.activeProviderId || "";
  const activeId = state.activeModelId || state.activeModel || "";
  if (activeProviderId) {
    const provider = aiProviders().find((item) => item.id === activeProviderId);
    if (provider && isProviderEnabled(provider) && isModelEnabled(activeProviderId, activeId)) {
      const model = providerModelEntries(provider).find((item) => item.id === activeId);
      const modelName = model?.name || activeId || "Default model";
      return {
        providerId: activeProviderId,
        modelId: activeId,
        providerName: provider?.name || activeProviderId,
        modelName,
        label: `${provider?.name || activeProviderId} / ${modelName}`,
        contextWindowTokens: model?.contextWindowTokens || null,
        contextWindow: model?.contextWindow || { mode: "provider_default", effectiveTokens: null }
      };
    }
  }
  if (installedLocal) {
    return {
      providerId: "localleaf-local",
      modelId: installedLocal.id,
      providerName: "Local",
      modelName: installedLocal.name,
      label: `Local / ${installedLocal.name}`,
      contextWindowTokens: installedLocal.contextWindowTokens || null,
      contextWindow: installedLocal.contextWindow || null
    };
  }
  return {
    providerId: "",
    modelId: "",
    providerName: "No provider",
    modelName: "Connect model",
    label: "No model active",
    contextWindowTokens: null,
    contextWindow: null
  };
}

function activeAiModelName() {
  return activeAiProviderModel().label;
}

function aiPendingCount() {
  return aiHistoryItems().filter((proposal) => ["pending", "proposed"].includes(proposal.status)).length;
}

function aiHistoryItems() {
  const fromMessages = local.aiMessages.flatMap((message) => message.proposals || []);
  const byId = new Map();
  [...fromMessages, ...local.aiChangeHistory].forEach((proposal) => {
    if (proposal?.id) byId.set(proposal.id, proposal);
  });
  return [...byId.values()].reverse();
}

function formatAiTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function syncAiProposalsFromAppState() {
  const proposals = Array.isArray(local.appState?.ai?.proposals) ? local.appState.ai.proposals : [];
  proposals.forEach((proposal) => {
    if (!proposal?.id) return;
    const existing = findAiProposal(proposal.id);
    const merged = { ...(existing || {}), ...proposal, sessionId: existing?.sessionId || proposal.sessionId || local.aiCurrentSessionId };
    local.aiMessages.forEach((message) => {
      const index = (message.proposals || []).findIndex((item) => item.id === proposal.id);
      if (index >= 0) message.proposals[index] = { ...message.proposals[index], ...merged };
    });
    rememberAiProposal(merged);
  });
}

function currentAiSession() {
  let session = local.aiSessions.find((item) => item.id === local.aiCurrentSessionId);
  if (!session) {
    session = createAiSession();
    local.aiSessions.unshift(session);
    local.aiCurrentSessionId = session.id;
  }
  return session;
}

function sessionPreviewFromMessages(messages = []) {
  const last = [...messages].reverse().find((message) => message?.id !== "welcome" && message?.message);
  return last ? String(last.message || "").replace(/\s+/g, " ").trim().slice(0, 120) : "Ready to help with this project.";
}

function firstUserPrompt(messages = []) {
  return messages.find((message) => message.role === "user")?.message || "";
}

function aiSessionTitleFromPrompt(prompt = "") {
  const clean = String(prompt || "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 42) : "New session";
}

function aiSessionSavePayload(session = currentAiSession()) {
  const active = activeAiProviderModel();
  return {
    projectKey: local.aiSessionsProjectKey || "",
    sessionId: session.id,
    providerId: active.providerId || "",
    providerName: active.providerName || "",
    modelId: active.modelId || "",
    modelName: active.modelName || "",
    permissionMode: local.aiPermissions.yoloMode ? "yolo" : "default",
    changeCount: aiHistoryItems().filter((proposal) => proposal.sessionId === session.id).length,
    activate: false
  };
}

function syncAiSessionLocalsFromReducer() {
  const stateApi = window.LocalLeafAiSessionState;
  if (stateApi && local.aiSessionState) {
    const state = local.aiSessionState;
    const activeDetail = stateApi.activeSession(state);
    local.aiSessions = state.sessionOrder.map((id) => {
      const summary = stateApi.sessionById(state, id) || { id };
      return normalizeAiSession({
        ...summary,
        messages: id === state.currentSessionId && Array.isArray(activeDetail?.messages)
          ? activeDetail.messages
          : []
      });
    });
    local.aiCurrentSessionId = state.currentSessionId;
    local.aiSessionsProjectKey = state.projectKey;
    local.aiSessionsProjectName = state.projectName || local.appState?.project?.name || "";
    const messages = Array.isArray(activeDetail?.messages) ? activeDetail.messages : [];
    local.aiMessages = (messages.length ? messages : [createAiWelcomeMessage()]).map((message) => ({ ...message }));
    return true;
  }
  return false;
}

function reduceAiSessionState(event) {
  const stateApi = window.LocalLeafAiSessionState;
  if (!stateApi || !local.aiSessionState) return;
  local.aiSessionState = stateApi.reduce(local.aiSessionState, event);
  syncAiSessionLocalsFromReducer();
}

function invalidateAiSessionProjectRequests(nextProjectKey) {
  const projectKey = String(nextProjectKey || "");
  if (!projectKey || projectKey === local.aiSessionsProjectKey) return false;
  local.aiSessionProjectRequestGeneration += 1;
  local.aiSessionActivationRequestId += 1;
  local.aiSessionCreating = false;
  local.aiSessionCreateError = "";
  local.aiSessionSwitchTargetId = "";
  local.aiSessionNewId = "";
  local.aiSessionRenamingId = "";
  local.aiSessionRenameValue = "";
  local.aiSessionRenameError = "";
  local.aiSessionDeleteId = "";
  local.aiSessionDeletingId = "";
  local.aiTranscriptSwitching = false;
  local.aiSessionMenuOpen = false;
  local.aiSessionMoreMenuOpen = false;
  local.aiSessionActionMenuId = "";
  local.aiQueuedPrompts = [];
  local.aiQueuedPromptMenuOpenId = "";
  local.aiEditingQueuedPromptId = "";
  return true;
}

function captureAiSessionProjectRequest() {
  return {
    projectKey: String(local.aiSessionsProjectKey || ""),
    generation: local.aiSessionProjectRequestGeneration
  };
}

function aiSessionProjectRequestIsCurrent(origin, sessionState = null) {
  const projectKey = String(origin?.projectKey || "");
  const responseProjectKey = sessionState == null ? projectKey : String(sessionState?.projectKey || "");
  return Boolean(
    projectKey
    && origin?.generation === local.aiSessionProjectRequestGeneration
    && projectKey === local.aiSessionsProjectKey
    && responseProjectKey === projectKey
  );
}

function applyAiSessionState(sessionState = {}, options = {}) {
  const incomingProjectKey = String(sessionState?.projectKey || "");
  const currentProjectKey = String(local.aiSessionsProjectKey || "");
  const allowProjectChange = options.allowProjectChange === true;
  if (!allowProjectChange && incomingProjectKey !== currentProjectKey) return false;
  if (allowProjectChange && incomingProjectKey && incomingProjectKey !== currentProjectKey) {
    invalidateAiSessionProjectRequests(incomingProjectKey);
  }
  const stateApi = window.LocalLeafAiSessionState;
  if (stateApi) {
    local.aiSessionState = local.aiSessionState
      ? stateApi.reduce(local.aiSessionState, {
        type: "SNAPSHOT_APPLIED",
        snapshot: sessionState,
        allowProjectChange
      })
      : stateApi.createState(sessionState);
    syncAiSessionLocalsFromReducer();
    return true;
  }
  const sessions = Array.isArray(sessionState.sessions) ? sessionState.sessions.map(normalizeAiSession) : [];
  const fallback = fallbackAiSessionState();
  local.aiSessions = sessions.length ? sessions : fallback.sessions;
  local.aiCurrentSessionId = local.aiSessions.some((session) => session.id === sessionState.currentSessionId)
    ? sessionState.currentSessionId
    : local.aiSessions[0].id;
  local.aiSessionsProjectKey = sessionState.projectKey || "";
  local.aiSessionsProjectName = sessionState.projectName || local.appState?.project?.name || "";
  const active = currentAiSession();
  local.aiMessages = (active.messages?.length ? active.messages : [createAiWelcomeMessage()]).map((message) => ({ ...message }));
  return true;
}

function applyAiSessionStatePreservingActive(sessionState = {}, options = {}) {
  const currentId = local.aiCurrentSessionId;
  const keepsCurrent = Array.isArray(sessionState.sessions)
    && sessionState.sessions.some((session) => session.id === currentId);
  if (!keepsCurrent) {
    return applyAiSessionState(sessionState, options);
  }
  const current = currentAiSession();
  return applyAiSessionState({
    ...sessionState,
    currentSessionId: currentId,
    activeSession: {
      ...current,
      messages: (current.messages || local.aiMessages || []).map((message) => ({ ...message }))
    }
  }, options);
}

function announceAi(message) {
  local.aiAnnouncement = String(message || "");
}

function syncAiSessionsFromAppState() {
  const sessionState = local.appState?.ai?.sessions;
  if (sessionState && Array.isArray(sessionState.sessions)) {
    applyAiSessionState(sessionState, { allowProjectChange: true });
    const hasActiveDetail = local.aiSessionState?.activeDetail?.id === local.aiSessionState?.currentSessionId;
    if (!sessionState.activeSession && !hasActiveDetail && (local.hostToken || local.guestToken)) {
      setTimeout(() => refreshAiSessionsFromHost({ render: route().view === "editor" }), 0);
    }
  }
}

async function refreshAiSessionsFromHost(options = {}) {
  if (!local.hostToken && !local.guestToken) return;
  const projectRequest = captureAiSessionProjectRequest();
  try {
    const sessionState = await api("/api/ai/sessions");
    if (!aiSessionProjectRequestIsCurrent(projectRequest, sessionState)) return;
    applyAiSessionState(sessionState);
    if (options.render !== false) refreshRightRailUi();
  } catch {
    // Keep the in-memory session state if the host endpoint is temporarily unavailable.
  }
}

async function importLegacyAiSessionsForProject() {
  if (isGuestClient() || !local.hostToken || !local.aiSessionsProjectKey) return;
  const projectRequest = captureAiSessionProjectRequest();
  const rawMigrationState = localStorage.getItem(AI_SESSIONS_MIGRATION_STORAGE_KEY) || "";
  let migrated = {};
  try {
    migrated = JSON.parse(rawMigrationState || "{}");
  } catch {
    migrated = {};
  }
  if (rawMigrationState === "1" || migrated.global === true || migrated[local.aiSessionsProjectKey]) return;
  const legacy = readLegacyAiSessionState();
  const hasLegacyMessages = legacy.sessions.some((session) => (session.messages || []).some((message) => message.id !== "welcome"));
  if (!hasLegacyMessages) {
    localStorage.setItem(AI_SESSIONS_MIGRATION_STORAGE_KEY, "1");
    return;
  }
  try {
    const imported = await api("/api/ai/sessions/import-legacy", {
      method: "POST",
      body: {
        projectKey: projectRequest.projectKey,
        sessions: legacy.sessions,
        currentSessionId: legacy.currentSessionId
      }
    });
    if (!aiSessionProjectRequestIsCurrent(projectRequest, imported)) return;
    applyAiSessionState(imported);
    localStorage.setItem(AI_SESSIONS_MIGRATION_STORAGE_KEY, "1");
  } catch {
    // Leave the legacy state untouched so a later run can import it.
  }
}

function saveAiSessions() {
  if (!local.hostToken && !local.guestToken) return;
  const payload = aiSessionSavePayload();
  const projectRequest = captureAiSessionProjectRequest();
  if (!projectRequest.projectKey) return;
  api("/api/ai/sessions/update", { method: "POST", body: payload })
    .then((sessionState) => {
      if (aiSessionProjectRequestIsCurrent(projectRequest, sessionState)) applyAiSessionState(sessionState);
    })
    .catch(() => {});
}

function syncCurrentAiSession(titleHint = "") {
  const session = currentAiSession();
  local.aiChangeHistory.forEach((proposal) => {
    if (proposal?.id && !proposal.sessionId) proposal.sessionId = session.id;
  });
  return session;
}

async function startNewAiSession() {
  if (local.aiSessionCreating || local.aiSessions.length >= 30) return;
  const projectRequest = captureAiSessionProjectRequest();
  if (!projectRequest.projectKey) return;
  const requestId = ++local.aiSessionActivationRequestId;
  local.aiSessionCreating = true;
  local.aiSessionCreateError = "";
  local.aiSessionMoreMenuOpen = false;
  local.aiSessionActionMenuId = "";
  local.aiForceScrollBottom = true;
  local.aiChatNeedsJump = false;
  announceAi("Creating a new AI session.");
  refreshRightRailUi();
  try {
    const sessionState = await api("/api/ai/sessions/create", {
      method: "POST",
      body: { projectKey: projectRequest.projectKey }
    });
    if (
      requestId === local.aiSessionActivationRequestId
      && aiSessionProjectRequestIsCurrent(projectRequest, sessionState)
    ) {
      applyAiSessionState(sessionState);
      local.aiSessionNewId = sessionState.currentSessionId;
      local.aiSessionMenuOpen = false;
      announceAi("New AI session created.");
      setTimeout(() => {
        if (local.aiSessionNewId === sessionState.currentSessionId) local.aiSessionNewId = "";
      }, 200);
      setTimeout(() => document.querySelector("#aiPrompt")?.focus(), 0);
    }
  } catch (error) {
    if (requestId === local.aiSessionActivationRequestId && aiSessionProjectRequestIsCurrent(projectRequest)) {
      local.aiSessionCreateError = error.message || "Could not create a new session.";
      local.aiSessionMenuOpen = true;
      announceAi(local.aiSessionCreateError);
    }
  } finally {
    if (aiSessionProjectRequestIsCurrent(projectRequest)) local.aiSessionCreating = false;
  }
  refreshRightRailUi();
}

async function switchAiSession(sessionId) {
  const session = local.aiSessions.find((item) => item.id === sessionId);
  if (!session) return;
  const projectRequest = captureAiSessionProjectRequest();
  if (!projectRequest.projectKey) return;
  const requestId = ++local.aiSessionActivationRequestId;
  local.aiSessionMenuOpen = false;
  local.aiSessionMoreMenuOpen = false;
  local.aiSessionActionMenuId = "";
  local.aiForceScrollBottom = true;
  local.aiChatNeedsJump = false;
  if (session.id === local.aiCurrentSessionId && !local.aiSessionCreating) {
    refreshRightRailUi();
    setTimeout(() => document.querySelector("#aiPrompt")?.focus(), 0);
    return;
  }
  local.aiSessionSwitchTargetId = session.id;
  local.aiTranscriptSwitching = true;
  refreshRightRailUi();
  try {
    const sessionState = await api("/api/ai/sessions/activate", {
      method: "POST",
      body: { projectKey: projectRequest.projectKey, sessionId: session.id }
    });
    if (
      requestId !== local.aiSessionActivationRequestId
      || !aiSessionProjectRequestIsCurrent(projectRequest, sessionState)
    ) return;
    applyAiSessionState(sessionState);
    announceAi(`Switched to ${session.title || "AI session"}.`);
    refreshRightRailUi();
  } catch (error) {
    if (requestId === local.aiSessionActivationRequestId && aiSessionProjectRequestIsCurrent(projectRequest)) {
      announceAi(error.message || "Could not switch AI sessions.");
      showAppNotice(error.message || "Could not switch AI sessions.", { type: "error", title: "AI sessions" });
    }
  }
  const motionDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 120;
  setTimeout(() => {
    if (requestId !== local.aiSessionActivationRequestId || !aiSessionProjectRequestIsCurrent(projectRequest)) return;
    local.aiTranscriptSwitching = false;
    local.aiSessionSwitchTargetId = "";
    refreshRightRailUi();
    document.querySelector("#aiPrompt")?.focus();
  }, motionDelay);
}

function requestDeleteAiSession(sessionId) {
  const targetId = String(sessionId || "");
  if (!targetId) return;
  const target = local.aiSessions.find((session) => session.id === targetId);
  if (!target) return;
  local.aiSessionActionMenuId = "";
  const queuedCount = local.aiQueuedPrompts.filter((item) => item.sessionId === targetId).length;
  if (queuedCount) {
    announceAi("Remove this session's queued messages before deleting it.");
    refreshRightRailUi();
    return;
  }
  const untouchedBlank = Number(target.messageCount || 0) === 0
    && Number(target.changeCount || 0) === 0
    && !target.parentSessionId
    && target.titleSource !== "manual"
    && (target.title || "New session") === "New session";
  if (!untouchedBlank) {
    local.aiSessionDeleteId = targetId;
    local.aiSessionMenuOpen = false;
    refreshRightRailUi();
    setTimeout(() => document.querySelector("#aiSessionDeleteCancel")?.focus(), 0);
    return;
  }
  deleteAiSession(targetId);
}

function toggleAiSessionActions(sessionId) {
  const id = String(sessionId || "");
  if (!id) return;
  local.aiSessionActionMenuId = local.aiSessionActionMenuId === id ? "" : id;
  refreshRightRailUi();
  if (local.aiSessionActionMenuId) {
    setTimeout(() => document.querySelector("#aiSessionActionsMenu button:not(:disabled)")?.focus(), 0);
  } else {
    setTimeout(() => document.querySelector(`.ai-session-row[data-session-id="${CSS.escape(id)}"] .ai-session-row-main`)?.focus(), 0);
  }
}

async function deleteAiSession(sessionId) {
  const targetId = String(sessionId || "");
  const target = local.aiSessions.find((session) => session.id === targetId);
  if (!target || local.aiSessionDeletingId) return;
  const projectRequest = captureAiSessionProjectRequest();
  if (!projectRequest.projectKey) return;
  const activationRequestId = ++local.aiSessionActivationRequestId;
  local.aiSessionDeleteId = "";
  local.aiSessionDeletingId = targetId;
  let deleted = false;
  refreshRightRailUi();
  try {
    const sessionState = await api("/api/ai/sessions/delete", {
      method: "POST",
      body: {
        projectKey: projectRequest.projectKey,
        sessionId: targetId,
        expectedRevision: target.revision
      }
    });
    const motionDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 120;
    await new Promise((resolve) => setTimeout(resolve, motionDelay));
    if (!aiSessionProjectRequestIsCurrent(projectRequest, sessionState)) return;
    if (activationRequestId === local.aiSessionActivationRequestId) {
      applyAiSessionState(sessionState);
      local.aiSessionMenuOpen = true;
      local.aiSessionMoreMenuOpen = false;
      local.aiSessionActionMenuId = "";
      local.aiForceScrollBottom = true;
      local.aiChatNeedsJump = false;
    } else {
      applyAiSessionStatePreservingActive(sessionState);
    }
    deleted = true;
    announceAi(`Deleted ${target.title || "AI session"}.`);
  } catch (error) {
    if (!aiSessionProjectRequestIsCurrent(projectRequest)) return;
    announceAi(error.message || "Could not delete the AI session.");
    showAppNotice(error.message || "Could not delete the AI session.", { type: "error", title: "AI sessions" });
  } finally {
    if (aiSessionProjectRequestIsCurrent(projectRequest) && local.aiSessionDeletingId === targetId) {
      local.aiSessionDeletingId = "";
    }
  }
  refreshRightRailUi();
  if (deleted) {
    setTimeout(() => {
      (document.querySelector(".ai-session-row.active .ai-session-row-main") || document.querySelector("#aiSessionMenuButton"))?.focus();
    }, 0);
  }
}

function beginRenameAiSession(sessionId = local.aiCurrentSessionId) {
  const session = local.aiSessions.find((item) => item.id === sessionId);
  if (!session) return;
  local.aiSessionRenamingId = session.id;
  local.aiSessionRenameValue = session.title || "New session";
  local.aiSessionRenameError = "";
  local.aiSessionActionMenuId = "";
  refreshRightRailUi();
  setTimeout(() => {
    const input = document.querySelector("#aiSessionRenameInput");
    input?.focus();
    input?.select();
  }, 0);
}

function cancelAiSessionRename() {
  const sessionId = local.aiSessionRenamingId;
  local.aiSessionRenamingId = "";
  local.aiSessionRenameValue = "";
  local.aiSessionRenameError = "";
  refreshRightRailUi();
  setTimeout(() => document.querySelector(`.ai-session-row[data-session-id="${CSS.escape(sessionId)}"] .ai-session-row-main`)?.focus(), 0);
}

async function renameAiSession(sessionId = local.aiCurrentSessionId, value = local.aiSessionRenameValue) {
  const session = local.aiSessions.find((item) => item.id === sessionId);
  const activationRequestId = local.aiSessionActivationRequestId;
  const clean = String(value || "").replace(/\s+/g, " ").trim().slice(0, 64);
  if (!session || !clean) {
    local.aiSessionRenameError = "Enter a session name.";
    refreshRightRailUi();
    setTimeout(() => document.querySelector("#aiSessionRenameInput")?.focus(), 0);
    return;
  }
  const projectRequest = captureAiSessionProjectRequest();
  if (!projectRequest.projectKey) return;
  try {
    const sessionState = await api("/api/ai/sessions/rename", {
      method: "POST",
      body: {
        projectKey: projectRequest.projectKey,
        sessionId: session.id,
        title: clean,
        expectedRevision: session.revision
      }
    });
    if (!aiSessionProjectRequestIsCurrent(projectRequest, sessionState)) return;
    if (activationRequestId === local.aiSessionActivationRequestId) applyAiSessionState(sessionState);
    else applyAiSessionStatePreservingActive(sessionState);
    local.aiSessionRenamingId = "";
    local.aiSessionRenameValue = "";
    local.aiSessionRenameError = "";
    announceAi(`Renamed session to ${clean}.`);
    setTimeout(() => document.querySelector(`.ai-session-row[data-session-id="${CSS.escape(sessionId)}"] .ai-session-row-main`)?.focus(), 0);
  } catch (error) {
    if (!aiSessionProjectRequestIsCurrent(projectRequest)) return;
    local.aiSessionRenameError = error.message || "Could not rename the session.";
    announceAi(local.aiSessionRenameError);
    setTimeout(() => document.querySelector("#aiSessionRenameInput")?.focus(), 0);
  }
  refreshRightRailUi();
}

function renameCurrentAiSession() {
  beginRenameAiSession(local.aiCurrentSessionId);
}

async function forkAiSession(sessionId = local.aiCurrentSessionId) {
  const session = local.aiSessions.find((item) => item.id === sessionId);
  if (!session) return;
  const projectRequest = captureAiSessionProjectRequest();
  if (!projectRequest.projectKey) return;
  const activationRequestId = ++local.aiSessionActivationRequestId;
  try {
    const sessionState = await api("/api/ai/sessions/fork", {
      method: "POST",
      body: {
        projectKey: projectRequest.projectKey,
        sessionId,
        expectedRevision: session.revision
      }
    });
    if (!aiSessionProjectRequestIsCurrent(projectRequest, sessionState)) return;
    if (activationRequestId === local.aiSessionActivationRequestId) applyAiSessionState(sessionState);
    else applyAiSessionStatePreservingActive(sessionState);
    announceAi(`Forked ${session.title || "AI session"}.`);
  } catch (error) {
    if (!aiSessionProjectRequestIsCurrent(projectRequest)) return;
    showAppNotice(error.message || "Could not fork session.", { type: "error", title: "AI sessions" });
    announceAi(error.message || "Could not fork the AI session.");
  }
  local.aiSessionMenuOpen = false;
  local.aiSessionMoreMenuOpen = false;
  local.aiSessionActionMenuId = "";
  local.aiForceScrollBottom = true;
  local.aiChatNeedsJump = false;
  refreshRightRailUi();
}

function setAiQueueingEnabled(enabled) {
  local.aiQueueingEnabled = Boolean(enabled);
  localStorage.setItem("localleaf.aiQueueingEnabled", local.aiQueueingEnabled ? "1" : "0");
}


function collabUrl() {
  const params = new URLSearchParams({ client: clientId });
  if (local.guestToken) params.set("token", local.guestToken);
  if (local.hostToken) params.set("host", local.hostToken);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/collab?${params.toString()}`;
}

function isLiveSession() {
  return local.appState?.session?.status === "live";
}

function isGuestClient() {
  return Boolean(local.guestToken);
}

function currentSessionGuest() {
  if (!isGuestClient()) return null;
  const users = Array.isArray(local.appState?.session?.users) ? local.appState.session.users : [];
  return users.find((user) => user.id === local.userId && user.role !== "host")
    || users.find((user) => user.name === local.userName && user.role !== "host")
    || null;
}

function effectiveSessionRole() {
  if (!isGuestClient()) return "host";
  return currentSessionGuest()?.role === "maintainer" ? "maintainer" : "viewer";
}

function canMutateProject() {
  return !isGuestClient() || effectiveSessionRole() === "maintainer";
}

function requireProjectMutationAccess(action = "change project files") {
  if (canMutateProject()) return true;
  showAppNotice(`Viewer access cannot ${action}.`, {
    title: "Read-only access",
    detail: "Ask the host to change your role to Maintainer. You can still read the source, PDF, and chat."
  });
  return false;
}

function synchronizeEditorAccessRole(options = {}) {
  if (route().view !== "editor" || !isGuestClient()) return false;
  const role = effectiveSessionRole();
  const renderedRole = options.renderedRole
    || document.querySelector(".editor-shell")?.dataset.accessRole
    || "";
  if (renderedRole === role && !local.sessionAccessRoleTarget) return false;
  if (local.sessionAccessRoleTarget === role) return true;

  const discardedLocalDraft = role === "viewer" && ["Unsaved", "Saving..."].includes(local.saveStatus);
  local.sessionAccessRoleTarget = role;
  if (role === "viewer") {
    clearTimeout(local.saveTimer);
    local.saveTimer = null;
    local.pendingSave = false;
    settlePendingCollabSaves(false);
    local.saveStatus = "Read only";
  }
  if (options.announce) {
    showAppNotice(
      role === "maintainer" ? "You can now edit this project." : "Your access is now read only.",
      {
        type: "success",
        title: role === "maintainer" ? "Maintainer access" : "Viewer access",
        detail: role === "maintainer"
          ? "File tools and the AI Helper are available without reconnecting."
          : discardedLocalDraft
            ? "Your unsaved local draft was not shared. The host version is being restored."
            : "You can continue reading the source, PDF, and chat."
      }
    );
  }

  void (async () => {
    if (role === "viewer" && local.selectedFile) {
      try {
        await loadSelectedFile();
        local.saveStatus = "Read only";
      } catch {
        // A later state update can still restore the selected file if it moved concurrently.
      }
    }
    if (route().view === "editor" && effectiveSessionRole() === role) {
      await render();
    }
    if (local.sessionAccessRoleTarget === role) local.sessionAccessRoleTarget = "";
  })();
  return true;
}

function connectCollab() {
  if (!isLiveSession()) {
    closeCollab();
    return;
  }
  if (local.collabSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(local.collabSocket.readyState)) {
    return;
  }
  clearTimeout(local.collabReconnectTimer);
  const socket = new WebSocket(collabUrl());
  local.collabSocket = socket;

  socket.addEventListener("open", () => {
    clearTimeout(local.collabLostTimer);
    local.collabLostTimer = null;
    clearTimeout(local.eventDisconnectTimer);
    local.eventDisconnectTimer = null;
    clearInterval(local.collabHeartbeatTimer);
    clearRemoteReconnectNotice();
    sendCollab("heartbeat");
    local.collabHeartbeatTimer = setInterval(() => sendCollab("heartbeat"), 5000);
    if (local.selectedFile) {
      sendCollab("open_file", { filePath: local.selectedFile });
    }
  });

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleCollabMessage(payload);
  });

  socket.addEventListener("close", () => {
    clearInterval(local.collabHeartbeatTimer);
    local.collabHeartbeatTimer = null;
    settlePendingCollabSaves(false);
    if (route().view === "editor" && local.appState?.session?.status !== "ended") {
      clearTimeout(local.collabLostTimer);
      local.collabLostTimer = setTimeout(async () => {
        const socketOpen = local.collabSocket?.readyState === WebSocket.OPEN;
        if (route().view === "editor" && !socketOpen) {
          try {
            await loadState();
            if (local.appState?.session?.status === "ended") {
              handleSessionEnded("The host has ended the session.");
              return;
            }
          } catch {
            // Keep the editor open while the public tunnel reconnects.
          }
          showRemoteReconnectNotice("The live editor connection is reconnecting.");
        }
      }, 8000);
      local.collabReconnectTimer = setTimeout(connectCollab, 1200);
    }
  });
}

function sendCollab(type, payload = {}) {
  if (!local.collabSocket || local.collabSocket.readyState !== WebSocket.OPEN) return false;
  local.collabSocket.send(JSON.stringify({ type, ...payload }));
  return true;
}

function settlePendingCollabSaves(saved = false) {
  for (const pending of local.pendingCollabSaves.values()) {
    clearTimeout(pending.timer);
    pending.resolve(saved);
  }
  local.pendingCollabSaves.clear();
}

function requestCollabSave(filePath, newText = local.editorContent, timeoutMs = 5000) {
  const requestId = `${clientId}-${Date.now()}-${++local.collabSaveSequence}`;
  return new Promise((resolve) => {
    const finish = (saved) => {
      const pending = local.pendingCollabSaves.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      local.pendingCollabSaves.delete(requestId);
      resolve(saved);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    local.pendingCollabSaves.set(requestId, { resolve, timer, filePath });
    if (!sendCollab("save", { filePath, requestId, newText })) finish(false);
  });
}

function closeCollab() {
  clearTimeout(local.collabReconnectTimer);
  clearTimeout(local.collabLostTimer);
  clearInterval(local.collabHeartbeatTimer);
  local.collabReconnectTimer = null;
  local.collabLostTimer = null;
  local.collabHeartbeatTimer = null;
  settlePendingCollabSaves(false);
  if (local.collabSocket) {
    local.collabSocket.close();
    local.collabSocket = null;
  }
}

function destroyCodeEditor() {
  if (!local.codeEditor) return;
  local.codeEditor.destroy();
  local.codeEditor = null;
}

function destroyVisualEditor() {
  if (!local.visualEditor) return;
  local.visualEditor.destroy();
  local.visualEditor = null;
}

function destroyEditorSurfaces(options = {}) {
  const previewPane = document.querySelector("#previewPane");
  if (previewPane && options.cancelPdfPreview !== false) window.LocalLeafPdfPreview?.cancel?.(previewPane);
  if (options.cancelPdfSourceNavigation !== false) local.pdfSourceNavigator?.cancel?.();
  if (options.cancelPdfReviewNavigation !== false) local.aiReviewNavigator?.cancel?.();
  destroyCodeEditor();
  destroyVisualEditor();
}

function endedViewParams() {
  const extra = {};
  if (local.guestToken) extra.token = local.guestToken;
  if (local.userName && local.userName !== "Host") extra.name = local.userName;
  return extra;
}

function handleSessionEnded(reason, detail) {
  local.sessionEndedReason = reason || "The host has ended the session.";
  local.sessionEndedDetail = detail || "Ask the host to start it again.";
  if (local.appState?.session) {
    local.appState.session.status = "ended";
    local.appState.session.inviteUrl = null;
  }
  clearTimeout(local.eventDisconnectTimer);
  local.eventDisconnectTimer = null;
  closeCollab();
  setView("ended", endedViewParams());
}

function handleAccessRevoked(reason, userId = "") {
  if (userId && local.userId && userId !== local.userId) return;
  local.guestToken = "";
  local.userId = "";
  sessionStorage.removeItem("localleaf.guestToken");
  handleSessionEnded(
    reason || "The host removed your access.",
    "This invite no longer gives access. Ask the host for a new invitation if you need to return."
  );
}

function showRemoteReconnectNotice(message) {
  if (!isGuestClient() && !local.joinRequestId) return;
  showAppNotice(message || "Trying to reconnect to the host.", {
    kind: "remote-reconnect",
    title: "Reconnecting",
    detail: "This session will stay open unless the host ends it.",
    timeoutMs: 0
  });
}

function clearRemoteReconnectNotice() {
  if (local.appNotice?.kind !== "remote-reconnect") return;
  clearTimeout(local.appNoticeTimer);
  local.appNoticeTimer = null;
  local.appNotice = null;
  renderAppNotice();
}

function applyRemoteText(filePath, text) {
  if (filePath !== local.selectedFile) return;
  if (text === local.editorContent) return;
  local.applyingRemoteEdit = true;
  local.editorContent = text;
  if (local.codeEditor) local.codeEditor.applyRemoteText(text);
  else if (local.visualEditor) local.visualEditor.applyRemoteText(text);
  else {
    const textarea = document.querySelector("#editorText");
    if (textarea && "value" in textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = text;
      const nextStart = Math.min(start, text.length);
      const nextEnd = Math.min(end, text.length);
      textarea.setSelectionRange(nextStart, nextEnd);
    }
  }
  const status = document.querySelector(".editor-subtitle");
  local.saveStatus = "Synced";
  if (status) status.textContent = local.saveStatus;
  local.applyingRemoteEdit = false;
}

function handleCollabMessage(payload) {
  if (payload.type === "sync_state") {
    const renderedRole = document.querySelector(".editor-shell")?.dataset.accessRole || "";
    if (payload.state) local.appState = payload.state;
    if (payload.userId) local.userId = payload.userId;
    local.collabPresence = payload.presence || [];
    if (!local.selectedFile && payload.filePath) {
      local.selectedFile = payload.filePath;
      expandToFile(payload.filePath);
    }
    if (payload.filePath === local.selectedFile && typeof payload.newText === "string") {
      applyRemoteText(payload.filePath, payload.newText);
    }
    synchronizeEditorAccessRole({ renderedRole });
    updateUsersPresenceUi();
    return;
  }

  if (payload.type === "file_opened") {
    if (payload.filePath === local.selectedFile && typeof payload.newText === "string") {
      applyRemoteText(payload.filePath, payload.newText);
    }
    return;
  }

  if (payload.type === "file_updated") {
    if (payload.userId && payload.userId === local.userId) return;
    applyRemoteText(payload.filePath, payload.newText || "");
    return;
  }

  if (payload.type === "file_saved") {
    const pendingSave = local.pendingCollabSaves.get(payload.requestId);
    if (pendingSave && payload.userId === local.userId) {
      clearTimeout(pendingSave.timer);
      local.pendingCollabSaves.delete(payload.requestId);
      pendingSave.resolve(true);
    }
    if (payload.filePath === local.selectedFile) {
      local.saveStatus = payload.userId === local.userId ? "Saved" : `Saved by ${payload.name || "collaborator"}`;
      const status = document.querySelector(".editor-subtitle");
      if (status) status.textContent = local.saveStatus;
    }
    return;
  }

  if (payload.type === "error" && payload.requestId) {
    const pendingSave = local.pendingCollabSaves.get(payload.requestId);
    if (pendingSave) {
      clearTimeout(pendingSave.timer);
      local.pendingCollabSaves.delete(payload.requestId);
      pendingSave.resolve(false);
    }
    return;
  }

  if (payload.type === "presence_update") {
    local.collabPresence = Array.isArray(payload.presence) ? payload.presence : [];
    const onlineUserIds = new Set(local.collabPresence.map((item) => item?.userId).filter(Boolean));
    if (Array.isArray(local.appState?.session?.users)) {
      local.appState.session.users = local.appState.session.users.map((user) => (
        user.role === "host" ? user : { ...user, online: onlineUserIds.has(user.id) }
      ));
    }
    updateUsersPresenceUi();
    return;
  }

  if (payload.type === "role_changed") {
    if (payload.userId && payload.userId !== local.userId) return;
    const role = payload.role === "maintainer" ? "maintainer" : "viewer";
    if (Array.isArray(local.appState?.session?.users)) {
      local.appState.session.users = local.appState.session.users.map((user) => (
        user.id === (payload.userId || local.userId) ? { ...user, role } : user
      ));
    }
    synchronizeEditorAccessRole({ announce: true });
    return;
  }

  if (payload.type === "access_revoked") {
    handleAccessRevoked(payload.reason, payload.userId);
    return;
  }

  if (payload.type === "state_update" && payload.state) {
    const renderedRole = document.querySelector(".editor-shell")?.dataset.accessRole || "";
    local.appState = payload.state;
    const selectedFileMissing = Boolean(local.selectedFile)
      && !(local.appState?.project?.files || []).some((file) => file.path === local.selectedFile);
    if (isGuestClient() && local.appState?.session?.status === "ended") {
      handleSessionEnded("The host has ended the session.");
      return;
    }
    syncAiProposalsFromAppState();
    synchronizeEditorAccessRole({ renderedRole, announce: true });
    if (selectedFileMissing) {
      clearTimeout(local.saveTimer);
      local.saveTimer = null;
      void openSurvivingProjectFile();
      showAppNotice("The file that was open is no longer in the project. LocalLeaf opened a surviving source file instead.", {
        type: "warning",
        title: "File removed"
      });
    }
    if (route().view === "editor") {
      (Array.isArray(local.appState?.session?.joinRequests) ? local.appState.session.joinRequests : [])
        .filter((request) => request.status === "pending")
        .forEach(showEditorJoinRequest);
      updateSidebarUi();
      refreshRightRailUi();
      updateUsersPresenceUi();
    }
    return;
  }

  if (payload.type === "project_event") {
    if (payload.event === "compile" && local.appState && shouldApplyCompileUpdate(payload.payload)) {
      local.appState.compile = payload.payload;
      if (route().view === "editor") {
        const refreshPreview = local.appState.compile.status !== "running";
        updateCompileUi({ refreshPreview, previewScroll: refreshPreview ? local.pendingPreviewScroll : null });
        if (refreshPreview) local.pendingPreviewScroll = null;
      }
    }
    if (payload.event === "chat" && local.appState && payload.payload) {
      const existing = local.appState.chat.some((message) => message.id === payload.payload.id);
      if (!existing) local.appState.chat.push(payload.payload);
      if (route().view === "editor") updateChatPanel();
    }
    return;
  }

  if (payload.type === "session_ended") {
    if (isGuestClient() || isLiveSession()) {
      handleSessionEnded(payload.reason || "The host stopped the session.");
    }
  }
}

function setView(view, extra = {}) {
  const previousView = route().view;
  if (!["session", "active"].includes(view)) {
    local.sessionGuestMenuAbortController?.abort();
    local.sessionGuestMenuAbortController = null;
  }
  if (view !== "editor") {
    local.sessionActionsMenuAbortController?.abort();
    local.sessionActionsMenuAbortController = null;
  }
  const params = new URLSearchParams();
  params.set("view", view);
  if (extra.name) params.set("name", extra.name);
  history.pushState({}, "", `/?${params.toString()}`);
  local.view = view;
  local.pendingViewTransition = previousView !== view
    ? { from: previousView, to: view }
    : null;
  if (extra.token) {
    local.guestToken = extra.token;
    sessionStorage.setItem("localleaf.guestToken", extra.token);
  }
  if (extra.name) local.userName = extra.name;
  if (extra.token) connectEvents();
  if (view !== "editor") closeCollab();
  if (view === "editor") {
    if (previousView !== "editor") prepareEditorOpenLayout();
    requestEditorMaximize();
  } else {
    local.editorOpenLayoutPrepared = false;
  }
  render();
}

function requestEditorMaximize() {
  window.localleafDesktop?.maximize?.();
}

function prepareEditorOpenLayout() {
  local.fileSectionHeight = 0;
  local.imageSectionHeight = 0;
  local.sidebarSectionLayoutNeedsDefault = true;
  local.sidebarSectionLayoutAutoSized = true;
  local.editorOpenLayoutPrepared = true;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function availableTunnelProviders(session = local.appState?.session) {
  return Array.isArray(session?.tunnel?.providers)
    ? session.tunnel.providers.filter((provider) => provider?.id && provider?.name)
    : [];
}

function preferredTunnelProviderId(session = local.appState?.session) {
  const providers = availableTunnelProviders(session);
  const serverPreference = String(session?.tunnel?.preferredProviderId || "");
  const requested = local.tunnelProviderPreferenceLoaded ? local.preferredTunnelProviderId : serverPreference;
  return providers.some((provider) => provider.id === requested) ? requested : "";
}

function setPreferredTunnelProvider(providerId, session = local.appState?.session) {
  const normalized = String(providerId || "");
  const allowed = !normalized || availableTunnelProviders(session).some((provider) => provider.id === normalized);
  if (!allowed) return false;
  local.preferredTunnelProviderId = normalized;
  local.tunnelProviderPreferenceLoaded = true;
  localStorage.setItem(TUNNEL_PROVIDER_STORAGE_KEY, normalized);
  return true;
}

function sessionTunnelProviderId(session = local.appState?.session) {
  const providers = availableTunnelProviders(session);
  const override = local.sessionTunnelProviderOverrideId;
  if (override === null) return preferredTunnelProviderId(session);
  if (!override || providers.some((provider) => provider.id === override)) return override;
  return preferredTunnelProviderId(session);
}

function tunnelProviderOptionsMarkup(session = local.appState?.session, selectedProviderId = preferredTunnelProviderId(session)) {
  const providers = availableTunnelProviders(session);
  const selected = String(selectedProviderId || "");
  if (!providers.length) return `<option value="">No public-link providers detected</option>`;
  return [
    `<option value="" ${selected ? "" : "selected"}>Automatic (recommended)</option>`,
    ...providers.map((provider) => `<option value="${escapeHtml(provider.id)}" ${selected === provider.id ? "selected" : ""}>${escapeHtml(provider.name)}</option>`)
  ].join("");
}

function sessionTunnelProviderPickerMarkup(session = local.appState?.session, selectedProviderId = preferredTunnelProviderId(session), disabled = false) {
  const providers = availableTunnelProviders(session);
  const selected = String(selectedProviderId || "");
  const selectedProvider = providers.find((provider) => provider.id === selected) || null;
  const unavailable = !providers.length;
  const triggerLabel = unavailable
    ? "No providers detected"
    : selectedProvider?.name || "Automatic";
  const triggerMeta = unavailable
    ? "Check provider availability"
    : selectedProvider
      ? "Session choice"
      : "Recommended";
  const automaticOption = {
    id: "",
    name: "Automatic",
    hint: "Uses the first provider that verifies."
  };
  const optionMarkup = unavailable
    ? `<div class="session-provider-empty" role="status">No public-link providers are available on this computer.</div>`
    : [automaticOption, ...providers].map((provider) => {
      const providerId = String(provider.id || "");
      const isSelected = providerId === selected;
      return `
        <button
          type="button"
          class="session-provider-option ${isSelected ? "selected" : ""}"
          role="option"
          aria-selected="${isSelected ? "true" : "false"}"
          tabindex="-1"
          data-session-tunnel-provider-option="${escapeHtml(providerId)}"
        >
          <span class="session-provider-option-copy">
            <strong>${escapeHtml(provider.name)}</strong>
            <small>${escapeHtml(provider.hint || "Use this provider for the current session.")}</small>
          </span>
          <span class="session-provider-option-check" aria-hidden="true">${editorToolIcon("check")}</span>
        </button>`;
    }).join("");

  return `
    <div class="session-provider-picker ${unavailable ? "is-unavailable" : ""}" data-session-provider-picker>
      <div class="session-provider-label-row">
        <span class="session-provider-label" id="sessionTunnelProviderLabel">Link provider</span>
        <span class="session-provider-scope">This session</span>
      </div>
      <button
        type="button"
        class="session-provider-trigger"
        id="sessionTunnelProvider"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-controls="sessionTunnelProviderMenu"
        aria-labelledby="sessionTunnelProviderLabel sessionTunnelProviderValue"
        ${disabled || unavailable ? "disabled" : ""}
      >
        <span class="session-provider-trigger-icon" aria-hidden="true">${uiGlyph("network")}</span>
        <span class="session-provider-trigger-copy">
          <strong id="sessionTunnelProviderValue">${escapeHtml(triggerLabel)}</strong>
          <small>${escapeHtml(triggerMeta)}</small>
        </span>
        <span class="session-provider-chevron" aria-hidden="true">${editorToolIcon("chevronDown")}</span>
      </button>
      <div
        class="session-provider-menu"
        id="sessionTunnelProviderMenu"
        role="listbox"
        aria-labelledby="sessionTunnelProviderLabel"
        aria-hidden="true"
        inert
      >${optionMarkup}</div>
    </div>`;
}

function selectedTunnelProvider(session = local.appState?.session) {
  const selectedId = preferredTunnelProviderId(session);
  return availableTunnelProviders(session).find((provider) => provider.id === selectedId) || null;
}

function selectedSessionTunnelProvider(session = local.appState?.session) {
  const selectedId = sessionTunnelProviderId(session);
  return availableTunnelProviders(session).find((provider) => provider.id === selectedId) || null;
}

function sessionTunnelProviderHint(session = local.appState?.session, selectedProviderId = sessionTunnelProviderId(session)) {
  const providers = availableTunnelProviders(session);
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) || null;
  const activePreferenceId = String(session?.tunnel?.preferredProviderId || "");
  if (selectedProviderId !== activePreferenceId) {
    return session?.status === "live"
      ? `Refresh to use ${selectedProvider?.name || "Automatic"}. Your Settings default stays unchanged.`
      : `This session will use ${selectedProvider?.name || "Automatic"}. Your Settings default stays unchanged.`;
  }
  return selectedProvider?.hint
    || (providers.length ? "Automatic uses the first provider that verifies." : "No public-link providers were detected.");
}

function compactInviteUrl(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const code = segments.at(-1) || "";
    const compactCode = code.length > 13 ? `${code.slice(0, 5)}...${code.slice(-5)}` : code;
    const joinPath = segments.includes("join") ? `/join/${compactCode}` : compactCode ? `/.../${compactCode}` : "";
    return `${url.hostname}${joinPath}`;
  } catch {
    const text = String(value || "");
    return text.length > 46 ? `${text.slice(0, 25)}...${text.slice(-16)}` : text;
  }
}

function tunnelInviteState(session = local.appState?.session) {
  const status = String(session?.tunnel?.status || "").toLowerCase();
  const providerName = session?.tunnel?.providerName || selectedSessionTunnelProvider(session)?.name || "the selected provider";
  const hasCurrentInvite = Boolean(session?.inviteUrl);
  const previousLinkInvalidated = Boolean(session?.tunnel?.previousLinkInvalidated);
  if (["error", "failed", "not installed", "unavailable"].includes(status)) {
    return {
      phase: "failed",
      title: previousLinkInvalidated ? "Replacement link failed" : "Could not create a verified link",
      detail: session?.tunnel?.detail || (previousLinkInvalidated ? "The previous invite link is no longer active. Choose another provider or try again." : "Choose another provider or try again."),
      providerName
    };
  }
  if (["checking", "verifying", "starting", "racing", "retrying"].includes(status)) {
    return {
      phase: "verifying",
      title: previousLinkInvalidated ? `Verifying a ${providerName} replacement` : `Verifying ${providerName}`,
      detail: session?.tunnel?.detail || (previousLinkInvalidated ? "The previous invite link is no longer active. Wait for this replacement to verify." : "LocalLeaf is checking that your friend can open the link."),
      providerName
    };
  }
  if (hasCurrentInvite) {
    return {
      phase: "ready",
      title: "Verified link ready",
      detail: `${providerName} verified this public link.`,
      providerName
    };
  }
  return {
    phase: "pending",
    title: "Generating your invite link",
    detail: session?.tunnel?.detail || "LocalLeaf is waiting for a public-link provider.",
    providerName
  };
}

function downloadFileName(name, extension) {
  const base = String(name || "LocalLeaf Project")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/\.+$/g, "")
    .slice(0, 80);
  return `${base || "LocalLeaf_Project"}${extension}`;
}

function triggerDownload(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function icon(name) {
  const icons = {
    plus: uiGlyph("plus"),
    folder: uiGlyph("folder"),
    users: uiGlyph("users"),
    file: uiGlyph("file"),
    copy: "",
    open: uiGlyph("external"),
    back: `<span class="chevron-left" aria-hidden="true"></span>`,
    compile: uiGlyph("compile"),
    chat: uiGlyph("chat"),
    ai: uiGlyph("ai"),
    help: uiGlyph("help"),
    info: uiGlyph("info"),
    template: uiGlyph("template"),
    download: uiGlyph("download"),
    refresh: uiGlyph("refresh"),
    settings: uiGlyph("settings"),
    ended: `<span class="plug-glyph" aria-hidden="true"></span>`
  };
  return icons[name] || "*";
}

const UI_GLYPH_MARKUP = {
  plus: `<path d="M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z"/>`,
  home: `<path d="M222.14,105.85l-80-80a20,20,0,0,0-28.28,0l-80,80A19.86,19.86,0,0,0,28,120v96a12,12,0,0,0,12,12H216a12,12,0,0,0,12-12V120A19.86,19.86,0,0,0,222.14,105.85ZM204,204H52V121.65l76-76,76,76Z"/>`,
  folder: `<path d="M216,68H132L105.33,48a20.12,20.12,0,0,0-12-4H40A20,20,0,0,0,20,64V200a20,20,0,0,0,20,20H216.89A19.13,19.13,0,0,0,236,200.89V88A20,20,0,0,0,216,68Zm-4,128H44V68H92l28.8,21.6A12,12,0,0,0,128,92h84Z"/>`,
  file: `<path d="M216.49,79.52l-56-56A12,12,0,0,0,152,20H56A20,20,0,0,0,36,40V216a20,20,0,0,0,20,20H200a20,20,0,0,0,20-20V88A12,12,0,0,0,216.49,79.52ZM160,57l23,23H160ZM60,212V44h76V92a12,12,0,0,0,12,12h48V212Zm112-80a12,12,0,0,1-12,12H96a12,12,0,0,1,0-24h64A12,12,0,0,1,172,132Zm0,40a12,12,0,0,1-12,12H96a12,12,0,0,1,0-24h64A12,12,0,0,1,172,172Z"/>`,
  users: `<path d="M164.38,181.1a52,52,0,1,0-72.76,0,75.89,75.89,0,0,0-30,28.89,12,12,0,0,0,20.78,12,53,53,0,0,1,91.22,0,12,12,0,1,0,20.78-12A75.89,75.89,0,0,0,164.38,181.1ZM100,144a28,28,0,1,1,28,28A28,28,0,0,1,100,144Zm147.21,9.59a12,12,0,0,1-16.81-2.39c-8.33-11.09-19.85-19.59-29.33-21.64a12,12,0,0,1-1.82-22.91,20,20,0,1,0-24.78-28.3,12,12,0,1,1-21-11.6,44,44,0,1,1,73.28,48.35,92.18,92.18,0,0,1,22.85,21.69A12,12,0,0,1,247.21,153.59Zm-192.28-24c-9.48,2.05-21,10.55-29.33,21.65A12,12,0,0,1,6.41,136.79,92.37,92.37,0,0,1,29.26,115.1a44,44,0,1,1,73.28-48.35,12,12,0,1,1-21,11.6,20,20,0,1,0-24.78,28.3,12,12,0,0,1-1.82,22.91Z"/>`,
  network: `<path d="M87.5,151.52l64-64a12,12,0,0,1,17,17l-64,64a12,12,0,0,1-17-17Zm131-114a60.08,60.08,0,0,0-84.87,0L103.51,67.61a12,12,0,0,0,17,17l30.07-30.06a36,36,0,0,1,50.93,50.92L171.4,135.52a12,12,0,1,0,17,17l30.08-30.06A60.09,60.09,0,0,0,218.45,37.55ZM135.52,171.4l-30.07,30.08a36,36,0,0,1-50.92-50.93l30.06-30.07a12,12,0,0,0-17-17L37.55,133.58a60,60,0,0,0,84.88,84.87l30.06-30.07a12,12,0,0,0-17-17Z"/>`,
  compile: `<path d="M176,128a12,12,0,0,1-5.17,9.87l-52,36A12,12,0,0,1,100,164V92a12,12,0,0,1,18.83-9.87l52,36A12,12,0,0,1,176,128Zm60,0A108,108,0,1,1,128,20,108.12,108.12,0,0,1,236,128Zm-24,0a84,84,0,1,0-84,84A84.09,84.09,0,0,0,212,128Z"/>`,
  external: `<path d="M228,104a12,12,0,0,1-24,0V69l-59.51,59.51a12,12,0,0,1-17-17L187,52H152a12,12,0,0,1,0-24h64a12,12,0,0,1,12,12Zm-44,24a12,12,0,0,0-12,12v64H52V84h64a12,12,0,0,0,0-24H48A20,20,0,0,0,28,80V208a20,20,0,0,0,20,20H176a20,20,0,0,0,20-20V140A12,12,0,0,0,184,128Z"/>`,
  chat: `<path d="M120,128a16,16,0,1,1-16-16A16,16,0,0,1,120,128Zm32-16a16,16,0,1,0,16,16A16,16,0,0,0,152,112Zm84,16A108,108,0,0,1,78.77,224.15L46.34,235A20,20,0,0,1,21,209.66l10.81-32.43A108,108,0,1,1,236,128Zm-24,0A84,84,0,1,0,55.27,170.06a12,12,0,0,1,1,9.81l-9.93,29.79,29.79-9.93a12.1,12.1,0,0,1,3.8-.62,12,12,0,0,1,6,1.62A84,84,0,0,0,212,128Z"/>`,
  download: `<path d="M228,144v64a12,12,0,0,1-12,12H40a12,12,0,0,1-12-12V144a12,12,0,0,1,24,0v52H204V144a12,12,0,0,1,24,0Zm-108.49,8.49a12,12,0,0,0,17,0l40-40a12,12,0,0,0-17-17L140,115V32a12,12,0,0,0-24,0v83L96.49,95.51a12,12,0,0,0-17,17Z"/>`,
  upload: `<path d="M228,144v64a12,12,0,0,1-12,12H40a12,12,0,0,1-12-12V144a12,12,0,0,1,24,0v52H204V144a12,12,0,0,1,24,0ZM96.49,80.49,116,61v83a12,12,0,0,0,24,0V61l19.51,19.52a12,12,0,1,0,17-17l-40-40a12,12,0,0,0-17,0l-40,40a12,12,0,1,0,17,17Z"/>`,
  stop: `<path d="M200,36H56A20,20,0,0,0,36,56V200a20,20,0,0,0,20,20H200a20,20,0,0,0,20-20V56A20,20,0,0,0,200,36Zm-4,160H60V60H196Z"/>`,
  refresh: `<path d="M244,56v48a12,12,0,0,1-12,12H184a12,12,0,1,1,0-24H201.1l-19-17.38c-.13-.12-.26-.24-.38-.37A76,76,0,1,0,127,204h1a75.53,75.53,0,0,0,52.15-20.72,12,12,0,0,1,16.49,17.45A99.45,99.45,0,0,1,128,228h-1.37A100,100,0,1,1,198.51,57.06L220,76.72V56a12,12,0,0,1,24,0Z"/>`,
  settings: `<path d="M40,92H70.06a36,36,0,0,0,67.88,0H216a12,12,0,0,0,0-24H137.94a36,36,0,0,0-67.88,0H40a12,12,0,0,0,0,24Zm64-24A12,12,0,1,1,92,80,12,12,0,0,1,104,68Zm112,96H201.94a36,36,0,0,0-67.88,0H40a12,12,0,0,0,0,24h94.06a36,36,0,0,0,67.88,0H216a12,12,0,0,0,0-24Zm-48,24a12,12,0,1,1,12-12A12,12,0,0,1,168,188Z"/>`,
  ai: `<path d="M234.36,170A12,12,0,0,1,230,186.37l-96,56a12,12,0,0,1-12.1,0l-96-56a12,12,0,0,1,12.09-20.74l90,52.48L218,165.63A12,12,0,0,1,234.36,170ZM218,117.63,128,170.11,38.05,117.63A12,12,0,0,0,26,138.37l96,56a12,12,0,0,0,12.1,0l96-56A12,12,0,0,0,218,117.63ZM20,80a12,12,0,0,1,6-10.37l96-56a12.06,12.06,0,0,1,12.1,0l96,56a12,12,0,0,1,0,20.74l-96,56a12,12,0,0,1-12.1,0l-96-56A12,12,0,0,1,20,80Zm35.82,0L128,122.11,200.18,80,128,37.89Z"/>`,
  help: `<path d="M144,180a16,16,0,1,1-16-16A16,16,0,0,1,144,180Zm92-52A108,108,0,1,1,128,20,108.12,108.12,0,0,1,236,128Zm-24,0a84,84,0,1,0-84,84A84.09,84.09,0,0,0,212,128ZM128,64c-24.26,0-44,17.94-44,40v4a12,12,0,0,0,24,0v-4c0-8.82,9-16,20-16s20,7.18,20,16-9,16-20,16a12,12,0,0,0-12,12v8a12,12,0,0,0,23.73,2.56C158.31,137.88,172,122.37,172,104,172,81.94,152.26,64,128,64Z"/>`,
  info: `<path d="M108,84a16,16,0,1,1,16,16A16,16,0,0,1,108,84Zm128,44A108,108,0,1,1,128,20,108.12,108.12,0,0,1,236,128Zm-24,0a84,84,0,1,0-84,84A84.09,84.09,0,0,0,212,128Zm-72,36.68V132a20,20,0,0,0-20-20,12,12,0,0,0-4,23.32V168a20,20,0,0,0,20,20,12,12,0,0,0,4-23.32Z"/>`,
  template: `<path d="M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36Zm-4,160H44V60H212ZM68,92A12,12,0,0,1,80,80h96a12,12,0,0,1,0,24H80A12,12,0,0,1,68,92Zm0,36a12,12,0,0,1,12-12h96a12,12,0,0,1,0,24H80A12,12,0,0,1,68,128Zm0,36a12,12,0,0,1,12-12h96a12,12,0,0,1,0,24H80A12,12,0,0,1,68,164Z"/>`,
  play: `<path d="M234.49,111.07,90.41,22.94A20,20,0,0,0,60,39.87V216.13a20,20,0,0,0,30.41,16.93l144.08-88.13a19.82,19.82,0,0,0,0-33.86ZM84,208.85V47.15L216.16,128Z"/>`,
  pause: `<path d="M200,28H160a20,20,0,0,0-20,20V208a20,20,0,0,0,20,20h40a20,20,0,0,0,20-20V48A20,20,0,0,0,200,28Zm-4,176H164V52h32ZM96,28H56A20,20,0,0,0,36,48V208a20,20,0,0,0,20,20H96a20,20,0,0,0,20-20V48A20,20,0,0,0,96,28ZM92,204H60V52H92Z"/>`
};

function uiGlyph(name) {
  const markup = UI_GLYPH_MARKUP[name] || UI_GLYPH_MARKUP.info;
  return `<svg class="ui-glyph ui-glyph-${name}" viewBox="0 0 256 256" aria-hidden="true" focusable="false">${markup}</svg>`;
}

const PROVIDER_LOGO_PATHS = {
  openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
};

const PROVIDER_LOGO_SVG_MARKUP = {
  lmstudio: `<path d="M2.84 2a1.273 1.273 0 100 2.547h14.107a1.273 1.273 0 100-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H22.04a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h14.106a1.274 1.274 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H15.38a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h14.106a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h9.698a1.273 1.273 0 100-2.547h-9.698z" fill-opacity=".3"></path><path d="M2.84 2a1.273 1.273 0 100 2.547h10.287a1.274 1.274 0 000-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H18.22a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h10.286a1.273 1.273 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H11.56a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h10.286a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h5.78a1.273 1.273 0 100-2.547h-5.78z"></path>`,
  opencode: `<path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"></path>`,
  cursor: `<path d="M4 4.6 20 12 4 19.4l3.6-7.4L4 4.6Z"></path><path d="m7.6 12 6.7-.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>`
};

const PROVIDER_LOGO_ASSETS = {
  openai: "/assets/provider-logos/openai.svg",
  lmstudio: "/assets/provider-logos/lm-studio.svg",
  opencode: "/assets/provider-logos/opencode.svg",
  cursor: "/assets/provider-logos/cursor.svg"
};

const PROVIDER_LOGO_KEYS_BY_ID = {
  openai: "openai",
  openrouter: "openrouter",
  ollama: "ollama",
  lmstudio: "lmstudio",
  "opencode-go": "opencode",
  cursor: "cursor"
};

function providerLogoKey(provider = {}) {
  if (provider.custom) return "custom";
  const id = String(provider.id || "").trim().toLowerCase();
  return PROVIDER_LOGO_KEYS_BY_ID[id] || "custom";
}

function providerLogoMarkup(provider = {}) {
  const key = providerLogoKey(provider);
  const asset = PROVIDER_LOGO_ASSETS[key];
  if (asset) {
    return `<span class="provider-logo provider-logo-${key}" aria-hidden="true"><img src="${asset}" alt="" loading="lazy" decoding="async" /></span>`;
  }
  const svgMarkup = PROVIDER_LOGO_SVG_MARKUP[key] || (PROVIDER_LOGO_PATHS[key] ? `<path d="${PROVIDER_LOGO_PATHS[key]}"></path>` : "");
  if (svgMarkup) {
    return `<span class="provider-logo provider-logo-${key}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${svgMarkup}</svg></span>`;
  }
  return `<span class="provider-logo provider-logo-${key}" aria-hidden="true">${uiGlyph("settings")}</span>`;
}

function downArrowIcon() {
  return `<svg class="ai-scroll-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14"></path><path d="m6 13 6 6 6-6"></path></svg>`;
}

function editorToolIcon(name) {
  const attrs = `class="tool-icon tool-icon-${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"`;
  const icons = {
    undo: `<svg ${attrs}><path d="M9 8H5V4" /><path d="M5.5 8.5A8 8 0 1 1 7 18" /></svg>`,
    redo: `<svg ${attrs}><path d="M15 8h4V4" /><path d="M18.5 8.5A8 8 0 1 0 17 18" /></svg>`,
    monospace: `<svg ${attrs}><path d="M8 8 4 12l4 4" /><path d="m16 8 4 4-4 4" /><path d="m13.5 6-3 12" /></svg>`,
    symbol: `<svg ${attrs}><path d="M7 18h10" /><path d="M8 18c2.6-2.4 3-4.4 3-7 0-2.7-1.3-4-3.2-4C6 7 5 8.2 5 10" /><path d="M16 18c-2.6-2.4-3-4.4-3-7 0-2.7 1.3-4 3.2-4C18 7 19 8.2 19 10" /></svg>`,
    math: `<svg ${attrs}><path d="M7 5h10" /><path d="M8 19h9" /><path d="M16 5 9 12l7 7" /><path d="M13.5 12H20" /></svg>`,
    link: `<svg ${attrs}><path d="M10 13a5 5 0 0 0 7.1 0l1.2-1.2a5 5 0 0 0-7.1-7.1L10.5 5.4" /><path d="M14 11a5 5 0 0 0-7.1 0l-1.2 1.2a5 5 0 0 0 7.1 7.1l.7-.7" /></svg>`,
    ref: `<svg ${attrs}><path d="M7 4h10v16l-5-3-5 3V4Z" /><path d="M10 8h4" /><path d="M10 11h4" /></svg>`,
    cite: `<svg ${attrs}><path d="M8 10h4v7H5v-4c0-3.3 1.7-5.3 5-6" /><path d="M17 10h2v7h-7v-4c0-3.3 1.7-5.3 5-6" /></svg>`,
    comment: `<svg ${attrs}><path d="M5 6h14v10H8l-3 3V6Z" /><path d="M9 10h6" /><path d="M9 13h4" /></svg>`,
    annotate: `<svg ${attrs}><path d="M12 3.5 13.5 8l4.5 1.5-4.5 1.5L12 15.5 10.5 11 6 9.5 10.5 8 12 3.5Z" /><path d="M5 18.5h5.5" /><path d="M14.5 16.5 18.5 12.5a1.6 1.6 0 0 1 2.3 2.3l-4 4-3 .7.7-3Z" /></svg>`,
    figure: `<svg ${attrs}><rect x="4" y="5" width="16" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m6.5 17 4.2-4.2 2.5 2.5 2-2L19 17" /></svg>`,
    table: `<svg ${attrs}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 10h16" /><path d="M4 15h16" /><path d="M10 5v14" /><path d="M15 5v14" /></svg>`,
    bulletList: `<svg ${attrs}><path d="M9 7h11" /><path d="M9 12h11" /><path d="M9 17h11" /><circle cx="5" cy="7" r="1.2" /><circle cx="5" cy="12" r="1.2" /><circle cx="5" cy="17" r="1.2" /></svg>`,
    numberedList: `<svg ${attrs}><path d="M10 7h10" /><path d="M10 12h10" /><path d="M10 17h10" /><path d="M4 6h1.5v4" /><path d="M4 10h3" /><path d="M4 14h3l-3 4h3" /></svg>`,
    outdent: `<svg ${attrs}><path d="M10 7h10" /><path d="M10 12h10" /><path d="M10 17h10" /><path d="m7 9-4 3 4 3" /></svg>`,
    indent: `<svg ${attrs}><path d="M4 7h10" /><path d="M4 12h10" /><path d="M4 17h10" /><path d="m17 9 4 3-4 3" /></svg>`,
    complete: `<svg ${attrs}><path d="M14 4 9 20" /><path d="M17 6h3" /><path d="M18.5 4.5v3" /><path d="M4 17h3" /><path d="M5.5 15.5v3" /></svg>`,
    search: `<svg ${attrs}><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>`,
    review: `<svg ${attrs}><path d="M3.8 12s3.1-5 8.2-5 8.2 5 8.2 5-3.1 5-8.2 5-8.2-5-8.2-5Z" /><circle cx="12" cy="12" r="2.3" /></svg>`,
    arrowUp: `<svg ${attrs}><path d="M12 19V5" /><path d="m7 10 5-5 5 5" /></svg>`,
    arrowDown: `<svg ${attrs}><path d="M12 5v14" /><path d="m7 14 5 5 5-5" /></svg>`,
    close: `<svg ${attrs}><path d="m6.5 6.5 11 11" /><path d="m17.5 6.5-11 11" /></svg>`,
    chevronRight: `<svg ${attrs}><path d="m9.5 7 5 5-5 5" /></svg>`,
    file: `<svg ${attrs}><path d="M6 3.5h8l4 4V20H6V3.5Z" /><path d="M14 3.5V8h4" /></svg>`,
    mainFile: `<svg ${attrs}><path d="M6 3.5h8l4 4V20H6V3.5Z" /><path d="M14 3.5V8h4" /><path d="M9 12h6" /><path d="M9 15h4" /></svg>`,
    image: `<svg ${attrs}><rect x="4" y="5" width="16" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m6.5 17 4.2-4.2 2.5 2.5 2-2L19 17" /></svg>`,
    files: `<svg ${attrs}><path d="M4 6.5h6l2 2h8v9.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5Z" /><path d="M4 10h16" /></svg>`,
    newFile: `<svg ${attrs}><path d="M6 3.5h8l4 4V20H6V3.5Z" /><path d="M14 3.5V8h4" /><path d="M9 13h6" /><path d="M12 10v6" /></svg>`,
    newFolder: `<svg ${attrs}><path d="M3.5 7h6l1.7 2H20v8.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7Z" /><path d="M12 14h5" /><path d="M14.5 11.5v5" /></svg>`,
    upload: `<svg ${attrs}><path d="M12 16V5" /><path d="m8 9 4-4 4 4" /><path d="M5 18.5h14" /></svg>`,
    rename: `<svg ${attrs}><path d="M4 19h7" /><path d="M13.5 5.5 18.5 10.5" /><path d="M6 15.5 15.8 5.7a2 2 0 0 1 2.8 2.8L8.8 18.3 5 19l1-3.5Z" /></svg>`,
    delete: `<svg ${attrs}><path d="M5 7h14" /><path d="M9 7V5h6v2" /><path d="M8 10v8" /><path d="M12 10v8" /><path d="M16 10v8" /><path d="M7 7l1 14h8l1-14" /></svg>`,
    chat: `<svg ${attrs}><path d="M5 6h14v10H8l-3 3V6Z" /><path d="M9 10h6" /><path d="M9 13h4" /></svg>`,
    menu: `<svg ${attrs}><path d="M5 7h14" /><path d="M5 12h14" /><path d="M5 17h14" /></svg>`,
    edit: `<svg ${attrs}><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m13.5 8.5 3 3" /></svg>`,
    chevronDown: `<svg ${attrs}><path d="m7 9.5 5 5 5-5" /></svg>`,
    more: `<svg ${attrs}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>`,
    check: `<svg ${attrs}><path d="m5 12.5 4 4 10-10" /></svg>`
  };
  return icons[name] || "";
}

function hostRailMarkup(active = "") {
  return `
    <nav class="host-nav-rail ${local.hostRailCollapsed ? "host-nav-rail-collapsed" : ""}" aria-label="Project shortcuts">
      <div class="host-rail-section host-rail-top">
        <button class="host-rail-button host-rail-collapse" id="railCollapse" title="${local.hostRailCollapsed ? "Expand navigation" : "Collapse navigation"}" aria-label="${local.hostRailCollapsed ? "Expand navigation" : "Collapse navigation"}"><span class="host-rail-collapse-icon" aria-hidden="true"></span><span class="host-rail-label">${local.hostRailCollapsed ? "Expand" : "Collapse"}</span></button>
        <button class="host-rail-button ${active === "home" ? "active" : ""}" id="railHome" title="Home" aria-label="Home">${uiGlyph("home")}<span class="host-rail-label">Home</span></button>
        <button class="host-rail-button" id="railModels" title="Models" aria-label="Models">${uiGlyph("ai")}<span class="host-rail-label">Models</span></button>
        <button class="host-rail-button ${active === "session" ? "active" : ""}" id="railSession" title="Session management" aria-label="Session management">${uiGlyph("users")}<span class="host-rail-label">Session</span></button>
      </div>
      <div class="host-rail-spacer"></div>
      <div class="host-rail-section host-rail-bottom">
        <button class="host-rail-button" id="railSettings" title="Settings" aria-label="Settings">${uiGlyph("settings")}<span class="host-rail-label">Settings</span></button>
        <button class="host-rail-button" id="railHelp" title="Help" aria-label="Help">${uiGlyph("help")}<span class="host-rail-label">Help</span></button>
        <button class="host-rail-button" id="railAbout" title="About" aria-label="About">${uiGlyph("info")}<span class="host-rail-label">About</span></button>
      </div>
    </nav>
  `;
}

function windowShell(content, options = {}) {
  return `
    <section class="host-frame ${options.dashboard ? "host-frame-dashboard" : ""}">
      <div class="window ${options.wide ? "window-wide" : ""} ${options.dashboard ? "window-dashboard" : ""}">
        <div class="titlebar">
          <div class="titlebar-brand">
            ${logoMark("titlebar-logo")}
            <strong>LocalLeaf Host</strong>
          </div>
        </div>
        <div class="window-body ${options.rail ? "window-body-with-rail" : ""} ${options.rail && local.hostRailCollapsed ? "host-rail-layout-collapsed" : ""}">
          ${options.rail ? hostRailMarkup(options.active) : ""}
          ${options.rail ? `<div class="window-content">${content}</div>` : content}
        </div>
      </div>
    </section>
  `;
}

function brand() {
  return `
    <div class="brand">
      ${logoMark("brand-mark")}
      <h1>LocalLeaf <span>Host</span></h1>
    </div>
  `;
}

function logoMark(className = "brand-mark") {
  return `<svg class="${className} brand-symbol" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect x="3" y="3" width="58" height="58" rx="17" class="brand-symbol-tile"/><path d="M17 41.5c.8-15.2 10.4-24.8 30-27.5-.2 15.7-8.9 27-25.8 31.7-2.2-.8-3.6-2.2-4.2-4.2Z" class="brand-symbol-leaf"/><path d="M17.5 48c7.2-14 16.2-23.3 27.5-29" class="brand-symbol-vein"/></svg>`;
}

function activeFileForUser(userId) {
  return local.collabPresence.find((item) => item.userId === userId)?.filePath || "";
}

function updateCheckButtonMarkup(id, label = "Check for updates", extraClass = "", options = {}) {
  const titleAttribute = options.menuItem ? "" : ' title="Check for updates"';
  return `
    <button class="btn update-check-button ${extraClass} ${local.updateChecking ? "is-checking" : ""}" id="${escapeHtml(id)}" data-check-updates data-default-label="${escapeHtml(label)}" type="button"${titleAttribute} aria-label="Check for updates" aria-busy="${local.updateChecking ? "true" : "false"}"${options.menuItem ? ' role="menuitem"' : ""}>
      <span class="update-check-icon">${icon("refresh")}</span>
      <span class="update-check-copy">
        <span data-update-label>${local.updateChecking ? "Checking for updates..." : escapeHtml(label)}</span>
        <small>Latest LocalLeaf build</small>
      </span>
    </button>
  `;
}

function isZipImportFile(file) {
  return /\.zip$/i.test(file?.name || "") || file?.type === "application/zip" || file?.type === "application/x-zip-compressed";
}

function importFileName(fileOrPath) {
  return String(fileOrPath?.name || fileOrPath || "").replace(/\\/g, "/").split("/").pop().trim();
}

function importFileExtension(fileOrPath) {
  const name = importFileName(fileOrPath).toLowerCase();
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex) : "";
}

function isSupportedProjectFileName(fileOrPath) {
  const name = importFileName(fileOrPath).toLowerCase();
  return SUPPORTED_PROJECT_SPECIAL_FILENAMES.has(name) || SUPPORTED_PROJECT_FILE_EXTENSIONS.has(importFileExtension(fileOrPath));
}

function isSupportedImageProjectFileName(fileOrPath) {
  return SUPPORTED_PROJECT_IMAGE_EXTENSIONS.has(importFileExtension(fileOrPath));
}

function normalizeProjectPathInput(pathValue = "") {
  return pathParts(pathValue).join("/");
}

function unsupportedProjectFiles(files) {
  return [...(files || [])].filter((file) => !isZipImportFile(file) && !isSupportedProjectFileName(stagedImportPath(file)));
}

function unsupportedFilesMessage(files) {
  const names = files.slice(0, 4).map((file) => file?.name || stagedImportPath(file) || "selected file").join(", ");
  const extra = files.length > 4 ? ` and ${files.length - 4} more` : "";
  return `Unsupported file type${files.length === 1 ? "" : "s"}: ${names}${extra}.`;
}

function isReadableImportFile(file) {
  return Boolean(
    file
    && typeof file.name === "string"
    && (
      typeof file.arrayBuffer === "function"
      || typeof FileReader === "function"
    )
  );
}

function readImportFileBuffer(file) {
  if (typeof file?.arrayBuffer === "function") {
    return file.arrayBuffer();
  }
  if (typeof FileReader !== "function") {
    return Promise.reject(new Error(`Could not read ${file?.name || "the selected file"}.`));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error || new Error(`Could not read ${file?.name || "the selected file"}.`)));
    reader.readAsArrayBuffer(file);
  });
}

function stagedImportPath(file) {
  return file?.webkitRelativePath || file?.relativePath || file?.name || "Untitled";
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function homeImportTrayMarkup() {
  const files = local.homeImportFiles || [];
  const hasFiles = files.length > 0;
  const zipFiles = files.filter(isZipImportFile);
  const invalidZipMix = zipFiles.length > 0 && files.length > 1;
  const title = hasFiles
    ? invalidZipMix
      ? "ZIP imports must be selected alone"
      : zipFiles.length
        ? "ZIP ready to open"
        : `${files.length} file${files.length === 1 ? "" : "s"} ready to open`
    : "Drop files or a ZIP here";
  const detail = hasFiles
    ? zipFiles.length
      ? "LocalLeaf will unpack this ZIP as a project."
      : "LocalLeaf will create a project from these files."
    : "Use a .zip for full projects, or select .tex, .bib, images, and supporting files together.";

  return `
    <section class="home-import-panel">
      <div class="home-import-head">
        <div>
          <strong>Drop project files</strong>
          <span>Drag a ZIP or loose LaTeX files into the box</span>
        </div>
      </div>
      <div class="home-import-drop ${local.homeImportDragActive ? "drag-active" : ""} ${hasFiles ? "has-files" : ""}" id="homeImportDropZone">
        <div class="home-import-drop-icon">${uiGlyph("upload")}</div>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
      </div>
      ${hasFiles ? `
        <div class="home-import-staged">
          <div class="home-import-staged-head">
            <div>
              <strong>${escapeHtml(zipFiles.length ? zipFiles[0].name : `${files.length} selected files`)}</strong>
              <span>${escapeHtml(zipFiles.length ? formatFileSize(zipFiles[0].size) : `${formatFileSize(files.reduce((total, file) => total + Number(file.size || 0), 0))} total`)}</span>
            </div>
            <div class="home-import-actions">
              <button class="btn btn-primary" id="openHomeImport" ${local.homeImportBusy || invalidZipMix ? "disabled" : ""}>${local.homeImportBusy ? "Opening..." : "Open import"}</button>
              <button class="btn" id="clearHomeImport" ${local.homeImportBusy ? "disabled" : ""}>Clear</button>
            </div>
          </div>
          <div class="home-import-file-list" aria-label="Files to import">
            ${files.slice(0, 12).map((file) => `
              <div class="home-import-file-row">
                <span>${isZipImportFile(file) ? "zip" : "file"}</span>
                <strong title="${escapeHtml(stagedImportPath(file))}">${escapeHtml(stagedImportPath(file))}</strong>
                <small>${escapeHtml(formatFileSize(file.size))}</small>
              </div>
            `).join("")}
            ${files.length > 12 ? `<div class="home-import-file-more">+ ${files.length - 12} more file${files.length - 12 === 1 ? "" : "s"}</div>` : ""}
          </div>
        </div>
      ` : ""}
      ${local.homeImportStatus ? `<div class="home-import-status">${escapeHtml(local.homeImportStatus)}</div>` : ""}
    </section>
  `;
}

function recentProjectsMarkup() {
  const items = recentProjects();
  if (!items.length) {
    return `<div class="recent-empty">Recent projects will appear here after you open or create them.</div>`;
  }
  return `
    <div class="recent-list">
      ${items.map((item) => `
        <button class="recent-item" data-open-recent="${escapeHtml(item.root)}" title="${escapeHtml(item.root)}">
          <span>${uiGlyph("folder")}</span>
          <strong>${escapeHtml(item.name || "LocalLeaf Project")}</strong>
          <small>${escapeHtml(item.root)}</small>
          ${item.sizeLabel ? `<b>${escapeHtml(item.sizeLabel)}</b>` : ""}
        </button>
      `).join("")}
    </div>
  `;
}

function homeModelsMarkup() {
  const state = aiState();
  const active = activeAiProviderModel();
  const downloading = state.download || state.downloadProgress || aiModels().find((model) => model.status === "downloading");
  return `
    <section class="home-models-panel">
      <div class="section-title">AI Models</div>
      <div class="home-model-summary">
        <div class="home-model-icon">${uiGlyph("ai")}</div>
        <div>
          <strong>${escapeHtml(active.providerName)} / ${escapeHtml(active.modelName)}</strong>
          <span>${escapeHtml(active.providerId === "local" ? state.storagePath || state.storageRoot || "Local model storage is ready to configure." : "Hosted provider configured from Settings > Models.")}</span>
        </div>
      </div>
      ${downloading ? `
        <div class="model-progress">
          <div>
            <strong>${escapeHtml(downloading.modelName || downloading.name || "Downloading model")}</strong>
            <span>${Math.round(Number(downloading.percent ?? downloading.progress ?? 0))}%</span>
          </div>
          <progress value="${Number(downloading.percent ?? downloading.progress ?? 0)}" max="100"></progress>
        </div>
      ` : ""}
      <div class="home-model-actions">
        <button class="btn btn-primary" id="homeOpenModels">${uiGlyph("settings")} Manage Models</button>
        <button class="btn" id="homeBringKey">${uiGlyph("ai")} Bring Your Own Key</button>
        <button class="btn" id="homeCustomModel">${uiGlyph("plus")} Configure Custom Model</button>
      </div>
    </section>
  `;
}

function homeView() {
  const state = local.appState;
  const hasLiveSession = state.session.status === "live";
  const sessionActionLabel = hasLiveSession ? "Manage Current Session" : "Host Online Session";
  return windowShell(`
      <div class="home-app-page">
        <header class="home-app-head">
          ${brand()}
          ${updateCheckButtonMarkup("homeCheckUpdates")}
        </header>

      <div class="home-app-grid">
        <section class="home-actions-panel">
          <div class="section-title">Start</div>
          <div class="home-action-grid">
            <button class="btn btn-primary" id="newProject">${icon("plus")} New Project</button>
            <button class="btn" id="importZip">${uiGlyph("folder")} Import ZIP Project</button>
            <button class="btn" id="importFiles">${uiGlyph("upload")} Import Files</button>
            <button class="btn btn-outline-orange" id="homeSessionAction">${uiGlyph("users")} ${sessionActionLabel}</button>
          </div>
          ${homeImportTrayMarkup()}
        </section>

        <section class="home-current-panel">
          <div class="section-title">Current Project</div>
          <button class="current-project-card" id="openCurrentCard">
            <div>
              <h2>${escapeHtml(state.project.name)}</h2>
              <p>${escapeHtml(state.project.root)}</p>
            </div>
            <span>${escapeHtml(state.project.sizeLabel)}</span>
          </button>
          <div class="section-title home-subsection-title">Recent Projects</div>
          ${recentProjectsMarkup()}
        </section>
      </div>
    </div>
  `, { rail: true, active: "home", dashboard: true, wide: true });
}

function projectView() {
  const { project, compiler, session } = local.appState;
  const compilerReady = compiler.available;
  const tunnelReady = session.tunnel.available;
  const defaultTunnelProvider = selectedTunnelProvider(session);
  return windowShell(`
    <div class="project-app-page">
      <header class="project-app-head">
        <button class="icon-button project-back-icon" id="goHome" title="Back to home" aria-label="Back to home">
          <span class="chevron-left" aria-hidden="true"></span>
        </button>
        <div>
          <h2>${escapeHtml(project.name)}</h2>
          <p>${escapeHtml(project.root)}</p>
        </div>
        <button class="btn btn-outline-orange" id="hostOnline">${uiGlyph("users")} Host Online Session</button>
      </header>

      <div class="project-app-grid">
        <main class="project-primary-panel">
          <div class="project-action-grid">
            <button class="btn btn-primary" id="openEditor">Open Editor</button>
            <button class="btn" id="importZipProject">${uiGlyph("folder")} Import ZIP</button>
          </div>

          <div class="section-title">Project Status</div>
          <div class="status-list project-status-card">
            <div class="status-row project-status-row">
              ${uiGlyph("compile")}
              <div><strong>Compiler</strong><span>${escapeHtml(compiler.label)}</span></div>
              <b class="${compilerReady ? "status-good" : "status-warn"}">${compilerReady ? "Ready" : "Fallback"}</b>
            </div>
            <div class="status-row project-status-row">
              ${uiGlyph("network")}
              <div><strong>Public invite link</strong><span>${escapeHtml(defaultTunnelProvider?.name || "Automatic provider selection")}</span></div>
              <b class="${tunnelReady ? "status-good" : "status-warn"}">${escapeHtml(session.tunnel.status)}</b>
            </div>
            <div class="status-row project-status-row">
              ${uiGlyph("file")}
              <div><strong>Project size</strong><span>${project.files.filter((item) => item.type !== "directory").length} files</span></div>
              <b>${project.sizeLabel}</b>
            </div>
            <div class="status-row project-status-row">
              ${uiGlyph("users")}
              <div><strong>Session capacity</strong><span>Friends still require host approval</span></div>
              <b>${session.maxUsers}</b>
            </div>
          </div>
        </main>

        <aside class="project-details-panel">
          <div class="section-title">Session Readiness</div>
          <div class="project-detail-list">
            <div><span>Tunnel</span><b class="${session.tunnel.available ? "status-good" : "status-warn"}">${escapeHtml(session.tunnel.status)}</b></div>
            <div><span>Default provider</span><b>${escapeHtml(defaultTunnelProvider?.name || "Automatic")}</b></div>
            <div><span>Access</span><b>Host approval</b></div>
            <div><span>Compiler</span><b class="${compilerReady ? "status-good" : "status-warn"}">${compilerReady ? "Ready" : "Fallback"}</b></div>
          </div>
        </aside>
      </div>
    </div>
  `, { rail: true, active: "home", dashboard: true, wide: true });
}

function sessionGuestRoleValue(context, id, fallback = "viewer") {
  const key = `${context}:${id}`;
  const saved = local.sessionGuestRoles[key];
  if (saved === "viewer" || saved === "maintainer") return saved;
  return fallback === "maintainer" ? "maintainer" : "viewer";
}

function sessionRolePickerMarkup({ context, id, value, disabled = false, label = "Guest role" }) {
  const key = `${context}:${id}`;
  const role = value === "maintainer" ? "maintainer" : "viewer";
  const title = role === "maintainer" ? "Maintainer" : "Viewer";
  const menuId = `sessionRoleMenu-${key.replace(/[^a-z0-9_-]/gi, "-")}`;
  return `
    <div class="session-role-picker" data-session-role-picker data-role-context="${escapeHtml(context)}" data-role-id="${escapeHtml(id)}" data-role-value="${role}">
      <button class="session-role-trigger" type="button" aria-label="${escapeHtml(label)}: ${title}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${menuId}" ${disabled ? "disabled" : ""}>
        <span>${title}</span>
        <span class="session-role-chevron" aria-hidden="true">${editorToolIcon("chevronDown")}</span>
      </button>
      <div class="session-role-menu" id="${menuId}" role="listbox" aria-label="${escapeHtml(label)}" aria-hidden="true" inert>
        <button type="button" role="option" data-session-role-option="viewer" aria-selected="${role === "viewer" ? "true" : "false"}">
          <span><strong>Viewer</strong><small>Read source, PDF, and chat</small></span>
          <span class="session-role-check" aria-hidden="true">${role === "viewer" ? "&#10003;" : ""}</span>
        </button>
        <button type="button" role="option" data-session-role-option="maintainer" aria-selected="${role === "maintainer" ? "true" : "false"}">
          <span><strong>Maintainer</strong><small>Edit files and use AI</small></span>
          <span class="session-role-check" aria-hidden="true">${role === "maintainer" ? "&#10003;" : ""}</span>
        </button>
      </div>
    </div>
  `;
}

function sessionGuestManagerMarkup(session) {
  const users = Array.isArray(session?.users) ? session.users : [];
  const host = users.find((user) => user.role === "host") || { id: "host", name: "Host", role: "host", online: true };
  const guests = users.filter((user) => user.role !== "host");
  const pending = (Array.isArray(session?.joinRequests) ? session.joinRequests : [])
    .filter((request) => request.status === "pending");
  const maxGuests = Math.max(1, Number(session?.maxGuests || 5));
  const full = guests.length >= maxGuests;
  const pendingRows = pending.map((request) => {
    const key = `pending:${request.id}`;
    const busy = Boolean(local.sessionGuestBusy[key]);
    const role = sessionGuestRoleValue("pending", request.id, "viewer");
    const error = local.sessionGuestErrors[key] || "";
    return `
      <article class="session-guest-row session-guest-request" data-session-guest-row="${escapeHtml(key)}" aria-busy="${busy ? "true" : "false"}">
        <div class="session-guest-identity">
          <div class="avatar">${escapeHtml(request.name?.[0] || "?")}</div>
          <div><strong>${escapeHtml(request.name || "Guest")}</strong><span>Waiting for approval</span></div>
        </div>
        <div class="session-guest-controls">
          ${sessionRolePickerMarkup({ context: "pending", id: request.id, value: role, disabled: busy, label: `Role for ${request.name || "guest"}` })}
          <button class="btn btn-primary session-guest-approve" type="button" data-session-guest-approve="${escapeHtml(request.id)}" ${busy || full ? "disabled" : ""}>${busy ? "Working&hellip;" : "Approve"}</button>
          <button class="btn session-guest-decline" type="button" data-session-guest-decline="${escapeHtml(request.id)}" ${busy ? "disabled" : ""}>Decline</button>
        </div>
        ${error ? `<p class="session-guest-error" role="alert">${escapeHtml(error)}</p>` : ""}
      </article>
    `;
  }).join("");
  const guestRows = guests.map((user) => {
    const key = `guest:${user.id}`;
    const busy = Boolean(local.sessionGuestBusy[key]);
    const role = user.role === "maintainer" ? "maintainer" : "viewer";
    const error = local.sessionGuestErrors[key] || "";
    return `
      <article class="session-guest-row" data-session-guest-row="${escapeHtml(key)}" aria-busy="${busy ? "true" : "false"}">
        <div class="session-guest-identity">
          <div class="avatar">${escapeHtml(user.name?.[0] || "?")}</div>
          <div><strong>${escapeHtml(user.name || "Guest")}</strong><span><i class="online-dot ${user.online ? "" : "offline"}" aria-hidden="true"></i>${user.online ? "Online" : "Offline"}</span></div>
        </div>
        <div class="session-guest-controls">
          ${sessionRolePickerMarkup({ context: "guest", id: user.id, value: role, disabled: busy, label: `Role for ${user.name || "guest"}` })}
          <button class="session-guest-remove" type="button" data-session-guest-remove="${escapeHtml(user.id)}" ${busy ? "disabled" : ""}>Remove access</button>
        </div>
        ${error ? `<p class="session-guest-error" role="alert">${escapeHtml(error)}</p>` : ""}
      </article>
    `;
  }).join("");

  return `
    <div class="session-guest-manager" id="sessionGuestManager" data-session-guest-manager>
      <div class="session-host-row" aria-label="Session host">
        <div class="session-guest-identity">
          <div class="avatar">${escapeHtml(host.name?.[0] || "H")}</div>
          <div><strong>${escapeHtml(host.name || "Host")} <span class="session-you-label">You</span></strong><span>Host &middot; Controls this session</span></div>
        </div>
        <span class="online-dot" title="Online"></span>
      </div>
      <div class="session-guest-heading-row">
        <div>
          <h3 id="sessionGuestsHeading" tabindex="-1">Guests</h3>
          <p>${guests.length} of ${maxGuests} guest spots used</p>
        </div>
        ${pending.length ? `<span class="session-pending-count">${pending.length} pending</span>` : ""}
      </div>
      ${full && pending.length ? `<p class="session-capacity-note" role="status">All guest spots are in use. Remove a guest before approving another.</p>` : ""}
      <div class="session-guest-list">
        ${pendingRows}
        ${guestRows}
        ${!pending.length && !guests.length ? `<div class="session-guests-empty"><strong>No guests yet</strong><span>New requests will appear here for approval.</span></div>` : ""}
      </div>
      <p class="session-guest-live-status" id="sessionGuestLiveStatus" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(local.sessionGuestStatus)}</p>
    </div>
  `;
}

function sessionView() {
  const { project, session } = local.appState;
  const isLive = session.status === "live";
  const wasEnded = session.status === "ended";
  const hasInvite = Boolean(session.inviteUrl);
  const inviteState = tunnelInviteState(session);
  const headerPhase = isLive
    ? inviteState.phase
    : local.sessionStartBusy
      ? "pending"
      : "idle";
  const headerStatusLabel = isLive
    ? inviteState.phase === "ready"
      ? "Live"
      : inviteState.phase === "failed"
        ? "Link issue"
        : "Preparing link"
    : local.sessionStartBusy
      ? "Starting"
      : wasEnded
        ? "Ended"
        : "Not started";
  const providers = availableTunnelProviders(session);
  const selectedProviderId = sessionTunnelProviderId(session);
  const canRefreshInvite = providers.length > 0 && !local.tunnelProviderSwitchBusy;
  const providerHint = sessionTunnelProviderHint(session, selectedProviderId);
  const refreshActionLabel = local.tunnelProviderSwitchBusy ? "Refreshing..." : "Refresh link";
  const visibleInviteUrl = compactInviteUrl(session.inviteUrl || "");
  const projectFileCount = project.files.filter((item) => item.type !== "directory").length;
  return windowShell(`
    <div class="session-share-page">
      <header class="session-share-head">
        <button class="btn session-back-button" id="backHome" title="Back to home">
          ${icon("back")} <span>Back to Home</span>
        </button>
        <div class="session-share-heading">
          <span class="pill session-state-pill phase-${headerPhase}">
            <span class="session-signal-bars" aria-hidden="true">
              <span></span><span></span><span></span><span></span>
            </span>
            <span>${headerStatusLabel}</span>
          </span>
          <h2>Host session</h2>
          <p>${isLive ? `${escapeHtml(project.name)} is ready to share.` : wasEnded ? "Sharing has stopped. Your project is still open on this computer." : `Start sharing ${escapeHtml(project.name)} when you are ready.`}</p>
        </div>
        ${isLive ? `<button class="btn btn-primary session-header-editor-button" id="openEditorFromSession" ${project.mainFile ? "" : "disabled"}>Open Editor</button>` : ""}
      </header>

      <div class="session-share-grid">
        <main class="session-share-main">
          <section class="session-invite-panel">
            <div class="session-panel-title">${isLive ? "Share one invite link" : wasEnded ? "Session ended" : "Start sharing"}</div>
            ${isLive
              ? `<div class="session-link-state phase-${inviteState.phase}" aria-live="polite">
                  <span class="session-signal-bars session-link-signal" aria-hidden="true">
                    <span></span><span></span><span></span><span></span>
                  </span>
                  <div>
                    <strong>${escapeHtml(inviteState.title)}</strong>
                    <span>${escapeHtml(inviteState.detail)}</span>
                  </div>
                </div>
                ${hasInvite ? `<div class="copy-box session-copy-box">
                  <div class="copy-row">
                    <code title="${escapeHtml(session.inviteUrl)}">${escapeHtml(visibleInviteUrl)}</code>
                    <button class="btn session-copy-button" id="copyInvite" title="Copy full invite link" aria-label="Copy full invite link">Copy link</button>
                  </div>
                  <p class="session-link-meta">Shortened for display. Copy keeps the complete verified link.</p>
                </div>` : ""}
                <p class="session-share-instruction"><strong>Send only this link.</strong> Your friend asks to join, then you approve access.</p>
                <div class="session-provider-control">
                  <div class="session-provider-choice">
                    ${sessionTunnelProviderPickerMarkup(session, selectedProviderId, local.tunnelProviderSwitchBusy)}
                    <span class="session-provider-hint">${escapeHtml(providerHint)}</span>
                  </div>
                  <button class="btn session-refresh-button" id="refreshInviteLink" ${canRefreshInvite ? "" : "disabled"} aria-busy="${local.tunnelProviderSwitchBusy ? "true" : "false"}">${uiGlyph("refresh")} ${refreshActionLabel}</button>
                </div>
                <div class="session-invite-actions">
                  <p class="session-refresh-note">Refreshing replaces the current invite link immediately. Anyone with the old link will need the new one.</p>
                  <div class="session-stop-row">
                    <span>End access for everyone without leaving this screen.</span>
                    <button class="btn btn-danger session-stop-button" id="stopSession" ${local.sessionStopBusy ? "disabled" : ""}>${uiGlyph("stop")} ${local.sessionStopBusy ? "Stopping..." : "Stop sharing"}</button>
                  </div>
                </div>`
              : `<div class="session-empty-panel">
                  <div class="session-empty-copy">
                    <div class="session-empty-icon">${uiGlyph("users")}</div>
                    <div>
                      <strong>${wasEnded ? "Sharing is off" : "No session is running"}</strong>
                      <span>${wasEnded ? "The old invite link no longer works. Start again when you want to share." : "LocalLeaf will show one link after it has been verified."}</span>
                    </div>
                  </div>
                  <button class="btn btn-primary" data-start-session ${local.sessionStartBusy ? "disabled" : ""}>${uiGlyph("users")} ${local.sessionStartBusy ? "Starting..." : wasEnded ? "Host again" : "Start hosting"}</button>
                </div>
                <div class="session-provider-control session-provider-control-idle">
                  <div class="session-provider-choice">
                    ${sessionTunnelProviderPickerMarkup(session, selectedProviderId)}
                    <span class="session-provider-hint">${escapeHtml(providerHint)}</span>
                  </div>
                </div>
                <p class="session-share-instruction"><strong>One verified link, one approval step.</strong> You decide who enters.</p>`}
          </section>
        </main>

        <aside class="session-share-side">
          <section class="session-side-card">
            <div class="session-project-summary">
              <strong>${escapeHtml(project.name)}</strong>
              <span>${projectFileCount} ${projectFileCount === 1 ? "file" : "files"} · ${escapeHtml(project.sizeLabel)}</span>
            </div>
            <div class="session-side-divider"></div>
            ${isLive ? sessionGuestManagerMarkup(session) : `<div class="session-panel-title">Shared access</div><p class="session-inactive-access">No guests can access this project while sharing is off.</p>`}
          </section>
        </aside>
      </div>
    </div>
  `, { rail: true, active: "session", dashboard: true, wide: true });
}

function requestMarkup(request) {
  return `
    <div class="request-row">
      <div class="avatar">${escapeHtml(request.name[0] || "?")}</div>
      <div><p>${escapeHtml(request.name)} wants to join.</p><small>Requested editor access</small></div>
      <button class="btn btn-primary approve-request" data-id="${request.id}" style="height:34px">Allow</button>
      <button class="btn deny-request" data-id="${request.id}" style="height:34px">Deny</button>
    </div>
  `;
}

function showEditorJoinRequest(request) {
  if (!request?.id || local.shownJoinRequests.has(request.id)) return;
  local.shownJoinRequests.add(request.id);
  document.querySelector(".join-toast")?.remove();
  const shell = document.querySelector(".editor-shell") || app;
  shell.insertAdjacentHTML("beforeend", `
    <section class="join-toast" role="dialog" aria-live="polite" aria-label="Join request">
      <div class="avatar">${escapeHtml(request.name?.[0] || "?")}</div>
      <div class="join-toast-copy">
        <strong>${escapeHtml(request.name || "Someone")} wants to join</strong>
        <span>Choose Viewer or Maintainer access in Host session.</span>
      </div>
      <button class="btn btn-primary" data-toast-review="${escapeHtml(request.id)}" style="height:32px">Review</button>
      <button class="btn" data-toast-deny="${escapeHtml(request.id)}" style="height:32px">Deny</button>
    </section>
  `);
  const toast = document.querySelector(".join-toast");
  toast?.querySelector("[data-toast-review]")?.addEventListener("click", () => {
    local.sessionGuestFocusPending = true;
    setView("session");
  });
  toast?.querySelector("[data-toast-deny]")?.addEventListener("click", async (event) => {
    await api("/api/join/deny", { method: "POST", body: { requestId: event.currentTarget.dataset.toastDeny } });
    toast.remove();
    await loadState();
  });
}

function shouldShowUpdateToast() {
  if (isGuestClient()) return false;
  if (!local.updateInfo?.updateAvailable || !local.updateInfo.latestVersion) return false;
  if (local.updateDismissedVersion === local.updateInfo.latestVersion) return false;
  return !["join", "waiting"].includes(route().view);
}

function canInstallUpdateFromDesktop() {
  return typeof window.localleafDesktop?.installUpdate === "function";
}

function updateToastMarkup() {
  const info = local.updateInfo || {};
  const targetUrl = info.downloadUrl || info.releaseUrl || "https://github.com/sethwhenton/localleaf/releases/latest";
  const canInstall = canInstallUpdateFromDesktop();
  const status = local.updateInstallStatus
    ? `<small class="update-toast-status">${escapeHtml(local.updateInstallStatus)}</small>`
    : `<small class="update-toast-status">Download from ${escapeHtml(info.assetName || "the latest release")}.</small>`;
  const action = canInstall
    ? `<button class="btn btn-primary update-toast-action" data-install-update type="button" ${local.updateInstalling ? "disabled" : ""}>
        ${local.updateInstalling ? "Downloading..." : "Install update"}
      </button>`
    : `<a class="btn btn-primary update-toast-action" href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener">Download</a>`;
  return `
    <section class="update-toast" role="status" aria-live="polite" aria-label="LocalLeaf update available">
      <div class="update-toast-icon">${icon("download")}</div>
      <div class="update-toast-copy">
        <strong>Update available</strong>
        <span>LocalLeaf v${escapeHtml(info.latestVersion)} is ready. You are on v${escapeHtml(info.currentVersion || "")}.</span>
        ${status}
      </div>
      ${action}
      <button class="icon-button update-toast-close" data-dismiss-update title="Later" aria-label="Dismiss update notice">x</button>
    </section>
  `;
}

function appNoticeMarkup(notice, belowUpdate = false) {
  if (!notice?.message) return "";
  const type = notice.type || "info";
  const iconText = type === "error" ? "!" : type === "success" ? "✓" : "i";
  return `
    <section class="app-notice app-notice-${escapeHtml(type)} ${belowUpdate ? "below-update" : ""}" role="status" aria-live="polite">
      <div class="app-notice-icon" aria-hidden="true">${escapeHtml(iconText)}</div>
      <div class="app-notice-copy">
        <strong>${escapeHtml(notice.title || "LocalLeaf")}</strong>
        <span>${escapeHtml(notice.message)}</span>
        ${notice.detail ? `<small>${escapeHtml(notice.detail)}</small>` : ""}
      </div>
      <button class="icon-button app-notice-close" data-dismiss-app-notice title="Dismiss" aria-label="Dismiss notice">x</button>
    </section>
  `;
}

function renderAppNotice() {
  document.querySelector(".app-notice")?.remove();
  if (!local.appNotice) return;
  const belowUpdate = Boolean(document.querySelector(".update-toast"));
  app.insertAdjacentHTML("beforeend", appNoticeMarkup(local.appNotice, belowUpdate));
  document.querySelector("[data-dismiss-app-notice]")?.addEventListener("click", () => {
    clearTimeout(local.appNoticeTimer);
    local.appNotice = null;
    renderAppNotice();
  });
}

function showAppNotice(message, options = {}) {
  clearTimeout(local.appNoticeTimer);
  const id = Date.now();
  local.appNotice = {
    id,
    kind: options.kind || "",
    type: options.type || "info",
    title: options.title || "LocalLeaf",
    message: String(message || "Something went wrong."),
    detail: options.detail || ""
  };
  renderAppNotice();
  const timeoutMs = Number(options.timeoutMs ?? 7200);
  if (timeoutMs > 0) {
    local.appNoticeTimer = setTimeout(() => {
      if (local.appNotice?.id === id) {
        local.appNotice = null;
        renderAppNotice();
      }
    }, timeoutMs);
  }
}

function showImportError(message, detail = "") {
  const text = String(message || "Import failed.");
  if (route().view === "home") {
    local.homeImportStatus = text;
  }
  showAppNotice(text, {
    type: "error",
    title: "Import failed",
    detail
  });
}

function renderUpdateToast() {
  document.querySelector(".update-toast")?.remove();
  if (!shouldShowUpdateToast()) return;
  app.insertAdjacentHTML("beforeend", updateToastMarkup());
  document.querySelector("[data-dismiss-update]")?.addEventListener("click", () => {
    local.updateDismissedVersion = local.updateInfo.latestVersion;
    localStorage.setItem("localleaf.updateDismissedVersion", local.updateDismissedVersion);
    document.querySelector(".update-toast")?.remove();
  });
  document.querySelector("[data-install-update]")?.addEventListener("click", installLatestUpdate);
  renderAppNotice();
}

function updateUpdateCheckButtons() {
  document.querySelectorAll("[data-check-updates]").forEach((button) => {
    button.disabled = local.updateChecking;
    button.classList.toggle("is-checking", local.updateChecking);
    button.setAttribute("aria-busy", local.updateChecking ? "true" : "false");
    const label = button.querySelector("[data-update-label]");
    if (label) label.textContent = local.updateChecking ? "Checking for updates..." : button.dataset.defaultLabel || "Check for updates";
  });
}

function markUpdateButtonFeedback(button, message) {
  if (!button || !message) return;
  const label = button.querySelector("[data-update-label]");
  if (!label) return;
  const defaultLabel = button.dataset.defaultLabel || "Check for updates";
  label.textContent = message;
  setTimeout(() => {
    if (!local.updateChecking) label.textContent = defaultLabel;
  }, 1500);
}

async function checkForUpdates(options = {}) {
  const manual = Boolean(options.manual);
  if (!manual && !local.autoUpdateChecks) return "disabled";
  if (isGuestClient() || local.updateChecking) return "skipped";
  if (!manual && local.updateCheckStarted) return "skipped";
  if (!manual) local.updateCheckStarted = true;
  local.updateChecking = true;
  updateUpdateCheckButtons();
  try {
    const info = await api("/api/update/latest", { timeoutMs: 9000 });
    if (!info || info.error) return "silent";
    local.updateInfo = info;
    if (info?.updateAvailable) {
      if (manual) {
        local.updateDismissedVersion = "";
        localStorage.removeItem("localleaf.updateDismissedVersion");
      }
      renderUpdateToast();
      return "available";
    }
    return "current";
  } catch {
    return "silent";
  } finally {
    local.updateChecking = false;
    updateUpdateCheckButtons();
  }
}

async function manualCheckForUpdates(event) {
  const button = event?.currentTarget;
  const result = await checkForUpdates({ manual: true });
  if (result === "current") {
    markUpdateButtonFeedback(button, "Up to date");
  } else if (result === "available") {
    markUpdateButtonFeedback(button, "Update ready");
  } else if (result === "silent") {
    markUpdateButtonFeedback(button, "Could not check");
  }
}

async function installLatestUpdate(event) {
  const info = local.updateInfo || {};
  const downloadUrl = info.downloadUrl || "";
  if (!downloadUrl) {
    local.updateInstallStatus = "Could not find a download for this computer.";
    renderUpdateToast();
    return;
  }
  if (!canInstallUpdateFromDesktop()) {
    window.open(downloadUrl, "_blank", "noopener");
    return;
  }

  local.updateInstalling = true;
  local.updateInstallStatus = "Downloading the installer...";
  renderUpdateToast();
  try {
    await window.localleafDesktop.installUpdate({
      downloadUrl,
      latestVersion: info.latestVersion,
      version: info.latestVersion,
      assetName: info.assetName
    });
    local.updateInstallStatus = "Installer opened. Follow the prompts to finish updating.";
  } catch (error) {
    local.updateInstallStatus = error?.message || "Could not download the update.";
  } finally {
    local.updateInstalling = false;
    renderUpdateToast();
    event?.currentTarget?.focus?.();
  }
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  local.theme = nextTheme;
  localStorage.setItem("localleaf.theme", nextTheme);
  document.documentElement.classList.toggle("theme-dark", nextTheme === "dark");
  document.documentElement.classList.toggle("theme-light", nextTheme !== "dark");
  syncDesktopTheme(nextTheme);
}

function syncDesktopTheme(theme) {
  window.localleafDesktop?.setTheme?.(theme === "dark" ? "dark" : "light");
}

function setAutoUpdateChecks(enabled) {
  local.autoUpdateChecks = Boolean(enabled);
  localStorage.setItem("localleaf.autoUpdateChecks", local.autoUpdateChecks ? "1" : "0");
}

function setJoinRequestSoundEnabled(enabled) {
  local.joinRequestSoundEnabled = Boolean(enabled);
  localStorage.setItem("localleaf.joinRequestSoundEnabled", local.joinRequestSoundEnabled ? "1" : "0");
  if (local.joinRequestSoundEnabled) preloadJoinRequestSound();
}

function joinRequestSound() {
  if (typeof Audio !== "function") return null;
  if (!local.joinRequestAudio) {
    local.joinRequestAudio = new Audio(JOIN_REQUEST_SOUND_URL);
    local.joinRequestAudio.preload = "auto";
    local.joinRequestAudio.volume = 0.42;
  }
  return local.joinRequestAudio;
}

function preloadJoinRequestSound() {
  const audio = joinRequestSound();
  if (!audio) return;
  try {
    audio.load();
  } catch {
    // Notification audio is a small enhancement; failures should never block collaboration.
  }
}

function playJoinRequestSound(request) {
  if (!local.joinRequestSoundEnabled || isGuestClient()) return;
  if (request?.id) {
    if (local.notifiedJoinRequests.has(request.id)) return;
    local.notifiedJoinRequests.add(request.id);
  }
  const audio = joinRequestSound();
  if (!audio) return;
  try {
    audio.pause();
    audio.currentTime = 0;
    audio.play()?.catch(() => {});
  } catch {
    // Browsers can block audio until a user gesture. The visual join toast still appears.
  }
}

function installModalFocusManagement(backdrop, returnFocus) {
  if (!backdrop) return;
  backdrop._localleafReturnFocus = returnFocus instanceof HTMLElement ? returnFocus : null;
  backdrop.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...backdrop.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !backdrop.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !backdrop.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });
}

function removeModal(backdrop, options = {}) {
  if (!backdrop) return;
  const returnFocus = backdrop._localleafReturnFocus;
  backdrop.remove();
  if (options.restoreFocus !== false) {
    const focusTarget = returnFocus?.isConnected
      ? returnFocus
      : options.fallbackFocusSelector
        ? document.querySelector(options.fallbackFocusSelector)
        : null;
    if (focusTarget) window.setTimeout(() => focusTarget.focus({ preventScroll: true }), 0);
  }
}

function hideSettingsModal(options = {}) {
  removeModal(document.querySelector(".settings-modal-backdrop"), options);
}

function settingsTabButton(section, label) {
  const active = local.settingsSection === section;
  return `<button type="button" class="settings-tab ${active ? "active" : ""}" id="settingsTab-${escapeHtml(section)}" role="tab" aria-selected="${active ? "true" : "false"}" aria-controls="settingsPanel-${escapeHtml(section)}" tabindex="${active ? "0" : "-1"}" data-settings-section="${escapeHtml(section)}">${escapeHtml(label)}</button>`;
}

function themeSwitchMarkup() {
  const isDark = local.theme === "dark";
  return `
    <button class="settings-theme-switch ${isDark ? "is-dark" : "is-light"}" id="themeModeSwitch" type="button" role="switch" aria-checked="${isDark ? "true" : "false"}" aria-label="Dark mode" title="${isDark ? "Switch to light mode" : "Switch to dark mode"}">
      <span class="settings-theme-thumb" aria-hidden="true"></span>
      <span class="settings-theme-option settings-theme-sun" aria-hidden="true">
        <span class="settings-theme-icon-bound">
          <svg class="settings-theme-icon" data-theme-icon="sun" viewBox="0 0 24 24" width="18" height="18" fill="none" focusable="false" aria-hidden="true">
            <circle cx="12" cy="12" r="3.25"></circle>
            <path d="M12 2.75v2M12 19.25v2M2.75 12h2M19.25 12h2M5.46 5.46l1.42 1.42M17.12 17.12l1.42 1.42M18.54 5.46l-1.42 1.42M6.88 17.12l-1.42 1.42"></path>
          </svg>
        </span>
      </span>
      <span class="settings-theme-option settings-theme-moon" aria-hidden="true">
        <span class="settings-theme-icon-bound">
          <svg class="settings-theme-icon" data-theme-icon="moon" viewBox="0 0 24 24" width="18" height="18" fill="none" focusable="false" aria-hidden="true">
            <path d="M19.75 15.35A8 8 0 0 1 8.65 4.25a8 8 0 1 0 11.1 11.1Z"></path>
          </svg>
        </span>
      </span>
      <span class="sr-only" data-theme-current>${isDark ? "Dark mode is on" : "Dark mode is off"}</span>
    </button>
  `;
}

function settingToggleMarkup(key, title, detail, options = {}) {
  return `
    <section class="settings-list-row permission-list-row ${options.warning ? "permission-warning" : ""}" aria-labelledby="${escapeHtml(key)}Title">
      <div class="settings-list-main">
        <div>
          <strong id="${escapeHtml(key)}Title">${escapeHtml(title)}</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
      </div>
      ${miniSwitchMarkup({ checked: local.aiPermissions[key], label: title, attrs: `data-ai-permission="${escapeHtml(key)}" aria-labelledby="${escapeHtml(key)}Title"` })}
    </section>
  `;
}

function miniSwitchMarkup({ checked = false, disabled = false, label = "", attrs = "" } = {}) {
  return `
    <label class="settings-mini-switch" ${label ? `title="${escapeHtml(label)}"` : ""}>
      <input type="checkbox" ${label ? `aria-label="${escapeHtml(label)}"` : ""} ${attrs} ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span aria-hidden="true"></span>
    </label>
  `;
}

function settingsGeneralMarkup() {
  const tunnelProviders = availableTunnelProviders();
  const preferredProvider = selectedTunnelProvider();
  return `
    <section class="settings-general settings-compact-page">
      <header class="settings-general-hero settings-section-intro">
        <span class="settings-general-mark" aria-hidden="true">${uiGlyph("settings")}</span>
        <div>
          <h3>Workspace defaults</h3>
          <p>Choose how LocalLeaf behaves on this computer.</p>
        </div>
      </header>
      <div class="settings-list-card settings-general-card">
        <section class="settings-list-row settings-theme-row">
          <div class="settings-list-main">
            <div>
              <strong>Appearance</strong>
              <span>Use the mode that feels best while editing and previewing PDFs.</span>
            </div>
          </div>
          ${themeSwitchMarkup()}
        </section>
        <section class="settings-list-row">
          <div class="settings-list-main">
            <div>
              <strong>Join request sound</strong>
              <span>Play a soft chime when someone asks to join your hosted session.</span>
            </div>
          </div>
          ${miniSwitchMarkup({ checked: local.joinRequestSoundEnabled, label: "Join request sound", attrs: `id="joinRequestSound"` })}
        </section>
        <section class="settings-list-row settings-tunnel-provider-row">
          <div class="settings-list-main">
            <div>
              <strong>Default invite-link provider</strong>
              <span>${escapeHtml(preferredProvider?.hint || "Automatic keeps the first provider that produces a verified public link.")}</span>
            </div>
          </div>
          <select class="settings-tunnel-provider-select" id="defaultTunnelProvider" aria-label="Default invite-link provider" ${tunnelProviders.length ? "" : "disabled"}>
            ${tunnelProviderOptionsMarkup()}
          </select>
        </section>
        <section class="settings-list-row">
          <div class="settings-list-main">
            <div>
              <strong>Auto-check updates</strong>
              <span>Quietly check the LocalLeaf release page when the app opens.</span>
            </div>
          </div>
          ${miniSwitchMarkup({ checked: local.autoUpdateChecks, label: "Auto-check updates", attrs: `id="autoUpdateChecks"` })}
        </section>
      </div>
    </section>
  `;
}

function localModelCardMarkup(model, activeId) {
  const status = modelStatus(model);
  const isActive = activeId === model.id && activeAiProviderModel().providerId === "localleaf-local";
  const busy = local.modelActionBusy === model.id;
  const progress = Math.round(Number(model.progress || 0));
  const statusLabel = isActive
    ? "Active"
    : status === "available"
      ? "Available"
      : status === "downloading"
        ? "Downloading"
        : status === "paused"
          ? "Paused"
          : status === "failed"
            ? "Failed"
            : "Installed";
  const statusTone = isActive ? "active" : status;
  const bytesLabel = model.bytesReceived || model.totalBytes
    ? `${formatFileSize(model.bytesReceived || 0)} / ${formatFileSize(model.totalBytes || model.expectedBytes || 0)}`
    : model.sizeLabel || "";
  const contextTokens = model.contextWindow?.effectiveTokens || model.contextWindowTokens || null;
  const contextMode = model.contextWindow?.mode === "advanced_override" ? "Advanced" : "Automatic";
  return `
    <article class="local-model-card local-model-${escapeHtml(status)} ${isActive ? "is-active" : ""}">
      <div class="local-model-identity">
        <span class="local-model-icon" aria-hidden="true"><span></span></span>
        <div class="local-model-copy">
          <div class="local-model-title-row">
            <h3>${escapeHtml(model.name)}</h3>
            <span class="local-model-state local-model-state-${escapeHtml(statusTone)}"><i></i>${escapeHtml(statusLabel)}</span>
          </div>
          <p>${escapeHtml(model.description || "")}</p>
          <div class="local-model-meta">
            <span>${escapeHtml(model.sizeLabel || "")}</span>
            ${contextTokens ? `<span class="local-model-context">${contextMode} context · ${escapeHtml(formatCompactContextTokens(contextTokens))}</span>` : ""}
            ${status === "failed" ? `<span class="local-model-problem">Download did not finish</span>` : ""}
          </div>
        </div>
      </div>
      <div class="local-model-actions">
        ${status === "installed"
          ? `<button class="icon-button local-model-delete" data-delete-model="${escapeHtml(model.id)}" ${busy ? "disabled" : ""} title="Delete model" aria-label="Delete model">${editorToolIcon("delete")}</button>`
          : status === "downloading"
            ? `
              <button class="icon-button" data-pause-model="${escapeHtml(model.id)}" title="Pause download" aria-label="Pause download">${uiGlyph("pause")}</button>
              <button class="icon-button local-model-delete" data-cancel-model="${escapeHtml(model.id)}" title="Stop and remove partial download" aria-label="Stop and remove partial download">${uiGlyph("stop")}</button>
            `
            : status === "paused"
              ? `
                <button class="icon-button" data-download-model="${escapeHtml(model.id)}" title="Resume download" aria-label="Resume download">${uiGlyph("play")}</button>
                <button class="icon-button local-model-delete" data-cancel-model="${escapeHtml(model.id)}" title="Delete partial download" aria-label="Delete partial download">${editorToolIcon("delete")}</button>
              `
              : `<button class="btn btn-primary local-model-download" data-download-model="${escapeHtml(model.id)}" ${busy ? "disabled" : ""}>${uiGlyph("download")} Download</button>`}
      </div>
      ${status === "downloading" || status === "paused" ? `
        <div class="local-model-progress" style="--local-model-progress: ${Math.max(0, Math.min(100, progress))}%;">
          <div><strong>${status === "paused" ? "Paused" : "Downloading"}</strong><span>${progress}% ${escapeHtml(bytesLabel)}</span></div>
          <progress value="${progress}" max="100"></progress>
        </div>
      ` : ""}
    </article>
  `;
}

function providerRowMarkup(provider) {
  const firstModel = providerModelEntries(provider)[0] || { id: "default", name: "Default" };
  const test = local.providerInlineTests[provider.id] || provider.test;
  const enabled = isProviderEnabled(provider);
  return `
    <div class="settings-list-row provider-row">
      <div class="settings-list-main">
        ${providerLogoMarkup(provider)}
        <div>
          <strong>${escapeHtml(provider.name)}</strong>
          <span>${escapeHtml(provider.baseUrl || provider.description || "Connected provider")}</span>
          ${test?.message ? `<small class="provider-test-result ${escapeHtml(test.color || (test.ok ? "green" : "red"))}" data-provider-test-slot="${escapeHtml(provider.id)}">${escapeHtml(test.message)}</small>` : `<small class="provider-test-result muted" data-provider-test-slot="${escapeHtml(provider.id)}" hidden></small>`}
        </div>
      </div>
      <div class="settings-list-actions">
        <span class="settings-status-tag">${escapeHtml(provider.custom ? "Custom" : "API key")}</span>
        ${miniSwitchMarkup({ checked: enabled, label: enabled ? "Provider enabled" : "Provider disabled", attrs: `data-provider-enabled="${escapeHtml(provider.id)}"` })}
        <button class="btn" data-test-provider="${escapeHtml(provider.id)}" data-test-model="${escapeHtml(firstModel.id)}">${local.providerTestBusy === provider.id ? "Testing..." : "Test"}</button>
        <button class="btn" data-edit-provider="${escapeHtml(provider.id)}">Edit</button>
        <button class="btn" data-delete-provider="${escapeHtml(provider.id)}">Disconnect</button>
      </div>
    </div>
  `;
}

function popularProviderRowMarkup(provider) {
  return `
    <div class="settings-list-row provider-row">
      <div class="settings-list-main">
        ${providerLogoMarkup(provider)}
        <div>
          <strong>${escapeHtml(provider.name)}</strong>
          <span>${escapeHtml(provider.description || provider.baseUrl || "OpenAI-compatible provider")}</span>
        </div>
      </div>
      <div class="settings-list-actions">
        <span class="settings-status-tag">${provider.id === "opencode-go" ? "Recommended" : provider.custom ? "Custom" : "Preset"}</span>
        <button class="btn" data-connect-provider="${escapeHtml(provider.id)}">${uiGlyph("plus")} Connect</button>
      </div>
    </div>
  `;
}

function settingsProvidersMarkup() {
  const connected = connectedAiProviders();
  const popular = popularAiProviders();
  return `
    <section class="settings-compact-page">
      <h3 class="settings-model-heading">Connected providers</h3>
      <div class="settings-list-card">
        ${connected.length ? connected.map(providerRowMarkup).join("") : `<div class="settings-empty-row">No providers connected yet.</div>`}
      </div>
      <h3 class="settings-model-heading">Popular providers</h3>
      <div class="settings-list-card">
        ${popular.slice(0, 8).map(popularProviderRowMarkup).join("")}
      </div>
    </section>
  `;
}

function modelListRowMarkup(provider, model) {
  const enabled = isModelEnabled(provider.id, model.id);
  const active = activeAiProviderModel();
  const isActive = active.providerId === provider.id && active.modelId === model.id;
  return `
    <div class="settings-list-row model-toggle-row">
      <div class="settings-list-main settings-model-toggle-main">
        <strong>${escapeHtml(model.name)}</strong>
        ${miniSwitchMarkup({ checked: enabled, label: enabled ? "Model shown in picker" : "Model hidden from picker", attrs: `data-model-enabled-provider="${escapeHtml(provider.id)}" data-model-enabled-id="${escapeHtml(model.id)}"` })}
        <span class="settings-model-context">Provider managed</span>
        ${isActive ? `<span class="settings-status-tag">Active</span>` : ""}
      </div>
    </div>
  `;
}

function providerModelGroupMarkup(provider) {
  const query = local.settingsModelSearch.trim().toLowerCase();
  const providerEnabled = isProviderEnabled(provider);
  const models = providerModelEntries(provider).filter((model) => {
    if (!query) return true;
    return `${provider.name} ${model.name} ${model.id}`.toLowerCase().includes(query);
  });
  if (!models.length) return "";
  const open = isProviderModelGroupOpen(provider.id);
  const panelId = `settings-provider-models-${encodeURIComponent(String(provider.id || "provider"))}`;
  return `
    <section class="settings-model-group settings-provider-model-group ${providerEnabled ? "" : "provider-disabled"} ${open ? "open" : "collapsed"}">
      <div class="settings-provider-model-head">
        <div class="settings-provider-model-title">
          ${providerLogoMarkup(provider)}
          <strong>${escapeHtml(provider.name)}</strong>
          ${miniSwitchMarkup({ checked: providerEnabled, label: providerEnabled ? "Provider shown in picker" : "Provider hidden from picker", attrs: `data-provider-enabled="${escapeHtml(provider.id)}" data-provider-toggle-scope="models"` })}
        </div>
        <button class="settings-provider-disclosure ${open ? "open" : ""}" type="button" data-toggle-provider-model-group="${escapeHtml(provider.id)}" data-provider-model-name="${escapeHtml(provider.name)}" aria-expanded="${open ? "true" : "false"}" aria-controls="${escapeHtml(panelId)}" title="${open ? "Collapse models" : "Expand models"}" aria-label="${open ? "Collapse" : "Expand"} ${escapeHtml(provider.name)} models">
          ${editorToolIcon("chevronDown")}
        </button>
      </div>
      <div class="settings-list-card settings-provider-models" id="${escapeHtml(panelId)}" ${open ? "" : "hidden"}>
        ${models.map((model) => modelListRowMarkup(provider, model)).join("")}
      </div>
    </section>
  `;
}

function localModelListMarkup(activeId) {
  const models = aiModels();
  if (!models.length) return "";
  const state = aiState();
  return `
    <section class="settings-model-group local-model-section">
      <div class="settings-model-group-head local-model-head">
        <div class="local-model-heading">
          <h3>Local models</h3>
          <p>Download once. Run privately on this computer.</p>
        </div>
        <button class="settings-storage-chip" id="chooseModelFolder" type="button" title="${escapeHtml(state.storagePathLabel || state.storagePath || "Default LocalLeafModel folder")}">
          ${uiGlyph("folder")} <span>${escapeHtml(state.storagePathLabel || state.storagePath || "Default storage")}</span>
        </button>
      </div>
      <div class="settings-model-card-list">
        ${models.map((model) => localModelCardMarkup(model, activeId)).join("")}
      </div>
    </section>
  `;
}

function settingsModelsMarkup() {
  const state = aiState();
  const activeId = state.activeModelId || state.activeModel || "";
  const connected = connectedAiProviders();
  const providerGroups = connected.map(providerModelGroupMarkup).filter(Boolean).join("");
  return `
    <section class="settings-models settings-compact-page">
      <div class="settings-model-tools">
        <label class="settings-model-search-wrap" for="settingsModelSearch">
          <span class="sr-only">Search models</span>
          ${editorToolIcon("search")}
          <input class="settings-model-search" id="settingsModelSearch" type="search" value="${escapeHtml(local.settingsModelSearch)}" placeholder="Search models" autocomplete="off" />
        </label>
        <div class="settings-model-toolbar">
          <button class="btn" id="bringYourOwnKey" type="button">${uiGlyph("plus")} Connect provider</button>
          <button class="btn" id="configureCustomModel" type="button">${uiGlyph("settings")} Custom</button>
        </div>
      </div>
      <h3 class="settings-model-heading">Provider models</h3>
      ${providerGroups || `<div class="settings-empty-row">Connect a provider to show hosted models here.</div>`}
      ${localModelListMarkup(activeId)}
    </section>
  `;
}

function settingsPermissionsMarkup() {
  return `
    <section class="settings-permission-page settings-compact-page">
      <header class="settings-permission-note settings-section-intro">
        <span class="settings-general-mark" aria-hidden="true">${uiGlyph("ai")}</span>
        <div>
          <strong>AI Helper permissions</strong>
          <span>Control what the active model may propose or apply for each request.</span>
        </div>
      </header>
      <h3 class="settings-model-heading">Edit Flow</h3>
      <div class="settings-permission-list settings-list-card">
        ${settingToggleMarkup("askBeforeEdits", "Default permissions", "Show approval cards before LocalLeaf writes any proposed file change.")}
        ${settingToggleMarkup("yoloMode", "YOLO mode", "Auto-apply approved-safe text edits from the AI Helper without approval cards.", { warning: true })}
        ${settingToggleMarkup("rewriteTools", "Rewrite tools", "Allow selected text rewriting and clarity improvements.")}
        ${settingToggleMarkup("multiFileEdits", "Multi-file edits", "Allow proposals that touch more than one text file.", { warning: true })}
      </div>
      <h3 class="settings-model-heading">Model Routing</h3>
      <div class="settings-permission-list settings-list-card">
        ${settingToggleMarkup("localModelOnly", "Local model only", "Keep AI requests on this computer and block hosted providers from the AI chat.")}
      </div>
      <h3 class="settings-model-heading">Advanced Actions</h3>
      <div class="settings-permission-list settings-list-card">
        ${settingToggleMarkup("fileManagement", "Create, rename, move, and delete", "Allow project file-management requests. New files always require host approval.", { warning: true })}
        ${settingToggleMarkup("fileUploads", "Uploads and imports", "Allow the AI Helper to discuss upload/import actions for project assets.", { warning: true })}
        ${settingToggleMarkup("shellCommands", "Shell commands", "Allow command or terminal requests to reach the active model.", { warning: true })}
        ${settingToggleMarkup("binaryFiles", "Binary files", "Allow binary-file requests such as images, PDFs, or other assets.", { warning: true })}
      </div>
    </section>
  `;
}

function showSettingsModal(section = "general") {
  const existingModal = document.querySelector(".settings-modal-backdrop");
  const returnFocus = existingModal?._localleafReturnFocus || document.activeElement;
  removeModal(existingModal, { restoreFocus: false });
  const allowedSections = new Set(["general", "providers", "models", "permissions"]);
  local.settingsSection = allowedSections.has(section) ? section : "general";
  const shell = document.querySelector(".editor-shell") || app;
  shell.insertAdjacentHTML("beforeend", `
    <div class="settings-modal-backdrop" role="presentation">
      <section class="settings-modal settings-modal-wide settings-preferences-modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle" aria-describedby="settingsSubtitle">
        <div class="settings-modal-head">
          <div>
            <h2 id="settingsTitle">LocalLeaf Settings</h2>
            <p id="settingsSubtitle">Workspace, provider, model, and AI preferences.</p>
          </div>
          <button class="icon-button dialog-close-button" data-close-settings title="Close settings" aria-label="Close settings"><svg class="dialog-close-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button>
        </div>
        <div class="settings-tabs" role="tablist" aria-label="Settings sections">
          ${settingsTabButton("general", "General")}
          ${settingsTabButton("providers", "Providers")}
          ${settingsTabButton("models", "Models")}
          ${settingsTabButton("permissions", "AI Permissions")}
        </div>
        <div class="settings-options">
          <div class="settings-section" id="settingsPanel-general" role="tabpanel" aria-labelledby="settingsTab-general" tabindex="0" data-settings-panel="general" ${local.settingsSection === "general" ? "" : "hidden"}>
            ${settingsGeneralMarkup()}
          </div>
          <div class="settings-section" id="settingsPanel-models" role="tabpanel" aria-labelledby="settingsTab-models" tabindex="0" data-settings-panel="models" ${local.settingsSection === "models" ? "" : "hidden"}>
            ${settingsModelsMarkup()}
          </div>
          <div class="settings-section" id="settingsPanel-providers" role="tabpanel" aria-labelledby="settingsTab-providers" tabindex="0" data-settings-panel="providers" ${local.settingsSection === "providers" ? "" : "hidden"}>
            ${settingsProvidersMarkup()}
          </div>
          <div class="settings-section" id="settingsPanel-permissions" role="tabpanel" aria-labelledby="settingsTab-permissions" tabindex="0" data-settings-panel="permissions" ${local.settingsSection === "permissions" ? "" : "hidden"}>
            ${settingsPermissionsMarkup()}
          </div>
        </div>
      </section>
    </div>
  `);

  const modal = document.querySelector(".settings-modal-backdrop");
  installModalFocusManagement(modal, returnFocus);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) hideSettingsModal();
  });
  modal?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideSettingsModal();
  });
  const settingsTabs = [...(modal?.querySelectorAll("[data-settings-section]") || [])];
  const activateSettingsTab = (button) => {
    local.settingsSection = button.dataset.settingsSection || "general";
    settingsTabs.forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    });
    modal.querySelectorAll("[data-settings-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== local.settingsSection;
    });
  };
  settingsTabs.forEach((button, index) => {
    button.addEventListener("click", () => activateSettingsTab(button));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? settingsTabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + settingsTabs.length) % settingsTabs.length;
      activateSettingsTab(settingsTabs[nextIndex]);
      settingsTabs[nextIndex].focus();
    });
  });
  modal?.querySelector("[data-close-settings]")?.addEventListener("click", hideSettingsModal);
  modal?.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  modal?.querySelector("#themeModeSwitch")?.addEventListener("click", (event) => {
    const nextTheme = local.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    const switcher = event.currentTarget;
    const isDark = nextTheme === "dark";
    switcher.classList.toggle("is-dark", isDark);
    switcher.classList.toggle("is-light", !isDark);
    switcher.setAttribute("aria-checked", isDark ? "true" : "false");
    switcher.setAttribute("title", isDark ? "Switch to light mode" : "Switch to dark mode");
    const label = switcher.querySelector("[data-theme-current]");
    if (label) label.textContent = isDark ? "Dark mode is on" : "Dark mode is off";
  });
  modal?.querySelector("#autoUpdateChecks")?.addEventListener("change", (event) => {
    setAutoUpdateChecks(event.currentTarget.checked);
  });
  modal?.querySelector("#joinRequestSound")?.addEventListener("change", (event) => {
    setJoinRequestSoundEnabled(event.currentTarget.checked);
  });
  modal?.querySelector("#defaultTunnelProvider")?.addEventListener("change", (event) => {
    if (!setPreferredTunnelProvider(event.currentTarget.value)) return;
    const provider = selectedTunnelProvider();
    showAppNotice(provider ? `${provider.name} will be used for new invite links.` : "Invite links will use the first provider that verifies.", {
      type: "success",
      title: "Invite-link provider",
      timeoutMs: 3200
    });
  });
  modal?.querySelector("#chooseModelFolder")?.addEventListener("click", chooseModelFolder);
  modal?.querySelector("#bringYourOwnKey")?.addEventListener("click", () => showProviderDialog({ mode: "key" }));
  modal?.querySelector("#configureCustomModel")?.addEventListener("click", () => showProviderDialog({ mode: "custom" }));
  modal?.querySelector("#settingsModelSearch")?.addEventListener("input", (event) => {
    local.settingsModelSearch = event.currentTarget.value;
    showSettingsModal("models");
    setTimeout(() => {
      const input = document.querySelector("#settingsModelSearch");
      input?.focus();
      input?.setSelectionRange?.(input.value.length, input.value.length);
    }, 0);
  });
  modal?.querySelectorAll("[data-ai-permission]").forEach((input) => {
    input.addEventListener("change", (event) => {
      const key = event.currentTarget.dataset.aiPermission;
      if ((key === "yoloMode" && event.currentTarget.checked) || (key === "askBeforeEdits" && !event.currentTarget.checked)) {
        const confirmed = confirm("YOLO mode reduces confirmations for AI file edits. Keep it off unless you are comfortable reviewing changes after they are made.");
        if (!confirmed) {
          syncAiPermissionInputs(modal);
          return;
        }
      }
      if (["fileManagement", "fileUploads", "shellCommands", "binaryFiles"].includes(key) && event.currentTarget.checked) {
        const confirmed = confirm("This allows higher-risk AI requests to reach the active model. LocalLeaf will still keep host-side safety checks, but only enable this for projects you trust.");
        if (!confirmed) {
          event.currentTarget.checked = false;
          return;
        }
      }
      if (key === "yoloMode") {
        setAiPermissionMode(event.currentTarget.checked ? "yolo" : "default");
      } else if (key === "askBeforeEdits") {
        setAiPermissionMode(event.currentTarget.checked ? "default" : "yolo");
      } else {
        local.aiPermissions[key] = event.currentTarget.checked;
        saveAiPermissions();
      }
      syncAiPermissionInputs(modal);
      if (route().view === "editor") refreshRightRailUi();
    });
  });
  modal?.querySelectorAll("[data-download-model]").forEach((button) => button.addEventListener("click", () => downloadModel(button.dataset.downloadModel)));
  modal?.querySelectorAll("[data-pause-model]").forEach((button) => button.addEventListener("click", () => pauseModelDownload(button.dataset.pauseModel)));
  modal?.querySelectorAll("[data-cancel-model]").forEach((button) => button.addEventListener("click", () => cancelModelDownload(button.dataset.cancelModel)));
  modal?.querySelectorAll("[data-delete-model]").forEach((button) => button.addEventListener("click", () => deleteModel(button.dataset.deleteModel)));
  modal?.querySelectorAll("[data-activate-model]").forEach((button) => button.addEventListener("click", () => activateModel(button.dataset.activateModel)));
  modal?.querySelectorAll("[data-use-provider]").forEach((button) => {
    button.addEventListener("click", () => useProviderModel(button.dataset.useProvider, button.dataset.useModel));
  });
  modal?.querySelectorAll("[data-connect-provider]").forEach((button) => {
    button.addEventListener("click", () => showProviderDialog({ templateId: button.dataset.connectProvider, mode: "key" }));
  });
  modal?.querySelectorAll("[data-provider-enabled]").forEach((input) => {
    input.addEventListener("change", (event) => {
      setProviderEnabled(event.currentTarget.dataset.providerEnabled, event.currentTarget.checked);
      showSettingsModal(event.currentTarget.dataset.providerToggleScope === "models" ? "models" : "providers");
    });
  });
  modal?.querySelectorAll("[data-model-enabled-provider]").forEach((input) => {
    input.addEventListener("change", (event) => {
      setModelEnabled(event.currentTarget.dataset.modelEnabledProvider, event.currentTarget.dataset.modelEnabledId, event.currentTarget.checked);
      showSettingsModal("models");
    });
  });
  modal?.querySelectorAll("[data-toggle-provider-model-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const expanded = toggleProviderModelGroup(button.dataset.toggleProviderModelGroup);
      updateProviderModelGroupDisclosure(button, expanded);
    });
  });
  modal?.querySelectorAll("[data-test-provider]").forEach((button) => {
    button.addEventListener("click", () => testProviderConnection(button.dataset.testProvider, button.dataset.testModel));
  });
  modal?.querySelectorAll("[data-edit-provider]").forEach((button) => {
    button.addEventListener("click", () => showProviderDialog({ providerId: button.dataset.editProvider, mode: "edit" }));
  });
  modal?.querySelectorAll("[data-delete-provider]").forEach((button) => {
    button.addEventListener("click", () => deleteProvider(button.dataset.deleteProvider));
  });
}

function providerFormRows(items, name, keyName, valueName) {
  const rows = items.length ? items : [""];
  return rows.map((item, index) => {
    const key = typeof item === "string" ? item : item?.[keyName] || item?.id || item?.name || "";
    const value = typeof item === "string"
      ? ""
      : item?.[valueName] || (valueName === "alias" ? item?.name : item?.value) || "";
    const legacyContextWindow = name === "model" && typeof item !== "string" ? item?.contextWindowTokens || "" : "";
    const rowLabel = name === "model" ? `model ${index + 1}` : `header ${index + 1}`;
    return `
      <div class="provider-form-row" data-provider-row="${escapeHtml(name)}">
        <input name="${escapeHtml(name)}-${escapeHtml(keyName)}" placeholder="${escapeHtml(keyName === "model" ? "Provider model ID" : "Header name")}" value="${escapeHtml(key)}" aria-label="${escapeHtml(keyName === "model" ? `Provider model ID for ${rowLabel}` : `Name for ${rowLabel}`)}" autocomplete="off" spellcheck="false" />
        <input name="${escapeHtml(name)}-${escapeHtml(valueName)}" placeholder="${escapeHtml(valueName === "value" ? "Header value" : "Display label")}" value="${escapeHtml(value)}" aria-label="${escapeHtml(valueName === "value" ? `Value for ${rowLabel}` : `Display label for ${rowLabel}`)}" autocomplete="off" spellcheck="false" />
        ${legacyContextWindow ? `<input name="model-context-window-legacy" type="hidden" value="${escapeHtml(legacyContextWindow)}" />` : ""}
        <button class="icon-button provider-row-remove" type="button" data-remove-provider-row title="Remove ${escapeHtml(rowLabel)}" aria-label="Remove ${escapeHtml(rowLabel)}">${editorToolIcon("delete")}</button>
      </div>
    `;
  }).join("");
}

function providerFormColumnLabels(group) {
  const model = group === "models";
  return `
    <div class="provider-form-column-labels" aria-hidden="true">
      <span>${model ? "Provider model ID" : "Header name"}</span>
      <span>${model ? "Display label" : "Header value"}</span>
      <span></span>
    </div>`;
}

function providerTemplateOptions(selectedId = "") {
  const templates = aiState().providerTemplates || [];
  return templates.map((template) => {
    return `<option value="${escapeHtml(template.id)}" ${template.id === selectedId ? "selected" : ""}>${escapeHtml(template.name)}</option>`;
  }).join("");
}

function showProviderDialog(options = {}) {
  const existingModal = document.querySelector(".provider-modal-backdrop");
  const returnFocus = existingModal?._localleafReturnFocus || document.activeElement;
  removeModal(existingModal, { restoreFocus: false });
  local.providerDialogTest = null;
  const customMode = options.mode === "custom";
  const provider = options.providerId
    ? aiProviders().find((item) => item.id === options.providerId)
    : options.templateId
      ? aiProviders().find((item) => item.id === options.templateId)
      : customMode
        ? null
        : aiProviders().find((item) => item.id === "opencode-go") || null;
  const title = options.mode === "key" ? "Connect Provider" : provider ? "Edit Provider" : "Add Custom Provider";
  const subtitle = customMode
    ? "Add an OpenAI-compatible endpoint and the model IDs you want LocalLeaf to show."
    : "Connect a provider and choose the models LocalLeaf can show in the picker.";
  const shell = document.querySelector(".editor-shell") || app;
  shell.insertAdjacentHTML("beforeend", `
    <div class="settings-modal-backdrop provider-modal-backdrop" role="presentation">
      <section class="settings-modal provider-modal" role="dialog" aria-modal="true" aria-labelledby="providerDialogTitle" aria-describedby="providerDialogDescription">
        <form id="providerForm">
          <div class="settings-modal-head provider-modal-head">
            <div>
              <h2 id="providerDialogTitle">${escapeHtml(title)}</h2>
              <p id="providerDialogDescription">${escapeHtml(subtitle)}</p>
            </div>
            <button class="icon-button provider-modal-close" data-close-provider type="button" title="Close provider dialog" aria-label="Close provider dialog">${editorToolIcon("close")}</button>
          </div>
          <div class="provider-form-body">
            <section class="provider-form-section provider-details-section">
              <div class="provider-form-section-head provider-section-heading">
                <span class="provider-section-icon" aria-hidden="true">${uiGlyph("network")}</span>
                <div>
                  <strong>Provider details</strong>
                  <span>Use an OpenAI-compatible endpoint. Credentials stay on this computer.</span>
                </div>
              </div>
              <div class="provider-form-field-grid">
                <label class="provider-field-full"><span>Provider preset</span>
                  <select name="templateId">
                    <option value="">Custom Provider</option>
                    ${providerTemplateOptions(provider?.builtin ? provider.id : "")}
                  </select>
                </label>
                <label><span>Provider ID</span><input name="providerId" required value="${escapeHtml(provider?.id || "")}" placeholder="openai-compatible" autocomplete="off" spellcheck="false" /></label>
                <label><span>Display name</span><input name="displayName" required value="${escapeHtml(provider?.name || "")}" placeholder="OpenAI Compatible" autocomplete="off" /></label>
                <label class="provider-field-full"><span>Base URL</span><input name="baseUrl" value="${escapeHtml(provider?.baseUrl || "")}" placeholder="https://api.example.com/v1" inputmode="url" autocomplete="url" spellcheck="false" /></label>
                <label class="provider-field-full"><span>API key</span><input name="apiKey" type="password" value="" placeholder="${provider?.hasApiKey ? "Leave blank to keep saved key" : "Stored encrypted on this computer"}" autocomplete="new-password" spellcheck="false" /></label>
              </div>
            </section>
            <section class="provider-form-section">
              <div class="provider-form-section-head provider-section-heading">
                <span class="provider-section-icon" aria-hidden="true">${uiGlyph("ai")}</span>
                <div>
                  <strong>Models</strong>
                  <span>Add the provider IDs LocalLeaf should show. Context window is managed by the provider.</span>
                </div>
                <button class="btn" type="button" data-add-model-row>${uiGlyph("plus")} Add model</button>
              </div>
              ${providerFormColumnLabels("models")}
              <div class="provider-form-rows" data-provider-rows="models">
                ${providerFormRows(provider?.models || [""], "model", "model", "alias")}
              </div>
            </section>
            <section class="provider-form-section">
              <div class="provider-form-section-head provider-section-heading">
                <span class="provider-section-icon" aria-hidden="true">${uiGlyph("settings")}</span>
                <div>
                  <strong>Optional headers</strong>
                  <span>Only add headers required by this endpoint.</span>
                </div>
                <button class="btn" type="button" data-add-header-row>${uiGlyph("plus")} Add header</button>
              </div>
              ${providerFormColumnLabels("headers")}
              <div class="provider-form-rows" data-provider-rows="headers">
                ${providerFormRows(provider?.headers || [], "header", "name", "value")}
              </div>
            </section>
            <details class="provider-form-advanced">
              <summary>
                <span>Advanced context handling</span>
                <span class="provider-advanced-chevron" aria-hidden="true">${editorToolIcon("chevronDown")}</span>
              </summary>
              <div class="provider-form-advanced-body">
                <div class="provider-form-advanced-inner">
                  <p>Context window is managed by the provider. LocalLeaf shows measured usage in AI Helper instead of presenting a manual context override. Compatibility metadata from an existing saved model is retained when you edit the provider.</p>
                </div>
              </div>
            </details>
          </div>
          <div class="provider-form-actions">
            <span class="provider-dialog-test muted" id="providerDialogTest" aria-live="polite">Run test to verify</span>
            <button class="btn" type="button" id="testProviderForm">Test connection</button>
            <button class="btn btn-primary" type="submit">Save provider</button>
          </div>
        </form>
      </section>
    </div>
  `);
  const modal = document.querySelector(".provider-modal-backdrop");
  installModalFocusManagement(modal, returnFocus);
  const close = () => removeModal(modal);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal?.querySelector("[data-close-provider]")?.addEventListener("click", close);
  modal?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  modal?.querySelector('input[name="displayName"]')?.focus();
  modal?.querySelector("[data-add-model-row]")?.addEventListener("click", () => addProviderFormRow("models"));
  modal?.querySelector("[data-add-header-row]")?.addEventListener("click", () => addProviderFormRow("headers"));
  modal?.querySelector('select[name="templateId"]')?.addEventListener("change", (event) => {
    const template = aiProviders().find((item) => item.id === event.currentTarget.value);
    if (!template) return;
    modal.querySelector('input[name="providerId"]').value = template.id;
    modal.querySelector('input[name="displayName"]').value = template.name;
    modal.querySelector('input[name="baseUrl"]').value = template.baseUrl || "";
    const modelRows = modal.querySelector('[data-provider-rows="models"]');
    if (modelRows) modelRows.innerHTML = providerFormRows(template.models || [], "model", "model", "alias");
    const headerRows = modal.querySelector('[data-provider-rows="headers"]');
    if (headerRows) headerRows.innerHTML = providerFormRows([], "header", "name", "value");
  });
  modal?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-remove-provider-row]");
    if (!button) return;
    const rows = button.closest(".provider-form-rows");
    const row = button.closest(".provider-form-row");
    if (!rows || !row) return;
    if (rows.children.length > 1) {
      row.remove();
      return;
    }
    row.querySelectorAll("input").forEach((input) => { input.value = ""; });
    row.querySelector("input")?.focus();
  });
  modal?.querySelector("#testProviderForm")?.addEventListener("click", () => testProviderConnection("", "", formProviderPayload()));
  modal?.querySelector("#providerForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveProviderFromDialog();
  });
}

function addProviderFormRow(group) {
  const rows = document.querySelector(`.provider-modal-backdrop [data-provider-rows="${group}"]`);
  if (!rows) return;
  const isModel = group === "models";
  rows.insertAdjacentHTML(
    "beforeend",
    providerFormRows([""], isModel ? "model" : "header", isModel ? "model" : "name", isModel ? "alias" : "value")
  );
  rows.lastElementChild?.querySelector("input")?.focus();
}

function formProviderPayload() {
  const form = document.querySelector("#providerForm");
  if (!form) return { id: "", name: "", models: [], headers: [] };
  const formData = new FormData(form);
  const models = [...form.querySelectorAll('[data-provider-row="model"]')]
    .map((row) => {
      const id = row.querySelector('input[name="model-model"]')?.value.trim();
      const name = row.querySelector('input[name="model-alias"]')?.value.trim() || id;
      const legacyContextWindow = Number(row.querySelector('input[name="model-context-window-legacy"]')?.value || 0);
      return id ? {
        id,
        name,
        ...(Number.isFinite(legacyContextWindow) && legacyContextWindow >= 1024
          ? { contextWindowTokens: legacyContextWindow }
          : {})
      } : null;
    })
    .filter(Boolean);
  const headers = [...form.querySelectorAll('[data-provider-row="header"]')]
    .map((row) => ({
      name: row.querySelector('input[name="header-name"]')?.value.trim(),
      value: row.querySelector('input[name="header-value"]')?.value.trim()
    }))
    .filter((header) => header.name);
  const templateId = String(formData.get("templateId") || "").trim();
  return {
    id: String(formData.get("providerId") || "").trim(),
    templateId,
    name: String(formData.get("displayName") || "").trim(),
    baseUrl: String(formData.get("baseUrl") || "").trim(),
    apiKey: String(formData.get("apiKey") || "").trim(),
    models: models.length ? models : [{ id: "default", name: "Default" }],
    headers,
    description: "Custom OpenAI-compatible provider.",
    custom: !templateId,
    activate: true
  };
}

async function saveProviderFromDialog() {
  const provider = formProviderPayload();
  if (!provider.id || !provider.name) {
    showAppNotice("Provider ID and display name are required.", { type: "error", title: "Provider" });
    return;
  }
  try {
    const payload = { ...provider };
    if (!payload.apiKey) delete payload.apiKey;
    const next = await api("/api/ai/providers/save", { method: "POST", body: payload });
    setProviderEnabled(provider.id, true);
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
    removeModal(document.querySelector(".provider-modal-backdrop"));
    showAppNotice(`${provider.name} saved.`, { type: "success", title: "Provider", timeoutMs: 3200 });
    if (document.querySelector(".settings-modal-backdrop")) showSettingsModal("models");
    else render();
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Provider" });
  }
}

async function useProviderModel(providerId, modelId) {
  try {
    if (providerId === "cursor") {
      local.activeCursorSdkModelId = modelId || "composer-2";
      localStorage.setItem("localleaf.activeCursorSdkModelId", local.activeCursorSdkModelId);
      local.aiModelPickerOpen = false;
      showAppNotice("Cursor selected for AI Helper.", { type: "success", title: "Models", timeoutMs: 2600 });
    }
    if (!providerId || providerId === "local" || providerId === "localleaf-local") {
      local.activeCursorSdkModelId = "";
      localStorage.removeItem("localleaf.activeCursorSdkModelId");
      await activateModel(modelId);
      return;
    }
    const next = await api("/api/ai/providers/activate", { method: "POST", body: { providerId, modelId } });
    if (providerId !== "cursor") {
      local.activeCursorSdkModelId = "";
      localStorage.removeItem("localleaf.activeCursorSdkModelId");
    }
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
    showAppNotice("Active AI model updated.", { type: "success", title: "Models", timeoutMs: 2600 });
    if (document.querySelector(".settings-modal-backdrop")) showSettingsModal("models");
    else refreshRightRailUi();
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Activate provider" });
  }
}

function setProviderTestDisplay(providerId, result) {
  const id = providerId || "form";
  if (providerId) local.providerInlineTests[providerId] = result;
  const slot = document.querySelector(`#providerDialogTest`) || document.querySelector(`[data-provider-test-slot="${CSS.escape(id)}"]`);
  if (!slot) return;
  slot.textContent = result.message || "";
  slot.className = slot.id === "providerDialogTest"
    ? `provider-dialog-test ${result.color || (result.ok ? "green" : "red")}`
    : `provider-test-result ${result.color || (result.ok ? "green" : "red")}`;
}

async function testProviderConnection(providerId, modelId = "", providerPayload = null) {
  if (providerId === "local" || providerId === "localleaf-local") {
    setProviderTestDisplay(providerId, { color: "muted", message: "Local models are tested after download." });
    return;
  }
  const payload = providerPayload || { providerId, modelId };
  const testId = providerPayload?.id || providerId || "form";
  local.providerTestBusy = testId;
  setProviderTestDisplay(testId === "form" ? "" : testId, { color: "muted", message: "Testing connection..." });
  try {
    const result = await api("/api/ai/providers/test", { method: "POST", body: payload, timeoutMs: 30000 });
    setProviderTestDisplay(result.providerId || testId, { ok: true, color: "green", message: result.message || "Connection ready." });
    await refreshAiState();
  } catch (error) {
    setProviderTestDisplay(testId === "form" ? "" : testId, { ok: false, color: "red", message: error.message || "Connection failed." });
    await refreshAiState();
  } finally {
    local.providerTestBusy = "";
  }
}

async function deleteProvider(providerId) {
  const provider = aiProviders().find((item) => item.id === providerId);
  if (!provider) return;
  if (!confirm(`Delete provider ${provider.name || provider.id}?`)) return;
  try {
    const next = await api("/api/ai/providers/delete", { method: "POST", body: { providerId } });
    delete local.aiProviderEnabled[providerId];
    Object.keys(local.aiModelEnabled).forEach((key) => {
      if (key.startsWith(`${providerId}/`)) delete local.aiModelEnabled[key];
    });
    writeBooleanMap(AI_PROVIDER_ENABLE_STORAGE_KEY, local.aiProviderEnabled);
    writeBooleanMap(AI_MODEL_ENABLE_STORAGE_KEY, local.aiModelEnabled);
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
    showSettingsModal("providers");
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Delete provider" });
  }
}

async function refreshAiState() {
  try {
    const next = await api("/api/ai/models/status");
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
  } catch {
    // AI models are host-only; guests and older servers can keep rendering without them.
  }
}

async function chooseModelFolder() {
  if (typeof window.localleafDesktop?.chooseModelFolder !== "function") {
    showAppNotice("Folder picking is available in the desktop app.", { title: "Models" });
    return;
  }
  const result = await window.localleafDesktop.chooseModelFolder();
  if (result?.canceled || !result?.folderPath) return;
  try {
    const next = await api("/api/ai/models/storage", { method: "POST", body: { path: result.folderPath } });
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
    showSettingsModal("models");
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Model folder" });
  }
}

async function downloadModel(modelId) {
  if (!modelId) return;
  local.modelActionBusy = modelId;
  try {
    const next = await api("/api/ai/models/download", { method: "POST", body: { modelId } });
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
    showAppNotice("Model download started.", { title: "Models", timeoutMs: 3200 });
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Model download" });
  } finally {
    local.modelActionBusy = "";
    showSettingsModal("models");
  }
}

async function pauseModelDownload(modelId) {
  if (!modelId) return;
  try {
    const next = await api("/api/ai/models/pause", { method: "POST", body: { modelId } });
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Pause model" });
  } finally {
    showSettingsModal("models");
  }
}

async function cancelModelDownload(modelId) {
  if (!modelId) return;
  try {
    const next = await api("/api/ai/models/cancel", { method: "POST", body: { modelId } });
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Stop model" });
  } finally {
    showSettingsModal("models");
  }
}

async function deleteModel(modelId) {
  if (!modelId || !confirm("Delete this local model from LocalLeafModel?")) return;
  local.modelActionBusy = modelId;
  try {
    const next = await api("/api/ai/models/delete", { method: "POST", body: { modelId } });
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Delete model" });
  } finally {
    local.modelActionBusy = "";
    showSettingsModal("models");
  }
}

async function activateModel(modelId) {
  if (!modelId) return;
  local.modelActionBusy = modelId;
  try {
    const next = await api("/api/ai/models/activate", { method: "POST", body: { modelId } });
    local.appState.ai = { ...(local.appState.ai || {}), ...next };
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Activate model" });
  } finally {
    local.modelActionBusy = "";
    showSettingsModal("models");
  }
}

function showInfoModal(kind) {
  const existingModal = document.querySelector(".info-modal-backdrop");
  const returnFocus = existingModal?._localleafReturnFocus || document.activeElement;
  removeModal(existingModal, { restoreFocus: false });
  const isHelp = kind === "help";
  const shell = document.querySelector(".editor-shell") || app;
  const helpItems = [
    {
      topic: "Projects",
      question: "Where does LocalLeaf keep my project?",
      answer: "A project is an ordinary folder on the host computer. You can create it in a destination you choose or import an existing ZIP. LocalLeaf reads and writes those files directly instead of moving the project into a separate cloud workspace."
    },
    {
      topic: "Hosting",
      question: "How do I invite someone to a session?",
      answer: "Open Host Session, wait for one verified invite link, then send that link to your friend. Their request appears on the host for approval. The host computer and LocalLeaf must stay online while guests are working."
    },
    {
      topic: "Access",
      question: "What can a Viewer or Maintainer do?",
      answer: "A Viewer can read source files, review the shared PDF, and use project chat. A Maintainer can also edit project files and use host-mediated AI. Only the host can compile, change guest access, refresh the invite link, or stop the session."
    },
    {
      topic: "Collaboration",
      question: "Can two people edit the same file at once?",
      answer: "LocalLeaf currently synchronizes the whole file, so the last arrival wins when two browsers save the same file. For now, divide work across separate files and avoid editing the same .tex file at the same time. Reopen the file if another writer has just changed it."
    },
    {
      topic: "Compilation",
      question: "What happens when the PDF does not compile?",
      answer: "Your source files remain saved. When a previous PDF has been validated, LocalLeaf keeps that last good copy visible while you inspect the compile warnings and logs. Fix the reported source, then recompile to replace it with a current PDF."
    },
    {
      topic: "AI and privacy",
      question: "Does AI send my project away from this computer?",
      answer: "A LocalLeaf Local model runs on the host computer. If you choose a hosted provider, LocalLeaf sends the relevant request context to that provider, so its privacy terms apply. Provider keys, host settings, and the host's AI history are not shared with guests."
    },
    {
      topic: "AI changes",
      question: "How does AI change project files?",
      answer: "AI Helper prepares a proposal and records it in Changes. Review the affected file and diff before approval. New files always need approval, and the host can decide whether ordinary edits ask first or use the allowed automatic edit mode."
    },
    {
      topic: "Invite links",
      question: "What does Refresh link do?",
      answer: "Refresh creates and verifies a new invitation. The previous link can no longer approve another guest, so send the replacement to anyone who has not joined. Existing approvals remain, but connected guests may need the new link to reconnect."
    },
    {
      topic: "Backups",
      question: "How should I back up or move a project?",
      answer: "Use Export to download the source ZIP or the latest compiled PDF. Because the project is already a normal folder, you can also back it up with your usual drive, version-control, or archive workflow. Stopping a hosted session never deletes the project files."
    }
  ];
  shell.insertAdjacentHTML("beforeend", `
    <div class="settings-modal-backdrop info-modal-backdrop" role="presentation">
      <section class="settings-modal info-modal info-modal-${isHelp ? "help" : "about"}" role="dialog" aria-modal="true" aria-labelledby="infoModalTitle" aria-describedby="infoModalSubtitle">
        <div class="settings-modal-head">
          <div>
            <h2 id="infoModalTitle">${isHelp ? "LocalLeaf help" : "About LocalLeaf"}</h2>
            <p id="infoModalSubtitle">${isHelp ? "Answers about projects, sharing, compiling, and AI." : "A local writing room for private, host-powered LaTeX work."}</p>
          </div>
          <button class="icon-button dialog-close-button" data-close-info title="Close" aria-label="Close"><svg class="dialog-close-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button>
        </div>
        ${isHelp ? `
          <div class="info-modal-body help-qa-list">
            ${helpItems.map(({ topic, question, answer }, index) => `
              <details ${index === 0 ? "open" : ""}>
                <summary>
                  <span class="help-step">${String(index + 1).padStart(2, "0")}</span>
                  <span class="help-question-copy">
                    <small class="help-topic">${escapeHtml(topic)}</small>
                    <strong>${escapeHtml(question)}</strong>
                  </span>
                  <span class="help-disclosure">
                    <span class="help-disclosure-label help-disclosure-label-collapsed">Show answer</span>
                    <span class="help-disclosure-label help-disclosure-label-expanded">Hide answer</span>
                    <span class="help-disclosure-icon-bound" aria-hidden="true">
                      <svg class="help-disclosure-icon" viewBox="0 0 24 24" focusable="false">
                        <path d="m6 9 6 6 6-6"></path>
                      </svg>
                    </span>
                  </span>
                </summary>
                <div class="help-answer"><div class="help-answer-inner"><p>${escapeHtml(answer)}</p></div></div>
              </details>
            `).join("")}
          </div>
        ` : `
          <div class="info-modal-body about-editorial">
            <section class="about-intro" aria-labelledby="aboutProductName">
              <div class="about-intro-heading">
                <strong class="about-product-name" id="aboutProductName">LocalLeaf</strong>
                <p class="about-product-line">A local writing room for LaTeX projects.</p>
              </div>
              <div class="about-values" aria-label="Product principles">
                <span>Private by design</span>
                <span>Host powered</span>
              </div>
              <p class="about-summary">LocalLeaf keeps a LaTeX project with the person hosting the session. Approved guests join from a browser to read, write, and chat while the host remains responsible for the files, access, and compiled PDF.</p>
            </section>
            <section class="about-working-model" aria-labelledby="aboutWorkingModelTitle">
              <h3 id="aboutWorkingModelTitle">How a session works</h3>
              <p>The host opens a normal project folder, starts a temporary session, approves each guest, and compiles one shared PDF. Guests work in the browser without installing LocalLeaf or receiving access to the host computer.</p>
            </section>
            <dl class="about-detail-list" aria-label="LocalLeaf product details">
              <div class="about-detail">
                <dt>Local files</dt>
                <dd>Source remains in a folder chosen by the host.</dd>
              </div>
              <div class="about-detail">
                <dt>Approved guests</dt>
                <dd>Every browser guest needs a verified link and host approval.</dd>
              </div>
              <div class="about-detail">
                <dt>Clear roles</dt>
                <dd>Viewers read and chat. Maintainers can also edit and use AI.</dd>
              </div>
              <div class="about-detail">
                <dt>Host compile</dt>
                <dd>LaTeX runs on the host and produces the PDF everyone reviews.</dd>
              </div>
              <div class="about-detail">
                <dt>Optional AI</dt>
                <dd>Use a local model or a provider. Every proposal appears in Changes, while permitted edits may be applied automatically.</dd>
              </div>
              <div class="about-detail">
                <dt>Project chat</dt>
                <dd>Session conversation stays beside the files and PDF.</dd>
              </div>
            </dl>
            <section class="about-boundaries" aria-labelledby="aboutBoundariesTitle">
              <h3 id="aboutBoundariesTitle">Current boundaries</h3>
              <p>The host must stay online for a shared session. Same-file collaboration is whole-file and last-arrival-wins, so writers should coordinate before editing the same source file.</p>
            </section>
            <div class="about-footer-row">
              <span>Made for research groups and classmates who write LaTeX together and want to keep ownership of the project files.</span>
              <a class="btn about-website-link" href="${LOCALLEAF_SITE_URL}" target="_blank" rel="noopener">Visit website</a>
            </div>
          </div>
        `}
      </section>
    </div>
  `);
  const modal = document.querySelector(".info-modal-backdrop");
  installModalFocusManagement(modal, returnFocus);
  const closeInfo = () => removeModal(modal);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) closeInfo();
  });
  modal?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeInfo();
  });
  modal?.querySelector("[data-close-info]")?.addEventListener("click", closeInfo);
  modal?.querySelector("[data-close-info]")?.focus();
}

function showHelpModal() {
  showInfoModal("help");
}

function showAboutModal() {
  showInfoModal("about");
}

function joinView(code) {
  const hostName = local.appState?.session?.users?.find((user) => user.role === "host")?.name || "the host";
  return `
    <section class="host-frame">
      <div class="window join-card">
        <div class="titlebar"><strong>LocalLeaf</strong><span></span></div>
        <div class="join-hero">
          ${logoMark("brand-mark join-logo")}
          <h1>Join ${escapeHtml(hostName)}'s<br />LocalLeaf Session</h1>
          <p style="margin:0;color:var(--muted);font-size:13px">Project: ${escapeHtml(local.appState?.project?.name || "Thesis Draft")}</p>
          <div class="field">
            <label for="guestName">Your name</label>
            <input id="guestName" value="${escapeHtml(local.userName === "Host" ? "" : local.userName)}" />
          </div>
          <button class="btn btn-primary" id="joinProject" style="width:100%">Join Project</button>
          <p class="error" id="joinError"></p>
          <div class="notice">You don't need to install anything. Just your browser.</div>
        </div>
      </div>
    </section>
  `;
}

function waitingView() {
  return `
    <section class="host-frame">
      <div class="window join-card">
        <div class="join-hero">
          ${logoMark("brand-mark join-logo")}
          <h1>Waiting for host approval</h1>
          <p style="color:var(--muted)">Keep this tab open. The editor will open as soon as the host allows you in.</p>
          <div class="notice">Request ID: ${escapeHtml(local.joinRequestId || "")}</div>
        </div>
      </div>
    </section>
  `;
}

function endedView() {
  const canDownload = Boolean(local.guestToken && isLiveSession() && local.appState?.project?.files?.length);
  const zipName = downloadFileName(local.appState?.project?.name, ".zip");
  const downloadButton = canDownload
    ? `<a class="btn ended-download-button" href="${authUrl("/api/export/zip")}" download="${escapeHtml(zipName)}">${icon("download")}<span>Download ZIP</span></a>`
    : "";
  return `
    <section class="empty-state">
      <div class="ended-card" role="alertdialog" aria-live="assertive" aria-labelledby="endedTitle">
        <div class="plug-icon">${icon("ended")}</div>
        <h1 id="endedTitle">Session Ended</h1>
        <p class="ended-reason">${escapeHtml(local.sessionEndedReason)}</p>
        <p class="ended-detail">${escapeHtml(local.sessionEndedDetail)}</p>
        <div class="ended-actions">
          ${downloadButton}
          <button class="btn" id="goBackHome">Go Back</button>
        </div>
        ${downloadButton ? `<p class="ended-note">Download your copy before the host stops the session.</p>` : ""}
      </div>
    </section>
  `;
}

function outlineFromContent(content) {
  const levels = {
    chapter: 0,
    section: 1,
    subsection: 2,
    subsubsection: 3,
    paragraph: 4,
    subparagraph: 5
  };
  const matches = [...String(content || "").matchAll(/\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]*)\}/g)];
  return matches.map((match, index) => ({
    id: `outline-${index}`,
    level: levels[match[1]] ?? 1,
    command: match[1],
    title: match[2].trim()
  })).filter((item) => item.title);
}

function fileMeta(filePath = local.selectedFile) {
  return local.appState?.project?.files?.find((item) => item.path === filePath) || null;
}

function isEditableFile(item) {
  return item?.type === "text";
}

function isImageAsset(item) {
  return item?.type === "image";
}

function isPdfAsset(item) {
  return item?.type === "image" && item.path.toLowerCase().endsWith(".pdf");
}

function isBrowserImageAsset(item) {
  return item?.type === "image" && /\.(png|jpe?g|gif|webp|svg)$/i.test(item.path);
}

function treeItem(pathValue) {
  return local.appState?.project?.files?.find((item) => item.path === pathValue) || null;
}

function pathParts(pathValue = "") {
  return String(pathValue || "").replace(/\\/g, "/").split("/").filter(Boolean);
}

function pathBasename(pathValue = "") {
  const parts = pathParts(pathValue);
  return parts[parts.length - 1] || "";
}

function pathDirname(pathValue = "") {
  const parts = pathParts(pathValue);
  parts.pop();
  return parts.join("/");
}

function joinProjectPath(basePath = "", childPath = "") {
  return [...pathParts(basePath), ...pathParts(childPath)].join("/");
}

function selectedDirectoryPath() {
  const folder = treeItem(local.selectedFolder);
  if (folder?.type === "directory") return folder.path;
  const selected = treeItem(local.selectedFile);
  return selected ? pathDirname(selected.path) : "";
}

function selectedTreeEntry() {
  const folder = treeItem(local.selectedFolder);
  if (folder?.type === "directory") return folder;
  return treeItem(local.selectedFile);
}

function projectPathExists(pathValue, exceptPath = "") {
  return local.appState?.project?.files?.some((item) => item.path === pathValue && item.path !== exceptPath);
}

function renameNameParts(item = {}) {
  const name = item.name || pathBasename(item.path);
  if (item.type === "directory") {
    return { stem: name, extension: "" };
  }
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return { stem: name, extension: "" };
  }
  return {
    stem: name.slice(0, dotIndex),
    extension: name.slice(dotIndex)
  };
}

function normalizeRenameStem(value, extension = "") {
  let stem = String(value || "").trim();
  if (extension && stem.toLowerCase().endsWith(extension.toLowerCase())) {
    stem = stem.slice(0, -extension.length).trimEnd();
  }
  return stem;
}

function projectEntryNameError(value, kind = "file") {
  const name = String(value || "").trim();
  if (!name) return `Enter a ${kind === "directory" ? "folder" : "file"} name.`;
  if (name === "." || name === "..") return "Choose a different name.";
  if (/[\\/]/.test(name)) return "Use a name only. Choose a folder separately.";
  if (/[<>:\"|?*\u0000-\u001f]/.test(name)) return "That name contains a character Windows cannot use.";
  if (/[. ]$/.test(name)) return "Names cannot end with a dot or space.";
  if (name.length > 120) return "Keep the name to 120 characters or fewer.";
  return "";
}

function normalizedNewFileName(value) {
  const name = String(value || "").trim();
  if (!name || name.startsWith(".")) return name;
  return importFileExtension(name) ? name : `${name}.tex`;
}

function creatableProjectFileNameError(value) {
  const basicError = projectEntryNameError(value, "file");
  if (basicError) return basicError;
  const name = normalizedNewFileName(value);
  if (!isSupportedProjectFileName(name) || isSupportedImageProjectFileName(name)) {
    return "Create a LaTeX or text project file here. Upload images and PDFs instead.";
  }
  return "";
}

function uniqueProjectPath(directory, preferredName) {
  const cleanDirectory = pathParts(directory).join("/");
  const cleanName = String(preferredName || "").trim() || "new file.tex";
  const extMatch = cleanName.match(/(\.[^./\\]+)$/);
  const extension = extMatch ? extMatch[1] : "";
  const baseName = extension ? cleanName.slice(0, -extension.length) : cleanName;
  let candidateName = cleanName;
  let index = 2;
  while (projectPathExists(joinProjectPath(cleanDirectory, candidateName))) {
    candidateName = `${baseName} ${index}${extension}`;
    index += 1;
  }
  return joinProjectPath(cleanDirectory, candidateName);
}

function copyNameForItem(item) {
  const name = item?.name || pathBasename(item?.path);
  if (!name) return "copy";
  if (item?.type === "directory") return `${name} copy`;
  const parts = renameNameParts(item);
  return `${parts.stem} copy${parts.extension}`;
}

function uniqueCopyPath(sourcePath, targetFolder) {
  const item = treeItem(sourcePath);
  return uniqueProjectPath(targetFolder, copyNameForItem(item));
}

function canCopyTreeItem(sourcePath) {
  const source = treeItem(sourcePath);
  return Boolean(source && source.type !== "binary");
}

function canPasteTreeItem(sourcePath, targetFolder = "") {
  const source = treeItem(sourcePath);
  if (!source || source.type === "binary") return false;
  const target = targetFolder ? treeItem(targetFolder) : null;
  if (targetFolder && target?.type !== "directory") return false;
  if (source.type === "directory" && (targetFolder === source.path || targetFolder.startsWith(`${source.path}/`))) {
    return false;
  }
  return true;
}

function renameInputMarkup(item) {
  const label = item.name || pathBasename(item.path);
  return `
    <div class="tree-rename-wrap ${local.renameSaving ? "is-saving" : ""}">
      <input class="tree-rename-input"
        data-rename-path="${escapeHtml(item.path)}"
        data-rename-kind="${escapeHtml(item.type)}"
        value="${escapeHtml(label)}"
        spellcheck="false"
        autocomplete="off"
        ${local.renameSaving ? "disabled" : ""}
        ${local.renameError ? 'aria-invalid="true" aria-describedby="treeRenameError"' : ""}
        aria-label="Rename ${escapeHtml(label)}" />
      <span class="tree-rename-actions">
        <button type="button" class="tree-inline-action tree-inline-confirm" data-tree-rename-confirm aria-label="Save new name" title="Save new name" ${local.renameSaving ? "disabled" : ""}>${editorToolIcon("check")}</button>
        <button type="button" class="tree-inline-action" data-tree-rename-cancel aria-label="Cancel rename" title="Cancel rename" ${local.renameSaving ? "disabled" : ""}>${editorToolIcon("close")}</button>
      </span>
      ${local.renameError ? `<span class="tree-rename-error" id="treeRenameError" role="alert">${escapeHtml(local.renameError)}</span>` : ""}
    </div>
  `;
}

function treeRenameRowMarkup(item, depth = 0) {
  return `
    <div class="tree-rename-row ${depth > 0 ? "nested" : ""}" style="--depth:${depth}">
      <span class="tree-rename-leading" aria-hidden="true">${fileIconFor(item)}</span>
      ${renameInputMarkup(item)}
    </div>
  `;
}

function treeCreateDraftMarkup() {
  const draft = local.treeCreateDraft;
  if (!draft) return "";
  const isFolder = draft.kind === "folder";
  const location = draft.directory ? `Inside ${draft.directory}` : "Project root";
  return `
    <form class="tree-create-draft ${draft.saving ? "is-saving" : ""}" data-create-kind="${escapeHtml(draft.kind)}" aria-label="${isFolder ? "New folder" : "New file"}" aria-busy="${draft.saving ? "true" : "false"}">
      <div class="tree-create-heading">
        <span class="tree-create-icon" aria-hidden="true">${editorToolIcon(isFolder ? "newFolder" : "newFile")}</span>
        <span class="tree-create-copy">
          <strong>${isFolder ? "New folder" : "New file"}</strong>
          <small>${escapeHtml(location)}</small>
        </span>
      </div>
      <div class="tree-create-control">
        <input class="tree-create-input" value="${escapeHtml(draft.name)}" spellcheck="false" autocomplete="off" ${draft.saving ? "disabled" : ""} ${draft.error ? 'aria-invalid="true"' : ""} aria-label="${isFolder ? "Folder name" : "File name"}" aria-describedby="treeCreateHint${draft.error ? " treeCreateError" : ""}" />
        <button type="submit" class="tree-inline-action tree-inline-confirm" data-tree-create-confirm aria-label="Create ${isFolder ? "folder" : "file"}" title="Create ${isFolder ? "folder" : "file"}" ${draft.saving ? "disabled" : ""}>${editorToolIcon("check")}</button>
        <button type="button" class="tree-inline-action" data-tree-create-cancel aria-label="Cancel new ${isFolder ? "folder" : "file"}" title="Cancel" ${draft.saving ? "disabled" : ""}>${editorToolIcon("close")}</button>
      </div>
      <small class="tree-create-hint" id="treeCreateHint">${isFolder ? "Enter a single folder name." : "No extension? LocalLeaf adds .tex."}</small>
      ${draft.error ? `<span class="tree-create-error" id="treeCreateError" role="alert">${escapeHtml(draft.error)}</span>` : ""}
    </form>
  `;
}

function expandToFile(filePath) {
  const parts = String(filePath || "").split("/").filter(Boolean);
  let current = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index];
    local.collapsedFolders.delete(current);
  }
}

function filteredFilesForTree(files) {
  const query = local.fileFilter.trim().toLowerCase();
  const nonImages = files.filter((item) => {
    if (item.type !== "directory") return item.type !== "image";
    const prefix = `${item.path}/`;
    const descendants = files.filter((candidate) => candidate.path.startsWith(prefix));
    return descendants.length === 0 || descendants.some((candidate) => candidate.type !== "directory" && candidate.type !== "image");
  });
  if (!query) return nonImages;

  const matchingPaths = new Set();
  for (const item of nonImages) {
    if (item.type !== "directory" && item.path.toLowerCase().includes(query)) {
      matchingPaths.add(item.path);
      const parts = item.path.split("/");
      let current = "";
      for (let index = 0; index < parts.length - 1; index += 1) {
        current = current ? `${current}/${parts[index]}` : parts[index];
        matchingPaths.add(current);
      }
    }
  }

  return nonImages.filter((item) => matchingPaths.has(item.path));
}

function buildProjectTree(files) {
  const root = {
    name: "",
    path: "",
    type: "directory",
    children: new Map()
  };

  for (const item of files) {
    const parts = item.path.split("/").filter(Boolean);
    let node = root;
    let currentPath = "";

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = index === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: currentPath,
          type: isLast ? item.type : "directory",
          item: isLast ? item : null,
          children: new Map()
        });
      }

      const child = node.children.get(part);
      if (isLast) {
        child.type = item.type;
        child.item = item;
      }
      node = child;
    });
  }

  return root;
}

function sortTreeNodes(nodes) {
  return [...nodes].sort((left, right) => {
    const leftDir = left.type === "directory";
    const rightDir = right.type === "directory";
    if (leftDir !== rightDir) return leftDir ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function fileIconFor(item) {
  if (item.type === "directory") return editorToolIcon("files");
  if (item.type === "image") return editorToolIcon("image");
  if (item.path === local.appState.project.mainFile) return editorToolIcon("mainFile");
  return editorToolIcon("file");
}

function renderTreeNode(node, selectedFile, depth = 0) {
  if (node.type === "directory") {
    const isCollapsed = local.collapsedFolders.has(node.path);
    const isSelected = local.selectedFolder === node.path;
    const children = sortTreeNodes(node.children.values());
    const renameItem = {
      path: node.path,
      name: node.name,
      type: "directory"
    };
      const folderRowMarkup = local.renamingTreePath === node.path
        ? treeRenameRowMarkup(renameItem, depth)
        : `
          <button class="tree-folder-row folder-toggle ${isSelected ? "active" : ""} ${depth > 0 ? "nested" : ""}"
            data-folder="${escapeHtml(node.path)}"
            data-drag-path="${escapeHtml(node.path)}"
            data-drag-kind="directory"
            data-drop-folder="${escapeHtml(node.path)}"
            draggable="true"
            style="--depth:${depth}">
            <span class="folder-caret ${isCollapsed ? "" : "expanded"}">${editorToolIcon("chevronRight")}</span>
            <span class="folder-name">${escapeHtml(node.name)}</span>
            <span class="folder-count">${children.length}</span>
          </button>`;
      return `
        <div class="tree-folder" data-depth="${depth}">
          ${folderRowMarkup}
          ${isCollapsed ? "" : `<div class="tree-children">${children.map((child) => renderTreeNode(child, selectedFile, depth + 1)).join("")}</div>`}
      </div>
    `;
  }

    const item = node.item;
    const selectable = isEditableFile(item) || isImageAsset(item);
    if (local.renamingTreePath === item.path) return treeRenameRowMarkup(item, depth);
    return `
      <button class="file-button tree-file ${item.path === selectedFile && !local.selectedFolder ? "active" : ""} ${item.type === "image" ? "image-file" : ""} ${selectable ? "" : "not-selectable"} ${depth > 0 ? "nested" : ""}"
      data-file="${escapeHtml(item.path)}"
      data-kind="${escapeHtml(item.type)}"
      data-selectable="${selectable ? "1" : "0"}"
      data-drag-path="${escapeHtml(item.path)}"
      data-drag-kind="${escapeHtml(item.type)}"
      style="--depth:${depth}"
      draggable="true"
      aria-disabled="${selectable ? "false" : "true"}">
      <span>${fileIconFor(item)}</span><span class="file-label">${escapeHtml(item.name)}</span>
    </button>
  `;
}

function renderProjectTree(files, selectedFile) {
  const treeFiles = filteredFilesForTree(files);
  const root = buildProjectTree(treeFiles);
  const children = sortTreeNodes(root.children.values());
  return children.length
    ? children.map((node) => renderTreeNode(node, selectedFile, 0)).join("")
    : `<div class="tree-empty">${local.fileFilter ? "No matching files." : "No files in this project."}</div>`;
}

function renderImageGroup(files, selectedFile) {
  const images = files.filter((item) => item.type === "image");
  const isEmpty = images.length === 0;

  return `
    <div class="image-group">
      <button class="tree-folder-row image-section-toggle" style="--depth:0">
        <span class="folder-caret ${local.imagesCollapsed ? "" : "expanded"}">${editorToolIcon("chevronRight")}</span>
        <span class="folder-name">Images</span>
        <span class="folder-count">${images.length}</span>
      </button>
        ${local.imagesCollapsed ? "" : `<div class="tree-children">
          ${isEmpty ? `<div class="tree-empty">No images in this project.</div>` : ""}
          ${images.map((item) => local.renamingTreePath === item.path ? treeRenameRowMarkup(item, 1) : `
            <button class="file-button tree-file image-file ${item.path === selectedFile && !local.selectedFolder ? "active" : ""} nested"
            data-file="${escapeHtml(item.path)}"
            data-kind="image"
            data-selectable="1"
            data-drag-path="${escapeHtml(item.path)}"
            data-drag-kind="image"
            draggable="true"
            style="--depth:1">
            <span>${editorToolIcon("image")}</span><span class="file-label">${escapeHtml(item.path)}</span>
          </button>
        `).join("")}
      </div>`}
    </div>
    `;
  }

function treeContextMenuMarkup() {
  const menu = local.treeContextMenu;
  if (!menu) return "";
  const entry = menu.path ? treeItem(menu.path) : null;
  const targetFolder = menu.targetFolder || "";
  const clipboardReady = canPasteTreeItem(local.treeClipboardPath, targetFolder);
  const canRename = Boolean(entry && entry.type !== "binary");
  const canDownload = Boolean(entry);
  const canCopy = Boolean(entry && canCopyTreeItem(entry.path));
  const canSetMain = Boolean(entry && entry.type === "text" && entry.path.endsWith(".tex") && entry.path !== local.appState.project.mainFile);
  const button = (action, label, options = {}) => `
    <button type="button"
      class="${options.danger ? "danger" : ""}"
      data-tree-menu-action="${escapeHtml(action)}"
      ${options.disabled ? "disabled" : ""}>
      ${escapeHtml(label)}
    </button>
  `;
  if (!canMutateProject()) {
    return `
      <div class="tree-context-menu" style="left:${menu.x}px;top:${menu.y}px" role="menu" aria-label="File tree menu">
        ${button("download", "Download", { disabled: !canDownload })}
      </div>
    `;
  }
  return `
    <div class="tree-context-menu" style="left:${menu.x}px;top:${menu.y}px" role="menu" aria-label="File tree menu">
      ${button("rename", "Rename", { disabled: !canRename })}
      ${button("copy", "Copy", { disabled: !canCopy })}
      ${button("paste", `Paste${local.treeClipboardPath ? ` ${pathBasename(local.treeClipboardPath)}` : ""}`, { disabled: !clipboardReady })}
      ${button("download", "Download", { disabled: !canDownload })}
      <div class="context-divider"></div>
      ${button("set-main", "Set as main document", { disabled: !canSetMain })}
      <div class="context-divider"></div>
      ${button("delete", "Delete", { disabled: !entry, danger: true })}
      <div class="context-divider"></div>
      ${button("new-file", "New file")}
      ${button("new-folder", "New folder")}
      ${button("upload", "Upload")}
    </div>
  `;
}

function selectedFileState(file = local.selectedFile) {
  const state = local.appState;
  const textFiles = state.project.files.filter((item) => item.type === "text");
  const selectedMeta = fileMeta(file) || textFiles[0] || state.project.files.find((item) => item.type === "image");
  const canEditSelected = isEditableFile(selectedMeta);
  const isMainFile = file === state.project.mainFile;
  return {
    file,
    selectedMeta,
    textFiles,
    outline: outlineFromContent(local.editorContent),
    isMainFile,
    canEditSelected,
    canSetMain: canEditSelected && String(file || "").endsWith(".tex") && !isMainFile
  };
}

function latexEscapeText(value) {
  return String(value || "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/\^/g, "\\^{}")
    .replace(/~/g, "\\~{}");
}

function latexUnescapeText(value) {
  return String(value || "")
    .replace(/\\textbackslash\{\}/g, "\\")
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/\\\^\{\}/g, "^")
    .replace(/\\~\{\}/g, "~");
}

function stripLatexAssetQuotes(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function stripLatexComments(line) {
  let escaped = false;
  let result = "";
  for (const char of String(line || "")) {
    if (char === "%" && !escaped) break;
    result += char;
    escaped = char === "\\" && !escaped;
    if (char !== "\\") escaped = false;
  }
  return result;
}

function latexBalance(lines, openChar, closeChar) {
  let balance = 0;
  for (const line of lines) {
    let escaped = false;
    for (const char of stripLatexComments(line)) {
      if (char === openChar && !escaped) balance += 1;
      else if (char === closeChar && !escaped) balance -= 1;
      escaped = char === "\\" && !escaped;
      if (char !== "\\") escaped = false;
    }
  }
  return balance;
}

function latexEnvironmentBalance(lines) {
  let balance = 0;
  for (const line of lines) {
    const source = stripLatexComments(line);
    const beginMatches = [...source.matchAll(/\\begin\{([^{}]+)\}/g)].filter((match) => match[1] !== "document");
    const endMatches = [...source.matchAll(/\\end\{([^{}]+)\}/g)].filter((match) => match[1] !== "document");
    balance += beginMatches.length - endMatches.length;
  }
  return balance;
}

function latexDisplayMathBalance(lines) {
  let balance = 0;
  for (const line of lines) {
    const source = stripLatexComments(line);
    balance += (source.match(/\\\[/g) || []).length;
    balance -= (source.match(/\\\]/g) || []).length;
  }
  return balance;
}

function visualRawBlockIsOpen(lines) {
  if (!lines.length) return false;
  return (
    latexDisplayMathBalance(lines) > 0 ||
    latexBalance(lines, "{", "}") > 0 ||
    latexBalance(lines, "[", "]") > 0 ||
    latexEnvironmentBalance(lines) > 0
  );
}

const VISUAL_COMMAND_OPTIONS = [
  { label: "\\(", insert: "\\(x\\)", detail: "math", info: "Inline formula", math: true },
  { label: "\\[", insert: "\\[\nx\n\\]", detail: "math", info: "Display formula", math: true, display: true },
  { label: "\\frac", insert: "\\frac{}{}", detail: "math", info: "Fraction", math: true },
  { label: "\\sqrt", insert: "\\sqrt{}", detail: "math", info: "Square root", math: true },
  { label: "\\sum", insert: "\\sum_{}^{}", detail: "math", info: "Summation", math: true },
  { label: "\\int", insert: "\\int_{}^{}", detail: "math", info: "Integral", math: true },
  { label: "\\alpha", insert: "\\alpha", detail: "math", info: "Greek alpha", math: true },
  { label: "\\beta", insert: "\\beta", detail: "math", info: "Greek beta", math: true },
  { label: "\\gamma", insert: "\\gamma", detail: "math", info: "Greek gamma", math: true },
  { label: "\\delta", insert: "\\delta", detail: "math", info: "Greek delta", math: true },
  { label: "\\theta", insert: "\\theta", detail: "math", info: "Greek theta", math: true },
  { label: "\\lambda", insert: "\\lambda", detail: "math", info: "Greek lambda", math: true },
  { label: "\\pi", insert: "\\pi", detail: "math", info: "Greek pi", math: true },
  { label: "\\sigma", insert: "\\sigma", detail: "math", info: "Greek sigma", math: true },
  { label: "\\omega", insert: "\\omega", detail: "math", info: "Greek omega", math: true },
  { label: "\\times", insert: "\\times", detail: "math", info: "Multiplication", math: true },
  { label: "\\leq", insert: "\\leq", detail: "math", info: "Less than or equal", math: true },
  { label: "\\geq", insert: "\\geq", detail: "math", info: "Greater than or equal", math: true },
  { label: "\\neq", insert: "\\neq", detail: "math", info: "Not equal", math: true },
  { label: "\\infty", insert: "\\infty", detail: "math", info: "Infinity", math: true },
  { label: "\\cite", insert: "\\cite{}", detail: "cite", info: "Citation" },
  { label: "\\ref", insert: "\\ref{}", detail: "ref", info: "Reference" },
  { label: "\\label", insert: "\\label{}", detail: "label", info: "Label" },
  { label: "\\textbf", insert: "\\textbf{}", detail: "cmd", info: "Bold text" },
  { label: "\\textit", insert: "\\textit{}", detail: "cmd", info: "Italic text" },
  { label: "\\texttt", insert: "\\texttt{}", detail: "cmd", info: "Monospace text" }
];

function visualMathInlineHtml(content, mode = "inline") {
  const text = String(content || "").trim() || "x";
  return `<span class="visual-math-chip visual-math-${mode}" data-latex-math="${mode}" contenteditable="true" spellcheck="false">${visualLatexSourceHtml(text)}</span>`;
}

function visualInlineHtml(text) {
  const mathSegments = [];
  const protectMath = (match, inlineA, inlineB, displayA) => {
    const mode = displayA !== undefined ? "display" : "inline";
    const content = inlineA ?? inlineB ?? displayA ?? "";
    const marker = `\uE100${mathSegments.length}\uE101`;
    mathSegments.push(visualMathInlineHtml(content, mode));
    return marker;
  };
  const source = String(text || "")
    .replace(/\\\(([\s\S]*?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$|\\\[([\s\S]*?)\\\]/g, protectMath)
    .replace(/\\\\\s*(?:\n|$)/g, "\uE000");
  let html = escapeHtml(latexUnescapeText(source));
  html = html.replace(/\\textbf\{([^{}]*)\}/g, "<strong data-latex-inline=\"textbf\">$1</strong>");
  html = html.replace(/\\(?:textit|emph)\{([^{}]*)\}/g, "<em data-latex-inline=\"textit\">$1</em>");
  html = html.replace(/\\texttt\{([^{}]*)\}/g, "<code data-latex-inline=\"texttt\">$1</code>");
  html = html.replace(/\\(?:cite|citep|citet|parencite|textcite)\{([^{}]*)\}/g, "<span class=\"visual-chip\" data-latex-raw=\"\\\\cite{$1}\">cite:$1</span>");
  html = html.replace(/\\(?:ref|eqref|autoref|pageref)\{([^{}]*)\}/g, "<span class=\"visual-chip\" data-latex-raw=\"\\\\ref{$1}\">ref:$1</span>");
  html = html.replace(/\uE000/g, "<br />");
  html = html.replace(/\uE100(\d+)\uE101/g, (_, index) => mathSegments[Number(index)] || "");
  return html;
}

function visualLatexSourceHtml(text) {
  return escapeHtml(text)
    .replace(/(\\[a-zA-Z@]+)(\*?)/g, "<span class=\"visual-latex-command\">$1$2</span>")
    .replace(/(\\)(?=[^a-zA-Z@]|$)/g, "<span class=\"visual-latex-command\">$1</span>");
}

function visualSourceLineMarkup(text, className = "") {
  return `<div class="visual-source-line ${className}">${visualLatexSourceHtml(text)}</div>`;
}

function inlineNodeToLatex(node) {
  if (node.nodeType === Node.TEXT_NODE) return latexEscapeText(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const raw = node.getAttribute("data-latex-raw");
  if (raw) return raw;
  const mathMode = node.getAttribute("data-latex-math");
  if (mathMode) {
    const content = (node.textContent || "").trim() || "x";
    return mathMode === "display" ? `\n\\[\n${content}\n\\]\n` : `\\(${content}\\)`;
  }
  const children = [...node.childNodes].map(inlineNodeToLatex).join("");
  if (node.tagName === "BR") return "\\\\\n";
  if (node.tagName === "DIV" || node.tagName === "P") {
    const text = children.trim();
    return text ? `${text}\\\\\n` : "\n";
  }
  const inline = node.getAttribute("data-latex-inline");
  if (inline) return `\\${inline}{${children}}`;
  if (node.tagName === "STRONG" || node.tagName === "B") return `\\textbf{${children}}`;
  if (node.tagName === "EM" || node.tagName === "I") return `\\textit{${children}}`;
  if (node.tagName === "CODE") return `\\texttt{${children}}`;
  return children;
}

function blockContentToLatex(element) {
  return [...element.childNodes]
    .map(inlineNodeToLatex)
    .join("")
    .replace(/(?:\\\\\s*){2,}$/g, "\\\\")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLatexCells(row) {
  const cells = [];
  let current = "";
  let escaped = false;
  for (const char of row) {
    if (char === "&" && !escaped) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
    escaped = char === "\\" && !escaped;
    if (char !== "\\") escaped = false;
  }
  cells.push(current.trim());
  return cells;
}

function parseLatexTableBlock(text) {
  const source = String(text || "");
  const tabular = source.match(/\\begin\{tabular\}\{([^}]*)\}([\s\S]*?)\\end\{tabular\}/);
  if (!tabular) return null;
  const tableBegin = source.match(/\\begin\{table\}(?:\[([^\]]*)\])?/);
  const caption = source.match(/\\caption(?:\[[^\]]*\])?\{([^{}]*)\}/);
  const label = source.match(/\\label\{([^{}]*)\}/);
  const tableBody = tabular[2]
    .replace(/\\hline/g, "")
    .replace(/\\toprule|\\midrule|\\bottomrule/g, "");
  const rows = tableBody
    .split(/\\\\/)
    .map((row) => row.replace(/%.*$/gm, "").trim())
    .filter(Boolean)
    .map((row) => splitLatexCells(row).map((cell) => latexUnescapeText(cell)));
  const colCount = Math.max(1, ...rows.map((row) => row.length), (tabular[1].match(/[lcrpmbX]/g) || []).length);
  const normalizedRows = (rows.length ? rows : [Array.from({ length: colCount }, () => "")])
    .map((row) => Array.from({ length: colCount }, (_, index) => row[index] || ""));
  return {
    type: "table",
    rows: normalizedRows,
    caption: latexUnescapeText(caption?.[1] || ""),
    label: label?.[1] || "tab:placeholder",
    placement: tableBegin?.[1] || "h",
    colSpec: tabular[1] || "l".repeat(colCount),
    borders: /\\hline|\\toprule|\\midrule|\\bottomrule/.test(source) ? "borders" : "none"
  };
}

function parseLatexFigureBlock(text) {
  const source = String(text || "");
  if (!/\\begin\{figure\}/.test(source) || !/\\end\{figure\}/.test(source)) return null;
  const figureBegin = source.match(/\\begin\{figure\}(?:\[([^\]]*)\])?/);
  const image = source.match(/\\includegraphics(?:\[[^\]]*\])?\{([^{}]*)\}/);
  const options = source.match(/\\includegraphics(?:\[([^\]]*)\])?\{([^{}]*)\}/);
  const caption = source.match(/\\caption(?:\[[^\]]*\])?\{([^{}]*)\}/);
  const label = source.match(/\\label\{([^{}]*)\}/);
  if (!image && !caption && !label) return null;
  return {
    type: "figure",
    image: stripLatexAssetQuotes(latexUnescapeText(image?.[1] || "")),
    caption: latexUnescapeText(caption?.[1] || ""),
    label: label?.[1] || "fig:placeholder",
    placement: figureBegin?.[1] || "h",
    options: options?.[1] || "width=0.8\\linewidth"
  };
}

function parseLatexMathBlock(text) {
  const source = String(text || "").trim();
  const bracket = source.match(/^\\\[([\s\S]*?)\\\]$/);
  if (bracket) {
    return {
      type: "math",
      mode: "display",
      syntax: "bracket",
      text: bracket[1].trim() || "x"
    };
  }
  const environment = source.match(/^\\begin\{(equation\*?|displaymath|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}$/);
  if (environment) {
    return {
      type: "math",
      mode: "display",
      syntax: "environment",
      environment: environment[1],
      text: environment[2].trim() || "x"
    };
  }
  return null;
}

function visualTableToLatex(block) {
  const rows = [...block.querySelectorAll(".visual-table-grid tr")].map((row) =>
    [...row.querySelectorAll("td, th")].map((cell) => latexEscapeText(cell.textContent.trim()))
  );
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  const savedSpec = block.dataset.tableColspec || "";
  const colSpec = (savedSpec.match(/[lcrpmbX]/g) || []).length === colCount ? savedSpec : "l".repeat(colCount);
  const placement = block.dataset.tablePlacement || "h";
  const borders = block.dataset.tableBorders !== "none";
  const bodyRows = (rows.length ? rows : [Array.from({ length: colCount }, () => "")])
    .map((row) => `    ${Array.from({ length: colCount }, (_, index) => row[index] || "").join(" & ")} \\\\`);
  const caption = latexEscapeText(block.querySelector(".visual-table-caption")?.textContent.trim() || "Caption");
  const label = latexEscapeText(block.querySelector(".visual-table-label")?.textContent.trim() || "tab:placeholder");
  return [
    `\\begin{table}[${placement}]`,
    "  \\centering",
    `  \\begin{tabular}{${colSpec}}`,
    borders ? "    \\hline" : "",
    ...bodyRows,
    borders ? "    \\hline" : "",
    "  \\end{tabular}",
    `  \\caption{${caption}}`,
    `  \\label{${label}}`,
    "\\end{table}"
  ].filter(Boolean).join("\n");
}

function visualMathToLatex(block) {
  const text = block.querySelector(".visual-math-input")?.textContent.trim() || "x";
  const syntax = block.dataset.mathSyntax || "bracket";
  const environment = block.dataset.mathEnvironment || "equation";
  if (syntax === "environment") {
    return [`\\begin{${environment}}`, text, `\\end{${environment}}`].join("\n");
  }
  return ["\\[", text, "\\]"].join("\n");
}

function visualFigureToLatex(block) {
  const image = stripLatexAssetQuotes(block.querySelector(".visual-figure-image")?.textContent.trim() || "image.png").replace(/"/g, "");
  const caption = latexEscapeText(block.querySelector(".visual-figure-caption")?.textContent.trim() || "Caption");
  const label = block.querySelector(".visual-figure-label")?.textContent.trim() || "fig:placeholder";
  const placement = block.querySelector(".visual-figure-placement")?.textContent.trim() || block.dataset.figurePlacement || "h";
  const options = block.querySelector(".visual-figure-options")?.textContent.trim() || block.dataset.figureOptions || "width=0.8\\linewidth";
  return [
    `\\begin{figure}[${placement}]`,
    "  \\centering",
    `  \\includegraphics[${options}]{"${image}"}`,
    `  \\caption{${caption}}`,
    `  \\label{${label}}`,
    "\\end{figure}"
  ].join("\n");
}

function visualBlockToLatex(block) {
  const type = block?.dataset?.visualType;
  if (type === "heading") {
    const level = block.dataset.headingLevel || "section";
    const star = block.dataset.headingStarred === "1" ? "*" : "";
    const text = block.querySelector(".visual-heading-input")?.textContent || "";
    const label = block.querySelector(".visual-heading-label")?.textContent.trim() || "";
    return `\\${level}${star}{${latexEscapeText(text.trim())}}${label ? `\\label{${label}}` : ""}`;
  }
  if (type === "paragraph") {
    const input = block.querySelector(".visual-paragraph-input");
    return blockContentToLatex(input || block);
  }
  if (type === "raw") return visualRawBlockText(block);
  if (type === "blank") return "";
  if (type === "table") return visualTableToLatex(block);
  if (type === "math") return visualMathToLatex(block);
  if (type === "figure") return visualFigureToLatex(block);
  return "";
}

function keepVisualInsertionsInsideDocument(source) {
  const latex = String(source || "");
  const marker = "\\end{document}";
  const index = latex.indexOf(marker);
  if (index < 0) return latex;
  const before = latex.slice(0, index).trimEnd();
  const after = latex.slice(index + marker.length).trim();
  if (!after) return latex;
  return `${before}\n\n${after}\n\n${marker}`;
}

function parseVisualLatex(content) {
  const blocks = [];
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  let paragraph = [];
  let paragraphStartLine = 1;
  let raw = [];
  let rawStartLine = 1;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join("\n").trim(), line: paragraphStartLine });
    paragraph = [];
  };

  const flushRaw = () => {
    if (!raw.length) return;
    const rawText = raw.join("\n");
    const math = parseLatexMathBlock(rawText);
    const table = math ? null : parseLatexTableBlock(rawText);
    const figure = table || math ? null : parseLatexFigureBlock(rawText);
    if (math) blocks.push({ ...math, line: rawStartLine });
    else if (table) blocks.push({ ...table, line: rawStartLine });
    else if (figure) blocks.push({ ...figure, line: rawStartLine });
    else blocks.push({ type: "raw", text: rawText, line: rawStartLine });
    raw = [];
  };

  const isPlainTextLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^\\\([^]*\\\)$/.test(trimmed) || /^(?<!\\)\$[^$]+(?<!\\)\$$/.test(trimmed)) return true;
    if (/^\\(?:textbf|textit|emph|texttt|cite|citep|citet|parencite|textcite|ref|eqref|autoref|pageref)\{/.test(trimmed)) return true;
    return !trimmed.startsWith("\\") && !trimmed.startsWith("%");
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (raw.length && visualRawBlockIsOpen(raw)) {
      raw.push(line);
      continue;
    }

    const heading = trimmed.match(/^\\(chapter|section|subsection|subsubsection|paragraph)(\*)?\{([^}]*)\}\s*(?:\\label\{([^{}]*)\})?\s*$/);
    if (heading) {
      flushParagraph();
      flushRaw();
      blocks.push({
        type: "heading",
        level: heading[1],
        starred: Boolean(heading[2]),
        text: latexUnescapeText(heading[3]),
        label: heading[4] || "",
        line: lineNumber
      });
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushRaw();
      blocks.push({ type: "blank", line: lineNumber });
      continue;
    }

    if (isPlainTextLine(line)) {
      flushRaw();
      if (!paragraph.length) paragraphStartLine = lineNumber;
      paragraph.push(line.trim());
      continue;
    }

    flushParagraph();
    if (!raw.length) rawStartLine = lineNumber;
    raw.push(line);
  }

  flushParagraph();
  flushRaw();
  return blocks.length ? blocks : [{ type: "paragraph", text: "", line: 1 }];
}

function visualLineNumberMarkup(block) {
  return `<span class="visual-line-number" aria-hidden="true">${escapeHtml(block.line || "")}</span>`;
}

function visualTextareaRows(text, minimum = 8, maximum = 28) {
  const lineCount = String(text || "").split("\n").length;
  return Math.max(minimum, Math.min(maximum, lineCount + 1));
}

function visualRawEditorLines(text, minimum = 9, maximum = 24) {
  return visualTextareaRows(text, minimum, maximum);
}

function visualBlockMarkup(block, index) {
  if (block.type === "heading") {
    const label = block.label
      ? `<span class="visual-heading-label-wrap" spellcheck="false"><span class="visual-latex-command">\\label</span>{<span class="visual-heading-label" contenteditable="true">${escapeHtml(block.label)}</span>}</span>`
      : "";
    return `
      <section class="visual-block visual-heading-block" data-visual-type="heading" data-heading-level="${escapeHtml(block.level)}" data-heading-starred="${block.starred ? "1" : "0"}">
        ${visualLineNumberMarkup(block)}
        <div class="visual-block-body visual-heading-body">
          <div class="visual-heading-line">
            <div class="visual-heading-input" contenteditable="true" spellcheck="true">${escapeHtml(block.text)}</div>
            ${label}
          </div>
        </div>
      </section>
    `;
  }
  if (block.type === "paragraph") {
    return `
      <section class="visual-block visual-paragraph-block" data-visual-type="paragraph">
        ${visualLineNumberMarkup(block)}
        <div class="visual-block-body">
          <div class="visual-paragraph-input" contenteditable="true" spellcheck="true">${visualInlineHtml(block.text)}</div>
        </div>
      </section>
    `;
  }
  if (block.type === "blank") {
    return `
      <section class="visual-block visual-paragraph-block visual-blank-block" data-visual-type="paragraph" aria-label="Blank line">
        ${visualLineNumberMarkup(block)}
        <div class="visual-block-body">
          <div class="visual-paragraph-input" contenteditable="true" spellcheck="true"></div>
        </div>
      </section>
    `;
  }
  if (block.type === "table") {
    const rows = block.rows || [["", ""]];
    const placement = block.placement || "h";
    const colSpec = block.colSpec || "l".repeat(Math.max(1, ...rows.map((row) => row.length)));
    return `
      <section class="visual-block visual-table-block" data-visual-type="table" data-table-borders="${escapeHtml(block.borders || "borders")}" data-table-placement="${escapeHtml(placement)}" data-table-colspec="${escapeHtml(colSpec)}">
        ${visualLineNumberMarkup(block)}
        <div class="visual-block-body visual-table-shell visual-latex-object">
          <div class="visual-object-toolbar" aria-label="Table controls">
            <select class="visual-table-borders" title="Table borders" aria-label="Table borders">
              <option value="borders" ${(block.borders || "borders") === "borders" ? "selected" : ""}>Borders</option>
              <option value="none" ${(block.borders || "borders") === "none" ? "selected" : ""}>No borders</option>
            </select>
            <button type="button" class="mini-button visual-table-add-row" title="Add row">+ Row</button>
            <button type="button" class="mini-button visual-table-add-column" title="Add column">+ Col</button>
          </div>
          <div class="visual-object-source">
            ${visualSourceLineMarkup(`\\begin{table}[${placement}]`)}
            ${visualSourceLineMarkup("  \\centering")}
          </div>
          <div class="visual-table-wrap" style="--visual-table-columns:${rows[0].length || 1}">
            <div class="visual-table-handle-row" aria-hidden="true">${rows[0].map(() => "<span></span>").join("")}</div>
            <table class="visual-table-grid">
              <tbody>
                ${rows.map((row) => `<tr>${row.map((cell) => `<td contenteditable="true" spellcheck="true">${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}
              </tbody>
            </table>
          </div>
          <div class="visual-table-caption" contenteditable="true" spellcheck="true">${escapeHtml(block.caption || "Caption")}</div>
          <div class="visual-table-label-row"><span aria-hidden="true">label:</span><span class="visual-table-label" contenteditable="true" spellcheck="false">${escapeHtml(block.label || "tab:placeholder")}</span></div>
          <div class="visual-object-source">
            ${visualSourceLineMarkup("\\end{table}")}
          </div>
        </div>
      </section>
    `;
  }
  if (block.type === "math") {
    const syntax = block.syntax || "bracket";
    const environment = block.environment || "equation";
    const opening = syntax === "environment" ? `\\begin{${environment}}` : "\\[";
    const closing = syntax === "environment" ? `\\end{${environment}}` : "\\]";
    return `
      <section class="visual-block visual-math-block" data-visual-type="math" data-math-syntax="${escapeHtml(syntax)}" data-math-environment="${escapeHtml(environment)}">
        ${visualLineNumberMarkup(block)}
        <div class="visual-block-body visual-math-shell visual-latex-object visual-source-like-object">
          <div class="visual-object-source visual-math-source">
            ${visualSourceLineMarkup(opening)}
            <div class="visual-math-input" contenteditable="true" spellcheck="false">${visualLatexSourceHtml(block.text || "x")}</div>
            ${visualSourceLineMarkup(closing)}
          </div>
        </div>
      </section>
    `;
  }
  if (block.type === "figure") {
    const placement = block.placement || "h";
    const options = block.options || "width=0.8\\linewidth";
    return `
      <section class="visual-block visual-figure-block" data-visual-type="figure" data-figure-placement="${escapeHtml(placement)}" data-figure-options="${escapeHtml(options)}">
        ${visualLineNumberMarkup(block)}
        <div class="visual-block-body visual-figure-shell visual-latex-object visual-source-like-object">
          <button type="button" class="visual-object-edit-button" title="Edit figure source" aria-label="Edit figure source">${editorToolIcon("edit")}</button>
          <div class="visual-object-source visual-figure-source">
            <div class="visual-source-line"><span class="visual-latex-command">\\begin</span>{figure}[<span class="visual-figure-placement" contenteditable="true" spellcheck="false">${escapeHtml(placement)}</span>]</div>
            ${visualSourceLineMarkup("  \\centering")}
            <div class="visual-object-inline-line visual-figure-line"><span class="visual-latex-command">\\includegraphics</span>[<span class="visual-figure-options" contenteditable="true" spellcheck="false">${escapeHtml(options)}</span>]{"<span class="visual-figure-image" contenteditable="true" spellcheck="false">${escapeHtml(block.image || "image.png")}</span>"}</div>
            <div class="visual-object-inline-line visual-caption-line"><span class="visual-latex-command">\\caption</span>{<span class="visual-figure-caption" contenteditable="true" spellcheck="true">${escapeHtml(block.caption || "Caption")}</span>}</div>
            <div class="visual-object-inline-line visual-label-line"><span class="visual-latex-command">\\label</span>{<span class="visual-figure-label" contenteditable="true" spellcheck="false">${escapeHtml(block.label || "fig:placeholder")}</span>}</div>
            ${visualSourceLineMarkup("\\end{figure}")}
          </div>
        </div>
      </section>
    `;
  }
  return `
    <section class="visual-block visual-raw-block visual-source-block ${block.expanded ? "visual-expanded-source-block" : ""}" data-visual-type="raw">
      ${visualLineNumberMarkup(block)}
      <div class="visual-block-body visual-raw-shell visual-source-shell">
        <div class="visual-raw-code-mount" data-visual-raw-code style="--raw-editor-lines:${visualRawEditorLines(block.text, block.expanded ? 10 : 7)}">${escapeHtml(block.text)}</div>
        <textarea class="visual-raw-input" rows="${visualTextareaRows(block.text, block.expanded ? 10 : 7)}" spellcheck="false" aria-label="Raw LaTeX block ${index + 1}">${escapeHtml(block.text)}</textarea>
      </div>
    </section>
  `;
}

function visualLatexMarkup(content) {
  return parseVisualLatex(content).map(visualBlockMarkup).join("");
}

function visualDomToLatex(host) {
  const blocks = [];
  host.querySelectorAll(".visual-block").forEach((block) => {
    blocks.push(visualBlockToLatex(block));
  });
  return keepVisualInsertionsInsideDocument(blocks.join("\n").replace(/\n{4,}/g, "\n\n\n"));
}

function editorBreadcrumbMarkup(file, selection) {
  const parts = String(file || "").split("/").filter(Boolean);
  const section = selection.canEditSelected
    ? selection.outline.find((item) => item?.title)?.title
    : "";
  const crumbs = parts.map((part, index) => {
    const isFile = index === parts.length - 1;
    return `<span class="${isFile ? "active" : ""}">${escapeHtml(part)}${isFile && file === local.appState.project.mainFile ? " (main)" : ""}</span>`;
  });
  if (section) crumbs.push(`<span>${escapeHtml(section)}</span>`);
  return crumbs.length ? crumbs.join(`<i aria-hidden="true"></i>`) : `<span>No file selected</span>`;
}

function outlineTreeMarkup(outlineItems = [], currentTitle = "") {
  if (!outlineItems.length) {
    return `<div class="outline-empty">No sections found.</div>`;
  }
  return `
    <div class="outline-tree" role="tree">
      ${outlineItems.map((item, index) => {
        const next = outlineItems[index + 1];
        const hasChildren = Boolean(next && next.level > item.level);
        const active = currentTitle && item.title === currentTitle;
        return `
          <button class="outline-row ${active ? "active" : ""}" type="button" role="treeitem" style="--outline-depth:${item.level}">
            <span class="outline-caret ${hasChildren ? "has-children" : ""}" aria-hidden="true">${hasChildren ? editorToolIcon("chevronRight") : ""}</span>
            <span class="outline-title">${escapeHtml(item.title)}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function editorSurfaceMarkup(file, selectedMeta) {
  if (isEditableFile(selectedMeta)) {
    return `<div class="editor-code-mount" id="editorText" data-file="${escapeHtml(file)}"></div>`;
  }
  if (isPdfAsset(selectedMeta)) {
    return `<div class="asset-preview"><iframe title="PDF asset preview" src="${authUrl(`/api/asset?path=${encodeURIComponent(file)}`)}"></iframe><span>${escapeHtml(file)}</span></div>`;
  }
  if (isBrowserImageAsset(selectedMeta)) {
    return `<div class="asset-preview"><img src="${authUrl(`/api/asset?path=${encodeURIComponent(file)}`)}" alt="${escapeHtml(selectedMeta.name)}" /><span>${escapeHtml(file)}</span></div>`;
  }
  return `<div class="asset-preview asset-unsupported"><strong>Preview unavailable</strong><span>${escapeHtml(file || "No file selected")}</span></div>`;
}

const EDITOR_STYLE_OPTIONS = [
  { value: "normal", label: "Normal text", className: "normal" },
  { value: "section", label: "Section", className: "section" },
  { value: "subsection", label: "Subsection", className: "subsection" },
  { value: "subsubsection", label: "Subsubsection", className: "subsubsection" },
  { value: "paragraph", label: "Paragraph", className: "paragraph" },
  { value: "subparagraph", label: "Subparagraph", className: "subparagraph" }
];

function editorStyleDropdownMarkup() {
  return `
    <div class="editor-style-menu-wrap ${local.editorStyleMenuOpen ? "open" : ""}">
      <button class="editor-style-button ${local.editorStyleMenuOpen ? "active" : ""}" id="editorStyleButton" type="button" title="Insert section command" aria-label="Insert section command" aria-haspopup="menu" aria-expanded="${local.editorStyleMenuOpen ? "true" : "false"}">
        <span>Normal text</span>
        <span class="style-chevron" aria-hidden="true">${editorToolIcon("chevronDown")}</span>
      </button>
      ${editorStyleMenuMarkup()}
    </div>
  `;
}

function editorStyleMenuMarkup() {
  return `
    <div class="editor-style-menu" role="menu" aria-label="Text style" aria-hidden="${local.editorStyleMenuOpen ? "false" : "true"}" ${local.editorStyleMenuOpen ? "" : "inert"}>
      ${EDITOR_STYLE_OPTIONS.map((item) => `
        <button type="button" class="editor-style-option ${escapeHtml(item.className)}" data-style-value="${escapeHtml(item.value)}" role="menuitem" tabindex="-1">
          ${escapeHtml(item.label)}
        </button>
      `).join("")}
    </div>
  `;
}

function editorFormatToolbarMarkup() {
  const tool = (command, label, title, extra = "", id = "") =>
    `<button class="editor-tool-button ${extra}" ${id ? `id="${id}"` : ""} data-editor-command="${command}" title="${title}" aria-label="${title}">${label}</button>`;
  return `
    <div class="editor-format-row" role="toolbar" aria-label="LaTeX editor tools">
      <button class="editor-files-tab-button" id="showFilesPanelInline" title="Show files" aria-label="Show files">
        ${editorToolIcon("files")}
        <span>Files</span>
      </button>
      ${tool("undo", editorToolIcon("undo"), "Undo")}
      ${tool("redo", editorToolIcon("redo"), "Redo")}
      ${editorStyleDropdownMarkup()}
      ${tool("bold", "<strong>B</strong>", "Bold")}
      ${tool("italic", "<em>I</em>", "Italic")}
      ${tool("monospace", editorToolIcon("monospace"), "Monospace")}
      ${tool("symbol", editorToolIcon("symbol"), "Insert symbol")}
      ${tool("math", editorToolIcon("math"), "Insert formula")}
      ${tool("link", editorToolIcon("link"), "Insert link")}
      ${tool("ref", editorToolIcon("ref"), "Insert reference")}
      ${tool("cite", editorToolIcon("cite"), "Insert citation")}
      ${tool("comment", editorToolIcon("comment"), "Toggle comment")}
      ${tool("figure", editorToolIcon("figure"), "Insert figure")}
      ${tool("table", editorToolIcon("table"), "Insert table", "", "editorTableButton")}
      ${tool("bulletList", editorToolIcon("bulletList"), "Insert bullet list")}
      ${tool("numberedList", editorToolIcon("numberedList"), "Insert numbered list")}
      ${tool("outdent", editorToolIcon("outdent"), "Outdent")}
      ${tool("indent", editorToolIcon("indent"), "Indent")}
      ${tool("complete", editorToolIcon("complete"), "Open command autocomplete", "accent-tool")}
      <div class="editor-mode-toggle" role="tablist" aria-label="Editor mode">
        <button class="editor-mode-pill active" type="button" role="tab" data-editor-mode="code" aria-selected="true">Code Editor</button>
        <button class="editor-mode-pill coming-soon" type="button" role="tab" aria-selected="false" disabled title="Visual Editor is coming soon">Visual Editor <span>soon</span></button>
      </div>
      <span class="format-row-spacer editor-search-reserved-space" aria-hidden="true"></span>
      <div class="editor-search-launcher ${local.searchOpen ? "is-open" : ""}" id="editorSearchLauncher" role="search" aria-label="Quick search">
        <div class="editor-search-launcher-surface">
          <input id="editorQuickSearchInput" type="search" value="${escapeHtml(local.searchQuery)}" placeholder="Search" aria-label="Search" autocomplete="off" spellcheck="false" />
          <button class="editor-tool-button ${local.searchOpen ? "active" : ""}" id="editorSearchToggle" type="button" title="Search and replace" aria-label="Open search and replace" aria-controls="editorSearchPanel" aria-expanded="${local.searchOpen ? "true" : "false"}">
            ${editorToolIcon("search")}
          </button>
        </div>
      </div>
      <button class="editor-chat-tab-button" id="showChatRailInline" title="Show chat" aria-label="Show chat">
        ${editorToolIcon("chat")}
        <span>Chat</span>
      </button>
    </div>
  `;
}

function searchStatusMarkup() {
  const status = local.searchStatus || (local.searchLoading ? `${local.searchResults.length} found` : "");
  return `
    ${local.searchLoading ? `<span class="search-spinner" aria-hidden="true"></span>` : ""}
    <span id="searchStatusText">${escapeHtml(status)}</span>
  `;
}

function setEditorSearchQuery(value) {
  local.searchQuery = String(value || "");
  local.visualSearchIndex = 0;
  local.searchResultIndex = -1;
  local.searchStatus = "";
  ["#editorQuickSearchInput", "#editorSearchInput"].forEach((selector) => {
    const input = document.querySelector(selector);
    if (input && input.value !== local.searchQuery) input.value = local.searchQuery;
  });
  if (!local.searchOpen) return;
  if (local.searchScope === "project") scheduleProjectSearch();
  else updateSearchPanelDynamicState();
}

function projectSearchResultsMarkup() {
  if (local.searchScope !== "project") return "";
  if (!local.searchQuery.trim()) {
    return `<div class="project-search-empty">Search all text files in this project, including imported ZIP files.</div>`;
  }
  if (!local.searchResults.length) {
    return `<div class="project-search-empty">${local.searchLoading ? "Searching project files..." : "No matches found."}</div>`;
  }
  return `
    <div class="project-search-results" id="projectSearchResults" aria-label="Project search results">
      ${local.searchResults.map((result, index) => `
        <button type="button" class="project-search-result ${index === local.searchResultIndex ? "active" : ""}" data-search-result="${index}">
          <span class="project-search-file">${escapeHtml(result.path)}</span>
          <span class="project-search-meta">Line ${escapeHtml(result.line)}:${escapeHtml(result.column)}</span>
          <span class="project-search-preview">${escapeHtml(result.preview || result.text || "")}</span>
        </button>
      `).join("")}
      ${local.searchTruncated ? `<div class="project-search-empty">Showing the first ${PROJECT_SEARCH_MAX_RESULTS} matches.</div>` : ""}
    </div>
  `;
}

function editorSearchPanelMarkup() {
  if (!local.searchOpen) return "";
  const projectScope = local.searchScope === "project";
  return `
    <section class="editor-search-popover" id="editorSearchPanel" role="search" aria-label="Search and replace">
      <div class="editor-search-scope" role="group" aria-label="Search scope">
        <button type="button" class="${projectScope ? "active" : ""}" data-search-scope="project" aria-pressed="${projectScope ? "true" : "false"}">All files</button>
        <button type="button" class="${!projectScope ? "active" : ""}" data-search-scope="file" aria-pressed="${!projectScope ? "true" : "false"}">Current file</button>
      </div>
      <div class="editor-search-fields">
        <div class="editor-search-input-row">
          <input id="editorSearchInput" value="${escapeHtml(local.searchQuery)}" placeholder="Search for" autocomplete="off" />
          <button class="search-toggle ${local.searchMatchCase ? "active" : ""}" id="searchMatchCase" title="Match case" aria-label="Match case" aria-pressed="${local.searchMatchCase ? "true" : "false"}">Aa</button>
          <button class="search-toggle ${local.searchRegex ? "active" : ""}" id="searchRegex" title="Use regular expression" aria-label="Use regular expression" aria-pressed="${local.searchRegex ? "true" : "false"}">.*</button>
          <button class="search-toggle ${local.searchWholeWord ? "active" : ""}" id="searchWholeWord" title="Whole word" aria-label="Whole word" aria-pressed="${local.searchWholeWord ? "true" : "false"}">W</button>
        </div>
        <input id="editorReplaceInput" value="${escapeHtml(local.searchReplace)}" placeholder="Replace with" autocomplete="off" />
      </div>
      <div class="editor-search-actions">
        <button class="editor-tool-button" id="searchPrevious" title="Previous match" aria-label="Previous match">${editorToolIcon("arrowUp")}</button>
        <button class="editor-tool-button" id="searchNext" title="Next match" aria-label="Next match">${editorToolIcon("arrowDown")}</button>
        <button class="btn" id="replaceOne" ${projectScope ? "disabled" : ""}>Replace</button>
        <button class="btn btn-primary" id="replaceAll">${projectScope ? "Replace all files" : "Replace all"}</button>
        <span class="search-status" id="searchStatus">${searchStatusMarkup()}</span>
        <button class="editor-tool-button" id="closeSearchPanel" title="Close search" aria-label="Close search">${editorToolIcon("close")}</button>
      </div>
      ${projectScope ? `<div class="project-search-note">Searches every text file. Replace all asks for confirmation.</div>` : ""}
      ${projectSearchResultsMarkup()}
    </section>
  `;
}

function tablePickerMarkup() {
  if (!local.tablePickerOpen || local.editorMode !== "visual") return "";
  const sizes = [];
  for (let row = 1; row <= 5; row += 1) {
    for (let col = 1; col <= 5; col += 1) {
      sizes.push(`<button type="button" class="table-size-cell" data-rows="${row}" data-cols="${col}" title="${row} x ${col}" aria-label="Insert ${row} by ${col} table"></button>`);
    }
  }
  return `
    <section class="editor-table-popover" aria-label="Insert table">
      <strong>Insert table</strong>
      <button type="button" class="table-from-text" id="tableFromText">From text or image</button>
      <span id="tableSizeHint">Select size</span>
      <div class="table-size-grid">${sizes.join("")}</div>
    </section>
  `;
}

function compiledPreviewMarkup() {
  const state = local.appState;
  if (state.compile.mode === "pdf" && state.compile.pdfAvailable) {
    return `<div class="pdf-preview-mount" data-pdf-url="${escapeHtml(authUrl(`/api/pdf?v=${state.compile.version}`))}" data-pdf-version="${Number(state.compile.version || 0)}" data-pdf-artifact-id="${escapeHtml(state.compile.artifactId || "")}"></div>`;
  }
  return state.compile.previewHtml || `<article class="paper-preview"><header class="paper-title"><h1>Compile to Preview</h1><p>Click Recompile to render the document preview.</p></header></article>`;
}

function compileUsesLastGoodPreview(compile = local.appState?.compile || {}) {
  return Boolean(
    compile.previewStale
    || compile.usingPreviousPdf
    || compile.isStale
    || (compile.status === "failed" && compile.mode === "pdf" && compile.pdfPath)
  );
}

function compileBusyLabel() {
  return local.compilePhase === "saving"
    ? "Saving changes before compile"
    : `Compiling ${local.appState?.project?.mainFile || "project"}`;
}

function capturePreviewScroll(previewPane = document.querySelector("#previewPane")) {
  if (!previewPane) return null;
  if (previewPane.querySelector(".pdf-document") && window.LocalLeafPdfPreview?.captureScroll) {
    return window.LocalLeafPdfPreview.captureScroll(previewPane);
  }
  const maxTop = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
  const maxLeft = Math.max(0, previewPane.scrollWidth - previewPane.clientWidth);
  return {
    top: previewPane.scrollTop,
    left: previewPane.scrollLeft,
    topRatio: maxTop ? previewPane.scrollTop / maxTop : 0,
    leftRatio: maxLeft ? previewPane.scrollLeft / maxLeft : 0
  };
}

function restorePreviewScroll(scrollState, previewPane = document.querySelector("#previewPane")) {
  if (!scrollState || !previewPane) return;
  if (previewPane.querySelector(".pdf-document") && window.LocalLeafPdfPreview?.restoreScroll) {
    window.LocalLeafPdfPreview.restoreScroll(previewPane, scrollState);
    return;
  }
  const apply = () => {
    const maxTop = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
    const maxLeft = Math.max(0, previewPane.scrollWidth - previewPane.clientWidth);
    previewPane.scrollTop = Math.min(maxTop, Math.max(scrollState.top, Math.round(maxTop * scrollState.topRatio)));
    previewPane.scrollLeft = Math.min(maxLeft, Math.max(scrollState.left, Math.round(maxLeft * scrollState.leftRatio)));
  };
  requestAnimationFrame(() => {
    apply();
    setTimeout(apply, 150);
    setTimeout(apply, 450);
  });
}

function previewActionsMarkup(compile = local.appState?.compile || {}) {
  if (compile.mode !== "pdf") {
    return `<span>${escapeHtml(compile.status || "")}</span>`;
  }
  return `
    ${compileUsesLastGoodPreview(compile) ? `<span class="compile-stale-note" title="The latest compile failed. This PDF is from the last successful compile.">Last good PDF</span>` : ""}
    <div class="pdf-zoom-controls" aria-label="PDF zoom controls">
      <button class="pdf-zoom-button" id="pdfZoomOut" type="button" title="Zoom out" aria-label="Zoom out">-</button>
      <span class="pdf-zoom-value" id="pdfZoomValue">${Math.round(local.pdfScale * 100)}%</span>
      <button class="pdf-zoom-button" id="pdfZoomIn" type="button" title="Zoom in" aria-label="Zoom in">+</button>
    </div>
    <a class="pdf-link" href="${authUrl(`/api/pdf?v=${compile.version}`)}" target="_blank" rel="noopener">PDF</a>
    ${compile.sourceMapAvailable ? `<span class="pdf-source-chip">SyncTeX</span>` : ""}
    <span class="pdf-source-status" id="pdfSourceStatus" role="status" aria-live="polite" title="${escapeHtml(pdfSourceStatusTitle())}">${escapeHtml(pdfSourceStatusLabel())}</span>
    <button class="pdf-annotate-button ${local.pdfAnnotateMode ? "active" : ""}" id="pdfAnnotateButton" type="button" title="Annotate PDF with AI" aria-label="Annotate PDF with AI" aria-pressed="${local.pdfAnnotateMode ? "true" : "false"}">
      ${editorToolIcon("annotate")}
      <span>Annotate</span>
    </button>
    <span>${escapeHtml(compile.status || "")}</span>
  `;
}

function compileLogLevel(line) {
  const text = String(line || "");
  if (
    /^! /.test(text) ||
    /\b(error|fatal|failed|failure|emergency stop|undefined control sequence|missing \$|runaway argument)\b/i.test(text)
  ) {
    return "error";
  }
  if (
    /\b(warning|warn|overfull|underfull|rerun|undefined references?|citation .* undefined|reference .* undefined)\b/i.test(text)
  ) {
    return "warning";
  }
  if (/\b(success|successful|output written|done)\b/i.test(text)) return "success";
  return "info";
}

function compileLogCounts(lines = []) {
  return lines.reduce((counts, line) => {
    counts[compileLogLevel(line)] += 1;
    return counts;
  }, { error: 0, warning: 0, success: 0, info: 0 });
}

function compileLogSummaryMarkup(lines = []) {
  const counts = compileLogCounts(lines);
  return `
    <div class="log-summary" aria-label="Compile log summary">
      <span class="log-chip error"><strong>${counts.error}</strong><span>Errors</span></span>
      <span class="log-chip warning"><strong>${counts.warning}</strong><span>Warnings</span></span>
      <span class="log-chip info"><strong>${counts.info + counts.success}</strong><span>Info</span></span>
    </div>
  `;
}

function compileLogsMarkup(lines = []) {
  const recent = lines.slice(-120);
  if (!recent.length) {
    return `<div class="log-empty">No compile logs yet.</div>`;
  }
  return recent.map((line) => {
    const level = compileLogLevel(line);
    const label = level === "error" ? "Error" : level === "warning" ? "Warning" : level === "success" ? "OK" : "";
    return `
      <div class="log-line ${level}">
        ${label ? `<span class="log-level">${label}</span>` : `<span class="log-level subtle">log</span>`}
        <span class="log-text">${escapeHtml(line)}</span>
      </div>
    `;
  }).join("");
}

function compileIssueLines(compile = {}) {
  const logs = compile.logs || [];
  const issues = { errors: [], warnings: [] };
  for (const line of logs) {
    const level = compileLogLevel(line);
    if (level === "error") issues.errors.push(line);
    else if (level === "warning") issues.warnings.push(line);
  }
  if (!issues.errors.length && compile.status === "failed") {
    issues.errors.push(logs.findLast((line) => String(line || "").trim()) || "Compile failed.");
  }
  return {
    errors: [...new Set(issues.errors)].slice(-12),
    warnings: [...new Set(issues.warnings)].slice(-12)
  };
}

function syncPinnedCompileIssues(compile = {}) {
  if (!compile || compile.status === "running") return;
  const issues = compileIssueLines(compile);
  local.pinnedCompileErrors = issues.errors;
  if (!issues.warnings.length) {
    local.pinnedCompileWarnings = [];
    local.clearedWarningVersion = null;
  } else if (local.clearedWarningVersion !== compile.version) {
    local.pinnedCompileWarnings = issues.warnings;
  }
}

function pinnedLogLineMarkup(line, level) {
  const label = level === "error" ? "Error" : "Warning";
  return `
    <div class="log-line ${level} pinned">
      <span class="log-level">${label}</span>
      <span class="log-text">${escapeHtml(line)}</span>
    </div>
  `;
}

function compilePinnedIssuesMarkup() {
  const hasErrors = local.pinnedCompileErrors.length > 0;
  const hasWarnings = local.pinnedCompileWarnings.length > 0;
  if (!hasErrors && !hasWarnings) return "";
  return `
    ${hasErrors ? `
      <section class="pinned-log-group error" aria-label="Pinned compile errors">
        <div class="pinned-log-head">
          <strong>Errors</strong>
          <span>Fix these to clear them</span>
        </div>
        ${local.pinnedCompileErrors.map((line) => pinnedLogLineMarkup(line, "error")).join("")}
      </section>
    ` : ""}
    ${hasWarnings ? `
      <section class="pinned-log-group warning" aria-label="Pinned compile warnings">
        <div class="pinned-log-head">
          <strong>Warnings</strong>
          <button type="button" id="clearPinnedWarnings">Clear</button>
        </div>
        ${local.pinnedCompileWarnings.map((line) => pinnedLogLineMarkup(line, "warning")).join("")}
      </section>
    ` : ""}
  `;
}

function updatePdfZoomUi() {
  const label = document.querySelector("#pdfZoomValue");
  if (label) label.textContent = `${Math.round(local.pdfScale * 100)}%`;
}

function beginPdfPreviewMount(previewPane, pdfUrl, scrollState = null, identity = {}) {
  if (!previewPane || !pdfUrl || !window.LocalLeafPdfPreview?.mount) return false;
  const bindRetry = () => {
    const retry = previewPane.querySelector("[data-pdf-retry]");
    if (!retry) return;
    const replacement = retry.cloneNode(true);
    retry.replaceWith(replacement);
    replacement.addEventListener("click", () => {
      beginPdfPreviewMount(
        previewPane,
        pdfUrl,
        window.LocalLeafPdfPreview?.captureScroll?.(previewPane),
        identity
      );
    });
  };

  window.LocalLeafPdfPreview.mount(previewPane, {
    url: pdfUrl,
    scale: local.pdfScale,
    scrollState,
    artifactId: String(identity.artifactId || ""),
    version: Number(identity.version || 0),
    onError: () => {
      setTimeout(bindRetry, 0);
    }
  });
  return true;
}

function mountPdfPreview(scrollState = null) {
  const previewPane = document.querySelector("#previewPane");
  const marker = previewPane?.querySelector(".pdf-preview-mount");
  if (!previewPane || !marker || !window.LocalLeafPdfPreview?.mount) return false;
  if (local.appState?.compile?.status === "running") return false;
  beginPdfPreviewMount(previewPane, marker.dataset.pdfUrl, scrollState, {
    artifactId: marker.dataset.pdfArtifactId,
    version: marker.dataset.pdfVersion
  });
  updatePdfZoomUi();
  bindPdfPreviewInteractions();
  return true;
}

function setPdfScale(nextScale) {
  const previewPane = document.querySelector("#previewPane");
  const scrollState = window.LocalLeafPdfPreview?.captureScroll?.(previewPane) || capturePreviewScroll(previewPane);
  local.pdfScale = Math.max(0.5, Math.min(2.4, Math.round(Number(nextScale || 1) * 10) / 10));
  localStorage.setItem("localleaf.pdfScale", String(local.pdfScale));
  updatePdfZoomUi();
  if (previewPane && local.appState?.compile?.mode === "pdf" && window.LocalLeafPdfPreview?.zoom) {
    window.LocalLeafPdfPreview.zoom(previewPane, {
      scale: local.pdfScale,
      scrollState
    });
  } else if (previewPane && local.appState?.compile?.mode === "pdf" && window.LocalLeafPdfPreview?.remount) {
    window.LocalLeafPdfPreview.remount(previewPane, {
      scale: local.pdfScale,
      scrollState
    });
  }
}

function updatePdfAnnotateUi() {
  const button = document.querySelector("#pdfAnnotateButton");
  if (button) {
    button.classList.toggle("active", local.pdfAnnotateMode);
    button.setAttribute("aria-pressed", local.pdfAnnotateMode ? "true" : "false");
  }
  document.querySelector("#previewPane")?.classList.toggle("pdf-annotate-active", local.pdfAnnotateMode);
  if (!local.pdfAnnotateMode) removePdfAnnotationOutline();
}

function setPdfAnnotateMode(enabled, options = {}) {
  local.pdfAnnotateMode = Boolean(enabled);
  if (options.closePopover !== false) closePdfAnnotationPopover();
  updatePdfAnnotateUi();
}

let pdfAnnotationPointerFrame = 0;
let pendingPdfAnnotationPointer = null;

function cancelPendingPdfAnnotationPointer() {
  pendingPdfAnnotationPointer = null;
  if (pdfAnnotationPointerFrame) cancelAnimationFrame(pdfAnnotationPointerFrame);
  pdfAnnotationPointerFrame = 0;
}

function bindPdfPreviewControls() {
  document.querySelector("#pdfZoomOut")?.addEventListener("click", () => setPdfScale(local.pdfScale - 0.1));
  document.querySelector("#pdfZoomIn")?.addEventListener("click", () => setPdfScale(local.pdfScale + 0.1));
  document.querySelector("#pdfAnnotateButton")?.addEventListener("click", () => {
    setPdfAnnotateMode(!local.pdfAnnotateMode);
  });
}

function bindPdfWheelZoom() {
  const previewPane = document.querySelector("#previewPane");
  if (!previewPane || previewPane.dataset.ctrlWheelZoomBound === "1") return;
  previewPane.dataset.ctrlWheelZoomBound = "1";
  previewPane.addEventListener("wheel", (event) => {
    if (!event.ctrlKey || local.appState?.compile?.mode !== "pdf") return;
    event.preventDefault();
    setPdfScale(local.pdfScale + (event.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });
}

function bindPdfPreviewInteractions() {
  const previewPane = document.querySelector("#previewPane");
  if (!previewPane || previewPane.dataset.pdfClickBound === "1") return;
  previewPane.dataset.pdfClickBound = "1";
  previewPane.addEventListener("click", handlePdfPreviewClick);
  previewPane.addEventListener("pointermove", handlePdfAnnotationPointerMove, { passive: true });
  previewPane.addEventListener("pointerleave", () => {
    cancelPendingPdfAnnotationPointer();
    if (!local.pdfAnnotationPopover) removePdfAnnotationOutline();
  }, { passive: true });
  updatePdfAnnotateUi();
}

function pdfClickTarget(event) {
  const page = event.target.closest?.(".pdf-page[data-page-number]");
  if (!page) return null;
  const previewMount = page.closest?.(".pdf-preview-mount");
  const rect = page.getBoundingClientRect();
  const pageNumber = Number(page.dataset.pageNumber || 1);
  const targetPreview = pdfAnnotationTargetAtPoint(page, event.clientX, event.clientY, rect);
  const x = Math.max(0, (event.clientX - rect.left) / Math.max(0.1, local.pdfScale));
  const y = Math.max(0, (event.clientY - rect.top) / Math.max(0.1, local.pdfScale));
  return {
    page: pageNumber,
    x,
    y,
    version: Number(previewMount?.dataset.pdfVersion || local.appState?.compile?.version || 0),
    artifactId: String(previewMount?.dataset.pdfArtifactId || local.appState?.compile?.artifactId || ""),
    clientX: event.clientX,
    clientY: event.clientY,
    elementType: targetPreview?.type || (targetPreview?.textPreview ? "text" : "page-area"),
    targetRect: targetPreview?.outline || null,
    textPreview: targetPreview?.textPreview || pdfTextPreviewAtPoint(page, event.clientX, event.clientY, rect),
    outline: targetPreview?.outline || null
  };
}

function fileExtension(filePath = "") {
  const name = String(filePath || "").split(/[\\/]/u).pop() || "";
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function supportsVisualEditor(filePath = local.selectedFile) {
  return fileExtension(filePath) === ".tex";
}

function editorModeStorageMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(EDITOR_MODE_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function editorModeStorageId(filePath = local.selectedFile) {
  const projectId = local.appState?.project?.id || local.appState?.project?.root || "project";
  return `${projectId}:${filePath || ""}`;
}

function readEditorModeForFile(filePath = local.selectedFile) {
  return "code";
}

function writeEditorModeForFile(filePath = local.selectedFile, mode = "code") {
  const nextMode = "code";
  const map = editorModeStorageMap();
  map[editorModeStorageId(filePath)] = nextMode;
  localStorage.setItem(EDITOR_MODE_STORAGE_KEY, JSON.stringify(map));
  localStorage.setItem("localleaf.editorMode", nextMode);
}

function pdfTextPreviewAtPoint(page, clientX, clientY, pageRect = page.getBoundingClientRect()) {
  const localX = clientX - pageRect.left;
  const localY = clientY - pageRect.top;
  const nearby = pdfAnnotationSpanRecords(page, pageRect)
    .filter((record) => (
      record.bottom >= localY - 18
      && record.top <= localY + 18
      && record.right >= localX - 90
      && record.left <= localX + 90
    ))
    .map((record) => record.text);
  return nearby.join(" ").replace(/\s+/g, " ").trim().slice(0, 220);
}

function pdfAnnotationSpanRecords(page, pageRect = page.getBoundingClientRect()) {
  const spans = Array.from(page.querySelectorAll(".pdf-text-layer span, .textLayer span"));
  const previewMount = page.closest?.(".pdf-preview-mount");
  const cacheKey = [
    previewMount?.dataset.pdfArtifactId || "",
    previewMount?.dataset.pdfVersion || "",
    local.pdfScale,
    Math.round(pageRect.width),
    Math.round(pageRect.height),
    spans.length
  ].join(":");
  if (page.__localLeafAnnotationLayout?.key === cacheKey) {
    return page.__localLeafAnnotationLayout.records;
  }
  const records = spans
    .map((span) => {
      const text = String(span.textContent || "").replace(/\s+/g, " ").trim();
      const rect = span.getBoundingClientRect();
      if (!text || rect.width < 1 || rect.height < 1) return null;
      return {
        span,
        text,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top,
        width: rect.width,
        height: rect.height,
        centerX: rect.left - pageRect.left + rect.width / 2,
        centerY: rect.top - pageRect.top + rect.height / 2
      };
    })
    .filter(Boolean);
  page.__localLeafAnnotationLayout = {
    key: cacheKey,
    records,
    lines: groupPdfAnnotationLines(records)
  };
  return records;
}

function unionPdfRects(records) {
  const left = Math.min(...records.map((item) => item.left));
  const top = Math.min(...records.map((item) => item.top));
  const right = Math.max(...records.map((item) => item.right));
  const bottom = Math.max(...records.map((item) => item.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function groupPdfAnnotationLines(records) {
  const sorted = [...records].sort((left, right) => left.centerY - right.centerY || left.left - right.left);
  const lines = [];
  sorted.forEach((record) => {
    const last = lines.at(-1);
    const tolerance = Math.max(5, Math.min(14, record.height * 0.72));
    if (last && Math.abs(last.centerY - record.centerY) <= tolerance) {
      last.records.push(record);
      const rect = unionPdfRects(last.records);
      Object.assign(last, rect, {
        centerY: last.records.reduce((sum, item) => sum + item.centerY, 0) / last.records.length,
        text: last.records.sort((left, right) => left.left - right.left).map((item) => item.text).join(" ")
      });
      return;
    }
    lines.push({
      records: [record],
      ...unionPdfRects([record]),
      centerY: record.centerY,
      text: record.text
    });
  });
  return lines;
}

function horizontalOverlapRatio(left, right) {
  const overlap = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  return overlap / Math.max(1, Math.min(left.width, right.width));
}

function pdfFallbackAnnotationOutline(page, clientX, clientY) {
  const pageRect = page.getBoundingClientRect();
  const width = Math.min(220, Math.max(120, pageRect.width * 0.28));
  const height = Math.min(120, Math.max(72, pageRect.height * 0.1));
  return {
    left: Math.max(8, Math.min(pageRect.width - width - 8, clientX - pageRect.left - width / 2)),
    top: Math.max(8, Math.min(pageRect.height - height - 8, clientY - pageRect.top - height / 2)),
    width,
    height
  };
}

function isPdfCanvasInk(data, index) {
  const red = data[index];
  const green = data[index + 1];
  const blue = data[index + 2];
  const alpha = data[index + 3];
  if (alpha <= 24) return false;
  const darkest = Math.min(red, green, blue);
  const lightest = Math.max(red, green, blue);
  return darkest < 242 || lightest - darkest > 18;
}

function pdfCanvasInkComponents(page) {
  const canvas = page.querySelector(".pdf-page-canvas");
  const context = canvas?.getContext?.("2d", { willReadFrequently: true });
  if (!canvas || !context || !canvas.width || !canvas.height) return [];
  const rect = canvas.getBoundingClientRect();
  const key = [
    canvas.width,
    canvas.height,
    Math.round(rect.width * 10) / 10,
    Math.round(rect.height * 10) / 10,
    local.pdfScale
  ].join("x");
  if (canvas.__localLeafInkTargetKey === key && Array.isArray(canvas.__localLeafInkTargets)) {
    return canvas.__localLeafInkTargets;
  }

  let image;
  try {
    image = context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return [];
  }

  const scaleX = canvas.width / Math.max(1, rect.width);
  const scaleY = canvas.height / Math.max(1, rect.height);
  const step = Math.max(5, Math.round(Math.min(scaleX, scaleY) * 4));
  const cols = Math.ceil(canvas.width / step);
  const rows = Math.ceil(canvas.height / step);
  const mask = new Uint8Array(cols * rows);
  const visited = new Uint8Array(cols * rows);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const pixelX = Math.min(canvas.width - 1, col * step + Math.floor(step / 2));
      const pixelY = Math.min(canvas.height - 1, row * step + Math.floor(step / 2));
      const index = (pixelY * canvas.width + pixelX) * 4;
      if (isPdfCanvasInk(image.data, index)) mask[row * cols + col] = 1;
    }
  }

  const components = [];
  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const startIndex = row * cols + col;
      if (!mask[startIndex] || visited[startIndex]) continue;
      const stack = [[col, row]];
      visited[startIndex] = 1;
      let minCol = col;
      let maxCol = col;
      let minRow = row;
      let maxRow = row;
      let cells = 0;
      while (stack.length) {
        const [currentCol, currentRow] = stack.pop();
        cells += 1;
        minCol = Math.min(minCol, currentCol);
        maxCol = Math.max(maxCol, currentCol);
        minRow = Math.min(minRow, currentRow);
        maxRow = Math.max(maxRow, currentRow);
        for (const [dx, dy] of neighbors) {
          const nextCol = currentCol + dx;
          const nextRow = currentRow + dy;
          if (nextCol < 0 || nextRow < 0 || nextCol >= cols || nextRow >= rows) continue;
          const nextIndex = nextRow * cols + nextCol;
          if (!mask[nextIndex] || visited[nextIndex]) continue;
          visited[nextIndex] = 1;
          stack.push([nextCol, nextRow]);
        }
      }
      const left = (minCol * step) / scaleX;
      const top = (minRow * step) / scaleY;
      const width = ((maxCol - minCol + 1) * step) / scaleX;
      const height = ((maxRow - minRow + 1) * step) / scaleY;
      if (cells < 14 || width < 28 || height < 22) continue;
      components.push({ left, top, width, height, right: left + width, bottom: top + height, cells });
    }
  }

  canvas.__localLeafInkTargetKey = key;
  canvas.__localLeafInkTargets = components
    .sort((left, right) => (right.width * right.height) - (left.width * left.height))
    .slice(0, 80);
  return canvas.__localLeafInkTargets;
}

function distanceToRect(pointX, pointY, rect) {
  const dx = pointX < rect.left ? rect.left - pointX : pointX > rect.right ? pointX - rect.right : 0;
  const dy = pointY < rect.top ? rect.top - pointY : pointY > rect.bottom ? pointY - rect.bottom : 0;
  return Math.hypot(dx, dy);
}

function pdfCanvasAnnotationTargetAtPoint(page, clientX, clientY) {
  const pageRect = page.getBoundingClientRect();
  const x = clientX - pageRect.left;
  const y = clientY - pageRect.top;
  const components = pdfCanvasInkComponents(page);
  const target = components
    .map((component) => {
      const padded = {
        ...component,
        left: component.left - 10,
        top: component.top - 10,
        right: component.right + 10,
        bottom: component.bottom + 10
      };
      const contains = x >= padded.left && x <= padded.right && y >= padded.top && y <= padded.bottom;
      return {
        component,
        contains,
        distance: distanceToRect(x, y, padded)
      };
    })
    .filter((item) => item.contains || item.distance <= 28)
    .sort((left, right) => Number(right.contains) - Number(left.contains) || left.distance - right.distance || right.component.cells - left.component.cells)[0]?.component;
  if (!target) return null;
  const pad = 8;
  const left = Math.max(4, target.left - pad);
  const top = Math.max(4, target.top - pad);
  return {
    type: "image",
    textPreview: "Image or figure region selected.",
    outline: {
      left,
      top,
      width: Math.min(pageRect.width - left - 4, target.width + pad * 2),
      height: Math.min(pageRect.height - top - 4, target.height + pad * 2)
    }
  };
}

function pdfAnnotationTargetAtPoint(page, clientX, clientY, pageRect = page.getBoundingClientRect()) {
  const records = pdfAnnotationSpanRecords(page, pageRect);
  if (!records.length) {
    return pdfCanvasAnnotationTargetAtPoint(page, clientX, clientY) || {
      type: "page-area",
      outline: pdfFallbackAnnotationOutline(page, clientX, clientY),
      textPreview: ""
    };
  }
  const localX = clientX - pageRect.left;
  const localY = clientY - pageRect.top;
  const anchor = records
    .map((record) => {
      const inside = localX >= record.left - 5 && localX <= record.right + 5 && localY >= record.top - 7 && localY <= record.bottom + 7;
      const dx = localX < record.left ? record.left - localX : localX > record.right ? localX - record.right : 0;
      const dy = localY < record.top ? record.top - localY : localY > record.bottom ? localY - record.bottom : 0;
      return { record, inside, distance: Math.hypot(dx, dy) };
    })
    .filter((item) => item.inside || item.distance <= 32)
    .sort((left, right) => Number(right.inside) - Number(left.inside) || left.distance - right.distance)[0]?.record;
  if (!anchor) {
    return pdfCanvasAnnotationTargetAtPoint(page, clientX, clientY) || {
      type: "page-area",
      outline: pdfFallbackAnnotationOutline(page, clientX, clientY),
      textPreview: ""
    };
  }

  const lines = page.__localLeafAnnotationLayout?.lines || groupPdfAnnotationLines(records);
  const anchorLineIndex = Math.max(0, lines.findIndex((line) => line.records.includes(anchor)));
  const selected = [lines[anchorLineIndex]];
  const avgHeight = Math.max(8, records.reduce((sum, item) => sum + item.height, 0) / records.length);
  const maxGap = Math.max(14, avgHeight * 1.55);
  const anchorLine = lines[anchorLineIndex];

  for (let index = anchorLineIndex - 1; index >= 0 && selected.length < 10; index -= 1) {
    const line = lines[index];
    const below = lines[index + 1];
    const gap = below.top - line.bottom;
    if (gap > maxGap || horizontalOverlapRatio(line, anchorLine) < 0.16) break;
    selected.unshift(line);
  }
  for (let index = anchorLineIndex + 1; index < lines.length && selected.length < 10; index += 1) {
    const line = lines[index];
    const above = lines[index - 1];
    const gap = line.top - above.bottom;
    if (gap > maxGap || horizontalOverlapRatio(line, anchorLine) < 0.16) break;
    selected.push(line);
  }

  const rect = unionPdfRects(selected);
  const padX = 9;
  const padY = 7;
  const outline = {
    left: Math.max(4, rect.left - padX),
    top: Math.max(4, rect.top - padY),
    width: Math.min(pageRect.width - Math.max(4, rect.left - padX) - 4, rect.width + padX * 2),
    height: Math.min(pageRect.height - Math.max(4, rect.top - padY) - 4, rect.height + padY * 2)
  };
  return {
    type: "text",
    outline,
    textPreview: selected.map((line) => line.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 260)
  };
}

function removePdfAnnotationOutline() {
  document.querySelectorAll(".pdf-annotation-target-outline").forEach((element) => element.remove());
}

function renderPdfAnnotationOutline(target, options = {}) {
  const page = document.querySelector(`.pdf-page[data-page-number="${target?.page || ""}"]`);
  const outline = target?.outline;
  if (!page || !outline) {
    removePdfAnnotationOutline();
    return;
  }

  let marker = document.querySelector(".pdf-annotation-target-outline");
  if (marker && marker.parentElement !== page) {
    marker.remove();
    marker = null;
  }
  if (!marker) {
    marker = document.createElement("div");
    page.append(marker);
  }
  marker.className = `pdf-annotation-target-outline ${options.selected ? "selected" : ""}`;
  marker.style.left = `${Math.round(outline.left)}px`;
  marker.style.top = `${Math.round(outline.top)}px`;
  marker.style.width = `${Math.max(16, Math.round(outline.width))}px`;
  marker.style.height = `${Math.max(16, Math.round(outline.height))}px`;
}

function handlePdfAnnotationPointerMove(event) {
  if (!local.pdfAnnotateMode || local.pdfAnnotationPopover || event.target.closest?.(".pdf-annotation-popover")) {
    cancelPendingPdfAnnotationPointer();
    return;
  }
  pendingPdfAnnotationPointer = {
    target: event.target,
    clientX: event.clientX,
    clientY: event.clientY
  };
  if (pdfAnnotationPointerFrame) return;
  pdfAnnotationPointerFrame = requestAnimationFrame(() => {
    pdfAnnotationPointerFrame = 0;
    const pointer = pendingPdfAnnotationPointer;
    pendingPdfAnnotationPointer = null;
    if (!pointer || !pointer.target?.isConnected || !local.pdfAnnotateMode || local.pdfAnnotationPopover) return;
    const target = pdfClickTarget(pointer);
    if (!target) {
      removePdfAnnotationOutline();
      return;
    }
    renderPdfAnnotationOutline(target);
  });
}

async function resolvePdfClickSource(target) {
  try {
    return await api("/api/pdf/source-position", {
      method: "POST",
      body: {
        page: target.page,
        x: target.x,
        y: target.y,
        version: target.version,
        artifactId: target.artifactId
      }
    });
  } catch (error) {
    return { ok: false, reason: error.message || "Could not map this PDF location." };
  }
}

function pdfSourceStatusLabel(status = local.pdfSourceStatus) {
  if (!status) return "";
  if (status.state === "mapping") return "Finding source...";
  if (status.state === "ready" && status.source?.path) {
    const context = status.source.previewState === "stale"
      ? " (last good PDF)"
      : status.source.previewState === "pending"
        ? " (compile in progress)"
        : "";
    return `${status.source.path} · line ${status.source.line}${context}`;
  }
  if (status.state === "pending") return "Source map pending";
  if (status.state === "busy") return "Source lookup busy";
  if (status.state === "stale") return "PDF changed — click again";
  if (status.state === "unavailable") return "No source for this spot";
  return "";
}

function pdfSourceStatusTitle(status = local.pdfSourceStatus) {
  if (status?.reason) return status.reason;
  if (status?.state === "ready" && status.source?.path) {
    return `Opened ${status.source.path} at line ${status.source.line}, column ${status.source.column || 0}.`;
  }
  return "Click the PDF to reveal its LaTeX source.";
}

function updatePdfSourceStatus(status) {
  local.pdfSourceStatus = status || "";
  const element = document.querySelector("#pdfSourceStatus");
  if (!element) return;
  element.textContent = pdfSourceStatusLabel();
  element.title = pdfSourceStatusTitle();
}

function pdfSourceNavigator() {
  if (local.pdfSourceNavigator) return local.pdfSourceNavigator;
  const createController = window.LocalLeafPdfSourceNavigation?.createPdfSourceNavigationController;
  if (typeof createController !== "function") return null;
  local.pdfSourceNavigator = createController({
    lookup: resolvePdfClickSource,
    reveal: jumpToPdfSource,
    onStatus: updatePdfSourceStatus
  });
  return local.pdfSourceNavigator;
}

function offsetForLineColumn(text, line, column = 0) {
  const lines = String(text || "").split(/\r?\n/u);
  const lineIndex = Math.max(0, Math.min(lines.length - 1, Number(line || 1) - 1));
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index].length + 1;
  }
  return offset + Math.max(0, Math.min(lines[lineIndex]?.length || 0, Number(column || 0)));
}

function centerCodeEditorSelection() {
  const scroller = document.querySelector(".code-panel .cm-scroller");
  const target = document.querySelector(".code-panel .cm-activeLine") || document.querySelector(".code-panel .cm-cursor");
  if (!scroller || !target) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!scrollerRect.height || !targetRect.height) return;
  const targetMiddle = targetRect.top + targetRect.height / 2;
  const scrollerMiddle = scrollerRect.top + scrollerRect.height / 2;
  scroller.scrollTop += targetMiddle - scrollerMiddle;
}

async function jumpToPdfSource(source, navigation = {}) {
  if (!source?.ok || !source.path) {
    return false;
  }
  if (navigation.isCurrent && !navigation.isCurrent()) return false;
  const revealFile = window.LocalLeafPdfSourceNavigation?.revealPdfSourceFile;
  if (typeof revealFile !== "function") return false;
  const selected = await revealFile(source, {
    isCurrent: navigation.isCurrent,
    selectFile: selectProjectFile,
    selectedPath: () => local.selectedFile
  });
  if (!selected) return false;
  if (navigation.isCurrent && !navigation.isCurrent()) return false;
  local.sourcePaneVisible = true;
  localStorage.setItem("localleaf.sourcePaneVisible", "1");
  applyEditorLayoutState();
  setEditorMode("code");
  requestAnimationFrame(() => {
    const offset = offsetForLineColumn(local.editorContent, source.line, source.column || 0);
    local.codeEditor?.selectRange?.(offset, offset);
    local.codeEditor?.focus?.();
    requestAnimationFrame(centerCodeEditorSelection);
    setTimeout(centerCodeEditorSelection, 80);
    document.querySelector(".code-panel")?.classList.add("source-jump-highlight");
    setTimeout(() => document.querySelector(".code-panel")?.classList.remove("source-jump-highlight"), 1100);
  });
  return true;
}

async function handlePdfPreviewClick(event) {
  if (event.target.closest?.(".pdf-annotation-popover")) return;
  if (local.appState?.compile?.mode !== "pdf") return;
  if (
    !local.pdfAnnotateMode
    && window.LocalLeafPdfSourceNavigation?.isPdfHyperlinkTarget?.(event.target)
  ) return;
  const target = pdfClickTarget(event);
  if (!target) return;
  if (local.pdfAnnotateMode) {
    event.preventDefault();
    event.stopPropagation();
    const source = await resolvePdfClickSource(target);
    openPdfAnnotationPopover(target, source);
    return;
  }
  event.preventDefault();
  const navigator = pdfSourceNavigator();
  if (navigator) {
    await navigator.navigate(target);
    return;
  }
  const source = await resolvePdfClickSource(target);
  if (source?.ok) await jumpToPdfSource(source);
  else updatePdfSourceStatus(source);
}

function closePdfAnnotationPopover() {
  document.querySelector(".pdf-annotation-popover")?.remove();
  local.pdfAnnotationPopover = null;
}

function openPdfAnnotationPopover(target, source) {
  closePdfAnnotationPopover();
  const previewPane = document.querySelector("#previewPane");
  if (!previewPane) return;
  const scrollTop = previewPane.scrollTop;
  const scrollLeft = previewPane.scrollLeft;
  const restoreAnnotationScroll = () => {
    previewPane.scrollTop = scrollTop;
    previewPane.scrollLeft = scrollLeft;
  };
  local.pdfAnnotationPopover = { target, source };
  renderPdfAnnotationOutline(target, { selected: true });
  const rect = previewPane.getBoundingClientRect();
  const viewportLeft = target.clientX - rect.left + 10;
  const viewportTop = target.clientY - rect.top + 10;
  const left = previewPane.scrollLeft + Math.min(Math.max(12, viewportLeft), Math.max(12, rect.width - 330));
  const top = previewPane.scrollTop + Math.min(Math.max(12, viewportTop), Math.max(12, rect.height - 250));
  const location = source?.ok ? `${source.path}:${source.line}` : source?.reason || "No mapped source";
  const targetLabel = target.elementType === "image" ? "Image / figure" : target.elementType === "text" ? "Text" : "PDF area";
  const popover = document.createElement("form");
  popover.className = "pdf-annotation-popover";
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.innerHTML = `
    <div class="pdf-annotation-head">
      <strong>Ask AI about this spot</strong>
      <button type="button" data-close-pdf-annotation aria-label="Close annotation">x</button>
    </div>
    <div class="pdf-annotation-meta">
      <span>Page ${escapeHtml(String(target.page))}</span>
      <span>${escapeHtml(targetLabel)}</span>
      <span>${escapeHtml(location)}</span>
    </div>
    ${target.textPreview ? `<p class="pdf-annotation-preview">${escapeHtml(target.textPreview)}</p>` : ""}
    <textarea id="pdfAnnotationText" rows="3" placeholder="What should LocalLeaf AI change here?"></textarea>
    <div class="pdf-annotation-actions">
      <button type="button" data-cancel-pdf-annotation>Cancel</button>
      <button type="submit">Send to AI</button>
    </div>
  `;
  previewPane.append(popover);
  const input = popover.querySelector("#pdfAnnotationText");
  requestAnimationFrame(() => {
    input?.focus?.({ preventScroll: true });
    restoreAnnotationScroll();
  });
  setTimeout(restoreAnnotationScroll, 80);
  setTimeout(restoreAnnotationScroll, 220);
  popover.querySelector("[data-close-pdf-annotation]")?.addEventListener("click", () => {
    setPdfAnnotateMode(false);
  });
  popover.querySelector("[data-cancel-pdf-annotation]")?.addEventListener("click", () => {
    setPdfAnnotateMode(false);
  });
  popover.addEventListener("submit", (submitEvent) => {
    submitEvent.preventDefault();
    submitPdfAnnotation();
  });
}

function submitPdfAnnotation() {
  const popover = document.querySelector(".pdf-annotation-popover");
  const instruction = String(popover?.querySelector("#pdfAnnotationText")?.value || "").trim();
  if (!instruction || !local.pdfAnnotationPopover) return;
  const { target, source } = local.pdfAnnotationPopover;
  const contextLines = [
    instruction,
    "",
    `PDF annotation: page ${target.page}, x ${Math.round(target.x)}, y ${Math.round(target.y)}.`,
    `Selected PDF element: ${target.elementType || "page-area"}.`,
    target.targetRect ? `Selected PDF rectangle: left ${Math.round(target.targetRect.left)}, top ${Math.round(target.targetRect.top)}, width ${Math.round(target.targetRect.width)}, height ${Math.round(target.targetRect.height)}.` : "",
    source?.ok ? `Mapped source: ${source.path}:${source.line}${source.column ? `:${source.column}` : ""}.` : `Mapped source: ${source?.reason || "not available"}.`,
    target.textPreview ? `Clicked PDF context: "${target.textPreview}".` : ""
  ].filter(Boolean);
  setPdfAnnotateMode(false);
  local.rightRailTab = "ai";
  localStorage.setItem("localleaf.rightRailTab", "ai");
  askAiHelper(contextLines.join("\n"), {
    path: source?.ok ? source.path : local.selectedFile,
    selectedText: target.textPreview || "",
    pdfAnnotation: {
      page: target.page,
      x: Math.round(target.x),
      y: Math.round(target.y),
      elementType: target.elementType || "page-area",
      targetRect: target.targetRect ? {
        left: Math.round(target.targetRect.left),
        top: Math.round(target.targetRect.top),
        width: Math.round(target.targetRect.width),
        height: Math.round(target.targetRect.height)
      } : null,
      textPreview: target.textPreview || "",
      source: source?.ok ? { path: source.path, line: source.line, column: source.column || 0 } : null
    }
  });
}

function editorShellClasses() {
  return [
    "editor-shell",
    local.sidebarVisible ? "" : "sidebar-collapsed",
    local.sourcePaneVisible ? "" : "source-collapsed",
    local.previewPaneVisible ? "" : "preview-collapsed",
    local.rightRailVisible ? "" : "right-rail-collapsed",
    local.logsVisible ? "" : "logs-hidden"
  ].filter(Boolean).join(" ");
}

function editorInlineStyle() {
  const styles = [
    `--sidebar-width:${local.sidebarWidth}px`,
    `--right-rail-width:${local.rightRailWidth}px`,
    `--logs-height:${local.logsHeight}px`,
    `--files-section-height:${local.fileSectionHeight}px`,
    `--images-section-height:${local.imageSectionHeight}px`
  ];
  if (local.sourcePaneWidth > 0) {
    styles.push(`--source-width:${local.sourcePaneWidth}px`);
  }
  return styles.join(";");
}

function layoutGlyph(kind) {
  return `<span class="layout-glyph layout-glyph-${kind}" aria-hidden="true"></span>`;
}

function layoutToggleMarkup(id, active, kind, title) {
  return `<button class="icon-button layout-toggle ${active ? "active" : ""}" id="${id}" title="${title}" aria-label="${title}">${layoutGlyph(kind)}</button>`;
}

function editorMoreMenuMarkup(state) {
  if (!local.editorMoreMenuOpen) return "";
  const menuButton = (action, label, detail = "", options = {}) => `
    <button type="button"
      class="editor-more-item ${options.active ? "active" : ""} ${options.danger ? "danger" : ""}"
      role="menuitem"
      data-editor-more-action="${escapeHtml(action)}"
      ${options.active !== undefined ? `aria-pressed="${options.active ? "true" : "false"}"` : ""}
      ${options.disabled ? "disabled" : ""}>
      ${options.icon ? `<span class="editor-menu-icon">${options.icon}</span>` : ""}
      <span class="editor-menu-copy">
        <span>${escapeHtml(label)}</span>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      </span>
      ${options.active !== undefined ? `<span class="editor-menu-state">${options.active ? "On" : "Off"}</span>` : ""}
    </button>
  `;
  const layoutButton = (action, label, detail, glyph, active) =>
    menuButton(action, label, detail, { active, icon: layoutGlyph(glyph) });
  return `
    <section class="editor-more-menu" role="menu" aria-label="Editor actions">
      <div class="editor-more-header">
        <strong>Workspace</strong>
        <span>${escapeHtml(state.project.name)}</span>
      </div>
      <div class="editor-more-section">
        ${isGuestClient() ? "" : menuButton("settings", "Settings", "Theme and update checks", { icon: icon("settings") })}
        ${menuButton("help", "Help", "Q&A and app guidance", { icon: icon("help") })}
        ${menuButton("about", "About", "Website and project info", { icon: icon("info") })}
        ${isGuestClient() ? "" : updateCheckButtonMarkup("editorCheckUpdates", "Check for updates", "editor-more-update", { menuItem: true })}
        ${isGuestClient() ? "" : `<a class="editor-more-item" href="${authUrl("/api/export/zip")}" download="${escapeHtml(downloadFileName(state.project.name, ".zip"))}" role="menuitem">
          <span class="editor-menu-icon">${icon("download")}</span>
          <span class="editor-menu-copy">
            <span>Download ZIP</span>
            <small>Save the whole project</small>
          </span>
        </a>`}
      </div>
      <div class="editor-more-section">
        <div class="editor-more-section-title">Layout</div>
        <div class="editor-more-toggle-grid">
          ${layoutButton("toggle-files", "Files", "Project tree", "sidebar", local.sidebarVisible)}
          ${layoutButton("toggle-editor", "Editor", "Source pane", "editor", local.sourcePaneVisible)}
          ${layoutButton("toggle-pdf", "PDF", "Preview pane", "preview", local.previewPaneVisible)}
          ${layoutButton("toggle-logs", "Logs", "Compiler output", "bottom", local.logsVisible)}
          ${layoutButton("toggle-chat", "Chat", "Users and messages", "right", local.rightRailVisible)}
        </div>
      </div>
    </section>
  `;
}

function closeEditorMoreMenuInPlace(options = {}) {
  local.editorMoreMenuOpen = false;
  document.querySelector(".editor-more-menu")?.remove();
  const button = document.querySelector("#editorMoreButton");
  button?.classList.remove("active");
  button?.setAttribute("aria-expanded", "false");
  if (options.focus !== false) button?.focus({ preventScroll: true });
}

function openEditorMoreMenuInPlace() {
  const button = document.querySelector("#editorMoreButton");
  if (!button || !local.appState?.project) {
    local.editorMoreMenuOpen = true;
    render();
    return;
  }
  document.querySelector(".editor-more-menu")?.remove();
  local.editorMoreMenuOpen = true;
  button.classList.add("active");
  button.setAttribute("aria-expanded", "true");
  button.insertAdjacentHTML("afterend", editorMoreMenuMarkup(local.appState));
  bindEditorMoreActions();
  document.querySelector('.editor-more-menu [role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
}

function bindEditorMoreActions() {
  const menu = document.querySelector(".editor-more-menu");
  const updateButton = menu?.querySelector("[data-check-updates]");
  if (updateButton && updateButton.dataset.updateCheckBound !== "1") {
    updateButton.dataset.updateCheckBound = "1";
    updateButton.addEventListener("click", manualCheckForUpdates);
  }
  if (menu && menu.dataset.keyboardBound !== "1") {
    menu.dataset.keyboardBound = "1";
    const enabledItems = () => [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')];
    menu.addEventListener("keydown", (event) => {
      const items = enabledItems();
      const currentIndex = items.indexOf(document.activeElement);
      let nextIndex = -1;
      if (event.key === "ArrowDown") nextIndex = (currentIndex + 1 + items.length) % items.length;
      else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = items.length - 1;
      else if (event.key === "Tab") {
        closeEditorMoreMenuInPlace({ focus: false });
        return;
      }
      if (nextIndex < 0 || !items[nextIndex]) return;
      event.preventDefault();
      items[nextIndex].focus();
    });
  }
  document.querySelectorAll("[data-editor-more-action]").forEach((button) => {
    if (button.dataset.editorMoreBound === "1") return;
    button.dataset.editorMoreBound = "1";
    button.addEventListener("click", () => {
      const action = button.dataset.editorMoreAction;
      closeEditorMoreMenuInPlace();
      if (action === "settings") {
        showSettingsModal("general");
        return;
      }
      if (action === "help") {
        showHelpModal();
        return;
      }
      if (action === "about") {
        showAboutModal();
        return;
      }
      if (action === "toggle-files") setSidebarVisible(!local.sidebarVisible);
      else if (action === "toggle-editor") toggleLayoutPane("source");
      else if (action === "toggle-pdf") toggleLayoutPane("preview");
      else if (action === "toggle-logs") toggleLayoutPane("logs");
      else if (action === "toggle-chat") setRightRailVisible(!local.rightRailVisible);
    });
  });
}

function chatSessionActionsMarkup(canShare) {
  if (isGuestClient()) return "";
  return `
    <div class="chat-session-actions" data-chat-session-actions>
      <button class="chat-session-actions-trigger" id="chatSessionActionsButton" type="button" title="Host session actions" aria-label="Host session actions" aria-haspopup="menu" aria-expanded="false" aria-controls="chatSessionActionsMenu">
        <span class="chat-session-actions-settings" aria-hidden="true">${uiGlyph("settings")}</span>
        <span class="chat-session-actions-chevron" aria-hidden="true">${editorToolIcon("chevronDown")}</span>
      </button>
      <div class="chat-session-actions-menu" id="chatSessionActionsMenu" role="menu" aria-label="Host session actions" aria-hidden="true" inert>
        <button type="button" role="menuitem" data-chat-session-action="share" ${canShare ? "" : "disabled"}>
          ${editorToolIcon("link")}
          <span>Share link</span>
        </button>
        <button type="button" role="menuitem" data-chat-session-action="manage">
          ${uiGlyph("users")}
          <span>Manage guests</span>
        </button>
      </div>
    </div>
  `;
}

function chatHeaderMarkup() {
  const session = local.appState.session;
  const canShare = Boolean(session.inviteUrl);
  const isLive = session.status === "live";
  return `
    <div class="panel-head chat-head">
      <div class="chat-title">
        <strong>Chat</strong>
        <small><span class="chat-session-state ${isLive ? "is-live" : ""}" aria-hidden="true"></span>${isLive ? "Session live" : "Session offline"}</small>
      </div>
      <div class="chat-actions">
        <button class="chat-share-button" id="shareInviteFromChat" title="${canShare ? "Copy invite link" : "Start a session first"}" aria-label="Copy invite link" ${canShare ? "" : "disabled"}>
          <span class="link-glyph" aria-hidden="true"></span>
          <span>Share</span>
        </button>
        ${chatSessionActionsMarkup(canShare)}
      </div>
    </div>
  `;
}

function chatEmptyMarkup() {
  return `
    <div class="chat-empty" role="status">
      <span class="chat-empty-rule" aria-hidden="true"></span>
      <strong class="chat-empty-title">No messages yet</strong>
      <span class="chat-empty-copy">Start a note for everyone in this session.</span>
    </div>
  `;
}

function bindChatSessionActions() {
  local.sessionActionsMenuAbortController?.abort();
  local.sessionActionsMenuAbortController = null;

  const controller = new AbortController();
  const { signal } = controller;
  const shareButton = document.querySelector("#shareInviteFromChat");
  shareButton?.addEventListener("click", (event) => copyInvite(event.currentTarget), { signal });

  const wrapper = document.querySelector("[data-chat-session-actions]");
  const trigger = wrapper?.querySelector("#chatSessionActionsButton");
  const menu = wrapper?.querySelector("#chatSessionActionsMenu");
  if (!wrapper || !trigger || !menu) {
    local.sessionActionsMenuAbortController = controller;
    return;
  }

  const enabledItems = () => [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const setOpen = (open, options = {}) => {
    const nextOpen = Boolean(open);
    wrapper.classList.toggle("is-open", nextOpen);
    trigger.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    menu.setAttribute("aria-hidden", nextOpen ? "false" : "true");
    if (nextOpen) {
      menu.inert = false;
      const items = enabledItems();
      const target = options.focus === "last" ? items.at(-1) : options.focus ? items[0] : null;
      target?.focus({ preventScroll: true });
      return;
    }
    if (options.restoreFocus) trigger.focus({ preventScroll: true });
    menu.inert = true;
  };

  trigger.addEventListener("click", () => {
    const opening = trigger.getAttribute("aria-expanded") !== "true";
    setOpen(opening, { focus: opening ? "first" : "", restoreFocus: !opening });
  }, { signal });
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setOpen(false, { restoreFocus: true });
      return;
    }
    const focus = ["ArrowUp", "End"].includes(event.key) ? "last" : "first";
    setOpen(true, { focus });
  }, { signal });

  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false, { restoreFocus: true });
      return;
    }
    if (event.key === "Tab") {
      window.setTimeout(() => setOpen(false), 0);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = enabledItems();
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(document.activeElement));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus({ preventScroll: true });
  }, { signal });

  menu.querySelector('[data-chat-session-action="share"]')?.addEventListener("click", async () => {
    await copyInvite(shareButton || trigger);
    setOpen(false, { restoreFocus: true });
  }, { signal });
  menu.querySelector('[data-chat-session-action="manage"]')?.addEventListener("click", () => {
    setOpen(false);
    controller.abort();
    if (local.sessionActionsMenuAbortController === controller) local.sessionActionsMenuAbortController = null;
    local.sessionGuestFocusPending = true;
    setView("session");
  }, { signal });
  document.addEventListener("pointerdown", (event) => {
    if (trigger.getAttribute("aria-expanded") !== "true" || wrapper.contains(event.target)) return;
    setOpen(false, { restoreFocus: true });
  }, { signal });

  local.sessionActionsMenuAbortController = controller;
}

function chatMessageMarkup(message) {
  const isOwnMessage = message.author === local.userName;
  const author = escapeHtml(message.author);
  return `
    <article class="chat-message ${isOwnMessage ? "own" : ""}" aria-label="Message from ${author}">
      <div class="avatar" aria-hidden="true">${escapeHtml(message.author[0] || "?")}</div>
      <div class="chat-bubble">
        <div class="chat-meta">
          <strong>${author}</strong>
          <time>${new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <p>${escapeHtml(message.message)}</p>
      </div>
    </article>
  `;
}

function rightRailTabsMarkup() {
  const tabs = [
    ["chat", "Chat", ""],
    ["ai", "AI Helper", ""],
    ["changes", "Changes", aiPendingCount() ? String(aiPendingCount()) : ""]
  ];
  return `
    <div class="right-rail-tabs" role="tablist" aria-label="Right rail">
      ${tabs.map(([id, label, badge]) => `
        <button class="right-rail-tab ${local.rightRailTab === id ? "active" : ""}" data-right-rail-tab="${escapeHtml(id)}" type="button">
          <span>${escapeHtml(label)}</span>
          ${badge ? `<b class="rail-tab-badge">${escapeHtml(badge)}</b>` : ""}
        </button>
      `).join("")}
      <button class="icon-button chat-tool" id="hideChatRail" title="Hide right rail" aria-label="Hide right rail">
        <span class="collapse-right-glyph" aria-hidden="true"></span>
      </button>
    </div>
  `;
}

function chatRailPanelMarkup() {
  const state = local.appState;
  const users = Array.isArray(state.session.users) ? state.session.users : [];
  const onlineCount = users.filter((user) => user.online !== false).length;
  return `
    <section class="chat-panel right-rail-panel ${local.rightRailTab === "chat" ? "active" : ""}" ${local.rightRailTab === "chat" ? "" : "hidden"}>
      ${chatHeaderMarkup()}
      <div class="chat-list">
        ${state.chat.length ? state.chat.map(chatMessageMarkup).join("") : chatEmptyMarkup()}
      </div>
      <section class="users-panel chat-users-inline">
        <div class="chat-users-head">
          <strong>People</strong>
          <span>${users.length} participant${users.length === 1 ? "" : "s"} · ${onlineCount} online</span>
        </div>
        <div class="users-list">
          ${users.map(userRowMarkup).join("")}
        </div>
      </section>
      <form class="chat-input" id="chatForm">
        <label class="sr-only" for="chatText">Message everyone in this session</label>
        <input id="chatText" placeholder="Message everyone" autocomplete="off" />
        <button class="btn btn-primary chat-send-button" type="submit">Send</button>
      </form>
    </section>
  `;
}

function userRowMarkup(user) {
  return `
    <div class="user-row">
      <div class="avatar">${escapeHtml(user.name[0] || "?")}</div>
      <div>
        <strong>${escapeHtml(user.name)}</strong><br />
        <small>${escapeHtml(user.role)}${activeFileForUser(user.id) ? ` · ${escapeHtml(activeFileForUser(user.id))}` : ""}</small>
      </div>
      <span class="online-dot ${user.online ? "" : "offline"}" title="${user.online ? "Online" : "Offline"}"></span>
    </div>
  `;
}

function selectedEditorText() {
  const text = currentEditorText();
  const selection = window.getSelection?.()?.toString?.() || "";
  return selection && text.includes(selection) ? selection : "";
}

function aiProposalDiffMarkup(proposal, options = {}) {
  const expanded = options.expanded !== false;
  if (!expanded) return "";
  const hunks = Array.isArray(proposal.diffHunks) ? proposal.diffHunks : [];
  if (hunks.length) {
    const lines = hunks.flatMap((hunk) => hunk.lines || []);
    return `
      <pre class="ai-diff-preview">${lines.map((line) => {
        const marker = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
        return `<span class="diff-${escapeHtml(line.type || "context")}"><b>${marker}</b> ${escapeHtml(line.text || "")}</span>`;
      }).join("\n") || `<span>Preview unavailable</span>`}</pre>
    `;
  }
  const newText = String(proposal.newText || proposal.replacements?.[0]?.text || "");
  const lines = newText.split(/\r?\n/).filter(Boolean);
  return `
    <pre class="ai-diff-preview">${lines.map((line) => `<span class="diff-added">+ ${escapeHtml(line)}</span>`).join("\n") || `<span>Preview unavailable</span>`}</pre>
  `;
}

function proposalProviderLabel(proposal) {
  const provider = proposal.provider?.name || proposal.providerName || "";
  const model = proposal.modelId || proposal.modelName || "";
  return [provider, model].filter(Boolean).join(" / ") || "Local fallback";
}

function proposalStatusLabel(status) {
  const normalized = String(status || "proposed").toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function aiProposalDiffStats(proposal) {
  const stats = { added: 0, removed: 0 };
  const hunks = Array.isArray(proposal?.diffHunks) ? proposal.diffHunks : [];
  hunks.forEach((hunk) => {
    (hunk.lines || []).forEach((line) => {
      if (line.type === "added") stats.added += 1;
      else if (line.type === "removed") stats.removed += 1;
    });
  });
  return stats;
}

function aiRunIdForProposal(proposal) {
  return proposal?.runId || proposal?.id || "run";
}

function aiRunGroupKey(proposal) {
  return [
    aiRunIdForProposal(proposal),
    proposal?.sessionId || "",
    proposal?.requester?.userId || "host"
  ].map((part) => encodeURIComponent(String(part))).join("::");
}

function aiChangeRuns(items) {
  const groups = new Map();
  items.forEach((proposal) => {
    const runId = aiRunIdForProposal(proposal);
    const groupKey = aiRunGroupKey(proposal);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: groupKey,
        runId,
        anchorProposalId: proposal.id,
        createdAt: proposal.createdAt || Date.now(),
        updatedAt: proposal.appliedAt || proposal.rejectedAt || proposal.revertedAt || proposal.createdAt || Date.now(),
        proposals: []
      });
    }
    const group = groups.get(groupKey);
    group.proposals.push(proposal);
    group.createdAt = Math.min(group.createdAt, proposal.createdAt || group.createdAt);
    group.updatedAt = Math.max(group.updatedAt, proposal.appliedAt || proposal.rejectedAt || proposal.revertedAt || proposal.createdAt || group.updatedAt);
  });
  return [...groups.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function aiRunStats(run) {
  return run.proposals.reduce((stats, proposal) => {
    const diff = aiProposalDiffStats(proposal);
    stats.added += diff.added;
    stats.removed += diff.removed;
    if (proposal.status === "applied") stats.applied += 1;
    if (proposal.status === "reverted") stats.reverted += 1;
    return stats;
  }, { added: 0, removed: 0, applied: 0, reverted: 0 });
}

function aiApprovalCardMarkup(proposal) {
  const status = proposal.status || "proposed";
  const canApply = proposal.actionable !== false && ["pending", "proposed"].includes(status);
  const createsFile = proposal.operation === "create";
  return `
    <article class="ai-change-card ai-approval-card ${escapeHtml(status)}" data-ai-proposal="${escapeHtml(proposal.id)}">
      <div class="ai-change-head">
        <div>
          <strong>${escapeHtml(proposal.path || local.selectedFile || "Current file")}${createsFile ? `<span class="ai-change-kind">New file</span>` : ""}</strong>
          <span>${escapeHtml(proposal.summary || "AI proposed a text edit.")}</span>
        </div>
        <b>${escapeHtml(status)}</b>
      </div>
      ${aiProposalDiffMarkup(proposal)}
      <div class="ai-change-actions">
        <button class="btn btn-primary" data-apply-ai-proposal="${escapeHtml(proposal.id)}" ${canApply ? "" : "disabled"}>${createsFile ? "Create file" : "Approve"}</button>
        <button class="btn" data-reject-ai-proposal="${escapeHtml(proposal.id)}" ${canApply ? "" : "disabled"}>Reject</button>
        <button class="btn" data-explain-ai-proposal="${escapeHtml(proposal.id)}">Explain</button>
      </div>
    </article>
  `;
}

function aiHistoryCardMarkup(proposal) {
  const status = proposal.status || "proposed";
  const expanded = local.aiExpandedChanges.has(proposal.id);
  const diffExpanded = local.aiExpandedDiffs.has(proposal.id);
  const canRevert = proposal.actionable !== false && status === "applied";
  const createsFile = proposal.operation === "create";
  const canOpenFile = !createsFile || status === "applied";
  return `
    <article class="ai-change-card ai-history-card ${escapeHtml(status)} ${expanded ? "expanded" : ""}" data-ai-proposal="${escapeHtml(proposal.id)}">
      <button type="button" class="ai-change-toggle" data-toggle-ai-change="${escapeHtml(proposal.id)}" aria-expanded="${expanded ? "true" : "false"}">
        <span>
          <strong>${escapeHtml(proposal.summary || "AI proposed a text edit.")}</strong>
          <small>${escapeHtml(proposal.path || "Current file")}${createsFile ? `<span class="ai-change-kind">New file</span>` : ""}</small>
        </span>
        <b class="ai-change-status ${escapeHtml(status)}">${escapeHtml(proposalStatusLabel(status))}</b>
        <i aria-hidden="true">${expanded ? "^" : "v"}</i>
      </button>
      ${expanded ? `
        <div class="ai-change-meta">
          <span>${escapeHtml(proposalProviderLabel(proposal))}</span>
          <span>${escapeHtml(formatAiTime(proposal.appliedAt || proposal.rejectedAt || proposal.revertedAt || proposal.createdAt))}</span>
        </div>
        ${proposal.userRequest ? `<p class="ai-change-request">${escapeHtml(proposal.userRequest)}</p>` : ""}
        ${aiProposalDiffMarkup(proposal, { expanded: diffExpanded })}
        <div class="ai-change-actions">
          <button class="btn" data-open-ai-proposal="${escapeHtml(proposal.id)}" ${canOpenFile ? "" : "disabled"}>Open file</button>
          <button class="btn" data-explain-ai-proposal="${escapeHtml(proposal.id)}">Explain</button>
          <button class="btn" data-copy-ai-proposal="${escapeHtml(proposal.id)}">Copy diff</button>
          <button class="btn" data-view-ai-proposal="${escapeHtml(proposal.id)}">${diffExpanded ? "Collapse" : "View"}</button>
          <button class="btn" data-revert-ai-proposal="${escapeHtml(proposal.id)}" ${canRevert ? "" : "disabled"}>Revert</button>
        </div>
      ` : ""}
    </article>
  `;
}

function aiMessageApprovalCardsMarkup(message) {
  const ids = Array.isArray(message.approvalCards) ? message.approvalCards : [];
  const direct = Array.isArray(message.proposals) ? message.proposals : [];
  const cards = ids.length
    ? ids.map(findAiProposal).filter((proposal) => proposal && ["pending", "proposed"].includes(proposal.status || "proposed") && proposal.approvalRequired !== false)
    : direct.filter((proposal) => ["pending", "proposed"].includes(proposal?.status || "") && proposal?.approvalRequired !== false);
  return cards.length ? `<div class="ai-message-approvals">${cards.map(aiApprovalCardMarkup).join("")}</div>` : "";
}

function renderAiMessageContent(value) {
  try {
    if (typeof window.LocalLeafMarkdown?.renderMarkdown === "function") {
      return window.LocalLeafMarkdown.renderMarkdown(value);
    }
  } catch {
    // Fall back to escaped text if the optional renderer cannot parse a response.
  }
  return `<p>${escapeHtml(value || "").replace(/\r?\n/g, "<br>")}</p>`;
}

function aiMessageMarkup(message) {
  const roleLabel = message.role === "user" ? "You" : "LocalLeaf";
  return `
    <article class="ai-message ai-message-${escapeHtml(message.role || "assistant")}" aria-label="${roleLabel} message">
      <div class="ai-message-body">
        <span class="ai-message-role">${roleLabel}</span>
        <div class="ai-markdown">${renderAiMessageContent(message.message || "")}</div>
        ${Array.isArray(message.fileLinks) && message.fileLinks.length ? `
          <div class="ai-file-links">
            ${message.fileLinks.map((file) => `<button type="button" data-open-ai-file-link="${escapeHtml(file)}">${escapeHtml(file)}</button>`).join("")}
          </div>
        ` : ""}
        ${aiMessageApprovalCardsMarkup(message)}
      </div>
    </article>
  `;
}

function aiWorkingMarkup(message = "") {
  const status = message || local.aiActivityMessage || "LocalLeaf is thinking";
  return `
    <div class="ai-message ai-message-assistant ai-message-working" aria-live="polite">
      <div class="ai-message-body">
        <span class="ai-message-role">LocalLeaf</span>
        <p>${escapeHtml(status)}<span class="ai-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></p>
      </div>
    </div>
  `;
}

function queuedPromptPreview(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function aiQueuedPromptStripMarkup() {
  if (!local.aiBusy || !local.aiQueuedPrompts.length) return "";
  return `
    <div class="ai-session-strip" aria-label="Queued AI messages">
      ${local.aiQueuedPrompts.map((queued, index) => {
        const isMenuOpen = local.aiQueuedPromptMenuOpenId === queued.id;
        return `
        <div class="ai-queue-row">
          <button type="button" class="ai-session-strip-title" data-edit-queued-ai-prompt="${escapeHtml(queued.id)}" title="Edit queued message" aria-label="Edit queued message">
            ${index === 0 ? `<span class="ai-strip-handle" aria-hidden="true"></span>` : `<span class="ai-strip-spacer" aria-hidden="true"></span>`}
            <span class="ai-strip-branch" aria-hidden="true"></span>
            <span>${escapeHtml(queuedPromptPreview(queued.message) || "Queued message")}</span>
          </button>
          <div class="ai-session-strip-actions">
            <button type="button" class="ai-strip-action ai-strip-icon" data-delete-queued-ai-prompt="${escapeHtml(queued.id)}" title="Delete queued message" aria-label="Delete queued message">${editorToolIcon("delete")}</button>
            <div class="ai-strip-more-wrap ${isMenuOpen ? "open" : ""}">
              <button type="button" class="ai-strip-action ai-strip-icon" data-toggle-queued-ai-menu="${escapeHtml(queued.id)}" title="Queue actions" aria-label="Queue actions" aria-expanded="${isMenuOpen ? "true" : "false"}">${editorToolIcon("more")}</button>
              ${isMenuOpen ? `
                <div class="ai-strip-menu" role="menu">
                  <button type="button" data-edit-queued-ai-prompt="${escapeHtml(queued.id)}" role="menuitem">${editorToolIcon("edit")} Edit queued message</button>
                  <button type="button" data-delete-queued-ai-prompt="${escapeHtml(queued.id)}" role="menuitem">${editorToolIcon("delete")} Delete queued message</button>
                  <small>${escapeHtml(index === 0 ? "Next message" : `Queued position ${index + 1}`)}</small>
                </div>
              ` : ""}
            </div>
          </div>
        </div>
      `;
      }).join("")}
    </div>
  `;
}

function aiSessionDateLabel(timestamp) {
  const date = new Date(timestamp || Date.now());
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (left, right) => left.toDateString() === right.toDateString();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return "Earlier";
}

function aiSessionTimeLabel(timestamp) {
  const date = new Date(timestamp || Date.now());
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function aiSessionStatusPill(session) {
  const queuedCount = local.aiQueuedPrompts.filter((item) => item.sessionId === session.id).length;
  if (session.runStatus === "running") return `<span class="ai-session-badge running" data-status="running">Running</span>`;
  if (queuedCount) return `<span class="ai-session-badge queued" data-status="queued">${queuedCount} queued</span>`;
  if (session.unread) return `<span class="ai-session-badge unread" data-status="unread">Unread</span>`;
  if (session.runStatus === "interrupted") return `<span class="ai-session-badge interrupted" data-status="interrupted">Interrupted</span>`;
  if (Number(session.changeCount || 0) > 0) return `<span class="ai-session-badge">Changed</span>`;
  if (session.parentSessionId) return `<span class="ai-session-badge">Fork</span>`;
  return "";
}

function aiSessionRowsMarkup(sessions) {
  if (!sessions.length) return `<div class="ai-session-empty">No sessions match this project search.</div>`;
  const keyboardSessionId = sessions.some((session) => session.id === local.aiCurrentSessionId)
    ? local.aiCurrentSessionId
    : sessions[0].id;
  const groups = sessions.reduce((map, session) => {
    const label = aiSessionDateLabel(session.updatedAt || session.createdAt);
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(session);
    return map;
  }, new Map());
  return [...groups.entries()].map(([label, items]) => `
    <div class="ai-session-menu-label" role="presentation">${escapeHtml(label)}</div>
    ${items.map((session) => {
      const active = session.id === local.aiCurrentSessionId;
      const actionOpen = local.aiSessionActionMenuId === session.id;
      const renaming = local.aiSessionRenamingId === session.id;
      const rowClasses = [
        "ai-session-row",
        active ? "active" : "",
        active && local.aiSessionSwitchTargetId === session.id ? "is-switching" : "",
        local.aiSessionNewId === session.id ? "is-new" : "",
        local.aiSessionDeletingId === session.id ? "is-deleting" : ""
      ].filter(Boolean).join(" ");
      if (renaming) {
        return `
          <div class="${rowClasses}" role="presentation" data-session-id="${escapeHtml(session.id)}">
            <input id="aiSessionRenameInput" class="ai-session-inline-rename" maxlength="64" value="${escapeHtml(local.aiSessionRenameValue)}" aria-label="Rename session" aria-invalid="${local.aiSessionRenameError ? "true" : "false"}" aria-describedby="${local.aiSessionRenameError ? "aiSessionRenameError" : ""}" />
            <span></span>
            ${local.aiSessionRenameError ? `<small id="aiSessionRenameError" class="ai-session-rename-error">${escapeHtml(local.aiSessionRenameError)}</small>` : ""}
          </div>
        `;
      }
      const metadata = [
        session.parentSessionId ? "Fork" : "",
        Number(session.changeCount || 0) > 0 ? "Changed" : "",
        aiSessionTimeLabel(session.updatedAt || session.createdAt)
      ].filter(Boolean).join(" · ");
      return `
        <div class="${rowClasses}" role="presentation" data-session-id="${escapeHtml(session.id)}">
          <button type="button" class="ai-session-row-main" data-ai-session="${escapeHtml(session.id)}" role="option" aria-selected="${active ? "true" : "false"}" aria-haspopup="menu" aria-expanded="${actionOpen ? "true" : "false"}" tabindex="${session.id === keyboardSessionId ? "0" : "-1"}">
            <span class="ai-session-check" aria-hidden="true">${editorToolIcon("check")}</span>
            <strong>${escapeHtml(session.title || "New session")} ${aiSessionStatusPill(session)}</strong>
            <small>${escapeHtml(metadata)}${metadata ? " — " : ""}${escapeHtml(session.lastPreview || "Ready to help with this project.")}</small>
            <span class="ai-session-row-menu-glyph" data-ai-session-actions aria-hidden="true">${editorToolIcon("more")}</span>
          </button>
        </div>
      `;
    }).join("")}
  `).join("");
}

function aiSessionActionMenuMarkup() {
  const session = local.aiSessions.find((item) => item.id === local.aiSessionActionMenuId);
  if (!session) return "";
  const queuedCount = local.aiQueuedPrompts.filter((item) => item.sessionId === session.id).length;
  return `
    <div class="ai-session-row-menu ai-session-floating-menu open" id="aiSessionActionsMenu" role="menu" aria-label="Actions for ${escapeHtml(session.title || "session")}" data-open="true">
      <button type="button" data-rename-ai-session="${escapeHtml(session.id)}" data-session-action="rename" role="menuitem">${editorToolIcon("edit")} <span>Rename</span></button>
      <button type="button" data-fork-ai-session="${escapeHtml(session.id)}" data-session-action="fork" role="menuitem">${editorToolIcon("files")} <span>Fork</span></button>
      ${session.runStatus === "running" ? `<button type="button" data-stop-session-response="${escapeHtml(session.id)}" data-session-action="stop" role="menuitem">${uiGlyph("stop")} <span>Stop response</span></button>` : ""}
      <button type="button" data-delete-ai-session="${escapeHtml(session.id)}" data-session-action="delete" role="menuitem" ${session.runStatus === "running" || queuedCount ? "disabled" : ""} title="${queuedCount ? "Remove queued messages before deleting" : "Delete session"}">${editorToolIcon("delete")} <span>Delete</span></button>
    </div>
  `;
}

function aiSessionMenuMarkup() {
  const query = local.aiSessionSearch.trim().toLowerCase();
  const sessions = local.aiSessions
    .filter((session) => {
      if (!query) return true;
      return `${session.title || ""} ${session.lastPreview || ""}`.toLowerCase().includes(query);
    })
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .slice(0, 30);
  const current = local.aiSessions.find((session) => session.id === local.aiCurrentSessionId) || local.aiSessions[0] || {};
  const atLimit = local.aiSessions.length >= 30;
  const showSearch = local.aiSessions.length >= 5;
  const footer = isGuestClient()
    ? "Temporary for this live session."
    : "Saved on this device for this project.";
  return `
    <div class="ai-session-bar">
      <button class="ai-session-trigger" id="aiSessionMenuButton" type="button" aria-haspopup="dialog" aria-expanded="${local.aiSessionMenuOpen ? "true" : "false"}" aria-controls="aiSessionDialog">
        <span class="ai-session-trigger-icon" aria-hidden="true">${editorToolIcon("chat")}</span>
        <span class="ai-session-trigger-copy"><strong>${escapeHtml(current.title || "New session")}</strong><span>${escapeHtml(current.runStatus === "running" ? "Response running" : current.unread ? "Unread response" : "AI session")}</span></span>
        <span class="ai-session-trigger-chevron" aria-hidden="true">${editorToolIcon("chevronDown")}</span>
      </button>
      <button class="ai-session-quick-new ${local.aiSessionCreating ? "is-creating" : ""}" type="button" data-ai-session-new title="${atLimit ? "Delete a session to create another" : "New session"}" aria-label="${local.aiSessionCreating ? "Creating session" : "New AI session"}" ${atLimit || local.aiSessionCreating ? "disabled" : ""}>${local.aiSessionCreating ? "Creating…" : uiGlyph("plus")}</button>
      <div class="ai-session-dialog-shell ${local.aiSessionMenuOpen ? "open" : ""}" ${local.aiSessionMenuOpen ? "" : "inert aria-hidden=\"true\""}>
        <div class="ai-session-dialog" id="aiSessionDialog" role="dialog" aria-modal="false" aria-label="AI sessions">
          ${showSearch ? `<input id="aiSessionSearch" class="ai-session-search" value="${escapeHtml(local.aiSessionSearch)}" placeholder="Search sessions" autocomplete="off" aria-label="Search AI sessions" />` : ""}
          <div class="ai-session-listbox" role="${local.aiSessionRenamingId ? "presentation" : "listbox"}" aria-label="AI sessions" tabindex="-1">
            ${aiSessionRowsMarkup(sessions)}
          </div>
          ${aiSessionActionMenuMarkup()}
          <div class="ai-session-footer">
            <span>${escapeHtml(atLimit ? "Delete a session to create another." : local.aiSessionCreateError || footer)}</span>
            ${local.aiSessionCreateError ? `<button type="button" data-ai-session-retry>Retry</button>` : ""}
          </div>
        </div>
      </div>
    </div>
  `;
}

function currentContextUsage() {
  return local.aiSessions.find((session) => session.id === local.aiCurrentSessionId)?.lastContextUsage || null;
}

function formatContextTokens(value, approximate = false) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "Unavailable";
  return `${approximate ? "≈" : ""}${new Intl.NumberFormat().format(Number(value))}`;
}

function formatCompactContextTokens(value) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens <= 0) return "Unavailable";
  if (tokens < 1024) return new Intl.NumberFormat().format(tokens);
  const thousands = tokens / 1024;
  const rounded = Number.isInteger(thousands) ? thousands : Math.round(thousands * 10) / 10;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(rounded)}K`;
}

function contextLevel(percent) {
  if (Number(percent) >= 90) return { key: "danger", label: "Nearly full" };
  if (Number(percent) >= 75) return { key: "warning", label: "Getting full" };
  return { key: "normal", label: "Context ready" };
}

function aiModelChipMarkup() {
  const active = activeAiProviderModel();
  const permissionLabel = local.aiPermissions.yoloMode ? "YOLO" : "Default";
  const usage = currentContextUsage();
  const approximate = usage?.usage?.source === "server_estimate" || usage?.usage?.source === "mixed";
  const percent = usage?.window?.percentUsed !== null && usage?.window?.percentUsed !== undefined && Number.isFinite(Number(usage.window.percentUsed))
    ? Math.max(0, Math.min(100, Number(usage.window.percentUsed)))
    : null;
  const level = contextLevel(percent);
  const contextSession = currentAiSession();
  const localProviderAliases = new Set(["local", "localleaf-local"]);
  const localModelActive = localProviderAliases.has(active.providerId);
  const providerChanged = Boolean(
    contextSession?.providerId
    && active.providerId
    && contextSession.providerId !== active.providerId
    && !(localProviderAliases.has(contextSession.providerId) && localProviderAliases.has(active.providerId))
  );
  const staleModel = Boolean(usage && (providerChanged || (contextSession?.modelId && contextSession.modelId !== active.modelId)));
  const usageCapacity = !staleModel && Number(usage?.window?.contextWindowTokens) > 0
    ? Number(usage.window.contextWindowTokens)
    : null;
  const activeCapacity = Number(active.contextWindow?.effectiveTokens ?? active.contextWindowTokens) > 0
    ? Number(active.contextWindow?.effectiveTokens ?? active.contextWindowTokens)
    : null;
  const capacityTokens = usageCapacity || activeCapacity;
  const unknownCapacity = !Number.isFinite(capacityTokens) || capacityTokens <= 0;
  const capacityLabel = localModelActive
    ? capacityTokens
      ? `${active.contextWindow?.mode === "advanced_override" ? "Advanced" : "Automatic"} · ${formatCompactContextTokens(capacityTokens)}`
      : "Automatic"
    : "Provider managed";
  const contextPolicyCopy = localModelActive
    ? "LocalLeaf chooses a stable local window and confirms the capacity reported by the running model."
    : "The provider manages this model's context window. LocalLeaf does not send a context-size override.";
  const query = local.aiModelSearch.trim().toLowerCase();
  const items = modelPickerItems().filter((item) => {
    if (!query) return true;
    return `${item.label} ${item.detail} ${item.providerName || ""}`.toLowerCase().includes(query);
  });
  const grouped = items.reduce((groups, item) => {
    const key = item.providerName || item.detail || "Models";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
  const tokenLabel = !usage
    ? "No request yet"
    : usage?.status === "not_applicable"
    ? "Not applicable"
    : usage?.status === "unavailable"
      ? "Unavailable"
      : formatContextTokens(usage?.usage?.totalTokens ?? usage?.usage?.inputTokens, approximate);
  const statusLabel = staleModel
    ? "Last request used another model"
    : usage?.status === "failed"
      ? "Last request failed"
    : usage?.status === "not_applicable"
      ? "Deterministic fallback"
      : usage?.status === "unavailable"
        ? "Context unavailable"
        : usage
          ? level.label
          : "No request yet";
  const truncationReasons = (usage?.truncation?.reasons || []).map((reason) => String(reason).replaceAll("_", " "));
  return `
    <div class="ai-model-picker ${local.aiModelPickerOpen ? "open" : ""}">
      <button class="ai-context-model-control" id="aiModelChip" type="button" aria-haspopup="dialog" aria-expanded="${local.aiModelPickerOpen ? "true" : "false"}" aria-controls="aiContextPopover" aria-describedby="aiContextButtonStatus" ${isGuestClient() ? "disabled title=\"The host manages models\"" : ""}>
        <span class="ai-context-ring ${unknownCapacity ? "unknown" : ""} ${level.key === "warning" ? "getting-full" : level.key === "danger" ? "nearly-full" : ""} ${local.aiContextUpdating ? "is-updating" : ""}" style="--context-percent:${percent ?? 0}" data-capacity="${unknownCapacity ? "unknown" : "known"}" data-level="${level.key}" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" pathLength="100"></circle><circle cx="8" cy="8" r="6" pathLength="100"></circle></svg></span>
        <span>${escapeHtml(active.modelName || active.providerName || "Connect model")}</span>
        <span class="ai-context-model-chevron" aria-hidden="true">${editorToolIcon("chevronDown")}</span>
      </button>
      <span class="sr-only" id="aiContextButtonStatus">${escapeHtml(`${statusLabel}. ${tokenLabel}${usage && !["not_applicable", "unavailable"].includes(usage.status) ? " tokens" : ""}.`)}</span>
      <div class="ai-context-popover-shell ${local.aiModelPickerOpen ? "open" : ""}" ${local.aiModelPickerOpen ? "" : "inert aria-hidden=\"true\""}>
        <div class="ai-context-popover" id="aiContextPopover" role="dialog" aria-modal="false" aria-label="Model and context">
          <div class="ai-context-status ${level.key === "warning" ? "getting-full" : level.key === "danger" ? "nearly-full" : ""}" data-level="${level.key}"><span>${escapeHtml(statusLabel)}</span><span>${escapeHtml(tokenLabel)}${usage && !["not_applicable", "unavailable"].includes(usage.status) ? " tokens" : ""}</span></div>
          ${percent !== null ? `<div class="ai-context-progress ${level.key === "danger" ? "nearly-full" : ""}" data-level="${level.key}" style="--context-percent:${percent}"><span></span></div>` : ""}
          <dl class="ai-context-details">
            <dt>Last request</dt><dd>${escapeHtml(tokenLabel)}</dd>
            <dt>Capacity</dt><dd>${escapeHtml(capacityLabel)}</dd>
            <dt>Chat turns</dt><dd>${usage ? `${Number(usage.history?.includedTurns || 0)} / ${Number(usage.history?.availableTurns || 0)}` : "—"}</dd>
            <dt>Measurement</dt><dd>${usage ? (usage.status === "not_applicable" ? "Not applicable" : approximate ? "Estimated" : usage.usage?.source === "provider_reported" ? "Measured" : "Unavailable") : "—"}</dd>
          </dl>
          ${truncationReasons.length ? `<p>Truncated: ${escapeHtml(truncationReasons.join(", "))}.</p>` : ""}
          <p>${escapeHtml(contextPolicyCopy)} LocalLeaf rebuilds project context for each request.</p>
          ${Number(percent || 0) >= 90 ? `<button type="button" data-ai-session-new ${local.aiSessions.length >= 30 ? "disabled title=\"Delete a session to create another\"" : ""}>${local.aiSessions.length >= 30 ? "Delete a session to create another" : "Start new session"}</button>` : ""}
          <div class="ai-context-model-list">
            <div class="ai-context-model-toolbar"><input id="aiModelSearch" value="${escapeHtml(local.aiModelSearch)}" placeholder="Search models" autocomplete="off" aria-label="Search models" /><button type="button" data-open-provider-dialog title="Connect provider" aria-label="Connect provider">${uiGlyph("plus")}</button><button type="button" data-open-model-settings title="Manage models" aria-label="Manage models">${uiGlyph("settings")}</button></div>
            ${[...grouped.entries()].map(([providerName, providerItems]) => `
              <span class="ai-context-model-provider">${escapeHtml(providerName)}</span>
              ${providerItems.slice(0, 10).map((item) => {
                const sameLocalProvider = ["local", "localleaf-local"].includes(active.providerId) && ["local", "localleaf-local"].includes(item.providerId);
                const isActive = (active.providerId === item.providerId || sameLocalProvider) && active.modelId === item.modelId;
                return `
                  <button type="button" data-picker-provider="${escapeHtml(item.providerId)}" data-picker-model="${escapeHtml(item.modelId)}" class="${isActive ? "active" : ""}">${escapeHtml(item.label)}${isActive ? `<span class="ai-context-model-check" aria-hidden="true">${editorToolIcon("check")}</span>` : ""}</button>
                `;
              }).join("")}
            `).join("") || `<div class="ai-model-empty">No models match.</div>`}
          </div>
        </div>
      </div>
      <button type="button" id="aiPermissionModeButton" class="ai-permission-mode ${local.aiPermissions.yoloMode ? "is-yolo" : ""}" title="Switch AI write permission mode">${escapeHtml(permissionLabel)}</button>
    </div>
  `;
}

function aiComposerShouldStop() {
  return (local.aiBusy || local.aiActivityMessage) && !String(local.aiPrompt || "").trim() && !local.aiEditingQueuedPromptId;
}

function aiSendButtonMarkup() {
  const stopMode = aiComposerShouldStop();
  return `
    <button class="btn btn-primary ai-send-button ${stopMode ? "is-stop" : ""}" type="${stopMode ? "button" : "submit"}" ${stopMode ? "data-stop-ai-run" : ""} title="${stopMode ? "Stop" : "Send"}" aria-label="${stopMode ? "Stop AI run" : "Send"}">
      ${uiGlyph(stopMode ? "stop" : "upload")}
    </button>
  `;
}

function aiSessionDeleteDialogMarkup() {
  const session = local.aiSessions.find((item) => item.id === local.aiSessionDeleteId);
  return `
    <div class="ai-session-delete-backdrop ${session ? "open" : ""}" ${session ? "" : "inert aria-hidden=\"true\""}>
      <div class="ai-session-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="aiSessionDeleteTitle" aria-describedby="aiSessionDeleteDescription">
        <h2 id="aiSessionDeleteTitle">Delete AI session?</h2>
        <p id="aiSessionDeleteDescription">${session ? `“${escapeHtml(session.title || "This session")}” and its transcript will be removed from this device.` : "This AI session will be removed."}</p>
        <div class="ai-session-delete-dialog-actions">
          <button type="button" id="aiSessionDeleteCancel" data-cancel-session-delete>Cancel</button>
          <button type="button" data-confirm-delete="${escapeHtml(session?.id || "")}">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function aiHelperPanelMarkup() {
  return `
    <section class="ai-helper-panel right-rail-panel ${local.rightRailTab === "ai" ? "active" : ""}" ${local.rightRailTab === "ai" ? "" : "hidden"}>
      <div class="panel-head ai-helper-head">
        <div>
          <strong>AI Helper</strong>
        </div>
        ${isGuestClient() ? "" : `<button class="icon-button chat-tool" id="openAiSettings" title="Manage models" aria-label="Manage models">${uiGlyph("settings")}</button>`}
      </div>
      ${aiSessionMenuMarkup()}
      <div class="ai-chat-wrap ${local.aiTranscriptSwitching ? "ai-transcript-switching" : ""}">
        <div class="ai-chat-list ${local.aiTranscriptSwitching ? "ai-transcript-switching" : ""}" id="aiChatList">
          ${local.aiMessages.map(aiMessageMarkup).join("")}
          ${local.aiActivityMessage ? aiWorkingMarkup() : ""}
        </div>
        <button class="ai-scroll-latest ${local.aiChatNeedsJump ? "visible" : ""}" id="aiScrollLatest" type="button" title="Jump to latest" aria-label="Jump to latest" aria-hidden="${local.aiChatNeedsJump ? "false" : "true"}">${downArrowIcon()}</button>
      </div>
      ${aiQueuedPromptStripMarkup()}
      <form class="ai-input-form" id="aiHelperForm">
        <textarea id="aiPrompt" rows="2" placeholder="Ask AI Helper..." aria-label="Message AI Helper" aria-describedby="aiComposerHint">${escapeHtml(local.aiPrompt)}</textarea>
        <span class="ai-composer-hint" id="aiComposerHint">Markdown supported. Enter sends; Shift+Enter adds a line.</span>
        <div class="ai-composer-footer">
          <div class="ai-composer-left">
            ${aiModelChipMarkup()}
          </div>
          ${aiSendButtonMarkup()}
        </div>
      </form>
      ${aiSessionDeleteDialogMarkup()}
      <div class="ai-sr-announcer" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(local.aiAnnouncement)}</div>
    </section>
  `;
}

function aiReviewStatusLabel(status = local.aiReviewStatus) {
  if (!status) return "";
  if (status.state === "locating") return "Locating change";
  if (status.state === "ready" && status.output?.page) return `Showing page ${status.output.page}`;
  if (status.state === "pending") return "PDF is still compiling";
  if (status.state === "busy") return "PDF lookup is busy";
  if (status.state === "stale") return "Recompile to locate change";
  if (status.state === "unavailable") return "Source opened; PDF location unavailable";
  return "";
}

function updateAiReviewStatus(status) {
  local.aiReviewStatus = status || null;
  const element = document.querySelector("#changesReviewStatus");
  if (!element) return;
  const label = aiReviewStatusLabel();
  element.textContent = label;
  element.hidden = !label;
  element.dataset.state = String(status?.state || "");
  element.title = String(status?.reason || (status?.output?.page ? `Showing the change on PDF page ${status.output.page}.` : ""));
}

function aiRunChangeMarkup(run) {
  const expanded = local.aiExpandedRuns.has(run.id);
  const stats = aiRunStats(run);
  const canUndo = run.proposals.some((proposal) => proposal.status === "applied" && proposal.actionable !== false);
  const fileCount = new Set(run.proposals.map((proposal) => proposal.path || "Current file")).size;
  const detailsId = `ai-run-details-${String(run.id || "run").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return `
    <section class="ai-run-change ${expanded ? "expanded" : ""}" data-ai-run="${escapeHtml(run.runId)}" data-ai-run-group="${escapeHtml(run.id)}">
      <div class="ai-run-head">
        <button type="button" class="ai-run-toggle" data-toggle-ai-run="${escapeHtml(run.id)}" aria-expanded="${expanded ? "true" : "false"}" aria-controls="${escapeHtml(detailsId)}">
          <strong>${fileCount} file${fileCount === 1 ? "" : "s"} changed</strong>
          <span class="diff-added">+${stats.added}</span>
          <span class="diff-removed">-${stats.removed}</span>
        </button>
        <div class="ai-run-actions">
          <button type="button" class="ai-run-undo-action" data-undo-ai-run="${escapeHtml(run.runId)}" data-run-group="${escapeHtml(run.id)}" title="${canUndo ? "Undo applied changes" : "Nothing to undo"}" aria-label="Undo applied changes" ${canUndo ? "" : "disabled"}>${editorToolIcon("undo")}<span class="sr-only">Undo</span></button>
          <button type="button" class="ai-run-review-action" data-review-ai-run="${escapeHtml(run.runId)}" data-run-group="${escapeHtml(run.id)}" aria-label="Review this change and show its PDF location">${editorToolIcon("review")}<span>Review</span></button>
          <button type="button" class="ai-run-disclosure" data-toggle-ai-run="${escapeHtml(run.id)}" title="${expanded ? "Collapse run" : "Expand run"}" aria-label="${expanded ? "Collapse run" : "Expand run"}" aria-expanded="${expanded ? "true" : "false"}" aria-controls="${escapeHtml(detailsId)}">${editorToolIcon("chevronDown")}<span class="sr-only">${expanded ? "Collapse run" : "Expand run"}</span></button>
        </div>
      </div>
      ${expanded ? `<div class="ai-run-files" id="${escapeHtml(detailsId)}">${run.proposals.map(aiHistoryCardMarkup).join("")}</div>` : ""}
    </section>
  `;
}

function changesPanelMarkup() {
  const items = aiHistoryItems();
  const runs = aiChangeRuns(items);
  return `
    <section class="changes-panel right-rail-panel ${local.rightRailTab === "changes" ? "active" : ""}" ${local.rightRailTab === "changes" ? "" : "hidden"}>
      <div class="panel-head">
        <strong>Changes</strong>
        <span class="changes-review-status" id="changesReviewStatus" role="status" aria-live="polite" aria-atomic="true" data-state="${escapeHtml(local.aiReviewStatus?.state || "")}" title="${escapeHtml(local.aiReviewStatus?.reason || "")}" ${aiReviewStatusLabel() ? "" : "hidden"}>${escapeHtml(aiReviewStatusLabel())}</span>
        <small>${runs.length} run${runs.length === 1 ? "" : "s"}</small>
      </div>
      <div class="change-history-list">
        ${runs.length ? runs.map(aiRunChangeMarkup).join("") : `<div class="chat-empty">AI change history will appear here after LocalLeaf proposes, applies, or rejects edits.</div>`}
      </div>
    </section>
  `;
}

function rightRailMarkup() {
  return `
    <aside class="right-rail">
      ${rightRailTabsMarkup()}
      ${chatRailPanelMarkup()}
      ${aiHelperPanelMarkup()}
      ${changesPanelMarkup()}
    </aside>
  `;
}

function applyProjectMutationAccessUi() {
  const shell = document.querySelector(".editor-shell");
  if (!shell) return;
  const canEdit = canMutateProject();
  shell.classList.toggle("viewer-read-only", !canEdit);
  shell.dataset.accessRole = effectiveSessionRole();
  if (canEdit) return;

  const mutationSelectors = [
    "#saveButton", "#newFile", "#newFolder", "#uploadFile", "#renameFile", "#deleteFile",
    "[data-editor-command]", "[data-style-value]", "#editorTableButton", "#editorReplaceInput",
    "#replaceOne", "#replaceAll", "#aiPrompt", ".ai-send-button", "#openAiSettings", "#aiModelChip",
    "[data-ai-session-new]", "[data-apply-ai-proposal]", "[data-reject-ai-proposal]",
    "[data-revert-ai-proposal]", "[data-ai-quick]", "[data-open-provider-dialog]", "[data-open-model-settings]"
  ];
  document.querySelectorAll(mutationSelectors.join(",")).forEach((control) => {
    if ("disabled" in control) control.disabled = true;
    control.setAttribute("aria-disabled", "true");
    control.title = "Viewer access is read only";
  });
  document.querySelectorAll('[contenteditable="true"]').forEach((element) => {
    if (element.closest(".editor-shell")) element.setAttribute("contenteditable", "false");
  });
  document.querySelectorAll("[data-drag-path]").forEach((element) => {
    element.draggable = false;
    element.removeAttribute("draggable");
  });
  const fallback = document.querySelector(".editor-fallback-textarea");
  if (fallback) {
    fallback.readOnly = true;
    fallback.setAttribute("aria-readonly", "true");
  }
  const aiForm = document.querySelector("#aiHelperForm");
  aiForm?.setAttribute("aria-disabled", "true");
  if (aiForm && !document.querySelector(".viewer-access-note")) {
    aiForm.insertAdjacentHTML("beforebegin", `<p class="viewer-access-note" role="note"><strong>Viewer access</strong><span>Ask the host for Maintainer access to use AI editing.</span></p>`);
  }
}

function refreshRightRailUi() {
  const rail = document.querySelector(".right-rail");
  if (!rail || route().view !== "editor") {
    render();
    return;
  }
  const previousAiList = rail.querySelector(".ai-chat-list");
  const aiScroll = previousAiList?.scrollTop || 0;
  const shouldStickToLatest = local.aiForceScrollBottom || local.aiChatPinnedToBottom || isAiChatNearBottom(previousAiList);
  const changesScroll = rail.querySelector(".change-history-list")?.scrollTop || 0;
  rail.outerHTML = rightRailMarkup();
  bindRightRailControls();
  bindChatForm();
  applyProjectMutationAccessUi();
  const nextAiList = document.querySelector(".ai-chat-list");
  const nextChangesList = document.querySelector(".change-history-list");
  if (nextAiList) {
    if (local.rightRailTab === "ai" && shouldStickToLatest) {
      requestAnimationFrame(() => scrollAiChatToBottom());
    } else {
      nextAiList.scrollTop = aiScroll;
      requestAnimationFrame(() => setAiChatJumpVisible(!isAiChatNearBottom(nextAiList)));
    }
  }
  if (nextChangesList) nextChangesList.scrollTop = changesScroll;
  local.aiForceScrollBottom = false;
}

function setRightRailTab(tab) {
  local.rightRailTab = ["chat", "ai", "changes"].includes(tab) ? tab : "chat";
  localStorage.setItem("localleaf.rightRailTab", local.rightRailTab);
  if (local.rightRailTab === "ai") local.aiForceScrollBottom = true;
  refreshRightRailUi();
}

function findAiProposal(proposalId) {
  for (const message of local.aiMessages) {
    const proposal = (message.proposals || []).find((item) => item.id === proposalId);
    if (proposal) return proposal;
  }
  return local.aiChangeHistory.find((item) => item.id === proposalId) || null;
}

function rememberAiProposal(proposal) {
  if (!proposal?.id) return;
  proposal.sessionId = proposal.sessionId || local.aiCurrentSessionId;
  const existing = local.aiChangeHistory.findIndex((item) => item.id === proposal.id);
  if (existing >= 0) local.aiChangeHistory.splice(existing, 1, proposal);
  else local.aiChangeHistory.push(proposal);
  local.aiChangeHistory = local.aiChangeHistory.slice(-50);
}

function setAiProposalStatus(proposalId, status, patch = {}) {
  const proposal = findAiProposal(proposalId);
  if (!proposal) return;
  Object.assign(proposal, patch, { status });
  rememberAiProposal(proposal);
}

function shouldAutoApplyAiProposal(proposal) {
  if (!proposal || proposal.status !== "proposed") return false;
  return proposal.approvalRequired === false;
}

function isAiChatNearBottom(list) {
  if (!list) return true;
  return list.scrollHeight - list.scrollTop - list.clientHeight < 42;
}

function setAiChatJumpVisible(visible) {
  local.aiChatNeedsJump = Boolean(visible);
  const button = document.querySelector("#aiScrollLatest");
  if (!button) return;
  button.classList.toggle("visible", local.aiChatNeedsJump);
  button.setAttribute("aria-hidden", local.aiChatNeedsJump ? "false" : "true");
}

function setAiActivity(message, options = {}) {
  local.aiActivityMessage = String(message || "").trim();
  local.aiForceScrollBottom = true;
  if (options.render !== false) refreshRightRailUi();
}

function clearAiActivity(options = {}) {
  local.aiActivityMessage = "";
  if (options.render !== false) refreshRightRailUi();
}

function updateAiSendButtonState() {
  const button = document.querySelector(".ai-send-button");
  if (!button) return;
  const stopMode = aiComposerShouldStop();
  button.classList.toggle("is-stop", stopMode);
  button.type = stopMode ? "button" : "submit";
  button.toggleAttribute("data-stop-ai-run", stopMode);
  button.title = stopMode ? "Stop" : "Send";
  button.setAttribute("aria-label", stopMode ? "Stop AI run" : "Send");
  button.innerHTML = uiGlyph(stopMode ? "stop" : "upload");
}

function autoGrowAiPrompt(input = document.querySelector("#aiPrompt")) {
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 148)}px`;
}

async function stopAiRun(sessionId = local.aiActiveRunSessionId) {
  local.aiStopRequested = true;
  const runId = local.aiActiveRunId;
  if (runId && sessionId) {
    try {
      const sessionState = await api("/api/agent/run/cancel", {
        method: "POST",
        body: { runId, sessionId }
      });
      applyAiSessionState(sessionState);
      reduceAiSessionState({ type: "RUN_CANCELLED", runId });
      announceAi("AI response stopped.");
    } catch (error) {
      announceAi(error.message || "Could not stop the AI response.");
    }
  }
  local.aiRunControllers.forEach((controller) => controller.abort());
  local.aiRunControllers.clear();
  local.aiActiveRunCount = 0;
  local.aiBusy = false;
  local.aiActiveRunId = "";
  local.aiActiveRunSessionId = "";
  local.aiCompileVerifying = false;
  local.aiActivityMessage = "";
  local.aiForceScrollBottom = true;
  refreshRightRailUi();
}

function scrollAiChatToBottom({ smooth = false } = {}) {
  const list = document.querySelector("#aiChatList") || document.querySelector(".ai-chat-list");
  if (!list) return;
  const allowSmooth = smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  list.scrollTo({ top: list.scrollHeight, behavior: allowSmooth ? "smooth" : "auto" });
  local.aiChatPinnedToBottom = true;
  setAiChatJumpVisible(false);
}

function bindAiChatScrollState() {
  const list = document.querySelector("#aiChatList") || document.querySelector(".ai-chat-list");
  if (!list) return;
  const update = () => {
    const nearBottom = isAiChatNearBottom(list);
    local.aiChatPinnedToBottom = nearBottom;
    setAiChatJumpVisible(!nearBottom);
  };
  list.addEventListener("scroll", update, { passive: true });
  requestAnimationFrame(update);
}

function createQueuedAiPrompt(prompt, options = {}) {
  const activeModel = activeAiProviderModel();
  return {
    id: `queued-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    clientMessageId: `user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId: local.aiCurrentSessionId,
    message: String(prompt || "").trim(),
    createdAt: Date.now(),
    path: options.path ?? local.selectedFile,
    selectedText: options.selectedText ?? selectedEditorText(),
    pdfAnnotation: options.pdfAnnotation || null,
    model: {
      providerId: activeModel.providerId || "",
      modelId: activeModel.modelId || "",
      providerName: activeModel.providerName || "",
      modelName: activeModel.modelName || ""
    },
    permissions: { ...local.aiPermissions }
  };
}

function queueAiPrompt(prompt, options = {}) {
  const queued = createQueuedAiPrompt(prompt, options);
  if (!queued.message) return null;
  local.aiQueuedPrompts.push(queued);
  reduceAiSessionState({ type: "PROMPT_QUEUED", item: queued });
  local.aiPrompt = "";
  local.aiEditingQueuedPromptId = "";
  local.aiSessionMoreMenuOpen = false;
  local.aiQueuedPromptMenuOpenId = "";
  local.aiForceScrollBottom = true;
  refreshRightRailUi();
  return queued;
}

function findQueuedAiPrompt(id) {
  return local.aiQueuedPrompts.find((item) => item.id === id) || null;
}

function editQueuedAiPrompt(id) {
  const queued = findQueuedAiPrompt(id);
  if (!queued) return;
  local.aiEditingQueuedPromptId = queued.id;
  local.aiPrompt = queued.message;
  local.aiSessionMoreMenuOpen = false;
  local.aiQueuedPromptMenuOpenId = "";
  refreshRightRailUi();
  setTimeout(() => {
    const prompt = document.querySelector("#aiPrompt");
    prompt?.focus();
    prompt?.setSelectionRange?.(prompt.value.length, prompt.value.length);
  }, 0);
}

function deleteQueuedAiPrompt(id) {
  reduceAiSessionState({ type: "PROMPT_DEQUEUED", id });
  local.aiQueuedPrompts = local.aiQueuedPrompts.filter((item) => item.id !== id);
  if (local.aiEditingQueuedPromptId === id) {
    local.aiEditingQueuedPromptId = "";
    local.aiPrompt = "";
  }
  local.aiSessionMoreMenuOpen = false;
  if (local.aiQueuedPromptMenuOpenId === id) local.aiQueuedPromptMenuOpenId = "";
  refreshRightRailUi();
}

function commitQueuedPromptEdit() {
  const queued = findQueuedAiPrompt(local.aiEditingQueuedPromptId);
  if (!queued) return false;
  queued.message = String(local.aiPrompt || "").trim();
  if (!queued.message) {
    deleteQueuedAiPrompt(queued.id);
    return true;
  }
  local.aiPrompt = "";
  local.aiEditingQueuedPromptId = "";
  local.aiSessionMoreMenuOpen = false;
  local.aiQueuedPromptMenuOpenId = "";
  refreshRightRailUi();
  return true;
}

async function askAiHelper(message, options = {}) {
  if (!requireProjectMutationAccess("use the AI Helper")) return;
  const prompt = String(message || local.aiPrompt || "").trim();
  if (!prompt) return;
  if (local.aiEditingQueuedPromptId && !options.steer) {
    commitQueuedPromptEdit();
    return;
  }
  if (local.aiBusy) {
    if (options.queuedPrompt) {
      local.aiQueuedPrompts.unshift(options.queuedPrompt);
      reduceAiSessionState({ type: "PROMPT_QUEUED", item: options.queuedPrompt });
      refreshRightRailUi();
    } else {
      queueAiPrompt(prompt, options);
    }
    return;
  }
  const activeModel = activeAiProviderModel();
  const queuedModel = options.queuedPrompt?.model || null;
  const originSessionId = options.queuedPrompt?.sessionId || local.aiCurrentSessionId;
  const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clientMessageId = options.queuedPrompt?.clientMessageId || `user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const controller = new AbortController();
  local.aiRunControllers.add(controller);
  local.aiStopRequested = false;
  local.aiPrompt = "";
  local.aiActiveRunCount += 1;
  local.aiBusy = local.aiActiveRunCount > 0;
  local.aiActiveRunId = local.aiActiveRunId || runId;
  local.aiActiveRunSessionId = originSessionId;
  local.aiActivityMessage = options.steer ? "Steering the active run" : "Reading the project and planning the edit";
  local.rightRailTab = "ai";
  localStorage.setItem("localleaf.rightRailTab", "ai");
  local.aiForceScrollBottom = true;
  const userMessage = { id: clientMessageId, role: "user", message: prompt, createdAt: Date.now(), runId };
  reduceAiSessionState({
    type: "RUN_STARTED",
    runId,
    sessionId: originSessionId,
    userMessage,
    run: {
      runId,
      sessionId: originSessionId,
      clientMessageId,
      model: queuedModel || activeModel,
      permissions: options.queuedPrompt?.permissions || local.aiPermissions
    }
  });
  refreshRightRailUi();
  try {
    const response = await api(options.steer ? "/api/agent/steer" : "/api/agent/message", {
      method: "POST",
      signal: controller.signal,
      body: {
        runId,
        clientMessageId,
        sessionId: originSessionId,
        queuedPromptId: options.queuedPrompt?.id || "",
        message: prompt,
        path: options.queuedPrompt ? options.queuedPrompt.path : (options.path ?? local.selectedFile),
        currentText: currentEditorText(),
        selectedText: options.queuedPrompt ? options.queuedPrompt.selectedText : (options.selectedText ?? selectedEditorText()),
        pdfAnnotation: options.queuedPrompt ? options.queuedPrompt.pdfAnnotation : (options.pdfAnnotation || null),
        compileLogs: local.appState?.compile?.logs || [],
        aiProviderId: queuedModel?.providerId || activeModel.providerId || "",
        aiModelId: queuedModel?.modelId || activeModel.modelId || "",
        aiPermissions: options.queuedPrompt?.permissions || local.aiPermissions
      }
    });
    const proposals = (response.proposals || []).map((proposal) => ({
      ...proposal,
      status: proposal.status || "proposed",
      sessionId: response.sessionId || originSessionId
    }));
    proposals.forEach(rememberAiProposal);
    const visibleApprovalIds = [];
    const autoApplied = [];
    if (proposals.some(shouldAutoApplyAiProposal)) {
      setAiActivity("Applying approved-safe edits", { render: false });
      for (const proposal of proposals) {
        try {
          if (shouldAutoApplyAiProposal(proposal)) {
            const applied = await approveAiProposal(proposal.id, {
              fromYolo: true,
              renderAfter: false,
              verifyCompile: false,
              suppressAutoApplyMessage: true
            });
            if (applied) {
              Object.assign(proposal, applied);
              autoApplied.push(proposal);
            }
          }
          else visibleApprovalIds.push(proposal.id);
        } catch {
          visibleApprovalIds.push(proposal.id);
        }
      }
    } else {
      visibleApprovalIds.push(...proposals.filter((proposal) => proposal.status === "proposed").map((proposal) => proposal.id));
    }
    const assistantMessage = {
      ...(response.assistantMessage || {}),
      id: response.assistantMessage?.id || `assistant-${runId}`,
      role: "assistant",
      message: response.assistantMessage?.message || response.reply || "I prepared a response.",
      proposals,
      approvalCards: visibleApprovalIds,
      runId
    };
    reduceAiSessionState({
      type: "RUN_COMPLETED",
      runId,
      assistantMessage,
      sessionRevision: response.sessionRevision,
      contextUsage: response.contextUsage
    });
    local.aiContextUpdating = true;
    await refreshAiSessionsFromHost({ render: false });
    if (originSessionId !== local.aiCurrentSessionId) {
      const origin = local.aiSessions.find((session) => session.id === originSessionId);
      announceAi(`Response completed in ${origin?.title || "a background AI session"}.`);
    } else if (Number(response.contextUsage?.window?.percentUsed || 0) >= 90) {
      announceAi("Context is nearly full. Consider starting a new session.");
    } else {
      announceAi("AI response completed.");
    }
    setTimeout(() => {
      local.aiContextUpdating = false;
      document.querySelector(".ai-context-ring")?.classList.remove("is-updating");
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140);
    if (autoApplied.length) await verifyAiRunAfterApply(autoApplied);
  } catch (error) {
    if (!controller.signal.aborted) {
      reduceAiSessionState({
        type: error.code === "AI_RUN_CANCELLED" ? "RUN_CANCELLED" : "RUN_FAILED",
        runId,
        error: { message: error.message || "AI Helper could not respond." }
      });
      if (originSessionId === local.aiCurrentSessionId) {
        local.aiMessages.push({
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          message: error.message || "AI Helper could not respond."
        });
      }
      announceAi(error.message || "AI Helper could not respond.");
      await refreshAiSessionsFromHost({ render: false });
    }
  } finally {
    local.aiRunControllers.delete(controller);
    local.aiActiveRunCount = controller.signal.aborted ? local.aiRunControllers.size : Math.max(0, local.aiActiveRunCount - 1);
    local.aiBusy = local.aiActiveRunCount > 0;
    if (!local.aiBusy) {
      local.aiActiveRunId = "";
      local.aiActiveRunSessionId = "";
    }
    if (!local.aiBusy && !local.aiCompileVerifying) local.aiActivityMessage = "";
    local.aiForceScrollBottom = true;
    refreshRightRailUi();
    if (!local.aiBusy) {
      const queued = local.aiQueuedPrompts.shift();
      if (queued?.id) reduceAiSessionState({ type: "PROMPT_DEQUEUED", id: queued.id });
      if (queued?.message) setTimeout(() => askAiHelper(queued.message, { queuedPrompt: queued, allowWhileBusy: true }), 0);
    }
    if (!local.aiBusy) local.aiStopRequested = false;
  }
}

async function approveAiProposal(proposalId, options = {}) {
  if (!requireProjectMutationAccess("apply AI edits")) return null;
  const proposal = findAiProposal(proposalId);
  if (!proposal) return;
  if (proposal.actionable === false) {
    showAppNotice("This proposal is historical and can no longer be applied after LocalLeaf restarted.", {
      type: "warning",
      title: "Proposal unavailable",
      detail: "Ask the AI Helper to prepare a fresh proposal against the current project state."
    });
    return null;
  }
  if (proposal.operation !== "create" && proposal.path === local.selectedFile && !await saveCurrentFile()) {
    showAppNotice("Save the current file before applying this AI proposal.", {
      type: "warning",
      title: "Approval paused"
    });
    return null;
  }
  let appliedProposal = null;
  let verifierOwnsActivity = false;
  setAiActivity(options.fromYolo ? "Applying YOLO edit" : "Applying approved change", { render: options.renderAfter !== false });
  try {
    const result = await api("/api/agent/approval/approve", { method: "POST", body: { proposalId } });
    appliedProposal = result.proposal || null;
    setAiProposalStatus(proposalId, appliedProposal?.status || "applied", appliedProposal || {});
    await loadState();
    if (proposal.operation === "create") {
      const selected = await selectProjectFile(proposal.path);
      if (!selected) {
        showAppNotice("The file was created, but LocalLeaf kept the current editor open because its unsaved content could not be saved.", {
          type: "warning",
          title: "New file created"
        });
      }
    } else if (!local.selectedFile || proposal.path === local.selectedFile) {
      local.selectedFile = proposal.path || local.selectedFile;
      expandToFile(local.selectedFile);
      await loadSelectedFile();
      updateEditorSourceUi();
    }
    if (options.fromYolo && !options.suppressAutoApplyMessage) {
      local.aiMessages.push({
        id: `assistant-auto-apply-${Date.now()}`,
        role: "assistant",
        message: proposal.operation === "create"
          ? `Created ${proposal.path || "the new project file"} after host approval.`
          : `YOLO mode applied the approved-safe edit to ${proposal.path || "the current file"}.`
      });
    }
    if (options.verifyCompile !== false) {
      verifierOwnsActivity = true;
      refreshRightRailUi();
      await verifyAiRunAfterApply([appliedProposal || proposal]);
    }
    return appliedProposal || proposal;
  } catch (error) {
    if (error.proposal) {
      setAiProposalStatus(proposalId, error.proposal.status || proposal.status || "proposed", error.proposal);
    } else {
      try {
        await loadState();
        await refreshAiSessionsFromHost({ render: false });
      } catch {
        // Keep the last known proposal state when the host cannot be reached.
      }
    }
    local.aiMessages.push({
      id: `assistant-apply-error-${Date.now()}`,
      role: "assistant",
      message: error.message || "LocalLeaf could not confirm whether the proposal was applied. The project state was refreshed where possible."
    });
    return null;
  } finally {
    if (!verifierOwnsActivity) clearAiActivity({ render: false });
    syncCurrentAiSession();
    if (options.renderAfter !== false) refreshRightRailUi();
  }
}

async function rejectAiProposal(proposalId) {
  if (!requireProjectMutationAccess("manage AI edits")) return null;
  const proposal = findAiProposal(proposalId);
  if (proposal?.actionable === false) {
    showAppNotice("This historical proposal is no longer actionable after LocalLeaf restarted.", {
      type: "warning",
      title: "Proposal unavailable"
    });
    return;
  }
  try {
    const result = await api("/api/agent/approval/reject", { method: "POST", body: { proposalId } });
    setAiProposalStatus(proposalId, result.proposal?.status || "rejected", result.proposal || {});
  } catch (error) {
    if (error.proposal) {
      setAiProposalStatus(proposalId, error.proposal.status || "proposed", error.proposal);
    } else {
      try {
        await refreshAiSessionsFromHost({ render: false });
      } catch {
        // Leave the proposal actionable if the host could not confirm the rejection.
      }
    }
    local.aiMessages.push({
      id: `assistant-reject-error-${Date.now()}`,
      role: "assistant",
      message: error.message || "Could not reject the proposal on the host."
    });
  } finally {
    syncCurrentAiSession();
    refreshRightRailUi();
  }
}

function explainAiProposal(proposalId) {
  const proposal = findAiProposal(proposalId);
  if (!proposal) return;
  local.rightRailTab = "ai";
  localStorage.setItem("localleaf.rightRailTab", "ai");
  local.aiForceScrollBottom = true;
  local.aiMessages.push({
    id: `assistant-explain-${Date.now()}`,
    role: "assistant",
    message: proposal.operation === "create"
      ? `${proposal.summary || "This proposal creates a new project file."} It will create ${proposal.path || "the requested file"} only after host approval and is listed in Changes.`
      : `${proposal.summary || "This change updates the selected text file."} It targets ${proposal.path || "the current file"} and is listed in Changes.`,
    fileLinks: proposal.path && (proposal.operation !== "create" || proposal.status === "applied") ? [proposal.path] : []
  });
  syncCurrentAiSession();
  refreshRightRailUi();
}

async function openAiProposalFile(proposalId, options = {}) {
  const proposal = findAiProposal(proposalId);
  if (!proposal?.path) return false;
  const isCurrent = typeof options.isCurrent === "function" ? options.isCurrent : () => true;
  if (!isCurrent()) return false;
  local.sourcePaneVisible = true;
  localStorage.setItem("localleaf.sourcePaneVisible", "1");
  local.editorMode = "code";
  localStorage.setItem("localleaf.editorMode", "code");
  try {
    applyEditorLayoutState();
    const selected = await selectProjectFile(proposal.path, { isCurrent });
    if (!selected || !isCurrent()) return false;
    local.rightRailTab = "changes";
    localStorage.setItem("localleaf.rightRailTab", "changes");
    setEditorMode("code");
    if (options.focus !== false) requestAnimationFrame(() => {
      if (!isCurrent()) return;
      const focus = proposal.focus || {};
      const contentLength = String(local.editorContent || "").length;
      const start = Math.max(0, Math.min(contentLength, Number.isInteger(focus.start) ? focus.start : 0));
      const end = Math.max(start, Math.min(contentLength, Number.isInteger(focus.end) ? focus.end : start));
      local.codeEditor?.selectRange?.(start, end);
      local.codeEditor?.focus?.();
      requestAnimationFrame(centerCodeEditorSelection);
    });
    return true;
  } catch (error) {
    showAppNotice(error.message || "Could not open the proposal file.", { title: "Open file" });
    return false;
  }
}

function aiProposalExpectedSourceHash(proposal) {
  return proposal?.status === "applied"
    ? String(proposal.newHash || "")
    : String(proposal?.baseHash || "");
}

function aiProposalOutputTarget(proposal, runId = "") {
  const focus = proposal?.focus || {};
  const line = Number.isSafeInteger(Number(focus.line)) && Number(focus.line) > 0
    ? Number(focus.line)
    : 1;
  const column = Number.isSafeInteger(Number(focus.column)) && Number(focus.column) >= 0
    ? Number(focus.column)
    : 0;
  const compile = local.appState?.compile || {};
  return {
    proposalId: String(proposal?.id || ""),
    runId: String(runId || aiRunIdForProposal(proposal)),
    path: String(proposal?.path || ""),
    line,
    column,
    expectedSourceHash: aiProposalExpectedSourceHash(proposal),
    artifactId: String(compile.artifactId || ""),
    version: Number(compile.version || 0)
  };
}

async function resolveAiProposalPdfOutput(target) {
  const result = await api("/api/pdf/output-position", {
    method: "POST",
    body: {
      path: target.path,
      line: target.line,
      column: target.column,
      expectedSourceHash: target.expectedSourceHash,
      artifactId: target.artifactId,
      version: target.version
    }
  });
  return result?.ok
    ? {
        ...result,
        proposalId: target.proposalId,
        runId: target.runId,
        artifactId: String(result.artifactId || target.artifactId),
        version: Number(result.version || target.version)
      }
    : result;
}

async function revealAiProposalPdfOutput(output, navigation = {}) {
  if (!output?.ok || (navigation.isCurrent && !navigation.isCurrent())) return false;
  const previewPane = document.querySelector("#previewPane");
  const reveal = window.LocalLeafPdfPreview?.revealPosition;
  if (!previewPane || typeof reveal !== "function") return false;
  local.previewPaneVisible = true;
  localStorage.setItem("localleaf.previewPaneVisible", "1");
  applyEditorLayoutState();
  const revealed = await reveal(previewPane, output);
  if (navigation.isCurrent && !navigation.isCurrent()) return false;
  return revealed === true;
}

function aiReviewNavigator() {
  if (local.aiReviewNavigator) return local.aiReviewNavigator;
  const createController = window.LocalLeafPdfSourceNavigation?.createPdfOutputNavigationController;
  if (typeof createController !== "function") return null;
  local.aiReviewNavigator = createController({
    lookup: resolveAiProposalPdfOutput,
    reveal: revealAiProposalPdfOutput,
    onStatus: (status) => {
      const previousTarget = local.aiReviewStatus?.target || null;
      updateAiReviewStatus({
        ...status,
        target: status?.target || status?.output || previousTarget
      });
    }
  });
  return local.aiReviewNavigator;
}

function proposalDiffText(proposal) {
  const hunks = Array.isArray(proposal?.diffHunks) ? proposal.diffHunks : [];
  if (!hunks.length) return String(proposal?.newText || proposal?.replacements?.[0]?.text || "");
  return hunks.flatMap((hunk) => (hunk.lines || []).map((line) => {
    const marker = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
    return `${marker} ${line.text || ""}`;
  })).join("\n");
}

async function copyAiProposalDiff(proposalId) {
  const proposal = findAiProposal(proposalId);
  if (!proposal) return;
  const text = proposalDiffText(proposal);
  try {
    await navigator.clipboard.writeText(text);
    showAppNotice("Diff copied.", { title: "Changes" });
  } catch {
    showAppNotice("Could not copy the diff from this browser.", { title: "Changes" });
  }
}

function uniqueProposalFiles(proposals = []) {
  return [...new Set(proposals.map((proposal) => proposal?.path).filter(Boolean))];
}

function addAiReportMessage(message, proposals = []) {
  clearAiActivity({ render: false });
  local.rightRailTab = "ai";
  localStorage.setItem("localleaf.rightRailTab", "ai");
  local.aiForceScrollBottom = true;
  local.aiMessages.push({
    id: `assistant-report-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: "assistant",
    message,
    fileLinks: uniqueProposalFiles(proposals)
  });
  syncCurrentAiSession();
  refreshRightRailUi();
}

function compileFailureSummary() {
  const logs = Array.isArray(local.appState?.compile?.logs) ? local.appState.compile.logs : [];
  const interesting = logs
    .filter((line) => /(^!|error|fatal|undefined|missing|emergency|failed)/iu.test(line))
    .slice(-4);
  return interesting.length ? interesting.join(" ") : "The compile did not finish successfully.";
}

async function requestCompileRepair(runId, sourceProposals, attempt) {
  const primary = sourceProposals.find((proposal) => proposal?.path) || sourceProposals[0] || {};
  const activeModel = activeAiProviderModel();
  const repairRunId = `${String(runId || "run").slice(0, 46)}-repair-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
  const clientMessageId = `user-${repairRunId}`;
  const repairMessage = [
    `Fix the LaTeX compile errors caused by AI run ${runId}.`,
    "Keep the intended edit, make the smallest safe repair, and return a LocalLeaf proposal.",
    `Repair attempt ${attempt} of 3.`
  ].join(" ");
  const response = await api("/api/agent/message", {
    method: "POST",
    body: {
      runId: repairRunId,
      clientMessageId,
      sessionId: primary.sessionId || local.aiCurrentSessionId,
      parentRunId: runId,
      message: repairMessage,
      path: primary.path || local.selectedFile,
      currentText: currentEditorText(),
      selectedText: "",
      compileLogs: local.appState?.compile?.logs || [],
      aiProviderId: activeModel.providerId || "",
      aiModelId: activeModel.modelId || "",
      aiPermissions: { ...local.aiPermissions }
    }
  });
  const proposals = (response.proposals || []).map((proposal) => ({
    ...proposal,
    status: proposal.status || "proposed",
    sessionId: local.aiCurrentSessionId,
    runId: proposal.runId || repairRunId
  }));
  proposals.forEach(rememberAiProposal);
  return { response, proposals };
}

async function verifyAiRunAfterApply(sourceProposals, options = {}) {
  const proposals = (sourceProposals || []).filter(Boolean);
  if (!proposals.length || options.verifyCompile === false || local.aiStopRequested) return;
  const runId = proposals.find((proposal) => proposal.runId)?.runId || proposals[0].id;
  const attempt = Number(options.attempt || local.aiCompileRepairAttempts[runId] || 0);
  local.aiCompileRepairAttempts[runId] = attempt;
  local.aiCompileVerifying = true;
  setAiActivity(attempt ? `Recompiling after repair ${attempt}` : "Compiling the updated project");
  local.previewPaneVisible = true;
  localStorage.setItem("localleaf.previewPaneVisible", "1");
  try {
    await compile();
    if (local.aiStopRequested) return;
    if (local.appState?.compile?.status === "success") {
      delete local.aiCompileRepairAttempts[runId];
      addAiReportMessage(
        `Done. I applied ${proposals.length} change${proposals.length === 1 ? "" : "s"} and the project compiled without errors.`,
        proposals
      );
      return;
    }
  } catch {
    // The compile panel already owns the detailed failure state.
  }

  if (attempt >= 3) {
    if (local.aiStopRequested) return;
    delete local.aiCompileRepairAttempts[runId];
    addAiReportMessage(
      `I applied the changes, but the project still has compile errors after 3 repair attempts. ${compileFailureSummary()}`,
      proposals
    );
    return;
  }

  const nextAttempt = attempt + 1;
  local.aiCompileRepairAttempts[runId] = nextAttempt;
  try {
    if (local.aiStopRequested) return;
    setAiActivity(`Preparing compile repair ${nextAttempt} of 3`);
    const { response, proposals: repairProposals } = await requestCompileRepair(runId, proposals, nextAttempt);
    if (local.aiStopRequested) return;
    if (!repairProposals.length) {
      addAiReportMessage(
        `I applied the changes, but the project did not compile. ${response.reply || compileFailureSummary()}`,
        proposals
      );
      return;
    }

    if (local.aiPermissions.yoloMode) {
      const appliedRepairs = [];
      for (const repair of repairProposals) {
        if (local.aiStopRequested) return;
        setAiActivity(`Applying compile repair ${nextAttempt} of 3`);
        const applied = await approveAiProposal(repair.id, {
          fromYolo: true,
          renderAfter: false,
          verifyCompile: false,
          suppressAutoApplyMessage: true
        });
        if (applied) appliedRepairs.push(applied);
      }
      refreshRightRailUi();
      if (local.aiStopRequested) return;
      await verifyAiRunAfterApply(appliedRepairs.length ? appliedRepairs : repairProposals, { attempt: nextAttempt });
      return;
    }

    setAiActivity("Waiting for approval on the compile repair");
    local.rightRailTab = "ai";
    localStorage.setItem("localleaf.rightRailTab", "ai");
    local.aiForceScrollBottom = true;
    local.aiMessages.push({
      id: `assistant-compile-repair-${Date.now()}`,
      role: "assistant",
      message: `The compile failed after the applied change. I prepared a repair proposal for approval. ${response.reply || compileFailureSummary()}`,
      proposals: repairProposals,
      approvalCards: repairProposals.filter((proposal) => proposal.approvalRequired !== false).map((proposal) => proposal.id),
      fileLinks: uniqueProposalFiles(repairProposals)
    });
    syncCurrentAiSession();
    refreshRightRailUi();
  } catch (error) {
    addAiReportMessage(
      `I applied the changes, but could not prepare an automatic compile repair. ${error.message || compileFailureSummary()}`,
      proposals
    );
  } finally {
    local.aiCompileVerifying = false;
    clearAiActivity();
  }
}

function toggleAiRun(runId) {
  if (local.aiExpandedRuns.has(runId)) local.aiExpandedRuns.delete(runId);
  else local.aiExpandedRuns.add(runId);
  refreshRightRailUi();
}

async function reviewAiRun(runKey) {
  const requestId = ++local.aiReviewOpenSequence;
  const isCurrent = () => requestId === local.aiReviewOpenSequence;
  local.aiReviewNavigator?.cancel?.();
  local.aiExpandedRuns.add(runKey);
  const run = aiChangeRuns(aiHistoryItems()).find((item) => item.id === runKey);
  const runId = run?.runId || "";
  const runProposals = run?.proposals || [];
  const proposal = runProposals.find((item) => item.operation !== "create") || runProposals[0];
  if (proposal?.id) local.aiExpandedChanges.add(proposal.id);
  refreshRightRailUi();
  if (!proposal) {
    updateAiReviewStatus({ state: "unavailable", reason: "This change is no longer available to review." });
    return false;
  }
  if (proposal.operation === "create" && proposal.status !== "applied") {
    updateAiReviewStatus({
      state: "unavailable",
      target: { proposalId: proposal.id, runId, path: proposal.path },
      reason: "This new file has not been created yet. Review its diff here, then choose Create file if it is correct."
    });
    return false;
  }

  local.sourcePaneVisible = true;
  local.previewPaneVisible = true;
  localStorage.setItem("localleaf.sourcePaneVisible", "1");
  localStorage.setItem("localleaf.previewPaneVisible", "1");
  applyEditorLayoutState();
  const target = aiProposalOutputTarget(proposal, runId);
  updateAiReviewStatus({ state: "locating", target });
  const opened = await openAiProposalFile(proposal.id, { isCurrent });
  if (!isCurrent()) return false;
  if (!opened) {
    const unavailable = { state: "unavailable", target, reason: "The changed source file could not be opened." };
    updateAiReviewStatus(unavailable);
    return false;
  }

  const navigator = aiReviewNavigator();
  if (!navigator) {
    const unavailable = {
      state: "unavailable",
      target,
      reason: "PDF location navigation is unavailable in this build. The changed source is open."
    };
    updateAiReviewStatus(unavailable);
    return false;
  }
  const result = await navigator.navigate(target);
  if (!isCurrent() || result?.superseded) return false;
  if (!result?.ok) {
    showAppNotice(result?.reason || "The changed source is open, but its PDF location is unavailable.", {
      title: "PDF location",
      detail: result?.recompileRequired ? "Recompile the project, then choose Review again." : "The source file remains open for review."
    });
    return false;
  }
  return true;
}

function toggleAiChange(proposalId) {
  if (local.aiExpandedChanges.has(proposalId)) local.aiExpandedChanges.delete(proposalId);
  else local.aiExpandedChanges.add(proposalId);
  refreshRightRailUi();
}

function toggleAiProposalDiff(proposalId) {
  local.aiExpandedChanges.add(proposalId);
  if (local.aiExpandedDiffs.has(proposalId)) local.aiExpandedDiffs.delete(proposalId);
  else local.aiExpandedDiffs.add(proposalId);
  refreshRightRailUi();
}

async function openSurvivingProjectFile() {
  const files = Array.isArray(local.appState?.project?.files) ? local.appState.project.files : [];
  const fallback = local.appState?.project?.mainFile
    || files.find((file) => file.type === "text")?.path
    || "";
  local.selectedFile = fallback;
  if (!fallback) {
    local.editorContent = "";
    updateEditorSourceUi();
    return;
  }
  expandToFile(fallback);
  await loadSelectedFile();
  updateEditorSourceUi();
  sendCollab("open_file", { filePath: fallback });
}

async function revertAiProposal(proposalId, options = {}) {
  if (!requireProjectMutationAccess("revert AI edits")) return null;
  const proposal = findAiProposal(proposalId);
  if (!proposal) return null;
  if (proposal.actionable === false) {
    showAppNotice("This historical change can no longer be reverted automatically after LocalLeaf restarted.", {
      type: "warning",
      title: "Revert unavailable",
      detail: "Use version control or prepare a new inverse edit."
    });
    return null;
  }
  if (proposal.path === local.selectedFile && !await saveCurrentFile()) {
    showAppNotice("Save the current file before reverting this AI change.", {
      type: "warning",
      title: "Revert paused"
    });
    return null;
  }
  try {
    const result = await api("/api/agent/proposal/revert", { method: "POST", body: { proposalId } });
    setAiProposalStatus(proposalId, result.proposal?.status || "reverted", result.proposal || {});
    await loadState();
    if (proposal.path === local.selectedFile) {
      if (proposal.operation === "create") await openSurvivingProjectFile();
      else {
        await loadSelectedFile();
        updateEditorSourceUi();
      }
    }
    if (options.report !== false) {
      addAiReportMessage(`Reverted ${proposal.summary || "the AI change"}.`, [result.proposal || proposal]);
    }
    return result.proposal || proposal;
  } catch (error) {
    if (error.proposal) setAiProposalStatus(proposalId, error.proposal.status || "stale", error.proposal);
    showAppNotice(error.message || "Could not revert this change.", { title: "Revert change" });
    return null;
  } finally {
    syncCurrentAiSession();
    refreshRightRailUi();
  }
}

async function undoAiRun(runKey) {
  const run = aiChangeRuns(aiHistoryItems()).find((item) => item.id === runKey);
  if (!run) return;
  if (run.proposals.some((proposal) => proposal.path === local.selectedFile) && !await saveCurrentFile()) {
    showAppNotice("Save the current file before undoing this AI run.", {
      type: "warning",
      title: "Undo paused"
    });
    return;
  }
  try {
    const result = await api("/api/agent/run/revert", {
      method: "POST",
      body: { runId: run.runId, proposalId: run.anchorProposalId }
    });
    (result.proposals || []).forEach((proposal) => setAiProposalStatus(proposal.id, proposal.status || "reverted", proposal));
    await loadState();
    const selectedProposal = result.proposals?.find((proposal) => proposal.path === local.selectedFile);
    if (selectedProposal) {
      if (selectedProposal.operation === "create") await openSurvivingProjectFile();
      else {
        await loadSelectedFile();
        updateEditorSourceUi();
      }
    }
    addAiReportMessage(`Undid ${result.proposals?.length || 0} applied change${result.proposals?.length === 1 ? "" : "s"} from this run.`, result.proposals || []);
  } catch (error) {
    showAppNotice(error.message || "Could not undo this run.", { title: "Undo run" });
  } finally {
    syncCurrentAiSession();
    refreshRightRailUi();
  }
}

function bindRightRailControls() {
  bindChatSessionActions();
  bindAiChatScrollState();
  if (local.rightRailTab === "ai" && local.aiForceScrollBottom) {
    requestAnimationFrame(() => {
      scrollAiChatToBottom();
      local.aiForceScrollBottom = false;
    });
  }
  document.querySelectorAll("[data-right-rail-tab]").forEach((button) => {
    button.addEventListener("click", () => setRightRailTab(button.dataset.rightRailTab));
  });
  document.querySelector("#openAiSettings")?.addEventListener("click", () => showSettingsModal("models"));
  document.querySelectorAll("[data-open-model-settings]").forEach((button) => {
    button.addEventListener("click", () => showSettingsModal("models"));
  });
  document.querySelector("#aiModelChip")?.addEventListener("click", () => {
    local.aiModelPickerOpen = !local.aiModelPickerOpen;
    local.aiSessionMoreMenuOpen = false;
    local.aiSessionMenuOpen = false;
    refreshRightRailUi();
  });
  document.querySelector("#aiPermissionModeButton")?.addEventListener("click", () => {
    toggleAiPermissionMode();
    local.aiForceScrollBottom = false;
    syncAiPermissionInputs(document);
    refreshRightRailUi();
  });
  document.querySelector("#aiScrollLatest")?.addEventListener("click", () => scrollAiChatToBottom({ smooth: true }));
  document.querySelector("#aiModelSearch")?.addEventListener("input", (event) => {
    local.aiModelSearch = event.currentTarget.value;
    refreshRightRailUi();
    setTimeout(() => {
      const input = document.querySelector("#aiModelSearch");
      input?.focus();
      input?.setSelectionRange?.(input.value.length, input.value.length);
    }, 0);
  });
  document.querySelectorAll("[data-picker-provider]").forEach((button) => {
    button.addEventListener("click", () => useProviderModel(button.dataset.pickerProvider, button.dataset.pickerModel));
  });
  document.querySelectorAll("[data-open-provider-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      local.aiModelPickerOpen = false;
      refreshRightRailUi();
      showProviderDialog({ mode: "key" });
    });
  });
  document.querySelector("[data-close-ai-model-picker]")?.addEventListener("click", () => {
    local.aiModelPickerOpen = false;
    refreshRightRailUi();
  });
  document.querySelectorAll("[data-ai-quick]").forEach((button) => {
    button.addEventListener("click", () => askAiHelper(button.dataset.aiQuick));
  });
  document.querySelector("[data-stop-ai-run]")?.addEventListener("click", stopAiRun);
  document.querySelector("#aiSessionMenuButton")?.addEventListener("click", () => {
    local.aiSessionMenuOpen = !local.aiSessionMenuOpen;
    local.aiSessionMoreMenuOpen = false;
    local.aiSessionActionMenuId = "";
    local.aiModelPickerOpen = false;
    refreshRightRailUi();
    if (local.aiSessionMenuOpen) {
      setTimeout(() => {
        (document.querySelector("#aiSessionSearch") || document.querySelector(".ai-session-row.active .ai-session-row-main") || document.querySelector(".ai-session-row-main"))?.focus();
      }, 0);
    }
  });
  document.querySelector("#aiSessionSearch")?.addEventListener("input", (event) => {
    local.aiSessionSearch = event.currentTarget.value;
    refreshRightRailUi();
    setTimeout(() => {
      const input = document.querySelector("#aiSessionSearch");
      input?.focus();
      input?.setSelectionRange?.(input.value.length, input.value.length);
    }, 0);
  });
  document.querySelector("#aiSessionSearch")?.addEventListener("keydown", (event) => {
    const options = [...document.querySelectorAll(".ai-session-listbox .ai-session-row-main")];
    if (["ArrowDown", "Home"].includes(event.key) && options.length) {
      event.preventDefault();
      options[0].focus();
    } else if (["ArrowUp", "End"].includes(event.key) && options.length) {
      event.preventDefault();
      options.at(-1).focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      local.aiSessionMenuOpen = false;
      refreshRightRailUi();
      setTimeout(() => document.querySelector("#aiSessionMenuButton")?.focus(), 0);
    }
  });
  document.querySelectorAll("[data-edit-queued-ai-prompt]").forEach((button) => {
    button.addEventListener("click", () => editQueuedAiPrompt(button.dataset.editQueuedAiPrompt));
  });
  document.querySelectorAll("[data-delete-queued-ai-prompt]").forEach((button) => {
    button.addEventListener("click", () => deleteQueuedAiPrompt(button.dataset.deleteQueuedAiPrompt));
  });
  document.querySelectorAll("[data-toggle-queued-ai-menu]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.toggleQueuedAiMenu || "";
      local.aiQueuedPromptMenuOpenId = local.aiQueuedPromptMenuOpenId === id ? "" : id;
      local.aiSessionMoreMenuOpen = false;
      local.aiSessionMenuOpen = false;
      refreshRightRailUi();
    });
  });
  document.querySelector("#aiSessionMoreButton")?.addEventListener("click", () => {
    local.aiSessionMoreMenuOpen = !local.aiSessionMoreMenuOpen;
    local.aiQueuedPromptMenuOpenId = "";
    local.aiSessionMenuOpen = false;
    refreshRightRailUi();
  });
  document.querySelector("[data-edit-current-ai-session]")?.addEventListener("click", renameCurrentAiSession);
  document.querySelector("[data-toggle-ai-queueing]")?.addEventListener("click", () => {
    setAiQueueingEnabled(!local.aiQueueingEnabled);
    local.aiSessionMoreMenuOpen = false;
    refreshRightRailUi();
  });
  document.querySelectorAll("[data-ai-session-new], [data-ai-session-retry]").forEach((button) => {
    button.addEventListener("click", startNewAiSession);
  });
  document.querySelectorAll("[data-ai-session]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.target.closest?.("[data-ai-session-actions]")) {
        event.preventDefault();
        toggleAiSessionActions(button.dataset.aiSession);
        return;
      }
      switchAiSession(button.dataset.aiSession);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      toggleAiSessionActions(button.dataset.aiSession);
    });
  });
  document.querySelectorAll("[data-rename-ai-session]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      beginRenameAiSession(button.dataset.renameAiSession);
    });
  });
  document.querySelectorAll("[data-fork-ai-session]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      forkAiSession(button.dataset.forkAiSession);
    });
  });
  document.querySelectorAll("[data-delete-ai-session]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      requestDeleteAiSession(button.dataset.deleteAiSession);
    });
  });
  document.querySelectorAll("[data-stop-session-response]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      stopAiRun(button.dataset.stopSessionResponse);
    });
  });
  document.querySelector("#aiSessionRenameInput")?.addEventListener("input", (event) => {
    local.aiSessionRenameValue = event.currentTarget.value.slice(0, 64);
    local.aiSessionRenameError = "";
  });
  document.querySelector("#aiSessionRenameInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      renameAiSession(local.aiSessionRenamingId, event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelAiSessionRename();
    }
  });
  const sessionListbox = document.querySelector(".ai-session-listbox");
  sessionListbox?.addEventListener("keydown", (event) => {
    const eventMain = event.target.closest?.(".ai-session-row-main");
    if (!eventMain && event.key !== "Escape") return;
    const options = [...sessionListbox.querySelectorAll(".ai-session-row-main")];
    if (!options.length) return;
    const focused = document.activeElement?.closest?.(".ai-session-row-main");
    let index = Math.max(0, options.indexOf(focused));
    if (event.key === "ArrowDown") index = Math.min(options.length - 1, index + 1);
    else if (event.key === "ArrowUp") index = Math.max(0, index - 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = options.length - 1;
    else if (event.key === "Enter" && focused) {
      event.preventDefault();
      focused.click();
      return;
    } else if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && focused) {
      event.preventDefault();
      toggleAiSessionActions(focused.dataset.aiSession);
      return;
    } else if (event.key === "F2" && focused) {
      event.preventDefault();
      beginRenameAiSession(focused.dataset.aiSession);
      return;
    } else if (event.key === "Delete" && focused) {
      event.preventDefault();
      requestDeleteAiSession(focused.dataset.aiSession);
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (local.aiSessionActionMenuId) local.aiSessionActionMenuId = "";
      else local.aiSessionMenuOpen = false;
      refreshRightRailUi();
      setTimeout(() => document.querySelector("#aiSessionMenuButton")?.focus(), 0);
      return;
    } else {
      return;
    }
    event.preventDefault();
    options.forEach((option, optionIndex) => option.tabIndex = optionIndex === index ? 0 : -1);
    options[index]?.focus();
  });
  document.querySelector("[data-cancel-session-delete]")?.addEventListener("click", () => {
    local.aiSessionDeleteId = "";
    refreshRightRailUi();
    setTimeout(() => document.querySelector("#aiSessionMenuButton")?.focus(), 0);
  });
  document.querySelector("[data-confirm-delete]")?.addEventListener("click", (event) => {
    deleteAiSession(event.currentTarget.dataset.confirmDelete);
  });
  const deleteDialog = document.querySelector(".ai-session-delete-backdrop.open .ai-session-delete-dialog");
  deleteDialog?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      local.aiSessionDeleteId = "";
      refreshRightRailUi();
      setTimeout(() => document.querySelector("#aiSessionMenuButton")?.focus(), 0);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...deleteDialog.querySelectorAll("button:not(:disabled)")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.querySelector("#aiPrompt")?.addEventListener("input", (event) => {
    local.aiPrompt = event.currentTarget.value;
    const queued = findQueuedAiPrompt(local.aiEditingQueuedPromptId);
    if (queued) queued.message = local.aiPrompt;
    autoGrowAiPrompt(event.currentTarget);
    updateAiSendButtonState();
  });
  document.querySelector("#aiPrompt")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      askAiHelper();
    }
  });
  document.querySelector("#aiHelperForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    askAiHelper();
  });
  document.querySelectorAll("[data-apply-ai-proposal]").forEach((button) => {
    button.addEventListener("click", () => approveAiProposal(button.dataset.applyAiProposal));
  });
  document.querySelectorAll("[data-reject-ai-proposal]").forEach((button) => {
    button.addEventListener("click", () => rejectAiProposal(button.dataset.rejectAiProposal));
  });
  document.querySelectorAll("[data-explain-ai-proposal]").forEach((button) => {
    button.addEventListener("click", () => explainAiProposal(button.dataset.explainAiProposal));
  });
  document.querySelectorAll("[data-focus-ai-proposal]").forEach((button) => {
    button.addEventListener("click", () => {
      local.rightRailTab = "ai";
      localStorage.setItem("localleaf.rightRailTab", "ai");
      refreshRightRailUi();
    });
  });
  document.querySelectorAll("[data-open-ai-proposal]").forEach((button) => {
    button.addEventListener("click", () => openAiProposalFile(button.dataset.openAiProposal));
  });
  document.querySelectorAll("[data-copy-ai-proposal]").forEach((button) => {
    button.addEventListener("click", () => copyAiProposalDiff(button.dataset.copyAiProposal));
  });
  document.querySelectorAll("[data-view-ai-proposal]").forEach((button) => {
    button.addEventListener("click", () => toggleAiProposalDiff(button.dataset.viewAiProposal));
  });
  document.querySelectorAll("[data-revert-ai-proposal]").forEach((button) => {
    button.addEventListener("click", () => revertAiProposal(button.dataset.revertAiProposal));
  });
  document.querySelectorAll("[data-toggle-ai-run]").forEach((button) => {
    button.addEventListener("click", () => toggleAiRun(button.dataset.toggleAiRun));
  });
  document.querySelectorAll("[data-review-ai-run]").forEach((button) => {
    button.addEventListener("click", () => {
      void reviewAiRun(button.dataset.runGroup || button.dataset.reviewAiRun);
    });
  });
  document.querySelectorAll("[data-undo-ai-run]").forEach((button) => {
    button.addEventListener("click", () => undoAiRun(button.dataset.runGroup || button.dataset.undoAiRun));
  });
  document.querySelectorAll("[data-toggle-ai-change]").forEach((button) => {
    button.addEventListener("click", () => toggleAiChange(button.dataset.toggleAiChange));
  });
  document.querySelectorAll("[data-open-ai-file-link]").forEach((button) => {
    button.addEventListener("click", async () => {
      const proposal = aiHistoryItems().find((item) => item.path === button.dataset.openAiFileLink);
      if (proposal) await openAiProposalFile(proposal.id);
      else {
        const previewScroll = capturePreviewScroll();
        local.selectedFile = button.dataset.openAiFileLink;
        await loadSelectedFile();
        await render();
        restorePreviewScroll(previewScroll);
      }
    });
  });
  autoGrowAiPrompt();
}

function bindChatForm() {
  document.querySelector("#chatForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.querySelector("#chatText");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    await api("/api/chat", { method: "POST", body: { author: local.userName, message } });
  });
}

function hideExportModal() {
  document.querySelector(".modal-backdrop")?.remove();
}

function showExportModal() {
  hideExportModal();
  const projectName = local.appState?.project?.name || "LocalLeaf project";
  const zipName = downloadFileName(projectName, ".zip");
  const pdfName = downloadFileName(projectName, ".pdf");
  const zipUrl = authUrl("/api/export/zip");
  const pdfUrl = authUrl("/api/export/pdf");
  const shell = document.querySelector(".editor-shell") || app;
  shell.insertAdjacentHTML("beforeend", `
    <div class="modal-backdrop" role="presentation">
      <section class="export-modal" role="dialog" aria-modal="true" aria-labelledby="exportTitle">
        <div class="export-modal-head">
          <div>
            <h2 id="exportTitle">Export project</h2>
            <p>${escapeHtml(projectName)}</p>
          </div>
          <button class="icon-button" data-close-export title="Close export dialog" aria-label="Close export dialog">x</button>
        </div>
        <div class="export-options">
          <a class="export-card" href="${zipUrl}" download="${escapeHtml(zipName)}">
            <strong>Source ZIP</strong>
            <span>All project files, folders, images, bibliography, and LaTeX sources.</span>
          </a>
          <button class="export-card export-card-button" type="button" data-export-pdf>
            <strong>Compiled PDF</strong>
            <span>Save, recompile, then download a real PDF file.</span>
          </button>
        </div>
      </section>
    </div>
  `);

  const modal = document.querySelector(".modal-backdrop");
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) hideExportModal();
  });
  modal?.querySelector("[data-close-export]")?.addEventListener("click", hideExportModal);
  modal?.querySelectorAll("a.export-card").forEach((link) => {
    link.addEventListener("click", () => {
      setTimeout(hideExportModal, 250);
    });
  });
  modal?.querySelector("[data-export-pdf]")?.addEventListener("click", async (event) => {
    event.preventDefault();
    const button = event.currentTarget;
    button.disabled = true;
    button.classList.add("is-working");
    button.querySelector("span").textContent = "Compiling before download...";
    try {
      await compile();
      if (local.appState?.compile?.status !== "success") {
        button.disabled = false;
        button.classList.remove("is-working");
        button.querySelector("span").textContent = "Fix compile errors, then try again.";
        return;
      }
      triggerDownload(pdfUrl, pdfName);
      setTimeout(hideExportModal, 250);
    } catch (error) {
      button.disabled = false;
      button.classList.remove("is-working");
      button.querySelector("span").textContent = error.message || "Could not export PDF.";
    }
  });
}

async function selectProjectFile(filePath, options = {}) {
  const item = fileMeta(filePath);
  if (!item || (!isEditableFile(item) && !isImageAsset(item))) return false;
  if (canMutateProject() && !await saveCurrentFile()) return false;
  if (options.isCurrent && !options.isCurrent()) return false;
  const editorContent = isEditableFile(item)
    ? (await api(`/api/file?path=${encodeURIComponent(filePath)}`)).content
    : "";
  if (options.isCurrent && !options.isCurrent()) return false;
  local.selectedFile = filePath;
  local.selectedFolder = "";
  expandToFile(filePath);
  local.saveStatus = canMutateProject() ? "Saved" : "Read only";
  if (isEditableFile(item)) {
    local.editorContent = editorContent;
    local.editorMode = readEditorModeForFile(filePath);
  } else {
    local.editorContent = editorContent;
    local.editorMode = "code";
  }
  updateEditorSourceUi();
  updateSidebarUi();
  if (isEditableFile(item)) {
    sendCollab("open_file", { filePath });
  }
  return true;
}

function editorView() {
  const state = local.appState;
  const file = local.selectedFile || state.project.mainFile || state.project.files.find((item) => item.type === "text" || item.type === "image")?.path || "";
  const compileLogs = state.compile.logs || [];
  syncPinnedCompileIssues(state.compile);
  const selection = selectedFileState(file);
  const isCompiling = local.compileBusy || state.compile.status === "running";
  const canCompile = !isGuestClient();
  const canEditProject = canMutateProject();
  const editorSurface = editorSurfaceMarkup(file, selection.selectedMeta);
  const preview = compiledPreviewMarkup();
  const hostBackButton = isGuestClient() ? "" : `
            <button class="icon-button editor-back-button" id="backToProject" title="Back" aria-label="Back">
              <span class="chevron-left" aria-hidden="true"></span>
            </button>`;

  return `
    <section class="${editorShellClasses()}" style="${editorInlineStyle()}">
      <header class="editor-topbar editor-topbar-v11">
        <div class="editor-primary-row">
          <div class="toolbar-actions">
            ${hostBackButton}
            <button class="icon-button editor-more-button ${local.editorMoreMenuOpen ? "active" : ""}" id="editorMoreButton" title="More editor actions" aria-label="More editor actions" aria-expanded="${local.editorMoreMenuOpen ? "true" : "false"}">
              ${editorToolIcon("menu")}
            </button>
            ${editorMoreMenuMarkup(state)}
            <button class="btn editor-save-button" id="saveButton" ${selection.canEditSelected && canEditProject ? "" : "disabled"} title="${canEditProject ? "Save current file" : "Viewer access is read only"}">
              <span class="save-glyph" aria-hidden="true"></span>
              <span>Save</span>
            </button>
          </div>
          <div class="editor-title-block">
            <h1>${escapeHtml(state.project.name)}</h1>
            <span class="editor-subtitle">Main: ${escapeHtml(state.project.mainFile || "none")} · ${escapeHtml(local.saveStatus)}</span>
          </div>
            <div class="toolbar-actions editor-run-actions">
              <button class="compile-button ${isCompiling ? "compiling" : ""}" id="compileButton" ${isCompiling || !canCompile ? "disabled" : ""} title="${canCompile ? "Compile the current host snapshot" : "Only the host can run the LaTeX compiler"}">
              <span class="compile-spinner"></span>
              <span>${isCompiling ? "Compiling..." : canCompile ? "Recompile" : "Host compiles"}</span>
            </button>
            <button class="btn" id="exportButton" style="height:32px" ${isGuestClient() ? "disabled title=\"Only the host can export this project\"" : ""}>Export</button>
          </div>
        </div>
        ${editorFormatToolbarMarkup()}
        ${editorSearchPanelMarkup()}
        ${tablePickerMarkup()}
      </header>

      <div class="editor-grid">
        <aside class="sidebar">
          <div class="files-panel-head">
            <div class="files-title">
              <strong>Files</strong>
              <span>${selection.textFiles.length} editable</span>
              <button class="icon-button files-hide-button" id="hideFilesPanel" title="Hide files panel" aria-label="Hide files panel">${layoutGlyph("sidebar")}</button>
            </div>
            <div class="file-actions">
              <button class="mini-button file-create-action" id="newFile" title="${canEditProject ? "New file" : "Viewer access is read only"}" aria-label="New file" ${canEditProject ? "" : "disabled"}>${editorToolIcon("newFile")}<span>New file</span></button>
              <button class="mini-button file-create-action" id="newFolder" title="${canEditProject ? "New folder" : "Viewer access is read only"}" aria-label="New folder" ${canEditProject ? "" : "disabled"}>${editorToolIcon("newFolder")}<span>New folder</span></button>
              <button class="mini-button icon-mini-button" id="uploadFile" title="${canEditProject ? "Upload file" : "Viewer access is read only"}" aria-label="Upload file" ${canEditProject ? "" : "disabled"}>${editorToolIcon("upload")}</button>
              <button class="mini-button icon-mini-button" id="renameFile" title="${canEditProject ? "Rename selected item" : "Viewer access is read only"}" aria-label="Rename selected item" ${canEditProject ? "" : "disabled"}>${editorToolIcon("rename")}</button>
              <button class="mini-button icon-mini-button danger-mini" id="deleteFile" title="${canEditProject ? "Delete selected item" : "Viewer access is read only"}" aria-label="Delete selected item" ${canEditProject ? "" : "disabled"}>${editorToolIcon("delete")}</button>
            </div>
          </div>
          <div class="file-search">
            <input id="fileSearch" value="${escapeHtml(local.fileFilter)}" placeholder="Search files" />
          </div>
          <div class="file-list tree-list">
            ${treeCreateDraftMarkup()}
            ${renderProjectTree(state.project.files, file)}
          </div>
          <div class="sidebar-section-resizer" data-sidebar-section-resizer="files" title="Resize files and images"></div>
          <section class="sidebar-images-panel tree-list" aria-label="Images">
            ${renderImageGroup(state.project.files, file)}
          </section>
          <div class="sidebar-section-resizer" data-sidebar-section-resizer="images" title="Resize images and outline"></div>
          <div class="outline ${selection.canEditSelected ? "" : "muted-outline"}">
            <h3>File outline</h3>
            ${selection.canEditSelected ? outlineTreeMarkup(selection.outline, selection.outline.find((item) => item?.title)?.title || "") : `<div class="outline-empty">Open a text file to view outline.</div>`}
          </div>
        </aside>
        <div class="sidebar-resizer" id="sidebarResizer" title="Resize file sidebar"></div>

        <section class="code-panel">
          <div class="pane-head source-head source-breadcrumb-head">
            <nav class="editor-breadcrumb" aria-label="Current file">
              ${editorBreadcrumbMarkup(file, selection)}
            </nav>
            <span class="editor-help">Tree selected</span>
          </div>
          ${editorSurface}
        </section>
        <div class="source-preview-resizer" id="sourcePreviewResizer" title="Resize editor and PDF panes"></div>

        <section class="preview-panel">
          <div class="panel-head">
            <span>Compiled Output</span>
            <div class="preview-actions">
              ${previewActionsMarkup(state.compile)}
            </div>
          </div>
          <div class="preview-scroll" id="previewPane">
            ${isCompiling ? `<div class="compile-overlay"><span class="big-spinner"></span><strong>${escapeHtml(compileBusyLabel())}</strong></div>` : ""}
            ${preview}
          </div>
        </section>

        <div class="right-rail-resizer" id="rightRailResizer" title="Resize chat panel"></div>
        ${rightRailMarkup()}
      </div>

        <footer class="log-dock">
          <div class="log-resizer" id="logResizer" title="Resize logs"></div>
          <div class="log-tabs">
            <button class="active">Compile log</button>
            ${compileLogSummaryMarkup(compileLogs)}
        </div>
        <div class="log-output">
          <div class="log-pinned">${compilePinnedIssuesMarkup()}</div>
            <div class="logs" aria-live="polite">${compileLogsMarkup(compileLogs)}</div>
          </div>
        </footer>
        ${treeContextMenuMarkup()}
      </section>
    `;
  }

async function loadState() {
  local.appState = await api("/api/state");
  syncAiSessionsFromAppState();
  await importLegacyAiSessionsForProject();
  syncAiProposalsFromAppState();
  if (local.hostToken) rememberRecentProject(local.appState.project);
  if (!local.guestToken && !new URLSearchParams(location.search).get("name")) {
    const hostUser = (Array.isArray(local.appState?.session?.users) ? local.appState.session.users : [])
      .find((user) => user.role === "host");
    if (hostUser?.name) local.userName = hostUser.name;
  }
  if (!local.selectedFile) {
    local.selectedFile = local.appState.project.mainFile;
  }
  if (local.selectedFile) {
    expandToFile(local.selectedFile);
    local.editorMode = readEditorModeForFile(local.selectedFile);
  }
}

async function loadSelectedFile() {
  if (!local.appState || !local.selectedFile) return;
  const item = fileMeta(local.selectedFile);
  if (!isEditableFile(item)) {
    local.editorContent = "";
    return;
  }
  const file = await api(`/api/file?path=${encodeURIComponent(local.selectedFile)}`);
  local.editorContent = file.content;
}

function bindCommon() {
  document.querySelector("#goHome")?.addEventListener("click", () => setView("home"));
  document.querySelector("#railCollapse")?.addEventListener("click", () => {
    local.hostRailCollapsed = !local.hostRailCollapsed;
    local.pendingHostRailMotion = local.hostRailCollapsed ? "collapsing" : "expanding";
    localStorage.setItem("localleaf.hostRailCollapsed", local.hostRailCollapsed ? "1" : "0");
    render();
  });
  document.querySelector("#railHome")?.addEventListener("click", () => setView("home"));
  document.querySelector("#railSession")?.addEventListener("click", () => setView("session"));
  document.querySelector("#railRecent")?.addEventListener("click", () => {
    setView("home");
    setTimeout(() => document.querySelector(".home-current-panel")?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth"
    }), 0);
  });
  document.querySelector("#railTemplates")?.addEventListener("click", () => {
    showAppNotice("Templates are coming soon.", { title: "Templates", detail: "The starter project remains available through New Project." });
  });
  document.querySelector("#railModels")?.addEventListener("click", () => showSettingsModal("models"));
  document.querySelector("#railSettings")?.addEventListener("click", () => showSettingsModal());
  document.querySelector("#railHelp")?.addEventListener("click", showHelpModal);
  document.querySelector("#railAbout")?.addEventListener("click", showAboutModal);
  document.querySelector("#goBackHome")?.addEventListener("click", goBackHome);
}

function goBackHome() {
  const previousView = route().view;
  closeCollab();
  local.joinRequestId = null;
  local.guestToken = "";
  sessionStorage.removeItem("localleaf.guestToken");
  local.userName = "Host";
  local.userId = "";
  local.sessionEndedReason = "The host has ended the session.";
  local.sessionEndedDetail = "Ask the host to start it again.";
  history.pushState({}, "", "/");
  local.view = "home";
  local.pendingViewTransition = previousView !== "home"
    ? { from: previousView, to: "home" }
    : null;
  render();
}

function bindHome() {
  document.querySelector("#openCurrentCard")?.addEventListener("click", () => setView("project"));
  document.querySelector("#homeOpenModels")?.addEventListener("click", () => showSettingsModal("models"));
  document.querySelector("#homeBringKey")?.addEventListener("click", () => showProviderDialog({ mode: "key" }));
  document.querySelector("#homeCustomModel")?.addEventListener("click", () => showProviderDialog({ mode: "custom" }));
  document.querySelectorAll("[data-open-recent]").forEach((button) => {
    button.addEventListener("click", () => openRecentProject(button.dataset.openRecent));
  });
  document.querySelector("#newProject")?.addEventListener("click", showNewProjectDialog);
  document.querySelector("#importZip")?.addEventListener("click", () => importZipProject());
  document.querySelector("#importFiles")?.addEventListener("click", openHomeImportPicker);
  document.querySelector("#homeSessionAction")?.addEventListener("click", handleHomeSessionAction);
  document.querySelector("#homeCheckUpdates")?.addEventListener("click", manualCheckForUpdates);
  bindHomeImportTray();
}

async function openRecentProject(projectRoot) {
  if (!projectRoot) return;
  try {
    syncCurrentAiSession();
    local.appState = await api("/api/project/open", { method: "POST", body: { path: projectRoot } });
    syncAiSessionsFromAppState();
    await importLegacyAiSessionsForProject();
    rememberRecentProject(local.appState.project);
    local.selectedFile = local.appState.project.mainFile;
    expandToFile(local.selectedFile);
    await loadSelectedFile();
    setView("project");
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Could not open project" });
  }
}

function newProjectDestinationDirectory() {
  const configuredDirectory = String(local.appState?.project?.defaultProjectsDirectory || "").trim();
  if (configuredDirectory) return configuredDirectory;
  const projectRoot = String(local.appState?.project?.root || "").trim().replace(/[\\/]+$/, "");
  if (!projectRoot) return "";
  const separatorIndex = Math.max(projectRoot.lastIndexOf("\\"), projectRoot.lastIndexOf("/"));
  if (separatorIndex < 0) return "";
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(projectRoot)) return `${projectRoot.slice(0, 2)}\\`;
  if (separatorIndex === 0) return projectRoot.slice(0, 1);
  return projectRoot.slice(0, separatorIndex);
}

function hideNewProjectDialog(options = {}) {
  removeModal(document.querySelector(".new-project-backdrop"), {
    fallbackFocusSelector: "#newProject",
    ...options
  });
}

function setNewProjectDialogState(modal, options = {}) {
  if (!modal) return;
  const busy = Boolean(options.busy);
  const form = modal.querySelector("#newProjectForm");
  const createButton = modal.querySelector("#createNewProject");
  const cancelButton = modal.querySelector("#cancelNewProject");
  const status = modal.querySelector("#newProjectStatus");
  modal.dataset.busy = busy ? "true" : "false";
  form?.setAttribute("aria-busy", busy ? "true" : "false");
  form?.querySelectorAll("input, button").forEach((control) => {
    control.disabled = busy;
  });
  if (cancelButton) cancelButton.disabled = busy;
  if (createButton) {
    createButton.textContent = busy ? "Creating..." : "Create project";
  }
  if (status) {
    status.textContent = options.message || (busy ? "Creating the project and starter files..." : "");
    status.classList.toggle("is-error", options.type === "error");
  }
}

function showNewProjectDialog() {
  const existingModal = document.querySelector(".new-project-backdrop");
  const returnFocus = existingModal?._localleafReturnFocus || document.activeElement;
  removeModal(existingModal, { restoreFocus: false });
  const defaultDestination = newProjectDestinationDirectory();
  const creationRequestId = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `new-project-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  document.body.insertAdjacentHTML("beforeend", `
    <div class="new-project-backdrop" role="presentation">
      <section class="new-project-modal" role="dialog" aria-modal="true" aria-labelledby="newProjectTitle" aria-describedby="newProjectDescription">
        <header class="new-project-modal-head">
          <div>
            <h2 id="newProjectTitle">Create a new project</h2>
            <p id="newProjectDescription">Choose a name and where LocalLeaf should create the project folder.</p>
          </div>
        </header>
        <form class="new-project-form" id="newProjectForm" novalidate>
          <label class="new-project-field" for="newProjectName">
            <span>Project name</span>
            <input id="newProjectName" name="projectName" type="text" value="LocalLeaf Project" maxlength="70" autocomplete="off" spellcheck="false" required aria-describedby="newProjectNameHint">
            <small id="newProjectNameHint">This becomes the folder name and project title.</small>
          </label>
          <div class="new-project-field">
            <label for="newProjectDestination">Destination folder</label>
            <div class="new-project-destination-row">
              <input id="newProjectDestination" name="destinationDirectory" type="text" value="${escapeHtml(defaultDestination)}" autocomplete="off" spellcheck="false" required aria-describedby="newProjectDestinationHint">
              <button class="btn" id="browseNewProjectDestination" type="button">${uiGlyph("folder")} Browse</button>
            </div>
            <small id="newProjectDestinationHint">LocalLeaf creates the named project folder inside this location. You can paste or edit the path directly.</small>
          </div>
          <p class="new-project-status" id="newProjectStatus" role="status" aria-live="polite"></p>
          <div class="new-project-actions">
            <button class="btn" id="cancelNewProject" type="button">Cancel</button>
            <button class="btn btn-primary" id="createNewProject" type="submit">Create project</button>
          </div>
        </form>
      </section>
    </div>
  `);

  const modal = document.querySelector(".new-project-backdrop");
  const form = modal?.querySelector("#newProjectForm");
  const nameInput = modal?.querySelector("#newProjectName");
  const destinationInput = modal?.querySelector("#newProjectDestination");
  const close = () => {
    if (modal?.dataset.busy === "true") return;
    hideNewProjectDialog();
  };
  installModalFocusManagement(modal, returnFocus);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  });
  modal?.querySelector("#cancelNewProject")?.addEventListener("click", close);
  modal?.querySelector("#browseNewProjectDestination")?.addEventListener("click", async () => {
    if (typeof window.localleafDesktop?.chooseProjectFolder !== "function") {
      setNewProjectDialogState(modal, {
        message: "Folder browsing is available in the desktop app. You can still enter the destination path above."
      });
      destinationInput?.focus();
      return;
    }
    const browseButton = modal.querySelector("#browseNewProjectDestination");
    browseButton.disabled = true;
    browseButton.setAttribute("aria-busy", "true");
    try {
      const result = await window.localleafDesktop.chooseProjectFolder(destinationInput?.value || "");
      if (!result?.canceled && result?.folderPath && destinationInput) {
        destinationInput.value = result.folderPath;
        setNewProjectDialogState(modal);
        destinationInput.focus();
      }
    } catch (error) {
      setNewProjectDialogState(modal, {
        type: "error",
        message: error?.message || "LocalLeaf could not open the folder picker. Enter the path directly instead."
      });
      destinationInput?.focus();
    } finally {
      browseButton.disabled = false;
      browseButton.setAttribute("aria-busy", "false");
    }
  });
  [nameInput, destinationInput].forEach((input) => {
    input?.addEventListener("input", () => {
      input.setCustomValidity("");
      input.removeAttribute("aria-invalid");
      const status = modal?.querySelector("#newProjectStatus");
      if (status?.classList.contains("is-error")) setNewProjectDialogState(modal);
    });
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const projectName = nameInput?.value.trim() || "";
    const destinationDirectory = destinationInput?.value.trim() || "";
    if (!projectName) {
      nameInput?.setCustomValidity("Enter a project name.");
      nameInput?.reportValidity();
      nameInput?.focus();
      return;
    }
    if (!destinationDirectory) {
      destinationInput?.setCustomValidity("Choose or enter a destination folder.");
      destinationInput?.reportValidity();
      destinationInput?.focus();
      return;
    }
    setNewProjectDialogState(modal, { busy: true });
    await createNewProject({ projectName, destinationDirectory, requestId: creationRequestId }, modal);
  });
  window.setTimeout(() => {
    nameInput?.focus({ preventScroll: true });
    nameInput?.select();
  }, 0);
}

async function createNewProject({ projectName, destinationDirectory, requestId }, modal) {
  let createdState;
  try {
    syncCurrentAiSession();
    createdState = await api("/api/project/new", {
      method: "POST",
      body: { projectName, destinationDirectory, requestId },
      timeoutMs: 20000
    });
  } catch (error) {
    setNewProjectDialogState(modal, {
      type: "error",
      message: error?.message || "LocalLeaf could not create this project."
    });
    const fieldId = error?.field === "destinationDirectory" ? "#newProjectDestination" : "#newProjectName";
    const field = modal?.querySelector(fieldId);
    field?.setAttribute("aria-invalid", "true");
    field?.focus();
    return false;
  }

  local.appState = createdState;
  rememberRecentProject(local.appState.project);
  local.selectedFile = local.appState.project.mainFile;
  expandToFile(local.selectedFile);
  local.saveStatus = "New project";
  removeModal(modal, { restoreFocus: false });
  try {
    syncAiSessionsFromAppState();
    await importLegacyAiSessionsForProject();
    await loadSelectedFile();
  } catch (error) {
    showAppNotice("The project was created, but LocalLeaf could not finish loading its editor state yet.", {
      type: "warning",
      title: "Project created",
      detail: error?.message || "Open the editor again to retry loading the starter file."
    });
  }
  setView("project");
  return true;
}

async function handleHomeSessionAction() {
  if (local.appState.session.status === "live") {
    setView("session");
    return;
  }
  await startSession();
}

async function openProjectPrompt() {
  const input = prompt("Enter a project folder path:", local.appState.project.root);
  if (!input) return;
  try {
    syncCurrentAiSession();
    local.appState = await api("/api/project/open", { method: "POST", body: { path: input } });
    syncAiSessionsFromAppState();
    await importLegacyAiSessionsForProject();
    rememberRecentProject(local.appState.project);
    local.selectedFile = local.appState.project.mainFile;
    expandToFile(local.selectedFile);
    await loadSelectedFile();
    setView("project");
  } catch (error) {
    alert(error.message);
  }
}

function bindHomeImportTray() {
  document.querySelector("#openHomeImport")?.addEventListener("click", importStagedHomeFiles);
  document.querySelector("#clearHomeImport")?.addEventListener("click", () => {
    local.homeImportFiles = [];
    local.homeImportStatus = "";
    render();
  });

  const dropZone = document.querySelector("#homeImportDropZone");
  if (!dropZone) return;
  const setDragActive = (active) => {
    local.homeImportDragActive = active;
    dropZone.classList.toggle("drag-active", active);
  };
  dropZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    setDragActive(true);
  });
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  });
  dropZone.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && dropZone.contains(event.relatedTarget)) return;
    setDragActive(false);
  });
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    setDragActive(false);
    setHomeImportFiles(event.dataTransfer.files);
  });
}

function openHomeImportPicker() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".zip,.tex,.latex,.bib,.bst,.cls,.sty,.clo,.cfg,.def,.ldf,.bbx,.cbx,.bbl,.txt,.md,.tikz,.csv,.dat,.json,.asy,.py,.png,.jpg,.jpeg,.gif,.webp,.svg,.pdf,.eps";
  input.addEventListener("change", () => setHomeImportFiles(input.files));
  input.click();
}

function setHomeImportFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => file?.name);
  const unsupported = unsupportedProjectFiles(files);
  local.homeImportFiles = files;
  local.homeImportStatus = files.length
    ? unsupported.length
      ? unsupportedFilesMessage(unsupported)
      : ""
    : "No files were selected.";
  local.homeImportDragActive = false;
  render();
  if (unsupported.length) {
    showImportError(
      unsupportedFilesMessage(unsupported),
      "LocalLeaf supports LaTeX source/support files, bibliography/data files, and image/PDF assets."
    );
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function importStagedHomeFiles() {
  const files = local.homeImportFiles || [];
  if (!files.length || local.homeImportBusy) return;
  const zipFiles = files.filter(isZipImportFile);
  if (zipFiles.length && files.length > 1) {
    showImportError("Select a ZIP by itself, or choose loose project files without a ZIP.");
    render();
    return;
  }
  const unsupported = unsupportedProjectFiles(files);
  if (unsupported.length) {
    showImportError(
      unsupportedFilesMessage(unsupported),
      "Remove unsupported files, then try the import again."
    );
    render();
    return;
  }
  if (!zipFiles.length && !files.some((file) => /\.tex$/i.test(stagedImportPath(file)))) {
    showImportError(
      "Imported files must include at least one .tex file.",
      "Add the main LaTeX source file, then import the group again."
    );
    render();
    return;
  }

  local.homeImportBusy = true;
  local.homeImportStatus = "Preparing import...";
  render();

  try {
    if (zipFiles.length === 1) {
      await importZipFile(zipFiles[0]);
      return;
    }

    const payloadFiles = [];
    for (const file of files) {
      if (!isReadableImportFile(file)) {
        throw new Error(`Could not read ${file?.name || "one selected file"}. Please choose it again.`);
      }
      const buffer = await readImportFileBuffer(file);
      payloadFiles.push({
        path: stagedImportPath(file),
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        contentBase64: arrayBufferToBase64(buffer)
      });
    }

    const mainCandidate = files.find((file) => /\.tex$/i.test(file.name)) || files[0];
    local.appState = await api("/api/project/import-files", {
      method: "POST",
      rawBody: JSON.stringify({
        projectName: mainCandidate?.name || "Imported Files",
        files: payloadFiles
      })
    });
    syncAiSessionsFromAppState();
    await importLegacyAiSessionsForProject();
    rememberRecentProject(local.appState.project);
    local.selectedFile = local.appState.project.mainFile;
    expandToFile(local.selectedFile);
    await loadSelectedFile();
    local.homeImportFiles = [];
    local.homeImportStatus = "";
    local.saveStatus = "Imported files";
    setView("project");
  } catch (error) {
    showImportError(error.message);
    render();
  } finally {
    local.homeImportBusy = false;
    if (route().view === "home") render();
  }
}

function bindProject() {
  const openEditor = async () => {
    await loadSelectedFile();
    setView("editor");
  };
  document.querySelector("#openEditor")?.addEventListener("click", openEditor);
  document.querySelector("#importZipProject")?.addEventListener("click", () => importZipProject());
  document.querySelector("#hostOnline")?.addEventListener("click", startSession);
  document.querySelector("#backProject")?.addEventListener("click", () => setView("project"));
}

async function importZipProject(fileOverride = null) {
  if (isReadableImportFile(fileOverride)) {
    await importZipFile(fileOverride);
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    await importZipFile(file);
  });
  input.click();
}

async function importZipFile(file) {
  try {
    if (!isReadableImportFile(file)) {
      throw new Error("Choose a ZIP file to import.");
    }
    if (!isZipImportFile(file)) {
      throw new Error("LocalLeaf can only import .zip project archives from this button.");
    }
    const buffer = await readImportFileBuffer(file);
    local.appState = await api("/api/project/import-zip", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-file-name": file.name
      },
      rawBody: buffer
    });
    syncAiSessionsFromAppState();
    await importLegacyAiSessionsForProject();
    rememberRecentProject(local.appState.project);
    local.selectedFile = local.appState.project.mainFile;
    expandToFile(local.selectedFile);
    await loadSelectedFile();
    local.homeImportFiles = [];
    local.homeImportStatus = "";
    local.saveStatus = "Imported";
    setView("project");
  } catch (error) {
    if (route().view === "home") {
      showImportError(error.message, isZipImportFile(file) ? "Make sure the archive contains at least one .tex file." : "");
      render();
      return;
    }
    showImportError(error.message, isZipImportFile(file) ? "Make sure the archive contains at least one .tex file." : "");
  }
}

async function startSession() {
  if (local.sessionStartBusy) return;
  local.sessionStartBusy = true;
  if (["session", "active"].includes(route().view)) render();
  try {
    local.appState = await api("/api/session/start", {
      method: "POST",
      body: { providerId: sessionTunnelProviderId() || null }
    });
    await loadSelectedFile();
    if (route().view === "session") render();
    else setView("session");
  } catch (error) {
    showAppNotice(error.message || "LocalLeaf could not start the sharing session.", {
      type: "error",
      title: "Session did not start",
      detail: "Choose another invite-link provider or try again."
    });
  } finally {
    local.sessionStartBusy = false;
    if (["session", "active"].includes(route().view)) render();
  }
}

async function requestAnotherTunnelProvider() {
  if (local.tunnelProviderSwitchBusy) return;
  const session = local.appState?.session;
  const providerId = sessionTunnelProviderId(session);

  local.tunnelProviderSwitchBusy = true;
  render();
  try {
    const result = await api("/api/session/tunnel/restart", {
      method: "POST",
      body: { providerId: providerId || null }
    });
    if (result?.project && result?.session) {
      local.appState = result;
    } else if (result?.session) {
      local.appState.session = result.session;
    } else {
      await loadState();
    }
    if (local.appState?.session?.tunnel?.previousLinkInvalidated) {
      showAppNotice("The previous invite link is no longer active.", {
        type: "warning",
        title: "Refreshing invite link",
        detail: "Wait for the selected provider to verify, then share the new link.",
        timeoutMs: 5200
      });
    } else {
      showAppNotice("LocalLeaf is creating and verifying an invite link.", {
        title: "Refreshing invite link",
        detail: "Share it only after the session screen marks it as verified.",
        timeoutMs: 4200
      });
    }
  } catch (error) {
    showAppNotice(error.message || "LocalLeaf could not refresh the invite link.", {
      type: "error",
      title: "Link refresh failed",
      detail: "Check the status on this screen before sharing any link."
    });
  } finally {
    local.tunnelProviderSwitchBusy = false;
    if (["session", "active"].includes(route().view)) render();
  }
}

function bindSessionTunnelProviderPicker() {
  local.sessionProviderMenuAbortController?.abort();
  local.sessionProviderMenuAbortController = null;

  const picker = document.querySelector("[data-session-provider-picker]");
  const trigger = picker?.querySelector("#sessionTunnelProvider");
  const menu = picker?.querySelector("#sessionTunnelProviderMenu");
  if (!picker || !trigger || !menu) return;

  const options = () => [...menu.querySelectorAll("[data-session-tunnel-provider-option]")];
  const setOpen = (open, { focusOption = false, restoreTrigger = false } = {}) => {
    const nextOpen = Boolean(open && !trigger.disabled);
    picker.classList.toggle("open", nextOpen);
    trigger.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    menu.setAttribute("aria-hidden", nextOpen ? "false" : "true");
    menu.inert = !nextOpen;
    if (nextOpen && focusOption) {
      const choices = options();
      (choices.find((option) => option.getAttribute("aria-selected") === "true") || choices[0])?.focus();
    } else if (!nextOpen && restoreTrigger) {
      trigger.focus({ preventScroll: true });
    }
  };
  const chooseProvider = (providerId) => {
    const normalized = String(providerId || "");
    if (normalized && !availableTunnelProviders().some((provider) => provider.id === normalized)) return;
    local.sessionTunnelProviderOverrideId = normalized;
    const selectedProvider = availableTunnelProviders().find((provider) => provider.id === normalized) || null;
    const value = trigger.querySelector("#sessionTunnelProviderValue");
    const meta = trigger.querySelector(".session-provider-trigger-copy small");
    const hint = picker.parentElement?.querySelector(".session-provider-hint");
    if (value) value.textContent = selectedProvider?.name || "Automatic";
    if (meta) meta.textContent = selectedProvider ? "Session choice" : "Recommended";
    if (hint) hint.textContent = sessionTunnelProviderHint(local.appState?.session, normalized);
    options().forEach((option) => {
      const selected = String(option.dataset.sessionTunnelProviderOption || "") === normalized;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", selected ? "true" : "false");
    });
    setOpen(false, { restoreTrigger: true });
  };

  trigger.addEventListener("click", () => {
    setOpen(trigger.getAttribute("aria-expanded") !== "true");
  });
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setOpen(false, { restoreTrigger: true });
      return;
    }
    setOpen(true);
    const choices = options();
    const selectedIndex = Math.max(0, choices.findIndex((option) => option.getAttribute("aria-selected") === "true"));
    const targetIndex = event.key === "ArrowUp" || event.key === "End"
      ? choices.length - 1
      : event.key === "Home"
        ? 0
        : selectedIndex;
    choices[targetIndex]?.focus();
  });
  options().forEach((option, optionIndex, choices) => {
    option.addEventListener("click", () => chooseProvider(option.dataset.sessionTunnelProviderOption));
    option.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        chooseProvider(option.dataset.sessionTunnelProviderOption);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false, { restoreTrigger: true });
        return;
      }
      if (event.key === "Tab") {
        setOpen(false);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? choices.length - 1
          : (optionIndex + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      choices[nextIndex]?.focus();
    });
  });

  const controller = new AbortController();
  local.sessionProviderMenuAbortController = controller;
  document.addEventListener("pointerdown", (event) => {
    if (!picker.contains(event.target)) setOpen(false);
  }, { signal: controller.signal });
  picker.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (!picker.isConnected || !picker.contains(document.activeElement)) setOpen(false);
    }, 0);
  });
}

function refreshSessionGuestManagerUi() {
  const current = document.querySelector("#sessionGuestManager");
  if (!current || !local.appState?.session) return;
  current.outerHTML = sessionGuestManagerMarkup(local.appState.session);
  bindSessionGuestManager();
}

function updateSessionGuestInState(nextUser) {
  if (!nextUser?.id || !Array.isArray(local.appState?.session?.users)) return;
  const existing = local.appState.session.users.findIndex((user) => user.id === nextUser.id);
  if (existing >= 0) local.appState.session.users.splice(existing, 1, { ...local.appState.session.users[existing], ...nextUser });
  else local.appState.session.users.push(nextUser);
}

function setSessionGuestRowState(key, options = {}) {
  if (options.busy === true) local.sessionGuestBusy[key] = true;
  else if (options.busy === false) delete local.sessionGuestBusy[key];
  if (options.error !== undefined) {
    if (options.error) local.sessionGuestErrors[key] = String(options.error);
    else delete local.sessionGuestErrors[key];
  }
  if (options.status !== undefined) local.sessionGuestStatus = String(options.status || "");
  refreshSessionGuestManagerUi();
}

async function approveSessionGuest(requestId) {
  const key = `pending:${requestId}`;
  const role = sessionGuestRoleValue("pending", requestId, "viewer");
  const request = local.appState?.session?.joinRequests?.find((item) => item.id === requestId);
  setSessionGuestRowState(key, { busy: true, error: "", status: "" });
  try {
    const result = await api("/api/join/approve", { method: "POST", body: { requestId, role } });
    if (request) request.status = "approved";
    updateSessionGuestInState(result.user);
    delete local.sessionGuestRoles[key];
    setSessionGuestRowState(key, {
      busy: false,
      error: "",
      status: `${request?.name || result.user?.name || "Guest"} joined as ${role === "maintainer" ? "Maintainer" : "Viewer"}.`
    });
  } catch (error) {
    setSessionGuestRowState(key, { busy: false, error: error.message || "LocalLeaf could not approve this request." });
  }
}

async function declineSessionGuest(requestId) {
  const key = `pending:${requestId}`;
  const request = local.appState?.session?.joinRequests?.find((item) => item.id === requestId);
  setSessionGuestRowState(key, { busy: true, error: "", status: "" });
  try {
    await api("/api/join/deny", { method: "POST", body: { requestId } });
    if (request) request.status = "denied";
    delete local.sessionGuestRoles[key];
    setSessionGuestRowState(key, {
      busy: false,
      error: "",
      status: `${request?.name || "Guest"}'s request was declined.`
    });
  } catch (error) {
    setSessionGuestRowState(key, { busy: false, error: error.message || "LocalLeaf could not decline this request." });
  }
}

async function changeSessionGuestRole(userId, role, options = {}) {
  const key = `guest:${userId}`;
  const user = local.appState?.session?.users?.find((item) => item.id === userId);
  if (!user || user.role === role) return;
  setSessionGuestRowState(key, { busy: true, error: "", status: "" });
  try {
    const result = await api("/api/session/guest/role", { method: "POST", body: { userId, role } });
    updateSessionGuestInState(result.user);
    setSessionGuestRowState(key, {
      busy: false,
      error: "",
      status: `${user.name}'s role is now ${role === "maintainer" ? "Maintainer" : "Viewer"}.`
    });
  } catch (error) {
    setSessionGuestRowState(key, { busy: false, error: error.message || "LocalLeaf could not change this role." });
  }
  if (options.restoreFocus) {
    window.setTimeout(() => {
      document.querySelector(`[data-session-role-picker][data-role-context="guest"][data-role-id="${CSS.escape(userId)}"] .session-role-trigger`)?.focus({ preventScroll: true });
    }, 0);
  }
}

function bindSessionRolePickers() {
  local.sessionGuestMenuAbortController?.abort();
  const controller = new AbortController();
  const { signal } = controller;
  const pickers = [...document.querySelectorAll("[data-session-role-picker]")];
  const closePicker = (picker, options = {}) => {
    const trigger = picker.querySelector(".session-role-trigger");
    const menu = picker.querySelector(".session-role-menu");
    picker.classList.remove("is-open");
    trigger?.setAttribute("aria-expanded", "false");
    menu?.setAttribute("aria-hidden", "true");
    if (menu) menu.inert = true;
    if (options.restoreFocus) trigger?.focus({ preventScroll: true });
  };
  const openPicker = (picker, focus = "selected") => {
    pickers.forEach((item) => {
      if (item !== picker) closePicker(item);
    });
    const trigger = picker.querySelector(".session-role-trigger");
    const menu = picker.querySelector(".session-role-menu");
    picker.classList.add("is-open");
    trigger?.setAttribute("aria-expanded", "true");
    menu?.setAttribute("aria-hidden", "false");
    if (menu) menu.inert = false;
    const options = [...(menu?.querySelectorAll('[role="option"]:not(:disabled)') || [])];
    const target = focus === "last"
      ? options.at(-1)
      : focus === "first"
        ? options[0]
        : options.find((item) => item.getAttribute("aria-selected") === "true") || options[0];
    target?.focus({ preventScroll: true });
  };

  pickers.forEach((picker) => {
    const trigger = picker.querySelector(".session-role-trigger");
    const menu = picker.querySelector(".session-role-menu");
    const options = [...(menu?.querySelectorAll('[role="option"]') || [])];
    trigger?.addEventListener("click", () => {
      if (picker.classList.contains("is-open")) closePicker(picker, { restoreFocus: true });
      else openPicker(picker);
    }, { signal });
    trigger?.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Escape") closePicker(picker, { restoreFocus: true });
      else openPicker(picker, ["ArrowUp", "End"].includes(event.key) ? "last" : "first");
    }, { signal });
    menu?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker(picker, { restoreFocus: true });
        return;
      }
      if (event.key === "Tab") {
        window.setTimeout(() => {
          if (picker.isConnected && !picker.contains(document.activeElement)) closePicker(picker);
        }, 0);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = Math.max(0, options.indexOf(document.activeElement));
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[nextIndex]?.focus({ preventScroll: true });
    }, { signal });
    options.forEach((option) => {
      option.addEventListener("click", () => {
        const role = option.dataset.sessionRoleOption === "maintainer" ? "maintainer" : "viewer";
        const context = picker.dataset.roleContext || "pending";
        const id = picker.dataset.roleId || "";
        if (context === "pending") {
          local.sessionGuestRoles[`pending:${id}`] = role;
          picker.dataset.roleValue = role;
          trigger.querySelector("span:first-child").textContent = role === "maintainer" ? "Maintainer" : "Viewer";
          trigger.setAttribute("aria-label", `${trigger.getAttribute("aria-label")?.split(":")[0] || "Guest role"}: ${role === "maintainer" ? "Maintainer" : "Viewer"}`);
          options.forEach((item) => {
            const selected = item.dataset.sessionRoleOption === role;
            item.setAttribute("aria-selected", selected ? "true" : "false");
            const check = item.querySelector(".session-role-check");
            if (check) check.textContent = selected ? String.fromCharCode(10003) : "";
          });
          closePicker(picker, { restoreFocus: true });
          return;
        }
        closePicker(picker, { restoreFocus: true });
        void changeSessionGuestRole(id, role, { restoreFocus: true });
      }, { signal });
    });
  });

  document.addEventListener("pointerdown", (event) => {
    pickers.forEach((picker) => {
      if (picker.classList.contains("is-open") && !picker.contains(event.target)) closePicker(picker);
    });
  }, { signal });
  local.sessionGuestMenuAbortController = controller;
}

function setGuestRemoveDialogBusy(modal, busy, message = "", type = "status") {
  if (!modal) return;
  modal.dataset.busy = busy ? "true" : "false";
  const cancel = modal.querySelector("[data-cancel-guest-remove]");
  const confirm = modal.querySelector("[data-confirm-guest-remove]");
  if (cancel) cancel.disabled = busy;
  if (confirm) {
    confirm.disabled = busy;
    confirm.textContent = busy ? "Removing..." : "Remove access";
  }
  const status = modal.querySelector(".guest-remove-status");
  if (status) {
    status.hidden = !message;
    status.textContent = message;
    status.setAttribute("role", type === "error" ? "alert" : "status");
  }
}

function showGuestRemoveDialog(userId, returnFocus = document.activeElement) {
  const user = local.appState?.session?.users?.find((item) => item.id === userId && item.role !== "host");
  if (!user) return;
  document.querySelector(".guest-remove-backdrop")?.remove();
  document.body.insertAdjacentHTML("beforeend", `
    <div class="guest-remove-backdrop" role="presentation" data-busy="false">
      <section class="guest-remove-dialog" role="alertdialog" aria-modal="true" aria-labelledby="guestRemoveTitle" aria-describedby="guestRemoveDescription">
        <div>
          <p class="guest-remove-eyebrow">Guest access</p>
          <h2 id="guestRemoveTitle">Remove ${escapeHtml(user.name)}?</h2>
          <p id="guestRemoveDescription">They will leave this session immediately. Their invite token will stop working.</p>
        </div>
        <p class="guest-remove-status" role="status" aria-live="polite" hidden></p>
        <div class="guest-remove-actions">
          <button class="btn" type="button" data-cancel-guest-remove>Cancel</button>
          <button class="btn btn-danger" type="button" data-confirm-guest-remove>Remove access</button>
        </div>
      </section>
    </div>
  `);
  const modal = document.querySelector(".guest-remove-backdrop");
  installModalFocusManagement(modal, returnFocus);
  const close = () => {
    if (modal?.dataset.busy === "true") return;
    removeModal(modal, { fallbackFocusSelector: `[data-session-guest-remove="${CSS.escape(userId)}"]` });
  };
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  });
  modal?.querySelector("[data-cancel-guest-remove]")?.addEventListener("click", close);
  modal?.querySelector("[data-confirm-guest-remove]")?.addEventListener("click", async () => {
    const key = `guest:${userId}`;
    setGuestRemoveDialogBusy(modal, true, "Removing access...");
    local.sessionGuestBusy[key] = true;
    delete local.sessionGuestErrors[key];
    refreshSessionGuestManagerUi();
    try {
      await api("/api/session/guest/remove", { method: "POST", body: { userId } });
      local.appState.session.users = local.appState.session.users.filter((item) => item.id !== userId);
      delete local.sessionGuestBusy[key];
      delete local.sessionGuestErrors[key];
      local.sessionGuestStatus = `${user.name}'s access was removed.`;
      removeModal(modal, { restoreFocus: false });
      refreshSessionGuestManagerUi();
      window.setTimeout(() => document.querySelector("#sessionGuestsHeading")?.focus({ preventScroll: true }), 0);
    } catch (error) {
      delete local.sessionGuestBusy[key];
      local.sessionGuestErrors[key] = error.message || "LocalLeaf could not remove this guest.";
      setGuestRemoveDialogBusy(modal, false, local.sessionGuestErrors[key], "error");
      refreshSessionGuestManagerUi();
      modal?.querySelector("[data-confirm-guest-remove]")?.focus({ preventScroll: true });
    }
  });
  window.setTimeout(() => modal?.querySelector("[data-cancel-guest-remove]")?.focus({ preventScroll: true }), 0);
}

function bindSessionGuestManager() {
  if (!document.querySelector("#sessionGuestManager")) return;
  bindSessionRolePickers();
  document.querySelectorAll("[data-session-guest-approve]").forEach((button) => {
    button.addEventListener("click", () => void approveSessionGuest(button.dataset.sessionGuestApprove));
  });
  document.querySelectorAll("[data-session-guest-decline]").forEach((button) => {
    button.addEventListener("click", () => void declineSessionGuest(button.dataset.sessionGuestDecline));
  });
  document.querySelectorAll("[data-session-guest-remove]").forEach((button) => {
    button.addEventListener("click", () => showGuestRemoveDialog(button.dataset.sessionGuestRemove, button));
  });
}

function focusSessionGuestManager() {
  if (!local.sessionGuestFocusPending) return;
  local.sessionGuestFocusPending = false;
  window.requestAnimationFrame(() => {
    const heading = document.querySelector("#sessionGuestsHeading");
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({
      block: "center",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth"
    });
  });
}

function bindSession() {
  bindSessionTunnelProviderPicker();
  bindSessionGuestManager();
  document.querySelector("#copyInvite")?.addEventListener("click", (event) => copyInvite(event.currentTarget));
  document.querySelectorAll("[data-start-session]").forEach((button) => {
    button.addEventListener("click", startSession);
  });
  document.querySelector("#refreshInviteLink")?.addEventListener("click", requestAnotherTunnelProvider);
  document.querySelector("#openEditorFromSession")?.addEventListener("click", async () => {
    await loadSelectedFile();
    setView("editor");
  });
  document.querySelector("#stopSession")?.addEventListener("click", stopSession);
  document.querySelector("#backHome")?.addEventListener("click", () => setView("home"));
  document.querySelector("#goSession")?.addEventListener("click", () => setView("session"));
  focusSessionGuestManager();
}

function markEditorChanged(source) {
  if (local.applyingRemoteEdit) return;
  if (!canMutateProject()) return;
  local.editorContent = typeof source === "string" ? source : source?.value || "";
  local.saveStatus = "Unsaved";
  const status = document.querySelector(".editor-subtitle");
  if (status) status.textContent = local.saveStatus;
  const sentThroughCollab = sendCollab("edit", { filePath: local.selectedFile, newText: local.editorContent });
  clearTimeout(local.saveTimer);
  local.saveTimer = setTimeout(async () => {
    if (sentThroughCollab) {
      const saved = await requestCollabSave(local.selectedFile, local.editorContent);
      if (!saved) {
        local.saveStatus = "Reconnecting...";
        const status = document.querySelector(".editor-subtitle");
        if (status) status.textContent = local.saveStatus;
      }
      return;
    }
    saveCurrentFile();
  }, 450);
}

async function refreshEditorSuggestions() {
  if (!local.appState) return;
  try {
    local.editorSuggestions = await api("/api/editor/suggestions");
    local.codeEditor?.setSuggestions(local.editorSuggestions);
    document.querySelectorAll(".visual-raw-code-mount").forEach((mount) => {
      mount.__localLeafEditor?.setSuggestions(local.editorSuggestions);
    });
  } catch {
    local.editorSuggestions = local.editorSuggestions || {};
  }
}

function currentEditorText() {
  if (local.codeEditor) return local.codeEditor.getText();
  if (local.visualEditor) return local.visualEditor.getText();
  return local.editorContent;
}

function prepareEditorForPersistence() {
  local.visualEditor?.flushTransientSourceBlocks?.({ includeActive: true, focusEmpty: false });
}

function canDropTreeItem(sourcePath, targetFolder) {
  if (!sourcePath) return false;
  const source = treeItem(sourcePath);
  const target = targetFolder ? treeItem(targetFolder) : null;
  if (!source) return false;
  if (targetFolder && target?.type !== "directory") return false;
  if (source.path === targetFolder) return false;
  if (source.type === "directory" && targetFolder.startsWith(`${source.path}/`)) return false;
  const nextPath = joinProjectPath(targetFolder, pathBasename(source.path));
  if (projectPathExists(nextPath, source.path)) return false;
  return pathDirname(source.path) !== targetFolder;
}

function pathAfterDirectoryMove(pathValue, from, to) {
  if (pathValue === from) return to;
  if (pathValue?.startsWith(`${from}/`)) return `${to}${pathValue.slice(from.length)}`;
  return pathValue;
}

async function moveTreeItemToFolder(sourcePath, targetFolder) {
  if (!requireProjectMutationAccess("move project items")) return;
  if (!canDropTreeItem(sourcePath, targetFolder)) return;
  const source = treeItem(sourcePath);
  const nextPath = joinProjectPath(targetFolder, pathBasename(source.path));
  try {
    const result = await api("/api/file/rename", {
      method: "POST",
      body: {
        from: source.path,
        to: nextPath
      }
    });
    const movedPath = result.path;
    const selectedFileWasInside = local.selectedFile === source.path || local.selectedFile?.startsWith(`${source.path}/`);
    const selectedFolderWasInside = local.selectedFolder === source.path || local.selectedFolder?.startsWith(`${source.path}/`);
    await loadState();
    if (selectedFileWasInside) {
      local.selectedFile = source.type === "directory"
        ? pathAfterDirectoryMove(local.selectedFile, source.path, movedPath)
        : movedPath;
      expandToFile(local.selectedFile);
      await loadSelectedFile();
    }
    if (selectedFolderWasInside) {
      local.selectedFolder = pathAfterDirectoryMove(local.selectedFolder, source.path, movedPath);
    }
    local.collapsedFolders.delete(targetFolder);
    local.saveStatus = "Moved";
    render();
  } catch (error) {
    alert(error.message);
  }
}

function closeTreeContextMenu() {
  local.treeContextMenu = null;
  document.querySelector(".tree-context-menu")?.remove();
}

function showTreeContextMenu(event, pathValue = "") {
  event.preventDefault();
  event.stopPropagation();
  const entry = pathValue ? treeItem(pathValue) : null;
  if (entry) {
    if (entry.type === "directory") {
      local.selectedFolder = entry.path;
    } else {
      local.selectedFolder = "";
      local.selectedFile = entry.path;
      expandToFile(entry.path);
    }
    updateSidebarUi();
  }
  const targetFolder = entry?.type === "directory" ? entry.path : entry ? pathDirname(entry.path) : "";
  const width = 206;
  const height = 350;
  local.treeContextMenu = {
    path: entry?.path || "",
    targetFolder,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))
  };
  document.querySelector(".tree-context-menu")?.remove();
  document.querySelector(".editor-shell")?.insertAdjacentHTML("beforeend", treeContextMenuMarkup());
  bindTreeContextMenu();
}

function downloadTreeItem(pathValue) {
  if (!pathValue) return;
  const link = document.createElement("a");
  link.href = authUrl(`/api/file/download?path=${encodeURIComponent(pathValue)}`);
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function copyTreeItemToFolder(sourcePath, targetFolder) {
  if (!requireProjectMutationAccess("copy project items")) return;
  if (!canPasteTreeItem(sourcePath, targetFolder)) return;
  const source = treeItem(sourcePath);
  const nextPath = uniqueCopyPath(sourcePath, targetFolder);
  try {
    const result = await api("/api/file/copy", {
      method: "POST",
      body: {
        from: source.path,
        to: nextPath
      }
    });
    await loadState();
    if (source.type === "directory") {
      local.selectedFolder = result.path;
      local.collapsedFolders.delete(result.path);
    } else {
      local.selectedFolder = "";
      local.selectedFile = result.path;
      expandToFile(result.path);
      if (isEditableFile(fileMeta(result.path))) await loadSelectedFile();
    }
    local.saveStatus = "Copied";
    updateSidebarUi();
  } catch (error) {
    alert(error.message);
  }
}

async function handleTreeContextMenuAction(action) {
  const menu = local.treeContextMenu;
  if (!menu) return;
  const pathValue = menu.path;
  const targetFolder = menu.targetFolder || "";
  closeTreeContextMenu();
  if (action !== "download" && !requireProjectMutationAccess("change project files")) return;

  if (action === "rename") {
    if (pathValue) startInlineRename(pathValue);
    return;
  }
  if (action === "copy") {
    if (pathValue && canCopyTreeItem(pathValue)) {
      local.treeClipboardPath = pathValue;
      local.saveStatus = "Copied";
      const status = document.querySelector(".editor-subtitle");
      if (status) status.textContent = local.saveStatus;
    }
    return;
  }
  if (action === "paste") {
    await copyTreeItemToFolder(local.treeClipboardPath, targetFolder);
    return;
  }
  if (action === "download") {
    downloadTreeItem(pathValue);
    return;
  }
  if (action === "set-main") {
    if (pathValue) {
      local.selectedFolder = "";
      local.selectedFile = pathValue;
      await setMainFile();
    }
    return;
  }
  if (action === "delete") {
    if (pathValue) {
      const entry = treeItem(pathValue);
      if (entry?.type === "directory") local.selectedFolder = entry.path;
      else {
        local.selectedFolder = "";
        local.selectedFile = entry?.path || pathValue;
      }
      await deleteSelectedFile(document.querySelector("#deleteFile"));
    }
    return;
  }
  if (action === "new-file") {
    await createFile(targetFolder);
    return;
  }
  if (action === "new-folder") {
    await createFolder(targetFolder);
    return;
  }
  if (action === "upload") {
    uploadProjectFile(targetFolder);
  }
}

function isVisualEditableTarget(target) {
  if (!target) return false;
  if (target.classList?.contains("visual-raw-input")) return true;
  return Boolean(target.closest?.("[contenteditable='true']"));
}

function insertTabIntoVisualTarget(target) {
  const tabText = "  ";
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.value = `${target.value.slice(0, start)}${tabText}${target.value.slice(end)}`;
    target.selectionStart = target.selectionEnd = start + tabText.length;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  document.execCommand("insertText", false, tabText);
}

function insertVisualHtmlAtSelection(html) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = template.content;
  const lastNode = fragment.lastChild;
  range.insertNode(fragment);
  if (lastNode) {
    range.setStartAfter(lastNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

function normalizeVisualClipboardLatex(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .filter((line, index, lines) => {
      const trimmed = line.trim();
      const next = (lines[index + 1] || "").trim();
      if (/^\d+$/.test(trimmed) && /^\\/.test(next)) return false;
      if (/^(LaTeX block|advanced source)$/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function parseVisualInlineMathPaste(text) {
  const source = normalizeVisualClipboardLatex(text);
  const inline = source.match(/^\\\(([\s\S]*?)\\\)$/) || source.match(/^(?<!\\)\$([^$\n]+?)(?<!\\)\$$/);
  if (inline) return { mode: "inline", content: inline[1].trim() || "x" };
  const display = source.match(/^\\\[([\s\S]*?)\\\]$/);
  if (display) return { mode: "display", content: display[1].trim() || "x" };
  return null;
}

function normalizeVisualMathClipboardContent(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\\([A-Za-z@]+)\s+(?=[{[_^A-Za-z0-9\\])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();
}

function visualLatexBlocksFromSnippet(text) {
  const source = normalizeVisualClipboardLatex(text);
  if (!source) return [];
  const direct = parseLatexMathBlock(source) || parseLatexTableBlock(source) || parseLatexFigureBlock(source);
  if (direct) return [{ ...direct, line: "" }];
  return parseVisualLatex(source).map((block) => ({ ...block, line: "" }));
}

function visualPasteShouldBecomeBlocks(text, target) {
  const source = normalizeVisualClipboardLatex(text);
  if (!source || target?.closest?.(".visual-math-chip, .visual-math-input, .visual-raw-block")) return false;
  if (parseVisualInlineMathPaste(source)?.mode === "inline" || visualLooksLikeBareMathPaste(source)) return false;
  const blocks = visualLatexBlocksFromSnippet(source);
  if (!blocks.length) return false;
  if (blocks.length > 1 && blocks.some((block) => block.type !== "paragraph" && block.type !== "blank")) return true;
  return ["figure", "table", "math", "heading", "raw"].includes(blocks[0]?.type);
}

function visualLooksLikeBareMathPaste(text) {
  const source = normalizeVisualClipboardLatex(text);
  if (!source || /\n{2,}/.test(source) || /^\\(?:begin|end|chapter|section|subsection|caption|label|cite|ref)\b/.test(source)) {
    return false;
  }
  if (parseVisualInlineMathPaste(source)?.mode === "display") return false;
  const mathCommand = VISUAL_COMMAND_OPTIONS
    .filter((option) => option.math && /^\\[A-Za-z@]+$/.test(option.label))
    .map((option) => option.label.replace(/^\\/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`^\\\\(?:${mathCommand})(?:\\b|\\{|_|\\^|$)`).test(source) || (/[_^=]/.test(source) && /^[-+*/=.,;:(){}\[\]\s\\A-Za-z0-9_^]+$/.test(source));
}

function visualInlinePasteHtml(text) {
  return visualInlineHtml(text).replace(/\n/g, "<br />");
}

function insertVisualLatexBlocksFromPaste(text, documentNode, getText, handleInput) {
  if (!documentNode) return false;
  const parsedBlocks = visualLatexBlocksFromSnippet(text);
  const blocks = parsedBlocks.filter((block) => block.type !== "blank" || parsedBlocks.length > 1);
  if (!blocks.length) return false;
  const html = blocks.map(visualBlockMarkup).join("");
  const target = visualInsertionTarget(documentNode);
  target.node.insertAdjacentHTML(target.position, html);
  const inserted = target.position === "beforeend" ? documentNode.lastElementChild : target.node.nextElementSibling;
  local.visualInsertAfterBlock = inserted || local.visualInsertAfterBlock;
  mountVisualRawEditors(documentNode.closest(".editor-visual-mount") || documentNode.parentElement, getText, handleInput, documentNode);
  markEditorChanged(getText());
  inserted?.querySelector?.("[contenteditable='true'], .visual-raw-input")?.focus?.();
  return true;
}

function rangeIntersectsNode(range, node) {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function visualSelectionNode(selection) {
  const node = selection?.anchorNode;
  return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
}

function visualSelectedBlocks(documentNode, range) {
  if (!documentNode || !range) return [];
  return [...documentNode.querySelectorAll(".visual-block")].filter((block) => rangeIntersectsNode(range, block));
}

function visualSelectionLatex(documentNode) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !documentNode?.contains(selection.anchorNode)) return "";
  const range = selection.getRangeAt(0);
  const selectedText = selection.toString().trim();
  const anchor = visualSelectionNode(selection);
  const math = anchor?.closest?.(".visual-math-chip, .visual-math-input");
  if (math && documentNode.contains(math)) {
    const mathText = math.textContent.trim();
    const rawContent = selectedText && selectedText.length < mathText.length ? selectedText : mathText;
    const content = normalizeVisualMathClipboardContent(rawContent) || "x";
    const mode = math.getAttribute("data-latex-math") || (math.classList.contains("visual-math-input") ? "display" : "inline");
    return mode === "display" ? `\\[\n${content}\n\\]` : `\\(${content}\\)`;
  }

  const fragment = range.cloneContents();
  const hasMath = fragment.querySelector?.(".visual-math-chip, .visual-math-input");
  const selectedBlocks = visualSelectedBlocks(documentNode, range);
  const objectBlocks = selectedBlocks.filter((block) => ["figure", "table", "math"].includes(block.dataset.visualType || ""));
  if (objectBlocks.length && /\\(?:begin|includegraphics|caption|label|\[|\])/.test(selectedText)) {
    return objectBlocks.map(visualBlockToLatex).join("\n\n");
  }
  if (hasMath) {
    return [...fragment.childNodes].map(inlineNodeToLatex).join("").trim();
  }
  return "";
}

function visualEditableContainer(target) {
  return target?.closest?.(".visual-math-chip, .visual-math-input, .visual-paragraph-input, .visual-heading-input, .visual-table-grid td, .visual-table-caption, .visual-figure-caption") || null;
}

function visualCaretOffset(container) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !container?.contains(selection.anchorNode)) return 0;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(container);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}

function visualCommandContext(target) {
  const container = visualEditableContainer(target);
  if (!container) return null;
  const selection = window.getSelection();
  if (!selection?.rangeCount || !container.contains(selection.anchorNode)) return null;
  const offset = visualCaretOffset(container);
  const before = container.textContent.slice(0, offset);
  const match = before.match(/\\[A-Za-z@]*$/);
  if (!match) return null;
  return {
    container,
    from: offset - match[0].length,
    to: offset,
    query: match[0].slice(1).toLowerCase(),
    insideMath: Boolean(container.closest(".visual-math-chip, .visual-math-input"))
  };
}

function visualDynamicCommandOptions() {
  const suggestions = local.editorSuggestions || {};
  const labels = (suggestions.labels || []).slice(0, 24).map((label) => ({
    label: `\\ref{${label}}`,
    insert: `\\ref{${label}}`,
    detail: "ref",
    info: "Project reference"
  }));
  const citations = (suggestions.citations || []).slice(0, 24).map((key) => ({
    label: `\\cite{${key}}`,
    insert: `\\cite{${key}}`,
    detail: "cite",
    info: "Bibliography citation"
  }));
  const macros = (suggestions.macros || []).slice(0, 24).map((macro) => ({
    label: `\\${macro}`,
    insert: `\\${macro}`,
    detail: "macro",
    info: "Project macro",
    math: true
  }));
  return [...macros, ...labels, ...citations];
}

function visualCommandOptions(query = "") {
  const options = [...visualDynamicCommandOptions(), ...VISUAL_COMMAND_OPTIONS];
  const normalized = query.toLowerCase();
  return options
    .filter((option) => option.label.toLowerCase().startsWith(`\\${normalized}`))
    .slice(0, 12);
}

function visualAutocompleteMarkup(options, activeIndex) {
  return `
    <div class="visual-autocomplete-popover" id="visualAutocompletePopover" role="listbox" aria-label="LaTeX command suggestions">
      ${options.map((option, index) => `
        <button type="button" class="visual-autocomplete-option ${index === activeIndex ? "active" : ""}" data-index="${index}" role="option" aria-selected="${index === activeIndex}">
          <span>${escapeHtml(option.label)}</span>
          <small>${escapeHtml(option.detail || "")}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function hideVisualAutocomplete() {
  document.querySelector("#visualAutocompletePopover")?.remove();
  local.visualAutocomplete = null;
}

function showVisualAutocomplete(context) {
  const options = visualCommandOptions(context.query);
  if (!options.length) {
    hideVisualAutocomplete();
    return;
  }
  local.visualAutocomplete = { ...context, options, activeIndex: 0 };
  document.querySelector("#visualAutocompletePopover")?.remove();
  document.body.insertAdjacentHTML("beforeend", visualAutocompleteMarkup(options, 0));
  const popover = document.querySelector("#visualAutocompletePopover");
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();
  const fallback = context.container.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - 300, Math.round((rect?.left || fallback.left) + window.scrollX)));
  const top = Math.max(8, Math.min(window.innerHeight - 260, Math.round((rect?.bottom || fallback.bottom) + window.scrollY + 8)));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.querySelectorAll(".visual-autocomplete-option").forEach((button) => {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyVisualAutocomplete(Number(button.dataset.index || 0));
    });
  });
}

function refreshVisualAutocomplete(target) {
  const context = visualCommandContext(target);
  if (!context) {
    hideVisualAutocomplete();
    return;
  }
  showVisualAutocomplete(context);
}

function moveVisualAutocomplete(direction) {
  const state = local.visualAutocomplete;
  if (!state) return false;
  state.activeIndex = (state.activeIndex + direction + state.options.length) % state.options.length;
  const popover = document.querySelector("#visualAutocompletePopover");
  popover?.querySelectorAll(".visual-autocomplete-option").forEach((button, index) => {
    button.classList.toggle("active", index === state.activeIndex);
    button.setAttribute("aria-selected", index === state.activeIndex ? "true" : "false");
  });
  return true;
}

function applyVisualAutocomplete(index = local.visualAutocomplete?.activeIndex || 0) {
  const state = local.visualAutocomplete;
  if (!state) return false;
  const option = state.options[index] || state.options[0];
  selectVisualTextRange(state.container, state.from, state.to);
  if (option.display && !state.insideMath) {
    const content = option.insert.replace(/^\\\[\s*/, "").replace(/\s*\\\]$/, "").trim() || "x";
    insertVisualHtmlAtSelection(visualMathInlineHtml(content, "display"));
  } else if (option.display) {
    document.execCommand("insertText", false, option.insert);
  } else if (option.math && !state.insideMath) {
    insertVisualHtmlAtSelection(visualMathInlineHtml(option.insert, "inline"));
  } else if (/^\\(?:cite|ref|label)\{/.test(option.insert) && !state.insideMath) {
    const value = option.insert.replace(/^\\(?:cite|ref|label)\{/, "").replace(/\}$/, "");
    const label = option.insert.startsWith("\\cite") ? `cite:${value}` : option.insert.startsWith("\\label") ? `label:${value}` : `ref:${value}`;
    insertVisualHtmlAtSelection(`<span class="visual-chip" data-latex-raw="${escapeHtml(option.insert)}">${escapeHtml(label)}</span>`);
  } else {
    document.execCommand("insertText", false, option.insert);
  }
  hideVisualAutocomplete();
  markEditorChanged(currentEditorText());
  return true;
}

function normalizeVisualMathElement(element) {
  if (!element || element.__normalizingMath) return;
  const text = element.textContent || "x";
  element.__normalizingMath = true;
  element.innerHTML = visualLatexSourceHtml(text);
  element.__normalizingMath = false;
}

function convertLatestTypedMath(target) {
  const container = visualEditableContainer(target);
  if (!container || container.closest(".visual-math-chip, .visual-math-input")) return false;
  const offset = visualCaretOffset(container);
  const before = container.textContent.slice(0, offset);
  const match = before.match(/\\\(([\s\S]*?)\\\)$|(?<!\\)\$([^$\n]+?)(?<!\\)\$$|\\\[([\s\S]*?)\\\]$/);
  if (!match) return false;
  const content = match[1] ?? match[2] ?? match[3] ?? "x";
  const mode = match[3] !== undefined ? "display" : "inline";
  const raw = match[0];
  selectVisualTextRange(container, offset - raw.length, offset);
  insertVisualHtmlAtSelection(visualMathInlineHtml(content, mode));
  markEditorChanged(currentEditorText());
  return true;
}

function visualRawBlockText(block) {
  const codeMount = block?.querySelector?.(".visual-raw-code-mount");
  const codeEditor = codeMount?.__localLeafEditor;
  if (codeEditor) return codeEditor.getText();
  return block?.querySelector?.(".visual-raw-input")?.value || codeMount?.textContent || "";
}

function syncVisualRawFallback(block) {
  const fallback = block?.querySelector?.(".visual-raw-input");
  if (fallback) fallback.value = visualRawBlockText(block);
}

function destroyVisualRawEditors(host) {
  host?.querySelectorAll?.(".visual-raw-code-mount").forEach((mount) => {
    mount.__localLeafEditor?.destroy();
  });
}

function visualOffsetParsedBlockLines(blocks, originalLine) {
  const baseLine = Number(originalLine);
  return blocks.map((parsedBlock, index) => {
    if (!Number.isFinite(baseLine)) {
      return { ...parsedBlock, line: index === 0 ? originalLine : parsedBlock.line };
    }
    const parsedLine = Number(parsedBlock.line || 1);
    return {
      ...parsedBlock,
      line: Number.isFinite(parsedLine) ? baseLine + parsedLine - 1 : baseLine + index
    };
  });
}

function visualSourceCollapseBlocks(source, originalLine) {
  const normalizedSource = String(source || "").replace(/\r\n/g, "\n");
  if (!normalizedSource.trim()) {
    return {
      blocks: [{ type: "blank", line: originalLine }],
      shouldCollapse: true,
      focusBlank: true
    };
  }

  const parsed = visualOffsetParsedBlockLines(parseVisualLatex(normalizedSource), originalLine);
  const hasRaw = parsed.some((block) => block.type === "raw");
  if (hasRaw) {
    return {
      blocks: parsed,
      shouldCollapse: false,
      focusBlank: false
    };
  }

  return {
    blocks: parsed,
    shouldCollapse: true,
    focusBlank: parsed.length === 1 && parsed[0].type === "blank"
  };
}

function replaceVisualBlockWithBlocks(block, replacementBlocks) {
  const template = document.createElement("template");
  template.innerHTML = replacementBlocks.map(visualBlockMarkup).join("");
  const replacements = [...template.content.children];
  block.replaceWith(...replacements);
  return replacements;
}

function collapseVisualRawBlockIfStructured(block, getText, options = {}) {
  if (!block?.isConnected || !block.classList.contains("visual-expanded-source-block")) return false;
  syncVisualRawFallback(block);
  const source = visualRawBlockText(block);
  const line = block.querySelector(".visual-line-number")?.textContent.trim() || "";
  const collapse = visualSourceCollapseBlocks(source, line);
  if (!collapse.shouldCollapse) return false;
  destroyVisualRawEditors(block);
  const replacements = replaceVisualBlockWithBlocks(block, collapse.blocks);
  if (replacements[0]) local.visualInsertAfterBlock = replacements[0];
  if (options.focusEmpty && collapse.focusBlank) {
    const input = replacements[0]?.querySelector?.(".visual-paragraph-input");
    input?.focus();
    if (input) selectVisualTextRange(input, 0, 0);
  }
  markEditorChanged(getText());
  return true;
}

function collapseVisualExpandedSourceBlocks(documentNode, getText, options = {}) {
  let collapsed = false;
  documentNode?.querySelectorAll?.(".visual-expanded-source-block").forEach((block) => {
    if (!block.isConnected || !documentNode.contains(block)) return;
    const active = document.activeElement;
    if (!options.includeActive && active && block.contains(active)) return;
    collapsed = collapseVisualRawBlockIfStructured(block, getText, options) || collapsed;
  });
  return collapsed;
}

function scheduleVisualRawCollapse(block, getText, documentNode) {
  clearTimeout(block.__localLeafCollapseTimer);
  block.__localLeafCollapseTimer = setTimeout(() => {
    if (!block.isConnected || !documentNode?.contains(block)) return;
    const active = document.activeElement;
    if (active && block.contains(active)) return;
    collapseVisualRawBlockIfStructured(block, getText, { focusEmpty: true });
  }, 180);
}

function mountVisualRawEditors(host, getText, handleInput, documentNode) {
  host.querySelectorAll(".visual-raw-code-mount").forEach((mount) => {
    if (mount.__localLeafEditor) return;
    const block = mount.closest(".visual-raw-block");
    const shell = mount.closest(".visual-raw-shell");
    const fallback = block?.querySelector(".visual-raw-input");
    const source = fallback?.value || mount.textContent || "";
    if (!window.LocalLeafEditor) {
      mount.textContent = "";
      fallback?.addEventListener("input", handleInput);
      fallback?.addEventListener("blur", () => scheduleVisualRawCollapse(block, getText, documentNode));
      return;
    }

    shell?.classList.add("has-code-editor");
    mount.textContent = "";
    const editor = window.LocalLeafEditor.mount({
      parent: mount,
      value: source,
      filePath: local.selectedFile,
      readOnly: !canMutateProject(),
      suggestions: local.editorSuggestions || {},
      visibleLineBreaks: false,
      onSearch: openEditorSearchPanel,
      onChange: () => {
        syncVisualRawFallback(block);
        markEditorChanged(getText());
      },
      onFocus: () => {
        local.editingNow = true;
      },
      onBlur: () => {
        local.editingNow = false;
        scheduleVisualRawCollapse(block, getText, documentNode);
      }
    });
    mount.__localLeafEditor = editor;
    syncVisualRawFallback(block);
  });
}

function compileDiagnosticsForFile(filePath = local.selectedFile) {
  const file = String(filePath || "");
  const mainFile = local.appState?.project?.mainFile || file;
  const logs = Array.isArray(local.appState?.compile?.logs) ? local.appState.compile.logs : [];
  const diagnostics = [];
  for (let index = 0; index < logs.length; index += 1) {
    const line = String(logs[index] || "");
    const severity = compileLogLevel(line);
    if (!["error", "warning"].includes(severity)) continue;
    const direct = line.match(/(?:^|\s)([^:\s]+\.tex):(\d+):\s*(.*)$/i);
    if (direct) {
      const pathHint = direct[1].replace(/^[./\\]+/u, "").replace(/\\/g, "/");
      if (pathHint.endsWith(file) || file.endsWith(pathHint)) {
        diagnostics.push({
          line: Number(direct[2] || 1),
          column: 0,
          severity,
          message: direct[3] || line
        });
      }
      continue;
    }
    const texLine = line.match(/\bl\.(\d+)\b\s*(.*)$/i) || logs[index + 1]?.match?.(/\bl\.(\d+)\b\s*(.*)$/i);
    if (texLine && (!file || file === mainFile)) {
      diagnostics.push({
        line: Number(texLine[1] || 1),
        column: 0,
        severity,
        message: line.replace(/^! ?/u, "").trim() || texLine[2] || line
      });
    }
  }
  return diagnostics.slice(-60);
}

function updateEditorDiagnostics() {
  local.compileDiagnostics = compileDiagnosticsForFile(local.selectedFile);
  local.codeEditor?.setDiagnostics?.(local.compileDiagnostics);
}

function syncEditorModeUi() {
  local.editorMode = "code";
  document.querySelectorAll("[data-editor-mode]").forEach((button) => {
    const active = button.dataset.editorMode === local.editorMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  const applied = local.codeEditor?.setMode?.("code");
  if (applied && applied !== local.editorMode) local.editorMode = applied;
}

function mountCodeEditor() {
  const host = document.querySelector("#editorText.editor-code-mount");
  if (!host) return;
  if (!window.LocalLeafEditor) {
    host.innerHTML = `<textarea class="editor-textarea editor-fallback-textarea" spellcheck="false" ${canMutateProject() ? "" : "readonly aria-readonly=\"true\""}>${escapeHtml(local.editorContent)}</textarea>`;
    return;
  }
  if (local.codeEditor?.host === host) return;
  destroyCodeEditor();
  local.codeEditor = window.LocalLeafEditor.mount({
    parent: host,
    value: local.editorContent,
    filePath: local.selectedFile,
    mode: "code",
    readOnly: !canMutateProject(),
    diagnostics: compileDiagnosticsForFile(local.selectedFile),
    suggestions: local.editorSuggestions || {},
    onChange: (text) => markEditorChanged(text),
    onSave: saveCurrentFile,
    onCompile: compile,
    onSearch: openEditorSearchPanel,
    onFocus: () => {
      local.editingNow = true;
    },
    onBlur: () => {
      local.editingNow = false;
    }
  });
  syncEditorModeUi();
  updateEditorDiagnostics();
  refreshEditorSuggestions();
}

function mountVisualEditor() {
  const host = document.querySelector("#editorText.editor-visual-mount");
  if (!host) return;
  if (local.visualEditor?.host === host) return;
  destroyCodeEditor();
  const documentNode = host.querySelector("#visualEditorDocument");
  if (!canMutateProject()) {
    documentNode?.querySelectorAll('[contenteditable="true"]').forEach((element) => element.setAttribute("contenteditable", "false"));
    documentNode?.querySelectorAll("input, textarea, select, button").forEach((element) => {
      element.disabled = true;
    });
  }
  const getText = () => visualDomToLatex(documentNode);
  const handleInput = (event) => {
    convertLatestTypedMath(event?.target);
    refreshVisualAutocomplete(event?.target);
    markEditorChanged(getText());
  };
  const handleCopy = (event) => {
    const latex = visualSelectionLatex(documentNode);
    if (!latex || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", latex);
    event.clipboardData.setData("text/html", `<pre>${escapeHtml(latex)}</pre>`);
    event.preventDefault();
  };
  const handlePaste = (event) => {
    const target = event.target;
    if (target?.closest?.(".visual-raw-code-mount .cm-editor, .visual-raw-input")) return;
    const text = normalizeVisualClipboardLatex(event.clipboardData?.getData("text/plain") || "");
    if (!text) return;

    const active = visualEditableContainer(target) || currentVisualEditableElement();
    const activeMath = active?.closest?.(".visual-math-chip, .visual-math-input");
    const pastedMath = parseVisualInlineMathPaste(text);
    if (activeMath) {
      if (!pastedMath) return;
      event.preventDefault();
      document.execCommand("insertText", false, pastedMath.content);
      normalizeVisualMathElement(activeMath);
      markEditorChanged(getText());
      return;
    }

    if (visualPasteShouldBecomeBlocks(text, target)) {
      event.preventDefault();
      hideVisualAutocomplete();
      insertVisualLatexBlocksFromPaste(text, documentNode, getText, handleInput);
      return;
    }

    if (active?.isContentEditable && pastedMath?.mode === "inline") {
      event.preventDefault();
      insertVisualHtmlAtSelection(visualMathInlineHtml(pastedMath.content, "inline"));
      markEditorChanged(getText());
      return;
    }

    if (active?.isContentEditable && visualLooksLikeBareMathPaste(text)) {
      event.preventDefault();
      insertVisualHtmlAtSelection(visualMathInlineHtml(text, "inline"));
      markEditorChanged(getText());
      return;
    }

    if (active?.isContentEditable && /\\\(|(?<!\\)\$[^$\n]+(?<!\\)\$|\\(?:textbf|textit|emph|texttt|cite|citep|citet|parencite|textcite|ref|eqref|autoref|pageref)\{/.test(text)) {
      event.preventDefault();
      insertVisualHtmlAtSelection(visualInlinePasteHtml(text));
      markEditorChanged(getText());
    }
  };
  const handleKeyDown = (event) => {
    const target = event.target;
    if (target?.closest?.(".visual-raw-code-mount .cm-editor")) return;
    if (local.visualAutocomplete) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveVisualAutocomplete(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveVisualAutocomplete(-1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyVisualAutocomplete();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideVisualAutocomplete();
        return;
      }
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod) {
      const key = event.key.toLowerCase();
      if (key === " " || event.code === "Space") {
        event.preventDefault();
        const context = visualCommandContext(target);
        if (context) showVisualAutocomplete(context);
        return;
      }
      if (key === "b" || key === "i" || key === "z" || key === "y") {
        event.preventDefault();
        const command = key === "b" ? "bold" : key === "i" ? "italic" : key === "z" && event.shiftKey ? "redo" : key === "z" ? "undo" : "redo";
        execVisualCommand(command);
        return;
      }
    }
    if (event.key === "Tab" && isVisualEditableTarget(target)) {
      event.preventDefault();
      insertTabIntoVisualTarget(target);
      markEditorChanged(getText());
      return;
    }
    if (event.key !== "Enter" || !target?.classList?.contains("visual-paragraph-input")) return;
    event.preventDefault();
    document.execCommand("insertLineBreak");
    markEditorChanged(getText());
  };
  const handleClick = (event) => {
    const addRow = event.target.closest?.(".visual-table-add-row");
    const addColumn = event.target.closest?.(".visual-table-add-column");
    const editObject = event.target.closest?.(".visual-object-edit-button");
    if (addRow) {
      const table = addRow.closest(".visual-table-block")?.querySelector(".visual-table-grid tbody");
      const columns = table?.querySelector("tr")?.children.length || 2;
      table?.insertAdjacentHTML("beforeend", `<tr>${Array.from({ length: columns }, () => `<td contenteditable="true" spellcheck="true"></td>`).join("")}</tr>`);
      markEditorChanged(getText());
    } else if (addColumn) {
      addColumn.closest(".visual-table-block")?.querySelectorAll(".visual-table-grid tr").forEach((row) => {
        row.insertAdjacentHTML("beforeend", `<td contenteditable="true" spellcheck="true"></td>`);
      });
      markEditorChanged(getText());
    } else if (editObject) {
      const block = editObject.closest(".visual-block");
      if (block?.dataset.visualType === "figure") {
        const line = block.querySelector(".visual-line-number")?.textContent.trim() || "";
        block.outerHTML = visualBlockMarkup({ type: "raw", text: visualFigureToLatex(block), line, expanded: true }, 0);
        mountVisualRawEditors(host, getText, handleInput, documentNode);
        const codeMount = host.querySelector(".visual-expanded-source-block .visual-raw-code-mount");
        const textarea = host.querySelector(".visual-expanded-source-block .visual-raw-input");
        if (codeMount?.__localLeafEditor) {
          codeMount.__localLeafEditor.focus();
        } else if (textarea) {
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        }
        markEditorChanged(getText());
      }
    }
  };
  const handleChange = (event) => {
    if (event.target.classList?.contains("visual-table-borders")) {
      const block = event.target.closest(".visual-table-block");
      if (block) block.dataset.tableBorders = event.target.value;
      markEditorChanged(getText());
    }
  };
  const handleFocusIn = () => {
    local.editingNow = true;
    const block = document.activeElement?.closest?.(".visual-block");
    if (block && documentNode?.contains(block)) local.visualInsertAfterBlock = block;
  };
  const handleFocusOut = (event) => {
    if (event.target?.closest?.(".visual-math-chip, .visual-math-input")) {
      setTimeout(() => {
        normalizeVisualMathElement(event.target.closest(".visual-math-chip, .visual-math-input"));
        markEditorChanged(getText());
      }, 0);
    }
    local.editingNow = false;
  };
  documentNode?.addEventListener("input", handleInput);
  documentNode?.addEventListener("copy", handleCopy);
  documentNode?.addEventListener("paste", handlePaste);
  documentNode?.addEventListener("keydown", handleKeyDown);
  documentNode?.addEventListener("click", handleClick);
  documentNode?.addEventListener("change", handleChange);
  documentNode?.addEventListener("focusin", handleFocusIn);
  documentNode?.addEventListener("focusout", handleFocusOut);
  mountVisualRawEditors(host, getText, handleInput, documentNode);
  refreshEditorSuggestions();

  local.visualEditor = {
    host,
    destroy() {
      hideVisualAutocomplete();
      destroyVisualRawEditors(host);
      documentNode?.removeEventListener("input", handleInput);
      documentNode?.removeEventListener("copy", handleCopy);
      documentNode?.removeEventListener("paste", handlePaste);
      documentNode?.removeEventListener("keydown", handleKeyDown);
      documentNode?.removeEventListener("click", handleClick);
      documentNode?.removeEventListener("change", handleChange);
      documentNode?.removeEventListener("focusin", handleFocusIn);
      documentNode?.removeEventListener("focusout", handleFocusOut);
      local.visualEditor = null;
    },
    getText,
    flushTransientSourceBlocks(options = {}) {
      return collapseVisualExpandedSourceBlocks(documentNode, getText, options);
    },
    applyRemoteText(text) {
      if (!documentNode) return;
      hideVisualAutocomplete();
      destroyVisualRawEditors(host);
      documentNode.innerHTML = visualLatexMarkup(text);
      mountVisualRawEditors(host, getText, handleInput, documentNode);
    },
    exec(command, value) {
      return execVisualCommand(command, value);
    }
  };
}

function execVisualCommand(command, value) {
  const active = currentVisualEditableElement();
  const insertText = (text) => {
    if (active && (active.isContentEditable || active.tagName === "TEXTAREA")) {
      document.execCommand("insertText", false, text);
      markEditorChanged(currentEditorText());
      return true;
    }
    return false;
  };
  const insertHtml = (html) => {
    if (active && active.isContentEditable) {
      insertVisualHtmlAtSelection(html);
      markEditorChanged(currentEditorText());
      return true;
    }
    return false;
  };
  const insertInlineMath = (content = "x") => {
    if (active?.closest?.(".visual-math-chip, .visual-math-input")) return insertText(content);
    if (insertHtml(visualMathInlineHtml(content, "inline"))) return true;
    insertVisualMathBlock(content);
    return true;
  };

  if (command === "undo") document.execCommand("undo");
  else if (command === "redo") document.execCommand("redo");
  else if (command === "bold") document.execCommand("bold");
  else if (command === "italic") document.execCommand("italic");
  else if (command === "monospace") insertHtml("<code data-latex-inline=\"texttt\">text</code>");
  else if (command === "style" && value && value !== "normal") insertText(`\\${value}{Title}`);
  else if (command === "link") insertText("\\href{}{text}");
  else if (command === "ref") insertHtml("<span class=\"visual-chip\" data-latex-raw=\"\\ref{}\">ref:</span>") || insertText("\\ref{}");
  else if (command === "cite") insertHtml("<span class=\"visual-chip\" data-latex-raw=\"\\cite{}\">cite:</span>") || insertText("\\cite{}");
  else if (command === "math") insertInlineMath("x");
  else if (command === "figure") {
    insertVisualFigure();
    return true;
  }
  else if (command === "table") {
    local.tablePickerOpen = !local.tablePickerOpen;
    refreshEditorToolbarPanels();
    return true;
  }
  else if (command === "bulletList") insertText("\\begin{itemize}\n  \\item \n\\end{itemize}");
  else if (command === "numberedList") insertText("\\begin{enumerate}\n  \\item \n\\end{enumerate}");
  else if (command === "symbol") insertInlineMath("\\alpha");
  else if (command === "comment") insertText("% ");
  else if (command === "complete") {
    setEditorMode("code");
    return true;
  }
  else return false;
  markEditorChanged(currentEditorText());
  return true;
}

function mountActiveEditor() {
  mountCodeEditor();
}

function setEditorMode(mode) {
  if (mode !== "code") return;
  local.editorContent = currentEditorText();
  local.editorMode = "code";
  local.tablePickerOpen = false;
  writeEditorModeForFile(local.selectedFile, "code");
  syncEditorModeUi();
  refreshEditorToolbarPanels();
}

function currentVisualEditableElement() {
  const active = document.activeElement;
  if (active?.isContentEditable || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    return active;
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount) return active;
  const node = selection.anchorNode?.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode
    : selection.anchorNode?.parentElement;
  return visualEditableContainer(node) || active;
}

function activeSearchOptions() {
  return {
    matchCase: local.searchMatchCase,
    wholeWord: local.searchWholeWord,
    regex: local.searchRegex
  };
}

function createAppSearchRegex(query, options = {}) {
  if (!query) return null;
  const source = options.regex
    ? query
    : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source;
  try {
    return new RegExp(wrapped, options.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

function lineInfoForSearchIndex(text, index) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEnd = text.indexOf("\n", index);
  const before = text.slice(0, index);
  const rawLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return {
    line: before.split("\n").length,
    column: index - lineStart + 1,
    preview: rawLine.trim().slice(0, 260) || rawLine.slice(0, 260)
  };
}

function searchTextMatches(text, query, options = {}) {
  const regex = createAppSearchRegex(query, options);
  if (!regex) return [];
  const matches = [];
  let match;
  while ((match = regex.exec(String(text || "")))) {
    if (!match[0]) {
      regex.lastIndex += 1;
      continue;
    }
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      text: match[0],
      ...lineInfoForSearchIndex(text, match.index)
    });
  }
  return matches;
}

function replaceWithRegex(text, query, replacement, options = {}) {
  const regex = createAppSearchRegex(query, options);
  if (!regex) return { text, count: 0 };
  let count = 0;
  const nextText = String(text).replace(regex, () => {
    count += 1;
    return replacement;
  });
  return { text: nextText, count };
}

function visualTextNodes(root) {
  if (!root) return [];
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(".visual-line-number")) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function visualVisibleText(root) {
  return visualTextNodes(root).map((node) => node.nodeValue).join("");
}

function selectVisualTextRange(root, from, to) {
  const nodes = visualTextNodes(root);
  let offset = 0;
  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;
  for (const node of nodes) {
    const nextOffset = offset + node.nodeValue.length;
    if (!startNode && from >= offset && from <= nextOffset) {
      startNode = node;
      startOffset = from - offset;
    }
    if (!endNode && to >= offset && to <= nextOffset) {
      endNode = node;
      endOffset = to - offset;
      break;
    }
    offset = nextOffset;
  }
  if (!startNode || !endNode) return false;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  startNode.parentElement?.closest?.("[contenteditable], textarea")?.focus?.();
  return true;
}

function visualFind(query, direction = "next") {
  const root = document.querySelector("#visualEditorDocument");
  const regex = createAppSearchRegex(query, activeSearchOptions());
  if (!root || !regex) return { found: false, total: 0 };
  const text = visualVisibleText(root);
  const matches = [];
  let match;
  while ((match = regex.exec(text))) {
    if (!match[0]) {
      regex.lastIndex += 1;
      continue;
    }
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  if (!matches.length) return { found: false, total: 0 };
  local.visualSearchIndex = direction === "prev"
    ? (local.visualSearchIndex - 1 + matches.length) % matches.length
    : local.visualSearchIndex % matches.length;
  const selected = matches[local.visualSearchIndex];
  if (direction !== "prev") local.visualSearchIndex = (local.visualSearchIndex + 1) % matches.length;
  selectVisualTextRange(root, selected.from, selected.to);
  return { found: true, total: matches.length, index: matches.indexOf(selected) + 1 };
}

function visualReplaceSelection(replacement) {
  const selection = window.getSelection();
  if (!selection.rangeCount || !document.querySelector("#visualEditorDocument")?.contains(selection.anchorNode)) return false;
  document.execCommand("insertText", false, replacement);
  markEditorChanged(currentEditorText());
  return true;
}

function updateSearchStatus(result, action = "find") {
  if (!result) return;
  if (result.count !== undefined) local.searchStatus = `${result.count} replaced`;
  else if (!result.found) local.searchStatus = "No matches";
  else local.searchStatus = `${result.index || 1} of ${result.total}`;
  const status = document.querySelector("#searchStatus");
  if (status) status.innerHTML = searchStatusMarkup();
}

function updateProjectSearchStatus() {
  const total = local.searchResults.length;
  if (!local.searchQuery.trim()) local.searchStatus = "";
  else if (local.searchLoading) local.searchStatus = `${total} found`;
  else if (!total) local.searchStatus = "No matches";
  else local.searchStatus = `${Math.max(local.searchResultIndex + 1, 1)} of ${total}`;
}

function bindProjectSearchResults() {
  document.querySelectorAll("[data-search-result]").forEach((button) => {
    button.addEventListener("click", () => {
      jumpToProjectSearchResult(Number(button.dataset.searchResult || 0));
    });
  });
}

function updateSearchPanelDynamicState() {
  updateProjectSearchStatus();
  const status = document.querySelector("#searchStatus");
  if (status) status.innerHTML = searchStatusMarkup();
  const results = document.querySelector("#projectSearchResults");
  const empty = document.querySelector(".project-search-empty");
  const markup = projectSearchResultsMarkup();
  if (results || empty) {
    const container = results || empty;
    container.outerHTML = markup;
  }
  document.querySelectorAll(".project-search-result").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.searchResult || -1) === local.searchResultIndex);
  });
  document.querySelector(".project-search-result.active")?.scrollIntoView({ block: "nearest" });
  bindProjectSearchResults();
}

function openEditorSearchPanel() {
  local.searchOpen = true;
  local.tablePickerOpen = false;
  local.editorStyleMenuOpen = false;
  refreshEditorToolbarPanels();
  if (local.searchScope === "project") scheduleProjectSearch(0);
  setTimeout(() => {
    const input = document.querySelector("#editorSearchInput");
    input?.focus();
    input?.select();
  }, 0);
}

function setSearchScope(scope) {
  local.searchScope = scope === "file" ? "file" : "project";
  localStorage.setItem(SEARCH_SCOPE_STORAGE_KEY, local.searchScope);
  local.visualSearchIndex = 0;
  local.searchResultIndex = -1;
  local.searchResults = [];
  local.searchTruncated = false;
  clearTimeout(local.searchTimer);
  local.searchRunId += 1;
  local.searchLoading = false;
  local.searchStatus = "";
  refreshEditorToolbarPanels();
  if (local.searchScope === "project") scheduleProjectSearch(0);
}

function scheduleProjectSearch(delay = 180) {
  clearTimeout(local.searchTimer);
  local.searchRunId += 1;
  const runId = local.searchRunId;
  local.searchResults = [];
  local.searchResultIndex = -1;
  local.searchTruncated = false;
  local.searchLoading = Boolean(local.searchQuery.trim());
  updateSearchPanelDynamicState();
  if (!local.searchLoading) return;
  local.searchTimer = setTimeout(() => runProjectSearch(runId), delay);
}

async function runProjectSearch(runId) {
  const query = local.searchQuery.trim();
  if (!query || local.searchScope !== "project" || runId !== local.searchRunId) return;
  const options = activeSearchOptions();
  const files = (local.appState?.project?.files || [])
    .filter((file) => file.type === "text" && Number(file.size || 0) <= PROJECT_SEARCH_MAX_FILE_BYTES)
    .sort((left, right) => left.path.localeCompare(right.path));

  try {
    for (const file of files) {
      if (runId !== local.searchRunId || local.searchScope !== "project") return;
      let content = "";
      if (file.path === local.selectedFile) {
        content = currentEditorText();
      } else {
        const response = await api(`/api/file?path=${encodeURIComponent(file.path)}`, { timeoutMs: 12000 });
        content = response.content || "";
      }
      const matches = searchTextMatches(content, query, options).slice(0, PROJECT_SEARCH_MAX_RESULTS_PER_FILE);
      if (matches.length) {
        const remaining = PROJECT_SEARCH_MAX_RESULTS - local.searchResults.length;
        local.searchResults.push(...matches.slice(0, remaining).map((match) => ({
          ...match,
          path: file.path
        })));
        if (matches.length > remaining || matches.length >= PROJECT_SEARCH_MAX_RESULTS_PER_FILE) {
          local.searchTruncated = true;
        }
        if (local.searchResults.length >= PROJECT_SEARCH_MAX_RESULTS) {
          local.searchTruncated = true;
          break;
        }
      }
      updateSearchPanelDynamicState();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    if (runId === local.searchRunId) {
      local.searchStatus = error.message || "Search failed";
    }
  } finally {
    if (runId === local.searchRunId) {
      local.searchLoading = false;
      updateSearchPanelDynamicState();
    }
  }
}

async function jumpToProjectSearchResult(index) {
  const results = local.searchResults;
  if (!results.length) {
    updateSearchStatus({ found: false, total: 0 });
    return;
  }
  const nextIndex = (index + results.length) % results.length;
  local.searchResultIndex = nextIndex;
  const result = results[nextIndex];
  updateSearchPanelDynamicState();
  if (result.path !== local.selectedFile) {
    await selectProjectFile(result.path);
  }
  requestAnimationFrame(() => {
    if (!local.codeEditor && local.editorMode !== "code") {
      setEditorMode("code");
    }
    local.codeEditor?.selectRange?.(result.from, result.to);
    updateSearchPanelDynamicState();
  });
}

function runProjectSearchNavigation(direction = "next") {
  if (!local.searchQuery.trim()) {
    updateSearchStatus({ found: false, total: 0 });
    return;
  }
  if (!local.searchResults.length) {
    scheduleProjectSearch(0);
    return;
  }
  const offset = direction === "prev" ? -1 : 1;
  const start = local.searchResultIndex < 0
    ? direction === "prev" ? local.searchResults.length : -1
    : local.searchResultIndex;
  jumpToProjectSearchResult(start + offset);
}

function runEditorSearch(direction = "next") {
  if (!local.searchQuery) {
    updateSearchStatus({ found: false, total: 0 });
    return;
  }
  if (local.searchScope === "project") {
    runProjectSearchNavigation(direction);
    return;
  }
  const result = local.codeEditor
    ? local.codeEditor.find(local.searchQuery, { ...activeSearchOptions(), direction })
    : visualFind(local.searchQuery, direction);
  updateSearchStatus(result);
}

function runEditorReplace(all = false) {
  if (!requireProjectMutationAccess("replace project text")) return;
  if (!local.searchQuery) return;
  if (local.searchScope === "project") {
    if (!all) {
      local.searchStatus = "Use Replace All for all files";
      updateSearchPanelDynamicState();
      return;
    }
    replaceAllProjectMatches();
    return;
  }
  const options = activeSearchOptions();
  if (local.codeEditor) {
    const result = all
      ? local.codeEditor.replaceAll(local.searchQuery, local.searchReplace, options)
      : local.codeEditor.replace(local.searchQuery, local.searchReplace, options);
    updateSearchStatus(result, "replace");
    return;
  }
  if (all) {
    const result = replaceWithRegex(currentEditorText(), local.searchQuery, local.searchReplace, options);
    if (result.count) {
      local.editorContent = result.text;
      local.visualEditor?.applyRemoteText(result.text);
      markEditorChanged(result.text);
    }
    updateSearchStatus(result, "replace");
    return;
  }
  const didReplace = visualReplaceSelection(local.searchReplace);
  if (!didReplace) runEditorSearch("next");
  updateSearchStatus({ count: didReplace ? 1 : 0 }, "replace");
}

async function replaceAllProjectMatches() {
  if (!requireProjectMutationAccess("replace project text")) return;
  const query = local.searchQuery.trim();
  if (!query) return;
  const estimated = local.searchResults.length;
  const message = estimated
    ? `Replace ${estimated}${local.searchTruncated ? "+" : ""} visible project match${estimated === 1 ? "" : "es"} across all text files?`
    : "Replace all matches across every text file in this project?";
  if (!confirm(message)) return;
  local.searchLoading = true;
  local.searchStatus = "Replacing...";
  updateSearchPanelDynamicState();
  try {
    const result = await api("/api/search/replace", {
      method: "POST",
      body: {
        query,
        replace: local.searchReplace,
        options: activeSearchOptions()
      }
    });
    local.searchStatus = `${result.count || 0} replaced in ${(result.files || []).length} files`;
    if ((result.files || []).includes(local.selectedFile)) {
      await loadSelectedFile();
      updateEditorSourceUi();
    }
    await loadState();
    scheduleProjectSearch(0);
  } catch (error) {
    local.searchStatus = error.message || "Replace failed";
    updateSearchPanelDynamicState();
  } finally {
    local.searchLoading = false;
    updateSearchPanelDynamicState();
  }
}

function closeEditorSearchPanel() {
  if (!local.searchOpen) return false;
  clearTimeout(local.searchTimer);
  local.searchRunId += 1;
  local.searchLoading = false;
  local.searchOpen = false;
  refreshEditorToolbarPanels();
  local.codeEditor?.focus?.();
  return true;
}

function refreshEditorToolbarPanels() {
  const topbar = document.querySelector(".editor-topbar");
  if (!topbar) return;
  syncEditorModeUi();
  const searchToggle = document.querySelector("#editorSearchToggle");
  searchToggle?.classList.toggle("active", local.searchOpen);
  searchToggle?.setAttribute("aria-expanded", local.searchOpen ? "true" : "false");
  document.querySelector("#editorSearchLauncher")?.classList.toggle("is-open", local.searchOpen);
  document.querySelector("#editorTableButton")?.classList.toggle("active", local.tablePickerOpen);
  const styleButton = document.querySelector("#editorStyleButton");
  styleButton?.classList.toggle("active", local.editorStyleMenuOpen);
  styleButton?.setAttribute("aria-expanded", local.editorStyleMenuOpen ? "true" : "false");
  const styleWrap = document.querySelector(".editor-style-menu-wrap");
  styleWrap?.classList.toggle("open", local.editorStyleMenuOpen);
  const styleMenu = styleWrap?.querySelector(".editor-style-menu");
  styleMenu?.setAttribute("aria-hidden", local.editorStyleMenuOpen ? "false" : "true");
  if (styleMenu) styleMenu.inert = !local.editorStyleMenuOpen;
  topbar.querySelector(".editor-search-popover")?.remove();
  topbar.querySelector(".editor-table-popover")?.remove();
  topbar.insertAdjacentHTML("beforeend", editorSearchPanelMarkup() + tablePickerMarkup());
  positionToolbarPopover(".editor-search-popover", "#editorSearchToggle", "center");
  positionToolbarPopover(".editor-table-popover", "#editorTableButton", "start");
  bindEditorStyleMenu();
  bindEditorToolbarPanels();
  applyProjectMutationAccessUi();
}

function positionToolbarPopover(popoverSelector, anchorSelector, align = "start") {
  const topbar = document.querySelector(".editor-topbar");
  const popover = document.querySelector(popoverSelector);
  const anchor = document.querySelector(anchorSelector);
  if (!topbar || !popover || !anchor) return;
  const topbarRect = topbar.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const popoverWidth = popover.offsetWidth || 220;
  const preferredLeft = align === "center"
    ? anchorRect.left - topbarRect.left + (anchorRect.width / 2) - (popoverWidth / 2)
    : anchorRect.left - topbarRect.left;
  const left = Math.max(8, Math.min(
    topbarRect.width - popoverWidth - 8,
    preferredLeft
  ));
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(anchorRect.bottom - topbarRect.top + 8)}px`;
}

function visualInsertionTarget(documentNode) {
  const activeBlock = document.activeElement?.closest?.(".visual-block");
  if (activeBlock && documentNode.contains(activeBlock)) {
    return { node: activeBlock, position: "afterend" };
  }
  if (local.visualInsertAfterBlock && documentNode.contains(local.visualInsertAfterBlock)) {
    return { node: local.visualInsertAfterBlock, position: "afterend" };
  }
  const blocks = [...documentNode.querySelectorAll(".visual-block")];
  const editableBlocks = blocks.filter((block) => !["raw", "blank"].includes(block.dataset.visualType || ""));
  const fallbackBlock = editableBlocks[editableBlocks.length - 1];
  if (fallbackBlock) return { node: fallbackBlock, position: "afterend" };
  return { node: documentNode, position: "beforeend" };
}

function insertVisualTable(rows = 2, cols = 2) {
  if (!requireProjectMutationAccess("format project text")) return;
  const documentNode = document.querySelector("#visualEditorDocument");
  if (!documentNode) return;
  const rowData = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));
  const blockHtml = visualBlockMarkup({
    type: "table",
    rows: rowData,
    caption: "Caption",
    label: "tab:placeholder",
    borders: "borders",
    line: ""
  }, 0);
  const target = visualInsertionTarget(documentNode);
  target.node.insertAdjacentHTML(target.position, blockHtml);
  local.visualInsertAfterBlock = target.position === "beforeend" ? documentNode.lastElementChild : target.node.nextElementSibling;
  local.tablePickerOpen = false;
  refreshEditorToolbarPanels();
  markEditorChanged(currentEditorText());
  local.visualInsertAfterBlock?.querySelector?.("td")?.focus();
}

function insertVisualFigure() {
  if (!requireProjectMutationAccess("format project text")) return;
  const documentNode = document.querySelector("#visualEditorDocument");
  if (!documentNode) return;
  const blockHtml = visualBlockMarkup({
    type: "figure",
    image: "image.png",
    caption: "Caption",
    label: "fig:placeholder",
    line: ""
  }, 0);
  const target = visualInsertionTarget(documentNode);
  target.node.insertAdjacentHTML(target.position, blockHtml);
  local.visualInsertAfterBlock = target.position === "beforeend" ? documentNode.lastElementChild : target.node.nextElementSibling;
  markEditorChanged(currentEditorText());
  local.visualInsertAfterBlock?.querySelector?.(".visual-figure-image")?.focus();
}

function insertVisualMathBlock(text = "x") {
  if (!requireProjectMutationAccess("format project text")) return;
  const documentNode = document.querySelector("#visualEditorDocument");
  if (!documentNode) return;
  const blockHtml = visualBlockMarkup({
    type: "math",
    mode: "display",
    syntax: "bracket",
    text,
    line: ""
  }, 0);
  const target = visualInsertionTarget(documentNode);
  target.node.insertAdjacentHTML(target.position, blockHtml);
  local.visualInsertAfterBlock = target.position === "beforeend" ? documentNode.lastElementChild : target.node.nextElementSibling;
  const input = local.visualInsertAfterBlock?.querySelector?.(".visual-math-input");
  input?.focus();
  if (input) selectVisualTextRange(input, 0, input.textContent.length);
  markEditorChanged(currentEditorText());
}

function copyTextWithSelection(text) {
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.top = "0";
  input.style.opacity = "0";
  document.body.appendChild(input);

  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  input.focus({ preventScroll: true });
  input.select();
  input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand("copy");
  input.remove();

  if (previousRange && selection) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }
  return copied;
}

async function writeClipboardText(text) {
  try {
    window.focus();
    if (navigator.clipboard?.writeText && document.hasFocus()) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy path for unfocused windows.
  }

  try {
    return copyTextWithSelection(text);
  } catch {
    return false;
  }
}

function markInviteCopied(trigger) {
  if (!trigger) return;
  trigger.classList.add("copied");
  trigger.setAttribute("title", "Invite link copied");
  trigger.setAttribute("aria-label", "Invite link copied");
  setTimeout(() => {
    trigger.classList.remove("copied");
    trigger.setAttribute("title", "Copy invite link");
    trigger.setAttribute("aria-label", "Copy invite link");
  }, 1400);
}

async function copyInvite(trigger) {
  const link = local.appState.session.inviteUrl;
  if (!link) {
    alert("Start an online session first, then LocalLeaf can copy the invite link.");
    return;
  }

  const copied = await writeClipboardText(link);
  if (copied) {
    markInviteCopied(trigger);
    return;
  }

  window.prompt("Copy this invite link:", link);
}

async function stopSession() {
  if (local.sessionStopBusy) return;
  local.sessionStopBusy = true;
  render();
  let failure = null;
  try {
    const result = await api("/api/session/stop", { method: "POST", body: {} });
    if (result?.project && result?.session) local.appState = result;
    else await loadState();
    local.sessionTunnelProviderOverrideId = null;
    local.sessionEndedReason = "Host stopped the session.";
    local.sessionEndedDetail = "Anyone still connected has been told the session ended.";
  } catch (error) {
    failure = error;
  } finally {
    local.sessionStopBusy = false;
    if (["session", "active"].includes(route().view)) render();
  }
  if (failure) {
    showAppNotice(failure.message || "LocalLeaf could not stop sharing.", {
      type: "error",
      title: "Session is still active",
      detail: "Try stopping it again before you close LocalLeaf."
    });
    return;
  }
  showAppNotice("The invite link is inactive and collaborators have been disconnected.", {
    title: "Sharing stopped",
    detail: "You can host again here or use Back to Home when you are ready.",
    timeoutMs: 5200
  });
}

function bindJoin(code) {
  document.querySelector("#joinProject")?.addEventListener("click", async () => {
    const name = document.querySelector("#guestName").value.trim();
    const error = document.querySelector("#joinError");
    error.textContent = "";
    try {
      const result = await api("/api/join", { method: "POST", body: { name, code } });
      local.joinRequestId = result.requestId;
      local.userName = name;
      renderWaiting();
      pollJoinStatus();
    } catch (exception) {
      error.textContent = exception.message;
    }
  });
}

function renderWaiting() {
  app.className = "app-shell app-shell-waiting";
  app.innerHTML = waitingView();
}

async function pollJoinStatus() {
  if (!local.joinRequestId) return;
  let status;
  try {
    status = await api(`/api/join-status?id=${encodeURIComponent(local.joinRequestId)}`);
  } catch (exception) {
    if (exception.status === 404 || exception.status === 410) {
      handleSessionEnded(
        "The host is no longer reachable.",
        "Your join request could not be completed because the session ended or the host connection dropped."
      );
      return;
    }
    showRemoteReconnectNotice("Still waiting for the host connection.");
    setTimeout(pollJoinStatus, 1800);
    return;
  }
  clearRemoteReconnectNotice();
  if (status.status === "approved") {
    local.guestToken = status.token;
    local.userId = status.userId || "";
    sessionStorage.setItem("localleaf.guestToken", status.token);
    await loadState();
    local.selectedFile = local.appState.project.mainFile;
    await loadSelectedFile();
    setView("editor", { token: status.token, name: local.userName });
    return;
  }
  if (status.status === "denied") {
    app.innerHTML = endedView();
    return;
  }
  if (status.status === "removed") {
    handleAccessRevoked("The host removed your access.", status.userId || "");
    return;
  }
  setTimeout(pollJoinStatus, 1200);
}

function bindEditor() {
  if (route().view !== "editor") return;
  if (!local.editorOpenLayoutPrepared) prepareEditorOpenLayout();
  requestEditorMaximize();
  if (isLiveSession()) connectCollab();
  else closeCollab();
  document.querySelector(".log-dock")?.addEventListener("click", (event) => {
    if (!event.target.closest?.("#clearPinnedWarnings")) return;
    local.clearedWarningVersion = local.appState?.compile?.version ?? null;
    local.pinnedCompileWarnings = [];
    const pinned = document.querySelector(".log-pinned");
    if (pinned) pinned.innerHTML = compilePinnedIssuesMarkup();
  });
  document.querySelector("#backToProject")?.addEventListener("click", () => {
    if (local.appState.session.status === "live") setView("session");
    else setView("project");
  });
  document.querySelector("#compileButton")?.addEventListener("click", compile);
  document.querySelector("#exportButton")?.addEventListener("click", showExportModal);
  document.querySelector("#editorMoreButton")?.addEventListener("click", () => {
    if (local.editorMoreMenuOpen) closeEditorMoreMenuInPlace();
    else openEditorMoreMenuInPlace();
  });
  document.querySelector("#saveButton")?.addEventListener("click", saveCurrentFile);
  bindEditorMoreActions();
  document.querySelector("#toggleSourcePane")?.addEventListener("click", () => toggleLayoutPane("source"));
  document.querySelector("#togglePreviewPane")?.addEventListener("click", () => toggleLayoutPane("preview"));
  document.querySelector("#toggleLogs")?.addEventListener("click", () => toggleLayoutPane("logs"));
  document.querySelector("#showFilesPanelInline")?.addEventListener("click", () => setSidebarVisible(true));
  document.querySelector("#hideChatRail")?.addEventListener("click", () => setRightRailVisible(false));
  document.querySelector("#showChatRail")?.addEventListener("click", () => setRightRailVisible(true));
  document.querySelector("#showChatRailInline")?.addEventListener("click", () => setRightRailVisible(true));
  document.querySelector("#sidebarResizer")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    local.resizingSidebar = true;
    document.body.classList.add("is-resizing-sidebar");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  });
  document.querySelector("#sourcePreviewResizer")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    local.resizingSplit = true;
    document.body.classList.add("is-resizing-split");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  });
  document.querySelector("#rightRailResizer")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    local.resizingRightRail = true;
    document.body.classList.add("is-resizing-right-rail");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  });
  document.querySelector("#logResizer")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    local.resizingLogs = true;
    document.body.classList.add("is-resizing-logs");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  });
  bindSidebarSectionResizers();
  clampSidebarSections();
  bindSidebarControls();

  bindEditorToolbar();
  bindRightRailControls();
  mountActiveEditor();
  applyProjectMutationAccessUi();
  bindPdfPreviewControls();
  bindPdfWheelZoom();
  bindPdfPreviewInteractions();
  mountPdfPreview();

  document.querySelector("#chatForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.querySelector("#chatText");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    await api("/api/chat", { method: "POST", body: { author: local.userName, message } });
  });
}

function bindSidebarSectionResizers() {
  document.querySelectorAll("[data-sidebar-section-resizer]").forEach((handle) => {
    handle.onpointerdown = (event) => {
      event.preventDefault();
      local.resizingSidebarSection = handle.dataset.sidebarSectionResizer || "";
      local.sidebarSectionLayoutAutoSized = false;
      document.body.classList.add("is-resizing-sidebar-section");
      handle.setPointerCapture?.(event.pointerId);
    };
  });
}

function sidebarSectionMetrics() {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return null;
  const head = sidebar.querySelector(".files-panel-head");
  const search = sidebar.querySelector(".file-search");
  const handleHeight = 7;
  const minFiles = 130;
  const minImages = 86;
  const minOutline = 120;
  const fixedHeight = (head?.offsetHeight || 0) + (search?.offsetHeight || 0) + handleHeight * 2;
  const available = Math.max(minFiles + minImages + minOutline, sidebar.clientHeight - fixedHeight);
  return { sidebar, head, search, handleHeight, minFiles, minImages, minOutline, available };
}

function clampSidebarSections(nextFiles = local.fileSectionHeight, nextImages = local.imageSectionHeight, options = {}) {
  const persist = options.persist !== false;
  const metrics = sidebarSectionMetrics();
  const minFiles = metrics?.minFiles || 130;
  const minImages = metrics?.minImages || 86;
  const minOutline = metrics?.minOutline || 120;
  const available = metrics?.available || 520;
  if (local.sidebarSectionLayoutNeedsDefault || !nextFiles || !nextImages) {
    nextImages = Math.max(minImages, Math.min(170, Math.round(available * 0.16)));
    nextFiles = Math.max(minFiles, Math.round((available - nextImages) * 0.72));
    local.sidebarSectionLayoutNeedsDefault = false;
    local.sidebarSectionLayoutAutoSized = true;
    if (persist) localStorage.setItem("localleaf.sidebarSectionLayoutVersion", SIDEBAR_SECTION_LAYOUT_VERSION);
  }
  const maxFiles = Math.max(minFiles, available - minImages - minOutline);
  const files = Math.max(minFiles, Math.min(maxFiles, Math.round(nextFiles)));
  const maxImages = Math.max(minImages, available - files - minOutline);
  const images = Math.max(minImages, Math.min(maxImages, Math.round(nextImages)));
  local.fileSectionHeight = files;
  local.imageSectionHeight = images;
  if (persist) {
    localStorage.setItem("localleaf.fileSectionHeight", String(files));
    localStorage.setItem("localleaf.imageSectionHeight", String(images));
  }
  applySidebarSectionStyles();
}

function applySidebarSectionStyles() {
  const shell = document.querySelector(".editor-shell");
  if (!shell) return;
  shell.style.setProperty("--files-section-height", `${local.fileSectionHeight}px`);
  shell.style.setProperty("--images-section-height", `${local.imageSectionHeight}px`);
}

function bindSidebarControls() {
  const bindClick = (selector, handler) => {
    const element = document.querySelector(selector);
    if (element) {
      element.onclick = (event) => {
        event.preventDefault();
        handler();
      };
    }
  };
  bindClick("#newFile", createFile);
  bindClick("#newFolder", createFolder);
  bindClick("#uploadFile", uploadProjectFile);
  bindClick("#renameFile", renameSelectedFile);
  const deleteButton = document.querySelector("#deleteFile");
  if (deleteButton) {
    deleteButton.onclick = (event) => {
      event.preventDefault();
      deleteSelectedFile(event.currentTarget);
    };
  }
  bindClick("#hideFilesPanel", () => setSidebarVisible(false));
  bindFileTreeInteractions();
  bindTreeContextMenu();
}

function bindFileTreeInteractions() {
  const canEditProject = canMutateProject();
  const createDraft = document.querySelector(".tree-create-draft");
  if (createDraft) {
    const input = createDraft.querySelector(".tree-create-input");
    createDraft.addEventListener("submit", async (event) => {
      event.preventDefault();
      await commitTreeCreateDraft(input);
    });
    createDraft.querySelector("[data-tree-create-cancel]")?.addEventListener("click", (event) => {
      event.preventDefault();
      cancelTreeCreateDraft();
    });
    input?.addEventListener("input", () => {
      if (!local.treeCreateDraft) return;
      local.treeCreateDraft.name = input.value;
      local.treeCreateDraft.error = "";
      createDraft.querySelector(".tree-create-error")?.remove();
      input.removeAttribute("aria-invalid");
    });
    input?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelTreeCreateDraft();
    });
  }
  document.querySelectorAll(".file-button").forEach((button) => {
    const requestRename = (event) => {
      if (!canEditProject) return;
      if (event.target?.closest?.(".tree-rename-wrap")) return;
      if (button.dataset.selectable !== "1") return;
      event.preventDefault();
      event.stopPropagation();
      startInlineRename(button.dataset.file);
    };
    button.addEventListener("mousedown", (event) => {
      if (event.detail >= 2) requestRename(event);
    });
    button.addEventListener("dblclick", requestRename);
    button.addEventListener("contextmenu", (event) => {
      showTreeContextMenu(event, button.dataset.file);
    });
    button.addEventListener("click", async (event) => {
      if (event.target?.closest?.(".tree-rename-wrap")) return;
      if (button.dataset.selectable !== "1") return;
      if (event.detail > 1 && canEditProject) {
        startInlineRename(button.dataset.file);
        return;
      }
      await selectProjectFile(button.dataset.file);
    });
  });
  document.querySelectorAll(".folder-toggle").forEach((button) => {
    const requestRename = (event) => {
      if (!canEditProject) return;
      if (event.target.closest?.(".tree-rename-wrap")) return;
      event.preventDefault();
      event.stopPropagation();
      startInlineRename(button.dataset.folder);
    };
    button.addEventListener("mousedown", (event) => {
      if (event.detail >= 2) requestRename(event);
    });
    button.addEventListener("dblclick", requestRename);
    button.addEventListener("contextmenu", (event) => {
      showTreeContextMenu(event, button.dataset.folder);
    });
    button.addEventListener("click", (event) => {
      if (event.target.closest?.(".tree-rename-wrap")) return;
      const folder = button.dataset.folder;
      if (event.detail > 1 && canEditProject) {
        startInlineRename(folder);
        return;
      }
      local.selectedFolder = folder;
      if (local.collapsedFolders.has(folder)) local.collapsedFolders.delete(folder);
      else local.collapsedFolders.add(folder);
      updateSidebarUi();
    });
  });
  document.querySelector(".file-list")?.addEventListener("contextmenu", (event) => {
    if (event.target.closest?.(".file-button, .tree-folder-row, .tree-rename-wrap, .tree-create-draft")) return;
    showTreeContextMenu(event, "");
  });
  document.querySelector(".image-section-toggle")?.addEventListener("click", () => {
    local.imagesCollapsed = !local.imagesCollapsed;
    updateSidebarUi();
  });
  document.querySelector("#fileSearch")?.addEventListener("input", (event) => {
    local.fileFilter = event.target.value;
    local.focusFileSearch = true;
    if (local.fileFilter.trim()) {
      local.collapsedFolders.clear();
      local.imagesCollapsed = false;
    }
    updateSidebarUi();
  });
  document.querySelector("#fileSearch")?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (local.fileFilter) {
      event.preventDefault();
      local.fileFilter = "";
      local.focusFileSearch = true;
      updateSidebarUi();
    } else {
      event.currentTarget.blur();
    }
  });
  document.querySelectorAll(".tree-rename-input").forEach((input) => {
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("input", () => {
      local.renameError = "";
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
      input.closest(".tree-rename-wrap")?.querySelector(".tree-rename-error")?.remove();
    });
    input.closest(".tree-rename-wrap")?.addEventListener("mousedown", (event) => event.stopPropagation());
    input.closest(".tree-rename-wrap")?.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("dragstart", (event) => event.stopPropagation());
    input.addEventListener("keydown", async (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        await commitInlineRename(input);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelInlineRename();
      }
    });
    input.closest(".tree-rename-wrap")?.querySelector("[data-tree-rename-confirm]")?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await commitInlineRename(input);
    });
    input.closest(".tree-rename-wrap")?.querySelector("[data-tree-rename-cancel]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      cancelInlineRename();
    });
  });
  bindTreeDragAndDrop();
}

function bindTreeContextMenu() {
  const menu = document.querySelector(".tree-context-menu");
  if (!menu) return;
  menu.querySelectorAll("[data-tree-menu-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      await handleTreeContextMenuAction(button.dataset.treeMenuAction);
    });
  });
}

function bindTreeDragAndDrop() {
  if (!canMutateProject()) {
    document.querySelectorAll("[data-drag-path]").forEach((item) => {
      item.draggable = false;
      item.removeAttribute("draggable");
    });
    return;
  }
  document.querySelectorAll("[data-drag-path]").forEach((item) => {
    item.addEventListener("dragstart", (event) => {
      local.draggedTreePath = item.dataset.dragPath || "";
      local.draggedTreeKind = item.dataset.dragKind || "";
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", local.draggedTreePath);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      document.querySelectorAll(".tree-drop-target").forEach((target) => target.classList.remove("tree-drop-target"));
      document.querySelector(".file-list")?.classList.remove("tree-root-drop-target");
      local.draggedTreePath = "";
      local.draggedTreeKind = "";
    });
  });

  document.querySelectorAll("[data-drop-folder]").forEach((target) => {
    target.addEventListener("dragover", (event) => {
      if (!canDropTreeItem(local.draggedTreePath, target.dataset.dropFolder || "")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      target.classList.add("tree-drop-target");
      document.querySelector(".file-list")?.classList.remove("tree-root-drop-target");
    });
    target.addEventListener("dragleave", () => {
      target.classList.remove("tree-drop-target");
    });
    target.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      target.classList.remove("tree-drop-target");
      const sourcePath = local.draggedTreePath || event.dataTransfer.getData("text/plain");
      await moveTreeItemToFolder(sourcePath, target.dataset.dropFolder || "");
    });
  });

  const root = document.querySelector(".file-list");
  root?.addEventListener("dragover", (event) => {
    if (event.target.closest?.("[data-drop-folder]")) return;
    if (!canDropTreeItem(local.draggedTreePath, "")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    root.classList.add("tree-root-drop-target");
  });
  root?.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && root.contains(event.relatedTarget)) return;
    root.classList.remove("tree-root-drop-target");
  });
  root?.addEventListener("drop", async (event) => {
    if (event.target.closest?.("[data-drop-folder]")) return;
    event.preventDefault();
    root.classList.remove("tree-root-drop-target");
    const sourcePath = local.draggedTreePath || event.dataTransfer.getData("text/plain");
    await moveTreeItemToFolder(sourcePath, "");
  });
}

function setEditorStyleMenuOpen(open, { focusOption = "", restoreTrigger = false } = {}) {
  local.editorStyleMenuOpen = Boolean(open);
  if (local.editorStyleMenuOpen) {
    local.searchOpen = false;
    local.tablePickerOpen = false;
  }
  refreshEditorToolbarPanels();
  const trigger = document.querySelector("#editorStyleButton");
  const options = [...document.querySelectorAll(".editor-style-menu [role='menuitem']")];
  if (local.editorStyleMenuOpen && focusOption) {
    (focusOption === "last" ? options.at(-1) : options[0])?.focus({ preventScroll: true });
  } else if (!local.editorStyleMenuOpen && restoreTrigger) {
    trigger?.focus({ preventScroll: true });
  }
}

function bindEditorToolbar() {
  document.querySelectorAll("[data-editor-mode]").forEach((button) => {
    button.addEventListener("click", () => setEditorMode(button.dataset.editorMode));
  });
  document.querySelectorAll("[data-editor-command]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!requireProjectMutationAccess("format project text")) return;
      const command = button.dataset.editorCommand;
      if (command === "table" && local.visualEditor) {
        local.visualEditor.exec(command);
        return;
      }
      if (local.codeEditor) local.codeEditor.exec(command);
      else local.visualEditor?.exec(command);
    });
  });
  const quickSearchLauncher = document.querySelector("#editorSearchLauncher");
  const quickSearchSurface = quickSearchLauncher?.querySelector(".editor-search-launcher-surface");
  const quickSearchInput = document.querySelector("#editorQuickSearchInput");
  quickSearchSurface?.addEventListener("click", (event) => {
    if (event.target.closest("button, input")) return;
    quickSearchInput?.focus();
  });
  quickSearchInput?.addEventListener("input", (event) => {
    setEditorSearchQuery(event.currentTarget.value);
  });
  quickSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (local.searchOpen) runEditorSearch(event.shiftKey ? "prev" : "next");
      else openEditorSearchPanel();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (local.searchOpen) closeEditorSearchPanel();
      else {
        quickSearchInput.blur();
        local.codeEditor?.focus?.();
      }
    }
  });
  document.querySelector("#editorSearchToggle")?.addEventListener("click", () => {
    if (local.searchOpen) closeEditorSearchPanel();
    else openEditorSearchPanel();
  });
  document.querySelector("#editorStyleButton")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = !local.editorStyleMenuOpen;
    setEditorStyleMenuOpen(opening, { focusOption: opening && event.detail === 0 ? "first" : "" });
  });
  bindEditorStyleMenu();
  document.querySelector("#editorSearchToggle")?.classList.toggle("active", local.searchOpen);
  document.querySelector("#editorSearchToggle")?.setAttribute("aria-expanded", local.searchOpen ? "true" : "false");
  quickSearchLauncher?.classList.toggle("is-open", local.searchOpen);
  document.querySelector("#editorTableButton")?.classList.toggle("active", local.tablePickerOpen);
  positionToolbarPopover(".editor-search-popover", "#editorSearchToggle", "center");
  positionToolbarPopover(".editor-table-popover", "#editorTableButton", "start");
  bindEditorToolbarPanels();
}

function bindEditorStyleMenu() {
  const trigger = document.querySelector("#editorStyleButton");
  if (trigger && trigger.dataset.styleKeyboardBound !== "true") {
    trigger.dataset.styleKeyboardBound = "true";
    trigger.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Escape") {
        setEditorStyleMenuOpen(false, { restoreTrigger: true });
        return;
      }
      const focusOption = event.key === "ArrowUp" || event.key === "End" ? "last" : "first";
      setEditorStyleMenuOpen(true, { focusOption });
    });
  }
  const options = [...document.querySelectorAll("[data-style-value]")];
  options.forEach((button, index) => {
    if (button.dataset.styleBound === "true") return;
    button.dataset.styleBound = "true";
    button.addEventListener("click", () => {
      if (!requireProjectMutationAccess("format project text")) return;
      const value = button.dataset.styleValue || "normal";
      if (local.codeEditor) local.codeEditor.exec("style", value);
      else local.visualEditor?.exec("style", value);
      setEditorStyleMenuOpen(false, { restoreTrigger: true });
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setEditorStyleMenuOpen(false, { restoreTrigger: true });
        return;
      }
      if (event.key === "Tab") {
        window.setTimeout(() => setEditorStyleMenuOpen(false), 0);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[nextIndex]?.focus({ preventScroll: true });
    });
  });
}

function bindEditorToolbarPanels() {
  const searchInput = document.querySelector("#editorSearchInput");
  const replaceInput = document.querySelector("#editorReplaceInput");
  searchInput?.addEventListener("input", (event) => {
    setEditorSearchQuery(event.target.value);
  });
  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runEditorSearch(event.shiftKey ? "prev" : "next");
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeEditorSearchPanel();
    }
  });
  replaceInput?.addEventListener("input", (event) => {
    local.searchReplace = event.target.value;
  });
  replaceInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runEditorReplace(event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeEditorSearchPanel();
    }
  });
  document.querySelector("#searchPrevious")?.addEventListener("click", () => runEditorSearch("prev"));
  document.querySelector("#searchNext")?.addEventListener("click", () => runEditorSearch("next"));
  document.querySelector("#replaceOne")?.addEventListener("click", () => runEditorReplace(false));
  document.querySelector("#replaceAll")?.addEventListener("click", () => runEditorReplace(true));
  document.querySelector("#closeSearchPanel")?.addEventListener("click", () => {
    closeEditorSearchPanel();
  });
  document.querySelectorAll("[data-search-scope]").forEach((button) => {
    button.addEventListener("click", () => setSearchScope(button.dataset.searchScope));
  });
  const toggleSearchOption = (key) => {
    local[key] = !local[key];
    refreshEditorToolbarPanels();
    if (local.searchScope === "project") scheduleProjectSearch(0);
  };
  document.querySelector("#searchMatchCase")?.addEventListener("click", () => {
    toggleSearchOption("searchMatchCase");
  });
  document.querySelector("#searchRegex")?.addEventListener("click", () => {
    toggleSearchOption("searchRegex");
  });
  document.querySelector("#searchWholeWord")?.addEventListener("click", () => {
    toggleSearchOption("searchWholeWord");
  });
  bindProjectSearchResults();
  document.querySelector("#tableFromText")?.addEventListener("click", () => insertVisualTable(2, 2));
  const tableCells = [...document.querySelectorAll(".table-size-cell")];
  const tableHint = document.querySelector("#tableSizeHint");
  const updateTablePreview = (rows = 0, cols = 0) => {
    tableCells.forEach((cell) => {
      const cellRows = Number(cell.dataset.rows || 0);
      const cellCols = Number(cell.dataset.cols || 0);
      cell.classList.toggle("preview-active", cellRows <= rows && cellCols <= cols);
    });
    if (tableHint) tableHint.textContent = rows && cols ? `${rows} x ${cols}` : "Select size";
  };
  document.querySelector(".table-size-grid")?.addEventListener("mouseleave", () => updateTablePreview());
  tableCells.forEach((button) => {
    button.addEventListener("mouseenter", () => {
      updateTablePreview(Number(button.dataset.rows || 0), Number(button.dataset.cols || 0));
    });
    button.addEventListener("focus", () => {
      updateTablePreview(Number(button.dataset.rows || 0), Number(button.dataset.cols || 0));
    });
    button.addEventListener("click", () => {
      insertVisualTable(Number(button.dataset.rows || 2), Number(button.dataset.cols || 2));
    });
  });
}

function bindSourceControls() {
  mountActiveEditor();
}

function toggleLayoutPane(pane) {
  if (pane === "sidebar") {
    local.sidebarVisible = !local.sidebarVisible;
    localStorage.setItem("localleaf.sidebarVisible", local.sidebarVisible ? "1" : "0");
  } else if (pane === "source") {
    local.sourcePaneVisible = !local.sourcePaneVisible;
    if (!local.sourcePaneVisible && !local.previewPaneVisible) {
      local.previewPaneVisible = true;
      localStorage.setItem("localleaf.previewPaneVisible", "1");
    }
    localStorage.setItem("localleaf.sourcePaneVisible", local.sourcePaneVisible ? "1" : "0");
  } else if (pane === "preview") {
    local.previewPaneVisible = !local.previewPaneVisible;
    if (!local.previewPaneVisible && !local.sourcePaneVisible) {
      local.sourcePaneVisible = true;
      localStorage.setItem("localleaf.sourcePaneVisible", "1");
    }
    localStorage.setItem("localleaf.previewPaneVisible", local.previewPaneVisible ? "1" : "0");
  } else if (pane === "right") {
    local.rightRailVisible = !local.rightRailVisible;
    localStorage.setItem("localleaf.rightRailVisible", local.rightRailVisible ? "1" : "0");
  } else if (pane === "logs") {
    local.logsVisible = !local.logsVisible;
    localStorage.setItem("localleaf.logsVisible", local.logsVisible ? "1" : "0");
  }
  applyEditorLayoutState();
}

function setSidebarVisible(visible) {
  local.sidebarVisible = visible;
  localStorage.setItem("localleaf.sidebarVisible", visible ? "1" : "0");
  applyEditorLayoutState();
}

function setRightRailVisible(visible) {
  local.rightRailVisible = visible;
  localStorage.setItem("localleaf.rightRailVisible", visible ? "1" : "0");
  applyEditorLayoutState();
}

function applyEditorLayoutState() {
  const shell = document.querySelector(".editor-shell");
  if (!shell) return;
  const wasCollapsed = {
    sidebar: shell.classList.contains("sidebar-collapsed"),
    source: shell.classList.contains("source-collapsed"),
    preview: shell.classList.contains("preview-collapsed"),
    rightRail: shell.classList.contains("right-rail-collapsed"),
    logs: shell.classList.contains("logs-hidden")
  };
  shell.classList.toggle("sidebar-collapsed", !local.sidebarVisible);
  shell.classList.toggle("source-collapsed", !local.sourcePaneVisible);
  shell.classList.toggle("preview-collapsed", !local.previewPaneVisible);
  shell.classList.toggle("right-rail-collapsed", !local.rightRailVisible);
  shell.classList.toggle("logs-hidden", !local.logsVisible);
  if (wasCollapsed.sidebar && local.sidebarVisible) playEditorPaneEnter(shell, "sidebar-opening");
  if (wasCollapsed.source && local.sourcePaneVisible) playEditorPaneEnter(shell, "source-opening");
  if (wasCollapsed.preview && local.previewPaneVisible) playEditorPaneEnter(shell, "preview-opening");
  if (wasCollapsed.rightRail && local.rightRailVisible) playEditorPaneEnter(shell, "right-rail-opening");
  if (wasCollapsed.logs && local.logsVisible) playEditorPaneEnter(shell, "logs-opening");
  applySidebarSectionStyles();
  document.querySelector("#toggleSourcePane")?.classList.toggle("active", local.sourcePaneVisible);
  document.querySelector("#togglePreviewPane")?.classList.toggle("active", local.previewPaneVisible);
  document.querySelector("#toggleLogs")?.classList.toggle("active", local.logsVisible);
}

function playEditorPaneEnter(shell, className) {
  if (!shell || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
  shell.classList.add(className);
  window.setTimeout(() => {
    if (shell.isConnected) shell.classList.remove(className);
  }, 280);
}

function updateSidebarUi() {
  const state = local.appState;
  const file = local.selectedFile;
  const textFiles = state.project.files.filter((item) => item.type === "text");
  const fileList = document.querySelector(".file-list");
  if (fileList) {
    fileList.innerHTML = `${treeCreateDraftMarkup()}${renderProjectTree(state.project.files, file)}`;
  }
  const imagePanel = document.querySelector(".sidebar-images-panel");
  if (imagePanel) {
    imagePanel.innerHTML = renderImageGroup(state.project.files, file);
  }
  const count = document.querySelector(".files-title span");
  if (count) count.textContent = `${textFiles.length} editable`;
  const search = document.querySelector("#fileSearch");
  if (search && search.value !== local.fileFilter) search.value = local.fileFilter;
  clampSidebarSections();
  bindSidebarSectionResizers();
  bindSidebarControls();
  settleEditorUi();
}

function updateEditorSourceUi() {
  const state = local.appState;
  const file = local.selectedFile || state.project.mainFile;
  const selection = selectedFileState(file);
  const breadcrumb = document.querySelector(".editor-breadcrumb");
  if (breadcrumb) breadcrumb.innerHTML = editorBreadcrumbMarkup(file, selection);
  syncEditorModeUi();

  const codePanel = document.querySelector(".code-panel");
  const oldSurface = codePanel?.querySelector(".editor-code-mount, .editor-visual-mount, #editorText, .asset-preview");
  if (oldSurface) {
    // Keep the initiating PDF navigation current while the mapped file swaps
    // the editor surface; full route/preview teardown still cancels it.
    destroyEditorSurfaces({
      cancelPdfPreview: false,
      cancelPdfSourceNavigation: false,
      cancelPdfReviewNavigation: false
    });
    oldSurface.outerHTML = editorSurfaceMarkup(file, selection.selectedMeta);
  }

  document.querySelectorAll(".file-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.file === file);
  });

    const outline = document.querySelector(".outline");
    if (outline) {
      outline.classList.toggle("muted-outline", !selection.canEditSelected);
      const currentTitle = selection.outline.find((item) => item?.title)?.title || "";
      outline.innerHTML = `
        <h3>File outline</h3>
        ${selection.canEditSelected ? outlineTreeMarkup(selection.outline, currentTitle) : `<div class="outline-empty">Open a text file to view outline.</div>`}
      `;
    }

  const saveButton = document.querySelector("#saveButton");
  if (saveButton) saveButton.disabled = !selection.canEditSelected || !canMutateProject();
  const mainButton = document.querySelector("#setMainFile");
  if (mainButton) mainButton.disabled = !selection.canSetMain;
  const status = document.querySelector(".editor-subtitle");
  if (status) status.textContent = local.saveStatus;

  bindSourceControls();
  updateEditorDiagnostics();
  applyProjectMutationAccessUi();
}

function updateChatPanel() {
  const list = document.querySelector(".chat-list");
  if (!list || !local.appState) return;
  list.innerHTML = local.appState.chat.length
    ? local.appState.chat.map(chatMessageMarkup).join("")
    : chatEmptyMarkup();
  settleEditorUi();
}

function updateUsersPresenceUi() {
  const list = document.querySelector(".users-list");
  if (!list || !local.appState) return;
  const users = Array.isArray(local.appState.session.users) ? local.appState.session.users : [];
  list.innerHTML = users.map((user) => `
    <div class="user-row">
      <div class="avatar">${escapeHtml(user.name[0] || "?")}</div>
      <div>
        <strong>${escapeHtml(user.name)}</strong><br />
        <small>${escapeHtml(user.role)}${activeFileForUser(user.id) ? ` · ${escapeHtml(activeFileForUser(user.id))}` : ""}</small>
      </div>
      <span class="online-dot ${user.online ? "" : "offline"}" title="${user.online ? "Online" : "Offline"}"></span>
    </div>
  `).join("");
  const summary = document.querySelector(".chat-users-head span");
  if (summary) {
    const onlineCount = users.filter((user) => user.online !== false).length;
    summary.textContent = `${users.length} participant${users.length === 1 ? "" : "s"} · ${onlineCount} online`;
  }
}

function updateCompileUi(options = {}) {
  if (!local.appState) return;
  const compile = local.appState.compile;
  const isCompiling = local.compileBusy || compile.status === "running";
  const canCompile = !isGuestClient();
  syncPinnedCompileIssues(compile);
  const button = document.querySelector("#compileButton");
  if (button) {
    button.disabled = isCompiling || !canCompile;
    button.classList.toggle("compiling", isCompiling);
    const label = button.querySelector("span:last-child");
    if (label) label.textContent = isCompiling
      ? (local.compilePhase === "saving" ? "Saving..." : "Compiling...")
      : canCompile ? "Recompile" : "Host compiles";
  }

  const previewActions = document.querySelector(".preview-actions");
  if (previewActions) {
    previewActions.innerHTML = previewActionsMarkup(compile);
    bindPdfPreviewControls();
    bindPdfPreviewInteractions();
  }

  const logs = document.querySelector(".logs");
  if (logs) logs.innerHTML = compileLogsMarkup(compile.logs || []);
  updateEditorDiagnostics();
  const pinnedLogs = document.querySelector(".log-pinned");
  if (pinnedLogs) pinnedLogs.innerHTML = compilePinnedIssuesMarkup();
  const logTabs = document.querySelector(".log-tabs");
  if (logTabs) {
    logTabs.innerHTML = `<button class="active">Logs</button>${compileLogSummaryMarkup(compile.logs || [])}`;
  }

  const previewPane = document.querySelector("#previewPane");
  if (!previewPane) return;
  const existingOverlay = previewPane.querySelector(".compile-overlay");
  if (isCompiling) {
    const overlayMarkup = `<span class="big-spinner"></span><strong>${escapeHtml(compileBusyLabel())}</strong>`;
    if (!existingOverlay) {
      previewPane.insertAdjacentHTML("afterbegin", `<div class="compile-overlay">${overlayMarkup}</div>`);
    } else {
      existingOverlay.innerHTML = overlayMarkup;
    }
    return;
  }

  if (existingOverlay) existingOverlay.remove();
  if (options.refreshPreview) {
    const scrollState = options.previewScroll || capturePreviewScroll(previewPane);
    previewPane.innerHTML = compiledPreviewMarkup();
    if (!mountPdfPreview(scrollState)) {
      restorePreviewScroll(scrollState, previewPane);
    }
  }
}

function shouldApplyCompileUpdate(nextCompile) {
  const currentCompile = local.appState?.compile;
  if (!currentCompile) return true;
  const currentVersion = Number(currentCompile.version || 0);
  const nextVersion = Number(nextCompile?.version || 0);
  if (nextVersion < currentVersion) return false;
  if (
    nextVersion === currentVersion
    && String(nextCompile?.status || "") === String(currentCompile.status || "")
    && String(nextCompile?.jobId || "") === String(currentCompile.jobId || "")
    && (nextCompile?.logs || []).length <= (currentCompile.logs || []).length
  ) {
    return false;
  }
  if (nextVersion === currentVersion && currentCompile.status !== "running" && nextCompile?.status === "running") {
    return false;
  }
  return true;
}

let resizePointerFrame = 0;
let pendingResizePointer = null;

function applyResizePointer(event) {
  if (local.resizingSidebar) {
    const grid = document.querySelector(".editor-grid");
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const width = Math.max(220, Math.min(460, Math.round(event.clientX - rect.left)));
    local.sidebarWidth = width;
    grid.style.setProperty("--sidebar-width", `${width}px`);
    document.querySelector(".editor-shell")?.style.setProperty("--sidebar-width", `${width}px`);
    return;
  }

  if (local.resizingSidebarSection) {
    const metrics = sidebarSectionMetrics();
    if (!metrics) return;
    const rect = metrics.sidebar.getBoundingClientRect();
    const fixedTop = (metrics.head?.offsetHeight || 0) + (metrics.search?.offsetHeight || 0);
    const y = Math.round(event.clientY - rect.top - fixedTop);
    if (local.resizingSidebarSection === "files") {
      clampSidebarSections(y, local.imageSectionHeight, { persist: false });
    } else if (local.resizingSidebarSection === "images") {
      clampSidebarSections(local.fileSectionHeight, y - local.fileSectionHeight - metrics.handleHeight, { persist: false });
    }
    return;
  }

  if (local.resizingSplit) {
    const codePanel = document.querySelector(".code-panel");
    const previewPanel = document.querySelector(".preview-panel");
    const shell = document.querySelector(".editor-shell");
    if (!codePanel || !previewPanel || !shell) return;
    const codeRect = codePanel.getBoundingClientRect();
    const previewRect = previewPanel.getBoundingClientRect();
    const totalWidth = Math.max(0, previewRect.right - codeRect.left);
    const minSource = Math.min(340, Math.max(260, totalWidth - 360));
    const maxSource = Math.max(minSource, totalWidth - 340);
    const width = Math.max(minSource, Math.min(maxSource, Math.round(event.clientX - codeRect.left)));
    local.sourcePaneWidth = width;
    shell.style.setProperty("--source-width", `${width}px`);
    return;
  }

  if (local.resizingRightRail) {
    const grid = document.querySelector(".editor-grid");
    const shell = document.querySelector(".editor-shell");
    if (!grid || !shell) return;
    const rect = grid.getBoundingClientRect();
    const maxWidth = Math.max(240, Math.min(540, Math.round(rect.width * 0.38)));
    const width = Math.max(220, Math.min(maxWidth, Math.round(rect.right - event.clientX)));
    local.rightRailWidth = width;
    shell.style.setProperty("--right-rail-width", `${width}px`);
    return;
  }

  if (local.resizingLogs) {
    const shell = document.querySelector(".editor-shell");
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const maxHeight = Math.max(92, Math.min(420, Math.round(rect.height - 220)));
    const height = Math.max(72, Math.min(maxHeight, Math.round(rect.bottom - event.clientY)));
    local.logsHeight = height;
    shell.style.setProperty("--logs-height", `${height}px`);
  }
}

window.addEventListener("pointermove", (event) => {
  if (!(local.resizingSidebar || local.resizingSidebarSection || local.resizingSplit || local.resizingRightRail || local.resizingLogs)) return;
  pendingResizePointer = { clientX: event.clientX, clientY: event.clientY };
  if (resizePointerFrame) return;
  resizePointerFrame = requestAnimationFrame(() => {
    resizePointerFrame = 0;
    const pointer = pendingResizePointer;
    pendingResizePointer = null;
    if (pointer) applyResizePointer(pointer);
  });
});

function finishResize(event, options = {}) {
  const resizeState = {
    sidebar: local.resizingSidebar,
    sidebarSection: local.resizingSidebarSection,
    split: local.resizingSplit,
    rightRail: local.resizingRightRail,
    logs: local.resizingLogs
  };
  if (!(resizeState.sidebar || resizeState.sidebarSection || resizeState.split || resizeState.rightRail || resizeState.logs)) return false;
  if (resizePointerFrame) cancelAnimationFrame(resizePointerFrame);
  resizePointerFrame = 0;
  const eventPointer = Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
    ? { clientX: event.clientX, clientY: event.clientY }
    : null;
  const finalPointer = options.useEventPointer === false ? pendingResizePointer : eventPointer || pendingResizePointer;
  pendingResizePointer = null;
  if (finalPointer) applyResizePointer(finalPointer);
  try {
    if (resizeState.sidebar) localStorage.setItem("localleaf.sidebarWidth", String(local.sidebarWidth));
    if (resizeState.sidebarSection) {
      localStorage.setItem("localleaf.fileSectionHeight", String(local.fileSectionHeight));
      localStorage.setItem("localleaf.imageSectionHeight", String(local.imageSectionHeight));
      localStorage.setItem("localleaf.sidebarSectionLayoutVersion", SIDEBAR_SECTION_LAYOUT_VERSION);
    }
    if (resizeState.split) localStorage.setItem("localleaf.sourcePaneWidth", String(local.sourcePaneWidth));
    if (resizeState.rightRail) localStorage.setItem("localleaf.rightRailWidth", String(local.rightRailWidth));
    if (resizeState.logs) localStorage.setItem("localleaf.logsHeight", String(local.logsHeight));
  } finally {
    local.resizingSidebar = false;
    local.resizingSidebarSection = "";
    local.resizingSplit = false;
    local.resizingRightRail = false;
    local.resizingLogs = false;
    document.body.classList.remove("is-resizing-sidebar");
    document.body.classList.remove("is-resizing-sidebar-section");
    document.body.classList.remove("is-resizing-split");
    document.body.classList.remove("is-resizing-right-rail");
    document.body.classList.remove("is-resizing-logs");
  }
  return true;
}

window.addEventListener("pointerup", (event) => {
  finishResize(event);
});

window.addEventListener("pointercancel", () => {
  finishResize(null, { useEventPointer: false });
});

window.addEventListener("lostpointercapture", () => {
  finishResize(null, { useEventPointer: false });
});

window.addEventListener("blur", () => {
  finishResize(null, { useEventPointer: false });
});

window.addEventListener("resize", () => {
  if (route().view !== "editor" || !local.sidebarSectionLayoutAutoSized || local.resizingSidebarSection) return;
  local.sidebarSectionLayoutNeedsDefault = true;
  clampSidebarSections(0, 0);
});

function settleEditorUi() {
  const chatList = document.querySelector(".chat-list");
  if (chatList) {
    chatList.scrollTop = chatList.scrollHeight;
  }
  if (local.focusFileSearch) {
    const search = document.querySelector("#fileSearch");
    if (search) {
      search.focus();
      search.selectionStart = search.selectionEnd = search.value.length;
    }
    local.focusFileSearch = false;
  }
  focusRenameInput();
  focusTreeCreateDraft();
}

async function saveCurrentFile() {
  if (!canMutateProject()) return true;
  if (!local.selectedFile) return true;
  if (!isEditableFile(fileMeta(local.selectedFile))) return true;
  prepareEditorForPersistence();
  clearTimeout(local.saveTimer);
  local.editorContent = currentEditorText();
  if (isLiveSession()) {
    const status = document.querySelector(".editor-subtitle");
    local.saveStatus = "Saving...";
    if (status) status.textContent = local.saveStatus;
    const saved = await requestCollabSave(local.selectedFile, local.editorContent);
    if (saved) {
      local.saveStatus = "Saved";
      if (status) status.textContent = local.saveStatus;
      return true;
    }
    local.saveStatus = "Waiting to reconnect";
    if (status) status.textContent = local.saveStatus;
    showRemoteReconnectNotice("Reconnect before saving or compiling this live document.");
    return false;
  }
  if (local.saving) {
    local.pendingSave = true;
    return local.savePromise;
  }
  local.saving = true;
  local.pendingSave = false;
  local.saveStatus = "Saving...";

  local.savePromise = (async () => {
    let saved = true;
    try {
      await api("/api/file", {
        method: "POST",
        body: {
          path: local.selectedFile,
          content: local.editorContent,
          user: local.userName
        }
      });
      sendCollab("save", { filePath: local.selectedFile });
      local.saveStatus = "Saved";
      refreshEditorSuggestions();
    } catch (error) {
      saved = false;
      local.saveStatus = "Save failed";
      showAppNotice(error.message || "LocalLeaf could not save this file.", {
        type: "error",
        title: "Save failed",
        detail: "Your editor content is still here. Try saving again before compiling."
      });
    } finally {
      local.saving = false;
      local.savePromise = null;
      const status = document.querySelector(".editor-subtitle");
      if (status) status.textContent = local.saveStatus;
    }

    if (local.pendingSave) {
      const pendingSaved = await saveCurrentFile();
      return saved && pendingSaved;
    }
    return saved;
  })();

  return local.savePromise;
}

function focusRenameInput() {
  if (!local.renamingTreePath || local.renameSaving) return;
  const input = document.querySelector(".tree-rename-input");
  if (!input) return;
  input.focus();
  input.select();
}

function focusTreeCreateDraft() {
  if (!local.treeCreateDraft || !local.treeCreateFocus || local.treeCreateDraft.saving) return;
  const input = document.querySelector(".tree-create-input");
  if (!input) return;
  input.focus();
  input.select();
  local.treeCreateFocus = false;
}

function startInlineRename(pathValue) {
  if (!requireProjectMutationAccess("rename project items")) return;
  const item = treeItem(pathValue);
  if (!item || item.type === "binary") return;
  local.treeCreateDraft = null;
  local.treeCreateFocus = false;
  if (item.type === "directory") {
    local.selectedFolder = item.path;
  } else {
    local.selectedFolder = "";
    local.selectedFile = item.path;
    expandToFile(item.path);
  }
  local.renamingTreePath = item.path;
  local.renamingTreeKind = item.type;
  local.renameError = "";
  updateSidebarUi();
}

function cancelInlineRename() {
  if (!local.renamingTreePath) return;
  local.renamingTreePath = "";
  local.renamingTreeKind = "";
  local.renameSaving = false;
  local.renameError = "";
  updateSidebarUi();
}

function showInlineRenameError(message) {
  local.renameError = String(message || "That item could not be renamed.");
  local.renameSaving = false;
  updateSidebarUi();
}

async function commitInlineRename(input) {
  if (!requireProjectMutationAccess("rename project items")) return;
  if (!input || local.renameSaving) return;
  const from = input.dataset.renamePath || "";
  if (!from || local.renamingTreePath !== from) return;
  const entry = treeItem(from);
  if (!entry) {
    cancelInlineRename();
    return;
  }
  const nextName = String(input.value || "").trim();
  const nameError = projectEntryNameError(nextName, entry.type);
  if (nameError) {
    showInlineRenameError(nameError);
    return;
  }
  if (entry.type !== "directory" && !isSupportedProjectFileName(nextName)) {
    showInlineRenameError("Use a supported LaTeX, text, data, image, or PDF file extension.");
    return;
  }
  const nextPath = joinProjectPath(pathDirname(entry.path), nextName);
  if (nextPath === entry.path) {
    local.renamingTreePath = "";
    local.renamingTreeKind = "";
    local.renameError = "";
    updateSidebarUi();
    return;
  }
  if (projectPathExists(nextPath, entry.path)) {
    showInlineRenameError("A file or folder with that name already exists here.");
    return;
  }

  local.renameSaving = true;
  local.renameError = "";
  updateSidebarUi();
  try {
    const result = await api("/api/file/rename", {
      method: "POST",
      body: {
        from: entry.path,
        to: nextPath
      }
    });
    await loadState();
    if (entry.type === "directory") {
      local.selectedFolder = result.path;
      local.selectedFile = pathAfterDirectoryMove(local.selectedFile, entry.path, result.path);
      expandToFile(local.selectedFile);
      if (isEditableFile(fileMeta(local.selectedFile))) await loadSelectedFile();
    } else {
      local.selectedFile = result.path;
      local.selectedFolder = "";
      expandToFile(result.path);
      await loadSelectedFile();
    }
    local.renamingTreePath = "";
    local.renamingTreeKind = "";
    local.renameSaving = false;
    local.renameError = "";
    local.saveStatus = "Renamed";
    render();
  } catch (error) {
    showInlineRenameError(error.message);
  }
}

function startTreeCreateDraft(kind, baseDirOverride = undefined) {
  if (!requireProjectMutationAccess(kind === "folder" ? "create folders" : "create files")) return;
  const baseDir = typeof baseDirOverride === "string" ? baseDirOverride : selectedDirectoryPath();
  const preferredName = kind === "folder" ? "folder" : "untitled.tex";
  const candidateName = pathBasename(uniqueProjectPath(baseDir, preferredName));
  local.renamingTreePath = "";
  local.renamingTreeKind = "";
  local.renameSaving = false;
  local.renameError = "";
  local.treeCreateDraft = {
    kind,
    directory: pathParts(baseDir).join("/"),
    name: candidateName,
    saving: false,
    error: ""
  };
  local.treeCreateFocus = true;
  if (baseDir) {
    local.selectedFolder = baseDir;
    local.collapsedFolders.delete(baseDir);
  }
  updateSidebarUi();
}

function cancelTreeCreateDraft() {
  if (!local.treeCreateDraft || local.treeCreateDraft.saving) return;
  local.treeCreateDraft = null;
  local.treeCreateFocus = false;
  updateSidebarUi();
}

function treeCreateError(message) {
  if (!local.treeCreateDraft) return;
  local.treeCreateDraft.saving = false;
  local.treeCreateDraft.error = String(message || "That item could not be created.");
  local.treeCreateFocus = true;
  updateSidebarUi();
}

async function commitTreeCreateDraft(input) {
  if (!requireProjectMutationAccess("create project items")) return;
  const draft = local.treeCreateDraft;
  if (!draft || draft.saving) return;
  const rawName = String(input?.value ?? draft.name ?? "").trim();
  const nameError = draft.kind === "folder"
    ? projectEntryNameError(rawName, "directory")
    : creatableProjectFileNameError(rawName);
  if (nameError) {
    treeCreateError(nameError);
    return;
  }

  const name = draft.kind === "folder" ? rawName : normalizedNewFileName(rawName);
  const path = joinProjectPath(draft.directory, name);
  if (projectPathExists(path)) {
    treeCreateError("A file or folder with that name already exists here.");
    return;
  }

  draft.name = name;
  draft.error = "";
  draft.saving = true;
  updateSidebarUi();
  try {
    const result = await api(draft.kind === "folder" ? "/api/folder/create" : "/api/file/create", {
      method: "POST",
      body: draft.kind === "folder"
        ? { path }
        : { path, content: path.toLowerCase().endsWith(".tex") ? "% New LocalLeaf file\n" : "" }
    });
    await loadState();
    local.treeCreateDraft = null;
    local.treeCreateFocus = false;
    if (draft.kind === "folder") {
      local.selectedFolder = result.path;
      local.collapsedFolders.delete(result.path);
      local.saveStatus = "Folder created";
      updateSidebarUi();
    } else {
      local.selectedFile = result.path;
      local.selectedFolder = "";
      expandToFile(result.path);
      await loadSelectedFile();
      local.saveStatus = "Created";
      render();
    }
  } catch (error) {
    treeCreateError(error.message);
  }
}

function createFile(baseDirOverride = undefined) {
  startTreeCreateDraft("file", baseDirOverride);
}

function createFolder(baseDirOverride = undefined) {
  startTreeCreateDraft("folder", baseDirOverride);
}

async function uploadProjectFile(baseDirOverride = undefined) {
  if (!requireProjectMutationAccess("upload project files")) return;
  const baseDirOverridePath = typeof baseDirOverride === "string" ? baseDirOverride : undefined;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".tex,.latex,.bib,.bst,.cls,.sty,.clo,.cfg,.def,.ldf,.bbx,.cbx,.bbl,.txt,.md,.tikz,.csv,.dat,.json,.asy,.py,.png,.jpg,.jpeg,.gif,.webp,.svg,.pdf,.eps";
  input.addEventListener("change", async () => {
    const upload = input.files?.[0];
    if (!upload) return;
    if (!isSupportedProjectFileName(upload.name)) {
      showAppNotice(`Unsupported file type: ${upload.name}.`, {
        type: "error",
        title: "Upload failed",
        detail: "Upload LaTeX source/support files, bibliography/data files, or image/PDF assets."
      });
      return;
    }
    const baseDir = baseDirOverridePath ?? selectedDirectoryPath();
    const uploadIsAsset = upload.type.startsWith("image/") || isSupportedImageProjectFileName(upload.name);
    const defaultName = uploadIsAsset && !baseDir ? `images/${upload.name}` : joinProjectPath(baseDir, upload.name);
    const targetPath = normalizeProjectPathInput(prompt("Upload to path:", defaultName));
    if (!targetPath) return;
    if (!isSupportedProjectFileName(targetPath)) {
      showAppNotice(`Unsupported file type: ${importFileName(targetPath) || targetPath}.`, {
        type: "error",
        title: "Upload failed",
        detail: "Keep the file extension as a supported LaTeX, data, image, PDF, or EPS asset."
      });
      return;
    }
    try {
      const buffer = await readImportFileBuffer(upload);
      const result = await api("/api/file/upload", {
        method: "POST",
        headers: {
          "content-type": upload.type || "application/octet-stream",
          "x-file-path": targetPath
        },
        rawBody: buffer
      });
      await loadState();
      local.selectedFile = result.path;
      local.selectedFolder = "";
      expandToFile(result.path);
      const uploadedMeta = fileMeta(result.path);
      if (isImageAsset(uploadedMeta)) {
        local.imagesCollapsed = false;
        local.editorContent = "";
      } else if (isEditableFile(uploadedMeta)) {
        await loadSelectedFile();
      }
      local.saveStatus = `Uploaded ${importFileName(result.path)}`;
      showAppNotice(`${importFileName(result.path)} was saved.`, {
        type: "success",
        title: "Upload saved",
        detail: isImageAsset(uploadedMeta)
          ? "It is available in the Images panel."
          : "It is available in the Files panel.",
        timeoutMs: 3600
      });
      render();
    } catch (error) {
      showAppNotice(error.message, { type: "error", title: "Upload failed" });
    }
  });
  input.click();
}

async function renameSelectedFile() {
  const entry = selectedTreeEntry();
  if (!entry) return;
  startInlineRename(entry.path);
}

function setDeleteFileDialogState(modal, options = {}) {
  if (!modal) return;
  const busy = Boolean(options.busy);
  const status = modal.querySelector("#fileDeleteStatus");
  const cancelButton = modal.querySelector("#cancelFileDelete");
  const deleteButton = modal.querySelector("#confirmFileDelete");
  const itemType = modal.dataset.itemType || "file";
  modal.dataset.busy = busy ? "true" : "false";
  modal.querySelector(".file-delete-dialog")?.setAttribute("aria-busy", busy ? "true" : "false");
  if (cancelButton) cancelButton.disabled = busy;
  if (deleteButton) {
    deleteButton.disabled = busy;
    deleteButton.textContent = busy ? "Deleting..." : `Delete ${itemType}`;
  }
  if (status) {
    const message = options.message || (busy ? `Deleting ${itemType}...` : "");
    status.hidden = !message;
    status.textContent = message;
    status.classList.toggle("is-pending", busy);
    status.classList.toggle("is-error", options.type === "error");
    status.setAttribute("role", options.type === "error" ? "alert" : "status");
    status.setAttribute("aria-live", options.type === "error" ? "assertive" : "polite");
  }
}

function hideDeleteFileDialog(options = {}) {
  const modal = document.querySelector(".file-delete-backdrop");
  const { force = false, ...removeOptions } = options;
  if (modal?.dataset.busy === "true" && !force) return;
  removeModal(modal, {
    fallbackFocusSelector: "#deleteFile",
    ...removeOptions
  });
}

async function confirmDeleteFile(modal, entry) {
  if (!requireProjectMutationAccess("delete project items")) return;
  if (!modal || modal.dataset.busy === "true") return;
  setDeleteFileDialogState(modal, { busy: true });
  try {
    await api("/api/file/delete", {
      method: "POST",
      body: { path: entry.path }
    });
    await loadState();
    local.selectedFolder = "";
    local.selectedFile = local.appState.project.mainFile || local.appState.project.files.find((file) => file.type === "text" || file.type === "image")?.path;
    expandToFile(local.selectedFile);
    await loadSelectedFile();
    local.saveStatus = "Deleted";
    await render();
    removeModal(modal, { restoreFocus: false });
    window.setTimeout(() => {
      const deleteButton = document.querySelector("#deleteFile");
      const fallback = document.querySelector(".file-button.active, #newFile");
      (deleteButton && !deleteButton.disabled ? deleteButton : fallback)?.focus({ preventScroll: true });
    }, 0);
  } catch (error) {
    setDeleteFileDialogState(modal, {
      type: "error",
      message: error?.message || "LocalLeaf could not delete this item."
    });
    modal.querySelector("#confirmFileDelete")?.focus({ preventScroll: true });
  }
}

function deleteSelectedFile(returnFocus = document.activeElement) {
  if (!requireProjectMutationAccess("delete project items")) return;
  const entry = selectedTreeEntry();
  if (!entry) return;
  const itemType = entry.type === "directory" ? "folder" : "file";
  const itemTypeLabel = itemType === "folder" ? "Folder" : "File";
  const existingModal = document.querySelector(".file-delete-backdrop");
  const focusTarget = returnFocus instanceof HTMLElement && returnFocus.isConnected
    ? returnFocus
    : document.querySelector("#deleteFile");
  removeModal(existingModal, { restoreFocus: false });
  document.body.insertAdjacentHTML("beforeend", `
    <div class="file-delete-backdrop" role="presentation" data-item-type="${itemType}" data-busy="false">
      <section class="file-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="fileDeleteTitle" aria-describedby="fileDeleteDescription fileDeleteTarget" aria-busy="false">
        <div class="file-delete-copy">
          <h2 id="fileDeleteTitle">Delete ${itemType}?</h2>
          <p id="fileDeleteDescription">This removes it from the host project folder. This action cannot be undone.</p>
        </div>
        <div class="file-delete-target" id="fileDeleteTarget">
          <span class="file-delete-target-type">${itemTypeLabel}</span>
          <strong class="file-delete-target-name" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</strong>
        </div>
        <p class="file-delete-status" id="fileDeleteStatus" role="status" aria-live="polite" hidden></p>
        <div class="file-delete-actions">
          <button class="btn file-delete-cancel" id="cancelFileDelete" type="button">Cancel</button>
          <button class="btn file-delete-confirm" id="confirmFileDelete" type="button">Delete ${itemType}</button>
        </div>
      </section>
    </div>
  `);

  const modal = document.querySelector(".file-delete-backdrop");
  const entrySnapshot = { path: entry.path, type: entry.type };
  const close = () => hideDeleteFileDialog();
  installModalFocusManagement(modal, focusTarget);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  modal?.querySelector("#cancelFileDelete")?.addEventListener("click", close);
  modal?.querySelector("#confirmFileDelete")?.addEventListener("click", () => {
    void confirmDeleteFile(modal, entrySnapshot);
  });
  window.setTimeout(() => modal?.querySelector("#cancelFileDelete")?.focus({ preventScroll: true }), 0);
}

async function setMainFile() {
  if (!requireProjectMutationAccess("change the main document")) return;
  if (!local.selectedFile) return;
  try {
    await api("/api/project/main-file", {
      method: "POST",
      body: { path: local.selectedFile }
    });
    await loadState();
    local.saveStatus = "Main file updated";
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function compile() {
  if (isGuestClient()) {
    showAppNotice("Only the host can run the LaTeX compiler.", {
      title: "Host-controlled compile",
      detail: "Your edits are shared with the host, who can compile and publish the next PDF preview."
    });
    return false;
  }
  if (local.compileBusy || local.appState?.compile?.status === "running") return false;
  const previewScroll = capturePreviewScroll();
  const previousCompile = {
    ...local.appState.compile,
    logs: [...(local.appState.compile.logs || [])]
  };
  const runId = ++local.compileRunId;
  let refreshPreview = false;
  let compileSucceeded = false;
  local.compileBusy = true;
  local.compilePhase = "saving";
  local.pendingPreviewScroll = previewScroll;
  updateCompileUi();
  try {
    const saved = await saveCurrentFile();
    if (!saved) {
      showAppNotice("Compile canceled because the current file was not saved.", {
        type: "error",
        title: "Compile did not start",
        detail: "Resolve the save error, then recompile."
      });
      return false;
    }

    local.compilePhase = "compiling";
    local.appState.compile.status = "running";
    updateCompileUi();
    const nextCompile = await api("/api/compile", {
      method: "POST",
      body: { requestedBy: local.userName }
    });
    if (runId !== local.compileRunId) return false;
    if (shouldApplyCompileUpdate(nextCompile)) {
      local.appState.compile = nextCompile;
    }
    refreshPreview = local.appState.compile.status !== "running";
    compileSucceeded = local.appState.compile.status === "success";
    if (!compileSucceeded && local.appState.compile.status === "failed") {
      showAppNotice("The latest compile failed.", {
        type: "error",
        title: "Compile failed",
        detail: compileUsesLastGoodPreview(local.appState.compile)
          ? "The preview is showing the last successful PDF. Check the compile log before sharing it."
          : "No current PDF is available. Check the compile log, then try again."
      });
    }
    return compileSucceeded;
  } catch (error) {
    const currentCompile = local.appState.compile;
    const serverFinished = currentCompile.status !== "running"
      && Number(currentCompile.version || 0) >= Number(previousCompile.version || 0);
    if (!serverFinished) {
      local.appState.compile = {
        ...previousCompile,
        status: "failed",
        previewStale: previousCompile.mode === "pdf" && Boolean(previousCompile.pdfPath),
        isStale: previousCompile.mode === "pdf" && Boolean(previousCompile.pdfPath),
        logs: [
          ...(previousCompile.logs || []),
          `Compile request failed: ${error.message || "Unknown error"}`
        ]
      };
    }
    showAppNotice(error.message || "LocalLeaf could not complete the compile request.", {
      type: "error",
      title: "Compile failed",
      detail: compileUsesLastGoodPreview(local.appState.compile)
        ? "The preview is still showing the last successful PDF."
        : "Check the compile log, then try again."
    });
    return false;
  } finally {
    if (runId === local.compileRunId) {
      local.compileBusy = false;
      local.compilePhase = "";
      local.pendingPreviewScroll = null;
      updateCompileUi({ refreshPreview, previewScroll });
    }
  }
}

async function render() {
  if (!local.appState) {
    await loadState();
  }

  let current = route();
  if (isGuestClient() && !["editor", "ended"].includes(current.view)) {
    const params = new URLSearchParams({ view: "editor" });
    if (local.userName && local.userName !== "Host") params.set("name", local.userName);
    history.replaceState({}, "", `/?${params.toString()}`);
    local.view = "editor";
    current = route();
  }
  destroyEditorSurfaces();
  const viewTransition = local.pendingViewTransition?.to === current.view
    ? local.pendingViewTransition
    : null;
  local.pendingViewTransition = null;
  const hostRailView = !isGuestClient() && ["home", "project", "session", "active"].includes(current.view);
  const hostRailMotion = hostRailView && ["expanding", "collapsing"].includes(local.pendingHostRailMotion)
    ? local.pendingHostRailMotion
    : "";
  local.pendingHostRailMotion = "";
  const hostRailEntrance = hostRailView && local.hostRailEntrancePending && !hostRailMotion;
  if (hostRailEntrance) local.hostRailEntrancePending = false;
  if (local.viewMotionTimer) {
    window.clearTimeout(local.viewMotionTimer);
    local.viewMotionTimer = null;
  }
  if (local.hostRailMotionTimer) {
    window.clearTimeout(local.hostRailMotionTimer);
    local.hostRailMotionTimer = null;
  }
  const hostRailMotionClass = hostRailMotion ? ` app-shell-rail-${hostRailMotion}` : hostRailEntrance ? " app-shell-rail-enter" : "";
  app.className = `app-shell app-shell-${current.view}${viewTransition ? " app-shell-view-enter" : ""}${hostRailMotionClass}`;
  if (viewTransition) {
    app.dataset.transitionFrom = viewTransition.from || "home";
    app.dataset.transitionTo = viewTransition.to;
  } else {
    delete app.dataset.transitionFrom;
    delete app.dataset.transitionTo;
  }
  if (current.view === "join") {
    app.innerHTML = joinView(current.code);
    bindJoin(current.code);
    return;
  }

  if (current.view === "project") app.innerHTML = projectView();
  else if (current.view === "session") app.innerHTML = sessionView();
  else if (current.view === "active") app.innerHTML = sessionView();
  else if (current.view === "editor") {
    if (isGuestClient() && local.appState?.session?.status !== "live") {
      app.innerHTML = endedView();
      bindCommon();
      return;
    }
    if (!local.editorContent) await loadSelectedFile();
    app.innerHTML = editorView();
  } else if (current.view === "ended") app.innerHTML = endedView();
  else app.innerHTML = homeView();

  bindCommon();
  bindHome();
  bindProject();
  bindSession();
  bindEditor();
  settleEditorUi();
  renderUpdateToast();
  renderAppNotice();
  if (viewTransition) {
    local.viewMotionTimer = window.setTimeout(() => {
      app.classList.remove("app-shell-view-enter");
      delete app.dataset.transitionFrom;
      delete app.dataset.transitionTo;
      local.viewMotionTimer = null;
    }, 360);
  }
  if (hostRailEntrance || hostRailMotion) {
    local.hostRailMotionTimer = window.setTimeout(() => {
      app.classList.remove("app-shell-rail-enter", "app-shell-rail-expanding", "app-shell-rail-collapsing");
      local.hostRailMotionTimer = null;
    }, 320);
  }
}

function connectEvents() {
  if (local.events) {
    local.events.close();
  }

  const params = new URLSearchParams({ client: clientId });
  if (local.guestToken) {
    params.set("token", local.guestToken);
  }
  if (local.hostToken) {
    params.set("host", local.hostToken);
  }
  const events = new EventSource(`/events?${params.toString()}`);
  local.events = events;
  events.addEventListener("open", () => {
    clearTimeout(local.eventDisconnectTimer);
    local.eventDisconnectTimer = null;
    clearRemoteReconnectNotice();
  });
  events.addEventListener("state", (event) => {
    clearTimeout(local.eventDisconnectTimer);
    local.eventDisconnectTimer = null;
    clearRemoteReconnectNotice();
    const renderedRole = document.querySelector(".editor-shell")?.dataset.accessRole || "";
    local.appState = JSON.parse(event.data);
    if (isGuestClient() && local.appState?.session?.status === "ended") {
      handleSessionEnded("The host has ended the session.");
      return;
    }
    syncAiProposalsFromAppState();
    synchronizeEditorAccessRole({ renderedRole, announce: true });
    const current = route();
    if (current.view === "editor") {
      (Array.isArray(local.appState?.session?.joinRequests) ? local.appState.session.joinRequests : [])
        .filter((request) => request.status === "pending")
        .forEach(showEditorJoinRequest);
      refreshRightRailUi();
    }
    if (["session", "active", "project", "home"].includes(current.view)) {
      render();
    }
  });
  events.addEventListener("join-request", (event) => {
    const request = JSON.parse(event.data);
    playJoinRequestSound(request);
    if (route().view === "editor") {
      loadState().then(() => showEditorJoinRequest(request));
      return;
    }
    if (route().view === "session" || route().view === "active") {
      loadState().then(render);
    }
  });
  events.addEventListener("file-update", (event) => {
    const update = JSON.parse(event.data);
    if (update.path === local.selectedFile && update.user !== local.userName && !local.editingNow) {
      local.editorContent = update.content;
      if (local.codeEditor) local.codeEditor.applyRemoteText(update.content);
      else if (local.visualEditor) local.visualEditor.applyRemoteText(update.content);
      else {
        const textarea = document.querySelector("#editorText");
        if (textarea && "value" in textarea) textarea.value = update.content;
      }
    }
  });
  events.addEventListener("compile", (event) => {
    if (!local.appState) return;
    const nextCompile = JSON.parse(event.data);
    if (!shouldApplyCompileUpdate(nextCompile)) return;
    local.appState.compile = nextCompile;
    if (route().view === "editor") {
      const refreshPreview = local.appState.compile.status !== "running";
      updateCompileUi({ refreshPreview, previewScroll: refreshPreview ? local.pendingPreviewScroll : null });
      if (refreshPreview) local.pendingPreviewScroll = null;
    }
  });
  events.addEventListener("chat", () => {
    loadState().then(() => {
      if (route().view === "editor") updateChatPanel();
    });
  });
  events.addEventListener("access-revoked", (event) => {
    const payload = event.data ? JSON.parse(event.data) : {};
    handleAccessRevoked(payload.reason, payload.userId);
  });
  events.addEventListener("session-ended", (event) => {
    const payload = event.data ? JSON.parse(event.data) : {};
    const current = route();
    if (isGuestClient()) {
      handleSessionEnded(payload.reason || "The host stopped the session.");
      return;
    }
    if (["session", "active", "editor"].includes(current.view)) {
      loadState().then(render);
    }
  });
  events.addEventListener("error", () => {
    clearTimeout(local.eventDisconnectTimer);
    const current = route();
    const isRemoteSessionView = Boolean(local.guestToken) && ["editor", "join", "waiting"].includes(current.view);
    if (!isRemoteSessionView) return;
    const collabIsHealthy = current.view === "editor" && local.collabSocket?.readyState === WebSocket.OPEN;
    if (collabIsHealthy) {
      local.eventDisconnectTimer = null;
      clearRemoteReconnectNotice();
      return;
    }
    local.eventDisconnectTimer = setTimeout(() => {
      const websocketRecovered = route().view === "editor" && local.collabSocket?.readyState === WebSocket.OPEN;
      if (websocketRecovered) {
        clearRemoteReconnectNotice();
        return;
      }
      if (local.events?.readyState !== EventSource.OPEN) {
        showRemoteReconnectNotice("The host event stream is reconnecting.");
      }
      if (local.events?.readyState === EventSource.CLOSED) {
        connectEvents();
      }
    }, 8000);
  });
}

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search);
  local.view = params.get("view") || "";
  const hostToken = params.get("host") || params.get("hostToken") || "";
  if (hostToken) {
    local.hostToken = hostToken;
    sessionStorage.setItem("localleaf.hostToken", hostToken);
  }
  render();
});

window.addEventListener("pointerdown", (event) => {
  if (!local.treeContextMenu) return;
  if (event.target.closest?.(".tree-context-menu")) return;
  closeTreeContextMenu();
});

window.addEventListener("pointerdown", (event) => {
  if (!local.editorStyleMenuOpen) return;
  if (event.target.closest?.(".editor-style-menu-wrap")) return;
  setEditorStyleMenuOpen(false);
});

window.addEventListener("pointerdown", (event) => {
  if (!local.editorMoreMenuOpen) return;
  if (event.target.closest?.(".editor-more-menu, #editorMoreButton")) return;
  closeEditorMoreMenuInPlace({ focus: false });
});

window.addEventListener("pointerdown", (event) => {
  if (local.pdfAnnotationPopover && !event.target.closest?.(".pdf-annotation-popover") && !event.target.closest?.(".pdf-page")) {
    setPdfAnnotateMode(false);
  }
  if (local.aiSessionDeleteId) return;
  let shouldRender = false;
  if (local.aiSessionMenuOpen && !event.target.closest?.(".ai-session-bar")) {
    local.aiSessionMenuOpen = false;
    shouldRender = true;
  }
  if (local.aiSessionActionMenuId && !event.target.closest?.(".ai-session-row, #aiSessionActionsMenu")) {
    local.aiSessionActionMenuId = "";
    shouldRender = true;
  }
  if (local.aiSessionMoreMenuOpen && !event.target.closest?.(".ai-strip-more-wrap")) {
    local.aiSessionMoreMenuOpen = false;
    shouldRender = true;
  }
  if (local.aiQueuedPromptMenuOpenId && !event.target.closest?.(".ai-strip-more-wrap")) {
    local.aiQueuedPromptMenuOpenId = "";
    shouldRender = true;
  }
  if (local.aiModelPickerOpen && !event.target.closest?.(".ai-model-picker")) {
    local.aiModelPickerOpen = false;
    shouldRender = true;
  }
  if (shouldRender) refreshRightRailUi();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector(".settings-modal-backdrop")) {
    event.preventDefault();
    hideSettingsModal();
    return;
  }
  if (event.key === "Escape" && route().view === "editor") {
    if (local.aiSessionDeleteId) {
      event.preventDefault();
      local.aiSessionDeleteId = "";
      refreshRightRailUi();
      setTimeout(() => document.querySelector("#aiSessionMenuButton")?.focus(), 0);
      return;
    }
    if (local.aiSessionRenamingId) {
      event.preventDefault();
      cancelAiSessionRename();
      return;
    }
    if (local.aiSessionActionMenuId) {
      const sessionId = local.aiSessionActionMenuId;
      event.preventDefault();
      local.aiSessionActionMenuId = "";
      refreshRightRailUi();
      setTimeout(() => document.querySelector(`.ai-session-row[data-session-id="${CSS.escape(sessionId)}"] .ai-session-row-main`)?.focus(), 0);
      return;
    }
    if (local.aiSessionMenuOpen) {
      event.preventDefault();
      local.aiSessionMenuOpen = false;
      refreshRightRailUi();
      setTimeout(() => document.querySelector("#aiSessionMenuButton")?.focus(), 0);
      return;
    }
    if (local.aiModelPickerOpen) {
      event.preventDefault();
      local.aiModelPickerOpen = false;
      refreshRightRailUi();
      setTimeout(() => document.querySelector("#aiModelChip")?.focus(), 0);
      return;
    }
    if (local.pdfAnnotationPopover || local.pdfAnnotateMode) {
      event.preventDefault();
      setPdfAnnotateMode(false);
      return;
    }
    if (local.editorMoreMenuOpen) {
      event.preventDefault();
      closeEditorMoreMenuInPlace();
      return;
    }
    if (local.treeContextMenu) {
      event.preventDefault();
      closeTreeContextMenu();
      return;
    }
    if (local.editorStyleMenuOpen) {
      event.preventDefault();
      setEditorStyleMenuOpen(false, { restoreTrigger: true });
      return;
    }
    if (closeEditorSearchPanel()) {
      event.preventDefault();
      return;
    }
    if (local.tablePickerOpen) {
      event.preventDefault();
      local.tablePickerOpen = false;
      refreshEditorToolbarPanels();
      return;
    }
  }
  const mod = event.ctrlKey || event.metaKey;
  if (!mod || route().view !== "editor") return;
  const key = event.key.toLowerCase();
  if (key === "f") {
    event.preventDefault();
    openEditorSearchPanel();
    return;
  }
  if (key === "s") {
    if (document.activeElement?.closest?.(".cm-editor")) return;
    event.preventDefault();
    saveCurrentFile();
    return;
  }
  if (document.activeElement?.closest?.(".cm-editor")) return;
  if (!local.visualEditor || !["b", "i", "z", "y"].includes(key)) return;
  event.preventDefault();
  const command = key === "b" ? "bold" : key === "i" ? "italic" : key === "z" && event.shiftKey ? "redo" : key === "z" ? "undo" : "redo";
  local.visualEditor.exec(command);
});

loadState()
  .then(() => {
    connectEvents();
    return render();
  })
  .then(() => {
    preloadJoinRequestSound();
    return checkForUpdates();
  })
  .catch((error) => {
    app.innerHTML = `<section class="empty-state"><div class="ended-card"><h1>LocalLeaf failed to start</h1><p class="error">${escapeHtml(error.message)}</p></div></section>`;
  });
