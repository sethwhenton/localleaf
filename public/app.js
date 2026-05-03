const clientId = crypto.randomUUID();
localStorage.setItem("localleaf.editorMode", "code");

const app = document.querySelector("#app");
const local = {
  appState: null,
  selectedFile: null,
  editorContent: "",
  saving: false,
  saveTimer: null,
  joinRequestId: null,
  guestToken: new URLSearchParams(location.search).get("token") || "",
  userName: new URLSearchParams(location.search).get("name") || "Host",
  userId: "",
  view: new URLSearchParams(location.search).get("view") || "",
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
  resizingSidebar: false,
  resizingSplit: false,
  resizingRightRail: false,
  resizingLogs: false,
  sidebarVisible: localStorage.getItem("localleaf.sidebarVisible") !== "0",
  sourcePaneVisible: localStorage.getItem("localleaf.sourcePaneVisible") !== "0",
  previewPaneVisible: localStorage.getItem("localleaf.previewPaneVisible") !== "0",
  rightRailVisible: localStorage.getItem("localleaf.rightRailVisible") !== "0",
  logsVisible: localStorage.getItem("localleaf.logsVisible") !== "0",
  pdfScale: Number(localStorage.getItem("localleaf.pdfScale") || 1),
  searchOpen: false,
  searchQuery: "",
  searchReplace: "",
  searchMatchCase: false,
  searchWholeWord: false,
  searchRegex: false,
  searchStatus: "",
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
  updateDismissedVersion: localStorage.getItem("localleaf.updateDismissedVersion") || "",
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

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.rawBody || (options.body ? JSON.stringify(options.body) : undefined)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

function authUrl(path) {
  if (!local.guestToken) return path;
  const hashIndex = path.indexOf("#");
  const beforeHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
  const separator = beforeHash.includes("?") ? "&" : "?";
  return `${beforeHash}${separator}token=${encodeURIComponent(local.guestToken)}${hash}`;
}

function collabUrl() {
  const params = new URLSearchParams({ client: clientId });
  if (local.guestToken) params.set("token", local.guestToken);
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
    local.collabHeartbeatTimer = setInterval(() => sendCollab("heartbeat"), 15000);
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
      local.collabLostTimer = setTimeout(() => {
        const socketOpen = local.collabSocket?.readyState === WebSocket.OPEN;
        if (route().view === "editor" && !socketOpen) {
          handleSessionEnded(
            "Connection to the host was lost.",
            "The host app may have closed, the PC may be offline, or the public tunnel may have stopped."
          );
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
  clearTimeout(local.eventDisconnectTimer);
  local.eventDisconnectTimer = null;
  closeCollab();
  setView("ended", endedViewParams());
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
  const params = new URLSearchParams();
  params.set("view", view);
  if (extra.token) params.set("token", extra.token);
  if (extra.name) params.set("name", extra.name);
  history.pushState({}, "", `/?${params.toString()}`);
  local.view = view;
  if (extra.token) local.guestToken = extra.token;
  if (extra.name) local.userName = extra.name;
  if (extra.token) connectEvents();
  if (view !== "editor") closeCollab();
  render();
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
    download: uiGlyph("download"),
    settings: uiGlyph("settings"),
    ended: `<span class="plug-glyph" aria-hidden="true"></span>`
  };
  return icons[name] || "*";
}

function uiGlyph(name) {
  return `<span class="ui-glyph ui-glyph-${name}" aria-hidden="true"></span>`;
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
    edit: `<svg ${attrs}><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m13.5 8.5 3 3" /></svg>`
  };
  return icons[name] || "";
}

function hostRailMarkup(active = "") {
  return `
    <nav class="host-nav-rail" aria-label="Project shortcuts">
      <button class="host-rail-button ${active === "home" ? "active" : ""}" id="railHome" title="Home" aria-label="Home">${uiGlyph("home")}</button>
      <button class="host-rail-button ${active === "session" ? "active" : ""}" id="railSession" title="Session management" aria-label="Session management">${uiGlyph("users")}</button>
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
        <div class="window-body ${options.rail ? "window-body-with-rail" : ""}">
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
    <button class="btn update-check-button ${extraClass}" id="${escapeHtml(id)}" data-check-updates data-default-label="${escapeHtml(label)}" type="button" title="Check for updates" aria-label="Check for updates">
      ${icon("download")}
      <span data-update-label>${local.updateChecking ? "Checking..." : escapeHtml(label)}</span>
    </button>
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
            <button class="btn" id="openCurrent">Open Current Project</button>
            <button class="btn btn-outline-orange" id="homeSessionAction">${uiGlyph("users")} ${sessionActionLabel}</button>
          </div>
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

function updateToastMarkup() {
  const info = local.updateInfo || {};
  const targetUrl = info.downloadUrl || info.releaseUrl || "https://github.com/sethwhenton/localleaf/releases/latest";
  return `
    <section class="update-toast" role="status" aria-live="polite" aria-label="LocalLeaf update available">
      <div class="update-toast-icon">${icon("download")}</div>
      <div class="update-toast-copy">
        <strong>Update available</strong>
        <span>LocalLeaf v${escapeHtml(info.latestVersion)} is ready. You are on v${escapeHtml(info.currentVersion || "")}.</span>
      </div>
      <a class="btn btn-primary update-toast-action" href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener">Update</a>
      <button class="icon-button update-toast-close" data-dismiss-update title="Later" aria-label="Dismiss update notice">x</button>
    </section>
  `;
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
}

function updateUpdateCheckButtons() {
  document.querySelectorAll("[data-check-updates]").forEach((button) => {
    button.disabled = local.updateChecking;
    const label = button.querySelector("[data-update-label]");
    if (label) label.textContent = local.updateChecking ? "Checking..." : button.dataset.defaultLabel || "Check for updates";
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
  if (isGuestClient() || local.updateChecking) return "skipped";
  if (!manual && local.updateCheckStarted) return "skipped";
  if (!manual) local.updateCheckStarted = true;
  local.updateChecking = true;
  if (manual) updateUpdateCheckButtons();
  try {
    const info = await api("/api/update/latest");
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
    if (manual) updateUpdateCheckButtons();
  }
}

async function manualCheckForUpdates(event) {
  const result = await checkForUpdates({ manual: true });
  if (result === "current") {
    markUpdateButtonFeedback(event?.currentTarget, "Up to date");
  }
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
  const canDownload = Boolean(local.appState?.project?.files?.length);
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
        ${downloadButton ? `<p class="ended-note">ZIP downloads work while the host app and public link are still reachable.</p>` : ""}
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
  if (!images.length) {
    return "";
  }

  return `
    <div class="image-group">
      <button class="tree-folder-row image-section-toggle" style="--depth:0">
        <span class="folder-caret">${local.imagesCollapsed ? ">" : "v"}</span>
        <span class="folder-name">Images</span>
        <span class="folder-count">${images.length}</span>
      </button>
        ${local.imagesCollapsed ? "" : `<div class="tree-children">
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
            <span class="outline-caret" aria-hidden="true">${hasChildren ? "⌄" : ""}</span>
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

function editorSearchPanelMarkup() {
  if (!local.searchOpen) return "";
  return `
    <section class="editor-search-popover" role="search" aria-label="Search and replace">
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
        <button class="editor-tool-button" id="searchPrevious" title="Previous match" aria-label="Previous match">↑</button>
        <button class="editor-tool-button" id="searchNext" title="Next match" aria-label="Next match">↓</button>
        <button class="btn" id="replaceOne">Replace</button>
        <button class="btn" id="replaceAll">Replace All</button>
        <span class="search-status" id="searchStatus">${escapeHtml(local.searchStatus)}</span>
        <button class="editor-tool-button" id="closeSearchPanel" title="Close search" aria-label="Close search">x</button>
      </div>
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
    `--logs-height:${local.logsHeight}px`
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
        <button class="icon-button chat-tool" id="hideChatRail" title="Hide chat" aria-label="Hide chat">
          <span class="collapse-right-glyph" aria-hidden="true"></span>
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

  return `
    <section class="${editorShellClasses()}" style="${editorInlineStyle()}">
      <header class="editor-topbar editor-topbar-v11">
        <div class="editor-primary-row">
          <div class="toolbar-actions">
            <button class="icon-button editor-back-button" id="backToProject" title="Back" aria-label="Back">
              <span class="chevron-left" aria-hidden="true"></span>
            </button>
            <button class="btn editor-save-button" id="saveButton" ${selection.canEditSelected ? "" : "disabled"}>
              <span class="save-glyph" aria-hidden="true"></span>
              <span>Save</span>
            </button>
            <a class="btn editor-download-button" id="downloadZipButton" href="${authUrl("/api/export/zip")}" download="${escapeHtml(downloadFileName(state.project.name, ".zip"))}" title="Download the full project as a ZIP" aria-label="Download the full project as a ZIP">
              ${icon("download")}
              <span>ZIP</span>
            </a>
          </div>
          <div class="editor-title-block">
            <h1>${escapeHtml(state.project.name)}</h1>
            <span class="editor-subtitle">${escapeHtml(local.saveStatus)}</span>
          </div>
            <div class="toolbar-actions editor-run-actions">
              <span class="main-file-pill">Main: ${escapeHtml(state.project.mainFile || "none")}</span>
              ${updateCheckButtonMarkup("editorCheckUpdates", "Update", "editor-update-button")}
              <button class="compile-button ${isCompiling ? "compiling" : ""}" id="compileButton" ${isCompiling ? "disabled" : ""}>
              <span class="compile-spinner"></span>
              <span>${isCompiling ? "Compiling..." : "Recompile"}</span>
            </button>
            <button class="btn" id="exportButton" style="height:32px">Export</button>
            <button class="btn" id="setMainFile" style="height:32px" ${selection.canSetMain ? "" : "disabled"}>Set Main</button>
            ${layoutToggleMarkup("toggleSourcePane", local.sourcePaneVisible, "editor", "Show or hide editor")}
            ${layoutToggleMarkup("togglePreviewPane", local.previewPaneVisible, "preview", "Show or hide PDF preview")}
            ${layoutToggleMarkup("toggleLogs", local.logsVisible, "bottom", "Show or hide logs")}
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
            ${renderImageGroup(state.project.files, file)}
          </div>
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
        <aside class="right-rail">
          <section class="chat-panel">
            ${chatHeaderMarkup()}
            <div class="chat-list">
              ${state.chat.length ? state.chat.map(chatMessageMarkup).join("") : `<div class="chat-empty">No messages yet.</div>`}
            </div>
            <form class="chat-input" id="chatForm">
              <input id="chatText" placeholder="Send a message" />
              <button class="btn" style="height:30px">Send</button>
            </form>
          </section>
          <section class="users-panel">
            <div class="panel-head">Users (${state.session.users.length})</div>
            <div class="users-list">
              ${state.session.users.map((user) => `
                <div class="user-row">
                  <div class="avatar">${escapeHtml(user.name[0] || "?")}</div>
                  <div>
                    <strong>${escapeHtml(user.name)}</strong><br />
                    <small>${escapeHtml(user.role)}${activeFileForUser(user.id) ? ` · ${escapeHtml(activeFileForUser(user.id))}` : ""}</small>
                  </div>
                  <span class="online-dot"></span>
                </div>
              `).join("")}
            </div>
          </section>
        </aside>
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
  document.querySelector("#railHome")?.addEventListener("click", () => setView("home"));
  document.querySelector("#railSession")?.addEventListener("click", () => setView("session"));
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
  document.querySelector("#openCurrent")?.addEventListener("click", () => setView("project"));
  document.querySelector("#openCurrentCard")?.addEventListener("click", () => setView("project"));
  document.querySelector("#newProject")?.addEventListener("click", createNewProject);
  document.querySelector("#importZip")?.addEventListener("click", importZipProject);
  document.querySelector("#homeSessionAction")?.addEventListener("click", handleHomeSessionAction);
  document.querySelector("#homeCheckUpdates")?.addEventListener("click", manualCheckForUpdates);
}

async function createNewProject() {
  try {
    local.appState = await api("/api/project/new", { method: "POST", body: {} });
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
    local.selectedFile = local.appState.project.mainFile;
    expandToFile(local.selectedFile);
    await loadSelectedFile();
    setView("project");
  } catch (error) {
    alert(error.message);
  }
}

function bindProject() {
  const openEditor = async () => {
    await loadSelectedFile();
    setView("editor");
  };
  document.querySelector("#openEditor")?.addEventListener("click", openEditor);
  document.querySelector("#importZipProject")?.addEventListener("click", importZipProject);
  document.querySelector("#hostOnline")?.addEventListener("click", startSession);
  document.querySelector("#backProject")?.addEventListener("click", () => setView("project"));
}

async function importZipProject() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      local.appState = await api("/api/project/import-zip", {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-file-name": file.name
        },
        rawBody: buffer
      });
      local.selectedFile = local.appState.project.mainFile;
      expandToFile(local.selectedFile);
      await loadSelectedFile();
      local.saveStatus = "Imported";
      setView("project");
    } catch (error) {
      alert(error.message);
    }
  });
  input.click();
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
  if (status) status.textContent = local.searchStatus;
}

function runEditorSearch(direction = "next") {
  if (!local.searchQuery) {
    updateSearchStatus({ found: false, total: 0 });
    return;
  }
  const result = local.codeEditor
    ? local.codeEditor.find(local.searchQuery, { ...activeSearchOptions(), direction })
    : visualFind(local.searchQuery, direction);
  updateSearchStatus(result);
}

function runEditorReplace(all = false) {
  if (!local.searchQuery) return;
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

function closeEditorSearchPanel() {
  if (!local.searchOpen) return false;
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
  handleSessionEnded("Host stopped the session.", "Anyone still connected will be told the session has ended.");
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
  } catch {
    handleSessionEnded(
      "The host is no longer reachable.",
      "Your join request could not be completed because the session ended or the host connection dropped."
    );
    return;
  }
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
  document.querySelector("#editorCheckUpdates")?.addEventListener("click", manualCheckForUpdates);
  document.querySelector("#saveButton")?.addEventListener("click", saveAndCompile);
  document.querySelector("#setMainFile")?.addEventListener("click", setMainFile);
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
  bindSidebarControls();

  bindEditorToolbar();
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
      local.searchOpen = !local.searchOpen;
      local.tablePickerOpen = false;
      local.editorStyleMenuOpen = false;
      refreshEditorToolbarPanels();
      setTimeout(() => document.querySelector("#editorSearchInput")?.focus(), 0);
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
    local.searchStatus = "";
    const status = document.querySelector("#searchStatus");
    if (status) status.textContent = "";
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
  document.querySelector("#searchMatchCase")?.addEventListener("click", () => {
    local.searchMatchCase = !local.searchMatchCase;
    refreshEditorToolbarPanels();
  });
  document.querySelector("#searchRegex")?.addEventListener("click", () => {
    local.searchRegex = !local.searchRegex;
    refreshEditorToolbarPanels();
  });
  document.querySelector("#searchWholeWord")?.addEventListener("click", () => {
    local.searchWholeWord = !local.searchWholeWord;
    refreshEditorToolbarPanels();
  });
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
    localStorage.setItem("localleaf.sourcePaneVisible", local.sourcePaneVisible ? "1" : "0");
  } else if (pane === "preview") {
    local.previewPaneVisible = !local.previewPaneVisible;
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
    fileList.innerHTML = `${renderProjectTree(state.project.files, file)}${renderImageGroup(state.project.files, file)}`;
  }
  const count = document.querySelector(".files-title span");
  if (count) count.textContent = `${textFiles.length} editable`;
  const search = document.querySelector("#fileSearch");
  if (search && search.value !== local.fileFilter) search.value = local.fileFilter;
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
        <small>${escapeHtml(user.role)}${activeFileForUser(user.id) ? ` · ${escapeHtml(activeFileForUser(user.id))}` : ""}</small>
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
  const wasResizing = local.resizingSidebar || local.resizingSplit || local.resizingRightRail || local.resizingLogs;
  if (!wasResizing) return;
  local.resizingSidebar = false;
  local.resizingSplit = false;
  local.resizingRightRail = false;
  local.resizingLogs = false;
  document.body.classList.remove("is-resizing-sidebar");
  document.body.classList.remove("is-resizing-split");
  document.body.classList.remove("is-resizing-right-rail");
  document.body.classList.remove("is-resizing-logs");
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
  input.addEventListener("change", async () => {
    const upload = input.files?.[0];
    if (!upload) return;
    const baseDir = baseDirOverridePath ?? selectedDirectoryPath();
    const defaultName = upload.type.startsWith("image/") && !baseDir ? `images/${upload.name}` : joinProjectPath(baseDir, upload.name);
    const targetPath = prompt("Upload to path:", defaultName);
    if (!targetPath) return;
    try {
      const buffer = await upload.arrayBuffer();
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
      await loadSelectedFile();
      local.saveStatus = "Uploaded";
      render();
    } catch (error) {
      alert(error.message);
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

  const current = route();
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
}

function connectEvents() {
  if (local.events) {
    local.events.close();
  }

  const params = new URLSearchParams({ client: clientId });
  if (local.guestToken) {
    params.set("token", local.guestToken);
  }
  const events = new EventSource(`/events?${params.toString()}`);
  local.events = events;
  events.addEventListener("open", () => {
    clearTimeout(local.eventDisconnectTimer);
    local.eventDisconnectTimer = null;
  });
  events.addEventListener("state", (event) => {
    clearTimeout(local.eventDisconnectTimer);
    local.eventDisconnectTimer = null;
    local.appState = JSON.parse(event.data);
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
    if (isGuestClient() || ["session", "active"].includes(current.view) || (current.view === "editor" && isLiveSession())) {
      handleSessionEnded(payload.reason || "The host stopped the session.");
    }
  });
  events.addEventListener("error", () => {
    clearTimeout(local.eventDisconnectTimer);
    const current = route();
    const isRemoteSessionView = Boolean(local.guestToken) && ["editor", "join", "waiting"].includes(current.view);
    if (!isRemoteSessionView) return;
    local.eventDisconnectTimer = setTimeout(() => {
      if (local.events?.readyState !== EventSource.OPEN) {
        handleSessionEnded(
          "Connection to the host was lost.",
          "The host app may have closed, the PC may be offline, or the public tunnel may have stopped."
        );
      }
    }, 8000);
  });
}

window.addEventListener("popstate", () => {
  local.view = new URLSearchParams(location.search).get("view") || "";
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

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && route().view === "editor") {
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
    local.searchOpen = true;
    local.tablePickerOpen = false;
    refreshEditorToolbarPanels();
    setTimeout(() => document.querySelector("#editorSearchInput")?.focus(), 0);
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
  .then(checkForUpdates)
  .catch((error) => {
    app.innerHTML = `<section class="empty-state"><div class="ended-card"><h1>LocalLeaf failed to start</h1><p class="error">${escapeHtml(error.message)}</p></div></section>`;
  });
