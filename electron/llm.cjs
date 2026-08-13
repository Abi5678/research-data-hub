"use strict";

// LLM client for optional schema assist.
// NHDOT production default: cloud NVIDIA NIM is OFF (ALLOW_CLOUD_NIM must be "1").
// Optional local/on-prem OpenAI-compatible endpoint via LLM_BASE_URL + settings.

const db = require("./db.cjs");

const CLOUD_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-instruct";

const COLUMN_KINDS = ["text", "integer", "double precision", "boolean", "date", "timestamptz"];

function cloudNimAllowed() {
  return process.env.ALLOW_CLOUD_NIM === "1";
}

function localBaseUrl() {
  const fromEnv = (process.env.LLM_BASE_URL || "").trim().replace(/\/$/, "");
  const fromSettings = (db.getSetting("llm_base_url") || "").trim().replace(/\/$/, "");
  return fromEnv || fromSettings || "";
}

function isAiAssistAvailable() {
  if (localBaseUrl()) return true;
  if (cloudNimAllowed() && db.getSetting("nvidia_api_key")) return true;
  return false;
}

function getConfig() {
  const local = localBaseUrl();
  const model =
    db.getSetting("nvidia_model") || db.getSetting("llm_model") || DEFAULT_MODEL;
  if (local) {
    const apiKey = db.getSetting("nvidia_api_key") || db.getSetting("llm_api_key") || "local";
    return {
      apiKey,
      model,
      apiUrl: `${local}/chat/completions`,
      mode: "local",
    };
  }
  if (!cloudNimAllowed()) {
    throw new Error(
      "Cloud NVIDIA NIM is disabled for this build (NHDOT). Configure a local LLM_BASE_URL or use deterministic import.",
    );
  }
  const apiKey = db.getSetting("nvidia_api_key");
  if (!apiKey) {
    throw new Error("No NVIDIA API key configured. Add one under Settings.");
  }
  return { apiKey, model, apiUrl: CLOUD_API_URL, mode: "cloud" };
}

async function chat(messages, { maxTokens = 8192, temperature = 0.2 } = {}) {
  const { apiKey, model, apiUrl } = getConfig();
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("LLM API returned an empty response");
  }
  return content;
}

