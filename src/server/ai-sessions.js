const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_PROJECT_SESSIONS = 30;
const MAX_SESSION_MESSAGES = 120;
const MAX_SESSION_RUNS = 120;
const MAX_MESSAGE_TEXT = 12000;
const SESSION_SCHEMA_VERSION = 2;
const SAFE_TRUNCATION_REASONS = new Set([
  "annotation_limit", "component_limit", "context_window", "current_file_limit", "file_limit",
  "history_limit", "message_limit", "project_context_limit", "prompt_budget", "request_limit",
  "selection_limit", "source_block_limit", "tool_limit"
]);
const SAFE_COMPONENT_KEYS = new Set([
  "annotation", "current_file", "history", "instructions", "project_context", "request",
  "selection", "source_block", "system", "tools", "user_message"
]);

function metadataKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
}

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

function sessionError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeTitle(title, fallback = "New session") {
  return String(title || "").replace(/\s+/g, " ").trim().slice(0, 64) || fallback;
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
    operation: proposal.operation === "create" ? "create" : "edit",
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
    approvalRequired: proposal.operation === "create" ? true : proposal.approvalRequired !== false,
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

function sanitizeContextUsage(contextUsage) {
  if (!contextUsage || typeof contextUsage !== "object") return null;
  const status = ["prepared", "complete", "failed", "unavailable", "not_applicable"].includes(contextUsage.status)
    ? contextUsage.status
    : "unavailable";
  const usage = contextUsage.usage && typeof contextUsage.usage === "object" ? contextUsage.usage : {};
  const window = contextUsage.window && typeof contextUsage.window === "object" ? contextUsage.window : {};
  const history = contextUsage.history && typeof contextUsage.history === "object" ? contextUsage.history : {};
  const truncation = contextUsage.truncation && typeof contextUsage.truncation === "object" ? contextUsage.truncation : {};
  const safeNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? Math.max(0, Number(value))
    : null;
  const measuredAtDate = new Date(String(contextUsage.measuredAt || ""));
  const measuredAt = Number.isNaN(measuredAtDate.getTime()) ? new Date().toISOString() : measuredAtDate.toISOString();
  return {
    version: 1,
    runId: String(contextUsage.runId || "").slice(0, 80),
    sessionId: String(contextUsage.sessionId || "").slice(0, 80),
    scope: "last_request",
    status,
    runtime: String(contextUsage.runtime || "").slice(0, 80),
    usage: {
      inputTokens: safeNumber(usage.inputTokens),
      outputTokens: safeNumber(usage.outputTokens),
      totalTokens: safeNumber(usage.totalTokens),
      source: ["provider_reported", "mixed", "server_estimate", "unavailable"].includes(usage.source)
        ? usage.source
        : "unavailable"
    },
    window: {
      contextWindowTokens: safeNumber(window.contextWindowTokens),
      maxOutputTokens: safeNumber(window.maxOutputTokens),
      percentUsed: safeNumber(window.percentUsed),
      source: ["local_runtime", "provider_model_config", "unknown"].includes(window.source) ? window.source : "unknown"
    },
    history: {
      availableTurns: safeNumber(history.availableTurns) || 0,
      includedTurns: safeNumber(history.includedTurns) || 0,
      droppedTurns: safeNumber(history.droppedTurns) || 0,
      summarized: false
    },
    truncation: {
      occurred: truncation.occurred === true,
      reasons: Array.isArray(truncation.reasons)
        ? [...new Set(truncation.reasons.map(metadataKey).filter((reason) => SAFE_TRUNCATION_REASONS.has(reason)))].slice(0, 20)
        : []
    },
    components: Array.isArray(contextUsage.components)
      ? contextUsage.components.slice(0, 20).map((component) => ({
        key: SAFE_COMPONENT_KEYS.has(metadataKey(component?.key)) ? metadataKey(component.key) : "other",
        originalChars: safeNumber(component?.originalChars) || 0,
        includedChars: safeNumber(component?.includedChars) || 0,
        truncated: component?.truncated === true
      }))
      : [],
    measuredAt
  };
}

function sanitizeRunResultMetadata(result) {
  if (!result || typeof result !== "object") return null;
  const safe = {
    runtime: String(result.runtime || "").slice(0, 80),
    modelId: String(result.modelId || "").slice(0, 120),
    provider: sanitizeProvider(result.provider)
  };
  return safe.runtime || safe.modelId || safe.provider ? safe : null;
}

function sanitizeRun(run) {
  if (!run || typeof run !== "object" || !run.runId) return null;
  const runId = String(run.runId).slice(0, 80);
  const clientMessageId = String(run.clientMessageId || "").slice(0, 80);
  const safe = {
    runId,
    sessionId: String(run.sessionId || "").slice(0, 80),
    clientMessageId,
    status: ["running", "complete", "failed", "cancelled", "interrupted"].includes(run.status)
      ? run.status
      : "interrupted",
    startedAt: Number(run.startedAt || Date.now()),
    finishedAt: Number(run.finishedAt || 0)
  };
  if (run.userMessage && typeof run.userMessage === "object") {
    safe.userMessage = sanitizeMessage({
      ...run.userMessage,
      id: clientMessageId || run.userMessage.id,
      role: "user",
      runId
    });
  }
  if (run.assistantMessage && typeof run.assistantMessage === "object") {
    safe.assistantMessage = sanitizeMessage({
      ...run.assistantMessage,
      role: "assistant",
      runId
    });
  }
  const resultMetadata = sanitizeRunResultMetadata(run.resultMetadata);
  if (resultMetadata) safe.resultMetadata = resultMetadata;
  if (Number.isFinite(Number(run.sessionRevision)) && Number(run.sessionRevision) > 0) {
    safe.sessionRevision = Number(run.sessionRevision);
  }
  const contextUsage = sanitizeContextUsage(run.contextUsage);
  if (contextUsage) safe.contextUsage = contextUsage;
  return safe;
}

function sanitizeRunMetadata(metadata) {
  const value = metadata && typeof metadata === "object" ? metadata : {};
  const safe = {};
  const lengths = { providerId: 80, providerName: 120, modelId: 120, modelName: 120, permissionMode: 40 };
  for (const [key, maxLength] of Object.entries(lengths)) {
    if (Object.hasOwn(value, key)) safe[key] = String(value[key] || "").slice(0, maxLength);
  }
  return safe;
}

function normalizeSession(session = {}, fallback = {}, options = {}) {
  const now = Date.now();
  const id = String(session.id || safeId()).slice(0, 80);
  const messages = Array.isArray(session.messages) ? session.messages.map(sanitizeMessage) : [];
  const title = normalizeTitle(session.title || fallback.title, "New session");
  const sanitizedRuns = (Array.isArray(session.runLedger) ? session.runLedger : [])
    .map((run) => sanitizeRun({ ...run, sessionId: id }))
    .filter(Boolean)
    .slice(-MAX_SESSION_RUNS);
  const hadRunningRun = sanitizedRuns.some((run) => run.status === "running");
  const runLedger = sanitizedRuns
    .map((run) => options.recoverStaleRuns && run.status === "running"
      ? { ...run, status: "interrupted", finishedAt: Date.now() }
      : run);
  const staleRunning = options.recoverStaleRuns
    && (session.runStatus === "running" || hadRunningRun);
  return {
    id,
    projectKey: String(session.projectKey || fallback.projectKey || ""),
    title,
    titleSource: session.titleSource === "manual" ? "manual" : "automatic",
    createdAt: Number(session.createdAt || now),
    updatedAt: Number(session.updatedAt || session.createdAt || now),
    parentSessionId: String(session.parentSessionId || ""),
    revision: Math.max(1, Number(session.revision || 1)),
    runStatus: staleRunning
      ? "interrupted"
      : (["idle", "running", "interrupted"].includes(session.runStatus) ? session.runStatus : "idle"),
    unread: session.unread === true,
    lastContextUsage: sanitizeContextUsage(session.lastContextUsage),
    providerId: String(session.providerId || ""),
    providerName: String(session.providerName || ""),
    modelId: String(session.modelId || ""),
    modelName: String(session.modelName || ""),
    permissionMode: String(session.permissionMode || "default"),
    status: String(session.status || "active"),
    changeCount: Number(session.changeCount || 0),
    messages: messages.slice(-MAX_SESSION_MESSAGES),
    runLedger
  };
}

function sessionPreview(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const last = [...messages].reverse().find((message) => message && message.id !== "welcome" && message.message);
  return last ? String(last.message || "").replace(/\s+/g, " ").trim().slice(0, 120) : "Ready to help with this project.";
}

function sessionChangeCount(session) {
  const ids = new Set();
  for (const message of session.messages || []) {
    for (const proposal of message.proposals || []) {
      if (proposal?.id) ids.add(proposal.id);
    }
    for (const proposalId of message.approvalCards || []) {
      if (proposalId) ids.add(proposalId);
    }
  }
  return Math.max(Math.max(0, Number(session.changeCount || 0)), ids.size);
}

function isUntouchedBlankSession(session) {
  return Boolean(session)
    && ["First session", "New session"].includes(session.title)
    && session.titleSource !== "manual"
    && session.runStatus === "idle"
    && session.unread !== true
    && (session.messages || []).filter((message) => message.id !== "welcome").length === 0
    && (session.runLedger || []).length === 0
    && !session.lastContextUsage
    && sessionChangeCount(session) === 0;
}

function publicSessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    titleSource: session.titleSource,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    parentSessionId: session.parentSessionId || "",
    revision: session.revision,
    runStatus: session.runStatus,
    unread: session.unread === true,
    lastContextUsage: sanitizeContextUsage(session.lastContextUsage),
    providerId: session.providerId || "",
    providerName: session.providerName || "",
    modelId: session.modelId || "",
    modelName: session.modelName || "",
    permissionMode: session.permissionMode || "default",
    status: session.status || "active",
    changeCount: sessionChangeCount(session),
    messageCount: (session.messages || []).filter((message) => message.id !== "welcome").length,
    lastPreview: sessionPreview(session)
  };
}

