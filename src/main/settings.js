/**
 * Persists user settings for the desktop app, including the user's own
 * OpenRouter API key (BYOK).
 *
 * The key is encrypted with Electron's safeStorage, which maps to DPAPI on
 * Windows and the Keychain on macOS, so the secret is never written to disk in
 * plain text. On Linux, if no system keyring is available, safeStorage has no
 * backend and we fall back to plaintext with a warning surfaced to the UI
 * rather than silently pretending the key is protected.
 *
 * Settings live outside the app bundle so they survive updates. The key is
 * only ever read inside the main process — it is never sent back to the
 * renderer, which only learns whether a key exists.
 */

const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
const THEMES = ["system", "light", "dark"];

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function write(data) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function storeKey(data, apiKey) {
  if (encryptionAvailable()) {
    data.encryptedKey = safeStorage.encryptString(apiKey).toString("base64");
    delete data.plainKey;
  } else {
    data.plainKey = apiKey;
    delete data.encryptedKey;
  }
}

function readStoredKey(data) {
  if (data.encryptedKey) {
    try {
      return safeStorage.decryptString(Buffer.from(data.encryptedKey, "base64"));
    } catch {
      // Saved by a different OS user, or the keychain entry was removed.
      return null;
    }
  }
  return data.plainKey || null;
}

/**
 * Resolves the key to use for API calls. A key saved through the settings
 * dialog wins; the OPENROUTER_API_KEY environment variable is the last resort
 * so headless and CI runs still work.
 */
function getApiKey() {
  const stored = readStoredKey(read());
  if (stored) return stored;
  return process.env.OPENROUTER_API_KEY || null;
}

function getModel() {
  const stored = read().model;
  if (stored) return stored;
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

/** Renderer-facing view. Deliberately omits the key itself. */
function getSettings() {
  const data = read();
  const stored = readStoredKey(data);
  const encryption = encryptionAvailable();

  return {
    model: getModel(),
    theme: THEMES.includes(data.theme) ? data.theme : "system",
    hasKey: Boolean(stored || process.env.OPENROUTER_API_KEY),
    keySource: stored ? "settings" : process.env.OPENROUTER_API_KEY ? "environment" : null,
    encryptionAvailable: encryption,
    storageBackend: data.plainKey && !encryption ? "plaintext" : "encrypted",
  };
}

function saveSettings({ apiKey, model, theme } = {}) {
  const data = read();

  if (typeof model === "string" && model.trim()) {
    data.model = model.trim();
  }

  if (typeof theme === "string" && THEMES.includes(theme)) {
    data.theme = theme;
  }

  if (typeof apiKey === "string" && apiKey.trim()) {
    const key = apiKey.trim();
    if (key.length < 20) {
      throw new Error("That doesn't look like an OpenRouter API key — it is too short.");
    }
    if (!key.startsWith("sk-or-")) {
      throw new Error("OpenRouter keys start with 'sk-or-'. Check for a stray quote or trailing space.");
    }
    storeKey(data, key);
  }

  write(data);
  return getSettings();
}

function clearApiKey() {
  const data = read();
  delete data.encryptedKey;
  delete data.plainKey;
  write(data);
  return getSettings();
}

module.exports = {
  DEFAULT_MODEL,
  THEMES,
  getApiKey,
  getModel,
  getSettings,
  saveSettings,
  clearApiKey,
};
