const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { projectKeyForRoot } = require("./ai-sessions");

const MAX_PROJECT_THREADS = 300;
const MAX_THREAD_MESSAGES = 80;

function defaultReviewRoot() {
  const base = process.env.LOCALLEAF_REVIEW_DIR
    || process.env.LOCALLEAF_APPDATA_DIR
    || path.join(os.homedir(), ".localleaf");
  return path.join(base, "ReviewThreads");
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function safeId(prefix = "review") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function sanitizeAuthor(author = {}) {
  return {
    userId: String(author.userId || author.id || "").slice(0, 80),
    userName: String(author.userName || author.name || "Reviewer").replace(/\s+/g, " ").trim().slice(0, 120) || "Reviewer",
    role: String(author.role || "").slice(0, 40)
  };
}

function sanitizeRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  return {
    left: Number(rect.left || 0),
    top: Number(rect.top || 0),
    width: Number(rect.width || 0),
    height: Number(rect.height || 0)
  };
}

function sanitizeAnchor(anchor = {}) {
  const source = anchor.source && typeof anchor.source === "object" ? anchor.source : null;
  return {
    kind: ["pdf", "source", "diagnostic"].includes(anchor.kind) ? anchor.kind : "source",
    page: Number(anchor.page || 0),
    x: Number(anchor.x || 0),
    y: Number(anchor.y || 0),
    targetRect: sanitizeRect(anchor.targetRect),
    textPreview: String(anchor.textPreview || "").replace(/\s+/g, " ").trim().slice(0, 1200),
    source: source
      ? {
        path: String(source.path || "").slice(0, 260),
        line: Number(source.line || 0),
        column: Number(source.column || 0)
      }
      : null,
    compileVersion: Number(anchor.compileVersion || 0),
    diagnostic: anchor.diagnostic && typeof anchor.diagnostic === "object"
      ? {
        severity: ["error", "warning", "info"].includes(anchor.diagnostic.severity) ? anchor.diagnostic.severity : "info",
        message: String(anchor.diagnostic.message || "").slice(0, 1000)
      }
      : null
  };
}

function sanitizeMessage(message = {}) {
  return {
    id: String(message.id || safeId("reply")).slice(0, 80),
    body: String(message.body || message.message || "").trim().slice(0, 4000),
    author: sanitizeAuthor(message.author),
    createdAt: Number(message.createdAt || Date.now())
  };
}

function sanitizeThread(thread = {}) {
  const messages = Array.isArray(thread.messages)
    ? thread.messages.map(sanitizeMessage).filter((message) => message.body).slice(-MAX_THREAD_MESSAGES)
    : [];
  const now = Date.now();
  return {
    id: String(thread.id || safeId()).slice(0, 80),
    status: thread.status === "resolved" ? "resolved" : "open",
    title: String(thread.title || "").replace(/\s+/g, " ").trim().slice(0, 160),
    anchor: sanitizeAnchor(thread.anchor),
    requester: sanitizeAuthor(thread.requester || messages[0]?.author || {}),
    messages,
    createdAt: Number(thread.createdAt || now),
    updatedAt: Number(thread.updatedAt || thread.resolvedAt || now),
    resolvedAt: Number(thread.resolvedAt || 0) || null,
    reopenedAt: Number(thread.reopenedAt || 0) || null
  };
}

function createReviewThreadStore(options = {}) {
  const root = options.root || defaultReviewRoot();
  const memoryOnly = options.memory === true;
  const filePath = memoryOnly ? "" : path.join(root, "review-threads.json");
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
        threads: [],
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
    return (record.threads || [])
      .map(sanitizeThread)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  }

  function upsert(project, thread) {
    const clean = sanitizeThread({ ...thread, updatedAt: Date.now() });
    const record = projectRecord(project);
    record.threads = [
      clean,
      ...(record.threads || []).filter((item) => item.id !== clean.id)
    ]
      .map(sanitizeThread)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .slice(0, MAX_PROJECT_THREADS);
    record.updatedAt = Date.now();
    writeStore();
    return clean;
  }

  function create(project, input = {}) {
    const author = sanitizeAuthor(input.author || input.requester);
    const body = String(input.body || input.message || "").trim();
    if (!body) throw new Error("Review comment is required.");
    const thread = sanitizeThread({
      id: safeId("review"),
      status: "open",
      title: input.title,
      anchor: input.anchor,
      requester: author,
      messages: [
        {
          id: safeId("reply"),
          body,
          author,
          createdAt: Date.now()
        }
      ],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    return upsert(project, thread);
  }

  function get(project, threadId) {
    return list(project).find((thread) => thread.id === threadId) || null;
  }

  function reply(project, threadId, input = {}) {
    const thread = get(project, threadId);
    if (!thread) throw new Error("Review thread was not found.");
    const message = sanitizeMessage({
      id: safeId("reply"),
      body: input.body || input.message,
      author: input.author,
      createdAt: Date.now()
    });
    if (!message.body) throw new Error("Reply text is required.");
    thread.messages = [...(thread.messages || []), message].slice(-MAX_THREAD_MESSAGES);
    thread.updatedAt = Date.now();
    return upsert(project, thread);
  }

  function setStatus(project, threadId, status) {
    const thread = get(project, threadId);
    if (!thread) throw new Error("Review thread was not found.");
    const now = Date.now();
    thread.status = status === "resolved" ? "resolved" : "open";
    thread.updatedAt = now;
    if (thread.status === "resolved") thread.resolvedAt = now;
    else thread.reopenedAt = now;
    return upsert(project, thread);
  }

  function clearProject(project) {
    const record = projectRecord(project);
    record.threads = [];
    record.updatedAt = Date.now();
    writeStore();
  }

  return {
    root,
    filePath,
    list,
    create,
    reply,
    setStatus,
    clearProject
  };
}

module.exports = {
  createReviewThreadStore,
  sanitizeThread
};
