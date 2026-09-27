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

const SYSTEM_PROMPT = `You are a file-organization assistant. You will be given a JSON list of files (metadata only, no file contents). Suggest a cleaner folder structure and flag files that look safe to archive or delete because they are old, duplicated, or unused. Respond with JSON only, matching this shape exactly:

{
  "moves": [{ "path": "...", "suggestedFolder": "...", "reason": "..." }],
  "archiveCandidates": [{ "path": "...", "reason": "..." }]
}`;

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

async function getOrganizationSuggestions(files) {
  const apiKey = settings.getApiKey();
  if (!apiKey) {
    throw new Error("No OpenRouter API key yet. Add your own key in Settings.");
  }

  const model = settings.getModel();

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(buildFileSnapshot(files), null, 2) },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 2000,
      temperature: 0.2,
    }),
  });

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
    throw new Error("OpenRouter response was truncated (max_completion_tokens reached).");
  }

  const text = choice.message?.content || "";
  console.log(`[ai] organization plan from ${data.model || model} (${data.usage?.total_tokens ?? "?"} tokens)`);

  try {
    return parsePlan(text);
  } catch {
    return { moves: [], archiveCandidates: [], raw: text };
  }
}

module.exports = { getOrganizationSuggestions };
