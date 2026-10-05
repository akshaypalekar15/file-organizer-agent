const api = window.agent.apiBase;
let currentRoot = null;
let hasApiKey = false;
let savedModel = "";
let savedTheme = "system";
const ARCHIVE_FOLDER = "_archive";

/**
 * Every call to the local API must carry the per-launch token. Without it the
 * server rejects the request, which is what stops any other web page from
 * driving this API.
 */
function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Token": window.agent.apiToken,
      ...(options.headers || {}),
    },
  });
}

const pickFolderBtn = document.getElementById("pick-folder");
const currentRootLabel = document.getElementById("current-root");
const filesList = document.getElementById("files-list");
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
const clearBtn = document.getElementById("clear-index");
const themeInput = document.getElementById("theme");
const applyToolbar = document.getElementById("apply-toolbar");
const selectAll = document.getElementById("select-all");
const selectionCount = document.getElementById("selection-count");
const reviewBtn = document.getElementById("review-changes");
const undoBtn = document.getElementById("undo-last");
const applyReview = document.getElementById("apply-review");
const reviewList = document.getElementById("review-list");
const reviewApply = document.getElementById("review-apply");
const reviewCancel = document.getElementById("review-cancel");

/** The plan currently under review, set by the Review step. */
let pendingPlan = [];
/** The suggestion list as last rendered, indexed to match the checkboxes. */
let currentPlan = [];

/**
 * Applies the appearance choice. "system" removes the attribute entirely so
 * the prefers-color-scheme media query in the stylesheet takes over and the
 * app follows the OS live, including when the user flips it mid-session.
 */
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

// Live preview: switching the dropdown repaints immediately, and Save makes it
// stick. Cancel leaves the stored choice untouched.
themeInput.addEventListener("change", () => {
  applyTheme(themeInput.value);
});

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
  savedModel = settings.model;
  modelInput.value = settings.model;
  themeInput.value = settings.theme;
  savedTheme = settings.theme;
  applyTheme(settings.theme);
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
  // Undo the live preview: the stored choice is only changed by Save.
  applyTheme(savedTheme);
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
    theme: themeInput.value,
  });

  if (!result.ok) {
    settingsStatus.textContent = result.error;
    return;
  }

  savedModel = result.settings.model;
  savedTheme = result.settings.theme;
  applyTheme(result.settings.theme);
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
  clearBtn.disabled = true;

  // Show the panels filling in immediately, rather than leaving the previous
  // folder's results on screen while the scan runs.
  showSkeleton(filesList, 8);
  showSkeleton(statsList, 5);
  showSkeleton(staleList, 5);
  suggestBtn.disabled = true;

  const res = await apiFetch(`${api}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootPath: folder }),
  });
  const data = await res.json();

  if (data.error) {
    currentRootLabel.textContent = `Couldn't scan ${folder} — ${data.error}`;
    pickFolderBtn.disabled = false;
    return;
  }

  const scanned = data.scanned ?? 0;
  const links = data.linksSkipped ?? 0;
  currentRootLabel.textContent = scanned
    ? `${folder} — ${scanned} files indexed${links ? ` (${links} links skipped)` : ""}`
    : `${folder} — no files found${links ? `, ${links} links skipped` : ""}`;

  pickFolderBtn.disabled = false;
  clearBtn.disabled = false;
  suggestBtn.disabled = !hasApiKey;

  loadFiles();
  loadStats();
  loadStale();
});

const SKELETON_ROWS = 6;
const REVEAL_STAGGER_MS = 16;
const REVEAL_CAP_MS = 320;

/** Placeholder rows shown while a panel's data is in flight. */
function showSkeleton(container, count = SKELETON_ROWS) {
  container.replaceChildren();

  const wrap = document.createElement("div");
  wrap.className = "skeleton";
  wrap.setAttribute("aria-hidden", "true");

  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    const wide = document.createElement("div");
    wide.className = "skeleton-bar";
    const narrow = document.createElement("div");
    narrow.className = "skeleton-bar short";
    row.append(wide, narrow);
    wrap.append(row);
  }
  container.append(wrap);
}

/**
 * Shows a skeleton, waits for the data, then reveals the rows staggered so the
 * list reads as filling in rather than snapping into place.
 */
async function loadPanel(container, load, emptyMessage) {
  showSkeleton(container);
  let rows;
  try {
    rows = await load();
  } catch (err) {
    renderRows(container, [[[err.message, "error"]]], emptyMessage);
    return;
  }
  renderRows(container, rows, emptyMessage, { animate: true });
}

/**
 * Renders a list of rows. Each row is an array of cells, and each cell is a
 * [text, className?] pair. The shape is validated because a malformed row
 * (a bare [text, class] pair, say) would otherwise destructure character by
 * character and render nonsense without any error.
 */
