const express = require("express");
const fs = require("fs");
const path = require("path");
const { statements, db } = require("./db");
const { scanDirectory } = require("./scanner");
const { watchRoot } = require("./watcher");
const { getOrganizationSuggestions } = require("./ai");

const PORT = 4287;

function startServer() {
  const app = express();
  app.use(express.json());

  // Kick off a scan of a chosen root, then start watching it live.
  app.post("/api/scan", async (req, res) => {
    const { rootPath } = req.body;
    if (!rootPath || !fs.existsSync(rootPath)) {
      return res.status(400).json({ error: "rootPath does not exist" });
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

  app.get("/api/files", (req, res) => {
    const limit = Number(req.query.limit) || 500;
    res.json(statements.listFiles.all(limit));
  });

  // Files untouched since `days` ago (based on modified/opened time).
  app.get("/api/stale", (req, res) => {
    const days = Number(req.query.days) || 180;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const limit = Number(req.query.limit) || 200;
    res.json(statements.listStale.all(cutoff, cutoff, limit));
  });

  app.get("/api/stats", (req, res) => {
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

  // Apply a single approved move. The renderer must show a preview
  // and get explicit confirmation before calling this.
  app.post("/api/apply-move", async (req, res) => {
    const { fromPath, toPath } = req.body;
    try {
      await fs.promises.mkdir(path.dirname(toPath), { recursive: true });
      await fs.promises.rename(fromPath, toPath);
      db.prepare(`UPDATE files SET path = ?, directory = ? WHERE path = ?`).run(
        toPath,
        path.dirname(toPath),
        fromPath
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Local agent API listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = { startServer, PORT };
