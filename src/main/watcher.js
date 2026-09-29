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
    // Must match scanner.js, which skips links rather than following them.
    // Left at its default (true), a junction pointing at an ancestor makes
    // chokidar walk the tree forever and emit an unbounded stream of add
    // events, which floods the index with duplicate rows.
    followSymlinks: false,
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
    // chokidar still reports a junction/symlink itself even with
    // followSymlinks: false, and stat() follows it to a directory. Only real
    // files belong in the index, matching what scanner.js records.
    if (!stat.isFile()) return;

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

/**
 * Closes every watcher and waits for the close to settle, so that no in-flight
 * add/unlink events can land after a caller has cleared the index.
 */
async function stopAll() {
  const closing = [...watchers.values()].map((watcher) => watcher.close());
  watchers.clear();
  await Promise.all(closing);
}

module.exports = { watchRoot, stopAll };