function renderRows(container, rows, emptyMessage, { animate = false } = {}) {
  container.replaceChildren();

  const isCell = (cell) => Array.isArray(cell) && (cell.length === 0 || typeof cell[0] === "string");
  const isRow = Array.isArray(rows) && rows.every((row) => Array.isArray(row) && row.every(isCell));

  if (!isRow) {
    console.error("renderRows: expected an array of rows of [text, className] cells", rows);
    const fallback = document.createElement("div");
    fallback.className = "error";
    fallback.textContent = "Couldn't display this result.";
    container.append(fallback);
    return;
  }

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }
  for (const [index, cells] of rows.entries()) {
    const row = document.createElement("div");
    row.className = animate ? "row reveal" : "row";
    if (animate) {
      // Cap the delay so a 200-row list doesn't take seconds to settle.
      row.style.animationDelay = `${Math.min(index * REVEAL_STAGGER_MS, REVEAL_CAP_MS)}ms`;
    }
    for (const [text, className] of cells) {
      const cell = document.createElement("span");
      cell.textContent = text;
      if (className) cell.className = className;
      row.append(cell);
    }
    container.append(row);
  }
}

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(ms) {
  return ms ? new Date(ms).toLocaleDateString() : "never";
}

/**
 * Replaces a panel's contents with a spinner, a message and a running elapsed
 * timer. Returns a handle so the caller can update the text and, crucially,
 * always stop the timer in a finally block.
 */
function showBusy(container, message) {
  container.replaceChildren();

  const wrap = document.createElement("div");
  wrap.className = "busy";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-live", "polite");

  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "busy-text";
  text.textContent = message;

  const elapsed = document.createElement("span");
  elapsed.className = "muted";
  elapsed.textContent = "0s";

  wrap.append(spinner, text, elapsed);
  container.append(wrap);

  const startedAt = Date.now();
  const timer = setInterval(() => {
    elapsed.textContent = `${Math.floor((Date.now() - startedAt) / 1000)}s`;
  }, 1000);

  return {
    setMessage(next) {
      text.textContent = next;
    },
    stop() {
      clearInterval(timer);
      wrap.remove();
    },
  };
}

function withRoot(query) {
  if (!currentRoot) return query;
  const separator = query.includes("?") ? "&" : "?";
  return `${query}${separator}rootPath=${encodeURIComponent(currentRoot)}`;
}

function loadFiles() {
  if (!currentRoot) return Promise.resolve();
  return loadPanel(
    filesList,
    async () => {
      const res = await apiFetch(`${api}/api/files${withRoot("?limit=200")}`);
      const files = await res.json();
      return files.map((f) => [
        [f.path.replace(`${currentRoot}\\`, ""), "path"],
        [`${formatSize(f.size)} · ${formatDate(f.modified_at)}`, "muted"],
      ]);
    },
    "No files found in this folder."
  );
}

function loadStats() {
  return loadPanel(
    statsList,
    async () => {
      const res = await apiFetch(`${api}/api/stats${withRoot("")}`);
      const stats = await res.json();
      return stats.map((s) => [
        [s.extension || "(none)", ""],
        [`${s.count} files · ${formatSize(s.total_size)}`, "muted"],
      ]);
    },
    "No files indexed yet."
  );
}

function loadStale() {
  return loadPanel(
    staleList,
    async () => {
      const res = await apiFetch(`${api}/api/stale${withRoot("?days=180&limit=30")}`);
      const files = await res.json();
      return files.map((f) => [
        [f.name, "path"],
        [formatDate(f.modified_at), "muted"],
      ]);
    },
    "Nothing looks stale in this folder — nice."
  );
}

async function resetPanels() {
  currentRoot = null;
  currentRootLabel.textContent = "No folder selected";
  clearBtn.disabled = true;
  pickFolderBtn.disabled = false;
  suggestBtn.disabled = true;
  renderRows(filesList, [], "Scan a folder to see its files.");
  renderRows(statsList, [], "Scan a folder to see stats.");
  renderRows(staleList, [], "Scan a folder to see stale files.");
}

