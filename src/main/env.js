/**
 * Minimal .env loader so OPENROUTER_API_KEY can live in a local file instead of
 * the shell environment. Real environment variables always take precedence, so
 * CI or a packaged launch can still override anything set here.
 */

const fs = require("fs");
const path = require("path");

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function loadEnv() {
  const envPath = path.join(__dirname, "..", "..", ".env");
  if (!fs.existsSync(envPath)) return {};

  const loaded = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(LINE);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    const value = rawValue.replace(/^["']|["']$/g, "");
    if (value === "") continue;

    process.env[key] = value;
    loaded[key] = value;
  }
  return loaded;
}

module.exports = { loadEnv };
