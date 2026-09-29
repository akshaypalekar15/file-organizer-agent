const fs = require("fs");
const path = require("path");
const { statements } = require("./db");

// Directories we never want to walk into.
const IGNORE_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__"]);

function categorize(extension) {
  const ext = (extension || "").toLowerCase();
  const map = {
    doc: ["doc", "docx", "pdf", "txt", "md", "odt"],
    sheet: ["xls", "xlsx", "csv", "tsv"],
    image: ["png", "jpg", "jpeg", "gif", "svg", "webp", "heic"],
    video: ["mp4", "mov", "avi", "mkv"],
    audio: ["mp3", "wav", "flac", "m4a"],
    code: ["js", "ts", "tsx", "jsx", "py", "java", "go", "rs", "c", "cpp", "json", "html", "css"],
    archive: ["zip", "rar", "7z", "tar", "gz"],
  };
  for (const [category, exts] of Object.entries(map)) {
    if (exts.includes(ext)) return category;
  }
  return "other";
}

function shouldIgnoreDir(name) {
  return IGNORE_DIRS.has(name) || name.startsWith(".");
}

async function indexFile(fullPath, name, now) {
  try {
    const stat = await fs.promises.stat(fullPath);
    const extension = path.extname(name).replace(".", "");

    statements.upsertFile.run({
      path: fullPath,
      name,
      extension,
      directory: path.dirname(fullPath),
      size: stat.size,
      created_at: Math.floor(stat.birthtimeMs),
      modified_at: Math.floor(stat.mtimeMs),
      last_scanned_at: now,
      category: categorize(extension),
    });
    return true;
  } catch {
    return false; // removed mid-scan, or unreadable
  }
}

/**
 * Recursively walk a directory, upserting every file into the index.
 * Yields to the event loop between directories so it doesn't block the
 * Electron main process on large trees.
 *
 * Junctions and symlinks are deliberately NOT followed. readdir() reports them
 * as neither a file nor a directory, so they used to be dropped without a
 * word; now we count them so the UI can say so. Following them is not safe by
 * default: a link pointing at an ancestor is an infinite loop, and the same
 * rule has to hold for the chokidar watcher or the index and the live updates
 * disagree. See watcher.js followSymlinks: false.
 */
async function scanDirectory(rootPath, { onProgress } = {}) {
  const now = Date.now();
  let count = 0;
  let linksSkipped = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied, skip
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        linksSkipped++;
        continue;
      }

      if (entry.isDirectory()) {
        if (shouldIgnoreDir(entry.name)) continue;
        await new Promise((resolve) => setImmediate(resolve)); // yield to event loop
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (await indexFile(fullPath, entry.name, now)) {
          count++;
          if (onProgress && count % 200 === 0) onProgress(count);
        }
      }
      // Anything else (sockets, fifos, devices) is not a file we care about.
    }
  }

  await walk(rootPath);
  statements.addRoot.run(rootPath, now);
  return { scanned: count, linksSkipped };
}

module.exports = { scanDirectory, categorize, shouldIgnoreDir };
