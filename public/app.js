const clientId = crypto.randomUUID();
const initialParams = new URLSearchParams(location.search);
const initialHostToken = initialParams.get("host") || initialParams.get("hostToken") || sessionStorage.getItem("localleaf.hostToken") || "";
if (initialHostToken) sessionStorage.setItem("localleaf.hostToken", initialHostToken);
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
const AI_PROVIDER_ENABLE_STORAGE_KEY = "localleaf.aiProviderEnabled.v1";
const AI_MODEL_ENABLE_STORAGE_KEY = "localleaf.aiModelEnabled.v1";
const AI_MODEL_GROUP_STORAGE_KEY = "localleaf.aiModelGroups.v1";
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
    messages: [createAiWelcomeMessage()]
  };
}

function readAiSessionState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_SESSIONS_STORAGE_KEY) || "{}");
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions.filter((session) => session?.id && Array.isArray(session.messages))
      : [];
    if (sessions.length) {
      sessions.forEach((session) => {
        session.messages = session.messages.map((message) => message?.id === "welcome" ? createAiWelcomeMessage() : message);
      });
      const currentSessionId = sessions.some((session) => session.id === parsed.currentSessionId)
        ? parsed.currentSessionId
        : sessions[0].id;
      return { sessions, currentSessionId };
    }
  } catch {
    // Fall through to a fresh local session when storage is unavailable or malformed.
  }
  const session = createAiSession("First session");
  return { sessions: [session], currentSessionId: session.id };
}

const initialAiSessionState = readAiSessionState();

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
  guestToken: initialParams.get("token") || "",
  userName: initialParams.get("name") || "Host",
  userId: "",
  view: initialParams.get("view") || "",
  editingNow: false,
  events: null,
  eventDisconnectTimer: null,
  collabSocket: null,
  collabReconnectTimer: null,
  collabHeartbeatTimer: null,
  collabLostTimer: null,
  collabPresence: [],
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
  clearedWarningVersion: null,
  updateInfo: null,
  updateCheckStarted: false,
  updateChecking: false,
  updateInstalling: false,
  updateInstallStatus: "",
  updateDismissedVersion: localStorage.getItem("localleaf.updateDismissedVersion") || "",
  autoUpdateChecks: localStorage.getItem("localleaf.autoUpdateChecks") !== "0",
  joinRequestSoundEnabled: localStorage.getItem("localleaf.joinRequestSoundEnabled") !== "0",
  theme: initialTheme,
  hostRailCollapsed: localStorage.getItem("localleaf.hostRailCollapsed") === "1",
  settingsSection: "general",
  settingsModelSearch: "",
  aiPrompt: "",
  aiBusy: false,
  aiActivityMessage: "",
  aiActiveRunCount: 0,
  aiActiveRunId: "",
  aiRunControllers: new Set(),
  aiStopRequested: false,
  aiQuickAction: "",
  aiModelPickerOpen: false,
  aiModelSearch: "",
  activeCursorSdkModelId: localStorage.getItem("localleaf.activeCursorSdkModelId") || "",
  aiSessionMenuOpen: false,
  aiSessionMoreMenuOpen: false,
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
  if (!providerId) return;
  local.aiModelGroupOpen[providerId] = !isProviderModelGroupOpen(providerId);
  writeBooleanMap(AI_MODEL_GROUP_STORAGE_KEY, local.aiModelGroupOpen);
}

