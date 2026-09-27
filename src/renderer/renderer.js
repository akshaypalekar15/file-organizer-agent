const api = window.agent.apiBase;
let currentRoot = null;
let hasApiKey = false;

const pickFolderBtn = document.getElementById("pick-folder");
const currentRootLabel = document.getElementById("current-root");
const statsList = document.getElementById("stats-list");
const staleList = document.getElementById("stale-list");
const suggestBtn = document.getElementById("get-suggestions");
const suggestionsList = document.getElementById("suggestions-list");

const settingsDialog = document.getElementById("settings-dialog");
const settingsForm = document.getElementById("settings-form");
const apiKeyInput = document.getElementById("api-key");
const modelInput = document.getElementById("model");
const settingsStatus = document.getElementById("settings-status");
const storageNote = document.getElementById("storage-note");
const keyHint = document.getElementById("key-hint");
const openSettingsBtn = document.getElementById("open-settings");

function setKeyState(hasKey) {
  hasApiKey = hasKey;
  keyHint.classList.toggle("hidden", hasKey);
  if (currentRoot) suggestBtn.disabled = !hasKey;
}

function describeStorage(settings) {
  if (!settings.encryptionAvailable) return "no OS keyring detected — cannot encrypt";
  if (settings.keySource === "environment") return "OS keychain (key currently from OPENROUTER_API_KEY)";
  return settings.storageBackend === "plaintext"
    ? "OS keyring unavailable — stored unencrypted"
    : "OS keychain";
}

async function refreshSettings() {
  const settings = await window.agent.getSettings();
  modelInput.value = settings.model;
  apiKeyInput.value = "";
  apiKeyInput.placeholder = settings.hasKey
    ? `Saved (${settings.keySource}) — leave blank to keep`
    : "sk-or-...";
  storageNote.textContent = describeStorage(settings);
  setKeyState(settings.hasKey);
  return settings;
}

async function openSettings() {
  await refreshSettings();
  settingsStatus.textContent = "";
  settingsDialog.showModal();
  apiKeyInput.focus();
}

document.getElementById("hint-settings").addEventListener("click", openSettings);
openSettingsBtn.addEventListener("click", openSettings);

document.getElementById("settings-cancel").addEventListener("click", () => {
  settingsDialog.close();
});

document.getElementById("clear-key").addEventListener("click", async () => {
  const settings = await window.agent.clearApiKey();
  setKeyState(settings.hasKey);
  apiKeyInput.value = "";
  apiKeyInput.placeholder = settings.hasKey ? "Saved (environment) — leave blank to keep" : "sk-or-...";
  settingsStatus.textContent = settings.hasKey
    ? "Removed the saved key. Still using OPENROUTER_API_KEY from the environment."
    : "Key removed.";
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await window.agent.saveSettings({
    apiKey: apiKeyInput.value,
    model: modelInput.value,
  });

  if (!result.ok) {
    settingsStatus.textContent = result.error;
    return;
  }

  setKeyState(result.settings.hasKey);
  settingsStatus.textContent = "Saved.";
  apiKeyInput.value = "";
  settingsDialog.close();
});

for (const [id, url] of [
  ["get-a-key", "https://openrouter.ai/keys"],
  ["browse-models", "https://openrouter.ai/models"],
]) {
  document.getElementById(id).addEventListener("click", (event) => {
    event.preventDefault();
    window.agent.openExternal(url);
  });
}

pickFolderBtn.addEventListener("click", async () => {
  const folder = await window.agent.selectFolder();
  if (!folder) return;

  currentRoot = folder;
  currentRootLabel.textContent = `Scanning ${folder}...`;
  pickFolderBtn.disabled = true;

  const res = await fetch(`${api}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootPath: folder }),
  });
  const data = await res.json();

  currentRootLabel.textContent = `${folder} — ${data.scanned ?? 0} files indexed`;
  pickFolderBtn.disabled = false;
  suggestBtn.disabled = !hasApiKey;

  loadStats();
  loadStale();
});

async function loadStats() {
  const res = await fetch(`${api}/api/stats`);
  const stats = await res.json();
  statsList.innerHTML = stats
    .map(
      (s) =>
        `<div class="row"><span>${s.extension || "(none)"}</span><span>${s.count} files · ${(
          s.total_size / 1024 / 1024
        ).toFixed(1)} MB</span></div>`
    )
    .join("") || `<div class="muted">No files indexed yet.</div>`;
}

async function loadStale() {
  const res = await fetch(`${api}/api/stale?days=180&limit=30`);
  const files = await res.json();
  staleList.innerHTML = files
    .map(
      (f) =>
        `<div class="row"><span>${f.name}</span><span class="muted">${new Date(
          f.modified_at
        ).toLocaleDateString()}</span></div>`
    )
    .join("") || `<div class="muted">Nothing looks stale — nice.</div>`;
}

suggestBtn.addEventListener("click", async () => {
  suggestBtn.disabled = true;
  suggestionsList.innerHTML = `<div class="muted">Asking the AI for suggestions...</div>`;

  try {
    const res = await fetch(`${api}/api/suggestions`, { method: "POST" });
    const data = await res.json();

    const moves = (data.moves || [])
      .map((m) => `<div class="row"><span>${m.path}</span><span class="muted">→ ${m.suggestedFolder}</span></div>`)
      .join("");
    const archive = (data.archiveCandidates || [])
      .map((a) => `<div class="row"><span>${a.path}</span><span class="muted">${a.reason}</span></div>`)
      .join("");

    suggestionsList.innerHTML = `
      <h3>Suggested moves</h3>${moves || '<div class="muted">None</div>'}
      <h3>Archive candidates</h3>${archive || '<div class="muted">None</div>'}
    `;
  } catch (err) {
    suggestionsList.innerHTML = `<div class="muted">Couldn't get suggestions: ${err.message}</div>`;
  } finally {
    suggestBtn.disabled = false;
  }
});
