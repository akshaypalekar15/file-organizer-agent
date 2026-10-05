const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { statements, rootPrefix, clearIndex } = require("./db");
const { scanDirectory, indexFile } = require("./scanner");
const { watchRoot, stopAll } = require("./watcher");
const { getOrganizationSuggestions } = require("./ai");

const PORT = 4287;

/**
 * A fresh token per launch, handed to the renderer through the preload bridge.
 *
 * Without this, any web page open in the default browser can drive this API,
 * including /api/apply which moves real files. A page cannot read this token
 * (different origin) and cannot send a custom header without a CORS preflight
 * that we never answer, so requiring it closes that off.
 */
const API_TOKEN = crypto.randomBytes(32).toString("hex");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function requireToken(req, res, next) {
  const hostname = req.hostname || "";
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return res.status(403).json({ error: "This API only accepts local requests." });
  }

  const presented = req.get("x-agent-token");
  if (!presented) {
    return res.status(401).json({ error: "Missing or invalid agent token." });
  }

  // Hash both sides to a fixed length first: timingSafeEqual throws on
  // mismatched buffer lengths, which would turn a wrong token into a 500.
  const digest = (value) => crypto.createHash("sha256").update(value).digest();
  if (!crypto.timingSafeEqual(digest(presented), digest(API_TOKEN))) {
    return res.status(401).json({ error: "Missing or invalid agent token." });
  }
  next();
}

/**
 * Resolves a suggested move to a concrete destination, or explains why it is
 * not allowed. Everything here is a hard gate: the source must be a file we
 * indexed, and the destination must land inside one of the scanned roots, so
 * neither a hallucinated suggestion nor a crafted request can reach outside.
 */
function planMove(filePath, suggestedFolder) {
  const row = statements.getFile.get(filePath);
  if (!row || row.is_deleted !== 0) {
    return { ok: false, reason: "not a file in the current index" };
  }
  if (typeof suggestedFolder !== "string" || !suggestedFolder.trim()) {
    return { ok: false, reason: "no destination folder was given" };
  }

  const folder = suggestedFolder.trim();
  if (path.isAbsolute(folder)) {
    return { ok: false, reason: "destination must be a relative folder" };
  }

  // Longest match wins, so a root nested inside another takes precedence.
  const roots = statements.listRoots
    .all()
    .map((r) => path.resolve(r.path))
    .sort((a, b) => b.length - a.length);

  const owner = roots.find((root) => filePath.startsWith(rootPrefix(root)));
  if (!owner) {
    return { ok: false, reason: "file is not inside a scanned folder" };
  }

  // Resolved against the scan root, not the file's own directory: the model is
  // proposing a layout for the whole tree, so "src/chrome" should mean
  // <root>/src/chrome rather than <root>/src/<currentFolder>/src/chrome.
  const toPath = path.resolve(owner, folder, path.basename(filePath));

  // path.resolve collapses "..", so this catches any escape out of the root.
  if (!toPath.startsWith(rootPrefix(owner))) {
    return { ok: false, reason: "destination is outside the scanned folders" };
  }
  if (toPath === filePath) {
    return { ok: false, reason: "already in that folder" };
  }

  return { ok: true, fromPath: filePath, toPath };
}

/**
 * Moves one file, refusing to overwrite anything. Falls back to copy+unlink
 * across volumes, where rename() would fail with EXDEV.
 */
