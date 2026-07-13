const fs = require("node:fs");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { spawn } = require("node:child_process");
const AdmZip = require("adm-zip");
const { WebSocketServer } = require("ws");
const PACKAGE_INFO = require("../../package.json");
const {
  detectMainFile,
  getProjectSize,
  isImageFile,
  isTextFile,
  listProjectFiles,
  normalizeRelativePath,
  resolveProjectPath
} = require("./safe-path");
const {
  capCompilerLogs,
  cleanupCompileArtifact,
  compileProject,
  commandExists,
  createCompileSnapshot,
  detectCompiler,
  isValidPdfArtifact
} = require("./compiler");
const { collectProjectEditorSuggestions } = require("./editor-suggestions");
const { createAiModelManager } = require("./ai-models");
const { createAiChangeStore } = require("./ai-changes");
const { createAiSessionStore, createMemoryAiSessionStore, projectKeyForRoot } = require("./ai-sessions");
const { buildContextUsage, estimateTokens } = require("./ai-context");
const { aiResponsePromptGuidance, boundedPlainText, formatAgentReply } = require("./ai-response-style");
const { createSynctexWorkerClient } = require("./synctex-worker-client");
const {
  DEFAULT_CURSOR_MODEL_ID,
  changedTextFiles,
  copyProjectToScratch,
  cursorLatexPrompt,
  runCursorSdkAgent,
  snapshotTextFiles
} = require("./cursor-agent");

let localtunnelClient = null;
try {
  localtunnelClient = require("localtunnel");
} catch {
  localtunnelClient = null;
}

const ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SAMPLE_PROJECT = path.join(ROOT, "samples", "thesis");
const DEFAULT_PROJECT_NAME = "LocalLeaf Project";
const DEFAULT_PORT = Number(process.env.PORT || 4317);
const MAX_GUESTS = 5;
const GUEST_ROLES = new Set(["viewer", "maintainer"]);
const MAX_PENDING_JOIN_REQUESTS = 20;
const MAX_RETAINED_JOIN_REQUESTS = 100;
const TUNNEL_VERIFY_ATTEMPTS = 12;
const TUNNEL_RESTART_ATTEMPTS = 3;
const TUNNEL_START_TIMEOUT_MS = 35000;
const SESSION_END_TUNNEL_GRACE_MS = 10000;
const SERVER_CLOSE_NOTICE_GRACE_MS = 350;
const UPDATE_CACHE_TTL_MS = 30 * 60 * 1000;
const UPDATE_RELEASE_API = "https://api.github.com/repos/sethwhenton/localleaf/releases/latest";
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const MAX_IMPORT_ENTRIES = 5000;
const MAX_IMPORT_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = 75 * 1024 * 1024;
const MAX_AI_CREATED_FILE_BYTES = 256 * 1024;
const MAX_IN_MEMORY_AI_PROPOSALS = 250;
const MAX_IN_MEMORY_AI_PROPOSAL_BYTES = 32 * 1024 * 1024;
const AI_CREATABLE_TEXT_EXTENSIONS = new Set([
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
  ".dat"
]);
const SYNCTEX_LOOKUP_TIMEOUT_MS = 2500;
const SYNCTEX_LOOKUP_MAX_OUTPUT_BYTES = 64 * 1024;
const SYNCTEX_MAX_CONCURRENT_LOOKUPS = 4;
const HOSTED_AGENT_PROMPT_LIMITS = {
  currentFileBudget: 42000,
  projectContextBudget: 70000,
  projectContextPerFileBudget: 18000,
  selectedTextBudget: 8000,
  compileLogBudget: 8000,
  conversationTurns: 10,
  conversationItemBudget: 1200,
  maxTokens: 1800
};
const LOCAL_AGENT_PROMPT_LIMITS = {
  currentFileBudget: 14000,
  projectContextBudget: 18000,
  projectContextPerFileBudget: 5000,
  selectedTextBudget: 3000,
  compileLogBudget: 3000,
  conversationTurns: 6,
  conversationItemBudget: 600,
  maxTokens: 1000
};

function localAgentPromptLimits(contextWindowTokens) {
  const contextTokens = Number(contextWindowTokens) || 16384;
  if (contextTokens <= 4096) {
    return {
      currentFileBudget: 800,
      projectContextBudget: 1300,
      projectContextPerFileBudget: 700,
      selectedTextBudget: 300,
      compileLogBudget: 300,
      conversationTurns: 1,
      conversationItemBudget: 160,
      maxTokens: 512
    };
  }
  if (contextTokens <= 8192) {
    return {
      currentFileBudget: 4000,
      projectContextBudget: 6000,
      projectContextPerFileBudget: 2000,
      selectedTextBudget: 900,
      compileLogBudget: 900,
      conversationTurns: 3,
      conversationItemBudget: 280,
      maxTokens: 700
    };
  }
  return LOCAL_AGENT_PROMPT_LIMITS;
}
const publicDnsResolver = new dns.Resolver();
publicDnsResolver.setServers(PUBLIC_DNS_SERVERS);
let latestReleaseCache = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

function securityHeaders(extra = {}) {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.github.com ws: wss:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'"
    ].join("; "),
    ...extra
  };
}

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function beginNdjsonResponse(response) {
  response.writeHead(200, {
    ...securityHeaders(),
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no"
  });
}

function sendNdjson(response, event) {
  response.write(`${JSON.stringify({ at: Date.now(), ...event })}\n`);
}

function textResponse(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(payload);
}

function timingSafeEqualString(left, right) {
  const leftText = String(left || "");
  const rightText = String(right || "");
  if (!leftText || !rightText) return false;
  const leftBuffer = Buffer.from(leftText);
  const rightBuffer = Buffer.from(rightText);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getHostToken(request, url) {
  return (
    request.headers["x-localleaf-host-token"] ||
    url.searchParams.get("host") ||
    url.searchParams.get("hostToken") ||
    ""
  );
}

function isHostRequest(state, request, url) {
  return timingSafeEqualString(getHostToken(request, url), state.hostToken);
}

function deny(response, message = "This action is only available to the local host app.") {
  jsonResponse(response, 403, { error: message });
}

function getAuthToken(request, url) {
  return (
    request.headers["x-localleaf-token"] ||
    url.searchParams.get("token") ||
    url.searchParams.get("t") ||
    ""
  );
}

function getTokenUser(state, request, url) {
  if (state.session.status !== "live") return null;
  const token = String(getAuthToken(request, url));
  const userId = token ? state.session.activeTokens.get(token) : null;
  return userId ? state.session.users.find((user) => user.id === userId) : null;
}

function canReadProject(state, request, url) {
  return isHostRequest(state, request, url) || Boolean(getTokenUser(state, request, url));
}

function sessionGuestLimit(state) {
  const configured = Number(state.session.maxGuests);
  return Number.isInteger(configured) && configured >= 0 ? configured : MAX_GUESTS;
}

function sessionGuestCount(state) {
  return state.session.users.filter((user) => user.role !== "host").length;
}

function normalizedGuestRole(value, fallback = null) {
  const role = String(value ?? "").trim().toLowerCase();
  if (!role) return fallback;
  return GUEST_ROLES.has(role) ? role : null;
}

function apiErrorPayload(error) {
  const payload = { error: error?.message || "Request failed." };
  if (error?.code) payload.code = String(error.code);
  if (error?.sessionId) payload.sessionId = String(error.sessionId);
  if (error?.runId) payload.runId = String(error.runId);
  return payload;
}

function apiErrorResponse(response, error, fallbackStatus = 400) {
  const statusCode = Number(error?.statusCode || fallbackStatus);
  jsonResponse(response, statusCode, apiErrorPayload(error));
}

function requestIdentity(state, request, url) {
  if (isHostRequest(state, request, url)) {
    const host = state.session.users.find((user) => user.id === "host") || { id: "host", name: getHostName(), role: "host" };
    return {
      isHost: true,
      user: host,
      userId: "host",
      userName: host.name || getHostName(),
      role: "host",
      canRead: true,
      canEdit: true
    };
  }
  const user = getTokenUser(state, request, url);
  return {
    isHost: false,
    user,
    userId: user?.id || "",
    userName: user?.name || "",
    role: user?.role || "",
    canRead: Boolean(user),
    canEdit: Boolean(user && user.role === "maintainer")
  };
}

function identityHasCapability(identity, capability) {
  if (capability === "read") return Boolean(identity.canRead);
  if (capability === "ai") return Boolean(identity.isHost || identity.canEdit);
  return Boolean(identity.canEdit);
}

async function readAuthorizedRequestPayload(state, request, response, url, options = {}) {
  const capability = options.capability || "edit";
  const message = options.message || "Maintainer access is required before changing this project.";
  let identity = requestIdentity(state, request, url);
  if (!identityHasCapability(identity, capability)) {
    deny(response, message);
    return null;
  }
  const context = typeof options.capture === "function" ? options.capture(identity) : null;
  const reader = options.reader || readBody;
  const body = await reader(request);
  identity = requestIdentity(state, request, url);
  if (!identityHasCapability(identity, capability)) {
    deny(response, message);
    return null;
  }
  return { body, identity, context };
}

function captureAiSessionMutationContext(state, identity) {
  const sessionStore = aiSessionStoreForIdentity(state, identity);
  return {
    sessionStore,
    originProjectKey: sessionStore.projectKeyForRoot(state.project.root)
  };
}

function requesterFromIdentity(identity = {}) {
  return {
    userId: identity.userId || (identity.isHost ? "host" : ""),
    userName: identity.userName || identity.user?.name || (identity.isHost ? getHostName() : ""),
    role: identity.role || identity.user?.role || (identity.isHost ? "host" : "")
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 2_000_000) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    request.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    request.on("error", reject);
  });
}

