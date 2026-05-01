const clientId = crypto.randomUUID();

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
  editorMode: localStorage.getItem("localleaf.editorMode") === "visual" ? "visual" : "code",
  editorSuggestions: null,
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

function connectCollab() {
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
    handleSessionEnded(payload.reason || "The host stopped the session.");
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
    files: `<svg ${attrs}><path d="M4 6.5h6l2 2h8v9.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5Z" /><path d="M4 10h16" /></svg>`,
    chat: `<svg ${attrs}><path d="M5 6h14v10H8l-3 3V6Z" /><path d="M9 10h6" /><path d="M9 13h4" /></svg>`
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

function homeView() {
  const state = local.appState;
  return windowShell(`
    <div class="home-app-page">
      <header class="home-app-head">
        ${brand()}
        <button class="btn btn-outline-orange" id="hostSession">${uiGlyph("users")} Host Online Session</button>
      </header>

      <div class="home-app-grid">
        <section class="home-actions-panel">
          <div class="section-title">Start</div>
          <div class="home-action-grid">
            <button class="btn" id="newProject">${icon("plus")} New Project</button>
            <button class="btn" id="openProject">${uiGlyph("folder")} Open Project</button>
            <button class="btn" id="importZip">${uiGlyph("folder")} Import ZIP Project</button>
            <button class="btn btn-primary" id="openCurrent">Open Current Project</button>
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
          <button class="btn btn-ghost open-another-button" id="openAnother">${uiGlyph("folder")} Open Another Project...</button>
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
        <button class="icon-button project-back-icon" id="backProject" title="Back to project" aria-label="Back to project">
          <span class="chevron-left" aria-hidden="true"></span>
        </button>
        <div>
          <span class="pill ${isLive ? "" : "pill-warn"}">${isLive ? "Session Live" : "Session Idle"}</span>
          <h2>Session Management</h2>
          <p>${isLive ? `${escapeHtml(project.name)} is online. Copy the invite link or open the editor.` : `Start hosting when you are ready to invite collaborators into ${escapeHtml(project.name)}.`}</p>
        </div>
        ${isLive
          ? `<button class="btn btn-primary" id="openEditorFromSession" ${project.mainFile ? "" : "disabled"}>Open Editor</button>`
          : `<button class="btn btn-primary" data-start-session>${uiGlyph("users")} Host Online Session</button>`}
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
  const downloadButton = canDownload
    ? `<a class="btn ended-download-button" href="${authUrl("/api/export/zip")}" download>${icon("download")}<span>Download ZIP</span></a>`
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
  const matches = [...String(content || "").matchAll(/\\section\*?\{([^}]*)\}/g)];
  if (!matches.length) {
    return ["No sections found"];
  }
  return matches.map((match) => match[1].trim()).filter(Boolean);
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
    const children = sortTreeNodes(node.children.values());
    return `
      <div class="tree-folder" data-depth="${depth}">
        <button class="tree-folder-row folder-toggle" data-folder="${escapeHtml(node.path)}" style="--depth:${depth}">
          <span class="folder-caret">${isCollapsed ? ">" : "v"}</span>
          <span class="folder-name">${escapeHtml(node.name)}</span>
          <span class="folder-count">${children.length}</span>
        </button>
        ${isCollapsed ? "" : `<div class="tree-children">${children.map((child) => renderTreeNode(child, selectedFile, depth + 1)).join("")}</div>`}
      </div>
    `;
  }

  const item = node.item;
  const selectable = isEditableFile(item) || isImageAsset(item);
  const disabled = selectable ? "" : "disabled";
  return `
    <button class="file-button tree-file ${item.path === selectedFile ? "active" : ""} ${item.type === "image" ? "image-file" : ""}"
      data-file="${escapeHtml(item.path)}"
      data-kind="${escapeHtml(item.type)}"
      style="--depth:${depth}"
      ${disabled}>
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
          <button class="file-button tree-file image-file ${item.path === selectedFile ? "active" : ""}"
            data-file="${escapeHtml(item.path)}"
            data-kind="image"
            style="--depth:1">
            <span>[img]</span><span class="file-label">${escapeHtml(item.path)}</span>
          </button>
        `).join("")}
      </div>`}
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

function visualInlineHtml(text) {
  let html = escapeHtml(latexUnescapeText(text));
  html = html.replace(/\\textbf\{([^{}]*)\}/g, "<strong data-latex-inline=\"textbf\">$1</strong>");
  html = html.replace(/\\(?:textit|emph)\{([^{}]*)\}/g, "<em data-latex-inline=\"textit\">$1</em>");
  html = html.replace(/\\texttt\{([^{}]*)\}/g, "<code data-latex-inline=\"texttt\">$1</code>");
  html = html.replace(/\\(?:cite|citep|citet|parencite|textcite)\{([^{}]*)\}/g, "<span class=\"visual-chip\" data-latex-raw=\"\\\\cite{$1}\">cite:$1</span>");
  html = html.replace(/\\(?:ref|eqref|autoref|pageref)\{([^{}]*)\}/g, "<span class=\"visual-chip\" data-latex-raw=\"\\\\ref{$1}\">ref:$1</span>");
  return html;
}

function inlineNodeToLatex(node) {
  if (node.nodeType === Node.TEXT_NODE) return latexEscapeText(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const raw = node.getAttribute("data-latex-raw");
  if (raw) return raw;
  const children = [...node.childNodes].map(inlineNodeToLatex).join("");
  const inline = node.getAttribute("data-latex-inline");
  if (inline) return `\\${inline}{${children}}`;
  if (node.tagName === "STRONG" || node.tagName === "B") return `\\textbf{${children}}`;
  if (node.tagName === "EM" || node.tagName === "I") return `\\textit{${children}}`;
  if (node.tagName === "CODE") return `\\texttt{${children}}`;
  if (node.tagName === "BR") return "\n";
  return children;
}

function blockContentToLatex(element) {
  return [...element.childNodes].map(inlineNodeToLatex).join("").replace(/\n{3,}/g, "\n\n").trim();
}

function parseVisualLatex(content) {
  const blocks = [];
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  let paragraph = [];
  let raw = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join("\n").trim() });
    paragraph = [];
  };

  const flushRaw = () => {
    if (!raw.length) return;
    blocks.push({ type: "raw", text: raw.join("\n") });
    raw = [];
  };

  const isPlainTextLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^\\(?:textbf|textit|emph|texttt|cite|citep|citet|parencite|textcite|ref|eqref|autoref|pageref)\{/.test(trimmed)) return true;
    return !trimmed.startsWith("\\") && !trimmed.startsWith("%");
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^\\(chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}\s*$/);
    if (heading) {
      flushParagraph();
      flushRaw();
      blocks.push({ type: "heading", level: heading[1], text: latexUnescapeText(heading[2]) });
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushRaw();
      blocks.push({ type: "blank" });
      continue;
    }

    if (isPlainTextLine(line)) {
      flushRaw();
      paragraph.push(line.trim());
      continue;
    }

    flushParagraph();
    raw.push(line);
  }

  flushParagraph();
  flushRaw();
  return blocks.length ? blocks : [{ type: "paragraph", text: "" }];
}

