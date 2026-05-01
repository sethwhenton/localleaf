const path = require("node:path");
const { app, BrowserWindow, Menu, nativeImage, nativeTheme, shell } = require("electron");
const { createLocalLeafServer } = require("../server/index");

let hostServer;
let mainWindow;

function iconPath() {
  return process.platform === "win32"
    ? path.join(__dirname, "../../build/icon.ico")
    : path.join(__dirname, "../../public/assets/localleaf-icon.png");
}

async function startHostServer() {
  hostServer = createLocalLeafServer({ port: 4317 });
  await hostServer.start(4317);
  return "http://localhost:4317";
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
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#ffffff",
      symbolColor: "#6b625a",
      height: 44
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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

app.whenReady().then(async () => {
  app.setAppUserModelId("dev.localleaf.host");
  nativeTheme.themeSource = "light";
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
