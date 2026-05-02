const fs = require("node:fs");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");
const AdmZip = require("adm-zip");
const { WebSocketServer } = require("ws");
const {
  detectMainFile,
  getProjectSize,
  isImageFile,
  isTextFile,
  listProjectFiles,
  resolveProjectPath
} = require("./safe-path");
const { compileProject, commandExists, detectCompiler } = require("./compiler");
const { collectProjectEditorSuggestions } = require("./editor-suggestions");

let localtunnelClient = null;
try {
  localtunnelClient = require("localtunnel");
} catch {
  localtunnelClient = null;
}

const ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SAMPLE_PROJECT = path.join(ROOT, "samples", "thesis");
const DEFAULT_PORT = Number(process.env.PORT || 4317);
const MAX_USERS = 5;
const TUNNEL_VERIFY_ATTEMPTS = 12;
const TUNNEL_RESTART_ATTEMPTS = 3;
const TUNNEL_START_TIMEOUT_MS = 35000;
const SESSION_END_TUNNEL_GRACE_MS = 10000;
const SERVER_CLOSE_NOTICE_GRACE_MS = 350;
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const publicDnsResolver = new dns.Resolver();
publicDnsResolver.setServers(PUBLIC_DNS_SERVERS);

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

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function textResponse(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(payload);
}

function isHostRequest(request) {
  const host = String(request.headers.host || "").toLowerCase();
  return (
    host.startsWith("localhost:") ||
    host.startsWith("127.0.0.1:") ||
    host.startsWith("[::1]:")
  );
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
  const token = String(getAuthToken(request, url));
  const userId = token ? state.session.activeTokens.get(token) : null;
  return userId ? state.session.users.find((user) => user.id === userId) : null;
}

function canReadProject(state, request, url) {
  return isHostRequest(request) || Boolean(getTokenUser(state, request, url));
}