function visualBlockMarkup(block, index) {
  if (block.type === "heading") {
    return `
      <section class="visual-block visual-heading-block" data-visual-type="heading" data-heading-level="${escapeHtml(block.level)}">
        <label>${escapeHtml(block.level)}</label>
        <div class="visual-heading-input" contenteditable="true" spellcheck="true">${escapeHtml(block.text)}</div>
      </section>
    `;
  }
  if (block.type === "paragraph") {
    return `
      <section class="visual-block visual-paragraph-block" data-visual-type="paragraph">
        <div class="visual-paragraph-input" contenteditable="true" spellcheck="true">${visualInlineHtml(block.text)}</div>
      </section>
    `;
  }
  if (block.type === "blank") {
    return `<div class="visual-block visual-blank-block" data-visual-type="blank" aria-label="Blank line"></div>`;
  }
  return `
    <section class="visual-block visual-raw-block" data-visual-type="raw">
      <div class="visual-raw-head"><span>LaTeX block</span><small>advanced source</small></div>
      <textarea class="visual-raw-input" spellcheck="false" aria-label="Raw LaTeX block ${index + 1}">${escapeHtml(block.text)}</textarea>
    </section>
  `;
}

function visualLatexMarkup(content) {
  return parseVisualLatex(content).map(visualBlockMarkup).join("");
}

