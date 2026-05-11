const path = require("node:path");
const { app, BrowserWindow, Menu, ipcMain, nativeImage, nativeTheme, shell } = require("electron");
const { createLocalLeafServer } = require("../server/index");

let hostServer;
let mainWindow;

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

async function startHostServer() {
  hostServer = createLocalLeafServer({ port: 4317 });
  await hostServer.start(4317);
  return `http://localhost:4317/?host=${encodeURIComponent(hostServer.state.hostToken)}`;
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
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });

  mainWindow.loadURL(url);
}

ipcMain.on("localleaf:maximize", (event) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (targetWindow && !targetWindow.isMaximized()) {
    targetWindow.maximize();
  }
});

ipcMain.on("localleaf:theme", (event, theme) => {
  applyDesktopTheme(theme, BrowserWindow.fromWebContents(event.sender));
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
});

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
