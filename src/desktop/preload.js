const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localleafDesktop", {
  maximize() {
    ipcRenderer.send("localleaf:maximize");
  },
  setTheme(theme) {
    ipcRenderer.send("localleaf:theme", theme);
  }
});