clearBtn.addEventListener("click", async () => {
  if (pickFolderBtn.disabled) return; // a scan is still running

  let summary = { fileCount: 0, rootCount: 0, folder: currentRoot };
  try {
    const res = await apiFetch(`${api}/api/summary`);
    if (res.ok) summary = { ...summary, ...(await res.json()) };
  } catch {
    // Fall back to zeros; the confirm dialog still explains the consequences.
  }

  if (!(await window.agent.confirmClear(summary))) return;

  clearBtn.disabled = true;
  clearBtn.textContent = "Clearing…";
  try {
    const res = await apiFetch(`${api}/api/clear`, { method: "POST" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "clear failed");

    renderRows(suggestionsList, [], "Nothing to suggest yet.");
    await resetPanels();
    currentRootLabel.textContent = `Index cleared — ${data.removedFiles} ${
      data.removedFiles === 1 ? "file" : "files"
    } removed`;
  } catch (err) {
    currentRootLabel.textContent = `Couldn't clear the index: ${err.message}`;
    clearBtn.disabled = false;
  } finally {
    clearBtn.textContent = "Clear";
  }
});

suggestBtn.addEventListener("click", async () => {
  suggestBtn.disabled = true;
  suggestBtn.classList.add("busy");
  suggestBtn.textContent = "Asking…";

  const busy = showBusy(
    suggestionsList,
    savedModel
      ? `Asking ${savedModel} for suggestions…`
      : "Asking the model for suggestions…"
  );

  try {
    const res = await apiFetch(`${api}/api/suggestions`, { method: "POST" });
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    const plan = [];
    for (const move of data.moves || []) {
      if (move?.path && move?.suggestedFolder) {
        plan.push({ path: move.path, suggestedFolder: move.suggestedFolder, reason: move.reason });
      }
    }
    for (const candidate of data.archiveCandidates || []) {
      if (candidate?.path) {
        // Archive candidates are a move into one folder, never a delete.
        plan.push({
          path: candidate.path,
          suggestedFolder: ARCHIVE_FOLDER,
          reason: candidate.reason || "archive candidate",
        });
      }
    }

    renderPlan(plan);

    const warnings = data.warnings || [];
    if (warnings.length && !plan.length) {
      renderRows(suggestionsList, warnings.map((w) => [[`Incomplete: ${w}`, "error"]]), "");
    }
    if (data.raw) {
      renderRows(suggestionsList, [[[data.raw, "muted"]]], "");
    }
    await refreshUndoState();
  } catch (err) {
    renderRows(suggestionsList, [[[`Couldn't get suggestions: ${err.message}`, "error"]]], "");
  } finally {
    busy.stop();
    suggestBtn.disabled = false;
    suggestBtn.classList.remove("busy");
    suggestBtn.textContent = "Get AI suggestions";
  }
});

/** Renders the suggestion plan as selectable rows. */
function renderPlan(plan) {
  applyReview.classList.add("hidden");
  pendingPlan = [];
  currentPlan = plan;

  if (!plan.length) {
    applyToolbar.classList.add("hidden");
    renderRows(suggestionsList, [], "The model had no suggestions for this folder.");
    return;
  }

  applyToolbar.classList.remove("hidden");
  suggestionsList.replaceChildren();

  plan.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "suggestion-row reveal";
    row.style.animationDelay = `${Math.min(index * REVEAL_STAGGER_MS, REVEAL_CAP_MS)}ms`;

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.dataset.index = String(index);

    const body = document.createElement("div");
    body.className = "suggestion-body";

    const path = document.createElement("span");
    path.className = "suggestion-path";
    path.textContent = item.path;

    const target = document.createElement("div");
    target.className = "suggestion-target";
    target.textContent = `→ ${item.suggestedFolder}`;

    body.append(path, target);
    if (item.reason) {
      const reason = document.createElement("div");
      reason.className = "suggestion-reason";
      reason.textContent = item.reason;
      body.append(reason);
    }

    row.append(box, body);
    suggestionsList.append(row);
  });

  // Keep the plan and the checkboxes in step.
  suggestionsList.dataset.size = String(plan.length);
  suggestionsList.onchange = (event) => {
    if (event.target.type === "checkbox") updateSelection();
  };
  updateSelection();
}

function selectedIndexes() {
  return [...suggestionsList.querySelectorAll('input[type="checkbox"]')]
    .map((box, i) => (box.checked ? i : -1))
    .filter((i) => i >= 0);
}

function updateSelection() {
  const boxes = [...suggestionsList.querySelectorAll('input[type="checkbox"]')];
  const chosen = boxes.filter((b) => b.checked).length;
  selectionCount.textContent = `${chosen} of ${boxes.length} selected`;
  selectAll.checked = boxes.length > 0 && chosen === boxes.length;
  reviewBtn.disabled = chosen === 0;
}

selectAll.addEventListener("change", () => {
  for (const box of suggestionsList.querySelectorAll('input[type="checkbox"]')) {
    box.checked = selectAll.checked;
  }
  updateSelection();
});

async function refreshUndoState() {
  try {
    const res = await apiFetch(`${api}/api/undo`);
    if (!res.ok) return;
    const data = await res.json();
    undoBtn.disabled = !data.available;
    undoBtn.textContent = data.available ? `Undo last batch (${data.count})` : "Undo last batch";
  } catch {
    undoBtn.disabled = true;
  }
}

