const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { app } = require("electron");

// Store the index outside the app bundle so it survives updates.
const userDataPath = app.getPath("userData");
if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
const dbPath = path.join(userDataPath, "file-index.sqlite");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    extension TEXT,
    directory TEXT,
    size INTEGER,
    created_at INTEGER,
    modified_at INTEGER,
    last_scanned_at INTEGER,
    open_count INTEGER DEFAULT 0,
    last_opened_at INTEGER,
    category TEXT,
    is_deleted INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_files_directory ON files(directory);
  CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
  CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at);

  CREATE TABLE IF NOT EXISTS scan_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    added_at INTEGER
  );

  -- One row per file actually moved, so a batch can be reversed. Rows are
  -- deleted as they are undone, which makes this the pending-undo log.
  CREATE TABLE IF NOT EXISTS move_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    moved_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_move_log_batch ON move_log(batch_id);
`);

const statements = {
  upsertFile: db.prepare(`
    INSERT INTO files (path, name, extension, directory, size, created_at, modified_at, last_scanned_at, category)
    VALUES (@path, @name, @extension, @directory, @size, @created_at, @modified_at, @last_scanned_at, @category)
    ON CONFLICT(path) DO UPDATE SET
      size=excluded.size,
      modified_at=excluded.modified_at,
      last_scanned_at=excluded.last_scanned_at,
      is_deleted=0
  `),
  markDeleted: db.prepare(`UPDATE files SET is_deleted = 1 WHERE path = ?`),
  bumpOpenCount: db.prepare(`
    UPDATE files SET open_count = open_count + 1, last_opened_at = ? WHERE path = ?
  `),
  addRoot: db.prepare(`
    INSERT OR IGNORE INTO scan_roots (path, added_at) VALUES (?, ?)
  `),
  listRoots: db.prepare(`SELECT * FROM scan_roots ORDER BY added_at DESC`),
  listFiles: db.prepare(`
    SELECT * FROM files WHERE is_deleted = 0 ORDER BY modified_at DESC LIMIT ?
  `),
  listStale: db.prepare(`
    SELECT * FROM files
    WHERE is_deleted = 0 AND modified_at < ? AND (last_opened_at IS NULL OR last_opened_at < ?)
    ORDER BY modified_at ASC
    LIMIT ?
  `),
  stats: db.prepare(`
    SELECT extension, COUNT(*) as count, SUM(size) as total_size
    FROM files WHERE is_deleted = 0
    GROUP BY extension
    ORDER BY total_size DESC
  `),

  // Root-scoped variants. Matching on a prefix length rather than LIKE '%...%'
  // avoids having to escape backslashes in Windows paths, and a file whose
  // path merely starts with the same characters (chrome-react-seo vs
  // chrome-react-seo-extension) is not swept in by accident.
  listFilesInRoot: db.prepare(`
    SELECT * FROM files
    WHERE is_deleted = 0 AND substr(path, 1, ?) = ?
    ORDER BY modified_at DESC
    LIMIT ?
  `),
  listStaleInRoot: db.prepare(`
    SELECT * FROM files
    WHERE is_deleted = 0
      AND modified_at < ?
      AND (last_opened_at IS NULL OR last_opened_at < ?)
      AND substr(path, 1, ?) = ?
    ORDER BY modified_at ASC
    LIMIT ?
  `),
  statsInRoot: db.prepare(`
    SELECT extension, COUNT(*) as count, SUM(size) as total_size
    FROM files
    WHERE is_deleted = 0 AND substr(path, 1, ?) = ?
    GROUP BY extension
    ORDER BY total_size DESC
  `),

  // Full reset. The index is a derived cache of the filesystem, so wiping it
  // is always recoverable by re-scanning; it never touches the user's files.
  indexCounts: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM files WHERE is_deleted = 0) AS files,
      (SELECT COUNT(*) FROM scan_roots) AS roots
  `),
  clearFiles: db.prepare(`DELETE FROM files`),
  clearRoots: db.prepare(`DELETE FROM scan_roots`),
  clearMoves: db.prepare(`DELETE FROM move_log`),

  // Apply support
  getFile: db.prepare(`SELECT * FROM files WHERE path = ?`),
  recordMove: db.prepare(
    `INSERT INTO move_log (batch_id, from_path, to_path, moved_at) VALUES (?, ?, ?, ?)`
  ),
  forgetMove: db.prepare(`DELETE FROM move_log WHERE id = ?`),
  undoCandidates: db.prepare(`
    SELECT * FROM move_log ORDER BY batch_id DESC, id DESC
  `),
};

/** "C:\dir\" — every file under the root starts with this. */
function rootPrefix(rootPath) {
  return path.join(rootPath, path.sep);
}

/**
 * Empties the index and forgets every scan root, reporting what was removed
 * so the UI can say so. Reclaims the disk too, since a long-lived index can
 * hold on to a lot of space after files have been deleted.
 */
function clearIndex() {
  const { files, roots } = statements.indexCounts.get();
  db.transaction(() => {
    statements.clearFiles.run();
    statements.clearRoots.run();
    statements.clearMoves.run();
  })();
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("vacuum");
  } catch {
    // Reclaiming space is best-effort; the delete already succeeded.
  }
  return { removedFiles: files, removedRoots: roots };
}

module.exports = { db, statements, rootPrefix, clearIndex };
