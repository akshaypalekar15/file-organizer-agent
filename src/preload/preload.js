const { contextBridge, ipcRenderer } = require("electron");

// The per-launch API token, handed over by the main process via
// additionalArguments. It is read here and exposed to the renderer so its own
// fetches can authenticate; it is never a secret from the app itself, only
// from other web pages, which cannot read it.
const tokenArg = process.argv.find((arg) => arg.startsWith("--api-token="));
const apiToken = tokenArg ? tokenArg.slice("--api-token=".length) : "";

// Only expose the specific, narrow capabilities the UI needs —
// never expose ipcRenderer or Node's fs directly. getSettings() returns a
// summary (hasKey, keySource) and never the key itself.
contextBridge.exposeInMainWorld("agent", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  clearApiKey: () => ipcRenderer.invoke("settings:clear"),
  confirmClear: (summary) => ipcRenderer.invoke("confirm-clear", summary),
  confirmApply: (summary) => ipcRenderer.invoke("confirm-apply", summary),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  apiBase: "http://127.0.0.1:4287",
  apiToken,
});