async function listModels() {
  const { apiKey, apiUrl, mode } = getConfig();
  if (mode !== "cloud") {
    return [db.getSetting("nvidia_model") || DEFAULT_MODEL];
  }
  const base = apiUrl.replace(/\/chat\/completions$/, "");
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Could not list models (${res.status})`);
  const data = await res.json();
  return (data?.data ?? []).map((m) => m.id).filter(Boolean);
}

async function testConnection() {
  const { model, mode } = getConfig();
  try {
    const reply = await chat(
      [{ role: "user", content: 'Reply with exactly the word "ok" and nothing else.' }],
      { maxTokens: 200, temperature: 0 },
    );
    return { model, reply: reply.trim().slice(0, 80), mode };
  } catch (err) {
    if (String(err.message).includes("404") && mode === "cloud") {
      let suggestions = [];
      try {
        const ids = await listModels();
        suggestions = ids.filter((id) => /nemotron/i.test(id)).slice(0, 8);
      } catch {
        /* keep original error */
      }
      if (suggestions.length > 0) {
        throw new Error(
          `Model "${model}" is not available on this account. Available Nemotron models: ${suggestions.join(", ")}`,
        );
      }
    }
    throw err;
  }
}

function extractJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model response");
  }
  return JSON.parse(t.slice(start, end + 1));
}

const SYSTEM_PROMPT = `You are an expert research data engineer. You are given profiles of tabular files (CSV / TSV / TXT / Excel sheets) found in a research project folder: file path, sheet name, column headers, inferred column types, row counts, and sample rows (up to ~20 per source).

Design a clean relational database schema for this data. Rules:

1. Group sources that represent the SAME logical table (e.g. the same measurements repeated across years or rounds, with mostly-overlapping headers) into ONE table. Give that table a "source_label" text column and set each source's "source_label" value (e.g. "1-Year FC", "2023").
2. Keep genuinely different data in separate tables.
3. For each table pick clear snake_case column names. For every column choose exactly one type from: ${COLUMN_KINDS.map((k) => `"${k}"`).join(", ")}. When a source column is messy (mixed content, unit rows under headers), prefer "text".
4. Map every table column to the source header it comes from ("source_header"). Columns like "source_label" that you introduce have "source_header": null.
5. Identify a primary key column per table when a column looks unique per row (record ids, sample codes). Mark with "pk": true. Do not invent surrogate keys — the database adds row_id automatically.
6. Identify foreign-key relationships BETWEEN your proposed tables when a column's values clearly reference another table's key column (a name like <parent>_id or <parent>_code, plus overlapping sample values).
7. Suggest a short project name describing the folder's research subject.

Respond with ONLY a JSON object, no prose, in exactly this shape:
{
  "project_name": string,
  "notes": string,            // 1-3 sentences: key modeling decisions & caveats
  "tables": [
    {
      "key": string,          // snake_case identifier
      "display_name": string,
      "description": string,  // one sentence
      "columns": [ { "name": string, "type": string, "pk"?: true, "source_header": string | null } ],
      "sources": [ { "file": string, "sheet": string | null, "source_label": string | null } ],
      "fks": [ { "column": string, "references": { "table": string, "column": string } } ]
    }
  ]
}`;

function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.tables) || plan.tables.length === 0) {
    throw new Error("Model returned no tables");
  }
  const keys = new Set();
  for (const t of plan.tables) {
    if (!t.key || typeof t.key !== "string") throw new Error("Table missing key");
    t.key = t.key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "table";
    while (keys.has(t.key)) t.key += "_2";
    keys.add(t.key);
    t.display_name = String(t.display_name || t.key);
    t.description = String(t.description || "");
    if (!Array.isArray(t.columns) || t.columns.length === 0) {
      throw new Error(`Table ${t.key} has no columns`);
    }
    for (const c of t.columns) {
      c.name = String(c.name || "col");
      if (!COLUMN_KINDS.includes(c.type)) c.type = "text";
      if (c.source_header !== null && typeof c.source_header !== "string") {
        c.source_header = c.source_header == null ? null : String(c.source_header);
      }
    }
    t.sources = Array.isArray(t.sources) ? t.sources : [];
    t.fks = Array.isArray(t.fks) ? t.fks : [];
  }
  const colsByTable = new Map(plan.tables.map((t) => [t.key, new Set(t.columns.map((c) => c.name))]));
  for (const t of plan.tables) {
    t.fks = t.fks.filter(
      (fk) =>
        fk &&
        typeof fk.column === "string" &&
        colsByTable.get(t.key)?.has(fk.column) &&
        fk.references &&
        colsByTable.has(fk.references.table) &&
        colsByTable.get(fk.references.table).has(fk.references.column),
    );
  }
  plan.project_name = String(plan.project_name || "Imported project");
  plan.notes = String(plan.notes || "");
  return plan;
}

function assignSteps(plan) {
  const depth = new Map(plan.tables.map((t) => [t.key, 1]));
  for (let i = 0; i < 4; i++) {
    for (const t of plan.tables) {
      for (const fk of t.fks) {
        const parentDepth = depth.get(fk.references.table) ?? 1;
        if (depth.get(t.key) <= parentDepth) depth.set(t.key, Math.min(parentDepth + 1, 4));
      }
    }
  }
  for (const t of plan.tables) t.step = depth.get(t.key);
  return plan;
}

async function analyzeProfiles(profiles) {
  const userContent = JSON.stringify({ files: profiles }, null, 1);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
  let raw = await chat(messages);
  let plan;
  try {
    plan = extractJson(raw);
  } catch (err) {
    // One retry asking for JSON only.
    raw = await chat([
      ...messages,
      { role: "assistant", content: raw },
      { role: "user", content: "Return ONLY valid JSON matching the required schema. No markdown." },
    ]);
    plan = extractJson(raw);
  }
  return assignSteps(validatePlan(plan));
}

module.exports = {
  chat,
  testConnection,
  analyzeProfiles,
  isAiAssistAvailable,
  cloudNimAllowed,
  localBaseUrl,
  DEFAULT_MODEL,
  COLUMN_KINDS,
  validatePlan,
  extractJson,
};
