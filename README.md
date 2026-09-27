# File Organizer Agent

A lightweight local Electron agent that scans a folder, indexes every file
into SQLite, tracks how often things get touched, and asks an AI (via
OpenRouter) for organization suggestions — file *contents* are never sent
anywhere.

## Setup

```bash
npm install
npm start
```

Then click **Settings** and paste your own OpenRouter API key
([get one here](https://openrouter.ai/keys)). You can also pick the model in
the same dialog. Only the AI suggestions call needs a key — scanning, stats,
and the stale-file list all work without one.

There is no key in the source and no key is bundled. This is a bring-your-own-key
app: your key is stored encrypted on your machine and is never transmitted
anywhere except as an `Authorization` header to OpenRouter.

### How the key is stored

`src/main/settings.js` encrypts the key with Electron's
[`safeStorage`](https://www.electronjs.org/docs/latest/api/safeStorage), which
maps to **DPAPI** on Windows, the **Keychain** on macOS, and **libsecret** on
Linux. It is written to `settings.json` in the app's `userData` directory as
ciphertext, never as plain text, and it is only ever decrypted inside the main
process — the renderer is told *whether* a key exists, never what it is.

If no system keyring is available (common on minimal Linux desktops), the key
falls back to plaintext storage and the Settings dialog says so explicitly
rather than implying it is protected.

### Precedence

| Setting | Order |
| --- | --- |
| API key | Settings dialog → `OPENROUTER_API_KEY` env var / `.env` |
| Model | Settings dialog → `OPENROUTER_MODEL` env var / `.env` → `anthropic/claude-sonnet-4.6` |

The env vars are a convenience for headless and CI runs. See `.env.example`.

## How it works

- **Scanner** (`src/main/scanner.js`) walks a chosen folder recursively and
  writes path/size/timestamps/category into SQLite.
- **Watcher** (`src/main/watcher.js`) uses `chokidar` to keep the index live
  after the initial scan, without re-scanning everything.
- **Local API** (`src/main/server.js`) runs on `http://127.0.0.1:4287` — the
  UI (renderer) only ever talks to this, never touches the filesystem
  directly, same pattern as Docker Desktop / Ollama.
- **AI layer** (`src/main/ai.js`) sends a metadata-only snapshot (paths,
  sizes, extensions, timestamps — never contents) to OpenRouter and asks for a
  JSON organization plan.
- **Settings** (`src/main/settings.js`) persists the BYOK key and model.
  Reached from the renderer over IPC (`settings:get` / `settings:save` /
  `settings:clear`), not over HTTP.
- **Env loader** (`src/main/env.js`) reads `.env` at startup without adding a
  dependency.
- **Renderer** (`src/renderer/`) is plain HTML/JS for now — swap in your
  Next.js/React setup once the API contract feels right; it's a static
  bundle either way since Electron just loads local files.

## Privacy — what actually leaves your machine

File **contents** are never read or sent. But when you click "Get AI
suggestions", the following is sent to OpenRouter (and on to whichever
provider it routes to) as part of the prompt:

- full absolute paths (so your directory layout is visible)
- file names, extensions, sizes, modification dates, open counts

Everything else — scanning, the SQLite index, `open_count` tracking, file
moves, and your API key at rest — stays entirely local. If that trade isn't
acceptable, skip the suggestions feature; the rest of the app doesn't need the
key.



## Usage-frequency tracking — an honest caveat

True "last accessed" time (`atime`) is disabled by default on most modern
filesystems for performance reasons, so it can't be trusted. This scaffold
tracks two proxies instead:

1. `modified_at` — reliable, from the OS.
2. `open_count` / `last_opened_at` — incremented only when a file is opened
   **through this app** (see `POST /api/open`).

For real "used but not modified" tracking (e.g. a PDF you keep reading but
never edit), you'd need an OS-level hook:
- macOS: FSEvents
- Linux: `fanotify` / `inotify`
- Windows: `ReadDirectoryChangesW` or ETW

Each is platform-specific and some need elevated permissions — treat this as
a v2 feature once the core loop (scan → suggest → apply) is working.

## Suggested next steps

1. Wire `POST /api/apply-move` up to a confirmation dialog in the UI before
   any file actually moves.
2. Add an exclude-list setting so the agent never touches certain folders.
3. Add duplicate detection (hash files during scan, flag matches).
4. Package with `electron-builder` for a distributable `.dmg` / `.exe`.
5. Consider swapping the local Express API for Electron's IPC directly if
   you don't need it reachable from a browser too.

## Project structure

```
file-organizer-agent/
├── package.json
├── .env.example         # optional env fallback (the Settings dialog is primary)
├── src/
│   ├── main/           # Electron main process (Node context)
│   │   ├── index.js     # app entry, window creation, folder picker, settings IPC
│   │   ├── env.js       # zero-dependency .env loader
│   │   ├── settings.js  # BYOK storage, encrypted via Electron safeStorage
│   │   ├── server.js    # local Express API
│   │   ├── db.js        # SQLite schema + prepared statements
│   │   ├── scanner.js   # recursive directory walk
│   │   ├── watcher.js   # live file watching via chokidar
│   │   └── ai.js        # OpenRouter API call for suggestions
│   ├── preload/
│   │   └── preload.js   # safe bridge exposed to renderer
│   └── renderer/        # UI (plain HTML/JS scaffold)
│       ├── index.html
│       ├── style.css
│       └── renderer.js
```