function readRawBody(request, limitBytes = 120 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        request.destroy();
        reject(new Error("Uploaded file is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function randomId(size = 12) {
  return crypto.randomBytes(size).toString("hex");
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let index = 0; index < 8; index += 1) {
    value += alphabet[crypto.randomInt(alphabet.length)];
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function getHostName() {
  try {
    return os.userInfo().username || "Host";
  } catch {
    return process.env.USERNAME || process.env.USER || "Host";
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getLanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "127.0.0.1";
}

function findCloudflared() {
  const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = [
    process.env.LOCALLEAF_CLOUDFLARED_PATH,
    path.join(ROOT, "bin", executable),
    process.resourcesPath ? path.join(process.resourcesPath, "bin", executable) : ""
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return commandExists("cloudflared") ? "cloudflared" : null;
}

function findSsh() {
  const executable = process.platform === "win32" ? "ssh.exe" : "ssh";
  const candidates = [
    process.env.LOCALLEAF_SSH_PATH,
    process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", executable) : "",
    process.platform === "win32" ? path.join(process.env.WINDIR || "C:\\Windows", "System32", "OpenSSH", executable) : ""
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return commandExists("ssh") ? "ssh" : null;
}

function createSshArgs() {
  return [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=20",
    "-o", "ServerAliveCountMax=3"
  ];
}

function createTunnelProviders() {
  const cloudflaredCommand = findCloudflared();
  const sshCommand = findSsh();
  const providers = [];

  if (sshCommand) {
    providers.push({
      id: "pinggy",
      name: "Pinggy",
      type: "process",
      command: sshCommand,
      args: ({ port }) => [
        ...createSshArgs(),
        "-p", "443",
        "-R", `0:127.0.0.1:${port}`,
        "free.pinggy.io"
      ],
      urlPattern: /https:\/\/[a-zA-Z0-9.-]+\.pinggy\.link/g,
      hint: "Free SSH tunnel, usually fastest fallback. Free sessions may time out."
    });

    providers.push({
      id: "localhostrun",
      name: "localhost.run",
      type: "process",
      command: sshCommand,
      args: ({ port }) => [
        ...createSshArgs(),
        "-R", `80:127.0.0.1:${port}`,
        "nokey@localhost.run"
      ],
      urlPattern: /https:\/\/[a-zA-Z0-9.-]+(?:localhost\.run|lhr\.life|lhr\.rocks)/g,
      hint: "Free SSH tunnel with temporary domains."
    });
  }

  if (localtunnelClient) {
    providers.push({
      id: "localtunnel",
      name: "LocalTunnel",
      type: "localtunnel",
      hint: "Bundled Node tunnel client. Useful as a fallback when SSH tunnels are unavailable."
    });
  }

  if (cloudflaredCommand) {
    providers.push({
      id: "cloudflare",
      name: "Cloudflare",
      type: "process",
      command: cloudflaredCommand,
      args: ({ baseUrl }) => ["tunnel", "--url", baseUrl],
      urlPattern: /https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/g,
      hint: "Bundled Cloudflare Quick Tunnel. Can be rate-limited after frequent starts."
    });
  }

  return providers;
}

function getUserProjectsDir() {
  return process.env.LOCALLEAF_PROJECTS_DIR || path.join(os.homedir(), "Documents", "LocalLeaf Projects");
}

function validateNewProjectName(value) {
  if (value === undefined) return DEFAULT_PROJECT_NAME;
  if (typeof value !== "string") {
    throw new Error("Project name must be text.");
  }

  const name = value.trim();
  if (!name) throw new Error("Project name is required.");
  if (name.length > 70) throw new Error("Project name must be 70 characters or fewer.");
  if (name === "." || name === "..") throw new Error("Choose a different project name.");
  if (/[\u0000-\u001f<>:\"/\\|?*]/.test(name)) {
    throw new Error("Project name contains characters that cannot be used in a folder name.");
  }
  if (/[. ]$/.test(name)) {
    throw new Error("Project name cannot end with a period or space.");
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error("Choose a project name that is not reserved by the operating system.");
  }
  return name;
}

function resolveNewProjectDestination(value) {
  let destination;
  if (value === undefined) {
    destination = path.resolve(getUserProjectsDir());
    fs.mkdirSync(destination, { recursive: true });
  } else {
    if (typeof value !== "string") {
      throw new Error("Destination folder must be a path.");
    }

    const input = value.trim();
    if (!input) throw new Error("Destination folder is required.");
    if (input.length > 2048 || input.includes("\0")) {
      throw new Error("Destination folder path is invalid.");
    }
    if (input.startsWith("\\\\") || input.startsWith("//")) {
      throw new Error("Choose a local destination folder instead of a network path.");
    }
    if (!path.isAbsolute(input)) {
      throw new Error("Destination folder must use an absolute path.");
    }

    destination = path.resolve(input);
    let stats;
    try {
      stats = fs.statSync(destination);
    } catch {
      throw new Error("Destination folder was not found.");
    }
    if (!stats.isDirectory()) {
      throw new Error("Destination must be a folder.");
    }
  }
  const realDestination = fs.realpathSync(destination);
  const realTemplateRoot = fs.realpathSync(SAMPLE_PROJECT);
  const templateWithSeparator = realTemplateRoot.endsWith(path.sep)
    ? realTemplateRoot
    : `${realTemplateRoot}${path.sep}`;
  if (realDestination === realTemplateRoot || realDestination.startsWith(templateWithSeparator)) {
    throw new Error("Choose a destination outside LocalLeaf's bundled starter template.");
  }
  return destination;
}

function sanitizeProjectName(name) {
  const clean = String(name || "Imported Project")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9 _.-]/g, "")
    .trim()
    .slice(0, 70);
  return clean || "Imported Project";
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function uniqueDirectory(parent, baseName) {
  fs.mkdirSync(parent, { recursive: true });
  const cleanBase = sanitizeProjectName(baseName);
  let candidate = path.join(parent, cleanBase);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${cleanBase} ${index}`);
    index += 1;
  }
  return candidate;
}

function reserveUniqueDirectory(parent, baseName) {
  let index = 1;
  while (index < 10_000) {
    const suffix = index === 1 ? "" : ` ${index}`;
    const candidate = path.join(parent, `${baseName}${suffix}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      index += 1;
    }
  }
  throw new Error("Could not choose an unused project folder name.");
}

function ensureDefaultProjectRoot(options = {}) {
  if (options.projectRoot) {
    return path.resolve(options.projectRoot);
  }

  const projectRoot = path.join(getUserProjectsDir(), DEFAULT_PROJECT_NAME);
  if (!fs.existsSync(projectRoot)) {
    copyDirectory(SAMPLE_PROJECT, projectRoot);
  }
  return projectRoot;
}

function chooseExtractedProjectRoot(extractRoot) {
  const entries = fs.readdirSync(extractRoot, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractRoot, entries[0].name);
  }
  return extractRoot;
}

function assertInsideDirectory(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("ZIP contains a file outside the project folder.");
  }
}

function extractZipBuffer(zipBuffer, extractRoot) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  if (entries.length > MAX_IMPORT_ENTRIES) {
    throw new Error(`ZIP contains too many files. LocalLeaf supports up to ${MAX_IMPORT_ENTRIES} entries per import.`);
  }

  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    const entryName = entry.entryName.replace(/\\/g, "/");
    if (!entryName || entryName.startsWith("/") || /^[a-zA-Z]:\//.test(entryName)) {
      throw new Error("ZIP contains an unsafe absolute path.");
    }
    if (entryName.split("/").filter(Boolean).length > 40) {
      throw new Error("ZIP folder nesting is too deep.");
    }

    const target = path.resolve(extractRoot, entryName);
    assertInsideDirectory(extractRoot, target);

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    const data = entry.getData();
    if (data.length > MAX_IMPORT_FILE_BYTES) {
      throw new Error(`ZIP contains a file larger than ${Math.round(MAX_IMPORT_FILE_BYTES / 1024 / 1024)} MB.`);
    }
    totalUncompressedBytes += data.length;
    if (totalUncompressedBytes > MAX_IMPORT_UNCOMPRESSED_BYTES) {
      throw new Error(`ZIP expands beyond LocalLeaf's ${Math.round(MAX_IMPORT_UNCOMPRESSED_BYTES / 1024 / 1024)} MB import limit.`);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

function importZipProject(zipBuffer, filename) {
  const importsRoot = path.join(getUserProjectsDir(), "Imported");
  const projectRoot = uniqueDirectory(importsRoot, sanitizeProjectName(filename || "Imported Project"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-zip-"));
  const extractRoot = path.join(tempRoot, "extract");
  fs.mkdirSync(extractRoot, { recursive: true });

  try {
    extractZipBuffer(zipBuffer, extractRoot);
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(error.message || "Could not extract ZIP project.");
  }

  const extractedProject = chooseExtractedProjectRoot(extractRoot);
  copyDirectory(extractedProject, projectRoot);
  fs.rmSync(tempRoot, { recursive: true, force: true });

  const mainFile = detectMainFile(projectRoot);
  if (!mainFile) {
    throw new Error("ZIP imported, but no .tex files were found.");
  }

  return projectRoot;
}

function importLooseFilesProject(fileRecords, projectName) {
  if (!Array.isArray(fileRecords) || fileRecords.length === 0) {
    throw new Error("Choose at least one file to import.");
  }
  if (fileRecords.length > MAX_IMPORT_ENTRIES) {
    throw new Error(`LocalLeaf supports up to ${MAX_IMPORT_ENTRIES} files per import.`);
  }

  const importsRoot = path.join(getUserProjectsDir(), "Imported");
  const firstName = fileRecords.find((file) => file?.path || file?.name)?.path || fileRecords[0]?.name || "Imported Files";
  const projectRoot = uniqueDirectory(importsRoot, sanitizeProjectName(projectName || firstName || "Imported Files"));
  fs.mkdirSync(projectRoot, { recursive: true });

  const seenPaths = new Set();
  let totalBytes = 0;

  try {
    for (const record of fileRecords) {
      const relativePath = normalizeRelativePath(record?.path || record?.name || "");
      if (!relativePath || relativePath.endsWith("/")) {
        throw new Error("Imported files must include a file name.");
      }
      if (relativePath.split("/").filter(Boolean).length > 40) {
        throw new Error("Imported file folder nesting is too deep.");
      }
      const key = relativePath.toLowerCase();
      if (seenPaths.has(key)) {
        throw new Error(`Duplicate import path: ${relativePath}`);
      }
      seenPaths.add(key);

      const contentBase64 = String(record?.contentBase64 || "");
      const data = Buffer.from(contentBase64, "base64");
      if (data.length > MAX_IMPORT_FILE_BYTES) {
        throw new Error(`Imported file ${relativePath} is larger than ${Math.round(MAX_IMPORT_FILE_BYTES / 1024 / 1024)} MB.`);
      }
      totalBytes += data.length;
      if (totalBytes > MAX_IMPORT_UNCOMPRESSED_BYTES) {
        throw new Error(`Imported files exceed LocalLeaf's ${Math.round(MAX_IMPORT_UNCOMPRESSED_BYTES / 1024 / 1024)} MB import limit.`);
      }

      const target = path.resolve(projectRoot, relativePath);
      assertInsideDirectory(projectRoot, target);
      if (!isTextFile(target) && !isImageFile(target)) {
        throw new Error(`Unsupported import file type: ${relativePath}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }

    const mainFile = detectMainFile(projectRoot);
    if (!mainFile) {
      throw new Error("Imported files must include at least one .tex file.");
    }
  } catch (error) {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    throw error;
  }

  return projectRoot;
}

function createNewTemplateProject(options = {}) {
  const projectName = validateNewProjectName(options.projectName);
  const destination = resolveNewProjectDestination(options.destinationDirectory);
  const projectRoot = reserveUniqueDirectory(destination, projectName);
  try {
    copyDirectory(SAMPLE_PROJECT, projectRoot);
    const mainFile = detectMainFile(projectRoot);
    if (!mainFile) {
      throw new Error("Starter template is missing a .tex file.");
    }
    return projectRoot;
  } catch (error) {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    throw error;
  }
}

function safeDownloadName(name, extension) {
  const base = sanitizeProjectName(name || "LocalLeaf Project")
    .replace(/\s+/g, "_")
    .replace(/\.+$/g, "");
  return `${base || "LocalLeaf_Project"}${extension}`;
}

function contentDisposition(disposition, filename) {
  const cleanName = String(filename || "LocalLeaf_Project")
    .replace(/[\\/"\r\n]/g, "_")
    .slice(0, 180);
  return `${disposition}; filename="${cleanName}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`;
}

function attachmentHeaders(filename, contentType) {
  return {
    ...securityHeaders(),
    "content-type": contentType,
    "content-disposition": contentDisposition("attachment", filename),
    "cache-control": "no-store"
  };
}

function streamFileResponse(request, response, filePath, contentType, extraHeaders = {}, lifecycle = {}) {
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    lifecycle.onComplete?.();
  };
  let size;
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error("Requested path is not a file.");
    size = stats.size;
  } catch {
    textResponse(response, 404, "The requested file is no longer available.");
    complete();
    return false;
  }
  const commonHeaders = {
    ...securityHeaders(),
    "content-type": contentType,
    "cache-control": "no-store",
    "accept-ranges": "bytes",
    ...extraHeaders
  };
  const range = request.headers.range;

  if (!range) {
    response.writeHead(200, {
      ...commonHeaders,
      "content-length": size
    });
    const stream = fs.createReadStream(filePath);
    stream.once("error", () => {
      if (!response.headersSent) {
        textResponse(response, 404, "The requested file is no longer available.");
      } else {
        response.destroy();
      }
    });
    stream.once("close", complete);
    response.once("close", () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(response);
    return true;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
  let start;
  let end;
  if (match) {
    if (match[1] === "" && match[2] !== "") {
      const suffixLength = Number(match[2]);
      start = Math.max(size - suffixLength, 0);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === "" ? size - 1 : Number(match[2]);
    }
  }

  if (
    !match ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    response.writeHead(416, {
      ...commonHeaders,
      "content-range": `bytes */${size}`
    });
    response.end();
    complete();
    return true;
  }

  end = Math.min(end, size - 1);
  response.writeHead(206, {
    ...commonHeaders,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`
  });
  const stream = fs.createReadStream(filePath, { start, end });
  stream.once("error", () => {
    if (!response.headersSent) {
      textResponse(response, 404, "The requested file is no longer available.");
    } else {
      response.destroy();
    }
  });
  stream.once("close", complete);
  response.once("close", () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(response);
  return true;
}

function addDirectoryToZip(zip, directory, baseDirectory = directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(directory, entry.name);
    const relativePath = path.relative(baseDirectory, fullPath).replace(/\\/g, "/");

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      addDirectoryToZip(zip, fullPath, baseDirectory);
    } else if (entry.isFile()) {
      zip.addFile(relativePath, fs.readFileSync(fullPath));
    }
  }
}

function createProjectZip(projectRoot, projectName) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-export-"));
  const zipPath = path.join(tempRoot, safeDownloadName(projectName, ".zip"));

  try {
    const zip = new AdmZip();
    addDirectoryToZip(zip, projectRoot);
    zip.writeZip(zipPath);
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(error.message || "Could not create project ZIP.");
  }

  return { tempRoot, zipPath };
}

function createItemZip(projectRoot, relativePath) {
  const fullPath = resolveProjectPath(projectRoot, relativePath);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-item-export-"));
  const zipPath = path.join(tempRoot, safeDownloadName(path.basename(fullPath), ".zip"));

  try {
    const zip = new AdmZip();
    addDirectoryToZip(zip, fullPath, path.dirname(fullPath));
    zip.writeZip(zipPath);
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(error.message || "Could not create folder ZIP.");
  }

  return { tempRoot, zipPath };
}

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".bib": "text/plain; charset=utf-8",
    ".bst": "text/plain; charset=utf-8",
    ".cfg": "text/plain; charset=utf-8",
    ".cls": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".dat": "text/plain; charset=utf-8",
    ".def": "text/plain; charset=utf-8",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".py": "text/x-python; charset=utf-8",
    ".sty": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".tex": "text/x-tex; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp"
  }[ext] || "application/octet-stream";
}

function copyProjectItem(fromPath, toPath) {
  const fromStats = fs.statSync(fromPath);
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  if (fromStats.isDirectory()) {
    fs.cpSync(fromPath, toPath, {
      recursive: true,
      filter(source) {
        try {
          return !fs.lstatSync(source).isSymbolicLink();
        } catch {
          return false;
        }
      }
    });
    return;
  }
  if (!fromStats.isFile()) {
    throw new Error("Only files and folders can be copied.");
  }
  fs.copyFileSync(fromPath, toPath);
}

function normalizeVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[+-]/)[0];
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function preferredReleaseAsset(assets = []) {
  const platform = os.platform();
  const arch = os.arch();
  const candidates = Array.isArray(assets) ? assets : [];
  const findAsset = (matcher) => candidates.find((asset) => matcher(String(asset.name || "").toLowerCase()));
  if (platform === "win32") {
    return findAsset((name) => name.endsWith(".exe")) || findAsset((name) => name.includes("setup"));
  }
  if (platform === "darwin") {
    if (arch === "arm64") {
      return findAsset((name) => name.includes("arm64") && name.endsWith(".dmg"));
    }
    return findAsset((name) => name.includes("x64") && name.endsWith(".dmg")) || findAsset((name) => name.endsWith(".dmg"));
  }
  return findAsset((name) => name.endsWith(".zip")) || candidates[0] || null;
}

function releaseAssetDownloads(assets = []) {
  const candidates = Array.isArray(assets) ? assets : [];
  const findAsset = (matcher) => candidates.find((asset) => matcher(String(asset.name || "").toLowerCase()));
  const windows = findAsset((name) => name === "localleaf-host-setup.exe" || (name.includes("setup") && name.endsWith(".exe")));
  const macArm64 = findAsset((name) => name.includes("mac") && name.includes("arm64") && name.endsWith(".dmg"));
  const macX64 = findAsset((name) => name.includes("mac") && name.includes("x64") && name.endsWith(".dmg"));
  return {
    windows: windows?.browser_download_url || "",
    macArm64: macArm64?.browser_download_url || "",
    macX64: macX64?.browser_download_url || ""
  };
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const request = https.get(
      UPDATE_RELEASE_API,
      {
        timeout: 6500,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `LocalLeaf/${PACKAGE_INFO.version}`
        }
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
          if (data.length > 1_000_000) {
            request.destroy(new Error("Update response was too large."));
          }
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`GitHub returned ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("GitHub returned an unreadable update response."));
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("Update check timed out.")));
    request.on("error", reject);
  });
}

async function getLatestUpdateInfo(releaseFetcher = fetchLatestRelease) {
  const now = Date.now();
  const shouldUseCache = releaseFetcher === fetchLatestRelease;
  if (shouldUseCache && latestReleaseCache && now - latestReleaseCache.checkedAt < UPDATE_CACHE_TTL_MS) {
    return latestReleaseCache.payload;
  }

  const currentVersion = PACKAGE_INFO.version;
  try {
    const release = await releaseFetcher();
    const latestVersion = normalizeVersion(release.tag_name || release.name || "");
    const asset = preferredReleaseAsset(release.assets);
    const downloads = releaseAssetDownloads(release.assets);
    const payload = {
      currentVersion,
      latestVersion,
      updateAvailable: Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: release.html_url || "https://github.com/sethwhenton/localleaf/releases/latest",
      siteUrl: "https://sethwhenton.github.io/localleaf/",
      downloadUrl: asset?.browser_download_url || release.html_url || "https://github.com/sethwhenton/localleaf/releases/latest",
      downloads,
      assetName: asset?.name || "",
      checkedAt: new Date(now).toISOString()
    };
    if (shouldUseCache) latestReleaseCache = { checkedAt: now, payload };
    return payload;
  } catch (error) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      releaseUrl: "https://github.com/sethwhenton/localleaf/releases/latest",
      siteUrl: "https://sethwhenton.github.io/localleaf/",
      downloadUrl: "https://github.com/sethwhenton/localleaf/releases/latest",
      downloads: {},
      error: error.message || "Could not check for updates."
    };
  }
}

function createInitialState(options = {}) {
  const projectRoot = ensureDefaultProjectRoot(options);
  const mainFile = detectMainFile(projectRoot);
  const compiler = detectCompiler();
  const tunnelProviders = options.tunnelProviders || createTunnelProviders();
  const tunnelReady = tunnelProviders.length > 0;
  const autoStartTunnel = options.autoStartTunnel !== false;

  const state = {
    hostToken: options.hostToken || randomId(24),
    port: options.port || DEFAULT_PORT,
    project: {
      id: randomId(6),
      name: path.basename(projectRoot),
      root: projectRoot,
      mainFile,
      files: listProjectFiles(projectRoot),
      size: getProjectSize(projectRoot)
    },
    session: {
      id: randomId(6),
      status: "idle",
      code: null,
      inviteUrl: null,
      publicUrl: null,
      maxGuests: MAX_GUESTS,
      // Compatibility alias for older renderers. The value now means guest slots, not total participants.
      maxUsers: MAX_GUESTS,
      users: [
        {
          id: "host",
          name: getHostName(),
          role: "host",
          color: "#fb6a00",
          online: true
        }
      ],
      joinRequests: [],
      activeTokens: new Map(),
      tunnel: {
        available: tunnelReady,
        status: tunnelReady ? "Ready" : "Not installed",
        detail: tunnelReady
          ? `Tunnel providers ready: ${tunnelProviders.map((provider) => provider.name).join(", ")}`
          : "No tunnel provider was found. Install OpenSSH or bundle a tunnel provider for public invite links.",
        providers: tunnelProviders,
        providerId: null,
        providerName: null,
        preferredProviderId: null,
        selectionMode: "automatic",
        previousLinkInvalidated: false,
        attempts: [],
        autoStart: autoStartTunnel,
        raceId: null,
        runners: new Map(),
        stopTimer: null,
        process: null,
        controller: null
      },
      network: {
        quality: tunnelReady ? "Good" : "Local only",
        score: tunnelReady ? 82 : 58,
        upload: tunnelReady ? "18 Mbps" : "Not measured",
        latency: tunnelReady ? "42 ms" : "Local only",
        recommendation: tunnelReady
          ? "Recommended: up to 5 collaborators"
          : "Local inspection works now. Public links need a tunnel provider."
      }
    },
    compiler,
    compile: {
      status: "idle",
      engine: compiler.engine,
      mode: "html",
      logs: ["[LocalLeaf] Ready."],
      previewHtml: "",
      pdfPath: null,
      synctexPath: null,
      sourceMapAvailable: false,
      version: 0,
      jobId: null,
      queuedJobs: 0,
      isStale: false,
      lastSuccessfulAt: null,
      lastSuccessfulVersion: 0,
      artifactId: null,
      artifactRoot: null,
      sourceSnapshotRoot: null
    },
    compileArtifacts: new Map(),
    projectCreations: new Map(),
    chat: [],
    ai: {
      models: null,
      sessions: null,
      guestSessions: new Map(),
      runControllers: new Map(),
      changes: null,
      proposals: new Map(),
      cursorRunner: options.cursorAgentRunner || runCursorSdkAgent
    },
    clients: new Map(),
    collabClients: new Map(),
    tunnelCheck: options.checkPublicTunnel || checkPublicTunnel
  };
  state.ai.models = createAiModelManager({
    modelRoot: options.modelRoot,
    secretStore: options.aiSecretStore,
    fetchImpl: options.aiFetch || options.fetchImpl,
    downloadImpl: options.aiDownloadImpl,
    totalMemoryBytes: options.aiTotalMemoryBytes,
    onChange: () => broadcastState(state)
  });
  state.ai.sessions = options.aiSessionStore || createAiSessionStore({ root: options.aiSessionRoot });
  state.ai.changes = options.aiChangeStore || createAiChangeStore({ root: options.aiChangeRoot });
  state.synctexResolver = options.synctexResolver || null;
  state.synctexForwardResolver = options.synctexForwardResolver || null;
  state.synctexWorkerClient = options.synctexWorkerClient || createSynctexWorkerClient({
    timeoutMs: SYNCTEX_LOOKUP_TIMEOUT_MS
  });
  state.ownsSynctexWorkerClient = !options.synctexWorkerClient;
  state.synctexCommand = String(options.synctexCommand || "").trim();
  state.synctexProcessRunner = options.synctexProcessRunner || ((processOptions) => runBoundedChildProcess(
    processOptions.command,
    processOptions.args,
    processOptions
  ));
  state.synctexLookups = {
    active: 0,
    maxActive: Math.max(
      1,
      Math.min(16, Number(options.synctexMaxConcurrentLookups) || SYNCTEX_MAX_CONCURRENT_LOOKUPS)
    )
  };
  return state;
}

function publicCompileState(compile = {}) {
  const pdfAvailable = isValidPdfArtifact(compile.pdfPath);
  return {
    status: compile.status,
    engine: compile.engine,
    mode: compile.mode,
    logs: compile.logs || [],
    previewHtml: compile.previewHtml || "",
    pdfPath: pdfAvailable ? "/api/pdf" : null,
    pdfAvailable,
    sourceMapAvailable: Boolean(compile.sourceMapAvailable && compile.synctexPath && fs.existsSync(compile.synctexPath)),
    version: compile.version || 0,
    jobId: compile.jobId || null,
    queuedJobs: Math.max(0, Number(compile.queuedJobs || 0)),
    isStale: Boolean(compile.isStale),
    lastSuccessfulAt: compile.lastSuccessfulAt || null,
    lastSuccessfulVersion: compile.lastSuccessfulVersion || 0,
    artifactId: compile.artifactId || null
  };
}

function guestCompileState(compile = {}) {
  const status = String(compile.status || "idle");
  const summary = status === "running"
    ? "[LocalLeaf] The host is compiling the project."
    : status === "success"
      ? "[LocalLeaf] The host finished compiling the project."
      : status === "failed"
        ? "[LocalLeaf] Compilation failed. Ask the host to review the detailed log."
        : "[LocalLeaf] The host has not compiled the project yet.";
  return {
    ...compile,
    logs: [summary],
    previewHtml: ""
  };
}

function registerCompileArtifact(state, compile = {}) {
  if (!compile.pdfPath || !compile.artifactRoot) return;
  const current = state.compileArtifacts.get(compile.pdfPath);
  state.compileArtifacts.set(compile.pdfPath, {
    pdfPath: compile.pdfPath,
    artifactRoot: compile.artifactRoot,
    readers: current?.readers || 0,
    retired: false
  });
}

function cleanupRetiredCompileArtifact(state, artifact) {
  if (!artifact?.retired || artifact.readers > 0) return;
  state.compileArtifacts.delete(artifact.pdfPath);
  cleanupCompileArtifact(artifact.artifactRoot);
}

function retireCompileArtifact(state, pdfPath) {
  const artifact = state.compileArtifacts.get(pdfPath);
  if (!artifact) return;
  artifact.retired = true;
  cleanupRetiredCompileArtifact(state, artifact);
}

function retainCompileArtifact(state, pdfPath) {
  const artifact = state.compileArtifacts.get(pdfPath);
  if (!artifact || artifact.retired) return () => {};
  artifact.readers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    artifact.readers = Math.max(0, artifact.readers - 1);
    cleanupRetiredCompileArtifact(state, artifact);
  };
}

function cleanupAllCompileArtifacts(state) {
  for (const artifact of state.compileArtifacts.values()) {
    artifact.retired = true;
    cleanupRetiredCompileArtifact(state, artifact);
  }
}

function aiSessionStoreForIdentity(state, identity) {
  if (identity.isHost) return state.ai.sessions;
  if (!identity.userId) return null;
  if (!state.ai.guestSessions.has(identity.userId)) {
    state.ai.guestSessions.set(identity.userId, createMemoryAiSessionStore());
  }
  return state.ai.guestSessions.get(identity.userId);
}

function validateAiSessionMutationProject(state, sessionStore, body = {}, originProjectKey = "") {
  const suppliedProjectKey = String(body?.projectKey || "").trim();
  const currentProjectKey = sessionStore.projectKeyForRoot(state.project.root);
  const requestProjectKey = String(originProjectKey || currentProjectKey);
  if (
    suppliedProjectKey
    && suppliedProjectKey === requestProjectKey
    && suppliedProjectKey === currentProjectKey
  ) return currentProjectKey;

  const error = new Error(suppliedProjectKey
    ? "The active project changed before this AI session action was applied."
    : "The AI session action is missing its originating project.");
  error.code = "AI_SESSION_PROJECT_MISMATCH";
  error.statusCode = 409;
  throw error;
}

function aiChangesForIdentity(state, identity) {
  const changes = (state.ai.changes?.list(state.project) || []).map((change) => ({
    ...change,
    actionable: state.ai.proposals.has(change.id)
  }));
  if (identity.isHost) return changes;
  if (!identity.userId) return [];
  return changes.filter((change) => {
    return change.requester?.userId === identity.userId || ["applied", "reverted"].includes(change.status);
  });
}

function publicGuestAiState(state, identity) {
  const modelState = state.ai.models.publicState();
  const activeModel = modelState.activeModel
    ? {
      providerId: "host-ai",
      providerName: "Host AI",
      modelId: modelState.activeModel.modelId || modelState.activeModel.name || "",
      name: modelState.activeModel.name || modelState.activeModel.modelId || "Host model",
      local: Boolean(modelState.activeModel.local)
    }
    : null;
  const sessionStore = aiSessionStoreForIdentity(state, identity);
  return {
    activeModelId: activeModel?.modelId || null,
    activeProviderId: activeModel ? "host-ai" : null,
    activeModel,
    runtime: modelState.runtime || "deterministic-fallback",
    permissions: {
      canReadTextFiles: true,
      canProposeTextEdits: true,
      canWriteWithoutApproval: false,
      canDeleteRenameMoveUploadShell: false,
      textFilesOnly: true
    },
    sessions: sessionStore ? sessionStore.summaryState(state.project) : null,
    proposals: aiChangesForIdentity(state, identity),
    models: [],
    providerTemplates: [],
    providers: [],
    modelChoices: []
  };
}

function publicAiState(state, identity) {
  if (identity.isHost) {
    return {
      ...state.ai.models.publicState(),
      sessions: state.ai.sessions.summaryState(state.project),
      proposals: aiChangesForIdentity(state, identity)
    };
  }
  if (identity.canEdit) return publicGuestAiState(state, identity);
  return {
    activeModelId: null,
    runtime: "host-only",
    permissions: {
      canReadTextFiles: false,
      canProposeTextEdits: false,
      canWriteWithoutApproval: false,
      canDeleteRenameMoveUploadShell: false,
      textFilesOnly: true
    },
    sessions: null,
    proposals: [],
    models: []
  };
}

function publicState(state, options = {}) {
  const isHost = Boolean(options.isHost);
  const identity = options.identity || {
    isHost,
    user: options.user || null,
    userId: options.user?.id || (isHost ? "host" : ""),
    userName: options.user?.name || (isHost ? getHostName() : ""),
    role: options.user?.role || (isHost ? "host" : ""),
    canRead: Boolean(options.canRead || isHost),
    canEdit: Boolean(options.canEdit || isHost || options.user?.role === "maintainer")
  };
  const canRead = isHost || Boolean(options.canRead);

  if (!canRead) {
    return {
      project: { name: "LocalLeaf project" },
      session: {
        status: state.session.status,
        maxGuests: sessionGuestLimit(state),
        maxUsers: sessionGuestLimit(state)
      },
      compiler: {
        available: Boolean(state.compiler.available),
        engine: state.compiler.engine || ""
      },
      compile: {
        status: "idle",
        mode: "html",
        version: state.compile.version || 0
      },
      ai: {},
      chat: []
    };
  }

  const users = state.session.users.map((user) => ({
    id: user.id,
    name: user.name,
    role: user.role,
    color: user.color,
    online: user.online
  }));
  const joinRequests = isHost
    ? state.session.joinRequests.map((request) => ({
        id: request.id,
        name: request.name,
        role: request.role,
        status: request.status,
        createdAt: request.createdAt,
        userId: request.userId
      }))
    : [];

  return {
    ...(isHost ? { port: state.port } : {}),
    project: {
      id: state.project.id,
      name: state.project.name,
      root: isHost ? state.project.root : "Stored on host computer",
      ...(isHost ? { defaultProjectsDirectory: path.resolve(getUserProjectsDir()) } : {}),
      mainFile: canRead ? state.project.mainFile : "",
      files: canRead ? state.project.files : [],
      size: canRead ? state.project.size : 0,
      sizeLabel: canRead ? formatBytes(state.project.size) : "Hidden until approved"
    },
    session: {
      id: state.session.id,
      status: state.session.status,
      maxGuests: sessionGuestLimit(state),
      maxUsers: sessionGuestLimit(state),
      users,
      joinRequests,
      ...(isHost ? {
        code: state.session.code,
        inviteUrl: state.session.inviteUrl,
        publicUrl: state.session.publicUrl,
        network: state.session.network
      } : {}),
      tunnel: {
        available: state.session.tunnel.available,
        status: state.session.tunnel.status,
        detail: state.session.tunnel.detail,
        autoStart: state.session.tunnel.autoStart,
        providerId: state.session.tunnel.providerId,
        providerName: state.session.tunnel.providerName,
        ...(isHost ? {
          preferredProviderId: state.session.tunnel.preferredProviderId || null,
          selectionMode: state.session.tunnel.selectionMode || "automatic",
          previousLinkInvalidated: Boolean(state.session.tunnel.previousLinkInvalidated),
          providers: (state.session.tunnel.providers || []).map((provider) => ({
            id: provider.id,
            name: provider.name,
            hint: provider.hint
          })),
          attempts: state.session.tunnel.attempts || []
        } : {})
      }
    },
    compiler: isHost
      ? state.compiler
      : {
          available: Boolean(state.compiler.available),
          engine: state.compiler.engine || ""
        },
    compile: isHost
      ? publicCompileState(state.compile)
      : guestCompileState(publicCompileState(state.compile)),
    ai: publicAiState(state, identity),
    chat: state.chat
  };
}

function sendSse(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function deleteSseClient(state, id, client = state.clients.get(id)) {
  if (client?.heartbeat) clearInterval(client.heartbeat);
  if (state.clients.get(id) === client) state.clients.delete(id);
}

function broadcast(state, event, payload) {
  for (const [id, client] of state.clients) {
    try {
      sendSse(client.response, event, payload);
    } catch {
      deleteSseClient(state, id, client);
    }
  }
}

function clientCanReadProject(state, client) {
  return client.isHost || (state.session.status === "live" && Boolean(client.token && state.session.activeTokens.has(client.token)));
}

function tokenUserByToken(state, token) {
  if (state.session.status !== "live") return null;
  const userId = token ? state.session.activeTokens.get(String(token)) : null;
  return userId ? state.session.users.find((user) => user.id === userId) : null;
}

function clientCanEditProject(state, client) {
  if (client.isHost) return true;
  return tokenUserByToken(state, client.token)?.role === "maintainer";
}

function websocketIdentity(state, request, url) {
  const isHost = isHostRequest(state, request, url);
  const token = String(url.searchParams.get("token") || "");
  const tokenUser = tokenUserByToken(state, token);
  if (isHost) {
    const hostUser = state.session.users.find((user) => user.id === "host") || {
      id: "host",
      name: getHostName(),
      role: "host"
    };
    return {
      isHost: true,
      token: "",
      userId: hostUser.id,
      name: hostUser.name,
      role: "host",
      canRead: true,
      canEdit: true
    };
  }
  if (tokenUser) {
    return {
      isHost: false,
      token,
      userId: tokenUser.id,
      name: tokenUser.name,
      role: tokenUser.role,
      canRead: true,
      canEdit: tokenUser.role === "maintainer"
    };
  }
  return {
    isHost: false,
    token,
    userId: "",
    name: "",
    role: "",
    canRead: false,
    canEdit: false
  };
}

function broadcastProject(state, event, payload) {
  for (const [id, client] of state.clients) {
    if (!clientCanReadProject(state, client)) continue;
    try {
      sendSse(client.response, event, event === "compile" && !client.isHost ? guestCompileState(payload) : payload);
    } catch {
      deleteSseClient(state, id, client);
    }
  }
  if (event === "compile") {
    for (const client of state.collabClients.values()) {
      sendWs(client, {
        type: "project_event",
        event,
        payload: client.isHost ? payload : guestCompileState(payload)
      });
    }
  } else if (event === "chat") {
    broadcastCollab(state, { type: "project_event", event, payload });
  }
}

function broadcastHosts(state, event, payload) {
  for (const [id, client] of state.clients) {
    if (!client.isHost) continue;
    try {
      sendSse(client.response, event, payload);
    } catch {
      deleteSseClient(state, id, client);
    }
  }
}

function sendWs(client, payload) {
  if (client.socket.readyState !== 1) return;
  client.socket.send(JSON.stringify(payload));
}

function broadcastCollab(state, payload, options = {}) {
  for (const client of state.collabClients.values()) {
    if (options.excludeClientId && client.id === options.excludeClientId) continue;
    sendWs(client, payload);
  }
}

function collabPresence(state) {
  return [...state.collabClients.values()]
    .filter((client) => client.filePath)
    .map((client) => ({
      clientId: client.id,
      userId: client.userId,
      name: client.name,
      role: client.role,
      filePath: client.filePath
    }));
}

function broadcastPresence(state, client) {
  broadcastCollab(state, {
    type: "presence_update",
    userId: client.userId,
    name: client.name,
    role: client.role,
    filePath: client.filePath || "",
    presence: collabPresence(state)
  });
}

function defaultCollabFile(state) {
  const openFile = [...state.collabClients.values()].find((client) => client.filePath)?.filePath;
  if (openFile) return openFile;
  return state.project.mainFile || state.project.files.find((file) => file.type === "text")?.path || "";
}

function readTextFileForCollab(state, filePath) {
  const fullPath = resolveProjectPath(state.project.root, filePath);
  if (!fs.existsSync(fullPath) || !isTextFile(fullPath)) {
    throw new Error("Only text project files can be shared in the live editor.");
  }
  return fs.readFileSync(fullPath, "utf8");
}

function writeTextFileForCollab(state, filePath, content) {
  const fullPath = resolveProjectPath(state.project.root, filePath);
  if (!fs.existsSync(fullPath) || !isTextFile(fullPath)) {
    throw new Error("Only text project files can be edited in the live editor.");
  }
  fs.writeFileSync(fullPath, String(content || ""), "utf8");
}

function attachCollabClient(state, socket, identity) {
  const client = {
    id: randomId(8),
    socket,
    isHost: identity.isHost,
    token: identity.token,
    userId: identity.userId,
    name: identity.name,
    role: identity.role,
    canEdit: identity.canEdit,
    filePath: ""
  };
  state.collabClients.set(client.id, client);
  const connectedUser = state.session.users.find((user) => user.id === client.userId);
  if (connectedUser) connectedUser.online = true;

  const filePath = defaultCollabFile(state);
  let content = "";
  if (filePath) {
    try {
      content = readTextFileForCollab(state, filePath);
    } catch {
      content = "";
    }
  }

  sendWs(client, {
    type: "sync_state",
    clientId: client.id,
    userId: client.userId,
    filePath,
    newText: content,
    state: publicState(state, {
      isHost: client.isHost,
      canRead: true,
      canEdit: client.canEdit,
      user: {
        id: client.userId,
        name: client.name,
        role: client.role
      }
    }),
    presence: collabPresence(state)
  });
  broadcastState(state);

  socket.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      sendWs(client, { type: "error", message: "Invalid collaboration message." });
      return;
    }
    handleCollabMessage(state, client, payload);
  });

  socket.on("close", () => {
    state.collabClients.delete(client.id);
    const stillConnected = [...state.collabClients.values()].some((item) => item.userId === client.userId);
    const disconnectedUser = state.session.users.find((user) => user.id === client.userId);
    if (disconnectedUser && disconnectedUser.role !== "host" && !stillConnected) {
      disconnectedUser.online = false;
      broadcastState(state);
    }
    broadcastPresence(state, client);
  });
}

function handleCollabMessage(state, client, payload) {
  const type = String(payload.type || "");
  if (type === "heartbeat") {
    sendWs(client, { type: "heartbeat" });
    return;
  }

  if (state.session.status === "ended") {
    if (!client.isHost) {
      sendWs(client, { type: "session_ended", reason: "Host stopped the session." });
    }
    client.socket.close();
    return;
  }

  if (!clientCanReadProject(state, client)) {
    client.canEdit = false;
    client.token = "";
    client.socket.close(4003, "Access revoked");
    return;
  }

  if (type === "open_file") {
    const filePath = String(payload.filePath || "").trim();
    try {
      const content = readTextFileForCollab(state, filePath);
      client.filePath = filePath;
      sendWs(client, { type: "file_opened", filePath, newText: content });
      broadcastPresence(state, client);
    } catch (error) {
      sendWs(client, { type: "error", message: error.message });
    }
    return;
  }

  if (type === "edit") {
    if (!clientCanEditProject(state, client)) {
      client.canEdit = false;
      sendWs(client, { type: "error", message: "Maintainer access is required before changing files." });
      return;
    }
    const filePath = String(payload.filePath || "").trim();
    const newText = String(payload.newText ?? "");
    try {
      writeTextFileForCollab(state, filePath, newText);
      client.filePath = filePath;
      const version = Date.now();
      broadcastCollab(
        state,
        {
          type: "file_updated",
          filePath,
          newText,
          userId: client.userId,
          name: client.name,
          version
        },
        { excludeClientId: client.id }
      );
      broadcastProject(state, "file-update", {
        path: filePath,
        content: newText,
        user: client.name,
        version
      });
      broadcastPresence(state, client);
    } catch (error) {
      sendWs(client, { type: "error", message: error.message });
    }
    return;
  }

  if (type === "save") {
    const requestId = String(payload.requestId || "").slice(0, 128);
    if (!clientCanEditProject(state, client)) {
      client.canEdit = false;
      sendWs(client, { type: "error", requestId, message: "Maintainer access is required before saving files." });
      return;
    }
    const filePath = String(payload.filePath || "").trim();
    try {
      const currentText = readTextFileForCollab(state, filePath);
      const hasNewText = Object.prototype.hasOwnProperty.call(payload, "newText");
      const newText = hasNewText ? String(payload.newText ?? "") : currentText;
      const version = Date.now();
      if (newText !== currentText) {
        writeTextFileForCollab(state, filePath, newText);
        client.filePath = filePath;
        broadcastCollab(
          state,
          {
            type: "file_updated",
            filePath,
            newText,
            userId: client.userId,
            name: client.name,
            version
          },
          { excludeClientId: client.id }
        );
        broadcastProject(state, "file-update", {
          path: filePath,
          content: newText,
          user: client.name,
          version
        });
        broadcastPresence(state, client);
      }
      broadcastCollab(state, {
        type: "file_saved",
        filePath,
        userId: client.userId,
        name: client.name,
        requestId,
        version
      });
    } catch (error) {
      sendWs(client, { type: "error", requestId, message: error.message });
    }
    return;
  }

  sendWs(client, { type: "error", message: `Unknown collaboration event: ${type}` });
}

function closeCollabClients(state, reason) {
  broadcastCollab(state, { type: "session_ended", reason });
  for (const client of state.collabClients.values()) {
    client.socket.close();
  }
  state.collabClients.clear();
}

function broadcastState(state) {
  for (const [id, client] of state.clients) {
    const user = client.isHost ? state.session.users.find((item) => item.id === "host") : tokenUserByToken(state, client.token);
    try {
      sendSse(
        client.response,
        "state",
        publicState(state, {
          isHost: client.isHost,
          canRead: clientCanReadProject(state, client),
          canEdit: client.isHost || user?.role === "maintainer",
          user
        })
      );
    } catch {
      deleteSseClient(state, id, client);
    }
  }
  for (const client of state.collabClients.values()) {
    const user = client.isHost
      ? state.session.users.find((item) => item.id === "host")
      : tokenUserByToken(state, client.token);
    sendWs(client, {
      type: "state_update",
      state: publicState(state, {
        isHost: client.isHost,
        canRead: client.isHost || Boolean(client.token && state.session.activeTokens.has(client.token)),
        canEdit: client.isHost || user?.role === "maintainer",
        user
      })
    });
  }
}

function refreshProject(state) {
  state.project.files = listProjectFiles(state.project.root);
  state.project.size = getProjectSize(state.project.root);
  if (!state.project.mainFile) {
    state.project.mainFile = detectMainFile(state.project.root);
  }
}

function textHash(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function firstChangedRange(before, after) {
  const oldText = String(before || "");
  const newText = String(after || "");
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start += 1;
  }
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return {
    start,
    oldEnd,
    newEnd,
    line: newText.slice(0, start).split(/\r?\n/u).length
  };
}

function inferAgentPath(state, requestedPath) {
  const candidate = String(requestedPath || state.project.mainFile || "").trim();
  const fullPath = resolveProjectPath(state.project.root, candidate);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error("Choose an existing text file before asking LocalLeaf AI for edits.");
  }
  if (!isTextFile(fullPath)) {
    throw new Error("LocalLeaf AI can only propose edits to text files.");
  }
  return { relativePath: normalizeRelativePath(candidate), fullPath };
}

const DETERMINISTIC_REWRITE_GUIDANCE = "I couldn't prepare a safe deterministic rewrite. Select the exact text you want changed, or give an exact replacement such as “change from … to …”.";

function rewriteSelectedProse(selectedText) {
  const source = String(selectedText || "");
  if (!source || /\\(?:begin\{(?:verbatim|lstlisting|minted)\}|verb\*?\b)/iu.test(source)) return source;
  const protectedLatex = /(?:``[^]*?''|“[^]*?”|"(?:\\.|[^"\\])*"|\\[A-Za-z@]+\*?(?:\s*\[[^\]\r\n]*\])?(?:\s*\{(?:[^{}]|\{[^{}]*\})*\})*|\\\([^]*?\\\)|\\\[[^]*?\\\]|\$\$?[^]*?\$\$?)/gu;
  let cursor = 0;
  let rewritten = "";
  for (const match of source.matchAll(protectedLatex)) {
    rewritten += source
      .slice(cursor, match.index)
      .replace(/\butilize\b/giu, "use")
      .replace(/\bin order to\b/giu, "to");
    rewritten += match[0];
    cursor = match.index + match[0].length;
  }
  return rewritten + source
    .slice(cursor)
    .replace(/\butilize\b/giu, "use")
    .replace(/\bin order to\b/giu, "to");
}

function deterministicSelectedRewrite(originalText, selectedText) {
  const selection = String(selectedText || "");
  if (!selection) return null;
  const start = originalText.indexOf(selection);
  if (start < 0 || originalText.indexOf(selection, start + selection.length) >= 0) return null;
  const replacement = rewriteSelectedProse(selection);
  if (replacement === selection) return null;
  return `${originalText.slice(0, start)}${replacement}${originalText.slice(start + selection.length)}`;
}

function createDeterministicAgentProposal(state, body) {
  const message = String(body.message || "").trim().slice(0, 2000);
  if (!message) throw new Error("Message is required.");

  const sourceSnapshot = body._sourceSnapshot instanceof Map ? body._sourceSnapshot : null;
  let sourceFile = sourceSnapshot
    ? agentReadProjectFileFromSnapshot(state, body.path, sourceSnapshot)
    : agentReadProjectFile(state, body.path);
  let relativePath = sourceFile.path;
  let fullPath = resolveProjectPath(state.project.root, relativePath);
  let originalText = sourceFile.content;
  const lowerMessage = message.toLowerCase();
  let newText = originalText;
  let summary = "Prepared a safe text edit proposal.";
  const replacementInstruction = exactReplacementInstruction(message);
  const annotationReplacement = createAnnotationReplacementProposal(state, { ...body, message }, replacementInstruction, {
    provider: null,
    modelId: "deterministic-fallback",
    runId: body.runId || "",
    sessionId: body.sessionId || "",
    requester: body.requester || null,
    skipChangeLog: body.skipChangeLog === true,
    sourceSnapshot
  });
  if (annotationReplacement) {
    annotationReplacement.modelId = "deterministic-fallback";
    return annotationReplacement;
  }
  if (replacementInstruction && !originalText.includes(replacementInstruction.find)) {
    const found = findTextFileContaining(state, replacementInstruction.find, message, sourceSnapshot);
    if (found) {
      relativePath = found.path;
      fullPath = found.fullPath;
      originalText = found.content;
      newText = originalText;
    }
  }

  if (replacementInstruction && originalText.includes(replacementInstruction.find)) {
    newText = originalText.replace(replacementInstruction.find, replacementInstruction.replace);
    summary = `Replace "${replacementInstruction.find}" with "${replacementInstruction.replace}".`;
  } else if (lowerMessage.includes("table")) {
    const table = [
      "\\begin{table}[h]",
      "\\centering",
      "\\begin{tabular}{ll}",
      "\\hline",
      "Item & Notes \\\\",
      "\\hline",
      "Example & Replace with your data \\\\",
      "\\hline",
      "\\end{tabular}",
      "\\caption{Generated table draft}",
      "\\end{table}"
    ].join("\n");
    newText = `${originalText.replace(/\s*$/u, "")}\n\n${table}\n`;
    summary = "Append a small LaTeX table draft.";
  } else if (lowerMessage.includes("rewrite")) {
    newText = deterministicSelectedRewrite(originalText, body.selectedText);
    if (!newText) return null;
    summary = "Rewrite common verbose phrases without changing project structure.";
  } else if (lowerMessage.includes("fix")) {
    newText = originalText
      .replace(/[ \t]+$/gm, "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n");
    if (newText === originalText) {
      newText = `${originalText.replace(/\s*$/u, "")}\n`;
    }
    summary = "Fix whitespace and line ending issues.";
  } else {
    newText = `${originalText.replace(/\s*$/u, "")}\n\n% LocalLeaf AI note: ${message.replace(/\s+/g, " ").slice(0, 160)}\n`;
    summary = "Add a comment note for the requested edit.";
  }

  const proposal = createAiProposalRecord({
    project: state.project,
    path: relativePath,
    originalText,
    newText,
    summary,
    userRequest: message,
    provider: null,
    modelId: "deterministic-fallback",
    runId: body.runId || "",
    sessionId: body.sessionId || "",
    requester: body.requester || null,
    skipChangeLog: body.skipChangeLog === true
  });
  state.ai.proposals.set(proposal.id, proposal);
  if (!proposal.skipChangeLog) recordAiProposalChange(state, proposal);
  return proposal;
}

function createAgentProposalFromText(state, body, newText, summary, metadata = {}) {
  const sourceFile = metadata.sourceSnapshot instanceof Map
    ? agentReadProjectFileFromSnapshot(state, body.path, metadata.sourceSnapshot)
    : agentReadProjectFile(state, body.path);
  const relativePath = sourceFile.path;
  const originalText = Object.prototype.hasOwnProperty.call(metadata, "originalText")
    ? String(metadata.originalText || "")
    : sourceFile.content;
  const cleanText = String(newText || "");
  if (!cleanText) throw new Error("AI provider did not return replacement text.");
  if (cleanText === originalText) throw new Error("AI provider returned the original file without changes.");

  const proposal = createAiProposalRecord({
    project: state.project,
    operation: "edit",
    path: relativePath,
    originalText,
    newText: cleanText,
    summary: boundedPlainText(summary || "AI provider proposed a text edit.") || "AI provider proposed a text edit.",
    userRequest: String(body.message || "").trim().slice(0, 2000),
    provider: metadata.provider || null,
    modelId: metadata.modelId || "",
    runId: metadata.runId || body.runId || "",
    sessionId: body.sessionId || metadata.sessionId || "",
    requester: body.requester || metadata.requester || null,
    skipChangeLog: body.skipChangeLog === true || metadata.skipChangeLog === true
  });
  if (metadata.deferRegistration !== true) registerAiProposal(state, proposal);
  return proposal;
}

function registerAiProposal(state, proposal) {
  state.ai.proposals.set(proposal.id, proposal);
  if (!proposal.skipChangeLog) recordAiProposalChange(state, proposal);
  const proposalBytes = (item) => Buffer.byteLength(String(item?.originalText || ""), "utf8")
    + Buffer.byteLength(String(item?.newText || ""), "utf8");
  const totalBytes = () => Array.from(state.ai.proposals.values())
    .reduce((total, item) => total + proposalBytes(item), 0);
  while (
    state.ai.proposals.size > MAX_IN_MEMORY_AI_PROPOSALS
    || totalBytes() > MAX_IN_MEMORY_AI_PROPOSAL_BYTES
  ) {
    const candidates = Array.from(state.ai.proposals.values()).filter((item) => item.id !== proposal.id);
    const removable = candidates.find((item) => item.status !== "proposed") || candidates[0];
    if (!removable) break;
    state.ai.proposals.delete(removable.id);
  }
  return proposal;
}

function validateAiCreatedFile(state, requestedPath, content) {
  const rawPath = String(requestedPath || "").trim();
  const slashPath = rawPath.replace(/\\/gu, "/");
  if (/^(?:\/|[A-Za-z]:\/)/u.test(slashPath) || path.isAbsolute(rawPath)) {
    throw new Error("AI-created files must use a project-relative path.");
  }
  const relativePath = normalizeRelativePath(rawPath);
  const pathParts = relativePath.split("/");
  if (
    relativePath.length > 512
    || pathParts.some((part) => !part || part.length > 128 || part.startsWith(".") || part.toLowerCase() === "node_modules")
  ) {
    throw new Error("Choose a visible project-relative path with ordinary folder and file names.");
  }
  const extension = path.extname(relativePath).toLowerCase();
  if (!AI_CREATABLE_TEXT_EXTENSIONS.has(extension)) {
    throw new Error("LocalLeaf AI can only create text-based LaTeX source and support files.");
  }
  const cleanText = String(content ?? "");
  if (cleanText.includes("\0")) {
    throw new Error("AI-created text files cannot contain null bytes.");
  }
  if (Buffer.byteLength(cleanText, "utf8") > MAX_AI_CREATED_FILE_BYTES) {
    throw new Error(`AI-created files must be ${Math.round(MAX_AI_CREATED_FILE_BYTES / 1024)} KB or smaller.`);
  }
  const fullPath = resolveProjectPath(state.project.root, relativePath);
  return { relativePath, fullPath, cleanText };
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  const leftInode = String(left.ino ?? "0");
  const rightInode = String(right.ino ?? "0");
  return leftInode !== "0" && leftInode === rightInode && String(left.dev ?? "") === String(right.dev ?? "");
}

