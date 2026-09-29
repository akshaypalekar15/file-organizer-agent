const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const { loadEnv } = require("./env");
const { getSettings, saveSettings, clearApiKey } = require("./settings");
const { startServer } = require("./server");
const { stopAll } = require("./watcher");

// Pick up OPENROUTER_API_KEY etc. from .env before anything reads them.
loadEnv();

// The renderer can only ask us to open links on these hosts.
const EXTERNAL_LINK_ALLOWLIST = ["https://openrouter.ai"];

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

// Renderer asks the main process to open a native folder picker —
// the browser sandbox can't do this on its own.
ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// Settings dialog (BYOK). saveSettings validates and encrypts; the raw key
// never travels back to the renderer, only the summary from getSettings().
ipcMain.handle("settings:get", () => getSettings());

ipcMain.handle("settings:save", async (_event, payload) => {
  try {
    return { ok: true, settings: saveSettings(payload) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("settings:clear", () => clearApiKey());

// Confirmation for the index reset. Shown natively rather than with
// window.confirm(), which Electron suppresses, and so the folder name and
// counts are spelled out before anything is deleted.
ipcMain.handle("confirm-clear", async (_event, summary = {}) => {
  const { folder, fileCount = 0, rootCount = 0 } = summary;

  const detail = [
    fileCount || rootCount
      ? `This removes ${fileCount} indexed ${fileCount === 1 ? "file" : "files"} across ${rootCount} ${
          rootCount === 1 ? "folder" : "folders"
        }.`
      : "The index is already empty.",
    folder ? `Current selection:\n${folder}` : null,
    "Your actual files are not touched. You can re-scan at any time.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Clear the index",
    message: fileCount ? "Clear all indexed data?" : "Clear the index?",
    detail,
    buttons: ["Cancel", "Clear everything"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });

  return response === 1;
});

ipcMain.handle("open-external", async (_event, url) => {
  if (typeof url !== "string") return false;
  if (!EXTERNAL_LINK_ALLOWLIST.some((prefix) => url.startsWith(prefix))) return false;
  await shell.openExternal(url);
  return true;
});

app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopAll();
  if (process.platform !== "darwin") app.quit();
});
