const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { projectKeyForRoot } = require("./ai-sessions");

const MAX_PROJECT_CHANGES = 250;

function defaultChangeRoot() {
  const base = process.env.LOCALLEAF_AI_CHANGE_DIR
    || process.env.LOCALLEAF_APPDATA_DIR
    || path.join(os.homedir(), ".localleaf");
  return path.join(base, "AiChanges");
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function sanitizeRequester(requester = {}) {
  return {
    userId: String(requester.userId || requester.id || "").slice(0, 80),
    userName: String(requester.userName || requester.name || "").slice(0, 120),
    role: String(requester.role || "").slice(0, 40)
  };
}

function sanitizeDiffHunks(hunks) {
  if (!Array.isArray(hunks)) return [];
  return hunks.slice(0, 100).map((hunk) => ({
    oldStart: Number(hunk?.oldStart || 0),
    newStart: Number(hunk?.newStart || 0),
    line: Number(hunk?.line || 0),
    lines: Array.isArray(hunk?.lines)
      ? hunk.lines.slice(0, 1500).map((line) => ({
        type: ["added", "removed", "context"].includes(line?.type) ? line.type : "context",
        text: String(line?.text || "").slice(0, 2000)
      }))
      : []
  }));
}

function sanitizeChange(record = {}) {
  if (!record.id) return null;
  return {
    id: String(record.id).slice(0, 80),
    runId: String(record.runId || "").slice(0, 80),
    sessionId: String(record.sessionId || "").slice(0, 80),
    operation: record.operation === "create" ? "create" : "edit",
    path: String(record.path || "").slice(0, 260),
    baseHash: String(record.baseHash || "").slice(0, 128),
    newHash: String(record.newHash || "").slice(0, 128),
    status: String(record.status || "proposed").slice(0, 40),
    summary: String(record.summary || "").slice(0, 500),
    userRequest: String(record.userRequest || "").slice(0, 12000),
    provider: record.provider && typeof record.provider === "object"
      ? {
        id: String(record.provider.id || "").slice(0, 80),
        name: String(record.provider.name || "").slice(0, 120),
        type: String(record.provider.type || "").slice(0, 80)
      }
      : null,
    modelId: String(record.modelId || "").slice(0, 120),
    approvalRequired: record.operation === "create" ? true : record.approvalRequired !== false,
    diffHunks: sanitizeDiffHunks(record.diffHunks),
    focus: record.focus && typeof record.focus === "object"
      ? {
        start: Number(record.focus.start || 0),
        end: Number(record.focus.end || record.focus.start || 0),
        line: Number(record.focus.line || 0),
        column: Number(record.focus.column || 0)
      }
      : null,
    requester: sanitizeRequester(record.requester),
    createdAt: Number(record.createdAt || Date.now()),
    appliedAt: Number(record.appliedAt || 0) || null,
    rejectedAt: Number(record.rejectedAt || 0) || null,
    revertedAt: Number(record.revertedAt || 0) || null,
    updatedAt: Number(record.updatedAt || record.appliedAt || record.rejectedAt || record.revertedAt || record.createdAt || Date.now())
  };
}

function createAiChangeStore(options = {}) {
  const root = options.root || defaultChangeRoot();
  const memoryOnly = options.memory === true;
  const filePath = memoryOnly ? "" : path.join(root, "changes.json");
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

  function projectRecord(project = {}) {
    const key = projectKeyForRoot(project.root || "");
    const store = readStore();
    if (!store.projects[key]) {
      store.projects[key] = {
        key,
        name: String(project.name || path.basename(project.root || "") || "LocalLeaf Project"),
        changes: [],
        updatedAt: Date.now()
      };
    } else {
      Object.assign(store.projects[key], {
        name: String(project.name || store.projects[key].name || "LocalLeaf Project"),
        updatedAt: Date.now()
      });
    }
    return store.projects[key];
  }

  function list(project) {
    const record = projectRecord(project);
    return (record.changes || []).map(sanitizeChange).filter(Boolean);
  }

  function upsert(project, change) {
    const clean = sanitizeChange({ ...change, updatedAt: Date.now() });
    if (!clean) return list(project);
    const record = projectRecord(project);
    record.changes = [
      clean,
      ...(record.changes || []).filter((item) => item.id !== clean.id)
    ]
      .map(sanitizeChange)
      .filter(Boolean)
      .sort((left, right) => Number(right.updatedAt || right.createdAt || 0) - Number(left.updatedAt || left.createdAt || 0))
      .slice(0, MAX_PROJECT_CHANGES);
    record.updatedAt = Date.now();
    writeStore();
    return list(project);
  }

  function clearProject(project) {
    const record = projectRecord(project);
    record.changes = [];
    record.updatedAt = Date.now();
    writeStore();
  }

  return {
    root,
    filePath,
    list,
    upsert,
    clearProject
  };
}

module.exports = {
  createAiChangeStore,
  sanitizeChange
};