function writeNewTextFileExclusive(fullPath, content) {
  const buffer = Buffer.from(String(content ?? ""), "utf8");
  let descriptor = null;
  let openedStats = null;
  try {
    descriptor = fs.openSync(fullPath, "wx");
    openedStats = fs.fstatSync(descriptor);
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (written < 1) throw new Error("LocalLeaf could not finish writing the new file.");
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Cleanup below is guarded by the opened file identity.
      }
      descriptor = null;
    }
    if (openedStats) {
      try {
        const currentStats = fs.lstatSync(fullPath);
        if (sameFileIdentity(openedStats, currentStats)) fs.unlinkSync(fullPath);
      } catch {
        // Preserve the original write error; never remove an unverified replacement.
      }
    }
    throw error;
  }
}

function createAgentFileProposal(state, body, requestedPath, content, summary, metadata = {}) {
  const { relativePath, fullPath, cleanText } = validateAiCreatedFile(state, requestedPath, content);
  if (fs.existsSync(fullPath)) {
    throw new Error("LocalLeaf AI cannot create this file because that path already exists.");
  }
  const proposal = createAiProposalRecord({
    project: state.project,
    operation: "create",
    path: relativePath,
    originalText: "",
    newText: cleanText,
    summary: boundedPlainText(summary || `Create ${relativePath}.`) || `Create ${relativePath}.`,
    userRequest: String(body.message || "").trim().slice(0, 2000),
    provider: metadata.provider || null,
    modelId: metadata.modelId || "",
    runId: metadata.runId || body.runId || "",
    sessionId: body.sessionId || metadata.sessionId || "",
    requester: body.requester || metadata.requester || null,
    skipChangeLog: body.skipChangeLog === true || metadata.skipChangeLog === true
  });
  proposal.approvalRequired = true;
  if (metadata.deferRegistration !== true) registerAiProposal(state, proposal);
  return proposal;
}

function createAiProposalRecord({ project, operation = "edit", path: relativePath, originalText, newText, summary, userRequest, provider, modelId, runId, sessionId, requester, skipChangeLog }) {
  const cleanOriginal = String(originalText || "");
  const cleanText = String(newText || "");
  const focus = firstChangedRange(cleanOriginal, cleanText);
  const projectRoot = path.resolve(String(project?.root || ""));
  return {
    id: randomId(8),
    runId: String(runId || ""),
    sessionId: String(sessionId || ""),
    projectKey: projectKeyForRoot(projectRoot),
    projectRoot,
    projectName: String(project?.name || path.basename(projectRoot) || "LocalLeaf Project").slice(0, 260),
    operation: operation === "create" ? "create" : "edit",
    path: relativePath,
    baseHash: textHash(cleanOriginal),
    newHash: textHash(cleanText),
    originalText: cleanOriginal,
    replacements: [
      {
        start: 0,
        end: cleanOriginal.length,
        text: cleanText
      }
    ],
    newText: cleanText,
    status: "proposed",
    approvalRequired: true,
    skipChangeLog: skipChangeLog === true,
    summary: boundedPlainText(summary || "AI proposed a text edit.") || "AI proposed a text edit.",
    userRequest: String(userRequest || "").slice(0, 2000),
    provider: provider ? {
      id: provider.id || "",
      name: provider.name || provider.id || "Provider"
    } : null,
    modelId: String(modelId || ""),
    requester: requester ? requesterFromIdentity(requester) : null,
    focus: {
      start: focus.start,
      end: Math.max(focus.start, focus.newEnd),
      line: focus.line
    },
    createdAt: Date.now()
  };
}