function providerModelEntries(provider) {
  return (provider?.models?.length ? provider.models : ["default"]).map((model) => {
    const id = typeof model === "string" ? model : model.id || model.name || "default";
    const name = typeof model === "string" ? model : model.name || model.id || "Default model";
    return { id, name };
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
    detail: model.sizeLabel || "Local model"
  }));
  if (local.aiPermissions.localModelOnly) return localItems;
  const providerItems = connectedAiProviders().filter(isProviderEnabled).flatMap((provider) => {
    return providerModelEntries(provider).filter((model) => isModelEnabled(provider.id, model.id)).map((model) => {
      return {
        providerId: provider.id,
        modelId: model.id,
        label: model.name,
        providerName: provider.name,
        detail: provider.name
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
        label: `Local / ${installedLocal.name}`
      }
      : {
        providerId: "localleaf-local",
        modelId: "",
        providerName: "Local",
        modelName: "Fallback",
        label: "Local / Fallback"
      };
  }
  if (local.activeCursorSdkModelId && aiProviders().some((provider) => provider.id === "cursor" && isProviderConnected(provider))) {
    return {
      providerId: "cursor",
      modelId: local.activeCursorSdkModelId,
      providerName: "Cursor",
      modelName: local.activeCursorSdkModelId === "composer-2" ? "Composer 2" : local.activeCursorSdkModelId,
      label: `Cursor / ${local.activeCursorSdkModelId === "composer-2" ? "Composer 2" : local.activeCursorSdkModelId}`
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
        label: `${state.activeModel.providerName || (state.activeModel.local ? "Local" : "Provider")} / ${state.activeModel.name || state.activeModel.modelId || "No model active"}`
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
      label: `${firstAvailable.providerName || firstAvailable.detail || "Provider"} / ${firstAvailable.label}`
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
        label: `${provider?.name || activeProviderId} / ${modelName}`
      };
    }
  }
  if (installedLocal) {
    return {
      providerId: "localleaf-local",
      modelId: installedLocal.id,
      providerName: "Local",
      modelName: installedLocal.name,
      label: `Local / ${installedLocal.name}`
    };
  }
  return {
    providerId: "",
    modelId: "",
    providerName: "No provider",
    modelName: "Connect model",
    label: "No model active"
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
    if (proposal?.id && (!proposal.sessionId || proposal.sessionId === local.aiCurrentSessionId)) byId.set(proposal.id, proposal);
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
    const merged = { ...(existing || {}), ...proposal, sessionId: existing?.sessionId || local.aiCurrentSessionId };
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

function firstUserPrompt(messages = []) {
  return messages.find((message) => message.role === "user")?.message || "";
}

function aiSessionTitleFromPrompt(prompt = "") {
  const clean = String(prompt || "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 42) : "New session";
}

function saveAiSessions() {
  const payload = {
    currentSessionId: local.aiCurrentSessionId,
    sessions: local.aiSessions.slice(0, 12).map((session) => ({
      ...session,
      messages: (session.messages || []).slice(-80)
    }))
  };
  localStorage.setItem(AI_SESSIONS_STORAGE_KEY, JSON.stringify(payload));
}

function syncCurrentAiSession(titleHint = "") {
  const session = currentAiSession();
  local.aiChangeHistory.forEach((proposal) => {
    if (proposal?.id && !proposal.sessionId) proposal.sessionId = session.id;
  });
  session.messages = local.aiMessages.map((message) => ({ ...message }));
  session.updatedAt = Date.now();
  if (!firstUserPrompt(session.messages)) {
    session.title = titleHint ? aiSessionTitleFromPrompt(titleHint) : session.title || "New session";
  } else if (!session.title || session.title === "New session" || session.title === "First session") {
    session.title = aiSessionTitleFromPrompt(firstUserPrompt(session.messages));
  }
  local.aiSessions = [session, ...local.aiSessions.filter((item) => item.id !== session.id)]
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .slice(0, 12);
  saveAiSessions();
}

function startNewAiSession() {
  syncCurrentAiSession();
  const session = createAiSession();
  local.aiSessions.unshift(session);
  local.aiCurrentSessionId = session.id;
  local.aiMessages = session.messages.map((message) => ({ ...message }));
  local.aiSessionMenuOpen = false;
  local.aiSessionMoreMenuOpen = false;
  local.aiForceScrollBottom = true;
  local.aiChatNeedsJump = false;
  saveAiSessions();
  refreshRightRailUi();
}

function switchAiSession(sessionId) {
  syncCurrentAiSession();
  const session = local.aiSessions.find((item) => item.id === sessionId);
  if (!session) return;
  local.aiCurrentSessionId = session.id;
  local.aiMessages = (session.messages || [createAiWelcomeMessage()]).map((message) => ({ ...message }));
  local.aiSessionMenuOpen = false;
  local.aiSessionMoreMenuOpen = false;
  local.aiForceScrollBottom = true;
  local.aiChatNeedsJump = false;
  saveAiSessions();
  refreshRightRailUi();
}

function deleteAiSession(sessionId, options = {}) {
  const targetId = String(sessionId || "");
  if (!targetId) return;
  const nextSessions = local.aiSessions.filter((session) => session.id !== targetId);
  if (!nextSessions.length) {
    const session = createAiSession();
    local.aiSessions = [session];
    local.aiCurrentSessionId = session.id;
    local.aiMessages = session.messages.map((message) => ({ ...message }));
  } else {
    local.aiSessions = nextSessions;
    if (local.aiCurrentSessionId === targetId) {
      const next = local.aiSessions[0];
      local.aiCurrentSessionId = next.id;
      local.aiMessages = (next.messages || [createAiWelcomeMessage()]).map((message) => ({ ...message }));
    }
  }
  local.aiSessionMenuOpen = options.keepMenu !== false;
  local.aiSessionMoreMenuOpen = false;
  local.aiForceScrollBottom = true;
  local.aiChatNeedsJump = false;
  saveAiSessions();
  refreshRightRailUi();
}

function renameCurrentAiSession() {
  const session = currentAiSession();
  const title = prompt("Session name", session.title || "New session");
  if (title === null) return;
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return;
  session.title = clean.slice(0, 64);
  session.updatedAt = Date.now();
  local.aiSessions = [session, ...local.aiSessions.filter((item) => item.id !== session.id)];
  local.aiSessionMoreMenuOpen = false;
  saveAiSessions();
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

function closeCollab() {
  clearTimeout(local.collabReconnectTimer);
  clearTimeout(local.collabLostTimer);
  clearInterval(local.collabHeartbeatTimer);
  local.collabReconnectTimer = null;
  local.collabLostTimer = null;
  local.collabHeartbeatTimer = null;
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

function destroyEditorSurfaces() {
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
    if (payload.filePath === local.selectedFile) {
      local.saveStatus = payload.userId === local.userId ? "Saved" : `Saved by ${payload.name || "collaborator"}`;
      const status = document.querySelector(".editor-subtitle");
      if (status) status.textContent = local.saveStatus;
    }
    return;
  }

  if (payload.type === "presence_update") {
    local.collabPresence = payload.presence || [];
    updateUsersPresenceUi();
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
  const params = new URLSearchParams();
  params.set("view", view);
  if (local.hostToken) params.set("host", local.hostToken);
  if (extra.token) params.set("token", extra.token);
  if (extra.name) params.set("name", extra.name);
  history.pushState({}, "", `/?${params.toString()}`);
  local.view = view;
  if (extra.token) local.guestToken = extra.token;
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

function uiGlyph(name) {
  return `<span class="ui-glyph ui-glyph-${name}" aria-hidden="true"></span>`;
}

const PROVIDER_LOGO_PATHS = {
  openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  openrouter: "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
  ollama: "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002z"
};

const PROVIDER_LOGO_SVG_MARKUP = {
  lmstudio: `<path d="M2.84 2a1.273 1.273 0 100 2.547h14.107a1.273 1.273 0 100-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H22.04a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h14.106a1.274 1.274 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H15.38a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h14.106a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h9.698a1.273 1.273 0 100-2.547h-9.698z" fill-opacity=".3"></path><path d="M2.84 2a1.273 1.273 0 100 2.547h10.287a1.274 1.274 0 000-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H18.22a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h10.286a1.273 1.273 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H11.56a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h10.286a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h5.78a1.273 1.273 0 100-2.547h-5.78z"></path>`,
  opencode: `<path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"></path>`,
  cursor: `<path d="M4 4.6 20 12 4 19.4l3.6-7.4L4 4.6Z"></path><path d="m7.6 12 6.7-.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>`
};

function providerLogoKey(provider = {}) {
  const value = `${provider.id || ""} ${provider.name || ""}`.toLowerCase();
  if (value.includes("openai")) return "openai";
  if (value.includes("openrouter")) return "openrouter";
  if (value.includes("ollama")) return "ollama";
  if (value.includes("lmstudio") || value.includes("lm studio")) return "lmstudio";
  if (value.includes("opencode")) return "opencode";
  if (value.includes("cursor")) return "cursor";
  return "custom";
}

function providerLogoMarkup(provider = {}) {
  const key = providerLogoKey(provider);
  const label = provider.name || "Provider";
  const svgMarkup = PROVIDER_LOGO_SVG_MARKUP[key] || (PROVIDER_LOGO_PATHS[key] ? `<path d="${PROVIDER_LOGO_PATHS[key]}"></path>` : "");
  if (svgMarkup) {
    return `<span class="provider-logo provider-logo-${key}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${svgMarkup}</svg></span>`;
  }
  const text = String(label).trim().slice(0, 2).toUpperCase() || "AI";
  return `<span class="provider-logo provider-logo-${key}" aria-hidden="true"><span>${escapeHtml(text)}</span></span>`;
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
    figure: `<svg ${attrs}><rect x="4" y="5" width="16" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m6.5 17 4.2-4.2 2.5 2.5 2-2L19 17" /></svg>`,
    table: `<svg ${attrs}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 10h16" /><path d="M4 15h16" /><path d="M10 5v14" /><path d="M15 5v14" /></svg>`,
    bulletList: `<svg ${attrs}><path d="M9 7h11" /><path d="M9 12h11" /><path d="M9 17h11" /><circle cx="5" cy="7" r="1.2" /><circle cx="5" cy="12" r="1.2" /><circle cx="5" cy="17" r="1.2" /></svg>`,
    numberedList: `<svg ${attrs}><path d="M10 7h10" /><path d="M10 12h10" /><path d="M10 17h10" /><path d="M4 6h1.5v4" /><path d="M4 10h3" /><path d="M4 14h3l-3 4h3" /></svg>`,
    outdent: `<svg ${attrs}><path d="M10 7h10" /><path d="M10 12h10" /><path d="M10 17h10" /><path d="m7 9-4 3 4 3" /></svg>`,
    indent: `<svg ${attrs}><path d="M4 7h10" /><path d="M4 12h10" /><path d="M4 17h10" /><path d="m17 9 4 3-4 3" /></svg>`,
    complete: `<svg ${attrs}><path d="M14 4 9 20" /><path d="M17 6h3" /><path d="M18.5 4.5v3" /><path d="M4 17h3" /><path d="M5.5 15.5v3" /></svg>`,
    search: `<svg ${attrs}><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>`,
    files: `<svg ${attrs}><path d="M4 6.5h6l2 2h8v9.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5Z" /><path d="M4 10h16" /></svg>`,
    newFile: `<svg ${attrs}><path d="M6 3.5h8l4 4V20H6V3.5Z" /><path d="M14 3.5V8h4" /><path d="M9 13h6" /><path d="M12 10v6" /></svg>`,
    newFolder: `<svg ${attrs}><path d="M3.5 7h6l1.7 2H20v8.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7Z" /><path d="M12 14h5" /><path d="M14.5 11.5v5" /></svg>`,
    upload: `<svg ${attrs}><path d="M12 16V5" /><path d="m8 9 4-4 4 4" /><path d="M5 18.5h14" /></svg>`,
    rename: `<svg ${attrs}><path d="M4 19h7" /><path d="M13.5 5.5 18.5 10.5" /><path d="M6 15.5 15.8 5.7a2 2 0 0 1 2.8 2.8L8.8 18.3 5 19l1-3.5Z" /></svg>`,
    delete: `<svg ${attrs}><path d="M5 7h14" /><path d="M9 7V5h6v2" /><path d="M8 10v8" /><path d="M12 10v8" /><path d="M16 10v8" /><path d="M7 7l1 14h8l1-14" /></svg>`,
    chat: `<svg ${attrs}><path d="M5 6h14v10H8l-3 3V6Z" /><path d="M9 10h6" /><path d="M9 13h4" /></svg>`,
    menu: `<svg ${attrs}><path d="M5 7h14" /><path d="M5 12h14" /><path d="M5 17h14" /></svg>`,
    edit: `<svg ${attrs}><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m13.5 8.5 3 3" /></svg>`
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
      <img class="brand-mark" src="/assets/localleaf-logo.svg" alt="" />
      <h1>LocalLeaf <span>Host</span></h1>
    </div>
  `;
}

function logoMark(className = "brand-mark") {
  return `<img class="${className}" src="/assets/localleaf-logo.svg" alt="" />`;
}

function activeFileForUser(userId) {
  return local.collabPresence.find((item) => item.userId === userId)?.filePath || "";
}

function updateCheckButtonMarkup(id, label = "Check for updates", extraClass = "") {
  return `
    <button class="btn update-check-button ${extraClass} ${local.updateChecking ? "is-checking" : ""}" id="${escapeHtml(id)}" data-check-updates data-default-label="${escapeHtml(label)}" type="button" title="Check for updates" aria-label="Check for updates" aria-busy="${local.updateChecking ? "true" : "false"}">
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
              <div><strong>Network</strong><span>${escapeHtml(session.network.recommendation)}</span></div>
              <b class="${tunnelReady ? "status-good" : "status-warn"}">${tunnelReady ? "Good" : "Local"}</b>
            </div>
            <div class="status-row project-status-row">
              ${uiGlyph("file")}
              <div><strong>Project size</strong><span>${project.files.filter((item) => item.type !== "directory").length} files</span></div>
              <b>${project.sizeLabel}</b>
            </div>
            <div class="status-row project-status-row">
              ${uiGlyph("users")}
              <div><strong>Recommended collaborators</strong><span>Based on current host checks</span></div>
              <b>${session.maxUsers}</b>
            </div>
          </div>
        </main>

        <aside class="project-details-panel">
          <div class="section-title">Session Readiness</div>
          <div class="project-detail-list">
            <div><span>Tunnel</span><b class="${session.tunnel.available ? "status-good" : "status-warn"}">${escapeHtml(session.tunnel.status)}</b></div>
            <div><span>Host quality</span><b class="${session.network.score >= 70 ? "status-good" : "status-warn"}">${escapeHtml(session.network.quality)}</b></div>
            <div><span>Upload</span><b>${escapeHtml(session.network.upload)}</b></div>
            <div><span>Latency</span><b>${escapeHtml(session.network.latency)}</b></div>
          </div>
        </aside>
      </div>
    </div>
  `, { rail: true, active: "home", dashboard: true, wide: true });
}

function sessionView() {
  const { project, session, compiler } = local.appState;
  const isLive = session.status === "live";
  const hasInvite = Boolean(session.inviteUrl);
  const tunnelLabel = session.tunnel.providerName
    ? `${session.tunnel.status} via ${session.tunnel.providerName}`
    : session.tunnel.status;
  const inviteStatusText = hasInvite
    ? session.inviteUrl
    : session.tunnel.status === "Error"
      ? "Public invite link is not available."
      : "Creating verified public invite link...";
  const pending = session.joinRequests.filter((item) => item.status === "pending");
  const pendingMarkup = pending.length
    ? `<div class="approval-strip">
        <div class="section-title">Join Requests</div>
        ${pending.map(requestMarkup).join("")}
      </div>`
    : "";
  return windowShell(`
    <div class="session-share-page">
      <header class="session-share-head">
        <button class="icon-button project-back-icon" id="backHome" title="Back to home" aria-label="Back to home">
          <span class="chevron-left" aria-hidden="true"></span>
        </button>
        <div>
          <span class="pill ${isLive ? "" : "pill-warn"}">${isLive ? "Session Live" : "Session Idle"}</span>
          <h2>Session Management</h2>
          <p>${isLive ? `${escapeHtml(project.name)} is online. Copy the invite link or open the editor.` : `Start hosting when you are ready to invite collaborators into ${escapeHtml(project.name)}.`}</p>
        </div>
        ${!isLive ? `<button class="btn btn-primary" data-start-session>${uiGlyph("users")} Host Online Session</button>` : ""}
      </header>

      ${pendingMarkup}

      <div class="session-share-grid">
        <main class="session-share-main">
          <section class="session-invite-panel">
            <div class="session-panel-title">${isLive ? "Invite Link" : "Host Session"}</div>
            ${isLive
              ? `<div class="copy-box session-copy-box">
                  <div class="copy-row">
                    <code>${escapeHtml(inviteStatusText)}</code>
                    <button class="icon-button copy-icon" id="copyInvite" title="Copy invite link" aria-label="Copy invite link" ${hasInvite ? "" : "disabled"}></button>
                  </div>
                  ${hasInvite ? "" : `<p class="muted">${escapeHtml(session.tunnel.detail)}</p>`}
                </div>
                <div class="session-invite-actions">
                  <button class="btn" id="copyInviteBottom" ${hasInvite ? "" : "disabled"}>Copy Invite Link</button>
                  <button class="btn btn-danger" id="stopSession">Stop Session</button>
                </div>`
              : `<div class="session-empty-panel">
                  <div class="session-empty-copy">
                    <div class="session-empty-icon">${uiGlyph("users")}</div>
                    <div>
                      <strong>No session is running</strong>
                      <span>Friends can join only after you start hosting. Your project files stay on this computer.</span>
                    </div>
                  </div>
                  <button class="btn btn-primary" data-start-session>${uiGlyph("users")} Host Online Session</button>
                </div>`}
          </section>

          <section class="session-health-card">
            <div class="session-panel-title">Session Health</div>
            <div class="session-health-list">
              <div class="session-health-row"><span>Host quality</span><b class="${session.network.score >= 70 ? "status-good" : "status-warn"}">${escapeHtml(session.network.quality)}</b><span class="bars"><i></i><i></i><i></i><i></i><i></i></span><small>${session.network.score}%</small></div>
              <div class="session-health-row"><span>Users</span><b>${session.users.length} / ${session.maxUsers}</b></div>
              <div class="session-health-row"><span>Compiler</span><b class="${compiler.available ? "status-good" : "status-warn"}">${compiler.available ? "Ready" : "Fallback"}</b></div>
              <div class="session-health-row"><span>Tunnel</span><b class="${session.tunnel.available ? "status-good" : "status-warn"}">${escapeHtml(tunnelLabel)}</b></div>
              <div class="session-health-row"><span>Upload</span><b>${escapeHtml(session.network.upload)}</b></div>
              <div class="session-health-row"><span>Latency</span><b>${escapeHtml(session.network.latency)}</b></div>
            </div>
          </section>

        </main>

        <aside class="session-share-side">
          <section class="session-side-card">
            <div class="session-panel-title">Project</div>
            <div class="session-project-mini">
              <strong>${escapeHtml(project.name)}</strong>
              <span>${escapeHtml(project.root)}</span>
            </div>
            <div class="project-detail-list">
              <div><span>Project size</span><b>${escapeHtml(project.sizeLabel)}</b></div>
              <div><span>Files</span><b>${project.files.filter((item) => item.type !== "directory").length}</b></div>
              <div><span>Collaborators</span><b>${session.users.length} / ${session.maxUsers}</b></div>
            </div>
          </section>

          <section class="session-side-card">
            <div class="session-panel-title">Users (${session.users.length})</div>
            <div class="session-user-list">
              ${session.users.map((user) => `
                <div class="session-user-row">
                  <div class="avatar">${escapeHtml(user.name[0] || "?")}</div>
                  <div><strong>${escapeHtml(user.name)}${user.role === "host" ? " (You)" : ""}</strong><span>${escapeHtml(user.role)}</span></div>
                  <span class="online-dot"></span>
                </div>
              `).join("")}
            </div>
          </section>
        </aside>
      </div>
      ${isLive ? `<button class="btn btn-primary session-open-editor-wide" id="openEditorFromSession" ${project.mainFile ? "" : "disabled"}>Open Editor</button>` : ""}
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
        <span>Approve editor access without leaving the editor.</span>
      </div>
      <button class="btn btn-primary" data-toast-approve="${escapeHtml(request.id)}" style="height:32px">Allow</button>
      <button class="btn" data-toast-deny="${escapeHtml(request.id)}" style="height:32px">Deny</button>
    </section>
  `);
  const toast = document.querySelector(".join-toast");
  toast?.querySelector("[data-toast-approve]")?.addEventListener("click", async (event) => {
    await api("/api/join/approve", { method: "POST", body: { requestId: event.currentTarget.dataset.toastApprove, role: "editor" } });
    toast.remove();
    await loadState();
    updateUsersPresenceUi();
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
  const iconText = type === "error" ? "!" : type === "success" ? "âœ“" : "i";
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
  const result = await checkForUpdates({ manual: true });
  if (result === "current") {
    markUpdateButtonFeedback(event?.currentTarget, "Up to date");
  } else if (result === "available") {
    markUpdateButtonFeedback(event?.currentTarget, "Update ready");
  } else if (result === "silent") {
    markUpdateButtonFeedback(event?.currentTarget, "Could not check");
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

function hideSettingsModal() {
  document.querySelector(".settings-modal-backdrop")?.remove();
}

function settingsTabButton(section, label) {
  return `<button type="button" class="settings-tab ${local.settingsSection === section ? "active" : ""}" data-settings-section="${escapeHtml(section)}">${escapeHtml(label)}</button>`;
}

function themeSwitchMarkup() {
  const isDark = local.theme === "dark";
  return `
    <button class="settings-theme-switch ${isDark ? "is-dark" : "is-light"}" id="themeModeSwitch" type="button" role="switch" aria-checked="${isDark ? "true" : "false"}" title="Switch between light and dark mode">
      <span class="settings-theme-option settings-theme-sun" aria-hidden="true"><span></span></span>
      <span class="settings-theme-option settings-theme-moon" aria-hidden="true"><span></span></span>
      <span class="settings-theme-thumb" aria-hidden="true"></span>
      <span class="sr-only" data-theme-current>${isDark ? "Dark mode" : "Light mode"}</span>
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
      ${miniSwitchMarkup({ checked: local.aiPermissions[key], attrs: `data-ai-permission="${escapeHtml(key)}"` })}
    </section>
  `;
}

function miniSwitchMarkup({ checked = false, disabled = false, label = "", attrs = "" } = {}) {
  return `
    <label class="settings-mini-switch" ${label ? `title="${escapeHtml(label)}"` : ""}>
      <input type="checkbox" ${attrs} ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span></span>
    </label>
  `;
}

function settingsGeneralMarkup() {
  return `
    <section class="settings-general settings-compact-page">
      <div class="settings-general-hero">
        <span class="settings-general-mark" aria-hidden="true">${uiGlyph("settings")}</span>
        <div>
          <h3>General</h3>
          <p>Basic workspace preferences for this computer.</p>
        </div>
      </div>
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
          ${miniSwitchMarkup({ checked: local.joinRequestSoundEnabled, attrs: `id="joinRequestSound"` })}
        </section>
        <section class="settings-list-row">
          <div class="settings-list-main">
            <div>
              <strong>Auto-check updates</strong>
              <span>Quietly check the LocalLeaf release page when the app opens.</span>
            </div>
          </div>
          ${miniSwitchMarkup({ checked: local.autoUpdateChecks, attrs: `id="autoUpdateChecks"` })}
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
          ${test?.message ? `<small class="provider-test-result ${escapeHtml(test.color || (test.ok ? "green" : "red"))}" data-provider-test-slot="${escapeHtml(provider.id)}">${escapeHtml(test.message)}</small>` : `<small class="provider-test-result muted" data-provider-test-slot="${escapeHtml(provider.id)}">Test result will appear here.</small>`}
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
  return `
    <section class="settings-model-group settings-provider-model-group ${providerEnabled ? "" : "provider-disabled"} ${open ? "open" : "collapsed"}">
      <div class="settings-provider-model-head">
        <div class="settings-provider-model-title">
          ${providerLogoMarkup(provider)}
          <strong>${escapeHtml(provider.name)}</strong>
          ${miniSwitchMarkup({ checked: providerEnabled, label: providerEnabled ? "Provider shown in picker" : "Provider hidden from picker", attrs: `data-provider-enabled="${escapeHtml(provider.id)}" data-provider-toggle-scope="models"` })}
        </div>
        <button class="settings-provider-disclosure ${open ? "open" : ""}" type="button" data-toggle-provider-model-group="${escapeHtml(provider.id)}" aria-expanded="${open ? "true" : "false"}" title="${open ? "Collapse models" : "Expand models"}" aria-label="${open ? "Collapse" : "Expand"} ${escapeHtml(provider.name)} models">
          <span aria-hidden="true"></span>
        </button>
      </div>
      <div class="settings-list-card settings-provider-models" ${open ? "" : "hidden"}>
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
      <input class="settings-model-search" id="settingsModelSearch" value="${escapeHtml(local.settingsModelSearch)}" placeholder="Search models" autocomplete="off" />
      <div class="settings-model-toolbar">
        <button class="btn" id="bringYourOwnKey" type="button">${uiGlyph("plus")} Connect provider</button>
        <button class="btn" id="configureCustomModel" type="button">${uiGlyph("settings")} Custom</button>
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
      <div class="settings-permission-note">
        <strong>AI Helper permissions</strong>
        <span>These controls are sent with each AI chat request and decide what the active model is allowed to propose or auto-apply.</span>
      </div>
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
        ${settingToggleMarkup("fileManagement", "Create, rename, move, and delete", "Allow the AI Helper to handle project file-management requests.", { warning: true })}
        ${settingToggleMarkup("fileUploads", "Uploads and imports", "Allow the AI Helper to discuss upload/import actions for project assets.", { warning: true })}
        ${settingToggleMarkup("shellCommands", "Shell commands", "Allow command or terminal requests to reach the active model.", { warning: true })}
        ${settingToggleMarkup("binaryFiles", "Binary files", "Allow binary-file requests such as images, PDFs, or other assets.", { warning: true })}
      </div>
    </section>
  `;
}

function showSettingsModal(section = "general") {
  hideSettingsModal();
  const allowedSections = new Set(["general", "providers", "models", "permissions"]);
  local.settingsSection = allowedSections.has(section) ? section : "general";
  const shell = document.querySelector(".editor-shell") || app;
  shell.insertAdjacentHTML("beforeend", `
    <div class="settings-modal-backdrop" role="presentation">
      <section class="settings-modal settings-modal-wide settings-preferences-modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <div class="settings-modal-head">
          <div>
            <h2 id="settingsTitle">LocalLeaf Settings</h2>
            <p>Simple workspace preferences for this app.</p>
          </div>
          <button class="icon-button" data-close-settings title="Close settings" aria-label="Close settings">x</button>
        </div>
        <div class="settings-tabs" role="tablist" aria-label="Settings sections">
          ${settingsTabButton("general", "General")}
          ${settingsTabButton("providers", "Providers")}
          ${settingsTabButton("models", "Models")}
          ${settingsTabButton("permissions", "AI Permissions")}
        </div>
        <div class="settings-options">
          <div class="settings-section" data-settings-panel="general" ${local.settingsSection === "general" ? "" : "hidden"}>
            ${settingsGeneralMarkup()}
          </div>
          <div class="settings-section" data-settings-panel="models" ${local.settingsSection === "models" ? "" : "hidden"}>
            ${settingsModelsMarkup()}
          </div>
          <div class="settings-section" data-settings-panel="providers" ${local.settingsSection === "providers" ? "" : "hidden"}>
            ${settingsProvidersMarkup()}
          </div>
          <div class="settings-section" data-settings-panel="permissions" ${local.settingsSection === "permissions" ? "" : "hidden"}>
            ${settingsPermissionsMarkup()}
          </div>
        </div>
      </section>
    </div>
  `);

  const modal = document.querySelector(".settings-modal-backdrop");
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) hideSettingsModal();
  });
  modal?.querySelectorAll("[data-settings-section]").forEach((button) => {
    button.addEventListener("click", () => {
      local.settingsSection = button.dataset.settingsSection || "general";
      modal.querySelectorAll("[data-settings-section]").forEach((tab) => tab.classList.toggle("active", tab === button));
      modal.querySelectorAll("[data-settings-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.settingsPanel !== local.settingsSection;
      });
    });
  });
  modal?.querySelector("[data-close-settings]")?.addEventListener("click", hideSettingsModal);
  modal?.querySelector("#themeModeSwitch")?.addEventListener("click", (event) => {
    const nextTheme = local.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    const switcher = event.currentTarget;
    const isDark = nextTheme === "dark";
    switcher.classList.toggle("is-dark", isDark);
    switcher.classList.toggle("is-light", !isDark);
    switcher.setAttribute("aria-checked", isDark ? "true" : "false");
    const label = switcher.querySelector("[data-theme-current]");
    if (label) label.textContent = isDark ? "Dark mode" : "Light mode";
  });
  modal?.querySelector("#autoUpdateChecks")?.addEventListener("change", (event) => {
    setAutoUpdateChecks(event.currentTarget.checked);
  });
  modal?.querySelector("#joinRequestSound")?.addEventListener("change", (event) => {
    setJoinRequestSoundEnabled(event.currentTarget.checked);
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
      toggleProviderModelGroup(button.dataset.toggleProviderModelGroup);
      showSettingsModal("models");
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
  return rows.map((item) => {
    const key = typeof item === "string" ? item : item?.[keyName] || item?.id || item?.name || "";
    const value = typeof item === "string" ? "" : item?.[valueName] || item?.value || "";
    return `
      <div class="provider-form-row" data-provider-row="${escapeHtml(name)}">
        <input name="${escapeHtml(name)}-${escapeHtml(keyName)}" placeholder="${escapeHtml(keyName === "model" ? "Model name" : "Header")}" value="${escapeHtml(key)}" />
        <input name="${escapeHtml(name)}-${escapeHtml(valueName)}" placeholder="${escapeHtml(valueName === "value" ? "Value" : "Alias")}" value="${escapeHtml(value)}" />
        <button class="icon-button" type="button" data-remove-provider-row title="Remove row" aria-label="Remove row">x</button>
      </div>
    `;
  }).join("");
}

function providerTemplateOptions(selectedId = "") {
  const templates = aiState().providerTemplates || [];
  return templates.map((template) => {
    return `<option value="${escapeHtml(template.id)}" ${template.id === selectedId ? "selected" : ""}>${escapeHtml(template.name)}</option>`;
  }).join("");
}

function showProviderDialog(options = {}) {
  document.querySelector(".provider-modal-backdrop")?.remove();
  local.providerDialogTest = null;
  const provider = options.providerId
    ? aiProviders().find((item) => item.id === options.providerId)
    : options.templateId
      ? aiProviders().find((item) => item.id === options.templateId)
      : aiProviders().find((item) => item.id === "opencode-go") || null;
  const title = options.mode === "key" ? "Connect Provider" : provider ? "Edit Provider" : "Configure Custom Model";
  const shell = document.querySelector(".editor-shell") || app;
  shell.insertAdjacentHTML("beforeend", `
    <div class="settings-modal-backdrop provider-modal-backdrop" role="presentation">
      <section class="settings-modal provider-modal" role="dialog" aria-modal="true" aria-labelledby="providerDialogTitle">
        <form id="providerForm">
          <div class="settings-modal-head">
            <div>
              <h2 id="providerDialogTitle">${escapeHtml(title)}</h2>
              <p>Connect an OpenCode-style provider and choose the models LocalLeaf can show in the picker.</p>
            </div>
            <button class="icon-button" data-close-provider type="button" title="Close provider dialog" aria-label="Close provider dialog">x</button>
          </div>
          <div class="provider-form-body">
            <label>Provider preset
              <select name="templateId">
                <option value="">Custom Provider</option>
                ${providerTemplateOptions(provider?.id || "")}
              </select>
            </label>
            <label>Provider ID <input name="providerId" required value="${escapeHtml(provider?.id || "")}" placeholder="openai-compatible" /></label>
            <label>Display name <input name="displayName" required value="${escapeHtml(provider?.name || "")}" placeholder="OpenAI Compatible" /></label>
            <label>Base URL <input name="baseUrl" value="${escapeHtml(provider?.baseUrl || "")}" placeholder="https://api.example.com/v1" /></label>
            <label>API key <input name="apiKey" type="password" value="" placeholder="${provider?.hasApiKey ? "Leave blank to keep saved key" : "Stored encrypted on this computer"}" /></label>
            <section class="provider-form-section">
              <div class="provider-form-section-head">
                <strong>Models</strong>
                <button class="btn" type="button" data-add-model-row>${uiGlyph("plus")} Add model</button>
              </div>
              <div class="provider-form-rows" data-provider-rows="models">
                ${providerFormRows(provider?.models || ["default"], "model", "model", "alias")}
              </div>
            </section>
            <section class="provider-form-section">
              <div class="provider-form-section-head">
                <strong>Optional headers</strong>
                <button class="btn" type="button" data-add-header-row>${uiGlyph("plus")} Add header</button>
              </div>
              <div class="provider-form-rows" data-provider-rows="headers">
                ${providerFormRows(provider?.headers || [], "header", "name", "value")}
              </div>
            </section>
          </div>
          <div class="provider-form-actions">
            <span class="provider-dialog-test muted" id="providerDialogTest" aria-live="polite">Run test to verify</span>
            <button class="btn" type="button" id="testProviderForm">Test connection</button>
            <button class="btn btn-primary" type="submit">Save / Submit</button>
          </div>
        </form>
      </section>
    </div>
  `);
  const modal = document.querySelector(".provider-modal-backdrop");
  const close = () => modal?.remove();
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal?.querySelector("[data-close-provider]")?.addEventListener("click", close);
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
    if (rows?.children.length > 1) button.closest(".provider-form-row")?.remove();
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
  rows.insertAdjacentHTML("beforeend", `
    <div class="provider-form-row" data-provider-row="${isModel ? "model" : "header"}">
      <input name="${isModel ? "model-model" : "header-name"}" placeholder="${isModel ? "Model name" : "Header"}" />
      <input name="${isModel ? "model-alias" : "header-value"}" placeholder="${isModel ? "Alias" : "Value"}" />
      <button class="icon-button" type="button" data-remove-provider-row title="Remove row" aria-label="Remove row">x</button>
    </div>
  `);
}

function formProviderPayload() {
  const form = document.querySelector("#providerForm");
  if (!form) return { id: "", name: "", models: [], headers: [] };
  const formData = new FormData(form);
  const models = [...form.querySelectorAll('[data-provider-row="model"]')]
    .map((row) => {
      const id = row.querySelector('input[name="model-model"]')?.value.trim();
      const name = row.querySelector('input[name="model-alias"]')?.value.trim() || id;
      return id ? { id, name } : null;
    })
    .filter(Boolean);
  const headers = [...form.querySelectorAll('[data-provider-row="header"]')]
    .map((row) => ({
      name: row.querySelector('input[name="header-name"]')?.value.trim(),
      value: row.querySelector('input[name="header-value"]')?.value.trim()
    }))
    .filter((header) => header.name);
  return {
    id: String(formData.get("providerId") || "").trim(),
    templateId: String(formData.get("templateId") || "").trim(),
    name: String(formData.get("displayName") || "").trim(),
    baseUrl: String(formData.get("baseUrl") || "").trim(),
    apiKey: String(formData.get("apiKey") || "").trim(),
    models: models.length ? models : [{ id: "default", name: "Default" }],
    headers,
    description: "Custom OpenAI-compatible provider.",
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
    document.querySelector(".provider-modal-backdrop")?.remove();
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
  document.querySelector(".info-modal-backdrop")?.remove();
  const isHelp = kind === "help";
  const shell = document.querySelector(".editor-shell") || app;
  const helpItems = [
    ["Start collaborating", "Create or import a project, choose Host Online Session, then share the invite link after the tunnel is ready."],
    ["Compile a project", "Open the editor and click Recompile. LocalLeaf tries bundled Tectonic, system Tectonic, latexmk, pdflatex, xelatex, and lualatex."],
    ["Export work", "Use Export in the editor to download the source ZIP or the latest compiled PDF."],
    ["Review AI edits", "AI Helper drafts file edits and lists them in Changes, where you can apply or reject each one."]
  ];
  shell.insertAdjacentHTML("beforeend", `
    <div class="settings-modal-backdrop info-modal-backdrop" role="presentation">
      <section class="settings-modal info-modal" role="dialog" aria-modal="true" aria-labelledby="infoModalTitle">
        <div class="settings-modal-head">
          <div>
            <h2 id="infoModalTitle">${isHelp ? "LocalLeaf Help" : "About LocalLeaf"}</h2>
            <p>${isHelp ? "Fast answers for the flows you will use most." : "Private, host-powered LaTeX collaboration."}</p>
          </div>
          <button class="icon-button" data-close-info title="Close" aria-label="Close">x</button>
        </div>
        ${isHelp ? `
          <div class="info-modal-body help-qa-list">
            ${helpItems.map(([question, answer], index) => `
              <details ${index === 0 ? "open" : ""}>
                <summary>
                  <span>${String(index + 1).padStart(2, "0")}</span>
                  <strong>${escapeHtml(question)}</strong>
                </summary>
                <p>${escapeHtml(answer)}</p>
              </details>
            `).join("")}
          </div>
        ` : `
          <div class="info-modal-body about-copy">
            <div class="about-hero-card">
              <div class="about-brand-card">
                ${logoMark("about-brand-mark")}
                <div>
                  <strong>LocalLeaf Host</strong>
                  <span>Overleaf-style editing, owned by the host computer.</span>
                </div>
              </div>
              <div>
                <span class="about-version-pill">Private by design</span>
                <span class="about-version-pill">Host powered</span>
              </div>
            </div>
            <p>LocalLeaf keeps LaTeX projects on the host machine while guests join from a browser to edit, chat, compile, and preview PDFs together.</p>
            <div class="about-feature-grid">
              <span><b>${uiGlyph("file")}</b><strong>Local files</strong><small>Projects stay on this computer.</small></span>
              <span><b>${uiGlyph("users")}</b><strong>Browser guests</strong><small>Friends join from one invite link.</small></span>
              <span><b>${uiGlyph("compile")}</b><strong>PDF compile</strong><small>Bundled compiler plus fallback engines.</small></span>
              <span><b>${uiGlyph("chat")}</b><strong>Project chat</strong><small>Talk while editing the same LaTeX files.</small></span>
            </div>
            <div class="about-footer-row">
              <a class="btn btn-primary about-website-link" href="${LOCALLEAF_SITE_URL}" target="_blank" rel="noopener">Open LocalLeaf website ${uiGlyph("external")}</a>
              <span>Built for student groups and quick self-hosted sessions.</span>
            </div>
          </div>
        `}
      </section>
    </div>
  `);
  const modal = document.querySelector(".info-modal-backdrop");
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) modal.remove();
  });
  modal?.querySelector("[data-close-info]")?.addEventListener("click", () => modal.remove());
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
  const parts = renameNameParts(item);
  const label = item.name || pathBasename(item.path);
  return `
    <span class="tree-rename-wrap">
      <input class="tree-rename-input"
        data-rename-path="${escapeHtml(item.path)}"
        data-rename-kind="${escapeHtml(item.type)}"
        data-rename-extension="${escapeHtml(parts.extension)}"
        value="${escapeHtml(parts.stem)}"
        spellcheck="false"
        autocomplete="off"
        aria-label="Rename ${escapeHtml(label)}" />
      ${parts.extension ? `<span class="tree-rename-extension">${escapeHtml(parts.extension)}</span>` : ""}
    </span>
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
  if (item.type === "directory") return ">";
  if (item.type === "image") return "[img]";
  if (item.path === local.appState.project.mainFile) return "[main]";
  return icon("file");
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
      const nameMarkup = local.renamingTreePath === node.path ? renameInputMarkup(renameItem) : `<span class="folder-name">${escapeHtml(node.name)}</span>`;
      return `
        <div class="tree-folder" data-depth="${depth}">
          <button class="tree-folder-row folder-toggle ${isSelected ? "active" : ""} ${depth > 0 ? "nested" : ""}"
            data-folder="${escapeHtml(node.path)}"
          data-drag-path="${escapeHtml(node.path)}"
          data-drag-kind="directory"
          data-drop-folder="${escapeHtml(node.path)}"
          draggable="true"
          style="--depth:${depth}">
          <span class="folder-caret">${isCollapsed ? ">" : "v"}</span>
          ${nameMarkup}
          <span class="folder-count">${children.length}</span>
        </button>
        ${isCollapsed ? "" : `<div class="tree-children">${children.map((child) => renderTreeNode(child, selectedFile, depth + 1)).join("")}</div>`}
      </div>
    `;
  }

    const item = node.item;
    const selectable = isEditableFile(item) || isImageAsset(item);
    const labelMarkup = local.renamingTreePath === item.path ? renameInputMarkup(item) : `<span class="file-label">${escapeHtml(item.name)}</span>`;
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
      <span>${fileIconFor(item)}</span>${labelMarkup}
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
        <span class="folder-caret">${local.imagesCollapsed ? ">" : "v"}</span>
        <span class="folder-name">Images</span>
        <span class="folder-count">${images.length}</span>
      </button>
        ${local.imagesCollapsed ? "" : `<div class="tree-children">
          ${isEmpty ? `<div class="tree-empty">No images in this project.</div>` : ""}
          ${images.map((item) => `
            <button class="file-button tree-file image-file ${item.path === selectedFile && !local.selectedFolder ? "active" : ""} nested"
            data-file="${escapeHtml(item.path)}"
            data-kind="image"
            data-selectable="1"
            data-drag-path="${escapeHtml(item.path)}"
            data-drag-kind="image"
            draggable="true"
            style="--depth:1">
            <span>[img]</span>${local.renamingTreePath === item.path ? renameInputMarkup(item) : `<span class="file-label">${escapeHtml(item.path)}</span>`}
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
            <span class="outline-caret" aria-hidden="true">${hasChildren ? "âŒ„" : ""}</span>
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
    <div class="editor-style-menu-wrap">
      <button class="editor-style-button ${local.editorStyleMenuOpen ? "active" : ""}" id="editorStyleButton" type="button" title="Insert section command" aria-label="Insert section command" aria-haspopup="menu" aria-expanded="${local.editorStyleMenuOpen ? "true" : "false"}">
        <span>Normal text</span>
        <span class="style-chevron" aria-hidden="true"></span>
      </button>
      ${local.editorStyleMenuOpen ? editorStyleMenuMarkup() : ""}
    </div>
  `;
}

function editorStyleMenuMarkup() {
  return `
    <div class="editor-style-menu" role="menu" aria-label="Text style">
      ${EDITOR_STYLE_OPTIONS.map((item) => `
        <button type="button" class="editor-style-option ${escapeHtml(item.className)}" data-style-value="${escapeHtml(item.value)}" role="menuitem">
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
        <button class="editor-mode-pill active" type="button" role="tab" aria-selected="true">Code Editor</button>
        <button class="editor-mode-pill coming-soon" type="button" role="tab" aria-selected="false" disabled title="Visual Editor is coming soon">Visual Editor <span>soon</span></button>
      </div>
      <button class="editor-tool-button ${local.searchOpen ? "active" : ""}" id="editorSearchToggle" title="Search and replace" aria-label="Search and replace">
        ${editorToolIcon("search")}
      </button>
      <span class="format-row-spacer"></span>
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
    <section class="editor-search-popover" role="search" aria-label="Search and replace">
      <div class="editor-search-scope" role="group" aria-label="Search scope">
        <button type="button" class="${projectScope ? "active" : ""}" data-search-scope="project">All files</button>
        <button type="button" class="${!projectScope ? "active" : ""}" data-search-scope="file">Current file</button>
      </div>
      <div class="editor-search-fields">
        <div class="editor-search-input-row">
          <input id="editorSearchInput" value="${escapeHtml(local.searchQuery)}" placeholder="Search for" autocomplete="off" />
          <button class="search-toggle ${local.searchMatchCase ? "active" : ""}" id="searchMatchCase" title="Match case" aria-label="Match case">Aa</button>
          <button class="search-toggle ${local.searchRegex ? "active" : ""}" id="searchRegex" title="Use regular expression" aria-label="Use regular expression">.*</button>
          <button class="search-toggle ${local.searchWholeWord ? "active" : ""}" id="searchWholeWord" title="Whole word" aria-label="Whole word">W</button>
        </div>
        <input id="editorReplaceInput" value="${escapeHtml(local.searchReplace)}" placeholder="Replace with" autocomplete="off" />
      </div>
      <div class="editor-search-actions">
        <button class="editor-tool-button" id="searchPrevious" title="Previous match" aria-label="Previous match">&uarr;</button>
        <button class="editor-tool-button" id="searchNext" title="Next match" aria-label="Next match">&darr;</button>
        <button class="btn" id="replaceOne" ${projectScope ? "disabled" : ""}>Replace</button>
        <button class="btn" id="replaceAll">${projectScope ? "Replace All Files" : "Replace All"}</button>
        <span class="search-status" id="searchStatus">${searchStatusMarkup()}</span>
        <button class="editor-tool-button" id="closeSearchPanel" title="Close search" aria-label="Close search">x</button>
      </div>
      ${projectScope ? `<div class="project-search-note">All-files search opens matches across the project. Replace All asks before changing every text file.</div>` : ""}
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
  if (state.compile.mode === "pdf") {
    return `<div class="pdf-preview-mount" data-pdf-url="${escapeHtml(authUrl(`/api/pdf?v=${state.compile.version}`))}"></div>`;
  }
  return state.compile.previewHtml || `<article class="paper-preview"><header class="paper-title"><h1>Compile to Preview</h1><p>Click Recompile to render the document preview.</p></header></article>`;
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
    <div class="pdf-zoom-controls" aria-label="PDF zoom controls">
      <button class="pdf-zoom-button" id="pdfZoomOut" type="button" title="Zoom out" aria-label="Zoom out">-</button>
      <span class="pdf-zoom-value" id="pdfZoomValue">${Math.round(local.pdfScale * 100)}%</span>
      <button class="pdf-zoom-button" id="pdfZoomIn" type="button" title="Zoom in" aria-label="Zoom in">+</button>
    </div>
    <a class="pdf-link" href="${authUrl(`/api/pdf?v=${compile.version}`)}" target="_blank" rel="noopener">PDF</a>
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
      <span class="log-chip error">${counts.error} errors</span>
      <span class="log-chip warning">${counts.warning} warnings</span>
      <span class="log-chip info">${counts.info + counts.success} info</span>
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
          <strong>Pinned errors</strong>
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

function mountPdfPreview(scrollState = null) {
  const previewPane = document.querySelector("#previewPane");
  const marker = previewPane?.querySelector(".pdf-preview-mount");
  if (!previewPane || !marker || !window.LocalLeafPdfPreview?.mount) return false;
  if (local.appState?.compile?.status === "running") return false;
  window.LocalLeafPdfPreview.mount(previewPane, {
    url: marker.dataset.pdfUrl,
    scale: local.pdfScale,
    scrollState
  });
  updatePdfZoomUi();
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

function bindPdfPreviewControls() {
  document.querySelector("#pdfZoomOut")?.addEventListener("click", () => setPdfScale(local.pdfScale - 0.1));
  document.querySelector("#pdfZoomIn")?.addEventListener("click", () => setPdfScale(local.pdfScale + 0.1));
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

function editorMoreMenuMarkup(state, selection) {
  if (!local.editorMoreMenuOpen) return "";
  const menuButton = (action, label, detail = "", options = {}) => `
    <button type="button"
      class="editor-more-item ${options.active ? "active" : ""} ${options.danger ? "danger" : ""}"
      data-editor-more-action="${escapeHtml(action)}"
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
        ${menuButton("settings", "Settings", "Theme and update checks", { icon: icon("settings") })}
        ${menuButton("help", "Help", "Q&A and app guidance", { icon: icon("help") })}
        ${menuButton("about", "About", "Website and project info", { icon: icon("info") })}
        ${updateCheckButtonMarkup("editorCheckUpdates", "Check for updates", "editor-more-update")}
        ${menuButton("set-main", "Set as main file", state.project.mainFile || "No main file", { disabled: !selection.canSetMain, icon: editorToolIcon("ref") })}
        <a class="editor-more-item" href="${authUrl("/api/export/zip")}" download="${escapeHtml(downloadFileName(state.project.name, ".zip"))}" role="menuitem">
          <span class="editor-menu-icon">${icon("download")}</span>
          <span class="editor-menu-copy">
            <span>Download ZIP</span>
            <small>Save the whole project</small>
          </span>
        </a>
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

function closeEditorMoreMenuInPlace() {
  local.editorMoreMenuOpen = false;
  document.querySelector(".editor-more-menu")?.remove();
  const button = document.querySelector("#editorMoreButton");
  button?.classList.remove("active");
  button?.setAttribute("aria-expanded", "false");
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
  const fallbackFile = local.appState.project.mainFile || local.appState.project.files.find((item) => item.type === "text" || item.type === "image")?.path || "";
  const selection = selectedFileState(local.selectedFile || fallbackFile);
  button.insertAdjacentHTML("afterend", editorMoreMenuMarkup(local.appState, selection));
  bindEditorMoreActions();
}

function bindEditorMoreActions() {
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
      if (action === "set-main") {
        setMainFile();
        return;
      }
      if (action === "toggle-files") setSidebarVisible(!local.sidebarVisible);
      else if (action === "toggle-editor") toggleLayoutPane("source");
      else if (action === "toggle-pdf") toggleLayoutPane("preview");
      else if (action === "toggle-logs") toggleLayoutPane("logs");
      else if (action === "toggle-chat") setRightRailVisible(!local.rightRailVisible);
      render();
    });
  });
}

function chatHeaderMarkup() {
  const session = local.appState.session;
  const canShare = Boolean(session.inviteUrl);
  return `
    <div class="panel-head chat-head">
      <div class="chat-title">
        <strong>Chat</strong>
        <small>${session.status === "live" ? "Session live" : "Start a session to share"}</small>
      </div>
      <div class="chat-actions">
        <button class="chat-share-button" id="shareInviteFromChat" title="${canShare ? "Copy invite link" : "Start a session first"}" aria-label="Copy invite link" ${canShare ? "" : "disabled"}>
          <span class="link-glyph" aria-hidden="true"></span>
          <span>Share</span>
        </button>
      </div>
    </div>
  `;
}

function chatMessageMarkup(message) {
  const isOwnMessage = message.author === local.userName;
  return `
    <div class="chat-message ${isOwnMessage ? "own" : ""}">
      <div class="avatar">${escapeHtml(message.author[0] || "?")}</div>
      <div class="chat-bubble">
        <div class="chat-meta">
          <strong>${escapeHtml(message.author)}</strong>
          <time>${new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <p>${escapeHtml(message.message)}</p>
      </div>
    </div>
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
  return `
    <section class="chat-panel right-rail-panel ${local.rightRailTab === "chat" ? "active" : ""}" ${local.rightRailTab === "chat" ? "" : "hidden"}>
      ${chatHeaderMarkup()}
      <div class="chat-list">
        ${state.chat.length ? state.chat.map(chatMessageMarkup).join("") : `<div class="chat-empty">No messages yet.</div>`}
      </div>
      <section class="users-panel chat-users-inline">
        <div class="panel-head">Users (${state.session.users.length})</div>
        <div class="users-list">
          ${state.session.users.map(userRowMarkup).join("")}
        </div>
      </section>
      <form class="chat-input" id="chatForm">
        <input id="chatText" placeholder="Send a message" />
        <button class="btn" style="height:30px">Send</button>
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
        <small>${escapeHtml(user.role)}${activeFileForUser(user.id) ? ` Â· ${escapeHtml(activeFileForUser(user.id))}` : ""}</small>
      </div>
      <span class="online-dot"></span>
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
    const lines = hunks.flatMap((hunk) => hunk.lines || []).slice(0, 80);
    return `
      <pre class="ai-diff-preview">${lines.map((line) => {
        const marker = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
        return `<span class="diff-${escapeHtml(line.type || "context")}"><b>${marker}</b> ${escapeHtml(line.text || "")}</span>`;
      }).join("\n") || `<span>Preview unavailable</span>`}</pre>
    `;
  }
  const newText = String(proposal.newText || proposal.replacements?.[0]?.text || "");
  const lines = newText.split(/\r?\n/).filter(Boolean).slice(-8);
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

function aiChangeRuns(items) {
  const groups = new Map();
  items.forEach((proposal) => {
    const runId = aiRunIdForProposal(proposal);
    if (!groups.has(runId)) {
      groups.set(runId, {
        id: runId,
        createdAt: proposal.createdAt || Date.now(),
        updatedAt: proposal.appliedAt || proposal.rejectedAt || proposal.revertedAt || proposal.createdAt || Date.now(),
        proposals: []
      });
    }
    const group = groups.get(runId);
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
  const canApply = ["pending", "proposed"].includes(status);
  return `
    <article class="ai-change-card ai-approval-card ${escapeHtml(status)}" data-ai-proposal="${escapeHtml(proposal.id)}">
      <div class="ai-change-head">
        <div>
          <strong>${escapeHtml(proposal.path || local.selectedFile || "Current file")}</strong>
          <span>${escapeHtml(proposal.summary || "AI proposed a text edit.")}</span>
        </div>
        <b>${escapeHtml(status)}</b>
      </div>
      ${aiProposalDiffMarkup(proposal)}
      <div class="ai-change-actions">
        <button class="btn btn-primary" data-apply-ai-proposal="${escapeHtml(proposal.id)}" ${canApply ? "" : "disabled"}>Approve</button>
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
  const canRevert = status === "applied";
  return `
    <article class="ai-change-card ai-history-card ${escapeHtml(status)} ${expanded ? "expanded" : ""}" data-ai-proposal="${escapeHtml(proposal.id)}">
      <button type="button" class="ai-change-toggle" data-toggle-ai-change="${escapeHtml(proposal.id)}" aria-expanded="${expanded ? "true" : "false"}">
        <span>
          <strong>${escapeHtml(proposal.summary || "AI proposed a text edit.")}</strong>
          <small>${escapeHtml(proposal.path || "Current file")}</small>
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
          <button class="btn" data-open-ai-proposal="${escapeHtml(proposal.id)}">Open file</button>
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

function aiMessageMarkup(message) {
  return `
    <div class="ai-message ai-message-${escapeHtml(message.role || "assistant")}">
      <div class="ai-message-body">
        <span class="ai-message-role">${message.role === "user" ? "You" : "LocalLeaf"}</span>
        <p>${escapeHtml(message.message || "")}</p>
        ${Array.isArray(message.fileLinks) && message.fileLinks.length ? `
          <div class="ai-file-links">
            ${message.fileLinks.map((file) => `<button type="button" data-open-ai-file-link="${escapeHtml(file)}">${escapeHtml(file)}</button>`).join("")}
          </div>
        ` : ""}
        ${aiMessageApprovalCardsMarkup(message)}
      </div>
    </div>
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
            <button type="button" class="ai-strip-action" data-steer-queued-ai-prompt="${escapeHtml(queued.id)}" title="Steer the active AI run" aria-label="Steer the active AI run"><span>Steer</span></button>
            <button type="button" class="ai-strip-action ai-strip-icon" data-delete-queued-ai-prompt="${escapeHtml(queued.id)}" title="Delete queued message" aria-label="Delete queued message">${editorToolIcon("delete")}</button>
            <div class="ai-strip-more-wrap ${isMenuOpen ? "open" : ""}">
              <button type="button" class="ai-strip-action ai-strip-icon" data-toggle-queued-ai-menu="${escapeHtml(queued.id)}" title="Queue actions" aria-label="Queue actions" aria-expanded="${isMenuOpen ? "true" : "false"}">...</button>
              ${isMenuOpen ? `
                <div class="ai-strip-menu" role="menu">
                  <button type="button" data-edit-queued-ai-prompt="${escapeHtml(queued.id)}" role="menuitem">${editorToolIcon("edit")} Edit queued message</button>
                  <button type="button" data-steer-queued-ai-prompt="${escapeHtml(queued.id)}" role="menuitem">${editorToolIcon("edit")} Steer now</button>
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

function aiSessionMenuMarkup() {
  const sessions = local.aiSessions.slice(0, 8);
  return `
    <div class="ai-session-picker ${local.aiSessionMenuOpen ? "open" : ""}">
      <button class="ai-session-plus" id="aiSessionMenuButton" type="button" title="AI sessions" aria-label="AI sessions" aria-expanded="${local.aiSessionMenuOpen ? "true" : "false"}">${uiGlyph("plus")}</button>
      ${local.aiSessionMenuOpen ? `
        <div class="ai-session-menu" role="menu">
          <button type="button" class="ai-session-new" data-ai-session-new role="menuitem">${uiGlyph("plus")} New session</button>
          <div class="ai-session-menu-label">Recent sessions</div>
          ${sessions.map((session) => `
            <div class="ai-session-menu-row ${session.id === local.aiCurrentSessionId ? "active" : ""}">
              <button type="button" role="menuitem" data-ai-session="${escapeHtml(session.id)}">
                <strong>${escapeHtml(session.title || "New session")}</strong>
                <span>${new Date(session.updatedAt || session.createdAt || Date.now()).toLocaleDateString()}</span>
              </button>
              <button type="button" class="ai-session-delete" data-delete-ai-session="${escapeHtml(session.id)}" title="Delete session" aria-label="Delete ${escapeHtml(session.title || "session")}">x</button>
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function aiModelChipMarkup() {
  const active = activeAiProviderModel();
  const permissionLabel = local.aiPermissions.yoloMode ? "YOLO" : "Default";
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
  return `
    <div class="ai-model-picker ${local.aiModelPickerOpen ? "open" : ""}">
      <button class="ai-model-chip" id="aiModelChip" type="button" aria-haspopup="menu" aria-expanded="${local.aiModelPickerOpen ? "true" : "false"}">
        <span>${escapeHtml(active.providerName)}</span>
        <strong>${escapeHtml(active.modelName)}</strong>
      </button>
      ${local.aiModelPickerOpen ? `
        <div class="ai-model-menu" role="menu">
          <div class="ai-model-menu-toolbar">
            <input id="aiModelSearch" value="${escapeHtml(local.aiModelSearch)}" placeholder="Search models" autocomplete="off" />
            <button type="button" data-open-provider-dialog title="Connect provider" aria-label="Connect provider">${uiGlyph("plus")}</button>
            <button type="button" data-open-model-settings title="Manage models" aria-label="Manage models">${uiGlyph("settings")}</button>
            <button type="button" data-close-ai-model-picker title="Close model picker" aria-label="Close model picker">x</button>
          </div>
          ${[...grouped.entries()].map(([providerName, providerItems]) => `
            <div class="ai-model-menu-group">
              <span class="ai-model-menu-provider">${escapeHtml(providerName)}</span>
              ${providerItems.slice(0, 10).map((item) => {
                const sameLocalProvider = ["local", "localleaf-local"].includes(active.providerId) && ["local", "localleaf-local"].includes(item.providerId);
                const isActive = (active.providerId === item.providerId || sameLocalProvider) && active.modelId === item.modelId;
                return `
                  <button type="button" role="menuitem" data-picker-provider="${escapeHtml(item.providerId)}" data-picker-model="${escapeHtml(item.modelId)}" class="${isActive ? "active" : ""}">
                    <strong>${escapeHtml(item.label)}</strong>
                    ${isActive ? `<span class="ai-model-check" aria-hidden="true"></span>` : ""}
                  </button>
                `;
              }).join("")}
            </div>
          `).join("") || `<div class="ai-model-empty">No models match.</div>`}
        </div>
      ` : ""}
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

function aiHelperPanelMarkup() {
  return `
    <section class="ai-helper-panel right-rail-panel ${local.rightRailTab === "ai" ? "active" : ""}" ${local.rightRailTab === "ai" ? "" : "hidden"}>
      <div class="panel-head ai-helper-head">
        <div>
          <strong>AI Helper</strong>
        </div>
        <button class="icon-button chat-tool" id="openAiSettings" title="Manage models" aria-label="Manage models">${uiGlyph("settings")}</button>
      </div>
      <div class="ai-chat-wrap">
        <div class="ai-chat-list" id="aiChatList">
          ${local.aiMessages.map(aiMessageMarkup).join("")}
          ${local.aiActivityMessage ? aiWorkingMarkup() : ""}
        </div>
        <button class="ai-scroll-latest ${local.aiChatNeedsJump ? "visible" : ""}" id="aiScrollLatest" type="button" title="Jump to latest" aria-label="Jump to latest" aria-hidden="${local.aiChatNeedsJump ? "false" : "true"}">${downArrowIcon()}</button>
      </div>
      ${aiQueuedPromptStripMarkup()}
      <form class="ai-input-form" id="aiHelperForm">
        <textarea id="aiPrompt" rows="2" placeholder="Ask AI Helper...">${escapeHtml(local.aiPrompt)}</textarea>
        <div class="ai-composer-footer">
          <div class="ai-composer-left">
            ${aiSessionMenuMarkup()}
            ${aiModelChipMarkup()}
          </div>
          ${aiSendButtonMarkup()}
        </div>
      </form>
    </section>
  `;
}

function aiRunChangeMarkup(run) {
  const expanded = local.aiExpandedRuns.has(run.id);
  const stats = aiRunStats(run);
  const appliedCount = stats.applied;
  const fileCount = new Set(run.proposals.map((proposal) => proposal.path || "Current file")).size;
  return `
    <section class="ai-run-change ${expanded ? "expanded" : ""}" data-ai-run="${escapeHtml(run.id)}">
      <div class="ai-run-head">
        <button type="button" class="ai-run-toggle" data-toggle-ai-run="${escapeHtml(run.id)}" aria-expanded="${expanded ? "true" : "false"}">
          <strong>${fileCount} file${fileCount === 1 ? "" : "s"} changed</strong>
          <span class="diff-added">+${stats.added}</span>
          <span class="diff-removed">-${stats.removed}</span>
        </button>
        <div class="ai-run-actions">
          <button type="button" data-undo-ai-run="${escapeHtml(run.id)}" ${appliedCount ? "" : "disabled"}>Undo</button>
          <button type="button" data-review-ai-run="${escapeHtml(run.id)}">Review</button>
          <button type="button" data-toggle-ai-run="${escapeHtml(run.id)}" title="${expanded ? "Collapse run" : "Expand run"}" aria-label="${expanded ? "Collapse run" : "Expand run"}">${expanded ? "^" : "v"}</button>
        </div>
      </div>
      ${expanded ? `<div class="ai-run-files">${run.proposals.map(aiHistoryCardMarkup).join("")}</div>` : ""}
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
  return proposal.approvalRequired === false || local.aiPermissions.yoloMode;
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

function stopAiRun() {
  local.aiStopRequested = true;
  local.aiRunControllers.forEach((controller) => controller.abort());
  local.aiRunControllers.clear();
  local.aiActiveRunCount = 0;
  local.aiBusy = false;
  local.aiActiveRunId = "";
  local.aiCompileVerifying = false;
  local.aiActivityMessage = "";
  local.aiForceScrollBottom = true;
  refreshRightRailUi();
}

function scrollAiChatToBottom({ smooth = false } = {}) {
  const list = document.querySelector("#aiChatList") || document.querySelector(".ai-chat-list");
  if (!list) return;
  list.scrollTo({ top: list.scrollHeight, behavior: smooth ? "smooth" : "auto" });
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

function createQueuedAiPrompt(prompt) {
  const activeModel = activeAiProviderModel();
  return {
    id: `queued-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    message: String(prompt || "").trim(),
    createdAt: Date.now(),
    path: local.selectedFile,
    selectedText: selectedEditorText(),
    model: {
      providerId: activeModel.providerId || "",
      modelId: activeModel.modelId || "",
      providerName: activeModel.providerName || "",
      modelName: activeModel.modelName || ""
    },
    permissions: { ...local.aiPermissions }
  };
}

function queueAiPrompt(prompt) {
  const queued = createQueuedAiPrompt(prompt);
  if (!queued.message) return null;
  local.aiQueuedPrompts.push(queued);
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

async function steerQueuedAiPrompt(id) {
  const queued = findQueuedAiPrompt(id);
  if (!queued) return;
  local.aiQueuedPrompts = local.aiQueuedPrompts.filter((item) => item.id !== queued.id);
  if (local.aiEditingQueuedPromptId === queued.id) {
    local.aiEditingQueuedPromptId = "";
    local.aiPrompt = "";
  }
  local.aiSessionMoreMenuOpen = false;
  if (local.aiQueuedPromptMenuOpenId === queued.id) local.aiQueuedPromptMenuOpenId = "";
  refreshRightRailUi();
  await askAiHelper(queued.message, { queuedPrompt: queued, steer: true, allowWhileBusy: true });
}

async function askAiHelper(message, options = {}) {
  const prompt = String(message || local.aiPrompt || "").trim();
  if (!prompt) return;
  if (local.aiEditingQueuedPromptId && !options.steer) {
    commitQueuedPromptEdit();
    return;
  }
  if (local.aiBusy && !options.allowWhileBusy) {
    queueAiPrompt(prompt);
    return;
  }
  const activeModel = activeAiProviderModel();
  const queuedModel = options.queuedPrompt?.model || null;
  const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const controller = new AbortController();
  local.aiRunControllers.add(controller);
  local.aiStopRequested = false;
  local.aiPrompt = "";
  local.aiActiveRunCount += 1;
  local.aiBusy = local.aiActiveRunCount > 0;
  local.aiActiveRunId = local.aiActiveRunId || runId;
  local.aiActivityMessage = options.steer ? "Steering the active run" : "Reading the project and planning the edit";
  local.rightRailTab = "ai";
  localStorage.setItem("localleaf.rightRailTab", "ai");
  local.aiForceScrollBottom = true;
  local.aiMessages.push({ id: `user-${Date.now()}`, role: "user", message: prompt });
  syncCurrentAiSession(prompt);
  refreshRightRailUi();
  try {
    const response = await api(options.steer ? "/api/agent/steer" : "/api/agent/message", {
      method: "POST",
      signal: controller.signal,
      body: {
        runId: options.steer ? local.aiActiveRunId : runId,
        queuedPromptId: options.queuedPrompt?.id || "",
        message: prompt,
        path: options.queuedPrompt?.path || local.selectedFile,
        currentText: currentEditorText(),
        selectedText: options.queuedPrompt?.selectedText || selectedEditorText(),
        compileLogs: local.appState?.compile?.logs || [],
        conversation: local.aiMessages.slice(-12).map((item) => ({
          role: item.role,
          message: item.message || ""
        })),
        aiProviderId: queuedModel?.providerId || activeModel.providerId || "",
        aiModelId: queuedModel?.modelId || activeModel.modelId || "",
        aiPermissions: options.queuedPrompt?.permissions || local.aiPermissions
      }
    });
    const proposals = (response.proposals || []).map((proposal) => ({ ...proposal, status: proposal.status || "proposed", sessionId: local.aiCurrentSessionId }));
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
    local.aiMessages.push({
      id: `assistant-${Date.now()}`,
      role: "assistant",
      message: response.reply || "I prepared a response.",
      proposals,
      approvalCards: visibleApprovalIds
    });
    syncCurrentAiSession(prompt);
    if (autoApplied.length) await verifyAiRunAfterApply(autoApplied);
  } catch (error) {
    if (!controller.signal.aborted) {
      local.aiMessages.push({
        id: `assistant-error-${Date.now()}`,
        role: "assistant",
        message: error.message || "AI Helper could not respond."
      });
      syncCurrentAiSession(prompt);
    }
  } finally {
    local.aiRunControllers.delete(controller);
    local.aiActiveRunCount = controller.signal.aborted ? local.aiRunControllers.size : Math.max(0, local.aiActiveRunCount - 1);
    local.aiBusy = local.aiActiveRunCount > 0;
    if (!local.aiBusy) local.aiActiveRunId = "";
    if (!local.aiBusy && !local.aiCompileVerifying) local.aiActivityMessage = "";
    local.aiForceScrollBottom = true;
    refreshRightRailUi();
    if (!local.aiBusy && !controller.signal.aborted && !local.aiStopRequested) {
      const queued = local.aiQueuedPrompts.shift();
      if (queued?.message) setTimeout(() => askAiHelper(queued.message, { queuedPrompt: queued, allowWhileBusy: true }), 0);
    }
    if (!local.aiBusy) local.aiStopRequested = false;
  }
}

async function approveAiProposal(proposalId, options = {}) {
  const proposal = findAiProposal(proposalId);
  if (!proposal) return;
  let appliedProposal = null;
  let verifierOwnsActivity = false;
  setAiActivity(options.fromYolo ? "Applying YOLO edit" : "Applying approved change", { render: options.renderAfter !== false });
  try {
    const result = await api("/api/agent/approval/approve", { method: "POST", body: { proposalId } });
    appliedProposal = result.proposal || null;
    setAiProposalStatus(proposalId, appliedProposal?.status || "applied", appliedProposal || {});
    await loadState();
    if (!local.selectedFile || proposal.path === local.selectedFile) {
      local.selectedFile = proposal.path || local.selectedFile;
      await loadSelectedFile();
      updateEditorSourceUi();
    }
    if (options.fromYolo && !options.suppressAutoApplyMessage) {
      local.aiMessages.push({
        id: `assistant-auto-apply-${Date.now()}`,
        role: "assistant",
        message: `YOLO mode applied the approved-safe edit to ${proposal.path || "the current file"}.`
      });
    }
    if (options.verifyCompile !== false) {
      verifierOwnsActivity = true;
      refreshRightRailUi();
      await verifyAiRunAfterApply([appliedProposal || proposal]);
    }
    return appliedProposal || proposal;
  } catch (error) {
    setAiProposalStatus(proposalId, "stale");
    local.aiMessages.push({
      id: `assistant-apply-error-${Date.now()}`,
      role: "assistant",
      message: error.message || "Could not apply the proposal."
    });
    return null;
  } finally {
    if (!verifierOwnsActivity) clearAiActivity({ render: false });
    syncCurrentAiSession();
    if (options.renderAfter !== false) refreshRightRailUi();
  }
}

async function rejectAiProposal(proposalId) {
  try {
    const result = await api("/api/agent/approval/reject", { method: "POST", body: { proposalId } });
    setAiProposalStatus(proposalId, result.proposal?.status || "rejected", result.proposal || {});
  } catch (error) {
    setAiProposalStatus(proposalId, "rejected");
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
    message: `${proposal.summary || "This change updates the selected text file."} It targets ${proposal.path || "the current file"} and is listed in Changes.`,
    fileLinks: proposal.path ? [proposal.path] : []
  });
  syncCurrentAiSession();
  refreshRightRailUi();
}

async function openAiProposalFile(proposalId) {
  const proposal = findAiProposal(proposalId);
  if (!proposal?.path) return;
  local.selectedFile = proposal.path;
  local.sourcePaneVisible = true;
  localStorage.setItem("localleaf.sourcePaneVisible", "1");
  local.editorMode = "code";
  localStorage.setItem("localleaf.editorMode", "code");
  try {
    const previewScroll = capturePreviewScroll();
    await loadSelectedFile();
    expandToFile(proposal.path);
    local.rightRailTab = "changes";
    await render();
    restorePreviewScroll(previewScroll);
    setTimeout(() => {
      const focus = proposal.focus || {};
      const start = Number.isInteger(focus.start) ? focus.start : 0;
      const end = Number.isInteger(focus.end) ? Math.max(start, focus.end) : start;
      local.codeEditor?.selectRange?.(start, end);
      local.codeEditor?.focus?.();
    }, 0);
  } catch (error) {
    showAppNotice(error.message || "Could not open the proposal file.", { title: "Open file" });
  }
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
  const repairMessage = [
    `Fix the LaTeX compile errors caused by AI run ${runId}.`,
    "Keep the intended edit, make the smallest safe repair, and return a LocalLeaf proposal.",
    `Repair attempt ${attempt} of 3.`
  ].join(" ");
  const response = await api("/api/agent/message", {
    method: "POST",
    body: {
      runId,
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
    runId: proposal.runId || runId
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

function reviewAiRun(runId) {
  local.aiExpandedRuns.add(runId);
  const proposal = aiHistoryItems().find((item) => aiRunIdForProposal(item) === runId);
  refreshRightRailUi();
  if (proposal) openAiProposalFile(proposal.id);
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

async function revertAiProposal(proposalId, options = {}) {
  const proposal = findAiProposal(proposalId);
  if (!proposal) return null;
  try {
    const result = await api("/api/agent/proposal/revert", { method: "POST", body: { proposalId } });
    setAiProposalStatus(proposalId, result.proposal?.status || "reverted", result.proposal || {});
    await loadState();
    if (proposal.path === local.selectedFile) {
      await loadSelectedFile();
      updateEditorSourceUi();
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

async function undoAiRun(runId) {
  try {
    const result = await api("/api/agent/run/revert", { method: "POST", body: { runId } });
    (result.proposals || []).forEach((proposal) => setAiProposalStatus(proposal.id, proposal.status || "reverted", proposal));
    await loadState();
    if (result.proposals?.some((proposal) => proposal.path === local.selectedFile)) {
      await loadSelectedFile();
      updateEditorSourceUi();
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
    refreshRightRailUi();
  });
  document.querySelectorAll("[data-edit-queued-ai-prompt]").forEach((button) => {
    button.addEventListener("click", () => editQueuedAiPrompt(button.dataset.editQueuedAiPrompt));
  });
  document.querySelectorAll("[data-delete-queued-ai-prompt]").forEach((button) => {
    button.addEventListener("click", () => deleteQueuedAiPrompt(button.dataset.deleteQueuedAiPrompt));
  });
  document.querySelectorAll("[data-steer-queued-ai-prompt]").forEach((button) => {
    button.addEventListener("click", () => steerQueuedAiPrompt(button.dataset.steerQueuedAiPrompt));
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
  document.querySelector("[data-ai-session-new]")?.addEventListener("click", startNewAiSession);
  document.querySelectorAll("[data-ai-session]").forEach((button) => {
    button.addEventListener("click", () => switchAiSession(button.dataset.aiSession));
  });
  document.querySelectorAll("[data-delete-ai-session]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteAiSession(button.dataset.deleteAiSession);
    });
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
    button.addEventListener("click", () => reviewAiRun(button.dataset.reviewAiRun));
  });
  document.querySelectorAll("[data-undo-ai-run]").forEach((button) => {
    button.addEventListener("click", () => undoAiRun(button.dataset.undoAiRun));
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

async function selectProjectFile(filePath) {
  const item = fileMeta(filePath);
  if (!item || (!isEditableFile(item) && !isImageAsset(item))) return;
  await saveCurrentFile();
  local.selectedFile = filePath;
  local.selectedFolder = "";
  expandToFile(filePath);
  local.saveStatus = "Saved";
  if (isEditableFile(item)) {
    await loadSelectedFile();
  } else {
    local.editorContent = "";
  }
  updateEditorSourceUi();
  updateSidebarUi();
  if (isEditableFile(item)) {
    sendCollab("open_file", { filePath });
  }
}

function editorView() {
  const state = local.appState;
  const file = local.selectedFile || state.project.mainFile || state.project.files.find((item) => item.type === "text" || item.type === "image")?.path || "";
  const compileLogs = state.compile.logs || [];
  syncPinnedCompileIssues(state.compile);
  const selection = selectedFileState(file);
  const isCompiling = state.compile.status === "running";
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
            ${editorMoreMenuMarkup(state, selection)}
            <button class="btn editor-save-button" id="saveButton" ${selection.canEditSelected ? "" : "disabled"}>
              <span class="save-glyph" aria-hidden="true"></span>
              <span>Save</span>
            </button>
          </div>
          <div class="editor-title-block">
            <h1>${escapeHtml(state.project.name)}</h1>
            <span class="editor-subtitle">Main: ${escapeHtml(state.project.mainFile || "none")} Â· ${escapeHtml(local.saveStatus)}</span>
          </div>
            <div class="toolbar-actions editor-run-actions">
              <button class="compile-button ${isCompiling ? "compiling" : ""}" id="compileButton" ${isCompiling ? "disabled" : ""}>
              <span class="compile-spinner"></span>
              <span>${isCompiling ? "Compiling..." : "Recompile"}</span>
            </button>
            <button class="btn" id="exportButton" style="height:32px">Export</button>
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
              <button class="mini-button icon-mini-button" id="newFile" title="New file" aria-label="New file">${editorToolIcon("newFile")}</button>
              <button class="mini-button icon-mini-button" id="newFolder" title="New folder" aria-label="New folder">${editorToolIcon("newFolder")}</button>
              <button class="mini-button icon-mini-button" id="uploadFile" title="Upload file" aria-label="Upload file">${editorToolIcon("upload")}</button>
              <button class="mini-button icon-mini-button" id="renameFile" title="Rename selected item" aria-label="Rename selected item">${editorToolIcon("rename")}</button>
              <button class="mini-button icon-mini-button danger-mini" id="deleteFile" title="Delete selected item" aria-label="Delete selected item">${editorToolIcon("delete")}</button>
            </div>
          </div>
          <div class="file-search">
            <input id="fileSearch" value="${escapeHtml(local.fileFilter)}" placeholder="Search files" />
          </div>
          <div class="file-list tree-list">
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
            ${isCompiling ? `<div class="compile-overlay"><span class="big-spinner"></span><strong>Compiling ${escapeHtml(state.project.mainFile || "project")}</strong></div>` : ""}
            ${preview}
          </div>
        </section>

        <div class="right-rail-resizer" id="rightRailResizer" title="Resize chat panel"></div>
        ${rightRailMarkup()}
      </div>

        <footer class="log-dock">
          <div class="log-resizer" id="logResizer" title="Resize logs"></div>
          <div class="log-tabs">
            <button class="active">Logs</button>
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
  syncAiProposalsFromAppState();
  if (!isGuestClient()) rememberRecentProject(local.appState.project);
  if (!local.guestToken && !new URLSearchParams(location.search).get("name")) {
    const hostUser = local.appState.session.users.find((user) => user.role === "host");
    if (hostUser?.name) local.userName = hostUser.name;
  }
  if (!local.selectedFile) {
    local.selectedFile = local.appState.project.mainFile;
  }
  if (local.selectedFile) {
    expandToFile(local.selectedFile);
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
    localStorage.setItem("localleaf.hostRailCollapsed", local.hostRailCollapsed ? "1" : "0");
    render();
  });
  document.querySelector("#railHome")?.addEventListener("click", () => setView("home"));
  document.querySelector("#railSession")?.addEventListener("click", () => setView("session"));
  document.querySelector("#railRecent")?.addEventListener("click", () => {
    setView("home");
    setTimeout(() => document.querySelector(".home-current-panel")?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
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
  closeCollab();
  local.joinRequestId = null;
  local.guestToken = "";
  local.userName = "Host";
  local.userId = "";
  local.sessionEndedReason = "The host has ended the session.";
  local.sessionEndedDetail = "Ask the host to start it again.";
  history.pushState({}, "", "/");
  local.view = "home";
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
  document.querySelector("#newProject")?.addEventListener("click", createNewProject);
  document.querySelector("#importZip")?.addEventListener("click", () => importZipProject());
  document.querySelector("#importFiles")?.addEventListener("click", openHomeImportPicker);
  document.querySelector("#homeSessionAction")?.addEventListener("click", handleHomeSessionAction);
  document.querySelector("#homeCheckUpdates")?.addEventListener("click", manualCheckForUpdates);
  bindHomeImportTray();
}

async function openRecentProject(projectRoot) {
  if (!projectRoot) return;
  try {
    local.appState = await api("/api/project/open", { method: "POST", body: { path: projectRoot } });
    rememberRecentProject(local.appState.project);
    local.selectedFile = local.appState.project.mainFile;
    expandToFile(local.selectedFile);
    await loadSelectedFile();
    setView("project");
  } catch (error) {
    showAppNotice(error.message, { type: "error", title: "Could not open project" });
  }
}

async function createNewProject() {
  try {
    local.appState = await api("/api/project/new", { method: "POST", body: {} });
    rememberRecentProject(local.appState.project);
    local.selectedFile = local.appState.project.mainFile;
    expandToFile(local.selectedFile);
    await loadSelectedFile();
    local.saveStatus = "New project";
    setView("project");
  } catch (error) {
    alert(error.message);
  }
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
    local.appState = await api("/api/project/open", { method: "POST", body: { path: input } });
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
  local.appState = await api("/api/session/start", { method: "POST", body: {} });
  await loadSelectedFile();
  setView("session");
}

function bindSession() {
  document.querySelector("#copyInvite")?.addEventListener("click", (event) => copyInvite(event.currentTarget));
  document.querySelector("#copyInviteBottom")?.addEventListener("click", (event) => copyInvite(event.currentTarget));
  document.querySelectorAll("[data-start-session]").forEach((button) => {
    button.addEventListener("click", startSession);
  });
  document.querySelector("#openEditorFromSession")?.addEventListener("click", async () => {
    await loadSelectedFile();
    setView("editor");
  });
  document.querySelector("#stopSession")?.addEventListener("click", stopSession);
  document.querySelector("#backHome")?.addEventListener("click", () => setView("home"));
  document.querySelector("#goSession")?.addEventListener("click", () => setView("session"));
  document.querySelectorAll(".approve-request").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/join/approve", { method: "POST", body: { requestId: button.dataset.id, role: "editor" } });
      await loadState();
      render();
    });
  });
  document.querySelectorAll(".deny-request").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/join/deny", { method: "POST", body: { requestId: button.dataset.id } });
      await loadState();
      render();
    });
  });
}

function markEditorChanged(source) {
  if (local.applyingRemoteEdit) return;
  local.editorContent = typeof source === "string" ? source : source?.value || "";
  local.saveStatus = "Unsaved";
  const status = document.querySelector(".editor-subtitle");
  if (status) status.textContent = local.saveStatus;
  sendCollab("edit", { filePath: local.selectedFile, newText: local.editorContent });
  clearTimeout(local.saveTimer);
  local.saveTimer = setTimeout(saveCurrentFile, 450);
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
      await deleteSelectedFile();
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

function mountCodeEditor() {
  const host = document.querySelector("#editorText.editor-code-mount");
  if (!host) return;
  if (!window.LocalLeafEditor) {
    host.innerHTML = `<textarea class="editor-textarea editor-fallback-textarea" spellcheck="false">${escapeHtml(local.editorContent)}</textarea>`;
    return;
  }
  if (local.codeEditor?.host === host) return;
  destroyCodeEditor();
  local.codeEditor = window.LocalLeafEditor.mount({
    parent: host,
    value: local.editorContent,
    filePath: local.selectedFile,
    suggestions: local.editorSuggestions || {},
    onChange: (text) => markEditorChanged(text),
    onSave: saveAndCompile,
    onCompile: compile,
    onSearch: openEditorSearchPanel,
    onFocus: () => {
      local.editingNow = true;
    },
    onBlur: () => {
      local.editingNow = false;
    }
  });
  refreshEditorSuggestions();
}

function mountVisualEditor() {
  const host = document.querySelector("#editorText.editor-visual-mount");
  if (!host) return;
  if (local.visualEditor?.host === host) return;
  destroyCodeEditor();
  const documentNode = host.querySelector("#visualEditorDocument");
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
  if (mode !== "code" || local.editorMode === mode) return;
  local.editorContent = currentEditorText();
  local.editorMode = "code";
  local.tablePickerOpen = false;
  localStorage.setItem("localleaf.editorMode", "code");
  updateEditorSourceUi();
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
  document.querySelector("#editorSearchToggle")?.classList.toggle("active", local.searchOpen);
  document.querySelector("#editorTableButton")?.classList.toggle("active", local.tablePickerOpen);
  const styleButton = document.querySelector("#editorStyleButton");
  styleButton?.classList.toggle("active", local.editorStyleMenuOpen);
  styleButton?.setAttribute("aria-expanded", local.editorStyleMenuOpen ? "true" : "false");
  const styleWrap = document.querySelector(".editor-style-menu-wrap");
  styleWrap?.querySelector(".editor-style-menu")?.remove();
  if (local.editorStyleMenuOpen) styleWrap?.insertAdjacentHTML("beforeend", editorStyleMenuMarkup());
  topbar.querySelector(".editor-search-popover")?.remove();
  topbar.querySelector(".editor-table-popover")?.remove();
  topbar.insertAdjacentHTML("beforeend", editorSearchPanelMarkup() + tablePickerMarkup());
  positionToolbarPopover(".editor-search-popover", "#editorSearchToggle", "center");
  positionToolbarPopover(".editor-table-popover", "#editorTableButton", "start");
  bindEditorStyleMenu();
  bindEditorToolbarPanels();
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
  await api("/api/session/stop", { method: "POST", body: {} });
  await loadState();
  local.sessionEndedReason = "Host stopped the session.";
  local.sessionEndedDetail = "Anyone still connected has been told the session ended.";
  setView("home");
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
  document.querySelector("#editorCheckUpdates")?.addEventListener("click", manualCheckForUpdates);
  document.querySelector("#saveButton")?.addEventListener("click", saveAndCompile);
  bindEditorMoreActions();
  document.querySelector("#toggleSourcePane")?.addEventListener("click", () => toggleLayoutPane("source"));
  document.querySelector("#togglePreviewPane")?.addEventListener("click", () => toggleLayoutPane("preview"));
  document.querySelector("#toggleLogs")?.addEventListener("click", () => toggleLayoutPane("logs"));
  document.querySelector("#showFilesPanelInline")?.addEventListener("click", () => setSidebarVisible(true));
  document.querySelector("#hideChatRail")?.addEventListener("click", () => setRightRailVisible(false));
  document.querySelector("#showChatRail")?.addEventListener("click", () => setRightRailVisible(true));
  document.querySelector("#showChatRailInline")?.addEventListener("click", () => setRightRailVisible(true));
  document.querySelector("#shareInviteFromChat")?.addEventListener("click", (event) => copyInvite(event.currentTarget));
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
  bindPdfPreviewControls();
  bindPdfWheelZoom();
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

function clampSidebarSections(nextFiles = local.fileSectionHeight, nextImages = local.imageSectionHeight) {
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
    localStorage.setItem("localleaf.sidebarSectionLayoutVersion", SIDEBAR_SECTION_LAYOUT_VERSION);
  }
  const maxFiles = Math.max(minFiles, available - minImages - minOutline);
  const files = Math.max(minFiles, Math.min(maxFiles, Math.round(nextFiles)));
  const maxImages = Math.max(minImages, available - files - minOutline);
  const images = Math.max(minImages, Math.min(maxImages, Math.round(nextImages)));
  local.fileSectionHeight = files;
  local.imageSectionHeight = images;
  localStorage.setItem("localleaf.fileSectionHeight", String(files));
  localStorage.setItem("localleaf.imageSectionHeight", String(images));
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
  bindClick("#deleteFile", deleteSelectedFile);
  bindClick("#hideFilesPanel", () => setSidebarVisible(false));
  bindFileTreeInteractions();
  bindTreeContextMenu();
}

function bindFileTreeInteractions() {
  document.querySelectorAll(".file-button").forEach((button) => {
    const requestRename = (event) => {
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
      if (event.detail > 1) {
        startInlineRename(button.dataset.file);
        return;
      }
      await selectProjectFile(button.dataset.file);
    });
  });
  document.querySelectorAll(".folder-toggle").forEach((button) => {
    const requestRename = (event) => {
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
      if (event.detail > 1) {
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
    if (event.target.closest?.(".file-button, .tree-folder-row, .tree-rename-wrap")) return;
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
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement?.classList?.contains("tree-rename-input")) return;
        commitInlineRename(input);
      }, 0);
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

function bindEditorToolbar() {
  document.querySelectorAll("[data-editor-mode]").forEach((button) => {
    button.addEventListener("click", () => setEditorMode(button.dataset.editorMode));
  });
  document.querySelectorAll("[data-editor-command]").forEach((button) => {
    button.addEventListener("click", () => {
      const command = button.dataset.editorCommand;
      if (command === "table" && local.visualEditor) {
        local.visualEditor.exec(command);
        return;
      }
      if (local.codeEditor) local.codeEditor.exec(command);
      else local.visualEditor?.exec(command);
    });
  });
    document.querySelector("#editorSearchToggle")?.addEventListener("click", () => {
      if (local.searchOpen) closeEditorSearchPanel();
      else openEditorSearchPanel();
    });
    document.querySelector("#editorStyleButton")?.addEventListener("click", (event) => {
      event.stopPropagation();
      local.editorStyleMenuOpen = !local.editorStyleMenuOpen;
      local.searchOpen = false;
      local.tablePickerOpen = false;
      refreshEditorToolbarPanels();
    });
    bindEditorStyleMenu();
    document.querySelector("#editorSearchToggle")?.classList.toggle("active", local.searchOpen);
    document.querySelector("#editorTableButton")?.classList.toggle("active", local.tablePickerOpen);
  positionToolbarPopover(".editor-search-popover", "#editorSearchToggle", "center");
  positionToolbarPopover(".editor-table-popover", "#editorTableButton", "start");
    bindEditorToolbarPanels();
  }

function bindEditorStyleMenu() {
  document.querySelectorAll("[data-style-value]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.styleValue || "normal";
      if (local.codeEditor) local.codeEditor.exec("style", value);
      else local.visualEditor?.exec("style", value);
      local.editorStyleMenuOpen = false;
      refreshEditorToolbarPanels();
    });
  });
}

function bindEditorToolbarPanels() {
  const searchInput = document.querySelector("#editorSearchInput");
  const replaceInput = document.querySelector("#editorReplaceInput");
  searchInput?.addEventListener("input", (event) => {
    local.searchQuery = event.target.value;
    local.visualSearchIndex = 0;
    local.searchResultIndex = -1;
    local.searchStatus = "";
    if (local.searchScope === "project") scheduleProjectSearch();
    else updateSearchPanelDynamicState();
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
  shell.classList.toggle("sidebar-collapsed", !local.sidebarVisible);
  shell.classList.toggle("source-collapsed", !local.sourcePaneVisible);
  shell.classList.toggle("preview-collapsed", !local.previewPaneVisible);
  shell.classList.toggle("right-rail-collapsed", !local.rightRailVisible);
  shell.classList.toggle("logs-hidden", !local.logsVisible);
  applySidebarSectionStyles();
  document.querySelector("#toggleSourcePane")?.classList.toggle("active", local.sourcePaneVisible);
  document.querySelector("#togglePreviewPane")?.classList.toggle("active", local.previewPaneVisible);
  document.querySelector("#toggleLogs")?.classList.toggle("active", local.logsVisible);
}

function updateSidebarUi() {
  const state = local.appState;
  const file = local.selectedFile;
  const textFiles = state.project.files.filter((item) => item.type === "text");
  const fileList = document.querySelector(".file-list");
  if (fileList) {
    fileList.innerHTML = renderProjectTree(state.project.files, file);
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
  document.querySelectorAll("[data-editor-mode]").forEach((button) => {
    const active = button.dataset.editorMode === local.editorMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  const codePanel = document.querySelector(".code-panel");
  const oldSurface = codePanel?.querySelector(".editor-code-mount, .editor-visual-mount, #editorText, .asset-preview");
  if (oldSurface) {
    destroyEditorSurfaces();
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
  if (saveButton) saveButton.disabled = !selection.canEditSelected;
  const mainButton = document.querySelector("#setMainFile");
  if (mainButton) mainButton.disabled = !selection.canSetMain;
  const status = document.querySelector(".editor-subtitle");
  if (status) status.textContent = local.saveStatus;

  bindSourceControls();
}

function updateChatPanel() {
  const list = document.querySelector(".chat-list");
  if (!list || !local.appState) return;
  list.innerHTML = local.appState.chat.length
    ? local.appState.chat.map(chatMessageMarkup).join("")
    : `<div class="chat-empty">No messages yet.</div>`;
  settleEditorUi();
}

function updateUsersPresenceUi() {
  const list = document.querySelector(".users-list");
  if (!list || !local.appState) return;
  list.innerHTML = local.appState.session.users.map((user) => `
    <div class="user-row">
      <div class="avatar">${escapeHtml(user.name[0] || "?")}</div>
      <div>
        <strong>${escapeHtml(user.name)}</strong><br />
        <small>${escapeHtml(user.role)}${activeFileForUser(user.id) ? ` Â· ${escapeHtml(activeFileForUser(user.id))}` : ""}</small>
      </div>
      <span class="online-dot"></span>
    </div>
  `).join("");
}

function updateCompileUi(options = {}) {
  if (!local.appState) return;
  const compile = local.appState.compile;
  const isCompiling = compile.status === "running";
  syncPinnedCompileIssues(compile);
  const button = document.querySelector("#compileButton");
  if (button) {
    button.disabled = isCompiling;
    button.classList.toggle("compiling", isCompiling);
    const label = button.querySelector("span:last-child");
    if (label) label.textContent = isCompiling ? "Compiling..." : "Recompile";
  }

  const previewActions = document.querySelector(".preview-actions");
  if (previewActions) {
    previewActions.innerHTML = previewActionsMarkup(compile);
    bindPdfPreviewControls();
  }

  const logs = document.querySelector(".logs");
  if (logs) logs.innerHTML = compileLogsMarkup(compile.logs || []);
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
    if (!existingOverlay) {
      previewPane.insertAdjacentHTML("afterbegin", `<div class="compile-overlay"><span class="big-spinner"></span><strong>Compiling ${escapeHtml(local.appState.project.mainFile || "project")}</strong></div>`);
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
  if (nextVersion === currentVersion && currentCompile.status !== "running" && nextCompile?.status === "running") {
    return false;
  }
  return true;
}

window.addEventListener("pointermove", (event) => {
  if (local.resizingSidebar) {
    const grid = document.querySelector(".editor-grid");
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const width = Math.max(220, Math.min(460, Math.round(event.clientX - rect.left)));
    local.sidebarWidth = width;
    localStorage.setItem("localleaf.sidebarWidth", String(width));
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
      clampSidebarSections(y, local.imageSectionHeight);
    } else if (local.resizingSidebarSection === "images") {
      clampSidebarSections(local.fileSectionHeight, y - local.fileSectionHeight - metrics.handleHeight);
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
    localStorage.setItem("localleaf.sourcePaneWidth", String(width));
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
    localStorage.setItem("localleaf.rightRailWidth", String(width));
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
    localStorage.setItem("localleaf.logsHeight", String(height));
    shell.style.setProperty("--logs-height", `${height}px`);
  }
});

window.addEventListener("pointerup", () => {
  const wasResizing = local.resizingSidebar || local.resizingSidebarSection || local.resizingSplit || local.resizingRightRail || local.resizingLogs;
  if (!wasResizing) return;
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
}

async function saveCurrentFile() {
  if (!local.selectedFile) return;
  if (!isEditableFile(fileMeta(local.selectedFile))) return;
  prepareEditorForPersistence();
  clearTimeout(local.saveTimer);
  local.editorContent = currentEditorText();
  if (local.saving) {
    local.pendingSave = true;
    return local.savePromise;
  }
  local.saving = true;
  local.pendingSave = false;
  local.saveStatus = "Saving...";

  local.savePromise = (async () => {
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
      local.saveStatus = "Save failed";
      alert(error.message);
    } finally {
      local.saving = false;
      local.savePromise = null;
      const status = document.querySelector(".editor-subtitle");
      if (status) status.textContent = local.saveStatus;
    }

    if (local.pendingSave) {
      await saveCurrentFile();
    }
  })();

  return local.savePromise;
}

async function saveAndCompile() {
  clearTimeout(local.saveTimer);
  await compile();
}

function focusRenameInput() {
  if (!local.renamingTreePath) return;
  const input = document.querySelector(".tree-rename-input");
  if (!input) return;
  input.focus();
  input.select();
}

function startInlineRename(pathValue) {
  const item = treeItem(pathValue);
  if (!item || item.type === "binary") return;
  if (item.type === "directory") {
    local.selectedFolder = item.path;
  } else {
    local.selectedFolder = "";
    local.selectedFile = item.path;
    expandToFile(item.path);
  }
  local.renamingTreePath = item.path;
  local.renamingTreeKind = item.type;
  updateSidebarUi();
}

function cancelInlineRename() {
  if (!local.renamingTreePath) return;
  local.renamingTreePath = "";
  local.renamingTreeKind = "";
  local.renameSaving = false;
  updateSidebarUi();
}

async function commitInlineRename(input) {
  if (!input || local.renameSaving) return;
  const from = input.dataset.renamePath || "";
  if (!from || local.renamingTreePath !== from) return;
  const entry = treeItem(from);
  if (!entry) {
    cancelInlineRename();
    return;
  }
  const extension = input.dataset.renameExtension || "";
  const nextStem = normalizeRenameStem(input.value, extension);
  if (!nextStem) {
    alert("Enter a file or folder name.");
    focusRenameInput();
    return;
  }
  if (/[\\/]/.test(nextStem)) {
    alert("Use a name only. To move files, drag them into a folder.");
    focusRenameInput();
    return;
  }
  const nextName = `${nextStem}${extension}`;
  const nextPath = joinProjectPath(pathDirname(entry.path), nextName);
  if (nextPath === entry.path) {
    local.renamingTreePath = "";
    local.renamingTreeKind = "";
    updateSidebarUi();
    return;
  }
  if (projectPathExists(nextPath, entry.path)) {
    alert("A file or folder with that name already exists here.");
    focusRenameInput();
    return;
  }

  local.renameSaving = true;
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
    local.saveStatus = "Renamed";
    render();
  } catch (error) {
    local.renameSaving = false;
    alert(error.message);
    focusRenameInput();
  }
}

async function createFile(baseDirOverride = undefined) {
  const baseDir = typeof baseDirOverride === "string" ? baseDirOverride : selectedDirectoryPath();
  const filePath = uniqueProjectPath(baseDir, "new file.tex");
  try {
    const result = await api("/api/file/create", {
      method: "POST",
      body: {
        path: filePath,
        content: filePath.endsWith(".tex") ? "% New LocalLeaf file\n" : ""
      }
    });
    await loadState();
    local.selectedFile = result.path;
    local.selectedFolder = "";
    expandToFile(result.path);
    await loadSelectedFile();
    local.renamingTreePath = result.path;
    local.renamingTreeKind = "text";
    local.saveStatus = "Created";
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function createFolder(baseDirOverride = undefined) {
  const baseDir = typeof baseDirOverride === "string" ? baseDirOverride : selectedDirectoryPath();
  const folderPath = uniqueProjectPath(baseDir, "new folder");
  try {
    const result = await api("/api/folder/create", {
      method: "POST",
      body: { path: folderPath }
    });
    await loadState();
    local.selectedFolder = result.path;
    local.collapsedFolders.delete(result.path);
    local.renamingTreePath = result.path;
    local.renamingTreeKind = "directory";
    local.saveStatus = "Folder created";
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function uploadProjectFile(baseDirOverride = undefined) {
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

async function deleteSelectedFile() {
  const entry = selectedTreeEntry();
  if (!entry) return;
  const confirmed = confirm(`Delete ${entry.path}? This removes it from the host project folder.`);
  if (!confirmed) return;
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
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function setMainFile() {
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
  const previewScroll = capturePreviewScroll();
  local.pendingPreviewScroll = previewScroll;
  await saveCurrentFile();
  local.appState.compile.status = "running";
  updateCompileUi();
  const nextCompile = await api("/api/compile", {
    method: "POST",
    body: { requestedBy: local.userName }
  });
  if (shouldApplyCompileUpdate(nextCompile)) {
    local.appState.compile = nextCompile;
  }
  updateCompileUi({ refreshPreview: true, previewScroll });
  local.pendingPreviewScroll = null;
}

async function render() {
  if (!local.appState) {
    await loadState();
  }

  let current = route();
  if (isGuestClient() && !["editor", "ended"].includes(current.view)) {
    const params = new URLSearchParams({ view: "editor", token: local.guestToken });
    if (local.userName && local.userName !== "Host") params.set("name", local.userName);
    history.replaceState({}, "", `/?${params.toString()}`);
    local.view = "editor";
    current = route();
  }
  destroyEditorSurfaces();
  app.className = `app-shell app-shell-${current.view}`;
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
    local.appState = JSON.parse(event.data);
    if (isGuestClient() && local.appState?.session?.status === "ended") {
      handleSessionEnded("The host has ended the session.");
      return;
    }
    syncAiProposalsFromAppState();
    const current = route();
    if (current.view === "editor") {
      local.appState.session.joinRequests
        .filter((request) => request.status === "pending")
        .forEach(showEditorJoinRequest);
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
    local.eventDisconnectTimer = setTimeout(() => {
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
  local.editorStyleMenuOpen = false;
  refreshEditorToolbarPanels();
});

window.addEventListener("pointerdown", (event) => {
  if (!local.editorMoreMenuOpen) return;
  if (event.target.closest?.(".editor-more-menu, #editorMoreButton")) return;
  closeEditorMoreMenuInPlace();
});

window.addEventListener("pointerdown", (event) => {
  let shouldRender = false;
  if (local.aiSessionMenuOpen && !event.target.closest?.(".ai-session-picker")) {
    local.aiSessionMenuOpen = false;
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
      local.editorStyleMenuOpen = false;
      refreshEditorToolbarPanels();
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
    saveAndCompile();
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