function publicSessionDetail(session) {
  return {
    ...publicSessionSummary(session),
    messages: (session.messages || []).map(sanitizeMessage)
  };
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!(["EACCES", "EEXIST", "EPERM"].includes(error.code) && process.platform === "win32")) throw error;
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // A second LocalLeaf process may still be replacing the same app-private file.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4 * (attempt + 1));
    }
  }
  try {
    fs.copyFileSync(tempPath, filePath);
    fs.rmSync(tempPath, { force: true });
  } catch {
    fs.rmSync(tempPath, { force: true });
    throw lastError;
  }
}

function createAiSessionStore(options = {}) {
  const memoryOnly = options.memory === true;
  const root = options.root || defaultSessionRoot();
  const filePath = memoryOnly ? "" : path.join(root, "sessions.json");
  let cache = memoryOnly ? { schemaVersion: SESSION_SCHEMA_VERSION, projects: {} } : null;

  function readStore() {
    if (cache) return cache;
    let loadedPersistedStore = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      cache = parsed && typeof parsed === "object" ? parsed : {};
      loadedPersistedStore = true;
    } catch {
      cache = {};
    }
    cache.schemaVersion = SESSION_SCHEMA_VERSION;
    if (!cache.projects || typeof cache.projects !== "object") cache.projects = {};
    for (const [key, recordValue] of Object.entries(cache.projects)) {
      const record = recordValue && typeof recordValue === "object" ? recordValue : {};
      record.key = String(record.key || key);
      record.sessions = (Array.isArray(record.sessions) ? record.sessions : [])
        .map((session) => normalizeSession(session, { projectKey: record.key }, { recoverStaleRuns: true }));
      if (!record.sessions.some((session) => session.id === record.currentSessionId)) {
        record.currentSessionId = record.sessions[0]?.id || "";
      }
      cache.projects[key] = record;
    }
    if (loadedPersistedStore) atomicWriteJson(filePath, cache);
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
        messages: []
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

  function sortSessions(projectRecord) {
    projectRecord.sessions = (projectRecord.sessions || [])
      .map((session) => normalizeSession(session, { projectKey: projectRecord.key }))
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
    if (!projectRecord.sessions.some((session) => session.id === projectRecord.currentSessionId)) {
      projectRecord.currentSessionId = projectRecord.sessions[0]?.id || "";
    }
  }

  function summaryState(project) {
    const record = ensureProject(project);
    sortSessions(record);
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      projectKey: record.key,
      projectName: record.name,
      currentSessionId: record.currentSessionId,
      sessions: record.sessions.map(publicSessionSummary)
    };
  }

  function publicState(project) {
    const record = ensureProject(project);
    sortSessions(record);
    const activeSession = record.sessions.find((session) => session.id === record.currentSessionId) || null;
    return {
      ...summaryState(project),
      activeSession: activeSession ? publicSessionDetail(activeSession) : null
    };
  }

  function findSession(record, sessionId) {
    return record.sessions.find((session) => session.id === sessionId) || null;
  }

  function requireSession(record, sessionId) {
    const session = findSession(record, sessionId);
    if (!session) throw sessionError("AI_SESSION_NOT_FOUND", "AI session was not found.", 404);
    return session;
  }

  function assertExpectedRevision(session, expectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null || expectedRevision === "") return;
    if (Number(expectedRevision) !== session.revision) {
      throw sessionError("AI_SESSION_REVISION", "AI session changed before this request was applied.");
    }
  }

  function assertSessionCapacity(record, additional = 1) {
    if (record.sessions.length + additional > MAX_PROJECT_SESSIONS) {
      throw sessionError("AI_SESSION_LIMIT", `A project can have at most ${MAX_PROJECT_SESSIONS} AI sessions.`);
    }
  }

  function getSession(project, sessionId) {
    const record = ensureProject(project);
    sortSessions(record);
    const session = findSession(record, sessionId);
    return session ? publicSessionDetail(session) : null;
  }

  function getRun(project, sessionId, runId) {
    const record = ensureProject(project);
    const session = requireSession(record, sessionId);
    const run = session.runLedger.find((item) => item.runId === String(runId || ""));
    return run ? sanitizeRun({ ...run, sessionId: session.id }) : null;
  }

  function updateSession(project, sessionId, updates = {}) {
    const record = ensureProject(project);
    sortSessions(record);
    const session = requireSession(record, sessionId);
    assertExpectedRevision(session, updates.expectedRevision);
    let changed = false;
    const assignString = (key, maxLength = 120) => {
      if (!Object.hasOwn(updates, key)) return;
      const value = String(updates[key] || "").slice(0, maxLength);
      if (session[key] !== value) {
        session[key] = value;
        changed = true;
      }
    };
    if (Object.hasOwn(updates, "title")) {
      const title = normalizeTitle(updates.title, session.title);
      if (title !== session.title || session.titleSource !== "manual") {
        session.title = title;
        session.titleSource = "manual";
        changed = true;
      }
    }
    assignString("providerId", 80);
    assignString("providerName", 120);
    assignString("modelId", 120);
    assignString("modelName", 120);
    assignString("permissionMode", 40);
    assignString("status", 40);
    if (Object.hasOwn(updates, "changeCount")) {
      const changeCount = Math.max(0, Number(updates.changeCount || 0));
      if (session.changeCount !== changeCount) {
        session.changeCount = changeCount;
        changed = true;
      }
    }
    if (changed) {
      session.updatedAt = Date.now();
      session.revision += 1;
    }
    if (updates.activate !== false) record.currentSessionId = session.id;
    sortSessions(record);
    writeStore();
    return publicState(project);
  }

  function renameSession(project, sessionId, input = {}) {
    const record = ensureProject(project);
    sortSessions(record);
    const session = requireSession(record, sessionId);
    assertExpectedRevision(session, input.expectedRevision);
    const title = normalizeTitle(input.title, "");
    if (!title) throw sessionError("AI_SESSION_TITLE", "AI session title cannot be blank.", 400);
    if (title === session.title && session.titleSource === "manual") return publicState(project);
    session.title = title;
    session.titleSource = "manual";
    session.updatedAt = Date.now();
    session.revision += 1;
    sortSessions(record);
    writeStore();
    return publicState(project);
  }

  function createSession(project, input = {}) {
    const record = ensureProject(project);
    sortSessions(record);
    assertSessionCapacity(record);
    const session = normalizeSession({
      id: safeId(),
      projectKey: record.key,
      title: input.title || "New session",
      titleSource: input.title ? "manual" : "automatic",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, { projectKey: record.key });
    record.sessions = [session, ...(record.sessions || [])];
    record.currentSessionId = session.id;
    sortSessions(record);
    writeStore();
    return publicState(project);
  }

  function activateSession(project, sessionId) {
    const record = ensureProject(project);
    sortSessions(record);
    const session = requireSession(record, sessionId);
    record.currentSessionId = session.id;
    if (session.unread) {
      session.unread = false;
      session.revision += 1;
    }
    record.updatedAt = Date.now();
    writeStore();
    return publicState(project);
  }

  function deleteSession(project, sessionId, input = {}) {
    const record = ensureProject(project);
    sortSessions(record);
    const target = requireSession(record, sessionId);
    assertExpectedRevision(target, input.expectedRevision);
    if (target.runStatus === "running") {
      throw sessionError("AI_SESSION_BUSY", "Stop the running response before deleting this AI session.");
    }
    record.sessions = (record.sessions || []).filter((session) => session.id !== sessionId);
    if (!record.sessions.length) {
      const session = normalizeSession({ title: "New session", projectKey: record.key, messages: [] });
      record.sessions = [session];
      record.currentSessionId = session.id;
    } else if (record.currentSessionId === sessionId) {
      record.currentSessionId = record.sessions[0].id;
    }
    sortSessions(record);
    writeStore();
    return publicState(project);
  }

  function forkSession(project, sessionId, input = {}) {
    const record = ensureProject(project);
    sortSessions(record);
    const source = requireSession(record, sessionId);
    assertExpectedRevision(source, input.expectedRevision);
    assertSessionCapacity(record);
    const session = normalizeSession({
      ...source,
      id: safeId(),
      parentSessionId: source.id,
      title: `Fork: ${source.title || "Session"}`.slice(0, 64),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      messages: (source.messages || []).map((message) => ({ ...message })),
      lastContextUsage: null,
      runStatus: "idle",
      unread: false,
      runLedger: []
    }, { projectKey: record.key });
    record.sessions = [session, ...(record.sessions || [])];
    record.currentSessionId = session.id;
    sortSessions(record);
    writeStore();
    return publicState(project);
  }

  function importLegacySessions(project, sessions = [], currentSessionId = "") {
    const record = ensureProject(project);
    const existingSessions = record.sessions.length === 1 && isUntouchedBlankSession(record.sessions[0])
      ? []
      : record.sessions;
    const seenIds = new Set(existingSessions.map((session) => session.id));
    const imported = [];
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session || !session.id) continue;
      const normalized = normalizeSession(
        { ...session, projectKey: record.key },
        { projectKey: record.key },
        { recoverStaleRuns: true }
      );
      if (seenIds.has(normalized.id)) continue;
      seenIds.add(normalized.id);
      imported.push(normalized);
    }
    if (imported.length) {
      if (existingSessions.length + imported.length > MAX_PROJECT_SESSIONS) {
        throw sessionError("AI_SESSION_LIMIT", `A project can have at most ${MAX_PROJECT_SESSIONS} AI sessions.`);
      }
      record.sessions = [...imported, ...existingSessions];
      if (currentSessionId && imported.some((session) => session.id === currentSessionId)) {
        record.currentSessionId = currentSessionId;
      }
      sortSessions(record);
      writeStore();
    }
    return publicState(project);
  }

  function beginRun(project, sessionId, input = {}) {
    const record = ensureProject(project);
    sortSessions(record);
    const session = requireSession(record, sessionId);
    const runId = String(input.runId || "").trim().slice(0, 80);
    if (!runId) throw sessionError("AI_RUN_INVALID", "AI run ID is required.", 400);
    const existingOwner = record.sessions.find((item) => item.runLedger.some((run) => run.runId === runId));
    if (existingOwner) {
      if (existingOwner.id === session.id) return publicState(project);
      throw sessionError("AI_RUN_BUSY", "That AI run already belongs to another session.");
    }
    const runningSession = record.sessions.find((item) => item.runStatus === "running");
    if (runningSession) {
      const error = sessionError("AI_RUN_BUSY", "Another AI response is already running for this project.");
      error.sessionId = runningSession.id;
      throw error;
    }
    const hadUserMessage = session.messages.some((message) => message.role === "user" && message.id !== "welcome");
    const clientMessageId = String(input.clientMessageId || safeId("message")).slice(0, 80);
    const userMessage = sanitizeMessage({
      id: clientMessageId,
      role: "user",
      message: input.message,
      createdAt: Date.now(),
      runId
    });
    if (!session.messages.some((message) => message.id === clientMessageId)) {
      session.messages.push(userMessage);
      session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
    }
    if (!hadUserMessage && session.titleSource !== "manual") {
      session.title = String(input.message || "New session").replace(/\s+/g, " ").trim().slice(0, 64) || "New session";
    }
    session.runLedger.push(sanitizeRun({
      runId,
      sessionId: session.id,
      clientMessageId,
      userMessage,
      status: "running",
      startedAt: Date.now()
    }));
    session.runLedger = session.runLedger.filter(Boolean).slice(-MAX_SESSION_RUNS);
    session.runStatus = "running";
    session.updatedAt = Date.now();
    session.revision += 1;
    writeStore();
    return publicState(project);
  }

  function finalizeRun(project, sessionId, input = {}) {
    const record = ensureProject(project);
    sortSessions(record);
    const session = requireSession(record, sessionId);
    const run = session.runLedger.find((item) => item.runId === String(input.runId || ""));
    if (!run || run.status !== "running") return publicState(project);
    const assistantInput = typeof input.assistantMessage === "string"
      ? { message: input.assistantMessage }
      : (input.assistantMessage || {});
    const assistantMessage = sanitizeMessage({
      ...assistantInput,
      id: assistantInput.id || `assistant-${run.runId}`,
      role: "assistant",
      runId: run.runId,
      createdAt: assistantInput.createdAt || Date.now()
    });
    session.messages.push(assistantMessage);
    session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
    run.status = "complete";
    run.finishedAt = Date.now();
    run.sessionId = session.id;
    run.assistantMessage = assistantMessage;
    run.resultMetadata = sanitizeRunResultMetadata(input.result);
    session.runStatus = "idle";
    session.unread = record.currentSessionId !== session.id;
    Object.assign(session, sanitizeRunMetadata(input.metadata));
    session.lastContextUsage = sanitizeContextUsage(input.contextUsage
      ? { ...input.contextUsage, runId: run.runId, sessionId: session.id }
      : null);
    run.contextUsage = session.lastContextUsage;
    session.updatedAt = Date.now();
    session.revision += 1;
    run.sessionRevision = session.revision;
    writeStore();
    return publicState(project);
  }

  function cancelRun(project, sessionId, input = {}) {
    const record = ensureProject(project);
    sortSessions(record);
    const session = requireSession(record, sessionId);
    const run = session.runLedger.find((item) => item.runId === String(input.runId || ""));
    if (!run || run.status !== "running") return publicState(project);
    run.status = "cancelled";
    run.finishedAt = Date.now();
    session.runStatus = "idle";
    session.updatedAt = Date.now();
    session.revision += 1;
    writeStore();
    return publicState(project);
  }

  function failRun(project, sessionId, input = {}) {
    const record = ensureProject(project);
    sortSessions(record);
    const session = requireSession(record, sessionId);
    const run = session.runLedger.find((item) => item.runId === String(input.runId || ""));
    if (!run || run.status !== "running") return publicState(project);
    run.status = "failed";
    run.finishedAt = Date.now();
    session.runStatus = "interrupted";
    session.lastContextUsage = sanitizeContextUsage(input.contextUsage
      ? { ...input.contextUsage, runId: run.runId, sessionId: session.id }
      : null);
    session.updatedAt = Date.now();
    session.revision += 1;
    writeStore();
    return publicState(project);
  }

  return {
    root,
    filePath,
    projectKeyForRoot,
    summaryState,
    publicState,
    createSession,
    activateSession,
    updateSession,
    renameSession,
    deleteSession,
    forkSession,
    importLegacySessions,
    getSession,
    getRun,
    beginRun,
    finalizeRun,
    failRun,
    cancelRun
  };
}

module.exports = {
  createAiSessionStore,
  createMemoryAiSessionStore: () => createAiSessionStore({ memory: true }),
  createWelcomeMessage,
  projectKeyForRoot
};