function shortPath(p, root) {
  if (!p) return "";
  return root && p.startsWith(root) ? p.slice(root.length + 1) : p;
}

/** Dry-run the plan and show exactly what would happen, per file. */
reviewBtn.addEventListener("click", async () => {
  const items = selectedIndexes().map((i) => ({
    path: currentPlan[i].path,
    suggestedFolder: currentPlan[i].suggestedFolder,
  }));
  if (!items.length) return;

  reviewBtn.disabled = true;
  reviewBtn.textContent = "Checking…";
  try {
    const res = await apiFetch(`${api}/api/apply`, {
      method: "POST",
      body: JSON.stringify({ items, dryRun: true }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    reviewList.replaceChildren();
    const heading = document.createElement("h3");
    const moving = data.results.filter((r) => r.status === "would-move").length;
    const skipped = data.results.length - moving;
    heading.textContent = `${moving} ${moving === 1 ? "file" : "files"} will move${
      skipped ? `, ${skipped} skipped` : ""
    }.`;
    reviewList.append(heading);

    for (const r of data.results) {
      const row = document.createElement("div");
      row.className = r.status === "would-move" ? "review-row" : "review-row skipped";
      const from = document.createElement("span");
      from.className = "from";
      from.textContent = shortPath(r.fromPath, currentRoot);
      const to = document.createElement("span");
      to.className = "to";
      to.textContent =
        r.status === "would-move" ? shortPath(r.toPath, currentRoot) : `skipped — ${r.reason}`;
      row.append(from, to);
      reviewList.append(row);
    }

    pendingPlan = items;
    reviewApply.disabled = moving === 0;
    reviewApply.textContent = `Move ${moving} ${moving === 1 ? "file" : "files"}`;
    applyReview.classList.remove("hidden");
  } catch (err) {
    renderRows(suggestionsList, [[[`Couldn't check that plan: ${err.message}`, "error"]]], "");
  } finally {
    reviewBtn.disabled = false;
    reviewBtn.textContent = "Review changes";
  }
});

reviewCancel.addEventListener("click", () => {
  applyReview.classList.add("hidden");
  pendingPlan = [];
  updateSelection();
});

reviewApply.addEventListener("click", async () => {
  const items = pendingPlan;
  if (!items.length) return;

  const confirmed = await window.agent.confirmApply({
    count: items.length,
    sample: items.slice(0, 4).map((i) => `${shortPath(i.path, currentRoot)} → ${i.suggestedFolder}`),
  });
  if (!confirmed) return;

  reviewApply.disabled = true;
  reviewApply.textContent = "Moving…";
  try {
    const res = await apiFetch(`${api}/api/apply`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    applyReview.classList.add("hidden");
    renderRows(
      suggestionsList,
      data.results.map((r) => [
        [shortPath(r.path, currentRoot), "path"],
        [
          r.status === "moved"
            ? `moved → ${shortPath(r.toPath, currentRoot)}`
            : `skipped — ${r.reason}`,
          r.status === "moved" ? "muted" : "error",
        ],
      ]),
      "Nothing was changed."
    );

    pendingPlan = [];
    await Promise.all([loadFiles(), loadStats(), loadStale()]);
    await refreshUndoState();
  } catch (err) {
    renderRows(suggestionsList, [[[`Couldn't apply: ${err.message}`, "error"]]], "");
  } finally {
    reviewApply.disabled = false;
    reviewApply.textContent = "Apply";
    updateSelection();
  }
});

undoBtn.addEventListener("click", async () => {
  undoBtn.disabled = true;
  try {
    const res = await apiFetch(`${api}/api/undo`, { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderRows(
      suggestionsList,
      data.results.map((r) => [
        [shortPath(r.toPath, currentRoot), "path"],
        [
          r.status === "restored"
            ? `restored to ${shortPath(r.fromPath, currentRoot)}`
            : `skipped — ${r.reason}`,
          r.status === "restored" ? "muted" : "error",
        ],
      ]),
      "Nothing to restore."
    );

    await Promise.all([loadFiles(), loadStats(), loadStale()]);
    await refreshUndoState();
  } catch (err) {
    renderRows(suggestionsList, [[[`Couldn't undo: ${err.message}`, "error"]]], "");
  }
});

// The index survives restarts, so offer Clear straight away rather than making
// the user scan something before they can clear the previous session's data.
(async function init() {
  await refreshSettings();
  try {
    const res = await apiFetch(`${api}/api/summary`);
    if (!res.ok) return;
    const { files, roots } = await res.json();
    clearBtn.disabled = !files && !roots;
  } catch {
    // Server not reachable yet; Clear stays disabled until the first scan.
  }
})();
