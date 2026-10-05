/**
 * Calls the OpenRouter API with a metadata-only snapshot of the file index
 * (paths, sizes, extensions, timestamps) and asks for an organization plan.
 * Raw file contents are never sent.
 *
 * The key is the user's own (BYOK), saved through the in-app settings dialog
 * and stored encrypted by settings.js. It is read here inside the main process
 * only and is never exposed to the renderer.
 */

const settings = require("./settings");

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const APP_TITLE = "File Organizer Agent";
// Generous, because a large folder means a big prompt, but bounded so the UI
// spinner can never hang forever. Override for very slow models.
const REQUEST_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 120000;

// One `moves` entry costs roughly 50 output tokens (path + folder + reason), so
// a plan covering a few hundred files needs far more than a single small
// allowance. Files are sent in batches and each call gets a realistic budget.
const BATCH_SIZE = 100;
const MAX_COMPLETION_TOKENS = 14000;

const SYSTEM_PROMPT = `You are a file-organization assistant. You will be given a JSON list of files (metadata only, no file contents). Suggest a cleaner folder structure and flag files that look safe to archive or delete because they are old, duplicated, or unused. Respond with JSON only, matching this shape exactly:

{
  "moves": [{ "path": "...", "suggestedFolder": "...", "reason": "..." }],
  "archiveCandidates": [{ "path": "...", "reason": "..." }]
}

Rules: copy each "path" exactly as given, never invent one, and keep every "reason" under 10 words. Only suggest moves for files that appear in the list.`;

function buildFileSnapshot(files) {
  return files.map((f) => ({
    path: f.path,
    name: f.name,
    ext: f.extension,
    sizeKB: Math.round(f.size / 1024),
    modified: new Date(f.modified_at).toISOString().slice(0, 10),
    openCount: f.open_count,
  }));
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-OpenRouter-Title": APP_TITLE,
  };
  const siteUrl = process.env.OPENROUTER_SITE_URL;
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;
  return headers;
}
function parsePlan(text) {
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function requestPlan(files, apiKey, model) {
  // An explicit AbortController with a normal timer rather than
  // AbortSignal.timeout(), whose timer is unref'd: it will not keep the event
  // loop alive on its own, so the abort is not guaranteed to fire.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: buildHeaders(apiKey),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          // Compact, not pretty-printed: indentation costs about 30% more
          // input tokens for no benefit.
          { role: "user", content: JSON.stringify(buildFileSnapshot(files)) },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        temperature: 0.2,
      }),
    });
  } catch (err) {
    // The UI shows a spinner while this runs, so a hung request has to end in
    // an error rather than leaving the user watching it indefinitely.
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error(`OpenRouter didn't respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. Try again, or pick a faster model in Settings.`);
    }
    throw new Error(`Could not reach OpenRouter: ${err.message}`);
  } finally {
    clearTimeout(deadline);
  }

  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try {
      detail = JSON.parse(body)?.error?.message || body;
    } catch {
      // non-JSON error body, keep the raw text
    }
    throw new Error(`OpenRouter API error ${response.status}: ${detail}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error("OpenRouter returned no completion choices.");
  }
  if (choice.finish_reason === "length") {
    throw new Error(
      `the plan hit the ${MAX_COMPLETION_TOKENS}-token output limit and was cut off`
    );
  }

  const text = choice.message?.content || "";
  console.log(
    `[ai] ${files.length} files via ${data.model || model} (${data.usage?.total_tokens ?? "?"} tokens)`
  );

  try {
    return parsePlan(text);
  } catch {
    return { moves: [], archiveCandidates: [], raw: text };
  }
}

function entryFor(item, extraKey) {
  if (!item || typeof item.path !== "string") return null;
  const entry = { path: item.path };
  if (extraKey) {
    const value = item[extraKey];
    if (typeof value === "string" && value.trim()) entry[extraKey] = value.trim();
  }
  const reason = item.reason;
  if (typeof reason === "string" && reason.trim()) entry.reason = reason.trim();
  return entry;
}

/**
 * Builds an organization plan for a set of files.
 *
 * Files are sent in batches so the per-call output stays inside a sane token
 * budget, and the merged result is filtered down to paths that were actually
 * sent. That filter matters: the apply endpoint renames real files, so a
 * hallucinated or mistyped path in the model's reply must never reach it.
 */
async function getOrganizationSuggestions(files) {
  const apiKey = settings.getApiKey();
  if (!apiKey) {
    throw new Error("No OpenRouter API key yet. Add your own key in Settings.");
  }
  if (!Array.isArray(files) || !files.length) {
    return { moves: [], archiveCandidates: [], warnings: [] };
  }

  const model = settings.getModel();
  const known = new Set(files.map((f) => f.path));
  const batches = chunk(files, BATCH_SIZE);

  const result = { moves: [], archiveCandidates: [], warnings: [] };
  const seen = new Set();
  let succeeded = 0;

  for (const batch of batches) {
    let plan;
    try {
      plan = await requestPlan(batch, apiKey, model);
    } catch (err) {
      result.warnings.push(`${batch.length} files: ${err.message}`);
      continue;
    }
    succeeded++;

    for (const item of plan.moves || []) {
      const entry = entryFor(item, "suggestedFolder");
      if (entry && known.has(entry.path) && !seen.has(entry.path)) {
        seen.add(entry.path);
        result.moves.push(entry);
      }
    }
    for (const item of plan.archiveCandidates || []) {
      const entry = entryFor(item);
      // A file already slated to move shouldn't also be offered for archiving.
      if (entry && known.has(entry.path) && !seen.has(entry.path)) {
        seen.add(entry.path);
        result.archiveCandidates.push(entry);
      }
    }
    if (plan.raw) {
      result.warnings.push(`${batch.length} files: the model replied with something that wasn't JSON, so that batch was skipped.`);
    }
  }

  if (!succeeded) {
    throw new Error(result.warnings[0] || "OpenRouter returned no usable plan.");
  }

  return result;
}

module.exports = { getOrganizationSuggestions, BATCH_SIZE, MAX_COMPLETION_TOKENS };
