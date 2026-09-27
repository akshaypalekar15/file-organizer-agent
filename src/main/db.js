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
  removeFile: db.prepare(`DELETE FROM files WHERE path = ?`),
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
};

module.exports = { db, statements };
