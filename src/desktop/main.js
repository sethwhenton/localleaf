const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, shell } = require("electron");
const { createLocalLeafServer } = require("../server/index");
const { readDesktopPreferences, writeDesktopPreferences } = require("./preferences");

let hostServer;
let mainWindow;
let hostOrigin = "";
const UPDATE_REDIRECT_LIMIT = 5;
const UPDATE_REPOSITORY_PATH = "/sethwhenton/localleaf/";
const UPDATE_REDIRECT_HOSTS = new Set([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);

function isAllowedUpdateUrl(rawUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  if (!options.redirect) {
    return host === "github.com"
      && parsed.pathname.toLowerCase().startsWith(UPDATE_REPOSITORY_PATH);
  }
  return UPDATE_REDIRECT_HOSTS.has(host) || host.endsWith(".githubusercontent.com");
}

function expectedInstallerExtension() {
  if (process.platform === "win32") return ".exe";
  if (process.platform === "darwin") return ".dmg";
  return ".zip";
}

function safeInstallerVersion(value) {
  return String(value || "latest").replace(/^v/i, "").replace(/[^0-9A-Za-z._-]+/g, "-").slice(0, 40) || "latest";
}

function updateInstallerPath(version) {
  const extension = expectedInstallerExtension();
  const updateDir = path.join(os.tmpdir(), "LocalLeaf", "updates");
  fs.mkdirSync(updateDir, { recursive: true });
  return path.join(updateDir, `LocalLeaf-Host-${safeInstallerVersion(version)}${extension}`);
}

function downloadUpdateInstaller(rawUrl, version, redirectCount = 0) {
  if (redirectCount > UPDATE_REDIRECT_LIMIT) {
    return Promise.reject(new Error("Update download redirected too many times."));
  }
  if (!isAllowedUpdateUrl(rawUrl, { redirect: redirectCount > 0 })) {
    return Promise.reject(new Error("Update download URL is not trusted."));
  }
  const parsed = new URL(rawUrl);
  const extension = expectedInstallerExtension();
  if (redirectCount === 0 && !parsed.pathname.toLowerCase().endsWith(extension)) {
    return Promise.reject(new Error(`Expected a LocalLeaf ${extension} installer for this computer.`));
  }

  return new Promise((resolve, reject) => {
    const request = https.get(
      parsed,
      {
        timeout: 30000,
        headers: {
          "user-agent": "LocalLeaf-Updater"
        }
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
          response.resume();
          const nextUrl = new URL(response.headers.location, parsed).toString();
          downloadUpdateInstaller(nextUrl, version, redirectCount + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Update download failed with HTTP ${response.statusCode}.`));
          return;
        }

        const installerPath = updateInstallerPath(version);
        const tempPath = `${installerPath}.download`;
        const file = fs.createWriteStream(tempPath);
        response.pipe(file);
        file.on("finish", () => {
          file.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            fs.rename(tempPath, installerPath, (renameError) => {
              if (renameError) reject(renameError);
              else resolve(installerPath);
            });
          });
        });
        file.on("error", (error) => {
          fs.rm(tempPath, { force: true }, () => reject(error));
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("Update download timed out.")));
    request.on("error", reject);
  });
}

function isTrustedRendererEvent(event) {
  if (!hostOrigin) return false;
  try {
    return new URL(event.senderFrame?.url || event.sender?.getURL?.() || "").origin === hostOrigin;
  } catch {
    return false;
  }
}

function requireTrustedRenderer(event) {
  if (!isTrustedRendererEvent(event)) {
    throw new Error("Blocked a LocalLeaf desktop request from an untrusted page.");
  }
}

function safeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (parsed.protocol === "https:" || parsed.origin === hostOrigin) return parsed.toString();
    return "";
  } catch {
    return "";
  }
}

function titleBarTheme(theme) {
  return theme === "dark"
    ? { color: "#10110f", symbolColor: "#f4eee6", height: 44 }
    : { color: "#ffffff", symbolColor: "#6b625a", height: 44 };
}

function applyDesktopTheme(theme, targetWindow = mainWindow) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  const overlay = titleBarTheme(nextTheme);
  nativeTheme.themeSource = nextTheme;
  if (!targetWindow) return;
  targetWindow.setBackgroundColor(overlay.color);
  if (typeof targetWindow.setTitleBarOverlay === "function") {
    targetWindow.setTitleBarOverlay(overlay);
  }
}

function iconPath() {
  return process.platform === "win32"
    ? path.join(__dirname, "../../build/icon.ico")
    : path.join(__dirname, "../../public/assets/localleaf-icon.png");
}

function defaultModelRoot() {
  return path.join(app.getPath("userData"), "LocalLeafModel");
}

function defaultAiSessionRoot() {
  return path.join(app.getPath("userData"), "AiSessions");
}

function defaultAiChangeRoot() {
  return path.join(app.getPath("userData"), "AiChanges");
}

function rendererPreferencesPath() {
  return path.join(app.getPath("userData"), "renderer-preferences.json");
}

function createAiSecretStore() {
  let root = defaultModelRoot();
  const memorySecrets = new Map();

  function filePath() {
    return path.join(root, "provider-secrets.json");
  }

  function readSecrets() {
    try {
      return JSON.parse(fs.readFileSync(filePath(), "utf8"));
    } catch {
      return {};
    }
  }

  function writeSecrets(payload) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(payload, null, 2), "utf8");
  }

  return {
    setRoot(nextRoot) {
      root = nextRoot || root;
    },
    async getSecret(id) {
      if (!safeStorage.isEncryptionAvailable()) return memorySecrets.get(id) || "";
      const payload = readSecrets();
      const encrypted = payload[id];
      if (!encrypted) return "";
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    },
    async setSecret(id, value) {
      if (!value) {
        await this.deleteSecret(id);
        return;
      }
      if (!safeStorage.isEncryptionAvailable()) {
        memorySecrets.set(id, value);
        return;
      }
      const payload = readSecrets();
      payload[id] = safeStorage.encryptString(value).toString("base64");
      writeSecrets(payload);
    },
    async deleteSecret(id) {
      memorySecrets.delete(id);
      if (!safeStorage.isEncryptionAvailable()) return;
      const payload = readSecrets();
      delete payload[id];
      writeSecrets(payload);
    }
  };
}

async function startHostServer() {
  const modelRoot = defaultModelRoot();
  try {
    fs.mkdirSync(modelRoot, { recursive: true });
  } catch {
    // The server can decide how to fall back if the desktop default is unavailable.
  }
  hostServer = createLocalLeafServer({
    port: 0,
    modelRoot,
    aiSessionRoot: defaultAiSessionRoot(),
    aiChangeRoot: defaultAiChangeRoot(),
    aiSecretStore: createAiSecretStore()
  });
  await hostServer.start(0);
  hostOrigin = `http://127.0.0.1:${hostServer.state.port}`;
  return `${hostOrigin}/?host=${encodeURIComponent(hostServer.state.hostToken)}`;
}

function createWindow(url) {
  const windowIcon = nativeImage.createFromPath(iconPath());
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: "LocalLeaf Host",
    icon: windowIcon,
    backgroundColor: "#10110f",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarTheme("dark"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });
  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setMenu(null);

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const externalUrl = safeExternalUrl(targetUrl);
    if (externalUrl) shell.openExternal(externalUrl);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    let targetOrigin = "";
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      // Invalid navigation targets are blocked below.
    }
    if (targetOrigin !== hostOrigin) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());

  mainWindow.loadURL(url);
}

ipcMain.on("localleaf:maximize", (event) => {
  if (!isTrustedRendererEvent(event)) return;
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (targetWindow && !targetWindow.isMaximized()) {
    targetWindow.maximize();
  }
});

ipcMain.on("localleaf:theme", (event, theme) => {
  if (!isTrustedRendererEvent(event)) return;
  applyDesktopTheme(theme, BrowserWindow.fromWebContents(event.sender));
});

ipcMain.on("localleaf:preferences:load", (event) => {
  if (!isTrustedRendererEvent(event)) {
    event.returnValue = null;
    return;
  }
  event.returnValue = readDesktopPreferences(rendererPreferencesPath());
});

ipcMain.on("localleaf:preferences:save", (event, preferences) => {
  if (!isTrustedRendererEvent(event)) return;
  try {
    writeDesktopPreferences(rendererPreferencesPath(), preferences);
  } catch {
    // Preferences remain available in the renderer for this run even if the app-private file cannot be updated.
  }
});

ipcMain.handle("localleaf:install-update", async (event, update = {}) => {
  requireTrustedRenderer(event);
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  const downloadUrl = String(update.downloadUrl || "");
  const version = String(update.version || update.latestVersion || "latest");
  const installerPath = await downloadUpdateInstaller(downloadUrl, version);
  const openError = await shell.openPath(installerPath);
  if (openError) throw new Error(openError);
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.focus();
  }
  return { ok: true, installerPath };
});

ipcMain.handle("localleaf:choose-model-folder", async (event) => {
  requireTrustedRenderer(event);
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(targetWindow || undefined, {
    title: "Choose AI model folder",
    properties: ["openDirectory", "createDirectory"]
  });
  return {
    canceled: result.canceled,
    folderPath: result.canceled ? null : result.filePaths[0] || null
  };
});

ipcMain.handle("localleaf:choose-project-folder", async (event, suggestedPath) => {
  requireTrustedRenderer(event);
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  const candidatePath = typeof suggestedPath === "string" ? suggestedPath.trim() : "";
  let defaultPath;
  try {
    if (candidatePath && path.isAbsolute(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
      defaultPath = path.resolve(candidatePath);
    }
  } catch {
    defaultPath = undefined;
  }
  const result = await dialog.showOpenDialog(targetWindow || undefined, {
    title: "Choose where to create the project",
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath ? { defaultPath } : {})
  });
  return {
    canceled: result.canceled,
    folderPath: result.canceled ? null : result.filePaths[0] || null
  };
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("dev.localleaf.host");
    nativeTheme.themeSource = "dark";
    Menu.setApplicationMenu(null);
    const url = await startHostServer();
    createWindow(url);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(url);
      }
    });
  }).catch((error) => {
    dialog.showErrorBox(
      "LocalLeaf could not start",
      error?.message || "The local host service could not be started."
    );
    app.quit();
  });
}

app.on("before-quit", async (event) => {
  if (!hostServer) return;
  event.preventDefault();
  const server = hostServer;
  hostServer = null;
  await server.stop();
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