function compactLineDiff(before, after, context = 3) {
  const beforeLines = String(before || "").split(/\r?\n/u);
  const afterLines = String(after || "").split(/\r?\n/u);
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start += 1;
  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (beforeEnd >= start && afterEnd >= start && beforeLines[beforeEnd] === afterLines[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  if (start > beforeEnd && start > afterEnd) return [];
  const beforeFrom = Math.max(0, start - context);
  const afterFrom = Math.max(0, start - context);
  const beforeTo = Math.min(beforeLines.length - 1, beforeEnd + context);
  const afterTo = Math.min(afterLines.length - 1, afterEnd + context);
  const lines = [];
  for (let index = beforeFrom; index <= beforeTo; index += 1) {
    if (index < start || index > beforeEnd) lines.push({ type: "context", lineNumber: index + 1, text: beforeLines[index] || "" });
    else lines.push({ type: "removed", lineNumber: index + 1, text: beforeLines[index] || "" });
  }
  for (let index = afterFrom; index <= afterTo; index += 1) {
    if (index >= start && index <= afterEnd) lines.push({ type: "added", lineNumber: index + 1, text: afterLines[index] || "" });
  }
  return [{
    oldStart: beforeFrom + 1,
    newStart: afterFrom + 1,
    lines
  }];
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function wantsFileEdit(message) {
  const lower = String(message || "").toLowerCase();
  return ["fix", "rewrite", "table", "change", "edit", "update", "replace", "insert", "add", "write", "latex", "error"].some((word) => lower.includes(word));
}

function agentPermissions(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    askBeforeEdits: source.askBeforeEdits !== false,
    yoloMode: source.yoloMode === true,
    localModelOnly: source.localModelOnly === true,
    rewriteTools: source.rewriteTools !== false,
    multiFileEdits: source.multiFileEdits === true,
    fileManagement: source.fileManagement === true,
    fileUploads: source.fileUploads === true,
    shellCommands: source.shellCommands === true,
    binaryFiles: source.binaryFiles === true
  };
}

function requestedAgentCapabilities(message) {
  const text = String(message || "");
  return {
    fileManagement: /\b(delete|rename|move|create\s+(?:a\s+)?(?:file|folder|directory)|new\s+(?:file|folder|directory))\b/iu.test(text)
      || /\b(?:create|make|write)\s+(?:a\s+)?(?:new\s+)?[^\s<>:"|?*]+\.(?:tex|bib|bst|cls|sty|clo|cfg|def|ldf|bbx|cbx|bbl|txt|md|latex|tikz|csv|dat)\b/iu.test(text),
    fileUploads: /\b(upload|import|attach|add\s+(?:an?\s+)?(?:image|asset|file|pdf))\b/iu.test(text),
    shellCommands: /\b(shell|terminal|command|execute|run\s+script|npm|node|powershell|cmd)\b/iu.test(text),
    binaryFiles: /\b(binary|png|jpe?g|gif|webp|eps)\b|(?:edit|modify|replace|write|change)\s+(?:the\s+)?(?:image|pdf|asset)\s+(?:file|asset|binary)\b/iu.test(text)
  };
}

function agentRequestForIdentity(state, identity, body = {}, extras = {}) {
  const requestBody = {
    ...(body && typeof body === "object" ? body : {}),
    ...extras,
    requester: requesterFromIdentity(identity)
  };
  if (identity.isHost) return requestBody;

  delete requestBody.aiProviderId;
  delete requestBody.providerId;
  delete requestBody.aiModelId;
  delete requestBody.modelId;
  requestBody.aiPermissions = {
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
  return requestBody;
}

function guestProviderMetadata(provider) {
  if (!provider) return null;
  return {
    id: "host-ai",
    name: "Host AI",
    type: "host-mediated",
    modelId: String(provider.modelId || "")
  };
}

function agentResultForIdentity(result, identity) {
  if (identity.isHost || !result || typeof result !== "object") return result;
  return {
    ...result,
    provider: guestProviderMetadata(result.provider),
    proposals: Array.isArray(result.proposals)
      ? result.proposals.map((proposal) => ({
        ...proposal,
        provider: guestProviderMetadata(proposal.provider),
        providerName: proposal.provider ? "Host AI" : proposal.providerName
      }))
      : []
  };
}

function canManageAiProposal(identity, proposal) {
  if (identity?.isHost) return true;
  if (!identity?.userId || !proposal?.requester?.userId) return false;
  return proposal.requester.userId === identity.userId;
}

function aiProposalRunIdentity(proposal = {}) {
  return [
    String(proposal.runId || ""),
    String(proposal.sessionId || ""),
    String(proposal.projectKey || ""),
    String(proposal.requester?.userId || "host")
  ].join("\u001f");
}

function aiProposalsShareRun(left, right) {
  return Boolean(left?.runId && right?.runId)
    && aiProposalRunIdentity(left) === aiProposalRunIdentity(right);
}

function normalizedProjectRoot(projectRoot) {
  const resolved = path.resolve(String(projectRoot || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function aiProposalMatchesCurrentProject(state, proposal) {
  if (!proposal?.projectRoot || !proposal?.projectKey || !state?.project?.root) return false;
  return proposal.projectKey === projectKeyForRoot(state.project.root)
    && normalizedProjectRoot(proposal.projectRoot) === normalizedProjectRoot(state.project.root);
}

function assertAiProposalProject(state, proposal) {
  if (aiProposalMatchesCurrentProject(state, proposal)) return;
  const error = new Error("Open the project where this AI proposal was created before managing it.");
  error.code = "AI_PROPOSAL_PROJECT_MISMATCH";
  error.statusCode = 409;
  throw error;
}

function blockedAgentCapabilities(message, permissions) {
  const requested = requestedAgentCapabilities(message);
  const labels = [];
  if (requested.fileManagement && !permissions.fileManagement) labels.push("Create, rename, move, and delete");
  if (requested.fileUploads && !permissions.fileUploads) labels.push("Uploads and imports");
  if (requested.shellCommands && !permissions.shellCommands) labels.push("Shell commands");
  if (requested.binaryFiles && !permissions.binaryFiles) labels.push("Binary files");
  return labels;
}

function hasAdvancedAgentRequest(message) {
  return Object.values(requestedAgentCapabilities(message)).some(Boolean);
}

function agentPermissionSummary(permissions) {
  return [
    `Ask before edits: ${permissions.askBeforeEdits ? "on" : "off"}`,
    `YOLO mode: ${permissions.yoloMode ? "on" : "off"}`,
    `Rewrite tools: ${permissions.rewriteTools ? "on" : "off"}`,
    `Multi-file edits: ${permissions.multiFileEdits ? "on" : "off"}`,
    `File management: ${permissions.fileManagement ? "on" : "off"}`,
    `Uploads/imports: ${permissions.fileUploads ? "on" : "off"}`,
    `Shell commands: ${permissions.shellCommands ? "on" : "off"}`,
    `Binary files: ${permissions.binaryFiles ? "on" : "off"}`
  ].join("\n");
}

function setProposalApprovalFromPermissions(proposal, permissions) {
  if (!proposal || typeof proposal !== "object") return proposal;
  proposal.approvalRequired = proposal.operation === "create" || proposal.hostApprovalRequired === true
    ? true
    : permissions.askBeforeEdits && !permissions.yoloMode;
  return proposal;
}

function applyPermissionsToAgentResult(result, permissions) {
  const proposals = Array.isArray(result?.proposals) ? result.proposals.map((proposal) => setProposalApprovalFromPermissions(proposal, permissions)) : [];
  return { ...result, proposals };
}

function agentListProjectFiles(state) {
  return state.project.files
    .filter((item) => item.type === "text" || item.type === "file")
    .map((item) => ({
      path: item.path,
      type: item.type,
      size: item.size || 0
    }))
    .slice(0, 300);
}

function agentReadProjectFile(state, requestedPath) {
  const { relativePath, fullPath } = inferAgentPath(state, requestedPath);
  const content = fs.readFileSync(fullPath, "utf8");
  return {
    path: relativePath,
    hash: textHash(content),
    content
  };
}

function agentReadProjectFileFromSnapshot(state, requestedPath, sourceSnapshot) {
  if (!(sourceSnapshot instanceof Map)) return agentReadProjectFile(state, requestedPath);
  const relativePath = normalizeRelativePath(String(requestedPath || state.project.mainFile || "").trim());
  const fullPath = resolveProjectPath(state.project.root, relativePath);
  if (!isTextFile(fullPath) || !sourceSnapshot.has(relativePath)) {
    throw new Error("Choose a text file that existed when this AI response started.");
  }
  const content = String(sourceSnapshot.get(relativePath) || "");
  return {
    path: relativePath,
    hash: textHash(content),
    content
  };
}

function agentTextFiles(state, limit = 80) {
  return (state.project.files || [])
    .filter((item) => item.type === "text" && /\.(tex|bib|sty|cls|txt|md)$/iu.test(item.path || ""))
    .filter((item) => Number(item.size || 0) <= 240000)
    .sort((left, right) => {
      const leftScore = left.path === state.project.mainFile ? -2 : /abstract/i.test(left.path) ? -1 : 0;
      const rightScore = right.path === state.project.mainFile ? -2 : /abstract/i.test(right.path) ? -1 : 0;
      return leftScore - rightScore || left.path.localeCompare(right.path);
    })
    .slice(0, limit);
}

function findTextFileContaining(state, needle, hint = "", sourceSnapshot = null) {
  const target = String(needle || "");
  if (!target) return null;
  const hintText = String(hint || "").toLowerCase();
  const candidates = agentTextFiles(state).sort((left, right) => {
    const leftHint = hintText && left.path.toLowerCase().includes("abstract") ? -1 : 0;
    const rightHint = hintText && right.path.toLowerCase().includes("abstract") ? -1 : 0;
    return leftHint - rightHint || left.path.localeCompare(right.path);
  });
  for (const item of candidates) {
    const fullPath = resolveProjectPath(state.project.root, item.path);
    try {
      const content = sourceSnapshot instanceof Map && sourceSnapshot.has(item.path)
        ? String(sourceSnapshot.get(item.path) || "")
        : fs.readFileSync(fullPath, "utf8");
      if (content.includes(target)) return { path: item.path, fullPath, content };
    } catch {
      // Ignore unreadable project files while building AI context.
    }
  }
  return null;
}

function agentProjectContext(state, currentPath, budget = 70000, options = {}) {
  const selected = normalizeRelativePath(currentPath || state.project.mainFile || "");
  const files = agentTextFiles(state);
  const ordered = files.sort((left, right) => {
    const leftRank = left.path === selected ? -3 : left.path === state.project.mainFile ? -2 : /abstract/i.test(left.path) ? -1 : 0;
    const rightRank = right.path === selected ? -3 : right.path === state.project.mainFile ? -2 : /abstract/i.test(right.path) ? -1 : 0;
    return leftRank - rightRank || left.path.localeCompare(right.path);
  });
  let remaining = budget;
  const chunks = [];
  let originalChars = 0;
  let truncated = false;
  for (const item of ordered) {
    if (options.skipSelected && item.path === selected) continue;
    if (remaining <= 1200) {
      originalChars += Math.max(0, Number(item.size || 0));
      truncated = true;
      continue;
    }
    const fullPath = resolveProjectPath(state.project.root, item.path);
    let content = "";
    try {
      content = options.sourceSnapshot instanceof Map && options.sourceSnapshot.has(item.path)
        ? String(options.sourceSnapshot.get(item.path) || "")
        : fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    originalChars += content.length;
    const header = `--- FILE: ${item.path}${item.path === selected ? " (currently open)" : ""} ---\n`;
    const available = Math.max(0, remaining - header.length);
    const limit = options.perFileBudget ? Math.min(available, options.perFileBudget) : available;
    const slice = content.slice(0, limit);
    if (slice.length < content.length) truncated = true;
    chunks.push(`${header}${slice}${slice.length < content.length ? "\n% ... LocalLeaf truncated this file for context ..." : ""}`);
    remaining -= header.length + slice.length;
  }
  const text = chunks.join("\n\n");
  return { text, originalChars, includedChars: text.length, truncated };
}

function agentCompileLogs(state) {
  return (Array.isArray(state.compile.logs) ? state.compile.logs : [])
    .map((line) => String(line || ""))
    .slice(-200);
}

function compactAgentFileContext(text, budget = 42000) {
  const source = String(text || "");
  const limit = Math.max(400, Number(budget) || 42000);
  if (source.length <= limit) return source;
  const omission = "\n\n% ... LocalLeaf omitted the middle of this large file for model context ...\n\n";
  const available = Math.max(2, limit - omission.length);
  const headLength = Math.max(1, Math.round(available * 0.68));
  const tailLength = Math.max(1, available - headLength);
  const head = source.slice(0, headLength);
  const tail = source.slice(-tailLength);
  return `${head}${omission}${tail}`;
}

function utf8Prefix(text, maxBytes) {
  const source = String(text || "");
  if (Buffer.byteLength(source, "utf8") <= maxBytes) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    let end = middle;
    if (end > 0 && /[\uD800-\uDBFF]/u.test(source[end - 1])) end -= 1;
    if (Buffer.byteLength(source.slice(0, end), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(source[end - 1])) end -= 1;
  while (end > 0 && Buffer.byteLength(source.slice(0, end), "utf8") > maxBytes) end -= 1;
  return source.slice(0, end);
}

function utf8Suffix(text, maxBytes) {
  const source = String(text || "");
  if (Buffer.byteLength(source, "utf8") <= maxBytes) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    let start = middle;
    if (start < source.length && /[\uDC00-\uDFFF]/u.test(source[start])) start += 1;
    if (Buffer.byteLength(source.slice(start), "utf8") <= maxBytes) high = middle;
    else low = middle + 1;
  }
  let start = low;
  if (start < source.length && /[\uDC00-\uDFFF]/u.test(source[start])) start += 1;
  while (start < source.length && Buffer.byteLength(source.slice(start), "utf8") > maxBytes) start += 1;
  return source.slice(start);
}

function compactPromptContent(text, maxBytes) {
  const source = String(text || "");
  const limit = Math.max(400, Math.floor(Number(maxBytes) || 400));
  if (Buffer.byteLength(source, "utf8") <= limit) return source;
  const omission = "\n\n[LocalLeaf shortened earlier context to fit this local model.]\n\n";
  const available = Math.max(2, limit - Buffer.byteLength(omission, "utf8"));
  const headBudget = Math.max(1, Math.floor(available * 0.68));
  const tailBudget = Math.max(1, available - headBudget);
  return `${utf8Prefix(source, headBudget)}${omission}${utf8Suffix(source, tailBudget)}`;
}

function fitLocalModelMessages(messages, options = {}) {
  const contextWindowTokens = Number(options.contextWindowTokens);
  const maxOutputTokens = Math.max(1, Math.round(Number(options.maxOutputTokens) || 1));
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens < 1024) {
    return { messages, truncated: false };
  }
  const maxInputTokens = Math.max(512, Math.floor(contextWindowTokens - maxOutputTokens - 320));
  const fitted = (Array.isArray(messages) ? messages : []).map((message) => ({ ...message }));
  let truncated = false;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const serialized = JSON.stringify({
      model: String(options.modelId || "local-model"),
      messages: fitted,
      temperature: Number(options.temperature ?? 0.1),
      max_tokens: maxOutputTokens,
      stream: false
    });
    const inputTokens = estimateTokens(serialized);
    if (inputTokens <= maxInputTokens) {
      return { messages: fitted, truncated, estimatedInputTokens: inputTokens };
    }
    const candidate = fitted
      .map((message, index) => ({
        index,
        bytes: Buffer.byteLength(String(message?.content || ""), "utf8")
      }))
      .sort((left, right) => right.bytes - left.bytes)[0];
    if (!candidate || candidate.bytes <= 400) break;
    const excessBytes = Math.max(192, Math.ceil((inputTokens - maxInputTokens) * 3.3));
    const nextBudget = Math.max(400, candidate.bytes - excessBytes);
    fitted[candidate.index].content = compactPromptContent(fitted[candidate.index].content, nextBudget);
    truncated = true;
  }

  return {
    messages: fitted,
    truncated,
    estimatedInputTokens: estimateTokens(JSON.stringify({ messages: fitted }))
  };
}

function lineStartOffsets(text) {
  const source = String(text || "");
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function rangeForLineSpan(text, startLine, endLine) {
  const source = String(text || "");
  const starts = lineStartOffsets(source);
  const lineCount = Math.max(1, starts.length);
  const safeStartLine = Math.max(1, Math.min(lineCount, Number(startLine || 1)));
  const safeEndLine = Math.max(safeStartLine, Math.min(lineCount, Number(endLine || safeStartLine)));
  return {
    start: starts[safeStartLine - 1] || 0,
    end: safeEndLine < starts.length ? starts[safeEndLine] : source.length
  };
}

function lineAt(lines, index) {
  return String(lines[index] || "").replace(/\r$/u, "");
}

function latexAnnotationBlockRange(text, mappedLine) {
  const source = String(text || "");
  const lines = source.split("\n");
  const lineCount = Math.max(1, lines.length);
  let index = Math.max(0, Math.min(lineCount - 1, Number(mappedLine || 1) - 1));
  if (!lineAt(lines, index).trim()) {
    let best = index;
    for (let distance = 1; distance <= 8; distance += 1) {
      const up = index - distance;
      const down = index + distance;
      if (up >= 0 && lineAt(lines, up).trim()) {
        best = up;
        break;
      }
      if (down < lineCount && lineAt(lines, down).trim()) {
        best = down;
        break;
      }
    }
    index = best;
  }

  const anchor = lineAt(lines, index).trim();
  if (/^\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{/u.test(anchor)) {
    const range = rangeForLineSpan(source, index + 1, index + 1);
    return { startLine: index + 1, endLine: index + 1, ...range, text: source.slice(range.start, range.end) };
  }

  const envPattern = /^\\(?:begin|end)\{([^{}]+)\}/u;
  for (let line = index; line >= 0; line -= 1) {
    const trimmed = lineAt(lines, line).trim();
    const env = trimmed.match(envPattern);
    if (env?.[0]?.startsWith("\\begin")) {
      const startLine = line + 1;
      const envName = env[1];
      if (envName === "document") break;
      const endPattern = new RegExp(`^\\\\end\\{${envName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`, "u");
      for (let down = index; down < lineCount; down += 1) {
        if (endPattern.test(lineAt(lines, down).trim())) {
          const endLine = down + 1;
          const range = rangeForLineSpan(source, startLine, endLine);
          return { startLine, endLine, ...range, text: source.slice(range.start, range.end) };
        }
      }
      break;
    }
    if (line !== index && !trimmed) break;
  }

  const isBoundary = (line, current) => {
    const trimmed = lineAt(lines, line).trim();
    if (!trimmed) return true;
    if (line === current) return false;
    return /^\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end|documentclass|usepackage|input|include|bibliography|addbibresource)\b/u.test(trimmed);
  };
  let start = index;
  while (start > 0 && !isBoundary(start - 1, index)) start -= 1;
  let end = index;
  while (end + 1 < lineCount && !isBoundary(end + 1, index)) end += 1;
  const range = rangeForLineSpan(source, start + 1, end + 1);
  return { startLine: start + 1, endLine: end + 1, ...range, text: source.slice(range.start, range.end) };
}

function agentPdfAnnotationContext(state, body = {}, preferredPath = "", sourceSnapshot = null) {
  const annotation = body.pdfAnnotation && typeof body.pdfAnnotation === "object" ? body.pdfAnnotation : null;
  const source = annotation?.source && typeof annotation.source === "object" ? annotation.source : null;
  if (!annotation && !source) return null;
  const requestedPath = source?.path || preferredPath || body.path;
  if (!requestedPath) return null;
  try {
    const file = sourceSnapshot instanceof Map
      ? agentReadProjectFileFromSnapshot(state, requestedPath, sourceSnapshot)
      : agentReadProjectFile(state, requestedPath);
    const line = Math.max(1, Number(source?.line || 1));
    const block = latexAnnotationBlockRange(file.content, line);
    return {
      path: file.path,
      hash: file.hash,
      content: file.content,
      line,
      column: Math.max(0, Number(source?.column || 0)),
      startLine: block.startLine,
      endLine: block.endLine,
      start: block.start,
      end: block.end,
      text: block.text,
      elementType: String(annotation?.elementType || "text").replace(/[^\w-]/gu, "").slice(0, 40) || "text",
      targetRect: annotation?.targetRect && typeof annotation.targetRect === "object"
        ? {
          left: Number(annotation.targetRect.left || 0),
          top: Number(annotation.targetRect.top || 0),
          width: Number(annotation.targetRect.width || 0),
          height: Number(annotation.targetRect.height || 0)
        }
        : null,
      pdfText: String(annotation?.textPreview || body.selectedText || "").replace(/\s+/g, " ").trim().slice(0, 800),
      page: Number(annotation?.page || 0),
      x: Number(annotation?.x || 0),
      y: Number(annotation?.y || 0)
    };
  } catch {
    return null;
  }
}

function lineNumberedSnippet(text, startLine = 1) {
  return String(text || "")
    .split(/\n/u)
    .map((line, index) => `${String(startLine + index).padStart(4, " ")} | ${line.replace(/\r$/u, "")}`)
    .join("\n");
}

function annotationPromptContext(annotation) {
  if (!annotation) return "";
  return [
    "PDF annotation target (highest priority):",
    `The user clicked page ${annotation.page || "unknown"} at PDF coordinate ${Math.round(annotation.x || 0)}, ${Math.round(annotation.y || 0)}.`,
    `Selected PDF element: ${annotation.elementType || "text"}.`,
    annotation.targetRect ? `Selected PDF rectangle: left ${Math.round(annotation.targetRect.left)}, top ${Math.round(annotation.targetRect.top)}, width ${Math.round(annotation.targetRect.width)}, height ${Math.round(annotation.targetRect.height)}.` : "",
    `Mapped source: ${annotation.path}:${annotation.line}${annotation.column ? `:${annotation.column}` : ""}.`,
    `Annotated source block: lines ${annotation.startLine}-${annotation.endLine}.`,
    annotation.pdfText ? `Clicked PDF context:\n${annotation.pdfText}` : "",
    annotation.elementType === "image" ? "This annotation targets a rendered image or figure region. Prefer edits to the mapped figure/includegraphics/caption/label/placement source block, not nearby body text." : "",
    "Only edit this annotated source block unless the user explicitly asks for a broader project change.",
    "When returning replacements, make the replacement find value an exact substring from this annotated source block.",
    `Annotated source block:\n${lineNumberedSnippet(annotation.text, annotation.startLine)}`
  ].filter(Boolean).join("\n");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactReplacementInstruction(message) {
  const normalizedInput = String(message || "")
    .replace(/[\u201c\u201d]/gu, "\"")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/\s+/g, " ")
    .trim();
  const replacementMatch = [
    /\bfrom\s+["']?(.+?)["']?\s+\bto\s+["']?(.+?)(?=["']?(?:$|[.!?])|\s+\b(?:in|inside|on|at|within|under)\b)/iu,
    /\b(?:replace|change|update)\s+["']?(.+?)["']?\s+\b(?:with|to)\s+["']?(.+?)(?=["']?(?:$|[.!?])|\s+\b(?:in|inside|on|at|within|under)\b)/iu
  ].map((pattern) => normalizedInput.match(pattern)).find(Boolean);
  if (replacementMatch) {
    const find = String(replacementMatch[1] || "").trim();
    let replace = String(replacementMatch[2] || "").trim();
    const findPunctuation = find.match(/[.!?]$/u)?.[0];
    if (findPunctuation && !/[.!?]$/u.test(replace) && normalizedInput.endsWith(findPunctuation)) {
      replace += findPunctuation;
    }
    if (find && replace && find !== replace) return { find, replace };
  }
  const normalized = String(message || "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/\bfrom\s+["'“]?(.+?)["'”]?\s+\bto\s+["'“]?(.+?)(?=["'”]?(?:$|[.!?])|\s+\b(?:in|inside|on|at|within|under)\b)/iu);
  if (!match) return null;
  const find = String(match[1] || "").trim();
  let replace = String(match[2] || "").trim();
  const findPunctuation = find.match(/[.!?]$/u)?.[0];
  if (findPunctuation && !/[.!?]$/u.test(replace) && normalized.endsWith(findPunctuation)) {
    replace += findPunctuation;
  }
  if (!find || !replace || find === replace) return null;
  return { find, replace };
}

function replaceInstructionInScope(scopeText, instruction) {
  const source = String(scopeText || "");
  const find = String(instruction?.find || "");
  const replace = String(instruction?.replace || "");
  if (!find || replace === "" || find === replace) return "";
  if (source.includes(find)) return source.replace(find, replace);
  const wholeWord = /^[A-Za-z0-9 _-]+$/u.test(find);
  const pattern = wholeWord ? new RegExp(`\\b${escapeRegex(find)}\\b`, "iu") : new RegExp(escapeRegex(find), "iu");
  const next = source.replace(pattern, replace);
  return next === source ? "" : next;
}

function createAnnotationReplacementProposal(state, body, exactInstruction, metadata = {}) {
  const annotation = agentPdfAnnotationContext(state, body, "", metadata.sourceSnapshot);
  if (!annotation || !exactInstruction) return null;
  const replacementBlock = replaceInstructionInScope(annotation.text, exactInstruction);
  if (!replacementBlock) return null;
  const newText = `${annotation.content.slice(0, annotation.start)}${replacementBlock}${annotation.content.slice(annotation.end)}`;
  const proposal = createAgentProposalFromText(
    state,
    { ...body, path: annotation.path },
    newText,
    `Replace "${exactInstruction.find}" with "${exactInstruction.replace}" in the annotated PDF selection.`,
    metadata
  );
  proposal.annotation = {
    page: annotation.page,
    path: annotation.path,
    line: annotation.line,
    startLine: annotation.startLine,
    endLine: annotation.endLine,
    elementType: annotation.elementType,
    targetRect: annotation.targetRect,
    pdfText: annotation.pdfText
  };
  return proposal;
}

function providerNewTextLooksLikeFullFile(originalText, proposedText) {
  const original = String(originalText || "");
  const proposed = String(proposedText || "");
  if (!proposed.trim()) return false;
  if (/\\begin\{document\}/u.test(original)) return /\\begin\{document\}/u.test(proposed);
  return proposed.length > Math.max(400, original.length * 0.55);
}

function applyExactReplacementInstructions(originalText, replacements = [], options = {}) {
  const source = String(originalText || "");
  const exactItems = [];
  const rangeItems = [];
  for (const item of Array.isArray(replacements) ? replacements.slice(0, 20) : []) {
    if (!item || typeof item !== "object") continue;
    const start = Number(item.start);
    const end = Number(item.end);
    const text = typeof item.text === "string" ? item.text : typeof item.replace === "string" ? item.replace : typeof item.newText === "string" ? item.newText : "";
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= source.length && text) {
      rangeItems.push({ start, end, text });
      continue;
    }
    const find = typeof item.find === "string" ? item.find : typeof item.oldText === "string" ? item.oldText : typeof item.from === "string" ? item.from : "";
    const replace = typeof item.replace === "string" ? item.replace : typeof item.text === "string" ? item.text : typeof item.newText === "string" ? item.newText : typeof item.to === "string" ? item.to : "";
    if (find && replace !== "" && find !== replace) exactItems.push({ find, replace, all: item.all === true });
  }
  if (rangeItems.length) {
    let next = source;
    for (const item of rangeItems.sort((left, right) => right.start - left.start)) {
      next = `${next.slice(0, item.start)}${item.text}${next.slice(item.end)}`;
    }
    return next === source ? "" : next;
  }
  const scope = options.scope && Number.isInteger(options.scope.start) && Number.isInteger(options.scope.end)
    ? {
      start: Math.max(0, Math.min(source.length, options.scope.start)),
      end: Math.max(0, Math.min(source.length, options.scope.end))
    }
    : null;
  if (scope && scope.end >= scope.start && exactItems.length) {
    let scoped = source.slice(scope.start, scope.end);
    let changed = false;
    for (const item of exactItems) {
      const nextScoped = replaceInstructionInScope(scoped, item);
      if (!nextScoped) continue;
      scoped = item.all && scoped.includes(item.find)
        ? scoped.split(item.find).join(item.replace)
        : nextScoped;
      changed = true;
    }
    if (changed) return `${source.slice(0, scope.start)}${scoped}${source.slice(scope.end)}`;
  }
  let next = source;
  for (const item of exactItems) {
    if (!next.includes(item.find)) continue;
    next = item.all ? next.split(item.find).join(item.replace) : next.replace(item.find, item.replace);
  }
  return next === source ? "" : next;
}

function createServerSearchRegex(query, options = {}) {
  const raw = String(query || "");
  if (!raw) return null;
  const source = options.regex
    ? raw
    : raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = options.wholeWord ? `\\b(?:${source})\\b` : source;
  try {
    return new RegExp(pattern, options.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

function replaceProjectText(state, input = {}) {
  const query = String(input.query || "");
  if (!query) throw new Error("Search text is required.");
  const regex = createServerSearchRegex(query, input.options || {});
  if (!regex) throw new Error("Search pattern is invalid.");
  const replacement = String(input.replace ?? input.replacement ?? "");
  const files = agentTextFiles(state, 400);
  const changed = [];
  let total = 0;
  for (const file of files) {
    const fullPath = resolveProjectPath(state.project.root, file.path);
    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    const nextText = content.replace(regex, () => {
      total += 1;
      return replacement;
    });
    if (nextText !== content) {
      fs.writeFileSync(fullPath, nextText, "utf8");
      changed.push(file.path);
    }
  }
  if (changed.length) refreshProject(state);
  return { count: total, files: changed };
}

function cursorProviderRequested(body = {}) {
  const providerId = String(body.aiProviderId || body.providerId || "").trim().toLowerCase();
  return providerId === "cursor" || providerId === "cursor-sdk" || providerId === "cursor-sdk-local";
}

function cursorModelId(body = {}) {
  const requested = String(body.aiModelId || body.modelId || "").trim();
  return requested && requested !== "cursor-sdk-local" ? requested : DEFAULT_CURSOR_MODEL_ID;
}

function cursorProviderPublic(modelId) {
  return {
    id: "cursor",
    name: "Cursor",
    modelId: modelId || DEFAULT_CURSOR_MODEL_ID
  };
}

function throwIfAgentRunCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("AI response was cancelled.");
  error.code = "AI_RUN_CANCELLED";
  throw error;
}

async function createCursorAgentResponse(state, body, options = {}) {
  const message = String(body.message || "").trim().slice(0, 2000);
  if (!message) throw new Error("Message is required.");

  const permissions = agentPermissions(body.aiPermissions || body.permissions);
  const { relativePath } = inferAgentPath(state, body.path);
  const scratchRoot = copyProjectToScratch(state.project.root);
  const before = snapshotTextFiles(scratchRoot);
  body._sourceSnapshot = before;
  const modelId = cursorModelId(body);
  const cursorConfig = await state.ai.models.cursorProviderConfig({
    providerId: body.aiProviderId || body.providerId || "cursor",
    modelId
  });

  try {
    const result = await state.ai.cursorRunner({
      cwd: scratchRoot,
      modelId,
      apiKey: cursorConfig.apiKey,
      prompt: cursorLatexPrompt(body, {
        currentPath: relativePath,
        fileManagementAllowed: permissions.fileManagement
      }),
      body,
      state,
      signal: options.signal
    });
    throwIfAgentRunCancelled(options.signal);
    const changed = changedTextFiles(before, scratchRoot, {
      includeCreated: permissions.fileManagement
    });
    const orderedChanges = requestedAgentCapabilities(message).fileManagement
      ? [...changed].sort((left, right) => Number(right.operation === "create") - Number(left.operation === "create"))
      : changed;
    const allowedChanges = permissions.multiFileEdits
      ? orderedChanges.slice(0, 8)
      : orderedChanges.filter((item) => item.path === relativePath || item.operation === "create").slice(0, 1);
    const proposals = allowedChanges.map((change) => {
      if (change.operation === "create") {
        return createAgentFileProposal(
          state,
          body,
          change.path,
          change.newText,
          `Cursor SDK proposed a new file at ${change.path}.`,
          {
            provider: cursorProviderPublic(cursorConfig.modelId || modelId),
            modelId: cursorConfig.modelId || modelId,
            deferRegistration: true
          }
        );
      }
      return setProposalApprovalFromPermissions(createAgentProposalFromText(
        state,
        { ...body, path: change.path },
        change.newText,
        change.path === relativePath
          ? "Cursor SDK proposed an edit to the current LaTeX file."
          : `Cursor SDK proposed an edit to ${change.path}.`,
        {
          provider: cursorProviderPublic(cursorConfig.modelId || modelId),
          modelId: cursorConfig.modelId || modelId,
          originalText: change.oldText,
          sourceSnapshot: before,
          deferRegistration: true
        }
      ), permissions);
    });
    if (requestedAgentCapabilities(message).fileManagement && !proposals.some((proposal) => proposal.operation === "create")) {
      throw new Error("The Cursor response did not produce a safe file-management proposal, so LocalLeaf did not write anything.");
    }
    if (proposals.some((proposal) => proposal.operation === "create")) {
      proposals.forEach((proposal) => {
        proposal.approvalRequired = true;
        proposal.hostApprovalRequired = true;
      });
    }
    proposals.forEach((proposal) => registerAiProposal(state, proposal));

    if (!proposals.length && wantsFileEdit(message) && !requestedAgentCapabilities(message).fileManagement) {
      const proposal = setProposalApprovalFromPermissions(createDeterministicAgentProposal(state, body), permissions);
      if (!proposal) {
        return {
          reply: `${result?.reply || "Cursor SDK completed the run, but did not change the editable file."}\n\n${DETERMINISTIC_REWRITE_GUIDANCE}`,
          runtime: "cursor-sdk",
          provider: cursorProviderPublic(cursorConfig.modelId || modelId),
          proposals: []
        };
      }
      return {
        reply: formatAgentReply(
          `${result?.reply || "Cursor SDK completed the run, but did not change the editable file."}\n\nThe model did not return an editable patch, so LocalLeaf prepared a safe fallback.`,
          [proposal]
        ),
        runtime: "cursor-sdk",
        provider: cursorProviderPublic(cursorConfig.modelId || modelId),
        proposals: [setProposalApprovalFromPermissions(publicProposal(proposal), permissions)]
      };
    }

    return {
      reply: formatAgentReply(
        result?.reply || (proposals.length ? "Cursor SDK prepared a file-change proposal." : "Cursor SDK finished without file changes."),
        proposals
      ),
      runtime: "cursor-sdk",
      provider: cursorProviderPublic(cursorConfig.modelId || modelId),
      proposals: proposals.map((proposal) => setProposalApprovalFromPermissions(publicProposal(proposal), permissions))
    };
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function createProviderProposalsFromParsed(state, body, parsed, metadata, permissions) {
  const sourceSnapshot = metadata.sourceSnapshot instanceof Map ? metadata.sourceSnapshot : null;
  const exactInstruction = exactReplacementInstruction(body.message || "");
  let exactProposal = null;
  if (exactInstruction) {
    const annotationProposal = createAnnotationReplacementProposal(state, body, exactInstruction, {
      ...metadata,
      deferRegistration: true
    });
    if (annotationProposal) {
      exactProposal = setProposalApprovalFromPermissions(annotationProposal, permissions);
    } else {
      const found = findTextFileContaining(state, exactInstruction.find, body.message || "", sourceSnapshot);
      if (found) {
      const nextText = found.content.replace(exactInstruction.find, exactInstruction.replace);
        exactProposal = setProposalApprovalFromPermissions(createAgentProposalFromText(
          state,
          { ...body, path: found.path },
          nextText,
          `Replace "${exactInstruction.find}" with "${exactInstruction.replace}".`,
          { ...metadata, deferRegistration: true }
        ), permissions);
      }
    }
  }
  const proposals = [];
  const proposalLimit = permissions.multiFileEdits ? 8 : 1;
  const creates = Array.isArray(parsed.creates) ? parsed.creates : [];
  if (creates.length && !permissions.fileManagement) {
    throw new Error("The provider requested file creation, but File management is off in AI Permissions.");
  }
  const proposedCreatePaths = new Set();
  const validCreates = [];
  for (const create of creates.slice(0, proposalLimit)) {
    if (!create || typeof create !== "object") continue;
    const hasContent = Object.prototype.hasOwnProperty.call(create, "content")
      || Object.prototype.hasOwnProperty.call(create, "newText");
    if (!hasContent) continue;
    const content = Object.prototype.hasOwnProperty.call(create, "content") ? create.content : create.newText;
    const validated = validateAiCreatedFile(state, create.path, content);
    const normalizedCreatePath = validated.relativePath;
    if (proposedCreatePaths.has(normalizedCreatePath)) {
      throw new Error(`The provider proposed the same new file more than once: ${normalizedCreatePath}.`);
    }
    proposedCreatePaths.add(normalizedCreatePath);
    if (fs.existsSync(validated.fullPath)) {
      throw new Error(`LocalLeaf AI cannot create ${normalizedCreatePath} because that path already exists.`);
    }
    validCreates.push({
      ...create,
      path: normalizedCreatePath,
      content: validated.cleanText
    });
  }
  for (const create of validCreates) {
    proposals.push(createAgentFileProposal(
      state,
      body,
      create.path,
      create.content,
      create.summary || parsed.summary || `Create ${String(create.path || "a new file")}.`,
      { ...metadata, deferRegistration: true }
    ));
  }
  if (exactProposal && proposals.length < proposalLimit) proposals.push(exactProposal);
  const edits = exactProposal
    ? []
    : Array.isArray(parsed.edits) && parsed.edits.length
    ? parsed.edits
    : [{
      path: parsed.path || body.path,
      replacements: parsed.replacements,
      newText: parsed.newText
    }];
  for (const edit of edits.slice(0, Math.max(0, proposalLimit - proposals.length))) {
    const targetPath = edit.path || body.path;
    const targetFile = sourceSnapshot
      ? agentReadProjectFileFromSnapshot(state, targetPath, sourceSnapshot)
      : agentReadProjectFile(state, targetPath);
    const annotationTarget = agentPdfAnnotationContext(state, body, targetFile.path, sourceSnapshot);
    const replacementText = applyExactReplacementInstructions(targetFile.content, edit.replacements, {
      scope: annotationTarget && annotationTarget.path === targetFile.path
        ? { start: annotationTarget.start, end: annotationTarget.end }
        : null
    });
    let proposedText = replacementText;
    if (!proposedText && typeof edit.newText === "string" && edit.newText.trim()) {
      const cleanNewText = edit.newText;
      if (annotationTarget && annotationTarget.path === targetFile.path && !providerNewTextLooksLikeFullFile(targetFile.content, cleanNewText)) {
        proposedText = `${targetFile.content.slice(0, annotationTarget.start)}${cleanNewText.replace(/\s*$/u, "")}\n${targetFile.content.slice(annotationTarget.end)}`;
      } else {
        proposedText = cleanNewText;
      }
    }
    if (!proposedText) continue;
    proposals.push(setProposalApprovalFromPermissions(createAgentProposalFromText(
      state,
      { ...body, path: targetFile.path },
      proposedText,
      edit.summary || parsed.summary || parsed.reply,
      { ...metadata, deferRegistration: true }
    ), permissions));
  }
  if (requestedAgentCapabilities(body.message || "").fileManagement && !proposals.some((proposal) => proposal.operation === "create")) {
    throw new Error("The provider did not return a safe file-management proposal, so LocalLeaf did not write anything.");
  }
  if (proposals.some((proposal) => proposal.operation === "create")) {
    proposals.forEach((proposal) => {
      proposal.approvalRequired = true;
      proposal.hostApprovalRequired = true;
    });
  }
  proposals.forEach((proposal) => registerAiProposal(state, proposal));
  return proposals;
}

async function createProviderAgentResponse(state, body, options = {}) {
  const message = String(body.message || "").trim().slice(0, 2000);
  if (!message) throw new Error("Message is required.");
  const permissions = agentPermissions(body.aiPermissions || body.permissions);
  const limits = {
    ...HOSTED_AGENT_PROMPT_LIMITS,
    ...(options.promptLimits || {})
  };
  const sourceSnapshot = body._sourceSnapshot instanceof Map
    ? body._sourceSnapshot
    : snapshotTextFiles(state.project.root);
  body._sourceSnapshot = sourceSnapshot;
  const annotationContext = agentPdfAnnotationContext(state, body, "", sourceSnapshot);
  const currentFile = agentReadProjectFileFromSnapshot(state, annotationContext?.path || body.path, sourceSnapshot);
  const relativePath = currentFile.path;
  const originalText = currentFile.content;
  const compileLogSource = Array.isArray(body.compileLogs)
    ? body.compileLogs.map((item) => String(item || "")).join("\n")
    : "";
  const compileLogs = compileLogSource.slice(-limits.compileLogBudget);
  const selectedTextSource = String(body.selectedText || "");
  const selectedText = selectedTextSource.slice(0, limits.selectedTextBudget);
  const conversationSource = Array.isArray(body.conversation)
    ? body.conversation.map((item) => ({
      role: String(item?.role || "user"),
      message: String(item?.message || "")
    }))
    : [];
  const lastConversationItem = conversationSource.at(-1);
  if (lastConversationItem?.role === "user" && lastConversationItem.message.trim() === message) {
    conversationSource.pop();
  }
  const includedConversation = conversationSource.slice(-limits.conversationTurns);
  const conversation = includedConversation
    .map((item) => `${item.role.toUpperCase()}: ${item.message.slice(0, limits.conversationItemBudget)}`)
    .join("\n");
  const projectContextResult = agentProjectContext(state, relativePath, limits.projectContextBudget, {
    skipSelected: true,
    perFileBudget: limits.projectContextPerFileBudget,
    sourceSnapshot
  });
  const projectContext = projectContextResult.text;
  const currentFileContext = compactAgentFileContext(originalText, limits.currentFileBudget);
  const compactProjectContext = compactAgentFileContext(projectContext, limits.projectContextBudget);
  const prompt = [
    "You are LocalLeaf AI, a careful LaTeX project assistant.",
    "Return JSON only with this shape:",
    '{"reply":"short explanation","summary":"short change summary","edits":[{"path":"relative/project/file.tex","replacements":[{"find":"exact text from that file","replace":"replacement text","all":false}],"newText":"full replacement file text or empty string"}],"creates":[{"path":"relative/project/new-file.tex","content":"complete UTF-8 file content","summary":"short creation summary"}]}',
    aiResponsePromptGuidance({ jsonTransport: true }),
    "Prefer replacements for small edits. Only set newText for larger structural edits. Keep LaTeX valid. Do not delete unrelated content.",
    "Each replacement find value must exactly match text shown from the relevant project file.",
    "You may edit another text file if the user asks about content that lives outside the currently open file.",
    permissions.fileManagement
      ? "File management is enabled. Use creates only when the user explicitly asks for a new file. Use a new project-relative path with a LaTeX text/support extension, and never use creates to overwrite an existing file."
      : "File management is disabled. Return an empty creates array and do not propose new files.",
    "For PDF annotation requests, treat the annotation target as the user's selection and avoid editing unrelated matching text elsewhere.",
    "Current AI Helper permissions:",
    agentPermissionSummary(permissions),
    "If an advanced action is allowed, explain the intended action clearly. For this MVP, file writes still happen through LocalLeaf proposals and approval cards.",
    `File path: ${relativePath}`,
    "Current file:",
    currentFileContext,
    annotationPromptContext(annotationContext),
    "Project context:",
    compactProjectContext,
    conversation ? `Recent chat context:\n${conversation}` : "",
    selectedText ? `Selected text:\n${selectedText}` : "",
    compileLogs ? `Compile logs:\n${compileLogs}` : "",
    `User request: ${message}`
  ].filter(Boolean).join("\n\n");

  const requestedProviderId = String(body.aiProviderId || body.providerId || "").trim();
  const requestedModelId = String(body.aiModelId || body.modelId || "").trim();
  const askModel = options.askModel || state.ai.models.askActiveProvider;
  let modelMessages = [
    {
      role: "system",
      content: "You are a precise LaTeX editor. Return exactly one valid JSON object matching the requested schema. Do not wrap it in a Markdown fence or add commentary outside the object."
    },
    { role: "user", content: prompt }
  ];
  const runtime = options.runtime || state.ai.models.publicState().runtime;
  const modelState = state.ai.models.publicState();
  const selectedModel = (modelState.modelChoices || []).find((choice) => {
    const providerMatches = !requestedProviderId || choice.providerId === requestedProviderId
      || (["local", "localleaf-local"].includes(requestedProviderId) && choice.local);
    return providerMatches && (!requestedModelId || choice.modelId === requestedModelId);
  }) || modelState.activeModel;
  const localContextFit = runtime === "local-llama-cpp"
    ? fitLocalModelMessages(modelMessages, {
      contextWindowTokens: selectedModel?.contextWindowTokens,
      maxOutputTokens: limits.maxTokens,
      modelId: requestedModelId || selectedModel?.modelId,
      temperature: 0.1
    })
    : { messages: modelMessages, truncated: false };
  modelMessages = localContextFit.messages;
  const truncationReasons = [];
  const historyTruncated = conversationSource.length > includedConversation.length
    || includedConversation.some((item) => item.message.length > limits.conversationItemBudget);
  const projectContextTruncated = projectContextResult.truncated || projectContext.length > compactProjectContext.length;
  if (historyTruncated) truncationReasons.push("history_limit");
  if (originalText.length > currentFileContext.length) truncationReasons.push("current_file_limit");
  if (projectContextTruncated) truncationReasons.push("project_context_limit");
  if (selectedTextSource.length > selectedText.length) truncationReasons.push("selection_limit");
  if (compileLogSource.length > compileLogs.length) truncationReasons.push("tool_limit");
  if (localContextFit.truncated) truncationReasons.push("context_window");
  const serializedModelRequest = JSON.stringify({
    model: requestedModelId || selectedModel?.modelId || "",
    messages: modelMessages,
    max_tokens: limits.maxTokens,
    temperature: 0.1
  });
  const contextMetadata = {
    runId: body.runId || "",
    sessionId: body.sessionId || "",
    runtime,
    messages: serializedModelRequest,
    contextWindowTokens: selectedModel?.contextWindowTokens || null,
    windowSource: selectedModel?.contextWindowTokens
      ? (selectedModel.local ? "local_runtime" : "provider_model_config")
      : "unknown",
    maxOutputTokens: limits.maxTokens,
    history: {
      availableTurns: conversationSource.length,
      includedTurns: includedConversation.length,
      droppedTurns: Math.max(0, conversationSource.length - includedConversation.length)
    },
    truncation: { occurred: truncationReasons.length > 0, reasons: truncationReasons },
    components: [
      { key: "current_file", originalChars: originalText.length, includedChars: currentFileContext.length, truncated: originalText.length > currentFileContext.length },
      { key: "project_context", originalChars: Math.max(projectContextResult.originalChars, projectContext.length), includedChars: compactProjectContext.length, truncated: projectContextTruncated },
      { key: "history", originalChars: conversationSource.reduce((sum, item) => sum + item.message.length, 0), includedChars: conversation.length, truncated: historyTruncated },
      { key: "selection", originalChars: selectedTextSource.length, includedChars: selectedText.length, truncated: selectedTextSource.length > selectedText.length },
      { key: "tools", originalChars: compileLogSource.length, includedChars: compileLogs.length, truncated: compileLogSource.length > compileLogs.length },
      { key: "request", originalChars: message.length, includedChars: message.length, truncated: false }
    ]
  };
  const preparedContextUsage = buildContextUsage({ ...contextMetadata, status: "prepared" });
  if (typeof options.onContextPrepared === "function") options.onContextPrepared(preparedContextUsage);
  const result = await askModel(modelMessages, {
    providerId: requestedProviderId || undefined,
    modelId: requestedModelId || undefined,
    maxTokens: limits.maxTokens,
    temperature: 0.1,
    signal: options.signal
  });
  throwIfAgentRunCancelled(options.signal);
  const contextUsage = buildContextUsage({
    ...contextMetadata,
    status: "complete",
    runtime,
    providerUsage: result?.usage,
    estimatedInputTokens: result?.requestInputTokensEstimate,
    contextWindowTokens: result?.contextWindowTokens || contextMetadata.contextWindowTokens,
    windowSource: result?.windowSource || contextMetadata.windowSource
  });

  const parsed = extractJsonObject(result?.content);
  const proposals = [];
  let reply = result?.content || "The provider responded.";
  if (parsed && typeof parsed === "object") {
    reply = String(parsed.reply || "I prepared a response.");
    proposals.push(...createProviderProposalsFromParsed(state, body, parsed, {
      provider: result.provider,
      modelId: result.modelId,
      sourceSnapshot
    }, permissions));
    if (!proposals.length && wantsFileEdit(message) && !requestedAgentCapabilities(message).fileManagement) {
      const fallbackProposal = setProposalApprovalFromPermissions(createDeterministicAgentProposal(state, body), permissions);
      if (fallbackProposal) {
        proposals.push(fallbackProposal);
        reply = `${reply} I added a safe LocalLeaf fallback proposal because the model did not return an editable patch.`;
      } else {
        reply = `${reply}\n\n${DETERMINISTIC_REWRITE_GUIDANCE}`;
      }
    }
  } else if (wantsFileEdit(message) && !requestedAgentCapabilities(message).fileManagement) {
    const fallbackProposal = setProposalApprovalFromPermissions(createDeterministicAgentProposal(state, body), permissions);
    if (fallbackProposal) {
      proposals.push(fallbackProposal);
      reply = `${reply}\n\nI drafted a file change and added it to Changes.`;
    } else {
      reply = `${reply}\n\n${DETERMINISTIC_REWRITE_GUIDANCE}`;
    }
  }
  if (requestedAgentCapabilities(message).fileManagement && !proposals.some((proposal) => proposal.operation === "create")) {
    throw new Error("The provider did not return a valid file-management proposal, so LocalLeaf did not write anything.");
  }

  return {
    reply: formatAgentReply(reply, proposals),
    runtime,
    provider: result?.provider ? {
      id: result.provider.id,
      name: result.provider.name,
      modelId: result.modelId
    } : null,
    proposals: proposals.map((proposal) => setProposalApprovalFromPermissions(publicProposal(proposal), permissions)),
    contextUsage
  };
}

async function createAgentMessageResponse(state, body, options = {}) {
  const message = String(body.message || "").trim().slice(0, 2000);
  const permissions = agentPermissions(body.aiPermissions || body.permissions);
  if (!permissions.rewriteTools && /\b(rewrite|humanize|clarity|simplify)\b/iu.test(message)) {
    throw new Error("Rewrite tools are off. Enable Rewrite tools in Settings > AI Permissions to use this request.");
  }
  const blocked = blockedAgentCapabilities(message, permissions);
  if (blocked.length) {
    throw new Error(`This request needs AI permission for ${blocked.join(", ")}. Enable it in Settings > AI Permissions.`);
  }
  const providerChoice = String(body.aiProviderId || body.providerId || "").trim();
  const hasExplicitChoice = Object.prototype.hasOwnProperty.call(body, "aiProviderId") || Object.prototype.hasOwnProperty.call(body, "providerId");
  const providerRequested = providerChoice && providerChoice !== "local" && providerChoice !== "localleaf-local";
  const activeAi = state.ai.models.publicState().activeProviderId;
  if (permissions.localModelOnly && providerRequested) {
    throw new Error("Local model only is on. Disable it in Settings > AI Permissions or choose a local model in the AI chat.");
  }
  if (cursorProviderRequested(body)) {
    return applyPermissionsToAgentResult(await createCursorAgentResponse(state, body, options), permissions);
  }
  const fileManagementRequest = requestedAgentCapabilities(message).fileManagement;
  if ((!providerRequested || providerChoice === "local" || providerChoice === "localleaf-local") && state.ai.models.hasActiveLocalModel()) {
    const requestedLocalModelId = String(body.aiModelId || body.modelId || "").trim();
    try {
      await state.ai.models.prepareLocalModel({ modelId: requestedLocalModelId || undefined });
      const localModelState = state.ai.models.publicState();
      const selectedLocalModel = (localModelState.modelChoices || []).find((choice) => {
        return choice.local && (!requestedLocalModelId || choice.modelId === requestedLocalModelId);
      }) || (localModelState.activeModel?.local ? localModelState.activeModel : null);
      return applyPermissionsToAgentResult(await createProviderAgentResponse(state, body, {
        ...options,
        runtime: "local-llama-cpp",
        promptLimits: localAgentPromptLimits(selectedLocalModel?.contextWindowTokens),
        askModel: (messages, requestOptions) => state.ai.models.askLocalModel(messages, {
          ...requestOptions,
          modelId: body.aiModelId || body.modelId || requestOptions?.modelId
        })
      }), permissions);
    } catch (error) {
      throwIfAgentRunCancelled(options.signal);
      if (!permissions.localModelOnly && !hasExplicitChoice && activeAi) {
        return applyPermissionsToAgentResult(await createProviderAgentResponse(state, body, options), permissions);
      }
      if (!fileManagementRequest && wantsFileEdit(message) && /local model|runtime|malformed|json|empty|failed|context size|exceeds the available context/i.test(error.message || "")) {
        const proposal = setProposalApprovalFromPermissions(createDeterministicAgentProposal(state, body), permissions);
        if (!proposal) {
          return {
            reply: `${error.message || "The local model could not respond."}\n\n${DETERMINISTIC_REWRITE_GUIDANCE}`,
            runtime: "deterministic-fallback",
            provider: null,
            proposals: []
          };
        }
        return {
          reply: formatAgentReply(
            `${error.message || "The local model could not respond."}\n\nThe model could not produce a usable patch, so LocalLeaf prepared a safe fallback.`,
            [proposal]
          ),
          runtime: "deterministic-fallback",
          provider: null,
          proposals: [setProposalApprovalFromPermissions(publicProposal(proposal), permissions)]
        };
      }
      throw error;
    }
  }
  if ((providerRequested || (!hasExplicitChoice && activeAi)) && !permissions.localModelOnly) {
    try {
      return applyPermissionsToAgentResult(await createProviderAgentResponse(state, body, options), permissions);
    } catch (error) {
      throwIfAgentRunCancelled(options.signal);
      if (!fileManagementRequest && wantsFileEdit(message) && /timed out|malformed|json|unreadable|invalid|original file|without changes|replacement text/i.test(error.message || "")) {
        const proposal = setProposalApprovalFromPermissions(createDeterministicAgentProposal(state, body), permissions);
        const reason = /malformed|json|unreadable|invalid/i.test(error.message || "")
          ? "The provider response was not usable."
          : error.message;
        if (!proposal) {
          return {
            reply: `${reason}\n\n${DETERMINISTIC_REWRITE_GUIDANCE}`,
            runtime: "deterministic-fallback",
            provider: null,
            proposals: []
          };
        }
        return {
          reply: formatAgentReply(
            `${reason}\n\nThe provider could not produce a usable patch, so LocalLeaf prepared a safe fallback.`,
            [proposal]
          ),
          runtime: "deterministic-fallback",
          provider: null,
          proposals: [setProposalApprovalFromPermissions(publicProposal(proposal), permissions)]
        };
      }
      throw error;
    }
  }

  if (hasAdvancedAgentRequest(message)) {
    return {
      reply: "That permission is enabled. The current local fallback can acknowledge advanced actions, but only text edits are automated in this MVP. Choose a hosted provider model for richer planning, or ask for a safe text edit I can propose now.",
      runtime: "deterministic-fallback",
      provider: null,
      proposals: []
    };
  }

  if (!wantsFileEdit(message)) {
    return {
      reply: "I'm ready to help with LaTeX errors, rewrites, tables, and project edits. Tell me what you want changed or which compile issue to inspect.",
      runtime: "deterministic-fallback",
      provider: null,
      proposals: []
    };
  }

  const proposal = setProposalApprovalFromPermissions(createDeterministicAgentProposal(state, body), permissions);
  if (!proposal) {
    return {
      reply: DETERMINISTIC_REWRITE_GUIDANCE,
      runtime: "deterministic-fallback",
      provider: null,
      proposals: []
    };
  }
  return {
    reply: formatAgentReply("Review the proposal in this chat before it is written.", [proposal]),
    runtime: "deterministic-fallback",
    provider: null,
    proposals: [setProposalApprovalFromPermissions(publicProposal(proposal), permissions)]
  };
}

function aiRunError(code, message, statusCode = 409, metadata = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, metadata);
  return error;
}

function aiRunIdentityKey(identity = {}) {
  return identity.isHost ? "host" : `guest:${String(identity.userId || "anonymous")}`;
}

function aiRunControllerKey(identity, runId) {
  return `${aiRunIdentityKey(identity)}:${String(runId || "")}`;
}

function contextUsageForRuntime(runtime, input = {}) {
  return buildContextUsage({
    runId: input.runId,
    sessionId: input.sessionId,
    status: input.status || "prepared",
    runtime,
    messages: input.messages || [],
    providerUsage: input.providerUsage,
    contextWindowTokens: input.contextWindowTokens,
    maxOutputTokens: input.maxOutputTokens,
    windowSource: input.windowSource,
    history: input.history || { availableTurns: 0, includedTurns: 0, droppedTurns: 0 },
    truncation: input.truncation || { occurred: false, reasons: [] },
    components: input.components || []
  });
}

async function runAgentForSession(state, identity, body = {}, options = {}) {
  const sessionStore = aiSessionStoreForIdentity(state, identity);
  if (!sessionStore) throw aiRunError("AI_SESSION_NOT_FOUND", "AI session was not found.", 404);
  const runProject = {
    ...state.project,
    files: Array.isArray(state.project?.files) ? state.project.files.map((file) => ({ ...file })) : []
  };
  const runState = { ...state, project: runProject };
  const currentSnapshot = sessionStore.publicState(runProject);
  const suppliedSessionId = String(body.sessionId || "").trim();
  const sessionId = suppliedSessionId || currentSnapshot.currentSessionId;
  const originSession = sessionStore.getSession(runProject, sessionId);
  if (!originSession) throw aiRunError("AI_SESSION_NOT_FOUND", "AI session was not found.", 404);

  const runId = String(body.runId || randomId(8)).trim().slice(0, 80);
  const clientMessageId = String(body.clientMessageId || `user-${runId}`).trim().slice(0, 80);
  const message = String(body.message || "").trim().slice(0, 2000);
  if (!message) throw aiRunError("AI_RUN_INVALID", "Message is required.", 400);
  const existingRun = sessionStore.getRun(runProject, sessionId, runId);
  if (existingRun) {
    const originalUserMessage = existingRun.userMessage
      || (originSession.messages || []).find((item) => item.id === existingRun.clientMessageId);
    if (existingRun.clientMessageId !== clientMessageId || String(originalUserMessage?.message || "") !== message) {
      throw aiRunError("AI_RUN_BUSY", "That AI run ID is already associated with another request.", 409, { runId, sessionId });
    }
    if (existingRun.status === "complete") {
      const originSessionId = existingRun.sessionId || sessionId;
      const assistantMessage = existingRun.assistantMessage || [...(originSession.messages || [])]
        .reverse()
        .find((item) => item.role === "assistant" && item.runId === runId) || {
          id: `assistant-${runId}`,
          role: "assistant",
          message: "This AI run already completed.",
          runId
        };
      const resultMetadata = existingRun.resultMetadata || {};
      const replayContextUsage = existingRun.contextUsage || contextUsageForRuntime(
        resultMetadata.runtime || "cursor-sdk",
        {
          runId,
          sessionId: originSessionId,
          status: "unavailable",
          messages: [],
          history: { availableTurns: 0, includedTurns: 0, droppedTurns: 0 }
        }
      );
      if (typeof options.onRunStarted === "function") {
        options.onRunStarted({ runId, sessionId: originSessionId, replayed: true });
      }
      if (typeof options.onContextPrepared === "function") options.onContextPrepared(replayContextUsage);
      return {
        ...resultMetadata,
        runId,
        sessionId: originSessionId,
        reply: assistantMessage.message,
        assistantMessage,
        proposals: assistantMessage.proposals || [],
        sessionRevision: existingRun.sessionRevision || originSession.revision,
        contextUsage: replayContextUsage,
        runtime: resultMetadata.runtime || replayContextUsage.runtime || "",
        replayed: true
      };
    }
    if (existingRun.status === "cancelled") {
      throw aiRunError("AI_RUN_CANCELLED", "AI response was cancelled.", 409, { runId, sessionId });
    }
    throw aiRunError("AI_RUN_BUSY", "That AI run is already active or terminal.", 409, { runId, sessionId });
  }
  const effectiveBody = agentRequestForIdentity(runState, identity, {
    ...body,
    runId,
    clientMessageId,
    sessionId,
    message,
    conversation: (originSession.messages || [])
      .filter((item) => item.id !== "welcome")
      .map((item) => ({ role: item.role, message: item.message || "" }))
  });
  const activeModel = runState.ai.models.publicState().activeModel || {};
  const permissions = agentPermissions(effectiveBody.aiPermissions || effectiveBody.permissions);
  const metadata = identity.isHost ? {
    providerId: effectiveBody.aiProviderId || effectiveBody.providerId || activeModel.providerId || "",
    providerName: activeModel.providerName || "",
    modelId: effectiveBody.aiModelId || effectiveBody.modelId || activeModel.modelId || "",
    modelName: activeModel.name || "",
    permissionMode: permissions.yoloMode ? "yolo" : "default"
  } : {
    providerId: "host-ai",
    providerName: "Host AI",
    modelId: activeModel.modelId || "host-model",
    modelName: activeModel.name || "Host model",
    permissionMode: "default"
  };

  sessionStore.beginRun(runProject, sessionId, {
    runId,
    clientMessageId,
    message,
    metadata
  });
  const controller = new AbortController();
  const controllerKey = aiRunControllerKey(identity, runId);
  const runControl = { controller, sessionId, runId, sessionStore, project: runProject, cancelled: false };
  state.ai.runControllers.set(controllerKey, runControl);
  if (typeof options.onRunStarted === "function") options.onRunStarted({ runId, sessionId });

  let preparedContextUsage = null;
  const announceContext = (contextUsage) => {
    preparedContextUsage = contextUsage;
    if (typeof options.onContextPrepared === "function") options.onContextPrepared(contextUsage);
  };
  const initialRuntime = cursorProviderRequested(effectiveBody)
    ? "cursor-sdk"
    : runState.ai.models.publicState().runtime || "deterministic-fallback";
  if (["cursor-sdk", "deterministic-fallback"].includes(initialRuntime)) {
    announceContext(contextUsageForRuntime(initialRuntime, {
      runId,
      sessionId,
      status: "prepared",
      messages: [{ role: "user", content: message }],
      components: [{ key: "request", originalChars: message.length, includedChars: message.length, truncated: false }]
    }));
  }

  try {
    const rawResult = await createAgentMessageResponse(runState, effectiveBody, {
      signal: controller.signal,
      onContextPrepared: announceContext
    });
    if (runControl.cancelled || controller.signal.aborted) {
      throw aiRunError("AI_RUN_CANCELLED", "AI response was cancelled.", 409, { runId, sessionId });
    }
    const result = agentResultForIdentity(rawResult, identity);
    const runtime = result.runtime || initialRuntime;
    const contextUsage = result.contextUsage || contextUsageForRuntime(runtime, {
      runId,
      sessionId,
      status: "complete",
      messages: [{ role: "user", content: message }],
      components: [{ key: "request", originalChars: message.length, includedChars: message.length, truncated: false }]
    });
    if (!preparedContextUsage) announceContext(contextUsage);
    const proposals = Array.isArray(result.proposals) ? result.proposals : [];
    const assistantMessage = {
      id: `assistant-${runId}`,
      role: "assistant",
      message: result.reply || "I prepared a response.",
      proposals,
      approvalCards: proposals
        .filter((proposal) => proposal.status === "proposed" && proposal.approvalRequired !== false)
        .map((proposal) => proposal.id),
      runId,
      createdAt: Date.now()
    };
    const completedSnapshot = sessionStore.finalizeRun(runProject, sessionId, {
      runId,
      assistantMessage,
      contextUsage,
      metadata,
      result
    });
    const completedSummary = completedSnapshot.sessions.find((session) => session.id === sessionId);
    return {
      ...result,
      runId,
      sessionId,
      assistantMessage,
      sessionRevision: completedSummary?.revision || null,
      contextUsage
    };
  } catch (error) {
    if (runControl.cancelled || controller.signal.aborted || error?.code === "AI_RUN_CANCELLED") {
      sessionStore.cancelRun(runProject, sessionId, { runId });
      throw aiRunError("AI_RUN_CANCELLED", "AI response was cancelled.", 409, { runId, sessionId });
    }
    const failedContextUsage = preparedContextUsage
      ? { ...preparedContextUsage, status: preparedContextUsage.status === "not_applicable" ? "not_applicable" : "failed" }
      : contextUsageForRuntime(initialRuntime, {
        runId,
        sessionId,
        status: "failed",
        messages: [{ role: "user", content: message }]
      });
    sessionStore.failRun(runProject, sessionId, { runId, contextUsage: failedContextUsage });
    throw error;
  } finally {
    if (state.ai.runControllers.get(controllerKey) === runControl) {
      state.ai.runControllers.delete(controllerKey);
    }
  }
}

function createdFileDiff(content) {
  const lines = String(content || "").split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) return [];
  return [{
    oldStart: 0,
    newStart: 1,
    lines: lines.map((text, index) => ({ type: "added", lineNumber: index + 1, text }))
  }];
}

function publicProposal(proposal) {
  return {
    id: proposal.id,
    runId: proposal.runId || "",
    sessionId: proposal.sessionId || "",
    operation: proposal.operation === "create" ? "create" : "edit",
    actionable: true,
    hostApprovalRequired: proposal.hostApprovalRequired === true || proposal.operation === "create",
    path: proposal.path,
    baseHash: proposal.baseHash,
    newHash: proposal.newHash || textHash(proposal.newText || ""),
    replacements: proposal.replacements,
    newText: proposal.newText,
    status: proposal.status,
    summary: proposal.summary,
    userRequest: proposal.userRequest || "",
    provider: proposal.provider || null,
    modelId: proposal.modelId || "",
    requester: proposal.requester || null,
    approvalRequired: proposal.approvalRequired !== false,
    diffHunks: proposal.operation === "create"
      ? createdFileDiff(proposal.newText || "")
      : compactLineDiff(proposal.originalText || "", proposal.newText || ""),
    focus: proposal.focus || firstChangedRange(proposal.originalText || "", proposal.newText || ""),
    createdAt: proposal.createdAt,
    appliedAt: proposal.appliedAt || null,
    rejectedAt: proposal.rejectedAt || null,
    revertedAt: proposal.revertedAt || null
  };
}

function recordAiProposalChange(state, proposal) {
  if (!state.ai.changes || !proposal?.id || proposal.skipChangeLog) return;
  try {
    const originProject = proposal.projectRoot
      ? { root: proposal.projectRoot, name: proposal.projectName || path.basename(proposal.projectRoot) }
      : state.project;
    state.ai.changes.upsert(originProject, publicProposal(proposal));
  } catch {
    // Change history is useful for review, but it should not block safe file application.
  }
}

function applyAgentProposalAndBroadcast(state, proposal) {
  const applied = applyAiProposalToFile(state, proposal);
  const actorId = proposal.requester?.userId || "host";
  const actorName = proposal.requester?.userName ? `${proposal.requester.userName} via LocalLeaf AI` : "LocalLeaf AI";
  broadcastCollab(state, {
    type: "file_updated",
    filePath: proposal.path,
    newText: proposal.newText,
    userId: actorId,
    name: actorName,
    version: applied.version
  });
  broadcastProject(state, "file-update", {
    path: proposal.path,
    content: proposal.newText,
    user: actorName,
    version: applied.version
  });
  broadcastState(state);
  return applied;
}

function applyAiProposalToFile(state, proposal) {
  assertAiProposalProject(state, proposal);
  if (proposal.operation === "create") {
    const { fullPath, cleanText } = validateAiCreatedFile(state, proposal.path, proposal.newText);
    if (fs.existsSync(fullPath)) {
      proposal.status = "stale";
      recordAiProposalChange(state, proposal);
      const error = new Error("A file now exists at the path proposed by LocalLeaf AI.");
      error.statusCode = 409;
      error.proposal = publicProposal(proposal);
      throw error;
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    try {
      const checkedPath = validateAiCreatedFile(state, proposal.path, cleanText).fullPath;
      writeNewTextFileExclusive(checkedPath, cleanText);
    } catch (error) {
      if (error?.code === "EEXIST") {
        proposal.status = "stale";
        recordAiProposalChange(state, proposal);
        const conflict = new Error("A file was created at this path before the AI proposal could be applied.");
        conflict.statusCode = 409;
        conflict.proposal = publicProposal(proposal);
        throw conflict;
      }
      throw error;
    }
    proposal.status = "applied";
    proposal.appliedAt = Date.now();
    proposal.newHash = textHash(cleanText);
    refreshProject(state);
    recordAiProposalChange(state, proposal);
    return {
      version: Date.now(),
      proposal: publicProposal(proposal)
    };
  }
  const fullPath = resolveProjectPath(state.project.root, proposal.path);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    const error = new Error("Proposal target file was not found.");
    error.statusCode = 404;
    throw error;
  }
  if (!isTextFile(fullPath)) {
    const error = new Error("LocalLeaf AI proposals can only edit text files.");
    error.statusCode = 400;
    throw error;
  }
  const currentText = fs.readFileSync(fullPath, "utf8");
  if (textHash(currentText) !== proposal.baseHash) {
    proposal.status = "stale";
    recordAiProposalChange(state, proposal);
    const error = new Error("File changed since this AI proposal was created.");
    error.statusCode = 409;
    error.proposal = publicProposal(proposal);
    throw error;
  }
  fs.writeFileSync(fullPath, proposal.newText, "utf8");
  proposal.status = "applied";
  proposal.appliedAt = Date.now();
  proposal.newHash = textHash(proposal.newText || "");
  refreshProject(state);
  recordAiProposalChange(state, proposal);
  return {
    version: Date.now(),
    proposal: publicProposal(proposal)
  };
}

function validateProposalRevertTarget(state, proposal) {
  assertAiProposalProject(state, proposal);
  const fullPath = resolveProjectPath(state.project.root, proposal.path);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    const error = new Error("Proposal target file was not found.");
    error.statusCode = 404;
    throw error;
  }
  if (!isTextFile(fullPath)) {
    const error = new Error("LocalLeaf AI proposals can only revert text files.");
    error.statusCode = 400;
    throw error;
  }
  const currentText = fs.readFileSync(fullPath, "utf8");
  const expectedHash = proposal.newHash || textHash(proposal.newText || "");
  if (textHash(currentText) !== expectedHash) {
    proposal.status = "stale";
    recordAiProposalChange(state, proposal);
    const error = new Error("File changed since this AI proposal was applied.");
    error.statusCode = 409;
    error.proposal = publicProposal(proposal);
    throw error;
  }
  return { fullPath, currentText, removeOnRevert: proposal.operation === "create" };
}

function revertAiProposalToFile(state, proposal) {
  const { fullPath, removeOnRevert } = validateProposalRevertTarget(state, proposal);
  if (removeOnRevert) {
    fs.unlinkSync(fullPath);
    if (state.project.mainFile === proposal.path) state.project.mainFile = detectMainFile(state.project.root);
  }
  else fs.writeFileSync(fullPath, proposal.originalText || "", "utf8");
  proposal.status = "reverted";
  proposal.revertedAt = Date.now();
  refreshProject(state);
  recordAiProposalChange(state, proposal);
  return {
    version: Date.now(),
    proposal: publicProposal(proposal)
  };
}

function revertAgentProposalAndBroadcast(state, proposal) {
  const reverted = revertAiProposalToFile(state, proposal);
  const actorId = proposal.requester?.userId || "host";
  const actorName = proposal.requester?.userName ? `${proposal.requester.userName} via LocalLeaf AI` : "LocalLeaf AI";
  if (proposal.operation !== "create") {
    broadcastCollab(state, {
      type: "file_updated",
      filePath: proposal.path,
      newText: proposal.originalText || "",
      userId: actorId,
      name: actorName,
      version: reverted.version
    });
    broadcastProject(state, "file-update", {
      path: proposal.path,
      content: proposal.originalText || "",
      user: actorName,
      version: reverted.version
    });
  }
  broadcastState(state);
  return reverted;
}

function revertAiRunAtomically(state, proposals) {
  const targets = proposals.map((proposal) => ({
    proposal,
    ...validateProposalRevertTarget(state, proposal)
  }));
  const written = [];

  try {
    for (const target of targets) {
      if (target.removeOnRevert) fs.unlinkSync(target.fullPath);
      else fs.writeFileSync(target.fullPath, target.proposal.originalText || "", "utf8");
      written.push(target);
    }
  } catch (writeError) {
    const rollbackErrors = [];
    for (const target of written.reverse()) {
      try {
        if (target.removeOnRevert) {
          fs.mkdirSync(path.dirname(target.fullPath), { recursive: true });
          writeNewTextFileExclusive(target.fullPath, target.currentText);
        } else {
          fs.writeFileSync(target.fullPath, target.currentText, "utf8");
        }
      } catch (rollbackError) {
        rollbackErrors.push({ path: target.proposal.path, error: rollbackError });
      }
    }

    const error = new Error(
      rollbackErrors.length
        ? `The AI run could not be undone, and ${rollbackErrors.length} file${rollbackErrors.length === 1 ? "" : "s"} could not be restored. Close the editor and recover those files from version control or a backup before continuing.`
        : "The AI run could not be undone. LocalLeaf restored every file to its pre-undo content."
    );
    error.statusCode = 500;
    error.cause = writeError;
    error.rollbackErrors = rollbackErrors;
    throw error;
  }

  const revertedAt = Date.now();
  const version = Date.now();
  for (const target of targets) {
    target.proposal.status = "reverted";
    target.proposal.revertedAt = revertedAt;
  }
  if (targets.some((target) => target.removeOnRevert && state.project.mainFile === target.proposal.path)) {
    state.project.mainFile = detectMainFile(state.project.root);
  }
  refreshProject(state);
  for (const target of targets) recordAiProposalChange(state, target.proposal);

  for (const target of targets) {
    const actorId = target.proposal.requester?.userId || "host";
    const actorName = target.proposal.requester?.userName
      ? `${target.proposal.requester.userName} via LocalLeaf AI`
      : "LocalLeaf AI";
    if (!target.removeOnRevert) {
      broadcastCollab(state, {
        type: "file_updated",
        filePath: target.proposal.path,
        newText: target.proposal.originalText || "",
        userId: actorId,
        name: actorName,
        version
      });
      broadcastProject(state, "file-update", {
        path: target.proposal.path,
        content: target.proposal.originalText || "",
        user: actorName,
        version
      });
    }
  }
  broadcastState(state);

  return targets.map(({ proposal }) => publicProposal(proposal));
}

function rejectAiProposal(state, proposal) {
  assertAiProposalProject(state, proposal);
  proposal.status = "rejected";
  proposal.rejectedAt = Date.now();
  recordAiProposalChange(state, proposal);
  return publicProposal(proposal);
}

function sourcePathFromSynctexInput(projectRoot, inputPath, sourceSnapshotRoot = "") {
  const raw = String(inputPath || "").trim();
  if (!raw) return "";
  const root = path.resolve(projectRoot);
  const absoluteInput = path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw);
  const absolute = absoluteInput ? path.resolve(raw) : path.resolve(root, raw);
  const roots = [
    { sourceRoot: root, targetRoot: root },
    ...(sourceSnapshotRoot
      ? [{ sourceRoot: path.resolve(sourceSnapshotRoot), targetRoot: root }]
      : [])
  ];

  for (const candidate of roots) {
    const sourceRootWithSeparator = candidate.sourceRoot.endsWith(path.sep)
      ? candidate.sourceRoot
      : `${candidate.sourceRoot}${path.sep}`;
    if (absolute !== candidate.sourceRoot && !absolute.startsWith(sourceRootWithSeparator)) continue;
    const relative = path.relative(candidate.sourceRoot, absolute);
    const target = path.resolve(candidate.targetRoot, relative);
    const targetRootWithSeparator = candidate.targetRoot.endsWith(path.sep)
      ? candidate.targetRoot
      : `${candidate.targetRoot}${path.sep}`;
    if (target !== candidate.targetRoot && !target.startsWith(targetRootWithSeparator)) continue;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile() || !isTextFile(target)) continue;
    return relative.replace(/\\/g, "/");
  }
  return "";
}

function parseSynctexEditOutput(state, output) {
  const text = String(output || "");
  const input = text.match(/^Input:\s*(.+)$/imu)?.[1] || "";
  const line = Number.parseInt(text.match(/^Line:\s*(\d+)$/imu)?.[1] || "0", 10);
  const columnMatch = text.match(/^Column:\s*(-?\d+)$/imu);
  const column = columnMatch ? Math.max(0, Number.parseInt(columnMatch[1] || "0", 10)) : 0;
  const relativePath = sourcePathFromSynctexInput(
    state.project.root,
    input,
    state.compile.sourceSnapshotRoot
  );
  if (!relativePath || !Number.isFinite(line) || line < 1) return null;
  return {
    ok: true,
    path: relativePath,
    line,
    column
  };
}

function normalizePdfSourceResult(state, result) {
  if (!result?.ok) {
    return { ok: false, reason: result?.reason || "PDF source position could not be mapped." };
  }
  const relativePath = sourcePathFromSynctexInput(
    state.project.root,
    result.path,
    state.compile.sourceSnapshotRoot
  );
  const line = Number.parseInt(result.line, 10);
  const column = Math.max(0, Number.parseInt(result.column || 0, 10) || 0);
  if (!relativePath || !Number.isFinite(line) || line < 1) {
    return { ok: false, reason: "That PDF location is not mapped to editable project source." };
  }
  return { ok: true, path: relativePath, line, column };
}

function synctexCommand(state) {
  if (state?.synctexCommand) return state.synctexCommand;
  const candidates = [
    process.env.LOCALLEAF_SYNCTEX_PATH,
    path.join(ROOT, "bin", process.platform === "win32" ? "synctex.exe" : "synctex"),
    process.resourcesPath ? path.join(process.resourcesPath, "bin", process.platform === "win32" ? "synctex.exe" : "synctex") : ""
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Continue to PATH fallback.
    }
  }
  return "synctex";
}

function runBoundedChildProcess(command, args = [], options = {}) {
  const timeoutMs = Math.max(25, Math.min(30000, Number(options.timeoutMs) || SYNCTEX_LOOKUP_TIMEOUT_MS));
  const killGraceMs = Math.max(25, Math.min(5000, Number(options.killGraceMs) || 500));
  const maxOutputBytes = Math.max(
    1024,
    Math.min(1024 * 1024, Number(options.maxOutputBytes) || SYNCTEX_LOOKUP_MAX_OUTPUT_BYTES)
  );
  const spawnImpl = typeof options.spawnImpl === "function" ? options.spawnImpl : spawn;
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    let timer = null;
    let killTimer = null;
    let terminationResult = null;

    const finish = (result = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ok: Boolean(result.ok),
        timedOut: Boolean(result.timedOut),
        outputLimitExceeded: Boolean(result.outputLimitExceeded),
        spawnFailed: Boolean(result.spawnFailed),
        killGraceExpired: Boolean(result.killGraceExpired),
        errorCode: result.errorCode ? String(result.errorCode) : "",
        exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
        signal: result.signal ? String(result.signal) : "",
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    };

    const requestTermination = (result) => {
      if (settled || terminationResult) return;
      terminationResult = result;
      if (timer) clearTimeout(timer);
      try {
        child?.kill?.("SIGKILL");
      } catch {
        // The bounded grace timer below prevents a platform-specific kill failure from hanging forever.
      }
      killTimer = setTimeout(() => {
        try {
          child?.kill?.("SIGKILL");
        } catch {
          // Resolve with the original bounded failure after the final kill attempt.
        }
        child?.stdout?.destroy?.();
        child?.stderr?.destroy?.();
        finish({ ...terminationResult, killGraceExpired: true });
      }, killGraceMs);
    };

    const collect = (target, chunk) => {
      if (settled || terminationResult) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxOutputBytes - outputBytes;
      if (remaining > 0) target.push(data.subarray(0, remaining));
      outputBytes += data.length;
      if (outputBytes <= maxOutputBytes) return;
      requestTermination({ outputLimitExceeded: true });
    };

    try {
      child = spawnImpl(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      finish({ spawnFailed: true, errorCode: error?.code || "SPAWN_ERROR" });
      return;
    }

    child.stdout?.on("data", (chunk) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (terminationResult) return;
      if (!child?.pid) {
        finish({ spawnFailed: true, errorCode: error?.code || "SPAWN_ERROR" });
        return;
      }
      requestTermination({ spawnFailed: true, errorCode: error?.code || "PROCESS_ERROR" });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        ...(terminationResult || {}),
        ok: !terminationResult && exitCode === 0,
        exitCode,
        signal
      });
    });
    timer = setTimeout(() => {
      requestTermination({ timedOut: true });
    }, timeoutMs);
  });
}

function pdfSourceLookupReadiness(state, input = {}) {
  const page = Number(input.page);
  const x = Number(input.x);
  const y = Number(input.y);
  if (
    !Number.isFinite(page)
    || page < 1
    || !Number.isFinite(x)
    || x < 0
    || !Number.isFinite(y)
    || y < 0
  ) {
    return { ok: false, state: "unavailable", reason: "A valid PDF page and coordinates are required." };
  }

  const requestedArtifactId = String(input.artifactId || "").trim();
  const currentArtifactId = String(state.compile.artifactId || "").trim();
  const hasRequestedVersion = Object.hasOwn(input, "version") && input.version !== "" && input.version !== null;
  const requestedVersion = hasRequestedVersion ? Number(input.version) : null;
  const versionMismatch = hasRequestedVersion
    && Number.isFinite(requestedVersion)
    && requestedVersion !== Number(state.compile.version || 0);
  if (
    (requestedArtifactId && requestedArtifactId !== currentArtifactId)
    || (!requestedArtifactId && versionMismatch)
  ) {
    return {
      ok: false,
      state: "stale",
      retryable: true,
      reason: "The PDF preview changed before this source location was mapped. Click the current preview again."
    };
  }

  if (!isValidPdfArtifact(state.compile.pdfPath)) {
    if (state.compile.status === "running") {
      return {
        ok: false,
        state: "pending",
        retryable: true,
        reason: "The first PDF is still compiling. Try this click again when the preview is ready."
      };
    }
    return { ok: false, state: "unavailable", reason: "Compile the project to PDF first." };
  }
  if (!state.compile.synctexPath || !fs.existsSync(state.compile.synctexPath)) {
    return {
      ok: false,
      state: "unavailable",
      reason: "SyncTeX data is not available for this PDF. Recompile with SyncTeX support."
    };
  }
  return {
    ok: true,
    page,
    x,
    y,
    previewState: state.compile.status === "running"
      ? "pending"
      : state.compile.isStale
        ? "stale"
        : ""
  };
}

function pdfSourceResultForPreview(result, readiness) {
  if (!result?.ok || !readiness.previewState) return result;
  return { ...result, previewState: readiness.previewState };
}

function pdfSourceLookupSnapshot(state) {
  return {
    projectId: state.project.id,
    artifactId: String(state.compile.artifactId || ""),
    pdfPath: state.compile.pdfPath || "",
    synctexPath: state.compile.synctexPath || "",
    mappingState: {
      project: { root: state.project.root },
      compile: { sourceSnapshotRoot: state.compile.sourceSnapshotRoot }
    }
  };
}

function pdfSourceLookupSnapshotIsCurrent(state, snapshot) {
  return state.project.id === snapshot.projectId
    && String(state.compile.artifactId || "") === snapshot.artifactId
    && String(state.compile.pdfPath || "") === snapshot.pdfPath
    && String(state.compile.synctexPath || "") === snapshot.synctexPath;
}

function stalePdfSourceLookupResult() {
  return {
    ok: false,
    state: "stale",
    retryable: true,
    reason: "The PDF preview changed before this source location was mapped. Click the current preview again."
  };
}

async function resolvePdfSourcePosition(state, input = {}) {
  const readiness = pdfSourceLookupReadiness(state, input);
  if (!readiness.ok) return readiness;
  const lookupSnapshot = pdfSourceLookupSnapshot(state);
  if (typeof state.synctexResolver === "function") {
    try {
      const result = await state.synctexResolver({
        page: readiness.page,
        x: readiness.x,
        y: readiness.y,
        pdfPath: state.compile.pdfPath,
        synctexPath: state.compile.synctexPath,
        projectRoot: state.project.root
      });
      if (!pdfSourceLookupSnapshotIsCurrent(state, lookupSnapshot)) return stalePdfSourceLookupResult();
      return pdfSourceResultForPreview(normalizePdfSourceResult(lookupSnapshot.mappingState, result), readiness);
    } catch {
      return { ok: false, state: "unavailable", reason: "SyncTeX lookup failed on the host." };
    }
  }
  const { page, x, y } = readiness;
  const command = synctexCommand(state);
  if (!command) {
    return { ok: false, state: "unavailable", reason: "SyncTeX command was not found on this computer." };
  }
  const outputArg = `${Math.round(page)}:${Math.round(x)}:${Math.round(y)}:${state.compile.pdfPath}`;
  const lookupTracker = state.synctexLookups;
  if (lookupTracker.active >= lookupTracker.maxActive) {
    return {
      ok: false,
      state: "busy",
      retryable: true,
      reason: "The host is already handling several PDF source lookups. Try this click again in a moment."
    };
  }
  lookupTracker.active += 1;
  let result;
  let bundledResult = null;
  let runnerFailed = false;
  try {
    try {
      result = await state.synctexProcessRunner({
        command,
        args: ["edit", "-o", outputArg],
        cwd: state.project.root,
        timeoutMs: SYNCTEX_LOOKUP_TIMEOUT_MS,
        maxOutputBytes: SYNCTEX_LOOKUP_MAX_OUTPUT_BYTES,
        page,
        x,
        y
      });
    } catch {
      runnerFailed = true;
      result = null;
    }
    if (!pdfSourceLookupSnapshotIsCurrent(state, lookupSnapshot)) return stalePdfSourceLookupResult();
    if (result?.ok) {
      const parsed = parseSynctexEditOutput(lookupSnapshot.mappingState, `${result.stdout || ""}\n${result.stderr || ""}`);
      if (parsed) return pdfSourceResultForPreview(parsed, readiness);
    }

    bundledResult = await state.synctexWorkerClient.lookup({
      synctexPath: lookupSnapshot.synctexPath,
      page,
      x,
      y
    });
    if (!pdfSourceLookupSnapshotIsCurrent(state, lookupSnapshot)) return stalePdfSourceLookupResult();
    if (bundledResult?.ok) {
      return pdfSourceResultForPreview(
        normalizePdfSourceResult(lookupSnapshot.mappingState, bundledResult),
        readiness
      );
    }
  } catch {
    runnerFailed = true;
  } finally {
    lookupTracker.active = Math.max(0, lookupTracker.active - 1);
  }
  if (bundledResult?.code === "WORKER_TIMEOUT") {
    return {
      ok: false,
      state: "unavailable",
      retryable: true,
      reason: "The bundled SyncTeX lookup timed out on the host. Try again or recompile the PDF."
    };
  }
  if (["WORKER_ERROR", "WORKER_EXIT", "WORKER_PROTOCOL_ERROR", "WORKER_RESTARTED"].includes(bundledResult?.code)) {
    return {
      ok: false,
      state: "unavailable",
      retryable: true,
      reason: "The bundled SyncTeX reader restarted. Try this PDF location again."
    };
  }
  if (runnerFailed) {
    return { ok: false, state: "unavailable", reason: "SyncTeX lookup failed on the host." };
  }
  if (result?.timedOut) {
    return {
      ok: false,
      state: "unavailable",
      retryable: true,
      reason: "SyncTeX lookup timed out on the host. Try again or recompile the PDF."
    };
  }
  if (result?.outputLimitExceeded) {
    return { ok: false, state: "unavailable", reason: "SyncTeX lookup returned too much output on the host." };
  }
  if (result?.spawnFailed) {
    return { ok: false, state: "unavailable", reason: "SyncTeX lookup could not start on the host." };
  }
  if (!result?.ok) {
    return { ok: false, state: "unavailable", reason: "SyncTeX could not map that PDF location." };
  }
  return { ok: false, reason: "That PDF location is not mapped to editable source." };
}

function parseSynctexViewOutput(output) {
  const values = ["Page", "x", "y", "h", "v", "W", "H"];
  const required = new Set(values);
  let record = null;

  function normalizedRecord(candidate) {
    if (!candidate || [...required].some((key) => candidate[key] === undefined)) return null;
    const page = Number(candidate.Page);
    const height = Number(candidate.H);
    const x = Number(candidate.h);
    const y = Number(candidate.v) - height;
    const width = Number(candidate.W);
    if (
      !Number.isSafeInteger(page)
      || page < 1
      || ![x, y, Number(candidate.h), Number(candidate.v), width, height].every(Number.isFinite)
      || width < 0
      || height < 0
    ) {
      return null;
    }
    return { ok: true, page, x, y, width, height };
  }

  for (const line of String(output || "").split(/\r?\n/u)) {
    const match = /^\s*(Page|x|y|h|v|W|H):\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key === "Page") {
      const completed = normalizedRecord(record);
      if (completed) return completed;
      record = {};
    }
    if (!record) continue;
    if (record[key] === undefined) record[key] = Number(rawValue);
    if (values.every((field) => record[field] !== undefined)) {
      const completed = normalizedRecord(record);
      if (completed) return completed;
    }
  }
  return normalizedRecord(record);
}

function normalizePdfOutputResult(result) {
  if (!result?.ok) {
    return { ok: false, reason: result?.reason || "Source position could not be mapped to the PDF." };
  }
  const page = Number(result.page);
  const x = Number(result.x ?? result.h);
  const y = Number(result.y ?? result.v);
  const width = Number(result.width ?? result.W ?? 0);
  const height = Number(result.height ?? result.H ?? 0);
  if (
    !Number.isSafeInteger(page)
    || page < 1
    || !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(width)
    || width < 0
    || !Number.isFinite(height)
    || height < 0
  ) {
    return { ok: false, reason: "SyncTeX returned an invalid PDF position." };
  }
  return { ok: true, page, x, y, width, height };
}

function pdfOutputLookupReadiness(state, input = {}) {
  const rawPath = String(input.relativePath || input.path || input.sourcePath || "").trim();
  if (!rawPath || path.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/u.test(rawPath)) {
    return { ok: false, state: "unavailable", reason: "Choose an editable project file to review." };
  }

  let relativePath;
  let projectSourcePath;
  try {
    relativePath = normalizeRelativePath(rawPath);
    projectSourcePath = resolveProjectPath(state.project.root, relativePath);
  } catch {
    return { ok: false, state: "unavailable", reason: "That source path is outside the editable project." };
  }
  if (
    !relativePath
    || !fs.existsSync(projectSourcePath)
    || !fs.statSync(projectSourcePath).isFile()
    || !isTextFile(projectSourcePath)
  ) {
    return { ok: false, state: "unavailable", reason: "That source path is not an editable project file." };
  }

  const line = Number(input.line);
  const column = input.column === undefined || input.column === null ? 0 : Number(input.column);
  if (
    !Number.isSafeInteger(line)
    || line < 1
    || !Number.isSafeInteger(column)
    || column < 0
  ) {
    return { ok: false, state: "unavailable", reason: "A valid source line and column are required." };
  }

  const requestedArtifactId = String(input.artifactId || "").trim();
  const currentArtifactId = String(state.compile.artifactId || "").trim();
  if (requestedArtifactId.length > 256) {
    return { ok: false, state: "unavailable", reason: "The PDF artifact identifier is invalid." };
  }
  const hasRequestedVersion = Object.hasOwn(input, "version") && input.version !== "" && input.version !== null;
  const requestedVersion = hasRequestedVersion ? Number(input.version) : null;
  if (hasRequestedVersion && (!Number.isSafeInteger(requestedVersion) || requestedVersion < 0)) {
    return { ok: false, state: "unavailable", reason: "The PDF version is invalid." };
  }
  if (
    (requestedArtifactId && requestedArtifactId !== currentArtifactId)
    || (!requestedArtifactId && hasRequestedVersion && requestedVersion !== Number(state.compile.version || 0))
  ) {
    return {
      ok: false,
      state: "stale",
      retryable: true,
      reason: "The PDF preview changed before this review location was mapped. Review the current PDF again."
    };
  }

  if (!isValidPdfArtifact(state.compile.pdfPath)) {
    if (state.compile.status === "running") {
      return {
        ok: false,
        state: "pending",
        retryable: true,
        reason: "The first PDF is still compiling. Review this change when the preview is ready."
      };
    }
    return { ok: false, state: "unavailable", reason: "Compile the project to PDF before reviewing this change." };
  }
  if (!state.compile.synctexPath || !fs.existsSync(state.compile.synctexPath)) {
    return {
      ok: false,
      state: "unavailable",
      recompileRequired: true,
      reason: "SyncTeX data is unavailable for this PDF. Recompile before reviewing this change."
    };
  }

  const sourceSnapshotRoot = String(state.compile.sourceSnapshotRoot || "").trim();
  if (!sourceSnapshotRoot || !fs.existsSync(sourceSnapshotRoot) || !fs.statSync(sourceSnapshotRoot).isDirectory()) {
    return {
      ok: false,
      state: "unavailable",
      recompileRequired: true,
      reason: "The compiled source snapshot is unavailable. Recompile before reviewing this change."
    };
  }
  let sourcePath;
  try {
    sourcePath = resolveProjectPath(sourceSnapshotRoot, relativePath);
  } catch {
    return { ok: false, state: "unavailable", reason: "The compiled source path is invalid." };
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile() || !isTextFile(sourcePath)) {
    return {
      ok: false,
      state: "unavailable",
      recompileRequired: true,
      reason: "This file is not present in the displayed PDF snapshot. Recompile before reviewing this change."
    };
  }

  const expectedSourceHash = String(input.expectedSourceHash || "").trim().toLowerCase();
  if (expectedSourceHash && !/^[a-f0-9]{64}$/u.test(expectedSourceHash)) {
    return { ok: false, state: "unavailable", reason: "The expected source version is invalid." };
  }
  return {
    ok: true,
    relativePath,
    sourcePath,
    sourceSnapshotRoot,
    line,
    column,
    expectedSourceHash,
    previewState: state.compile.status === "running"
      ? "pending"
      : state.compile.isStale
        ? "stale"
        : ""
  };
}

function pdfOutputLookupSnapshot(state, readiness) {
  return {
    projectId: state.project.id,
    artifactId: String(state.compile.artifactId || ""),
    version: Number(state.compile.version || 0),
    pdfPath: state.compile.pdfPath || "",
    synctexPath: state.compile.synctexPath || "",
    sourceSnapshotRoot: readiness.sourceSnapshotRoot,
    sourcePath: readiness.sourcePath,
    relativePath: readiness.relativePath,
    line: readiness.line,
    column: readiness.column
  };
}

function pdfOutputLookupSnapshotIsCurrent(state, snapshot) {
  return state.project.id === snapshot.projectId
    && String(state.compile.artifactId || "") === snapshot.artifactId
    && String(state.compile.pdfPath || "") === snapshot.pdfPath
    && String(state.compile.synctexPath || "") === snapshot.synctexPath
    && String(state.compile.sourceSnapshotRoot || "") === snapshot.sourceSnapshotRoot;
}

function stalePdfOutputLookupResult() {
  return {
    ok: false,
    state: "stale",
    retryable: true,
    reason: "The PDF preview changed before this review location was mapped. Review the current PDF again."
  };
}

function sourceHashMismatchResult(readiness) {
  return {
    ok: false,
    state: readiness.previewState === "pending" ? "pending" : "stale",
    retryable: true,
    recompileRequired: true,
    reason: "The displayed PDF was compiled from a different version of this file. Recompile before reviewing this change."
  };
}

function pdfOutputSuccess(result, readiness, snapshot) {
  const mapped = normalizePdfOutputResult(result);
  if (!mapped.ok) return mapped;
  return {
    ...mapped,
    path: snapshot.relativePath,
    line: snapshot.line,
    column: snapshot.column,
    artifactId: snapshot.artifactId,
    version: snapshot.version,
    ...(readiness.previewState ? { previewState: readiness.previewState } : {})
  };
}

async function resolvePdfOutputPosition(state, input = {}) {
  const readiness = pdfOutputLookupReadiness(state, input);
  if (!readiness.ok) return readiness;
  const lookupSnapshot = pdfOutputLookupSnapshot(state, readiness);
  const lookupTracker = state.synctexLookups;
  if (lookupTracker.active >= lookupTracker.maxActive) {
    return {
      ok: false,
      state: "busy",
      retryable: true,
      reason: "The host is already handling several PDF lookups. Try Review again in a moment."
    };
  }
  lookupTracker.active += 1;

  try {
  let snapshotHash;
  try {
    const beforeStat = await fs.promises.stat(lookupSnapshot.sourcePath, { bigint: true });
    if (!beforeStat.isFile()) throw new Error("Compiled source snapshot is not a file.");
    const snapshotBytes = await fs.promises.readFile(lookupSnapshot.sourcePath);
    const afterStat = await fs.promises.stat(lookupSnapshot.sourcePath, { bigint: true });
    if (
      !afterStat.isFile()
      || beforeStat.size !== afterStat.size
      || beforeStat.mtimeNs !== afterStat.mtimeNs
    ) {
      return {
        ok: false,
        state: "stale",
        retryable: true,
        recompileRequired: true,
        reason: "The compiled source snapshot changed unexpectedly. Recompile before reviewing this change."
      };
    }
    snapshotHash = crypto.createHash("sha256").update(snapshotBytes).digest("hex");
  } catch {
    if (!pdfOutputLookupSnapshotIsCurrent(state, lookupSnapshot)) return stalePdfOutputLookupResult();
    return {
      ok: false,
      state: "unavailable",
      recompileRequired: true,
      reason: "The compiled source snapshot could not be read. Recompile before reviewing this change."
    };
  }
  if (!pdfOutputLookupSnapshotIsCurrent(state, lookupSnapshot)) return stalePdfOutputLookupResult();
  if (readiness.expectedSourceHash && snapshotHash !== readiness.expectedSourceHash) {
    return sourceHashMismatchResult(readiness);
  }

  if (typeof state.synctexForwardResolver === "function") {
    try {
      const result = await state.synctexForwardResolver({
        sourcePath: lookupSnapshot.sourcePath,
        relativePath: lookupSnapshot.relativePath,
        line: lookupSnapshot.line,
        column: lookupSnapshot.column,
        pdfPath: lookupSnapshot.pdfPath,
        synctexPath: lookupSnapshot.synctexPath,
        synctexDirectory: path.dirname(lookupSnapshot.synctexPath),
        sourceSnapshotRoot: lookupSnapshot.sourceSnapshotRoot,
        projectRoot: state.project.root,
        artifactId: lookupSnapshot.artifactId,
        version: lookupSnapshot.version
      });
      if (!pdfOutputLookupSnapshotIsCurrent(state, lookupSnapshot)) return stalePdfOutputLookupResult();
      return pdfOutputSuccess(result, readiness, lookupSnapshot);
    } catch {
      if (!pdfOutputLookupSnapshotIsCurrent(state, lookupSnapshot)) return stalePdfOutputLookupResult();
      return { ok: false, state: "unavailable", reason: "SyncTeX forward lookup failed on the host." };
    }
  }

  let result;
  let bundledResult = null;
  let runnerFailed = false;
  try {
    try {
      result = await state.synctexProcessRunner({
        command: synctexCommand(state),
        args: [
          "view",
          "-i",
          `${lookupSnapshot.line}:${lookupSnapshot.column}:${lookupSnapshot.sourcePath}`,
          "-o",
          lookupSnapshot.pdfPath,
          "-d",
          path.dirname(lookupSnapshot.synctexPath)
        ],
        cwd: lookupSnapshot.sourceSnapshotRoot,
        timeoutMs: SYNCTEX_LOOKUP_TIMEOUT_MS,
        maxOutputBytes: SYNCTEX_LOOKUP_MAX_OUTPUT_BYTES,
        sourcePath: lookupSnapshot.sourcePath,
        relativePath: lookupSnapshot.relativePath,
        line: lookupSnapshot.line,
        column: lookupSnapshot.column
      });
    } catch {
      runnerFailed = true;
      result = null;
    }
    if (!pdfOutputLookupSnapshotIsCurrent(state, lookupSnapshot)) return stalePdfOutputLookupResult();
    if (result?.ok) {
      const parsed = parseSynctexViewOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
      if (parsed) return pdfOutputSuccess(parsed, readiness, lookupSnapshot);
    }

    bundledResult = typeof state.synctexWorkerClient.lookupSource === "function"
      ? await state.synctexWorkerClient.lookupSource({
        synctexPath: lookupSnapshot.synctexPath,
        sourcePath: lookupSnapshot.sourcePath,
        relativePath: lookupSnapshot.relativePath,
        line: lookupSnapshot.line,
        column: lookupSnapshot.column
      })
      : { ok: false, code: "WORKER_PROTOCOL_ERROR" };
    if (!pdfOutputLookupSnapshotIsCurrent(state, lookupSnapshot)) return stalePdfOutputLookupResult();
    if (bundledResult?.ok) return pdfOutputSuccess(bundledResult, readiness, lookupSnapshot);
  } catch {
    runnerFailed = true;
  }

  if (bundledResult?.code === "WORKER_TIMEOUT") {
    return {
      ok: false,
      state: "unavailable",
      retryable: true,
      reason: "The bundled SyncTeX lookup timed out. Try Review again or recompile the PDF."
    };
  }
  if (["WORKER_ERROR", "WORKER_EXIT", "WORKER_PROTOCOL_ERROR", "WORKER_RESTARTED"].includes(bundledResult?.code)) {
    return {
      ok: false,
      state: "unavailable",
      retryable: true,
      reason: "The bundled SyncTeX reader restarted. Try Review again."
    };
  }
  if (runnerFailed) {
    return { ok: false, state: "unavailable", reason: "SyncTeX forward lookup failed on the host." };
  }
  if (result?.timedOut) {
    return {
      ok: false,
      state: "unavailable",
      retryable: true,
      reason: "SyncTeX lookup timed out. Try Review again or recompile the PDF."
    };
  }
  if (result?.outputLimitExceeded) {
    return { ok: false, state: "unavailable", reason: "SyncTeX lookup returned too much output on the host." };
  }
  if (result?.spawnFailed) {
    return { ok: false, state: "unavailable", reason: "SyncTeX lookup could not start on the host." };
  }
  return {
    ok: false,
    state: "unavailable",
    reason: "That source position is not mapped in the displayed PDF. Recompile if this change is new."
  };
  } finally {
    lookupTracker.active = Math.max(0, lookupTracker.active - 1);
  }
}

function setProjectRoot(state, projectRoot) {
  const root = path.resolve(projectRoot);
  const mainFile = detectMainFile(root);
  if (!mainFile) {
    throw new Error("Choose a LaTeX project folder that contains at least one .tex file.");
  }
  const nextProject = {
    id: randomId(6),
    name: path.basename(root),
    root,
    mainFile,
    files: listProjectFiles(root),
    size: getProjectSize(root)
  };
  retireCompileArtifact(state, state.compile.pdfPath);
  state.project = nextProject;
  state.compile = {
    ...state.compile,
    status: "idle",
    logs: ["[LocalLeaf] Project opened."],
    previewHtml: "",
    pdfPath: null,
    synctexPath: null,
    sourceMapAvailable: false,
    version: state.compile.version + 1,
    jobId: null,
    queuedJobs: 0,
    isStale: false,
    lastSuccessfulAt: null,
    lastSuccessfulVersion: 0,
    artifactId: null,
    artifactRoot: null,
    sourceSnapshotRoot: null
  };
}

function blockProjectSwitchWhileSharing(state, response) {
  if (state.session.status === "live") {
    jsonResponse(response, 409, {
      error: "Stop sharing before opening, creating, or importing another project."
    });
    return true;
  }
  if (state.ai?.runControllers?.size) {
    jsonResponse(response, 409, {
      error: "Stop the active AI response before opening, creating, or importing another project.",
      code: "AI_RUN_BUSY"
    });
    return true;
  }
  return false;
}

function serveStatic(request, response, pathname) {
  const cleanPath = pathname === "/" || pathname.startsWith("/join/") ? "/index.html" : pathname;
  const target = path.resolve(PUBLIC_DIR, cleanPath.replace(/^\/+/, ""));
  const publicRoot = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : `${PUBLIC_DIR}${path.sep}`;

  if (target !== PUBLIC_DIR && !target.startsWith(publicRoot)) {
    textResponse(response, 403, "Forbidden");
    return true;
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return false;
  }

  const ext = path.extname(target).toLowerCase();
  response.writeHead(200, {
    ...securityHeaders(),
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "cache-control": "no-store"
  });
  fs.createReadStream(target).pipe(response);
  return true;
}

function activeTunnelProviders(state) {
  return state.session.tunnel.providers || [];
}

function resolveTunnelProviderPreference(state, body = {}) {
  const provided = Object.prototype.hasOwnProperty.call(body, "providerId");
  if (!provided) {
    return {
      provided: false,
      providerId: state.session.tunnel.preferredProviderId || null
    };
  }
  if (body.providerId === null) {
    return { provided: true, providerId: null };
  }
  if (typeof body.providerId !== "string" || !body.providerId.trim()) {
    throw new Error("providerId must be a non-empty available provider ID or null for automatic selection.");
  }
  const providerId = body.providerId.trim();
  if (!activeTunnelProviders(state).some((provider) => provider.id === providerId)) {
    const availableIds = activeTunnelProviders(state).map((provider) => provider.id).join(", ");
    throw new Error(`Tunnel provider \"${providerId}\" is unavailable. Available providers: ${availableIds || "none"}.`);
  }
  return { provided: true, providerId };
}

function resetTunnelLink(state) {
  state.session.publicUrl = null;
  state.session.inviteUrl = null;
}

function recordTunnelAttempt(state, provider, status, detail) {
  state.session.tunnel.attempts = [
    ...(state.session.tunnel.attempts || []),
    {
      providerId: provider.id,
      providerName: provider.name,
      status,
      detail,
      createdAt: Date.now()
    }
  ].slice(-8);
}

function tunnelRunners(state) {
  if (!(state.session.tunnel.runners instanceof Map)) {
    state.session.tunnel.runners = new Map();
  }
  return state.session.tunnel.runners;
}

function createTunnelRunner(state, provider, baseUrl, raceId, restartAttempt) {
  const runner = {
    id: `${provider.id}-${randomId(4)}`,
    provider,
    baseUrl,
    raceId,
    challenge: randomId(12),
    restartAttempt,
    code: state.session.code,
    child: null,
    controller: null,
    startTimer: null,
    publicUrl: "",
    outputTail: "",
    stopped: false
  };
  tunnelRunners(state).set(provider.id, runner);
  return runner;
}

function raceStillActive(state, runner) {
  return (
    state.session.status === "live" &&
    state.session.code === runner.code &&
    state.session.tunnel.raceId === runner.raceId &&
    !state.session.inviteUrl &&
    !runner.stopped
  );
}

function stopTunnelRunner(runner) {
  if (!runner || runner.stopped) return;
  runner.stopped = true;
  if (runner.startTimer) {
    clearTimeout(runner.startTimer);
    runner.startTimer = null;
  }
  if (runner.child) {
    runner.child.stdout?.removeAllListeners("data");
    runner.child.stderr?.removeAllListeners("data");
    runner.child.removeAllListeners("error");
    runner.child.removeAllListeners("exit");
    runner.child.kill();
    runner.child = null;
  }
  if (runner.controller) {
    runner.controller.removeAllListeners?.("close");
    runner.controller.close?.();
    runner.controller = null;
  }
}

function stopLosingTunnelRunners(state, winnerProviderId) {
  for (const [providerId, runner] of tunnelRunners(state)) {
    if (providerId === winnerProviderId) continue;
    stopTunnelRunner(runner);
    tunnelRunners(state).delete(providerId);
  }
}

function startPublicTunnel(state, baseUrl, restartAttempt = 0, options = {}) {
  const availableProviders = activeTunnelProviders(state);
  const preferredProviderId = state.session.tunnel.preferredProviderId || null;
  const previousLinkInvalidated = options.previousLinkInvalidated === undefined
    ? Boolean(state.session.tunnel.previousLinkInvalidated)
    : Boolean(options.previousLinkInvalidated);
  const providers = preferredProviderId
    ? availableProviders.filter((provider) => provider.id === preferredProviderId)
    : availableProviders;
  if (!providers.length) {
    resetTunnelLink(state);
    state.session.tunnel.status = "Error";
    state.session.tunnel.detail = "No tunnel providers are available on this computer.";
    broadcastState(state);
    return;
  }

  stopPublicTunnel(state);
  resetTunnelLink(state);
  const raceId = randomId(5);
  state.session.tunnel.raceId = raceId;
  state.session.tunnel.runners = new Map();
  state.session.tunnel.providerId = null;
  state.session.tunnel.providerName = null;
  state.session.tunnel.selectionMode = preferredProviderId ? "preferred" : "automatic";
  state.session.tunnel.previousLinkInvalidated = previousLinkInvalidated;
  state.session.tunnel.status = "Starting";
  const startingDetail = preferredProviderId
    ? `${restartAttempt ? "Retrying" : "Starting"} selected tunnel provider: ${providers[0].name}`
    : restartAttempt
      ? `Racing tunnel providers again (${restartAttempt + 1}/${TUNNEL_RESTART_ATTEMPTS})`
      : `Racing tunnel providers: ${providers.map((provider) => provider.name).join(", ")}`;
  state.session.tunnel.detail = previousLinkInvalidated
    ? `Previous invite link was invalidated. ${startingDetail}`
    : startingDetail;
  broadcastState(state);

  for (const provider of providers) {
    startTunnelCandidate(state, provider, baseUrl, raceId, restartAttempt);
  }
}

function startTunnelCandidate(state, provider, baseUrl, raceId, restartAttempt) {
  if (provider.type === "localtunnel") {
    startLocalTunnelProvider(state, provider, baseUrl, raceId, restartAttempt);
    return;
  }

  startProcessTunnelProvider(state, provider, baseUrl, raceId, restartAttempt);
}

function startLocalTunnelProvider(state, provider, baseUrl, raceId, restartAttempt) {
  const runner = createTunnelRunner(state, provider, baseUrl, raceId, restartAttempt);
  runner.startTimer = setTimeout(() => {
    failTunnelCandidate(state, runner, `${provider.name} did not return a URL in time`);
  }, TUNNEL_START_TIMEOUT_MS);
  localtunnelClient({ port: state.port, local_host: "127.0.0.1" })
    .then((controller) => {
      clearTimeout(runner.startTimer);
      runner.startTimer = null;
      if (!raceStillActive(state, runner)) {
        controller.close?.();
        return;
      }
      runner.controller = controller;
      controller.on?.("close", () => {
        if (runner.stopped) return;
        runner.controller = null;
        if (state.session.tunnel.providerId === provider.id && state.session.inviteUrl) {
          handleWinningTunnelStopped(state, runner, "LocalTunnel connection closed");
          return;
        }
        failTunnelCandidate(state, runner, "LocalTunnel connection closed");
      });
      handleTunnelCandidateUrl(state, runner, controller.url);
    })
    .catch((error) => {
      clearTimeout(runner.startTimer);
      runner.startTimer = null;
      failTunnelCandidate(state, runner, error.message || "LocalTunnel failed to start");
    });
}

function startProcessTunnelProvider(state, provider, baseUrl, raceId, restartAttempt) {
  const runner = createTunnelRunner(state, provider, baseUrl, raceId, restartAttempt);
  const child = spawn(provider.command, provider.args({ baseUrl, port: state.port }), {
    windowsHide: true
  });
  runner.child = child;

  let announcedUrl = null;
  runner.startTimer = setTimeout(() => {
    failTunnelCandidate(state, runner, `${provider.name} did not return a URL in time`);
  }, TUNNEL_START_TIMEOUT_MS);
  const parseOutput = (chunk) => {
    if (runner.stopped) return;
    const text = chunk.toString();
    runner.outputTail = `${runner.outputTail}${text}`.slice(-4000);
    answerSshPrompt(child, text);
    const publicUrl = parseProviderUrl(provider, runner.outputTail);
    if (!publicUrl || publicUrl === announcedUrl) return;
    announcedUrl = publicUrl;
    clearTimeout(runner.startTimer);
    runner.startTimer = null;
    handleTunnelCandidateUrl(state, runner, publicUrl);
  };

  child.stdout.on("data", parseOutput);
  child.stderr.on("data", parseOutput);
  child.on("error", (error) => {
    clearTimeout(runner.startTimer);
    runner.startTimer = null;
    runner.child = null;
    failTunnelCandidate(state, runner, error.message || `${provider.name} failed to start`);
  });
  child.on("exit", () => {
    clearTimeout(runner.startTimer);
    runner.startTimer = null;
    runner.child = null;
    if (runner.stopped || state.session.status !== "live" || state.session.code !== runner.code) return;
    const outputMessage = tunnelOutputMessage(provider, runner.outputTail);
    const reason = outputMessage || (announcedUrl ? `${provider.name} tunnel stopped` : `${provider.name} did not create a public URL`);
    if (state.session.tunnel.providerId === provider.id && state.session.inviteUrl) {
      handleWinningTunnelStopped(state, runner, reason);
      return;
    }
    failTunnelCandidate(state, runner, reason);
  });
}

function answerSshPrompt(child, text) {
  if (!child.stdin?.writable) return;
  if (/are you sure you want to continue connecting/i.test(text)) {
    child.stdin.write("yes\n");
    return;
  }
  if (/password:/i.test(text)) {
    child.stdin.write("\n");
  }
}

function parseProviderUrl(provider, text) {
  if (!provider.urlPattern) return "";
  provider.urlPattern.lastIndex = 0;
  const matches = [...text.matchAll(provider.urlPattern)].map((match) => match[0]);
  return matches.find((url) => !url.includes("localhost")) || "";
}

function handleTunnelCandidateUrl(state, runner, publicUrl) {
  if (!publicUrl || !raceStillActive(state, runner)) return;
  runner.publicUrl = publicUrl;
  state.session.tunnel.status = "Checking";
  state.session.tunnel.detail = `${runner.provider.name} produced a public URL. Verifying it...`;
  broadcastState(state);
  verifyTunnelCandidate(state, runner, publicUrl);
}

function acceptTunnelWinner(state, runner, publicUrl) {
  if (!raceStillActive(state, runner)) return;
  const provider = runner.provider;
  state.session.publicUrl = publicUrl;
  state.session.inviteUrl = `${publicUrl}/join/${runner.code}`;
  state.session.tunnel.providerId = provider.id;
  state.session.tunnel.providerName = provider.name;
  state.session.tunnel.status = "Connected";
  state.session.tunnel.detail = state.session.tunnel.previousLinkInvalidated
    ? `${provider.name} verified the replacement invite link`
    : state.session.tunnel.selectionMode === "preferred"
      ? `${provider.name} verified the selected public link`
      : `${provider.name} won the tunnel race and verified the public link`;
  state.session.tunnel.process = runner.child || null;
  state.session.tunnel.controller = runner.controller || null;
  recordTunnelAttempt(state, provider, "connected", "Won race and verified public link");
  stopLosingTunnelRunners(state, provider.id);
  broadcastState(state);
}

function failTunnelCandidate(state, runner, reason) {
  if (!runner || runner.stopped) return;
  const provider = runner.provider;
  const code = runner.code;
  if (runner.startTimer) {
    clearTimeout(runner.startTimer);
    runner.startTimer = null;
  }
  const canAffectRace =
    state.session.status === "live" &&
    state.session.code === code &&
    state.session.tunnel.raceId === runner.raceId &&
    !state.session.inviteUrl;

  stopTunnelRunner(runner);
  tunnelRunners(state).delete(provider.id);
  if (!canAffectRace) return;

  recordTunnelAttempt(state, provider, "failed", reason);
  if (tunnelRunners(state).size > 0) {
    state.session.tunnel.status = "Racing";
    state.session.tunnel.detail = `${provider.name} failed: ${reason}. Waiting for another tunnel provider...`;
    broadcastState(state);
    return;
  }

  if (runner.restartAttempt + 1 < TUNNEL_RESTART_ATTEMPTS && !/rate-limit|too many requests|429|1015/i.test(reason)) {
    const originatingRaceId = runner.raceId;
    state.session.tunnel.status = "Retrying";
    state.session.tunnel.providerId = null;
    state.session.tunnel.providerName = null;
    state.session.tunnel.detail = `All tunnel providers failed. Racing them again...`;
    broadcastState(state);
    setTimeout(() => {
      const canRetry = state.session.status === "live" &&
        state.session.code === code &&
        state.session.tunnel.raceId === originatingRaceId &&
        !state.session.inviteUrl;
      if (canRetry) {
        startPublicTunnel(state, runner.baseUrl, runner.restartAttempt + 1);
      }
    }, 750);
    return;
  }

  resetTunnelLink(state);
  state.session.tunnel.providerId = null;
  state.session.tunnel.providerName = null;
  state.session.tunnel.status = "Error";
  state.session.tunnel.detail = `All tunnel providers failed. Last error: ${reason}`;
  broadcastState(state);
}

function handleWinningTunnelStopped(state, runner, reason) {
  const provider = runner.provider;
  if (state.session.status !== "live" || state.session.code !== runner.code) return;
  tunnelRunners(state).delete(provider.id);
  resetTunnelLink(state);
  recordTunnelAttempt(state, provider, "failed", reason);

  if (runner.restartAttempt + 1 < TUNNEL_RESTART_ATTEMPTS && !/rate-limit|too many requests|429|1015/i.test(reason)) {
    const originatingRaceId = runner.raceId;
    state.session.tunnel.status = "Retrying";
    state.session.tunnel.detail = `${provider.name} tunnel stopped. Racing tunnel providers again...`;
    broadcastState(state);
    setTimeout(() => {
      const canRetry = state.session.status === "live" &&
        state.session.code === runner.code &&
        state.session.tunnel.raceId === originatingRaceId &&
        !state.session.inviteUrl;
      if (canRetry) {
        startPublicTunnel(state, runner.baseUrl, runner.restartAttempt + 1);
      }
    }, 750);
    return;
  }

  state.session.tunnel.providerId = null;
  state.session.tunnel.providerName = null;
  state.session.tunnel.status = "Error";
  state.session.tunnel.detail = `${provider.name} tunnel stopped: ${reason}`;
  broadcastState(state);
}

function stopPublicTunnel(state) {
  if (state.session.tunnel.stopTimer) {
    clearTimeout(state.session.tunnel.stopTimer);
    state.session.tunnel.stopTimer = null;
  }
  for (const runner of tunnelRunners(state).values()) {
    stopTunnelRunner(runner);
  }
  tunnelRunners(state).clear();
  if (state.session.tunnel.process) {
    state.session.tunnel.process.removeAllListeners("exit");
    state.session.tunnel.process.kill();
    state.session.tunnel.process = null;
  }
  if (state.session.tunnel.controller) {
    state.session.tunnel.controller.removeAllListeners?.("close");
    state.session.tunnel.controller.close?.();
    state.session.tunnel.controller = null;
  }
  state.session.tunnel.raceId = null;
}

function schedulePublicTunnelStop(state, sessionId) {
  if (!state.session.tunnel.process && !state.session.tunnel.controller && tunnelRunners(state).size === 0) return;
  if (state.session.tunnel.stopTimer) {
    clearTimeout(state.session.tunnel.stopTimer);
  }
  state.session.tunnel.stopTimer = setTimeout(() => {
    state.session.tunnel.stopTimer = null;
    if (state.session.id === sessionId && state.session.status === "ended") {
      stopPublicTunnel(state);
    }
  }, SESSION_END_TUNNEL_GRACE_MS);
}

function cancelGuestAiRunsForUser(state, userId) {
  const identityPrefix = `guest:${String(userId || "")}:`;
  for (const [key, control] of [...state.ai.runControllers.entries()]) {
    if (!key.startsWith(identityPrefix)) continue;
    control.cancelled = true;
    control.controller.abort();
    try {
      control.sessionStore.cancelRun(control.project || state.project, control.sessionId, { runId: control.runId });
    } catch {
      // Guest teardown must continue even if a run already became terminal.
    }
    state.ai.runControllers.delete(key);
  }
}

function cancelGuestAiRuns(state) {
  for (const user of state.session.users) {
    if (user.role === "host") continue;
    cancelGuestAiRunsForUser(state, user.id);
  }
}

function publicSessionUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    color: user.color,
    online: user.online
  };
}

function setGuestRole(state, user, role) {
  const previousRole = user.role;
  user.role = role;
  for (const requestRecord of state.session.joinRequests) {
    if (requestRecord.userId === user.id) requestRecord.role = role;
  }
  let connectedClient = null;
  for (const client of state.collabClients.values()) {
    if (client.userId !== user.id) continue;
    client.role = role;
    client.canEdit = role === "maintainer";
    connectedClient ||= client;
    sendWs(client, {
      type: "role_changed",
      userId: user.id,
      role,
      canEdit: client.canEdit
    });
  }
  if (previousRole === "maintainer" && role === "viewer") {
    cancelGuestAiRunsForUser(state, user.id);
    state.ai.guestSessions.delete(user.id);
  }
  if (connectedClient) broadcastPresence(state, connectedClient);
  broadcastState(state);
  return publicSessionUser(user);
}

function removeGuestAccess(state, user, reason = "The host removed you from this session.") {
  const removedUser = publicSessionUser(user);
  const revokedTokens = new Set();
  for (const [token, userId] of state.session.activeTokens.entries()) {
    if (userId !== user.id) continue;
    revokedTokens.add(token);
    state.session.activeTokens.delete(token);
  }

  cancelGuestAiRunsForUser(state, user.id);
  state.ai.guestSessions.delete(user.id);

  for (const [id, client] of [...state.collabClients.entries()]) {
    if (client.userId !== user.id) continue;
    client.canEdit = false;
    client.token = "";
    sendWs(client, { type: "access_revoked", userId: user.id, reason });
    state.collabClients.delete(id);
    client.socket.close(4003, "Access revoked");
  }
  for (const [id, client] of [...state.clients.entries()]) {
    if (!revokedTokens.has(client.token)) continue;
    try {
      sendSse(client.response, "access-revoked", { userId: user.id, reason });
      client.response.end();
    } catch {
      // Revocation still succeeds if an already-closing EventSource cannot receive the final event.
    }
    deleteSseClient(state, id, client);
  }

  state.session.users = state.session.users.filter((item) => item.id !== user.id);
  for (const requestRecord of state.session.joinRequests) {
    if (requestRecord.userId !== user.id) continue;
    requestRecord.status = "removed";
    delete requestRecord.token;
  }
  broadcastCollab(state, {
    type: "presence_update",
    userId: user.id,
    name: user.name,
    role: user.role,
    filePath: "",
    presence: collabPresence(state)
  });
  broadcastState(state);
  return removedUser;
}

function applyEndedSessionState(state) {
  cancelGuestAiRuns(state);
  state.session.status = "ended";
  state.session.inviteUrl = null;
  state.session.publicUrl = null;
  state.session.joinRequests = [];
  state.session.activeTokens.clear();
  state.ai.guestSessions.clear();
  state.session.users = state.session.users.map((user) => ({ ...user, online: user.role === "host" }));
  state.session.tunnel.providerId = null;
  state.session.tunnel.providerName = null;
  state.session.tunnel.previousLinkInvalidated = false;
  state.session.tunnel.status = state.session.tunnel.available ? "Ready" : "Not installed";
  state.session.tunnel.detail = state.session.tunnel.available
    ? `Tunnel providers ready: ${activeTunnelProviders(state).map((provider) => provider.name).join(", ")}`
    : "No tunnel provider was found.";
}

function notifySessionEnded(state, reason) {
  closeCollabClients(state, reason);
  broadcast(state, "session-ended", { reason });
  broadcastState(state);
}

function tunnelOutputMessage(provider, output) {
  if (provider.id === "cloudflare" && /429|too many requests|1015/i.test(output)) {
    return "Cloudflare is rate-limiting quick tunnel creation.";
  }
  if (provider.id === "cloudflare" && /failed to unmarshal quick tunnel|quick tunnel/i.test(output) && /error/i.test(output)) {
    return "Cloudflare could not create a quick tunnel right now.";
  }
  if (/permission denied|connection refused|connection reset|operation timed out|timed out/i.test(output)) {
    return `${provider.name} connection failed.`;
  }
  return "";
}

function lookupPublicHostname(hostname, options, callback) {
  publicDnsResolver.resolve4(hostname, (error, addresses) => {
    if (!error && addresses.length) {
      if (options?.all) {
        callback(null, addresses.map((address) => ({ address, family: 4 })));
        return;
      }
      callback(null, addresses[0], 4);
      return;
    }
    dns.lookup(hostname, options, callback);
  });
}

function checkPublicTunnel(publicUrl, challenge) {
  return new Promise((resolve) => {
    const checkUrl = new URL("/api/tunnel-check", publicUrl);
    checkUrl.searchParams.set("challenge", challenge);
    const request = https.get(
      checkUrl,
      {
        timeout: 8000,
        lookup: lookupPublicHostname
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 1024) body += chunk;
        });
        response.on("end", () => {
          try {
            const payload = JSON.parse(body);
            resolve(response.statusCode === 200 && payload.challenge === challenge);
          } catch {
            resolve(false);
          }
        });
      }
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function verifyTunnelCandidate(state, runner, publicUrl, attempt = 1) {
  (state.tunnelCheck || checkPublicTunnel)(publicUrl, runner.challenge).then((ok) => {
    if (!raceStillActive(state, runner) || runner.publicUrl !== publicUrl) return;

    if (ok) {
      acceptTunnelWinner(state, runner, publicUrl);
      return;
    }

    if (attempt < TUNNEL_VERIFY_ATTEMPTS) {
      state.session.tunnel.status = "Checking";
      state.session.tunnel.detail = `Waiting for ${runner.provider.name} public URL (${attempt + 1}/${TUNNEL_VERIFY_ATTEMPTS})`;
      broadcastState(state);
      setTimeout(
        () => verifyTunnelCandidate(state, runner, publicUrl, attempt + 1),
        3000
      );
      return;
    }

    failTunnelCandidate(state, runner, `${runner.provider.name} URL did not become reachable`);
  });
}

function createLocalLeafServer(options = {}) {
  const state = createInitialState(options);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const updateReleaseFetcher = typeof options.fetchLatestRelease === "function"
    ? options.fetchLatestRelease
    : fetchLatestRelease;
  const compileRunner = typeof options.compileProject === "function"
    ? options.compileProject
    : compileProject;
  const compileCoordinator = {
    activeJobId: null,
    nextJobNumber: 0,
    queuedJobs: 0,
    tail: Promise.resolve()
  };

  async function runCompileJob(job) {
    compileCoordinator.queuedJobs = Math.max(0, compileCoordinator.queuedJobs - 1);
    compileCoordinator.activeJobId = job.id;

    if (state.project.id !== job.projectId) {
      compileCoordinator.activeJobId = null;
      return {
        ...publicCompileState(state.compile),
        jobId: job.id,
        superseded: true
      };
    }

    const previousCompile = state.compile;
    const previousPdfAvailable = isValidPdfArtifact(previousCompile.pdfPath);
    state.compile = {
      ...previousCompile,
      status: "running",
      logs: ["[LocalLeaf] Compile started..."],
      version: previousCompile.version + 1,
      jobId: job.id,
      queuedJobs: compileCoordinator.queuedJobs,
      isStale: false
    };
    broadcastProject(state, "compile", publicCompileState(state.compile));

    let result;
    let compileSnapshot = null;
    try {
      compileSnapshot = await createCompileSnapshot(job.projectRoot);
      result = await compileRunner(compileSnapshot.sourceSnapshotRoot, job.mainFile, (chunk) => {
        if (compileCoordinator.activeJobId !== job.id || state.project.id !== job.projectId) return;
        state.compile.logs = [
          ...state.compile.logs,
          ...String(chunk || "").split(/\r?\n/).filter(Boolean)
        ].slice(-300);
        broadcastProject(state, "compile", publicCompileState(state.compile));
      }, {
        compileSnapshot,
        originalProjectRoot: job.projectRoot,
        previousPdfPath: previousCompile.pdfPath,
        previousSynctexPath: previousCompile.synctexPath,
        previousArtifactRoot: previousCompile.artifactRoot,
        previousSourceSnapshotRoot: previousCompile.sourceSnapshotRoot
      });
      if (result?.artifactRoot !== compileSnapshot.artifactRoot) {
        cleanupCompileArtifact(compileSnapshot.artifactRoot);
      }
    } catch (error) {
      cleanupCompileArtifact(compileSnapshot?.artifactRoot);
      result = {
        ok: false,
        engine: previousCompile.engine,
        mode: previousPdfAvailable ? "pdf" : "html",
        logs: [
          ...state.compile.logs,
          `[LocalLeaf] Compile failed: ${error.message || "Unknown compiler error."}`
        ],
        previewHtml: previousCompile.previewHtml || "",
        pdfPath: previousPdfAvailable ? previousCompile.pdfPath : null,
        synctexPath: previousPdfAvailable ? previousCompile.synctexPath || null : null,
        artifactRoot: previousPdfAvailable ? previousCompile.artifactRoot || null : null,
        sourceSnapshotRoot: previousPdfAvailable ? previousCompile.sourceSnapshotRoot || null : null,
        stale: previousPdfAvailable
      };
    }

    if (result?.pdfPath && !isValidPdfArtifact(result.pdfPath)) {
      if (result.artifactRoot && result.artifactRoot !== previousCompile.artifactRoot) {
        cleanupCompileArtifact(result.artifactRoot);
      }
      result = {
        ...result,
        ok: false,
        mode: "html",
        logs: [
          ...(result.logs || []),
          "[LocalLeaf] The compiler produced an invalid or incomplete PDF, so LocalLeaf did not publish it."
        ],
        pdfPath: null,
        synctexPath: null,
        artifactRoot: null,
        sourceSnapshotRoot: null,
        stale: false
      };
    }

    if (state.project.id !== job.projectId) {
      if (result.artifactRoot && result.artifactRoot !== previousCompile.artifactRoot) {
        cleanupCompileArtifact(result.artifactRoot);
      }
      compileCoordinator.activeJobId = null;
      return {
        ...publicCompileState(state.compile),
        jobId: job.id,
        superseded: true
      };
    }

    if (!result.ok && previousPdfAvailable && result.pdfPath !== previousCompile.pdfPath) {
      if (result.artifactRoot && result.artifactRoot !== previousCompile.artifactRoot) {
        cleanupCompileArtifact(result.artifactRoot);
      }
      result = {
        ...result,
        mode: "pdf",
        pdfPath: previousCompile.pdfPath,
        synctexPath: previousCompile.synctexPath,
        artifactRoot: previousCompile.artifactRoot,
        sourceSnapshotRoot: previousCompile.sourceSnapshotRoot,
        stale: true
      };
    }

    if (!isValidPdfArtifact(result.pdfPath)) {
      result = {
        ...result,
        mode: "html",
        pdfPath: null,
        synctexPath: null,
        artifactRoot: null,
        sourceSnapshotRoot: null,
        stale: false
      };
    }

    const completedAt = Date.now();
    const nextVersion = state.compile.version + 1;
    const hasSuccessfulPdf = Boolean(result.ok && result.mode === "pdf" && result.pdfPath);
    const isStale = Boolean(result.stale || (!result.ok && result.pdfPath));
    registerCompileArtifact(state, result);
    if (previousCompile.pdfPath && previousCompile.pdfPath !== result.pdfPath) {
      retireCompileArtifact(state, previousCompile.pdfPath);
    }
    state.compile = {
      status: result.ok ? "success" : "failed",
      engine: result.engine,
      mode: result.mode,
      logs: capCompilerLogs(result.logs?.length ? result.logs : state.compile.logs),
      previewHtml: result.previewHtml || "",
      pdfPath: result.pdfPath || null,
      synctexPath: result.synctexPath || null,
      sourceMapAvailable: Boolean(result.synctexPath && fs.existsSync(result.synctexPath)),
      version: nextVersion,
      jobId: job.id,
      queuedJobs: compileCoordinator.queuedJobs,
      isStale,
      lastSuccessfulAt: hasSuccessfulPdf ? completedAt : previousCompile.lastSuccessfulAt,
      lastSuccessfulVersion: hasSuccessfulPdf ? nextVersion : previousCompile.lastSuccessfulVersion,
      artifactId: result.pdfPath ? (hasSuccessfulPdf ? job.id : previousCompile.artifactId) : null,
      artifactRoot: result.pdfPath
        ? result.artifactRoot || previousCompile.artifactRoot || null
        : null,
      sourceSnapshotRoot: result.pdfPath
        ? result.sourceSnapshotRoot || previousCompile.sourceSnapshotRoot || null
        : null
    };
    const responseState = publicCompileState(state.compile);
    compileCoordinator.activeJobId = null;
    broadcastProject(state, "compile", responseState);
    broadcastState(state);
    return responseState;
  }

  function enqueueCompile() {
    const job = {
      id: `compile-${++compileCoordinator.nextJobNumber}`,
      projectId: state.project.id,
      projectRoot: state.project.root,
      mainFile: state.project.mainFile
    };
    compileCoordinator.queuedJobs += 1;
    state.compile.queuedJobs = compileCoordinator.queuedJobs - (compileCoordinator.activeJobId ? 0 : 1);
    if (compileCoordinator.activeJobId) {
      broadcastProject(state, "compile", publicCompileState(state.compile));
    }
    const pending = compileCoordinator.tail.then(() => runCompileJob(job));
    compileCoordinator.tail = pending.catch(() => undefined);
    return pending;
  }

  async function handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/tunnel-check") {
      const challenge = String(url.searchParams.get("challenge") || "");
      const runner = [...tunnelRunners(state).values()].find((candidate) => (
        candidate.challenge === challenge && raceStillActive(state, candidate)
      ));
      if (!runner) {
        jsonResponse(response, 404, { error: "Tunnel verification challenge not found." });
        return;
      }
      jsonResponse(response, 200, { challenge });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      const isHost = isHostRequest(state, request, url);
      const user = getTokenUser(state, request, url);
      jsonResponse(response, 200, publicState(state, {
        isHost,
        canRead: isHost || Boolean(user),
        canEdit: isHost || user?.role === "maintainer",
        user
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/ai/sessions") {
      const identity = requestIdentity(state, request, url);
      if (!identity.isHost && !identity.canEdit) {
        deny(response, "Maintainer access is required before using LocalLeaf AI sessions.");
        return;
      }
      jsonResponse(response, 200, aiSessionStoreForIdentity(state, identity).publicState(state.project));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/sessions/create") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before creating LocalLeaf AI sessions.",
        capture: (identity) => captureAiSessionMutationContext(state, identity)
      });
      if (!authorized) return;
      const { body, context: { sessionStore, originProjectKey } } = authorized;
      try {
        validateAiSessionMutationProject(state, sessionStore, body, originProjectKey);
        jsonResponse(response, 200, sessionStore.createSession(state.project, body));
      } catch (error) {
        apiErrorResponse(response, error);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/sessions/activate") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before activating LocalLeaf AI sessions.",
        capture: (identity) => captureAiSessionMutationContext(state, identity)
      });
      if (!authorized) return;
      const { body, context: { sessionStore, originProjectKey } } = authorized;
      try {
        validateAiSessionMutationProject(state, sessionStore, body, originProjectKey);
        jsonResponse(response, 200, sessionStore.activateSession(state.project, String(body.sessionId || body.id || "")));
      } catch (error) {
        apiErrorResponse(response, error, 404);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/sessions/update") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before updating LocalLeaf AI sessions.",
        capture: (identity) => captureAiSessionMutationContext(state, identity)
      });
      if (!authorized) return;
      const { body, context: { sessionStore, originProjectKey } } = authorized;
      try {
        validateAiSessionMutationProject(state, sessionStore, body, originProjectKey);
        jsonResponse(response, 200, sessionStore.updateSession(state.project, String(body.sessionId || body.id || ""), body));
      } catch (error) {
        apiErrorResponse(response, error, 404);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/sessions/rename") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before renaming LocalLeaf AI sessions.",
        capture: (identity) => captureAiSessionMutationContext(state, identity)
      });
      if (!authorized) return;
      const { body, context: { sessionStore, originProjectKey } } = authorized;
      try {
        validateAiSessionMutationProject(state, sessionStore, body, originProjectKey);
        jsonResponse(response, 200, sessionStore.renameSession(
          state.project,
          String(body.sessionId || body.id || ""),
          { title: body.title, expectedRevision: body.expectedRevision }
        ));
      } catch (error) {
        apiErrorResponse(response, error);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/sessions/delete") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before deleting LocalLeaf AI sessions.",
        capture: (identity) => captureAiSessionMutationContext(state, identity)
      });
      if (!authorized) return;
      const { body, context: { sessionStore, originProjectKey } } = authorized;
      try {
        validateAiSessionMutationProject(state, sessionStore, body, originProjectKey);
        jsonResponse(response, 200, sessionStore.deleteSession(
          state.project,
          String(body.sessionId || body.id || ""),
          { expectedRevision: body.expectedRevision }
        ));
      } catch (error) {
        apiErrorResponse(response, error);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/sessions/fork") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before forking LocalLeaf AI sessions.",
        capture: (identity) => captureAiSessionMutationContext(state, identity)
      });
      if (!authorized) return;
      const { body, context: { sessionStore, originProjectKey } } = authorized;
      try {
        validateAiSessionMutationProject(state, sessionStore, body, originProjectKey);
        jsonResponse(response, 200, sessionStore.forkSession(
          state.project,
          String(body.sessionId || body.id || ""),
          { expectedRevision: body.expectedRevision }
        ));
      } catch (error) {
        apiErrorResponse(response, error, 404);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/sessions/import-legacy") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can import LocalLeaf AI sessions.");
        return;
      }
      const sessionStore = state.ai.sessions;
      const originProjectKey = sessionStore.projectKeyForRoot(state.project.root);
      const body = await readBody(request);
      try {
        validateAiSessionMutationProject(state, sessionStore, body, originProjectKey);
        jsonResponse(response, 200, sessionStore.importLegacySessions(state.project, body.sessions || [], body.currentSessionId || ""));
      } catch (error) {
        apiErrorResponse(response, error);
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/update/latest") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can check for LocalLeaf updates.");
        return;
      }
      jsonResponse(response, 200, await getLatestUpdateInfo(updateReleaseFetcher));
      return;
    }

    if (request.method === "GET" && (url.pathname === "/api/ai/models" || url.pathname === "/api/ai/models/status")) {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can manage LocalLeaf AI models.");
        return;
      }
      jsonResponse(response, 200, state.ai.models.publicState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/models/storage") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can change LocalLeaf AI model storage.");
        return;
      }
      const body = await readBody(request);
      try {
        const aiState = state.ai.models.setStoragePath(body.path);
        broadcastState(state);
        jsonResponse(response, 200, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/models/download") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can download LocalLeaf AI models.");
        return;
      }
      const body = await readBody(request);
      try {
        const aiState = state.ai.models.downloadModel(String(body.modelId || ""));
        broadcastState(state);
        jsonResponse(response, 202, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/models/pause") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can pause LocalLeaf AI model downloads.");
        return;
      }
      const body = await readBody(request);
      try {
        const aiState = state.ai.models.pauseDownload(String(body.modelId || ""));
        broadcastState(state);
        jsonResponse(response, 200, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/models/cancel") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can stop LocalLeaf AI model downloads.");
        return;
      }
      const body = await readBody(request);
      try {
        const aiState = state.ai.models.cancelDownload(String(body.modelId || ""));
        broadcastState(state);
        jsonResponse(response, 200, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/models/delete") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can delete LocalLeaf AI models.");
        return;
      }
      const body = await readBody(request);
      try {
        const aiState = state.ai.models.deleteModel(String(body.modelId || ""));
        broadcastState(state);
        jsonResponse(response, 200, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/models/activate") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can activate LocalLeaf AI models.");
        return;
      }
      const body = await readBody(request);
      try {
        const aiState = state.ai.models.activateModel(String(body.modelId || ""));
        broadcastState(state);
        jsonResponse(response, 200, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/ai/providers/status") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can manage LocalLeaf AI providers.");
        return;
      }
      jsonResponse(response, 200, state.ai.models.publicState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/providers/save") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can save LocalLeaf AI providers.");
        return;
      }
      const body = await readBody(request);
      try {
        const payload = body.provider ? { ...body.provider, activate: body.activate, modelId: body.modelId || body.provider.model || body.provider.modelId } : body;
        const aiState = await state.ai.models.saveProvider(payload);
        broadcastState(state);
        jsonResponse(response, 200, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/providers/validate") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can validate LocalLeaf AI providers.");
        return;
      }
      const body = await readBody(request);
      try {
        const result = await state.ai.models.validateProvider(body);
        broadcastState(state);
        jsonResponse(response, 200, result);
      } catch (error) {
        const status = error.statusCode === 401 ? 401 : error.statusCode === 502 ? 502 : 400;
        jsonResponse(response, status, { error: error.message || "Provider validation failed." });
      }
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/ai/providers/presets/")) {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can configure LocalLeaf AI provider presets.");
        return;
      }
      const body = await readBody(request);
      const presetId = decodeURIComponent(url.pathname.split("/").pop() || "");
      try {
        const aiState = await state.ai.models.saveProvider({
          templateId: presetId,
          id: presetId,
          apiKey: body.apiKey,
          activate: body.activate !== false,
          modelId: body.modelId
        });
        broadcastState(state);
        jsonResponse(response, 200, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/providers/test") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can test LocalLeaf AI providers.");
        return;
      }
      const body = await readBody(request);
      const payload = body.provider ? { ...body.provider, apiKey: body.provider.apiKey ?? body.apiKey, modelId: body.modelId || body.provider.model || body.provider.modelId } : body;
      const result = await state.ai.models.testProvider(payload);
      broadcastState(state);
      jsonResponse(response, result.ok ? 200 : 400, result.ok ? result : { ...result, error: result.message });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/providers/activate") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can activate LocalLeaf AI providers.");
        return;
      }
      const body = await readBody(request);
      try {
        const aiState = state.ai.models.activateProvider(body.providerId || body.id, body.modelId);
        broadcastState(state);
        jsonResponse(response, 200, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/providers/delete") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can delete LocalLeaf AI providers.");
        return;
      }
      const body = await readBody(request);
      try {
        const aiState = await state.ai.models.deleteProvider(body.providerId || body.id);
        broadcastState(state);
        jsonResponse(response, 200, aiState);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/smoke-test") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Only the host app can run LocalLeaf AI smoke tests.");
        return;
      }
      const body = await readBody(request);
      const smokeFile = `localleaf-ai-smoke-${randomId(5)}.tex`;
      const smokePath = resolveProjectPath(state.project.root, smokeFile);
      let proposal = null;
      try {
        const provider = await state.ai.models.runSmokeTest({
          apiKey: body.apiKey,
          timeoutMs: body.timeoutMs
        });
        fs.writeFileSync(smokePath, "\\documentclass{article}\n\\begin{document}\nWe utilize this draft.\n\\end{document}\n", "utf8");
        refreshProject(state);
        proposal = createDeterministicAgentProposal(state, {
          path: smokeFile,
          message: "rewrite this section",
          selectedText: "We utilize this draft.",
          skipChangeLog: true
        });
        const applied = applyAiProposalToFile(state, proposal);
        const editOk = /We use this draft/.test(fs.readFileSync(smokePath, "utf8"));
        jsonResponse(response, editOk && provider.ok ? 200 : 400, {
          ok: editOk && provider.ok,
          provider,
          edit: {
            ok: editOk,
            proposalId: applied.proposal.id,
            status: applied.proposal.status
          }
        });
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      } finally {
        if (proposal) state.ai.proposals.delete(proposal.id);
        fs.rmSync(smokePath, { force: true });
        refreshProject(state);
        broadcastState(state);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/message") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before asking LocalLeaf AI to inspect project text."
      });
      if (!authorized) return;
      const { body, identity } = authorized;
      try {
        const result = await runAgentForSession(state, identity, body);
        broadcastState(state);
        jsonResponse(response, 200, result);
      } catch (error) {
        broadcastState(state);
        apiErrorResponse(response, error);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/steer") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before steering LocalLeaf AI runs."
      });
      if (!authorized) return;
      const { body, identity } = authorized;
      try {
        const result = await runAgentForSession(state, identity, {
          ...body,
          runId: `steer-${randomId(8)}`,
          steer: true
        });
        broadcastState(state);
        jsonResponse(response, 200, {
          ...result,
          steered: true,
          queuedPromptId: body.queuedPromptId || null
        });
      } catch (error) {
        broadcastState(state);
        apiErrorResponse(response, error);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/run/cancel") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before cancelling LocalLeaf AI runs."
      });
      if (!authorized) return;
      const { body, identity } = authorized;
      const runId = String(body.runId || "").trim().slice(0, 80);
      const sessionStore = aiSessionStoreForIdentity(state, identity);
      const control = state.ai.runControllers.get(aiRunControllerKey(identity, runId));
      const runProject = control?.project || state.project;
      const currentSnapshot = sessionStore?.publicState(runProject);
      const sessionId = String(body.sessionId || currentSnapshot?.currentSessionId || "").trim();
      try {
        if (!runId) throw aiRunError("AI_RUN_INVALID", "AI run ID is required.", 400);
        if (!sessionStore?.getSession(runProject, sessionId)) {
          throw aiRunError("AI_SESSION_NOT_FOUND", "AI session was not found.", 404);
        }
        if (control && control.sessionId !== sessionId) {
          throw aiRunError("AI_SESSION_NOT_FOUND", "AI session was not found.", 404);
        }
        if (control) {
          control.cancelled = true;
          control.controller.abort();
        }
        const sessionState = sessionStore.cancelRun(runProject, sessionId, { runId });
        broadcastState(state);
        jsonResponse(response, 200, sessionState);
      } catch (error) {
        apiErrorResponse(response, error);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/run") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "ai",
        message: "Maintainer access is required before running LocalLeaf AI."
      });
      if (!authorized) return;
      const { body, identity } = authorized;
      beginNdjsonResponse(response);
      let streamRunId = String(body.runId || randomId(8));
      let streamSessionId = String(body.sessionId || "");
      try {
        const files = agentListProjectFiles(state);
        const currentFile = agentReadProjectFile(state, body.path);
        const logs = agentCompileLogs(state);
        const result = await runAgentForSession(state, identity, { ...body, runId: streamRunId }, {
          onRunStarted: ({ runId, sessionId, replayed = false }) => {
            streamRunId = runId;
            streamSessionId = sessionId;
            sendNdjson(response, { type: "run_started", runId, sessionId });
            if (replayed) return;
            sendNdjson(response, {
              type: "tool_call",
              runId,
              sessionId,
              tool: "list_project_files",
              status: "completed",
              result: { count: files.length, files: files.slice(0, 40) }
            });
            sendNdjson(response, {
              type: "tool_call",
              runId,
              sessionId,
              tool: "read_file",
              status: "completed",
              result: { path: currentFile.path, hash: currentFile.hash, bytes: currentFile.content.length }
            });
            if (logs.length) {
              sendNdjson(response, {
                type: "tool_call",
                runId,
                sessionId,
                tool: "get_compile_logs",
                status: "completed",
                result: { lines: logs.length }
              });
            }
          },
          onContextPrepared: (contextUsage) => {
            sendNdjson(response, {
              type: "context_snapshot",
              runId: streamRunId,
              sessionId: streamSessionId,
              contextUsage
            });
          }
        });
        sendNdjson(response, {
          type: "assistant_delta",
          runId: streamRunId,
          sessionId: streamSessionId,
          delta: result.reply || ""
        });
        for (const proposal of result.proposals || []) {
          sendNdjson(response, {
            type: "proposal_created",
            runId: streamRunId,
            sessionId: streamSessionId,
            proposal
          });
          if (proposal.approvalRequired !== false && proposal.status === "proposed") {
            sendNdjson(response, {
              type: "approval_required",
              runId: streamRunId,
              sessionId: streamSessionId,
              proposal
            });
          }
        }
        broadcastState(state);
        sendNdjson(response, {
          type: "run_done",
          runId: streamRunId,
          sessionId: streamSessionId,
          contextUsage: result.contextUsage,
          result
        });
      } catch (error) {
        broadcastState(state);
        sendNdjson(response, {
          type: "run_error",
          runId: streamRunId,
          sessionId: error.sessionId || streamSessionId,
          error: error.message,
          code: error.code || "AI_RUN_FAILED"
        });
      } finally {
        response.end();
      }
      return;
    }

    if (request.method === "POST" && (url.pathname === "/api/agent/proposal/apply" || url.pathname === "/api/agent/approval/approve")) {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before applying LocalLeaf AI proposals."
      });
      if (!authorized) return;
      const { body, identity } = authorized;
      const proposal = state.ai.proposals.get(String(body.proposalId || body.id || ""));
      if (!proposal) {
        jsonResponse(response, 404, { error: "AI proposal was not found." });
        return;
      }
      if (proposal.operation === "create" && !identity.isHost) {
        deny(response, "Only the host can approve creation of a new project file.");
        return;
      }
      if (!canManageAiProposal(identity, proposal)) {
        deny(response, "You can only manage AI proposals created by your session.");
        return;
      }
      if (proposal.status !== "proposed") {
        jsonResponse(response, 409, { error: `AI proposal is already ${proposal.status}.` });
        return;
      }
      if (proposal.operation !== "create") {
        const createDependencies = Array.from(state.ai.proposals.values()).filter((candidate) => (
          candidate.operation === "create"
          && aiProposalsShareRun(candidate, proposal)
        ));
        const unresolvedCreate = createDependencies.find((candidate) => candidate.status !== "applied");
        if (unresolvedCreate) {
          jsonResponse(response, 409, {
            error: `Create ${unresolvedCreate.path} before applying the related edit.`,
            code: "AI_CREATE_DEPENDENCY_PENDING",
            proposal: publicProposal(proposal)
          });
          return;
        }
        for (const dependency of createDependencies) {
          try {
            validateProposalRevertTarget(state, dependency);
          } catch {
            dependency.status = "stale";
            recordAiProposalChange(state, dependency);
            jsonResponse(response, 409, {
              error: `The required new file ${dependency.path} is missing or changed. Prepare a fresh AI run before applying the related edit.`,
              code: "AI_CREATE_DEPENDENCY_STALE",
              proposal: publicProposal(proposal)
            });
            return;
          }
        }
      }

      try {
        const applied = applyAgentProposalAndBroadcast(state, proposal);
        jsonResponse(response, 200, { ok: true, proposal: applied.proposal });
      } catch (error) {
        jsonResponse(response, error.statusCode || 400, {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.proposal ? { proposal: error.proposal } : {})
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/proposal/revert") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before reverting LocalLeaf AI proposals."
      });
      if (!authorized) return;
      const { body, identity } = authorized;
      const proposal = state.ai.proposals.get(String(body.proposalId || body.id || ""));
      if (!proposal) {
        jsonResponse(response, 404, { error: "AI proposal was not found." });
        return;
      }
      if (!canManageAiProposal(identity, proposal)) {
        deny(response, "You can only manage AI proposals created by your session.");
        return;
      }
      if (proposal.status !== "applied") {
        jsonResponse(response, 409, { error: `AI proposal is ${proposal.status || "not applied"} and cannot be reverted.` });
        return;
      }
      if (proposal.operation === "create") {
        const appliedDependents = Array.from(state.ai.proposals.values()).filter((candidate) => (
          candidate.operation !== "create"
          && candidate.status === "applied"
          && aiProposalsShareRun(candidate, proposal)
        ));
        if (appliedDependents.length) {
          jsonResponse(response, 409, {
            error: "Undo the whole AI run, or revert its related edits, before removing this new file.",
            code: "AI_CREATE_DEPENDENTS_APPLIED",
            proposal: publicProposal(proposal)
          });
          return;
        }
      }
      try {
        const reverted = revertAgentProposalAndBroadcast(state, proposal);
        jsonResponse(response, 200, { ok: true, proposal: reverted.proposal });
      } catch (error) {
        jsonResponse(response, error.statusCode || 400, {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.proposal ? { proposal: error.proposal } : {})
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/run/revert") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before undoing LocalLeaf AI runs."
      });
      if (!authorized) return;
      const { body, identity } = authorized;
      const runId = String(body.runId || "").trim();
      const anchorId = String(body.proposalId || body.anchorProposalId || "").trim();
      const allRunProposals = Array.from(state.ai.proposals.values()).filter((proposal) => proposal.runId === runId);
      if (!runId || !allRunProposals.length) {
        jsonResponse(response, 404, { error: "No applied AI proposals were found for that run." });
        return;
      }
      let anchor = anchorId ? state.ai.proposals.get(anchorId) : null;
      if (anchor && (anchor.runId !== runId || !allRunProposals.includes(anchor))) anchor = null;
      if (!anchor) {
        const identities = new Map();
        for (const proposal of allRunProposals) {
          const key = aiProposalRunIdentity(proposal);
          if (!identities.has(key)) identities.set(key, proposal);
        }
        if (identities.size !== 1) {
          jsonResponse(response, 409, {
            error: "Choose the specific change group to undo.",
            code: "AI_RUN_AMBIGUOUS"
          });
          return;
        }
        anchor = identities.values().next().value;
      }
      if (!canManageAiProposal(identity, anchor)) {
        deny(response, "You can only manage AI runs created by your session.");
        return;
      }
      const runProposals = allRunProposals.filter((proposal) => aiProposalsShareRun(proposal, anchor));
      const proposals = runProposals.filter((proposal) => proposal.status === "applied" && aiProposalMatchesCurrentProject(state, proposal));
      if (!proposals.length) {
        try {
          assertAiProposalProject(state, runProposals[0]);
        } catch (error) {
          jsonResponse(response, error.statusCode || 409, { error: error.message, code: error.code });
          return;
        }
        jsonResponse(response, 404, { error: "No applied AI proposals were found for that change group." });
        return;
      }
      if (!proposals.every((proposal) => canManageAiProposal(identity, proposal))) {
        deny(response, "You can only manage AI runs created by your session.");
        return;
      }
      try {
        const reverted = revertAiRunAtomically(state, proposals);
        jsonResponse(response, 200, { ok: true, runId, proposals: reverted });
      } catch (error) {
        jsonResponse(response, error.statusCode || 400, {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.proposal ? { proposal: error.proposal } : {})
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/approval/reject") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before rejecting LocalLeaf AI proposals."
      });
      if (!authorized) return;
      const { body, identity } = authorized;
      const proposal = state.ai.proposals.get(String(body.proposalId || body.id || ""));
      if (!proposal) {
        jsonResponse(response, 404, { error: "AI proposal was not found." });
        return;
      }
      if (!canManageAiProposal(identity, proposal)) {
        deny(response, "You can only manage AI proposals created by your session.");
        return;
      }
      if (proposal.status !== "proposed") {
        jsonResponse(response, 409, { error: `AI proposal is already ${proposal.status}.` });
        return;
      }
      try {
        const rejected = rejectAiProposal(state, proposal);
        broadcastState(state);
        jsonResponse(response, 200, { ok: true, proposal: rejected });
      } catch (error) {
        jsonResponse(response, error.statusCode || 400, {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.proposal ? { proposal: error.proposal } : {})
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/editor/suggestions") {
      if (!canReadProject(state, request, url)) {
        deny(response, "Join approval is required before reading project suggestions.");
        return;
      }
      jsonResponse(response, 200, collectProjectEditorSuggestions(state.project.root, state.project.files));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/search/replace") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before replacing project text."
      });
      if (!authorized) return;
      const { body } = authorized;
      try {
        const result = replaceProjectText(state, body);
        broadcastState(state);
        jsonResponse(response, 200, result);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/file") {
      if (!canReadProject(state, request, url)) {
        deny(response, "Join approval is required before reading project files.");
        return;
      }
      const filePath = url.searchParams.get("path") || state.project.mainFile;
      const fullPath = resolveProjectPath(state.project.root, filePath);
      if (!isTextFile(fullPath)) {
        jsonResponse(response, 400, { error: "Only text-based project files are editable." });
        return;
      }
      jsonResponse(response, 200, {
        path: filePath,
        content: fs.readFileSync(fullPath, "utf8")
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/asset") {
      if (!canReadProject(state, request, url)) {
        deny(response, "Join approval is required before reading project assets.");
        return;
      }
      const filePath = url.searchParams.get("path") || "";
      const fullPath = resolveProjectPath(state.project.root, filePath);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile() || !isImageFile(fullPath)) {
        jsonResponse(response, 404, { error: "Image asset was not found." });
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      streamFileResponse(request, response, fullPath, MIME_TYPES[ext] || "application/octet-stream");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/file/download") {
      if (!canReadProject(state, request, url)) {
        deny(response, "Join approval is required before downloading project files.");
        return;
      }
      const filePath = url.searchParams.get("path") || "";
      const fullPath = resolveProjectPath(state.project.root, filePath);
      if (!fs.existsSync(fullPath)) {
        jsonResponse(response, 404, { error: "File or folder was not found." });
        return;
      }
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        let exported;
        try {
          exported = createItemZip(state.project.root, filePath);
        } catch (error) {
          jsonResponse(response, 500, { error: error.message });
          return;
        }
        response.writeHead(200, attachmentHeaders(path.basename(exported.zipPath), "application/zip"));
        const stream = fs.createReadStream(exported.zipPath);
        const cleanup = () => fs.rmSync(exported.tempRoot, { recursive: true, force: true });
        stream.on("close", cleanup);
        stream.on("error", cleanup);
        stream.pipe(response);
        return;
      }
      if (!stats.isFile()) {
        jsonResponse(response, 400, { error: "Only files and folders can be downloaded." });
        return;
      }
      const contentType = contentTypeForFile(fullPath);
      streamFileResponse(
        request,
        response,
        fullPath,
        contentType,
        attachmentHeaders(path.basename(fullPath), contentType)
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/project/open") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      if (blockProjectSwitchWhileSharing(state, response)) return;
      const body = await readBody(request);
      const nextRoot = path.resolve(body.path || SAMPLE_PROJECT);
      if (!fs.existsSync(nextRoot) || !fs.statSync(nextRoot).isDirectory()) {
        jsonResponse(response, 400, { error: "Project folder was not found." });
        return;
      }
      setProjectRoot(state, nextRoot);
      broadcastState(state);
      jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/project/new") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      const body = await readBody(request);
      const requestId = String(body.requestId || "").trim();
      if (requestId && !/^[A-Za-z0-9_-]{8,100}$/u.test(requestId)) {
        jsonResponse(response, 400, { error: "Project creation request ID is invalid." });
        return;
      }
      const requestSignature = JSON.stringify({
        projectName: body.projectName === undefined ? null : body.projectName,
        destinationDirectory: body.destinationDirectory === undefined ? null : body.destinationDirectory
      });
      const previousCreation = requestId ? state.projectCreations.get(requestId) : null;
      if (previousCreation) {
        if (previousCreation.signature !== requestSignature) {
          jsonResponse(response, 409, {
            error: "This project creation request ID was already used with different details.",
            code: "PROJECT_CREATE_IDEMPOTENCY_CONFLICT"
          });
          return;
        }
        let cachedProjectAvailable = false;
        try {
          cachedProjectAvailable = fs.statSync(previousCreation.projectRoot).isDirectory();
        } catch {
          cachedProjectAvailable = false;
        }
        if (cachedProjectAvailable) {
          if (path.resolve(state.project.root) !== path.resolve(previousCreation.projectRoot)) {
            if (blockProjectSwitchWhileSharing(state, response)) return;
            setProjectRoot(state, previousCreation.projectRoot);
            broadcastState(state);
          }
          jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
          return;
        }
        state.projectCreations.delete(requestId);
      }
      if (blockProjectSwitchWhileSharing(state, response)) return;
      let projectRoot;
      let committed = false;
      try {
        projectRoot = createNewTemplateProject({
          projectName: body.projectName,
          destinationDirectory: body.destinationDirectory
        });
        setProjectRoot(state, projectRoot);
        committed = true;
        state.compile.logs = [`[LocalLeaf] New project created from the starter template: ${state.project.name}`];
        if (requestId) {
          state.projectCreations.set(requestId, { signature: requestSignature, projectRoot });
          while (state.projectCreations.size > 50) {
            state.projectCreations.delete(state.projectCreations.keys().next().value);
          }
        }
      } catch (error) {
        if (projectRoot && !committed) fs.rmSync(projectRoot, { recursive: true, force: true });
        const message = error.message || "Could not create the project.";
        const field = /destination|folder path|network path|starter template/iu.test(message)
          ? "destinationDirectory"
          : /project name|name is|required name|reserved/iu.test(message)
            ? "projectName"
            : "";
        jsonResponse(response, 400, { error: message, ...(field ? { field } : {}) });
        return;
      }
      broadcastState(state);
      jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/project/import-zip") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      if (blockProjectSwitchWhileSharing(state, response)) return;

      const filename = request.headers["x-file-name"] || "Imported Project.zip";
      const zipBuffer = await readRawBody(request);
      if (zipBuffer.length === 0) {
        jsonResponse(response, 400, { error: "ZIP upload was empty." });
        return;
      }

      let importedRoot;
      try {
        importedRoot = importZipProject(zipBuffer, filename);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      setProjectRoot(state, importedRoot);
      state.compile.logs = [`[LocalLeaf] Imported ZIP project: ${filename}`];
      broadcastState(state);
      jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/project/import-files") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      if (blockProjectSwitchWhileSharing(state, response)) return;

      const payloadBuffer = await readRawBody(request, Math.ceil(MAX_IMPORT_UNCOMPRESSED_BYTES * 1.5));
      if (payloadBuffer.length === 0) {
        jsonResponse(response, 400, { error: "File import was empty." });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(payloadBuffer.toString("utf8"));
      } catch {
        jsonResponse(response, 400, { error: "Invalid file import payload." });
        return;
      }

      let importedRoot;
      try {
        importedRoot = importLooseFilesProject(payload.files, payload.projectName);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      setProjectRoot(state, importedRoot);
      state.compile.logs = [`[LocalLeaf] Imported ${payload.files.length} file${payload.files.length === 1 ? "" : "s"} into: ${state.project.name}`];
      broadcastState(state);
      jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/project/main-file") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before changing project settings."
      });
      if (!authorized) return;
      const { body } = authorized;
      const fullPath = resolveProjectPath(state.project.root, body.path);
      if (!fs.existsSync(fullPath) || path.extname(fullPath).toLowerCase() !== ".tex") {
        jsonResponse(response, 400, { error: "Main file must be an existing .tex file." });
        return;
      }
      state.project.mainFile = body.path;
      broadcastState(state);
      jsonResponse(response, 200, { ok: true, mainFile: state.project.mainFile });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/file") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before changing project files."
      });
      if (!authorized) return;
      const { body } = authorized;
      const filePath = body.path || state.project.mainFile;
      const fullPath = resolveProjectPath(state.project.root, filePath);
      if (!isTextFile(fullPath)) {
        jsonResponse(response, 400, { error: "Only text-based project files are editable." });
        return;
      }

      fs.writeFileSync(fullPath, String(body.content || ""), "utf8");
      refreshProject(state);
      const version = Date.now();
      broadcastCollab(state, {
        type: "file_updated",
        filePath,
        newText: String(body.content || ""),
        userId: isHostRequest(state, request, url) ? "host" : getTokenUser(state, request, url)?.id || "",
        name: body.user || "Unknown",
        version
      });
      broadcastCollab(state, {
        type: "file_saved",
        filePath,
        userId: isHostRequest(state, request, url) ? "host" : getTokenUser(state, request, url)?.id || "",
        name: body.user || "Unknown",
        version
      });
      broadcastProject(state, "file-update", {
        path: filePath,
        content: String(body.content || ""),
        user: body.user || "Unknown",
        version
      });
      broadcastState(state);
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/file/create") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before creating files."
      });
      if (!authorized) return;
      const { body } = authorized;
      const filePath = String(body.path || "").trim();
      const fullPath = resolveProjectPath(state.project.root, filePath);
      if (!isTextFile(fullPath)) {
        jsonResponse(response, 400, { error: "Only text-based project files can be created." });
        return;
      }
      if (fs.existsSync(fullPath)) {
        jsonResponse(response, 409, { error: "A file already exists at that path." });
        return;
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, String(body.content || ""), "utf8");
      refreshProject(state);
      broadcastState(state);
      jsonResponse(response, 200, { ok: true, path: filePath });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/file/upload") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before uploading files.",
        reader: readRawBody
      });
      if (!authorized) return;
      const fileBuffer = authorized.body;
      const filePath = normalizeRelativePath(String(request.headers["x-file-path"] || request.headers["x-file-name"] || "").trim());
      const fullPath = resolveProjectPath(state.project.root, filePath);
      if (!isTextFile(fullPath) && !isImageFile(fullPath)) {
        jsonResponse(response, 400, { error: "Only LaTeX source/support files and image/PDF assets can be uploaded." });
        return;
      }
      if (fs.existsSync(fullPath)) {
        jsonResponse(response, 409, { error: "A file already exists at that path." });
        return;
      }
      if (!fileBuffer.length) {
        jsonResponse(response, 400, { error: "Uploaded file was empty." });
        return;
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, fileBuffer);
      refreshProject(state);
      broadcastState(state);
      jsonResponse(response, 200, { ok: true, path: filePath });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/folder/create") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before creating folders."
      });
      if (!authorized) return;
      const { body } = authorized;
      const folderPath = String(body.path || "").trim();
      const fullPath = resolveProjectPath(state.project.root, folderPath);
      if (fs.existsSync(fullPath)) {
        jsonResponse(response, 409, { error: "A file or folder already exists at that path." });
        return;
      }
      fs.mkdirSync(fullPath, { recursive: true });
      refreshProject(state);
      broadcastState(state);
      jsonResponse(response, 200, { ok: true, path: folderPath });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/file/rename") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before renaming project items."
      });
      if (!authorized) return;
      const { body } = authorized;
      const from = String(body.from || "").trim();
      const to = String(body.to || "").trim();
      const fromPath = resolveProjectPath(state.project.root, from);
      const toPath = resolveProjectPath(state.project.root, to);
      if (!fs.existsSync(fromPath)) {
        jsonResponse(response, 404, { error: "Source file or folder was not found." });
        return;
      }
      if (fs.existsSync(toPath)) {
        jsonResponse(response, 409, { error: "A file or folder already exists at the new path." });
        return;
      }
      const fromStats = fs.statSync(fromPath);
      if (fromStats.isDirectory()) {
        const cleanFrom = normalizeRelativePath(from);
        const cleanTo = normalizeRelativePath(to);
        if (cleanTo === cleanFrom || cleanTo.startsWith(`${cleanFrom}/`)) {
          jsonResponse(response, 400, { error: "A folder cannot be moved inside itself." });
          return;
        }
      } else if (!fromStats.isFile()) {
        jsonResponse(response, 400, { error: "Only files and folders can be renamed." });
        return;
      } else if (!isTextFile(toPath) && !isImageFile(toPath)) {
        jsonResponse(response, 400, { error: "Only text-based files and image assets can be renamed." });
        return;
      }
      fs.mkdirSync(path.dirname(toPath), { recursive: true });
      fs.renameSync(fromPath, toPath);
      if (state.project.mainFile === from) {
        state.project.mainFile = to;
      } else if (fromStats.isDirectory() && state.project.mainFile?.startsWith(`${from}/`)) {
        state.project.mainFile = `${to}${state.project.mainFile.slice(from.length)}`;
      }
      refreshProject(state);
      broadcastState(state);
      jsonResponse(response, 200, { ok: true, path: to });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/file/copy") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before copying project items."
      });
      if (!authorized) return;
      const { body } = authorized;
      const from = String(body.from || "").trim();
      const to = String(body.to || "").trim();
      const fromPath = resolveProjectPath(state.project.root, from);
      const toPath = resolveProjectPath(state.project.root, to);
      if (!fs.existsSync(fromPath)) {
        jsonResponse(response, 404, { error: "Source file or folder was not found." });
        return;
      }
      if (fs.existsSync(toPath)) {
        jsonResponse(response, 409, { error: "A file or folder already exists at the destination path." });
        return;
      }
      const fromStats = fs.statSync(fromPath);
      if (fromStats.isDirectory()) {
        const cleanFrom = normalizeRelativePath(from);
        const cleanTo = normalizeRelativePath(to);
        if (cleanTo === cleanFrom || cleanTo.startsWith(`${cleanFrom}/`)) {
          jsonResponse(response, 400, { error: "A folder cannot be copied inside itself." });
          return;
        }
      }
      try {
        copyProjectItem(fromPath, toPath);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      refreshProject(state);
      broadcastState(state);
      jsonResponse(response, 200, { ok: true, path: to });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/file/delete") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "edit",
        message: "Maintainer access is required before deleting files."
      });
      if (!authorized) return;
      const { body } = authorized;
      const filePath = String(body.path || "").trim();
      const fullPath = resolveProjectPath(state.project.root, filePath);
      if (!fs.existsSync(fullPath)) {
        jsonResponse(response, 404, { error: "File or folder was not found." });
        return;
      }
      const targetStats = fs.statSync(fullPath);
      const deletingDirectory = targetStats.isDirectory();
      if (!targetStats.isFile() && !deletingDirectory) {
        jsonResponse(response, 400, { error: "Only files and folders can be deleted." });
        return;
      }
      const remainingTextFiles = state.project.files.filter((file) => {
        if (file.type !== "text") return false;
        return deletingDirectory ? !file.path.startsWith(`${filePath}/`) : file.path !== filePath;
      });
      if (remainingTextFiles.length < 1) {
        jsonResponse(response, 400, { error: "Cannot delete the last editable file." });
        return;
      }
      if (deletingDirectory) fs.rmSync(fullPath, { recursive: true, force: true });
      else fs.unlinkSync(fullPath);
      if (state.project.mainFile === filePath || state.project.mainFile?.startsWith(`${filePath}/`)) {
        state.project.mainFile = detectMainFile(state.project.root);
      }
      refreshProject(state);
      broadcastState(state);
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/start") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      if (state.session.status === "live") {
        jsonResponse(response, 409, { error: "A sharing session is already live. Stop it before starting another." });
        return;
      }
      const body = await readBody(request);
      let providerPreference;
      try {
        providerPreference = resolveTunnelProviderPreference(state, body);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      if (providerPreference.provided) {
        state.session.tunnel.preferredProviderId = providerPreference.providerId;
      }
      const code = randomCode();
      const lan = getLanAddress();
      const baseUrl = `http://127.0.0.1:${state.port}`;
      const shouldStartPublicTunnel = state.session.tunnel.available && state.session.tunnel.autoStart;
      stopPublicTunnel(state);
      state.session = {
        ...state.session,
        id: randomId(6),
        status: "live",
        code,
        publicUrl: null,
        inviteUrl: null,
        users: [
          {
            id: "host",
            name: getHostName(),
            role: "host",
            color: "#fb6a00",
            online: true
          }
        ],
        joinRequests: [],
        activeTokens: new Map(),
        tunnel: {
          ...state.session.tunnel,
          raceId: null,
          runners: new Map(),
          process: null,
          controller: null,
          providerId: null,
          providerName: null,
          selectionMode: state.session.tunnel.preferredProviderId ? "preferred" : "automatic",
          previousLinkInvalidated: false,
          attempts: [],
          status: shouldStartPublicTunnel
            ? "Starting"
            : state.session.tunnel.available
              ? "Error"
              : "Not installed",
          detail: shouldStartPublicTunnel
            ? `Preparing tunnel providers: ${activeTunnelProviders(state).map((provider) => provider.name).join(", ")}`
            : state.session.tunnel.available
              ? "Public tunnel auto-start is off. Restart LocalLeaf with tunnel auto-start enabled."
              : "A tunnel provider is required before friends can join over the internet."
        },
        network: {
          ...state.session.network,
          lanAddress: lan,
          recommendation: shouldStartPublicTunnel
            ? "Recommended: up to 5 collaborators"
            : "Public tunnel is not active. Friends cannot join until a verified internet link is available."
        }
      };
      state.chat = [];
      cancelGuestAiRuns(state);
      state.ai.guestSessions.clear();

      if (shouldStartPublicTunnel) {
        startPublicTunnel(state, baseUrl);
      }

      broadcastState(state);
      jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/tunnel/restart") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      if (state.session.status !== "live") {
        jsonResponse(response, 409, { error: "Start a live session before restarting its invite link." });
        return;
      }
      if (!state.session.tunnel.available || activeTunnelProviders(state).length === 0) {
        jsonResponse(response, 409, { error: "No tunnel providers are available on this computer." });
        return;
      }
      const body = await readBody(request);
      let providerPreference;
      try {
        providerPreference = resolveTunnelProviderPreference(state, body);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      if (providerPreference.provided) {
        state.session.tunnel.preferredProviderId = providerPreference.providerId;
      }
      const previousLinkInvalidated = Boolean(state.session.inviteUrl);
      if (previousLinkInvalidated) {
        state.session.code = randomCode();
      }
      startPublicTunnel(state, `http://127.0.0.1:${state.port}`, 0, { previousLinkInvalidated });
      jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/stop") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      const endedSessionId = state.session.id;
      applyEndedSessionState(state);
      notifySessionEnded(state, "Host stopped the session.");
      schedulePublicTunnelStop(state, endedSessionId);
      jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/guest/role") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      if (state.session.status !== "live") {
        jsonResponse(response, 409, { error: "Guest roles can only be changed during a live session." });
        return;
      }
      const body = await readBody(request);
      const userId = String(body.userId || "").trim();
      const role = normalizedGuestRole(body.role);
      if (!userId || !role) {
        jsonResponse(response, 400, { error: "Choose either viewer or maintainer for this guest." });
        return;
      }
      const user = state.session.users.find((item) => item.id === userId && item.role !== "host");
      if (!user) {
        jsonResponse(response, 404, { error: "Guest was not found in this live session." });
        return;
      }
      jsonResponse(response, 200, { ok: true, user: setGuestRole(state, user, role) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/guest/remove") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      if (state.session.status !== "live") {
        jsonResponse(response, 409, { error: "Guests can only be removed from a live session." });
        return;
      }
      const body = await readBody(request);
      const userId = String(body.userId || "").trim();
      const user = state.session.users.find((item) => item.id === userId && item.role !== "host");
      if (!user) {
        jsonResponse(response, 404, { error: "Guest was not found in this live session." });
        return;
      }
      jsonResponse(response, 200, { ok: true, user: removeGuestAccess(state, user) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/join") {
      const body = await readBody(request);
      const name = String(body.name || "").trim().slice(0, 40);
      const code = String(body.code || "").trim().toUpperCase();

      if (state.session.status !== "live" || code !== state.session.code) {
        jsonResponse(response, 404, { error: "Session not found or already ended." });
        return;
      }

      if (!name) {
        jsonResponse(response, 400, { error: "Name is required." });
        return;
      }

      if (sessionGuestCount(state) >= sessionGuestLimit(state)) {
        jsonResponse(response, 429, { error: "This session is full." });
        return;
      }
      if (state.session.joinRequests.filter((item) => item.status === "pending").length >= MAX_PENDING_JOIN_REQUESTS) {
        jsonResponse(response, 429, { error: "Too many join requests are waiting for host approval." });
        return;
      }

      const requestRecord = {
        id: randomId(5),
        name,
        role: "viewer",
        status: "pending",
        createdAt: Date.now()
      };
      if (state.session.joinRequests.length >= MAX_RETAINED_JOIN_REQUESTS) {
        const retainedPending = state.session.joinRequests.filter((item) => item.status === "pending");
        const retainedHandled = state.session.joinRequests
          .filter((item) => item.status !== "pending")
          .slice(-(MAX_RETAINED_JOIN_REQUESTS - retainedPending.length - 1));
        state.session.joinRequests = [...retainedHandled, ...retainedPending];
      }
      state.session.joinRequests.push(requestRecord);
      broadcastHosts(state, "join-request", requestRecord);
      broadcastState(state);
      jsonResponse(response, 200, { requestId: requestRecord.id, status: "pending" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/join-status") {
      const requestId = url.searchParams.get("id");
      const requestRecord = state.session.joinRequests.find((item) => item.id === requestId);
      if (!requestRecord) {
        jsonResponse(response, 404, { error: "Join request not found." });
        return;
      }
      jsonResponse(response, 200, requestRecord);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/join/approve") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      const body = await readBody(request);
      const requestRecord = state.session.joinRequests.find((item) => item.id === body.requestId);
      if (!requestRecord) {
        jsonResponse(response, 404, { error: "Join request not found." });
        return;
      }
      if (requestRecord.status !== "pending") {
        jsonResponse(response, 409, { error: "This join request was already handled." });
        return;
      }
      const role = normalizedGuestRole(body.role, "viewer");
      if (!role) {
        jsonResponse(response, 400, { error: "Choose either viewer or maintainer for this guest." });
        return;
      }
      if (sessionGuestCount(state) >= sessionGuestLimit(state)) {
        jsonResponse(response, 429, { error: "This session is full." });
        return;
      }

      const token = randomId(16);
      const user = {
        id: randomId(5),
        name: requestRecord.name,
        role,
        color: "#d9976f",
        online: false,
        token
      };
      requestRecord.status = "approved";
      requestRecord.role = user.role;
      requestRecord.token = token;
      requestRecord.userId = user.id;
      state.session.activeTokens.set(token, user.id);
      state.session.users.push(user);
      broadcastState(state);
      jsonResponse(response, 200, {
        ok: true,
        user: publicSessionUser(user)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/join/deny") {
      if (!isHostRequest(state, request, url)) {
        deny(response);
        return;
      }
      const body = await readBody(request);
      const requestRecord = state.session.joinRequests.find((item) => item.id === body.requestId);
      if (!requestRecord) {
        jsonResponse(response, 404, { error: "Join request not found." });
        return;
      }
      if (requestRecord.status !== "pending") {
        jsonResponse(response, 409, { error: "This join request was already handled." });
        return;
      }
      requestRecord.status = "denied";
      broadcastState(state);
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/compile") {
      if (!isHostRequest(state, request, url)) {
        deny(response, "Compilation is only available to the local host app.");
        return;
      }
      jsonResponse(response, 200, await enqueueCompile());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pdf/source-position") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "read",
        message: "Join approval is required before mapping PDF source positions."
      });
      if (!authorized) return;
      const { body } = authorized;
      jsonResponse(response, 200, await resolvePdfSourcePosition(state, body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pdf/output-position") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "read",
        message: "Join approval is required before mapping source positions to the PDF."
      });
      if (!authorized) return;
      const { body } = authorized;
      jsonResponse(response, 200, await resolvePdfOutputPosition(state, body));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/pdf") {
      if (!canReadProject(state, request, url)) {
        deny(response, "Join approval is required before reading the PDF.");
        return;
      }
      if (isValidPdfArtifact(state.compile.pdfPath)) {
        const releaseArtifact = retainCompileArtifact(state, state.compile.pdfPath);
        streamFileResponse(request, response, state.compile.pdfPath, "application/pdf", {
          "content-disposition": contentDisposition("inline", safeDownloadName(state.project.name, ".pdf")),
          "x-content-type-options": "nosniff"
        }, {
          onComplete: releaseArtifact
        });
        return;
      }
      textResponse(response, 404, "No PDF is available yet.");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/export/pdf") {
      if (!canReadProject(state, request, url)) {
        deny(response, "Join approval is required before exporting the PDF.");
        return;
      }
      if (isValidPdfArtifact(state.compile.pdfPath)) {
        const releaseArtifact = retainCompileArtifact(state, state.compile.pdfPath);
        streamFileResponse(
          request,
          response,
          state.compile.pdfPath,
          "application/pdf",
          attachmentHeaders(safeDownloadName(state.project.name, ".pdf"), "application/pdf"),
          { onComplete: releaseArtifact }
        );
        return;
      }
      textResponse(response, 404, "No compiled PDF is available yet. Recompile the project first.");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/export/zip") {
      if (!canReadProject(state, request, url)) {
        deny(response, "Join approval is required before exporting the project.");
        return;
      }

      let exported;
      try {
        exported = createProjectZip(state.project.root, state.project.name);
      } catch (error) {
        jsonResponse(response, 500, { error: error.message });
        return;
      }

      response.writeHead(200, attachmentHeaders(path.basename(exported.zipPath), "application/zip"));
      const stream = fs.createReadStream(exported.zipPath);
      const cleanup = () => fs.rmSync(exported.tempRoot, { recursive: true, force: true });
      stream.on("close", cleanup);
      stream.on("error", cleanup);
      stream.pipe(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const authorized = await readAuthorizedRequestPayload(state, request, response, url, {
        capability: "read",
        message: "Join approval is required before sending chat messages."
      });
      if (!authorized) return;
      const { body } = authorized;
      const message = String(body.message || "").trim().slice(0, 500);
      if (!message) {
        jsonResponse(response, 400, { error: "Message is required." });
        return;
      }
      const tokenUser = getTokenUser(state, request, url);
      const hostUser = state.session.users.find((user) => user.id === "host");
      const author = tokenUser
        ? tokenUser.name
        : String(body.author || hostUser?.name || "Host").trim().slice(0, 40) || "Host";
      const chatMessage = {
        id: randomId(5),
        author,
        message,
        createdAt: Date.now()
      };
      state.chat.push(chatMessage);
      state.chat = state.chat.slice(-100);
      broadcastProject(state, "chat", chatMessage);
      broadcastState(state);
      jsonResponse(response, 200, chatMessage);
      return;
    }

    jsonResponse(response, 404, { error: "API route not found." });
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `localhost:${state.port}`}`);

    try {
      if (request.method === "GET" && url.pathname === "/events") {
        const clientId = url.searchParams.get("client") || randomId(5);
        response.writeHead(200, {
          ...securityHeaders(),
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive"
        });
        response.write(": connected\n\n");
        const token = String(getAuthToken(request, url));
        const isHost = isHostRequest(state, request, url);
        const client = {
          response,
          isHost,
          token,
          heartbeat: null
        };
        client.heartbeat = setInterval(() => {
          try {
            response.write(": keepalive\n\n");
          } catch {
            deleteSseClient(state, clientId, client);
          }
        }, 5000);
        state.clients.set(clientId, client);
        const user = tokenUserByToken(state, token);
        sendSse(
          response,
          "state",
          publicState(state, {
            isHost,
            canRead: isHost || Boolean(token && state.session.status === "live" && state.session.activeTokens.has(token)),
            canEdit: isHost || user?.role === "maintainer",
            user
          })
        );
        request.on("close", () => {
          deleteSseClient(state, clientId, client);
        });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }

      if (serveStatic(request, response, url.pathname)) {
        return;
      }

      textResponse(response, 404, "Not found");
    } catch (error) {
      jsonResponse(response, 500, { error: error.message });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || `localhost:${state.port}`}`);
    if (url.pathname !== "/collab") {
      socket.destroy();
      return;
    }
    const identity = websocketIdentity(state, request, url);
    if (!identity.canRead) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      attachCollabClient(state, ws, identity);
    });
  });

  function start(port = state.port) {
    state.port = port;
    return new Promise((resolve, reject) => {
      const handleError = (error) => {
        server.off("listening", handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.off("error", handleError);
        const address = server.address();
        if (address && typeof address === "object") state.port = address.port;
        resolve(server);
      };
      server.once("error", handleError);
      server.once("listening", handleListening);
      server.listen(port, "127.0.0.1");
    });
  }

  async function stop() {
    if (state.session.status === "live") {
      applyEndedSessionState(state);
      notifySessionEnded(state, "Host stopped the session.");
      await new Promise((resolve) => setTimeout(resolve, SERVER_CLOSE_NOTICE_GRACE_MS));
    }
    for (const client of state.clients.values()) {
      if (client.heartbeat) clearInterval(client.heartbeat);
      client.response.end();
    }
    state.clients.clear();
    stopPublicTunnel(state);
    closeCollabClients(state, "Host stopped the session.");
    wss.close();
    if (state.ownsSynctexWorkerClient) await state.synctexWorkerClient.close();
    const closePromise = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();
    await closePromise;
    cleanupAllCompileArtifacts(state);
    return server;
  }

  return {
    server,
    state,
    start,
    stop
  };
}

if (require.main === module) {
  const app = createLocalLeafServer();
  app.start(DEFAULT_PORT).then(() => {
    console.log(`LocalLeaf Host is running at http://localhost:${DEFAULT_PORT}`);
    console.log("Press Ctrl+C to stop the session host.");
  });

  process.on("SIGINT", async () => {
    await app.stop();
    process.exit(0);
  });
}

module.exports = {
  createLocalLeafServer,
  runBoundedChildProcess
};
