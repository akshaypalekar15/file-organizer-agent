const { contextBridge, ipcRenderer } = require("electron");

// Only expose the specific, narrow capabilities the UI needs —
// never expose ipcRenderer or Node's fs directly. getSettings() returns a
// summary (hasKey, keySource) and never the key itself.
contextBridge.exposeInMainWorld("agent", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  clearApiKey: () => ipcRenderer.invoke("settings:clear"),
  confirmClear: (summary) => ipcRenderer.invoke("confirm-clear", summary),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  apiBase: "http://127.0.0.1:4287",
});
