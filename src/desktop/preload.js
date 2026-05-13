const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localleafDesktop", {
  maximize() {
    ipcRenderer.send("localleaf:maximize");
  },
  setTheme(theme) {
    ipcRenderer.send("localleaf:theme", theme);
  },
  installUpdate(update) {
    return ipcRenderer.invoke("localleaf:install-update", update);
  },
  chooseModelFolder() {
    return ipcRenderer.invoke("localleaf:choose-model-folder");
  }
});