async function performMove(fromPath, toPath) {
  if (await fs.promises.stat(toPath).then(() => true, () => false)) {
    return { ok: false, reason: "a file is already there" };
  }
  await fs.promises.mkdir(path.dirname(toPath), { recursive: true });

  try {
    await fs.promises.rename(fromPath, toPath);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await fs.promises.copyFile(fromPath, toPath);
    await fs.promises.unlink(fromPath);
  }
  return { ok: true };
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Everything under /api needs the per-launch token.
  app.use("/api", requireToken);

  // Kick off a scan of a chosen root, then start watching it live.
  app.post("/api/scan", async (req, res) => {
    const { rootPath } = req.body;
    if (!rootPath || !fs.existsSync(rootPath)) {
      return res.status(400).json({ error: "rootPath does not exist" });
    }
    if (!fs.statSync(rootPath).isDirectory()) {
      return res.status(400).json({ error: "rootPath is not a directory" });
    }
    try {
      const result = await scanDirectory(rootPath);
      watchRoot(rootPath);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/roots", (req, res) => {
    res.json(statements.listRoots.all());
  });

  app.get("/api/summary", (req, res) => {
    res.json(statements.indexCounts.get());
  });

  // Full reset: stop watching first and wait for the watchers to close, so a
  // queued add/unlink event can't resurrect a row we just deleted.
  app.post("/api/clear", async (req, res) => {
    try {
      await stopAll();
      res.json({ ok: true, ...clearIndex() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every read below takes an optional rootPath so the UI can scope a panel to
  // the folder the user just picked. Without it they fall back to the whole
  // index, which is how a scan of one folder can look empty while the panel
  // fills up with files from somewhere else entirely.
  app.get("/api/files", (req, res) => {
    const limit = Number(req.query.limit) || 500;
    const root = req.query.rootPath;
    if (root) {
      const prefix = rootPrefix(root);
      return res.json(statements.listFilesInRoot.all(prefix.length, prefix, limit));
    }
    res.json(statements.listFiles.all(limit));
  });

  // Files untouched since `days` ago (based on modified/opened time).
  app.get("/api/stale", (req, res) => {
    const days = Number(req.query.days) || 180;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const limit = Number(req.query.limit) || 200;
    const root = req.query.rootPath;
    if (root) {
      const prefix = rootPrefix(root);
      return res.json(statements.listStaleInRoot.all(cutoff, cutoff, prefix.length, prefix, limit));
    }
    res.json(statements.listStale.all(cutoff, cutoff, limit));
  });

  app.get("/api/stats", (req, res) => {
    const root = req.query.rootPath;
    if (root) {
      const prefix = rootPrefix(root);
      return res.json(statements.statsInRoot.all(prefix.length, prefix));
    }
    res.json(statements.stats.all());
  });

  // Record that the user opened a file through the app UI —
  // one input into the usage-frequency score (see README for caveats).
  app.post("/api/open", (req, res) => {
    const { filePath } = req.body;
    statements.bumpOpenCount.run(Date.now(), filePath);
    res.json({ ok: true });
  });

  app.post("/api/suggestions", async (req, res) => {
    try {
      const files = statements.listFiles.all(300);
      const suggestions = await getOrganizationSuggestions(files);
      res.json(suggestions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Plan and execute a batch of moves. With dryRun it only reports what would
   * happen, which is what the UI's review step uses — nothing touches disk
   * until the same request comes back without dryRun.
   */
  app.post("/api/apply", async (req, res) => {
    const { items, dryRun } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "no items to apply" });
    }

    const planned = items.map((item) => {
      const result = planMove(item?.path, item?.suggestedFolder);
      return { ...result, path: item?.path };
    });

    if (dryRun) {
      return res.json({
        dryRun: true,
        results: planned.map((r) => ({
          path: r.path,
          fromPath: r.fromPath || r.path,
          toPath: r.toPath || null,
          status: r.ok ? "would-move" : "skipped",
          reason: r.reason || null,
        })),
      });
    }

    const batchId = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    const results = [];

    for (const move of planned) {
      if (!move.ok) {
        results.push({ path: move.path, status: "skipped", reason: move.reason });
        continue;
      }
      try {
        const moved = await performMove(move.fromPath, move.toPath);
        if (!moved.ok) {
          results.push({ path: move.path, status: "skipped", reason: moved.reason });
          continue;
        }

        // Mirror exactly what the watcher does, so its later unlink/add events
        // are idempotent instead of racing a hand-written path update.
        statements.markDeleted.run(move.fromPath);
        await indexFile(move.toPath, path.basename(move.toPath), Date.now());
        statements.recordMove.run(batchId, move.fromPath, move.toPath, Date.now());

        results.push({
          path: move.path,
          fromPath: move.fromPath,
          toPath: move.toPath,
          status: "moved",
        });
      } catch (err) {
        results.push({ path: move.path, status: "skipped", reason: err.message });
      }
    }

    const applied = results.filter((r) => r.status === "moved").length;
    res.json({ batchId, applied, skipped: results.length - applied, results });
  });

  /** Reverses the most recent batch, so applying is never a one-way door. */
  app.post("/api/undo", async (req, res) => {
    const rows = statements.undoCandidates.all();
    if (!rows.length) {
      return res.status(400).json({ error: "there is nothing to undo" });
    }

    const batchId = rows[0].batch_id;
    const batch = rows.filter((r) => r.batch_id === batchId);
    const results = [];

    for (const row of batch) {
      // Only reverse cleanly when the original slot is free and the file we
      // moved is still sitting where we put it.
      const sourceThere = await fs.promises.stat(row.to_path).then(() => true, () => false);
      const targetFree = await fs.promises.stat(row.from_path).then(() => true, () => false);
      if (!sourceThere || targetFree) {
        results.push({
          toPath: row.to_path,
          status: "skipped",
          reason: !sourceThere ? "the file has been moved or deleted since" : "the original path is occupied",
        });
        continue;
      }
      try {
        const moved = await performMove(row.to_path, row.from_path);
        if (!moved.ok) {
          results.push({ toPath: row.to_path, status: "skipped", reason: moved.reason });
          continue;
        }
        statements.markDeleted.run(row.to_path);
        await indexFile(row.from_path, path.basename(row.from_path), Date.now());
        statements.forgetMove.run(row.id);
        results.push({ fromPath: row.to_path, toPath: row.from_path, status: "restored" });
      } catch (err) {
        results.push({ toPath: row.to_path, status: "skipped", reason: err.message });
      }
    }

    // A fully-skipped batch stays on the log so the user can retry later;
    // anything actually reversed is forgotten.
    if (results.every((r) => r.status === "skipped")) {
      return res.status(409).json({ error: "could not undo that batch", results });
    }

    const restored = results.filter((r) => r.status === "restored").length;
    res.json({ restored, skipped: results.length - restored, results });
  });

  app.get("/api/undo", (req, res) => {
    const rows = statements.undoCandidates.all();
    const latest = rows[0];
    res.json(
      latest
        ? { available: true, batchId: latest.batch_id, count: rows.filter((r) => r.batch_id === latest.batch_id).length }
        : { available: false }
    );
  });

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Local agent API listening on http://127.0.0.1:${PORT}`);
  });

  return API_TOKEN;
}

module.exports = { startServer, PORT, API_TOKEN };
