"use strict";

// NVIDIA NIM (build.nvidia.com) client. OpenAI-compatible chat completions.
// The API key lives in the local SQLite settings table and never reaches the
// renderer process.

const db = require("./db.cjs");

const API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-instruct";

const COLUMN_KINDS = ["text", "integer", "double precision", "boolean", "date", "timestamptz"];

function getConfig() {
  const apiKey = db.getSetting("nvidia_api_key");
  const model = db.getSetting("nvidia_model") || DEFAULT_MODEL;
  if (!apiKey) {
    throw new Error("No NVIDIA API key configured. Add one under Settings.");
  }
  return { apiKey, model };
}

async function chat(messages, { maxTokens = 8192, temperature = 0.2 } = {}) {
  const { apiKey, model } = getConfig();
  const res = await fetch(API_URL, {
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
    throw new Error(`NVIDIA API error ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("NVIDIA API returned an empty response");
  }
  return content;
}

async function listModels() {
  const { apiKey } = getConfig();
  const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Could not list models (${res.status})`);
  const data = await res.json();
  return (data?.data ?? []).map((m) => m.id).filter(Boolean);
}

async function testConnection() {
  const { model } = getConfig();
  try {
    const reply = await chat(
      [{ role: "user", content: 'Reply with exactly the word "ok" and nothing else.' }],
      { maxTokens: 200, temperature: 0 },
    );
    return { model, reply: reply.trim().slice(0, 80) };
  } catch (err) {
    // Model ids rotate on build.nvidia.com; on a 404 suggest live Nemotron ids.
    if (String(err.message).includes("404")) {
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

// Pull a JSON object out of a model reply that may be wrapped in prose or
// markdown fences.
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

const SYSTEM_PROMPT = `You are an expert research data engineer. You are given profiles of spreadsheet files (CSV / Excel sheets) found in a research project folder: file path, sheet name, column headers, inferred column types, row counts, and a few sample rows.

Design a clean relational database schema for this data. Rules:

1. Group sources that represent the SAME logical table (e.g. the same measurements repeated across years or rounds, with mostly-overlapping headers) into ONE table. Give that table a "source_label" text column and set each source's "source_label" value (e.g. "1-Year FC", "2023").
2. Keep genuinely different data in separate tables.
3. For each table pick clear snake_case column names. For every column choose exactly one type from: ${COLUMN_KINDS.map((k) => `"${k}"`).join(", ")}. When a source column is messy (mixed content, unit rows under headers), prefer "text".
4. Map every table column to the source header it comes from ("source_header"). Columns like "source_label" that you introduce have "source_header": null.
5. Identify a primary key column per table when a column looks unique per row (ids, specimen codes). Mark with "pk": true. Do not invent surrogate keys — the database adds row_id automatically.
6. Identify foreign-key relationships BETWEEN your proposed tables when a column's values clearly reference another table's key column (matching names like section_id / specimen_code and overlapping sample values).
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
  // FKs must point at proposed tables/columns; drop the ones that don't.
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

// Assign ErdDiagram steps (1-4) by FK dependency depth: tables nothing depends
// on sit at step 1, children below their parents.
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
    // One retry with explicit error feedback.
    raw = await chat([
      ...messages,
      { role: "assistant", content: raw.slice(0, 4000) },
      {
        role: "user",
        content: `Your previous response could not be parsed as JSON (${err.message}). Respond again with ONLY the JSON object, no other text.`,
      },
    ]);
    plan = extractJson(raw);
  }
  return assignSteps(validatePlan(plan));
}

module.exports = {
  chat,
  listModels,
  testConnection,
  analyzeProfiles,
  DEFAULT_MODEL,
};
