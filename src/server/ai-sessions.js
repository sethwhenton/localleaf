const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_PROJECT_SESSIONS = 30;
const MAX_SESSION_MESSAGES = 120;
const MAX_MESSAGE_TEXT = 12000;

function normalizeProjectRoot(projectRoot) {
  const resolved = path.resolve(String(projectRoot || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function projectKeyForRoot(projectRoot) {
  return crypto.createHash("sha256").update(normalizeProjectRoot(projectRoot), "utf8").digest("hex").slice(0, 32);
}

function defaultSessionRoot() {
  const base = process.env.LOCALLEAF_AI_SESSION_DIR
    || process.env.LOCALLEAF_APPDATA_DIR
    || path.join(os.homedir(), ".localleaf");
  return path.join(base, "AiSessions");
}

function safeId(prefix = "session") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function createWelcomeMessage() {
  return {
    id: "welcome",
    role: "assistant",
    message: "Ask me about LaTeX errors, rewrites, tables, or project structure. File edits will be tracked in Changes.",
    createdAt: Date.now()
  };
}

function sanitizeMessage(message) {
  const clean = message && typeof message === "object" ? message : {};
  const role = ["assistant", "user", "system"].includes(clean.role) ? clean.role : "assistant";
  const safe = {
    id: String(clean.id || safeId("message")).slice(0, 80),
    role,
    message: String(clean.message || "").slice(0, MAX_MESSAGE_TEXT),
    createdAt: Number(clean.createdAt || clean.updatedAt || Date.now())
  };
  if (Array.isArray(clean.approvalCards)) {
    safe.approvalCards = clean.approvalCards.map((id) => String(id || "").slice(0, 80)).filter(Boolean).slice(0, 40);
  }
  if (Array.isArray(clean.fileLinks)) {
    safe.fileLinks = clean.fileLinks.map((file) => String(file || "").slice(0, 260)).filter(Boolean).slice(0, 40);
  }
  if (Array.isArray(clean.proposals)) {
    safe.proposals = clean.proposals.map(sanitizeProposal).filter(Boolean).slice(0, 40);
  }
  if (clean.runId) safe.runId = String(clean.runId).slice(0, 80);
  return safe;
}

function sanitizeProvider(provider) {
  if (!provider || typeof provider !== "object") return null;
  return {
    id: String(provider.id || "").slice(0, 80),
    name: String(provider.name || provider.displayName || "").slice(0, 120),
    type: String(provider.type || "").slice(0, 80)
  };
}

function sanitizeDiffHunks(hunks) {
  if (!Array.isArray(hunks)) return [];
  return hunks.slice(0, 80).map((hunk) => ({
    line: Number(hunk?.line || 0),
    lines: Array.isArray(hunk?.lines)
      ? hunk.lines.slice(0, 1200).map((line) => ({
        type: ["added", "removed", "context"].includes(line?.type) ? line.type : "context",
        text: String(line?.text || "").slice(0, 2000)
      }))
      : []
  }));
}

function sanitizeProposal(proposal) {
  if (!proposal || typeof proposal !== "object" || !proposal.id) return null;
  return {
    id: String(proposal.id).slice(0, 80),
    path: String(proposal.path || "").slice(0, 260),
    baseHash: String(proposal.baseHash || "").slice(0, 128),
    newHash: String(proposal.newHash || "").slice(0, 128),
    summary: String(proposal.summary || "").slice(0, 500),
    status: String(proposal.status || "proposed").slice(0, 40),
    createdAt: Number(proposal.createdAt || Date.now()),
    appliedAt: Number(proposal.appliedAt || 0),
    rejectedAt: Number(proposal.rejectedAt || 0),
    revertedAt: Number(proposal.revertedAt || 0),
    provider: sanitizeProvider(proposal.provider),
    providerName: String(proposal.providerName || "").slice(0, 120),
    modelId: String(proposal.modelId || "").slice(0, 120),
    modelName: String(proposal.modelName || "").slice(0, 120),
    runId: String(proposal.runId || "").slice(0, 80),
    sessionId: String(proposal.sessionId || "").slice(0, 80),
    userRequest: String(proposal.userRequest || "").slice(0, MAX_MESSAGE_TEXT),
    approvalRequired: proposal.approvalRequired !== false,
    diffHunks: sanitizeDiffHunks(proposal.diffHunks),
    focus: proposal.focus && typeof proposal.focus === "object"
      ? {
        line: Number(proposal.focus.line || 0),
        column: Number(proposal.focus.column || 0)
      }
      : null,
    newText: String(proposal.newText || "").slice(0, 500000)
  };
}

function normalizeSession(session = {}, fallback = {}) {
  const now = Date.now();
  const messages = Array.isArray(session.messages) ? session.messages.map(sanitizeMessage) : [];
  return {
    id: String(session.id || safeId()).slice(0, 80),
    projectKey: String(session.projectKey || fallback.projectKey || ""),
    title: String(session.title || fallback.title || "New session").replace(/\s+/g, " ").trim().slice(0, 64) || "New session",
    createdAt: Number(session.createdAt || now),
    updatedAt: Number(session.updatedAt || session.createdAt || now),
    parentSessionId: String(session.parentSessionId || ""),
    providerId: String(session.providerId || ""),
    providerName: String(session.providerName || ""),
    modelId: String(session.modelId || ""),
    modelName: String(session.modelName || ""),
    permissionMode: String(session.permissionMode || "default"),
    status: String(session.status || "active"),
    changeCount: Number(session.changeCount || 0),
    messages: (messages.length ? messages : [createWelcomeMessage()]).slice(-MAX_SESSION_MESSAGES)
  };
}

function sessionPreview(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const last = [...messages].reverse().find((message) => message && message.id !== "welcome" && message.message);
  return last ? String(last.message || "").replace(/\s+/g, " ").trim().slice(0, 120) : "Ready to help with this project.";
}

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    parentSessionId: session.parentSessionId || "",
    providerId: session.providerId || "",
    providerName: session.providerName || "",
    modelId: session.modelId || "",
    modelName: session.modelName || "",
    permissionMode: session.permissionMode || "default",
    status: session.status || "active",
    changeCount: session.changeCount || 0,
    messageCount: (session.messages || []).filter((message) => message.id !== "welcome").length,
    lastPreview: sessionPreview(session),
    messages: session.messages || [createWelcomeMessage()]
  };
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function createAiSessionStore(options = {}) {
  const memoryOnly = options.memory === true;
  const root = options.root || defaultSessionRoot();
  const filePath = memoryOnly ? "" : path.join(root, "sessions.json");
  let cache = memoryOnly ? { projects: {} } : null;

  function readStore() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      cache = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      cache = {};
    }
    if (!cache.projects || typeof cache.projects !== "object") cache.projects = {};
    return cache;
  }

  function writeStore() {
    if (memoryOnly) return;
    atomicWriteJson(filePath, readStore());
  }

  function projectMeta(project) {
    const key = projectKeyForRoot(project?.root || "");
    return {
      key,
      name: String(project?.name || path.basename(project?.root || "") || "LocalLeaf Project"),
      root: path.resolve(String(project?.root || "")),
      mainFile: String(project?.mainFile || "")
    };
  }

  function ensureProject(project) {
    const store = readStore();
    const meta = projectMeta(project);
    if (!store.projects[meta.key]) {
      const session = normalizeSession({
        title: "First session",
        projectKey: meta.key,
        messages: [createWelcomeMessage()]
      });
      store.projects[meta.key] = {
        ...meta,
        currentSessionId: session.id,
        sessions: [session],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      writeStore();
    } else {
      Object.assign(store.projects[meta.key], meta, { updatedAt: Date.now() });
    }
    return store.projects[meta.key];
  }

  function sortAndTrim(projectRecord) {
    projectRecord.sessions = (projectRecord.sessions || [])
      .map((session) => normalizeSession(session, { projectKey: projectRecord.key }))
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .slice(0, MAX_PROJECT_SESSIONS);
    if (!projectRecord.sessions.some((session) => session.id === projectRecord.currentSessionId)) {
      projectRecord.currentSessionId = projectRecord.sessions[0]?.id || "";
    }
  }

  function publicState(project) {
    const record = ensureProject(project);
    sortAndTrim(record);
    return {
      projectKey: record.key,
      projectName: record.name,
      currentSessionId: record.currentSessionId,
      sessions: record.sessions.map(publicSession)
    };
  }

  function getSession(project, sessionId) {
    const record = ensureProject(project);
    sortAndTrim(record);
    return record.sessions.find((session) => session.id === sessionId) || null;
  }

  function updateSession(project, sessionId, updates = {}) {
    const record = ensureProject(project);
    const session = getSession(project, sessionId);
    if (!session) throw new Error("AI session was not found.");
    const next = normalizeSession({
      ...session,
      ...updates,
      id: session.id,
      projectKey: record.key,
      updatedAt: updates.updatedAt || Date.now()
    }, { projectKey: record.key });
    record.sessions = [next, ...record.sessions.filter((item) => item.id !== session.id)];
    record.currentSessionId = updates.activate === false ? record.currentSessionId : next.id;
    sortAndTrim(record);
    writeStore();
    return publicState(project);
  }

  function createSession(project, input = {}) {
    const record = ensureProject(project);
    const session = normalizeSession({
      ...input,
      id: safeId(),
      projectKey: record.key,
      title: input.title || "New session",
      messages: input.messages || [createWelcomeMessage()],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, { projectKey: record.key });
    record.sessions = [session, ...(record.sessions || [])];
    record.currentSessionId = session.id;
    sortAndTrim(record);
    writeStore();
    return publicState(project);
  }

  function activateSession(project, sessionId) {
    const record = ensureProject(project);
    const session = getSession(project, sessionId);
    if (!session) throw new Error("AI session was not found.");
    record.currentSessionId = session.id;
    record.updatedAt = Date.now();
    writeStore();
    return publicState(project);
  }

  function deleteSession(project, sessionId) {
    const record = ensureProject(project);
    record.sessions = (record.sessions || []).filter((session) => session.id !== sessionId);
    if (!record.sessions.length) {
      const session = normalizeSession({ title: "New session", projectKey: record.key, messages: [createWelcomeMessage()] });
      record.sessions = [session];
      record.currentSessionId = session.id;
    } else if (record.currentSessionId === sessionId) {
      record.currentSessionId = record.sessions[0].id;
    }
    sortAndTrim(record);
    writeStore();
    return publicState(project);
  }

  function forkSession(project, sessionId) {
    const record = ensureProject(project);
    const source = getSession(project, sessionId);
    if (!source) throw new Error("AI session was not found.");
    const session = normalizeSession({
      ...source,
      id: safeId(),
      parentSessionId: source.id,
      title: `Fork: ${source.title || "Session"}`.slice(0, 64),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: (source.messages || []).map((message) => ({ ...message }))
    }, { projectKey: record.key });
    record.sessions = [session, ...(record.sessions || [])];
    record.currentSessionId = session.id;
    sortAndTrim(record);
    writeStore();
    return publicState(project);
  }

  function importLegacySessions(project, sessions = [], currentSessionId = "") {
    const record = ensureProject(project);
    const existingIds = new Set((record.sessions || []).map((session) => session.id));
    const imported = sessions
      .filter((session) => session && session.id && !existingIds.has(session.id))
      .map((session) => normalizeSession({ ...session, projectKey: record.key }, { projectKey: record.key }));
    if (imported.length) {
      record.sessions = [...imported, ...(record.sessions || [])];
      if (currentSessionId && imported.some((session) => session.id === currentSessionId)) {
        record.currentSessionId = currentSessionId;
      }
      sortAndTrim(record);
      writeStore();
    }
    return publicState(project);
  }

  return {
    root,
    filePath,
    projectKeyForRoot,
    publicState,
    createSession,
    activateSession,
    updateSession,
    deleteSession,
    forkSession,
    importLegacySessions,
    getSession
  };
}

module.exports = {
  createAiSessionStore,
  createMemoryAiSessionStore: () => createAiSessionStore({ memory: true }),
  createWelcomeMessage,
  projectKeyForRoot
};
