const chokidar = require("chokidar");
const fs = require("fs");
const path = require("path");
const { statements } = require("./db");
const { categorize } = require("./scanner");

const watchers = new Map(); // rootPath -> chokidar instance

function watchRoot(rootPath) {
  if (watchers.has(rootPath)) return;

  const watcher = chokidar.watch(rootPath, {
    ignored: /(^|[/\\])(\.|node_modules|\.git|\.next|dist|build)/,
    persistent: true,
    ignoreInitial: true, // initial population is handled by scanner.js
    awaitWriteFinish: { stabilityThreshold: 500 },
  });

  watcher
    .on("add", async (filePath) => upsertFromDisk(filePath))
    .on("change", async (filePath) => upsertFromDisk(filePath))
    .on("unlink", (filePath) => statements.markDeleted.run(filePath));

  watchers.set(rootPath, watcher);
}

async function upsertFromDisk(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    const extension = path.extname(filePath).replace(".", "");
    statements.upsertFile.run({
      path: filePath,
      name: path.basename(filePath),
      extension,
      directory: path.dirname(filePath),
      size: stat.size,
      created_at: Math.floor(stat.birthtimeMs),
      modified_at: Math.floor(stat.mtimeMs),
      last_scanned_at: Date.now(),
      category: categorize(extension),
    });
  } catch {
    // file may already be gone; ignore
  }
}

function stopAll() {
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
}

module.exports = { watchRoot, stopAll };
