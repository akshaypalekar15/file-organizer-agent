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
