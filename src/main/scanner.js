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

/**
 * Recursively walk a directory, upserting every file into the index.
 * Runs synchronously in chunks via setImmediate so it doesn't block
 * the Electron main process for large trees.
 */
async function scanDirectory(rootPath, { onProgress } = {}) {
  const now = Date.now();
  let count = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return; // permission denied, skip
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await new Promise((resolve) => setImmediate(resolve)); // yield to event loop
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          const extension = path.extname(entry.name).replace(".", "");

          statements.upsertFile.run({
            path: fullPath,
            name: entry.name,
            extension,
            directory: dir,
            size: stat.size,
            created_at: Math.floor(stat.birthtimeMs),
            modified_at: Math.floor(stat.mtimeMs),
            last_scanned_at: now,
            category: categorize(extension),
          });

          count++;
          if (onProgress && count % 200 === 0) onProgress(count);
        } catch (err) {
          // file may have been deleted mid-scan; skip
        }
      }
    }
  }

  await walk(rootPath);
  statements.addRoot.run(rootPath, now);
  return { scanned: count };
}

module.exports = { scanDirectory, categorize };
