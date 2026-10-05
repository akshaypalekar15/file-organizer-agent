const chokidar = require("chokidar");
const path = require("path");
const { statements } = require("./db");
const { indexFile } = require("./scanner");

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
  // indexFile is shared with the scanner and the apply endpoint, so all three
  // agree on what counts as an indexable file.
  await indexFile(filePath, path.basename(filePath), Date.now());
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
