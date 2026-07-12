const { contextBridge, ipcRenderer } = require("electron");

let persistedPreferences = null;
try {
  persistedPreferences = ipcRenderer.sendSync("localleaf:preferences:load");
} catch {
  persistedPreferences = null;
}

contextBridge.exposeInMainWorld("localleafDesktop", {
  preferences: persistedPreferences,
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
  },
  chooseProjectFolder(suggestedPath) {
    return ipcRenderer.invoke("localleaf:choose-project-folder", suggestedPath);
  },
  savePreferences(preferences) {
    ipcRenderer.send("localleaf:preferences:save", preferences);
  }
});