function canEditProject(state, request, url) {
  if (isHostRequest(request)) return true;
  const user = getTokenUser(state, request, url);
  return Boolean(user && user.role === "editor");
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
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
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

function sshKnownHostsTarget() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function createSshArgs() {
  return [
    "-o", "StrictHostKeyChecking=no",
    "-o", `UserKnownHostsFile=${sshKnownHostsTarget()}`,
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

function ensureDefaultProjectRoot(options = {}) {
  if (options.projectRoot) {
    return path.resolve(options.projectRoot);
  }

  const projectRoot = path.join(getUserProjectsDir(), "Thesis Draft");
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
  for (const entry of zip.getEntries()) {
    const entryName = entry.entryName.replace(/\\/g, "/");
    if (!entryName || entryName.startsWith("/") || /^[a-zA-Z]:\//.test(entryName)) {
      throw new Error("ZIP contains an unsafe absolute path.");
    }

    const target = path.resolve(extractRoot, entryName);
    assertInsideDirectory(extractRoot, target);

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
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

function safeDownloadName(name, extension) {
  const base = sanitizeProjectName(name || "LocalLeaf Project")
    .replace(/\s+/g, "_")
    .replace(/\.+$/g, "");
  return `${base || "LocalLeaf_Project"}${extension}`;
}

function attachmentHeaders(filename, contentType) {
  const cleanName = String(filename).replace(/["\r\n]/g, "_");
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${cleanName}"`,
    "cache-control": "no-store"
  };
}

function streamFileResponse(request, response, filePath, contentType, extraHeaders = {}) {
  const { size } = fs.statSync(filePath);
  const commonHeaders = {
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
    fs.createReadStream(filePath).pipe(response);
    return;
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
    return;
  }

  end = Math.min(end, size - 1);
  response.writeHead(206, {
    ...commonHeaders,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`
  });
  fs.createReadStream(filePath, { start, end }).pipe(response);
}

function addDirectoryToZip(zip, directory, baseDirectory = directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
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

function createInitialState(options = {}) {
  const projectRoot = ensureDefaultProjectRoot(options);
  const mainFile = detectMainFile(projectRoot);
  const compiler = detectCompiler();
  const tunnelProviders = options.tunnelProviders || createTunnelProviders();
  const tunnelReady = tunnelProviders.length > 0;
  const autoStartTunnel = options.autoStartTunnel !== false;

  return {
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
      maxUsers: MAX_USERS,
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
      version: 0
    },
    chat: [],
    clients: new Map(),
    collabClients: new Map(),
    tunnelCheck: options.checkPublicTunnel || checkPublicTunnel
  };
}

function publicState(state, options = {}) {
  const isHost = Boolean(options.isHost);
  const canRead = isHost || Boolean(options.canRead);
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
    port: state.port,
    project: {
      id: state.project.id,
      name: state.project.name,
      root: isHost ? state.project.root : "Stored on host computer",
      mainFile: canRead ? state.project.mainFile : "",
      files: canRead ? state.project.files : [],
      size: canRead ? state.project.size : 0,
      sizeLabel: canRead ? formatBytes(state.project.size) : "Hidden until approved"
    },
    session: {
      ...state.session,
      activeTokens: undefined,
      users: canRead ? users : [],
      joinRequests,
      tunnel: {
        available: state.session.tunnel.available,
        status: state.session.tunnel.status,
        detail: state.session.tunnel.detail,
        autoStart: state.session.tunnel.autoStart,
        providerId: state.session.tunnel.providerId,
        providerName: state.session.tunnel.providerName,
        providers: (state.session.tunnel.providers || []).map((provider) => ({
          id: provider.id,
          name: provider.name,
          hint: provider.hint
        })),
        attempts: state.session.tunnel.attempts || []
      }
    },
    compiler: state.compiler,
    compile: canRead
      ? state.compile
      : {
          status: "idle",
          engine: state.compile.engine,
          mode: "html",
          logs: [],
          previewHtml: "",
          pdfPath: null,
          version: state.compile.version
        },
    chat: canRead ? state.chat : []
  };
}

function sendSse(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(state, event, payload) {
  for (const [id, client] of state.clients) {
    try {
      sendSse(client.response, event, payload);
    } catch {
      state.clients.delete(id);
    }
  }
}

function clientCanReadProject(state, client) {
  return client.isHost || Boolean(client.token && state.session.activeTokens.has(client.token));
}

function tokenUserByToken(state, token) {
  const userId = token ? state.session.activeTokens.get(String(token)) : null;
  return userId ? state.session.users.find((user) => user.id === userId) : null;
}

function websocketIdentity(state, request, url) {
  const isHost = isHostRequest(request);
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
      canEdit: tokenUser.role === "editor"
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
      sendSse(client.response, event, payload);
    } catch {
      state.clients.delete(id);
    }
  }
}

function broadcastHosts(state, event, payload) {
  for (const [id, client] of state.clients) {
    if (!client.isHost) continue;
    try {
      sendSse(client.response, event, payload);
    } catch {
      state.clients.delete(id);
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
    state: publicState(state, { isHost: client.isHost, canRead: true }),
    presence: collabPresence(state)
  });

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
    sendWs(client, { type: "session_ended", reason: "Host stopped the session." });
    client.socket.close();
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
    if (!client.canEdit) {
      sendWs(client, { type: "error", message: "Editor access is required before changing files." });
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
    if (!client.canEdit) {
      sendWs(client, { type: "error", message: "Editor access is required before saving files." });
      return;
    }
    const filePath = String(payload.filePath || "").trim();
    try {
      readTextFileForCollab(state, filePath);
      broadcastCollab(state, {
        type: "file_saved",
        filePath,
        userId: client.userId,
        name: client.name,
        version: Date.now()
      });
    } catch (error) {
      sendWs(client, { type: "error", message: error.message });
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
    try {
      sendSse(
        client.response,
        "state",
        publicState(state, {
          isHost: client.isHost,
          canRead: clientCanReadProject(state, client)
        })
      );
    } catch {
      state.clients.delete(id);
    }
  }
}

function refreshProject(state) {
  state.project.files = listProjectFiles(state.project.root);
  state.project.size = getProjectSize(state.project.root);
  if (!state.project.mainFile) {
    state.project.mainFile = detectMainFile(state.project.root);
  }
}

function setProjectRoot(state, projectRoot) {
  const root = path.resolve(projectRoot);
  const mainFile = detectMainFile(root);
  state.project = {
    id: randomId(6),
    name: path.basename(root),
    root,
    mainFile,
    files: listProjectFiles(root),
    size: getProjectSize(root)
  };
  state.compile = {
    ...state.compile,
    status: "idle",
    logs: ["[LocalLeaf] Project opened."],
    previewHtml: "",
    pdfPath: null,
    version: state.compile.version + 1
  };
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
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "cache-control": "no-store"
  });
  fs.createReadStream(target).pipe(response);
  return true;
}

function activeTunnelProviders(state) {
  return state.session.tunnel.providers || [];
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

function startPublicTunnel(state, baseUrl, restartAttempt = 0) {
  const providers = activeTunnelProviders(state);
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
  state.session.tunnel.status = "Starting";
  state.session.tunnel.detail = restartAttempt
    ? `Racing tunnel providers again (${restartAttempt + 1}/${TUNNEL_RESTART_ATTEMPTS})`
    : `Racing tunnel providers: ${providers.map((provider) => provider.name).join(", ")}`;
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
    const publicUrl = parseProviderUrl(provider, text);
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
  state.session.tunnel.detail = `${provider.name} won the tunnel race and verified the public link`;
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
    state.session.tunnel.status = "Retrying";
    state.session.tunnel.providerId = null;
    state.session.tunnel.providerName = null;
    state.session.tunnel.detail = `All tunnel providers failed. Racing them again...`;
    broadcastState(state);
    setTimeout(() => {
      const canRetry = state.session.status === "live" && state.session.code === code && !state.session.inviteUrl;
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
    state.session.tunnel.status = "Retrying";
    state.session.tunnel.detail = `${provider.name} tunnel stopped. Racing tunnel providers again...`;
    broadcastState(state);
    setTimeout(() => {
      const canRetry = state.session.status === "live" && state.session.code === runner.code && !state.session.inviteUrl;
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

function applyEndedSessionState(state) {
  state.session.status = "ended";
  state.session.inviteUrl = null;
  state.session.publicUrl = null;
  state.session.joinRequests = [];
  state.session.users = state.session.users.map((user) => ({ ...user, online: user.role === "host" }));
  state.session.tunnel.providerId = null;
  state.session.tunnel.providerName = null;
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

function checkPublicTunnel(publicUrl) {
  return new Promise((resolve) => {
    const request = https.get(
      `${publicUrl}/api/state`,
      {
        timeout: 8000,
        lookup: lookupPublicHostname
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
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
  (state.tunnelCheck || checkPublicTunnel)(publicUrl).then((ok) => {
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
  const wss = new WebSocketServer({ noServer: true });

  async function handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/state") {
      const isHost = isHostRequest(request);
      jsonResponse(response, 200, publicState(state, { isHost, canRead: isHost || Boolean(getTokenUser(state, request, url)) }));
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

    if (request.method === "POST" && url.pathname === "/api/project/open") {
      if (!isHostRequest(request)) {
        deny(response);
        return;
      }
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

    if (request.method === "POST" && url.pathname === "/api/project/import-zip") {
      if (!isHostRequest(request)) {
        deny(response);
        return;
      }

      const filename = request.headers["x-file-name"] || "Imported Project.zip";
      const zipBuffer = await readRawBody(request);
      if (zipBuffer.length === 0) {
        jsonResponse(response, 400, { error: "ZIP upload was empty." });
        return;
      }

      const importedRoot = importZipProject(zipBuffer, filename);
      setProjectRoot(state, importedRoot);
      state.compile.logs = [`[LocalLeaf] Imported ZIP project: ${filename}`];
      broadcastState(state);
      jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/project/main-file") {
      if (!canEditProject(state, request, url)) {
        deny(response, "Editor approval is required before changing project settings.");
        return;
      }
      const body = await readBody(request);
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
      if (!canEditProject(state, request, url)) {
        deny(response, "Editor approval is required before changing project files.");
        return;
      }
      const body = await readBody(request);
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
        userId: isHostRequest(request) ? "host" : getTokenUser(state, request, url)?.id || "",
        name: body.user || "Unknown",
        version
      });
      broadcastCollab(state, {
        type: "file_saved",
        filePath,
        userId: isHostRequest(request) ? "host" : getTokenUser(state, request, url)?.id || "",
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
      if (!canEditProject(state, request, url)) {
        deny(response, "Editor approval is required before creating files.");
        return;
      }
      const body = await readBody(request);
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
      if (!canEditProject(state, request, url)) {
        deny(response, "Editor approval is required before uploading files.");
        return;
      }
      const filePath = String(request.headers["x-file-path"] || request.headers["x-file-name"] || "").trim();
      const fullPath = resolveProjectPath(state.project.root, filePath);
      if (fs.existsSync(fullPath)) {
        jsonResponse(response, 409, { error: "A file already exists at that path." });
        return;
      }
      const fileBuffer = await readRawBody(request);
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
      if (!canEditProject(state, request, url)) {
        deny(response, "Editor approval is required before creating folders.");
        return;
      }
      const body = await readBody(request);
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
      if (!canEditProject(state, request, url)) {
        deny(response, "Editor approval is required before renaming files.");
        return;
      }
      const body = await readBody(request);
      const from = String(body.from || "").trim();
      const to = String(body.to || "").trim();
      const fromPath = resolveProjectPath(state.project.root, from);
      const toPath = resolveProjectPath(state.project.root, to);
      if (!fs.existsSync(fromPath) || !fs.statSync(fromPath).isFile()) {
        jsonResponse(response, 404, { error: "Source file was not found." });
        return;
      }
      if (fs.existsSync(toPath)) {
        jsonResponse(response, 409, { error: "A file already exists at the new path." });
        return;
      }
      if (!isTextFile(toPath) && !isImageFile(toPath)) {
        jsonResponse(response, 400, { error: "Only text-based files and image assets can be renamed." });
        return;
      }
      fs.mkdirSync(path.dirname(toPath), { recursive: true });
      fs.renameSync(fromPath, toPath);
      if (state.project.mainFile === from) {
        state.project.mainFile = to;
      }
      refreshProject(state);
      broadcastState(state);
      jsonResponse(response, 200, { ok: true, path: to });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/file/delete") {
      if (!canEditProject(state, request, url)) {
        deny(response, "Editor approval is required before deleting files.");
        return;
      }
      const body = await readBody(request);
      const filePath = String(body.path || "").trim();
      const fullPath = resolveProjectPath(state.project.root, filePath);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        jsonResponse(response, 404, { error: "File was not found." });
        return;
      }
      if (state.project.files.filter((file) => file.type === "text").length <= 1) {
        jsonResponse(response, 400, { error: "Cannot delete the last editable file." });
        return;
      }
      fs.unlinkSync(fullPath);
      if (state.project.mainFile === filePath) {
        state.project.mainFile = detectMainFile(state.project.root);
      }
      refreshProject(state);
      broadcastState(state);
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/start") {
      if (!isHostRequest(request)) {
        deny(response);
        return;
      }
      const code = randomCode();
      const lan = getLanAddress();
      const baseUrl = `http://localhost:${state.port}`;
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

      if (shouldStartPublicTunnel) {
        startPublicTunnel(state, baseUrl);
      }

      broadcastState(state);
      jsonResponse(response, 200, publicState(state, { isHost: true, canRead: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/stop") {
      if (!isHostRequest(request)) {
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

      if (state.session.users.length >= state.session.maxUsers) {
        jsonResponse(response, 429, { error: "This session is full." });
        return;
      }

      const requestRecord = {
        id: randomId(5),
        name,
        role: "editor",
        status: "pending",
        createdAt: Date.now()
      };
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
      if (!isHostRequest(request)) {
        deny(response);
        return;
      }
      const body = await readBody(request);
      const requestRecord = state.session.joinRequests.find((item) => item.id === body.requestId);
      if (!requestRecord) {
        jsonResponse(response, 404, { error: "Join request not found." });
        return;
      }

      const token = randomId(16);
      const user = {
        id: randomId(5),
        name: requestRecord.name,
        role: body.role === "viewer" ? "viewer" : "editor",
        color: "#d9976f",
        online: true,
        token
      };
      requestRecord.status = "approved";
      requestRecord.token = token;
      requestRecord.userId = user.id;
      state.session.activeTokens.set(token, user.id);
      state.session.users.push(user);
      broadcastState(state);
      jsonResponse(response, 200, {
        ok: true,
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
          color: user.color,
          online: user.online
        }
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/join/deny") {
      if (!isHostRequest(request)) {
        deny(response);
        return;
      }
      const body = await readBody(request);
      const requestRecord = state.session.joinRequests.find((item) => item.id === body.requestId);
      if (!requestRecord) {
        jsonResponse(response, 404, { error: "Join request not found." });
        return;
      }
      requestRecord.status = "denied";
      broadcastState(state);
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/compile") {
      if (!canEditProject(state, request, url)) {
        deny(response, "Editor approval is required before compiling.");
        return;
      }
      state.compile = {
        ...state.compile,
        status: "running",
        logs: ["[LocalLeaf] Compile started..."],
        version: state.compile.version + 1
      };
      broadcastProject(state, "compile", state.compile);

      const result = await compileProject(state.project.root, state.project.mainFile, (chunk) => {
        state.compile.logs = [...state.compile.logs, ...chunk.split(/\r?\n/).filter(Boolean)].slice(-300);
        broadcastProject(state, "compile", state.compile);
      });

      state.compile = {
        status: result.ok ? "success" : "failed",
        engine: result.engine,
        mode: result.mode,
        logs: result.logs.length ? result.logs : state.compile.logs,
        previewHtml: result.previewHtml,
        pdfPath: result.pdfPath,
        version: state.compile.version + 1
      };
      broadcastProject(state, "compile", state.compile);
      broadcastState(state);
      jsonResponse(response, 200, state.compile);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/pdf") {
      if (!canReadProject(state, request, url)) {
        deny(response, "Join approval is required before reading the PDF.");
        return;
      }
      if (state.compile.pdfPath && fs.existsSync(state.compile.pdfPath)) {
        streamFileResponse(request, response, state.compile.pdfPath, "application/pdf", {
          "content-disposition": `inline; filename="${safeDownloadName(state.project.name, ".pdf")}"`
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
      if (state.compile.pdfPath && fs.existsSync(state.compile.pdfPath)) {
        streamFileResponse(
          request,
          response,
          state.compile.pdfPath,
          "application/pdf",
          attachmentHeaders(safeDownloadName(state.project.name, ".pdf"), "application/pdf")
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
      if (!canReadProject(state, request, url)) {
        deny(response, "Join approval is required before sending chat messages.");
        return;
      }
      const body = await readBody(request);
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
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive"
        });
        response.write(": connected\n\n");
        const token = String(getAuthToken(request, url));
        state.clients.set(clientId, {
          response,
          isHost: isHostRequest(request),
          token
        });
        sendSse(
          response,
          "state",
          publicState(state, {
            isHost: isHostRequest(request),
            canRead: isHostRequest(request) || Boolean(token && state.session.activeTokens.has(token))
          })
        );
        request.on("close", () => {
          state.clients.delete(clientId);
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
    return new Promise((resolve) => {
      server.listen(port, () => resolve(server));
    });
  }

  async function stop() {
    if (state.session.status === "live") {
      applyEndedSessionState(state);
      notifySessionEnded(state, "Host stopped the session.");
      await new Promise((resolve) => setTimeout(resolve, SERVER_CLOSE_NOTICE_GRACE_MS));
    }
    stopPublicTunnel(state);
    closeCollabClients(state, "Host stopped the session.");
    wss.close();
    return new Promise((resolve) => server.close(resolve));
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
  createLocalLeafServer
};