function visualDomToLatex(host) {
  const blocks = [];
  host.querySelectorAll(".visual-block").forEach((block) => {
    const type = block.dataset.visualType;
    if (type === "heading") {
      const level = block.dataset.headingLevel || "section";
      const text = block.querySelector(".visual-heading-input")?.textContent || "";
      blocks.push(`\\${level}{${latexEscapeText(text.trim())}}`);
    } else if (type === "paragraph") {
      const input = block.querySelector(".visual-paragraph-input");
      blocks.push(blockContentToLatex(input || block));
    } else if (type === "raw") {
      blocks.push(block.querySelector(".visual-raw-input")?.value || "");
    } else if (type === "blank") {
      blocks.push("");
    }
  });
  return blocks.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

function editorBreadcrumbMarkup(file, selection) {
  const parts = String(file || "").split("/").filter(Boolean);
  const section = selection.canEditSelected
    ? selection.outline.find((item) => item && item !== "No sections found")
    : "";
  const crumbs = parts.map((part, index) => {
    const isFile = index === parts.length - 1;
    return `<span class="${isFile ? "active" : ""}">${escapeHtml(part)}${isFile && file === local.appState.project.mainFile ? " (main)" : ""}</span>`;
  });
  if (section) crumbs.push(`<span>${escapeHtml(section)}</span>`);
  return crumbs.length ? crumbs.join(`<i aria-hidden="true"></i>`) : `<span>No file selected</span>`;
}

function editorSurfaceMarkup(file, selectedMeta) {
  if (isEditableFile(selectedMeta)) {
    if (local.editorMode === "visual") {
      return `
        <div class="editor-visual-mount" id="editorText" data-file="${escapeHtml(file)}">
          <div class="visual-editor-intro">
            <strong>Visual Editor</strong>
            <span>Simple text and headings are editable here. Complex LaTeX stays in source blocks.</span>
          </div>
          <div class="visual-editor-document" id="visualEditorDocument">
            ${visualLatexMarkup(local.editorContent)}
          </div>
        </div>
      `;
    }
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

function editorFormatToolbarMarkup() {
  const tool = (command, label, title, extra = "") =>
    `<button class="editor-tool-button ${extra}" data-editor-command="${command}" title="${title}" aria-label="${title}">${label}</button>`;
  return `
    <div class="editor-format-row" role="toolbar" aria-label="LaTeX editor tools">
      <button class="editor-files-tab-button" id="showFilesPanelInline" title="Show files" aria-label="Show files">
        ${editorToolIcon("files")}
        <span>Files</span>
      </button>
      ${tool("undo", editorToolIcon("undo"), "Undo")}
      ${tool("redo", editorToolIcon("redo"), "Redo")}
      <select class="editor-style-select" id="editorStyleSelect" title="Insert section command" aria-label="Insert section command">
        <option value="normal">Normal text</option>
        <option value="chapter">Chapter</option>
        <option value="section">Section</option>
        <option value="subsection">Subsection</option>
        <option value="subsubsection">Subsubsection</option>
        <option value="paragraph">Paragraph</option>
      </select>
      ${tool("bold", "<strong>B</strong>", "Bold")}
      ${tool("italic", "<em>I</em>", "Italic")}
      ${tool("monospace", editorToolIcon("monospace"), "Monospace")}
      ${tool("symbol", editorToolIcon("symbol"), "Insert symbol")}
      ${tool("link", editorToolIcon("link"), "Insert link")}
      ${tool("ref", editorToolIcon("ref"), "Insert reference")}
      ${tool("cite", editorToolIcon("cite"), "Insert citation")}
      ${tool("comment", editorToolIcon("comment"), "Toggle comment")}
      ${tool("figure", editorToolIcon("figure"), "Insert figure")}
      ${tool("table", editorToolIcon("table"), "Insert table")}
      ${tool("bulletList", editorToolIcon("bulletList"), "Insert bullet list")}
      ${tool("numberedList", editorToolIcon("numberedList"), "Insert numbered list")}
      ${tool("outdent", editorToolIcon("outdent"), "Outdent")}
      ${tool("indent", editorToolIcon("indent"), "Indent")}
      ${tool("complete", editorToolIcon("complete"), "Open command autocomplete", "accent-tool")}
      <div class="editor-mode-toggle" role="tablist" aria-label="Editor mode">
        <button class="editor-mode-pill ${local.editorMode === "code" ? "active" : ""}" data-editor-mode="code" role="tab" aria-selected="${local.editorMode === "code"}">Code Editor</button>
        <button class="editor-mode-pill ${local.editorMode === "visual" ? "active" : ""}" data-editor-mode="visual" role="tab" aria-selected="${local.editorMode === "visual"}">Visual Editor</button>
      </div>
      <span class="format-row-spacer"></span>
      <button class="editor-chat-tab-button" id="showChatRailInline" title="Show chat" aria-label="Show chat">
        ${editorToolIcon("chat")}
        <span>Chat</span>
      </button>
    </div>
  `;
}

function compiledPreviewMarkup() {
  const state = local.appState;
  if (state.compile.mode === "pdf") {
    return `<iframe title="PDF preview" src="${authUrl(`/api/pdf?v=${state.compile.version}`)}" class="pdf-preview-frame"></iframe>`;
  }
  return state.compile.previewHtml || `<article class="paper-preview"><header class="paper-title"><h1>Compile to Preview</h1><p>Click Recompile to render the document preview.</p></header></article>`;
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
          <a class="export-card" href="${zipUrl}" download>
            <strong>Source ZIP</strong>
            <span>All project files, folders, images, bibliography, and LaTeX sources.</span>
          </a>
          <a class="export-card" href="${pdfUrl}" download>
            <strong>Compiled PDF</strong>
            <span>The latest successful PDF compile. Recompile first if it is out of date.</span>
          </a>
        </div>
      </section>
    </div>
  `);

  const modal = document.querySelector(".modal-backdrop");
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) hideExportModal();
  });
  modal?.querySelector("[data-close-export]")?.addEventListener("click", hideExportModal);
  modal?.querySelectorAll(".export-card").forEach((link) => {
    link.addEventListener("click", () => {
      setTimeout(hideExportModal, 250);
    });
  });
}

async function selectProjectFile(filePath) {
  const item = fileMeta(filePath);
  if (!item || (!isEditableFile(item) && !isImageAsset(item))) return;
  await saveCurrentFile();
  local.selectedFile = filePath;
  expandToFile(filePath);
  local.saveStatus = "Saved";
  if (isEditableFile(item)) {
    await loadSelectedFile();
  } else {
    local.editorContent = "";
  }
  updateEditorSourceUi();
  if (isEditableFile(item)) {
    sendCollab("open_file", { filePath });
  }
}

function editorView() {
  const state = local.appState;
  const file = local.selectedFile || state.project.mainFile || state.project.files.find((item) => item.type === "text" || item.type === "image")?.path || "";
  const logs = (state.compile.logs || []).slice(-20).join("\n");
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
            <a class="btn editor-download-button" id="downloadZipButton" href="${authUrl("/api/export/zip")}" download title="Download the full project as a ZIP" aria-label="Download the full project as a ZIP">
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
              <button class="mini-button" id="newFile" title="New file">+</button>
              <button class="mini-button" id="newFolder" title="New folder">Folder</button>
              <button class="mini-button" id="uploadFile" title="Upload file">Upload</button>
            </div>
            <div class="file-actions file-actions-secondary">
              <button class="mini-button" id="renameFile" title="Rename selected file">Rename</button>
              <button class="mini-button danger-mini" id="deleteFile" title="Delete selected file">Delete</button>
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
            <ol>
              ${selection.canEditSelected ? selection.outline.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : `<li>Open a text file to view outline.</li>`}
            </ol>
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
              ${state.compile.mode === "pdf" ? `<a class="pdf-link" href="${authUrl(`/api/pdf?v=${state.compile.version}`)}" target="_blank" rel="noopener">PDF</a>` : ""}
              <span>${escapeHtml(state.compile.status)}</span>
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
        <div class="log-tabs"><button class="active">Logs</button></div>
        <pre class="logs">${escapeHtml(logs)}</pre>
      </footer>
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
  local.sessionEndedReason = "The host has ended the session.";
  local.sessionEndedDetail = "Ask the host to start it again.";
  history.pushState({}, "", "/");
  local.view = "home";
  render();
}

function bindHome() {
  document.querySelector("#openCurrent")?.addEventListener("click", () => setView("project"));
  document.querySelector("#openCurrentCard")?.addEventListener("click", () => setView("project"));
  document.querySelector("#openAnother")?.addEventListener("click", openProjectPrompt);
  document.querySelector("#openProject")?.addEventListener("click", openProjectPrompt);
  document.querySelector("#newProject")?.addEventListener("click", () => setView("project"));
  document.querySelector("#importZip")?.addEventListener("click", importZipProject);
  document.querySelector("#hostSession")?.addEventListener("click", startSession);
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
  } catch {
    local.editorSuggestions = local.editorSuggestions || {};
  }
}

function currentEditorText() {
  if (local.codeEditor) return local.codeEditor.getText();
  if (local.visualEditor) return local.visualEditor.getText();
  return local.editorContent;
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
    onSave: saveCurrentFile,
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
  const handleInput = () => markEditorChanged(getText());
  const handleFocusIn = () => {
    local.editingNow = true;
  };
  const handleFocusOut = () => {
    local.editingNow = false;
  };
  documentNode?.addEventListener("input", handleInput);
  documentNode?.addEventListener("focusin", handleFocusIn);
  documentNode?.addEventListener("focusout", handleFocusOut);
  host.querySelectorAll(".visual-raw-input").forEach((input) => {
    input.addEventListener("input", handleInput);
  });

  local.visualEditor = {
    host,
    destroy() {
      documentNode?.removeEventListener("input", handleInput);
      documentNode?.removeEventListener("focusin", handleFocusIn);
      documentNode?.removeEventListener("focusout", handleFocusOut);
      local.visualEditor = null;
    },
    getText,
    applyRemoteText(text) {
      if (!documentNode) return;
      documentNode.innerHTML = visualLatexMarkup(text);
      host.querySelectorAll(".visual-raw-input").forEach((input) => {
        input.addEventListener("input", handleInput);
      });
    },
    exec(command, value) {
      return execVisualCommand(command, value);
    }
  };
}

function execVisualCommand(command, value) {
  const active = document.activeElement;
  const insertText = (text) => {
    if (active && (active.isContentEditable || active.tagName === "TEXTAREA")) {
      document.execCommand("insertText", false, text);
      markEditorChanged(currentEditorText());
      return true;
    }
    return false;
  };

  if (command === "bold") document.execCommand("bold");
  else if (command === "italic") document.execCommand("italic");
  else if (command === "monospace") document.execCommand("insertHTML", false, "<code data-latex-inline=\"texttt\">text</code>");
  else if (command === "style" && value && value !== "normal") insertText(`\\${value}{Title}`);
  else if (command === "link") insertText("\\href{}{text}");
  else if (command === "ref") insertText("\\ref{}");
  else if (command === "cite") insertText("\\cite{}");
  else if (command === "figure") insertText("\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}");
  else if (command === "table") insertText("\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{ll}\n    \\hline\n    Column & Value \\\\\n    \\hline\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}");
  else if (command === "bulletList") insertText("\\begin{itemize}\n  \\item \n\\end{itemize}");
  else if (command === "numberedList") insertText("\\begin{enumerate}\n  \\item \n\\end{enumerate}");
  else if (command === "symbol") insertText("\\alpha");
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
  if (local.editorMode === "visual") mountVisualEditor();
  else mountCodeEditor();
}

function setEditorMode(mode) {
  if (!["code", "visual"].includes(mode) || local.editorMode === mode) return;
  local.editorContent = currentEditorText();
  local.editorMode = mode;
  localStorage.setItem("localleaf.editorMode", mode);
  updateEditorSourceUi();
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
  connectCollab();
  document.querySelector("#backToProject")?.addEventListener("click", () => {
    if (local.appState.session.status === "live") setView("session");
    else setView("project");
  });
  document.querySelector("#compileButton")?.addEventListener("click", compile);
  document.querySelector("#exportButton")?.addEventListener("click", showExportModal);
  document.querySelector("#saveButton")?.addEventListener("click", saveCurrentFile);
  document.querySelector("#newFile")?.addEventListener("click", createFile);
  document.querySelector("#newFolder")?.addEventListener("click", createFolder);
  document.querySelector("#uploadFile")?.addEventListener("click", uploadProjectFile);
  document.querySelector("#renameFile")?.addEventListener("click", renameSelectedFile);
  document.querySelector("#deleteFile")?.addEventListener("click", deleteSelectedFile);
  document.querySelector("#setMainFile")?.addEventListener("click", setMainFile);
  document.querySelector("#toggleSourcePane")?.addEventListener("click", () => toggleLayoutPane("source"));
  document.querySelector("#togglePreviewPane")?.addEventListener("click", () => toggleLayoutPane("preview"));
  document.querySelector("#toggleLogs")?.addEventListener("click", () => toggleLayoutPane("logs"));
  document.querySelector("#hideFilesPanel")?.addEventListener("click", () => setSidebarVisible(false));
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
  document.querySelectorAll(".file-button").forEach((button) => {
    button.addEventListener("click", async () => {
      await selectProjectFile(button.dataset.file);
    });
  });
  document.querySelectorAll(".folder-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const folder = button.dataset.folder;
      if (local.collapsedFolders.has(folder)) local.collapsedFolders.delete(folder);
      else local.collapsedFolders.add(folder);
      updateSidebarUi();
    });
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

  bindEditorToolbar();
  mountActiveEditor();

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
  document.querySelector("#newFile")?.addEventListener("click", createFile);
  document.querySelector("#newFolder")?.addEventListener("click", createFolder);
  document.querySelector("#uploadFile")?.addEventListener("click", uploadProjectFile);
  document.querySelector("#renameFile")?.addEventListener("click", renameSelectedFile);
  document.querySelector("#deleteFile")?.addEventListener("click", deleteSelectedFile);
  document.querySelector("#hideFilesPanel")?.addEventListener("click", () => setSidebarVisible(false));
  document.querySelectorAll(".file-button").forEach((button) => {
    button.addEventListener("click", async () => {
      await selectProjectFile(button.dataset.file);
    });
  });
  document.querySelectorAll(".folder-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const folder = button.dataset.folder;
      if (local.collapsedFolders.has(folder)) local.collapsedFolders.delete(folder);
      else local.collapsedFolders.add(folder);
      updateSidebarUi();
    });
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
}

function bindEditorToolbar() {
  document.querySelectorAll("[data-editor-mode]").forEach((button) => {
    button.addEventListener("click", () => setEditorMode(button.dataset.editorMode));
  });
  document.querySelectorAll("[data-editor-command]").forEach((button) => {
    button.addEventListener("click", () => {
      if (local.codeEditor) local.codeEditor.exec(button.dataset.editorCommand);
      else local.visualEditor?.exec(button.dataset.editorCommand);
    });
  });
  const styleSelect = document.querySelector("#editorStyleSelect");
  styleSelect?.addEventListener("change", () => {
    if (local.codeEditor) local.codeEditor.exec("style", styleSelect.value);
    else local.visualEditor?.exec("style", styleSelect.value);
    styleSelect.value = "normal";
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
    const list = outline.querySelector("ol");
    if (list) {
      list.innerHTML = selection.canEditSelected
        ? selection.outline.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
        : `<li>Open a text file to view outline.</li>`;
    }
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
  const button = document.querySelector("#compileButton");
  if (button) {
    button.disabled = isCompiling;
    button.classList.toggle("compiling", isCompiling);
    const label = button.querySelector("span:last-child");
    if (label) label.textContent = isCompiling ? "Compiling..." : "Recompile";
  }

  const previewActions = document.querySelector(".preview-actions");
  if (previewActions) {
    previewActions.innerHTML = `${compile.mode === "pdf" ? `<a class="pdf-link" href="${authUrl(`/api/pdf?v=${compile.version}`)}" target="_blank" rel="noopener">PDF</a>` : ""}<span>${escapeHtml(compile.status)}</span>`;
  }

  const logs = document.querySelector(".logs");
  if (logs) logs.textContent = (compile.logs || []).slice(-20).join("\n");

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
    previewPane.innerHTML = compiledPreviewMarkup();
  }
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
}

async function saveCurrentFile() {
  if (!local.selectedFile) return;
  if (!isEditableFile(fileMeta(local.selectedFile))) return;
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

async function createFile() {
  const filePath = prompt("New file path:", "chapter.tex");
  if (!filePath) return;
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
    expandToFile(result.path);
    await loadSelectedFile();
    local.saveStatus = "Created";
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function createFolder() {
  const folderPath = prompt("New folder path:", "chapters");
  if (!folderPath) return;
  try {
    const result = await api("/api/folder/create", {
      method: "POST",
      body: { path: folderPath }
    });
    await loadState();
    local.collapsedFolders.delete(result.path);
    local.saveStatus = "Folder created";
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function uploadProjectFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.addEventListener("change", async () => {
    const upload = input.files?.[0];
    if (!upload) return;
    const targetPath = prompt("Upload to path:", upload.type.startsWith("image/") ? `images/${upload.name}` : upload.name);
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
  if (!local.selectedFile) return;
  const nextPath = prompt("Rename selected file:", local.selectedFile);
  if (!nextPath || nextPath === local.selectedFile) return;
  try {
    const result = await api("/api/file/rename", {
      method: "POST",
      body: {
        from: local.selectedFile,
        to: nextPath
      }
    });
    await loadState();
    local.selectedFile = result.path;
    expandToFile(result.path);
    await loadSelectedFile();
    local.saveStatus = "Renamed";
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteSelectedFile() {
  if (!local.selectedFile) return;
  const confirmed = confirm(`Delete ${local.selectedFile}? This removes it from the host project folder.`);
  if (!confirmed) return;
  try {
    await api("/api/file/delete", {
      method: "POST",
      body: { path: local.selectedFile }
    });
    await loadState();
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
  await saveCurrentFile();
  local.appState.compile.status = "running";
  updateCompileUi();
  local.appState.compile = await api("/api/compile", {
    method: "POST",
    body: { requestedBy: local.userName }
  });
  updateCompileUi({ refreshPreview: true });
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
    local.appState.compile = JSON.parse(event.data);
    if (route().view === "editor") {
      updateCompileUi({ refreshPreview: local.appState.compile.status !== "running" });
    }
  });
  events.addEventListener("chat", () => {
    loadState().then(() => {
      if (route().view === "editor") updateChatPanel();
    });
  });
  events.addEventListener("session-ended", (event) => {
    const payload = event.data ? JSON.parse(event.data) : {};
    handleSessionEnded(payload.reason || "The host stopped the session.");
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

loadState()
  .then(() => {
    connectEvents();
    render();
  })
  .catch((error) => {
    app.innerHTML = `<section class="empty-state"><div class="ended-card"><h1>LocalLeaf failed to start</h1><p class="error">${escapeHtml(error.message)}</p></div></section>`;
  });
