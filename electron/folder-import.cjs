"use strict";

// Folder scan + profiling + AI-plan execution for "Create project from folder".
// Runs entirely in the Electron main process (Node): the renderer only sees
// compact profiles and the resulting plan.

const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");
const ExcelJS = require("exceljs");
const db = require("./db.cjs");
const llm = require("./llm.cjs");

function resolveSourcePath(folder, relativeFile) {
  const root = path.resolve(folder);
  const rel = String(relativeFile ?? "").replace(/^[/\\]+/, "");
  const full = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) {
    throw new Error(`Path escapes import folder: ${relativeFile}`);
  }
  if (!fs.existsSync(full)) throw new Error(`File not found: ${relativeFile}`);
  return full;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_SOURCES = 40; // file::sheet pairs sent to the model
const MAX_DEPTH = 4;
const SAMPLE_ROWS = 5;
const MAX_PROFILE_COLUMNS = 40;
const CELL_TRUNC = 80;

// ---- type inference / row coercion --------------------------------------
// CJS port of the pure logic in src/lib/csv.ts + the header dedup in
// src/lib/xlsx.ts (renderer code is ESM/TS and can't be required here; keep
// the two in sync if the inference rules change).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+$/;
const BOOLISH = new Set(["true", "false", "0", "1"]);

function inferKind(colName, values) {
  const nameHasDate = /date|_at$|_on$|timestamp/i.test(colName);
  let seen = 0,
    ints = 0,
    floats = 0,
    bools = 0,
    dates = 0,
    datetimes = 0;
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (v === "") continue;
    seen++;
    if (BOOLISH.has(v.toLowerCase())) bools++;
    if (INT_RE.test(v)) ints++;
    else if (FLOAT_RE.test(v)) floats++;
    if (ISO_DATETIME.test(v)) datetimes++;
    else if (ISO_DATE.test(v)) dates++;
  }
  if (seen === 0) return "text";
  if (datetimes === seen) return "timestamptz";
  if (dates === seen) return "date";
  if (nameHasDate && dates + datetimes === seen) return datetimes > 0 ? "timestamptz" : "date";
  if (bools === seen && ints < seen) return "boolean";
  if (ints === seen) return "integer";
  if (ints + floats === seen && floats > 0) return "double precision";
  return "text";
}

function coerceValue(type, raw) {
  const v = raw == null ? "" : String(raw).trim();
  if (v === "") return { ok: true, value: null };
  switch (type) {
    case "integer":
      return INT_RE.test(v) ? { ok: true, value: v } : { ok: false };
    case "double precision":
      return INT_RE.test(v) || FLOAT_RE.test(v) ? { ok: true, value: v } : { ok: false };
    case "boolean": {
      const lv = v.toLowerCase();
      if (!BOOLISH.has(lv)) return { ok: false };
      return { ok: true, value: lv === "true" || lv === "1" ? "true" : "false" };
    }
    case "date":
      return ISO_DATE.test(v) ? { ok: true, value: v } : { ok: false };
    case "timestamptz":
      return ISO_DATETIME.test(v) || ISO_DATE.test(v) ? { ok: true, value: v } : { ok: false };
    default:
      return { ok: true, value: v };
  }
}

function dedupeHeaders(rawHeaders) {
  const seen = new Map();
  return rawHeaders.map((h) => {
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n === 0 ? h : `${h}_${n + 1}`;
  });
}

// ---- parsing --------------------------------------------------------------

function cellToString(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return cellToString(value.result);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join("");
    }
    return "";
  }
  return String(value);
}

function parseCsvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const res = Papa.parse(text, { header: true, skipEmptyLines: "greedy" });
  const rows = (res.data ?? []).filter((r) => r && Object.keys(r).length > 0);
  const headers = res.meta.fields ?? [];
  if (headers.length === 0 || rows.length === 0) return [];
  return [{ sheet: null, headers, rows }];
}

async function parseXlsxFile(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const out = [];
  for (const ws of workbook.worksheets) {
    if (ws.rowCount < 2) continue;
    const headerRow = ws.getRow(1);
    const rawHeaders = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      rawHeaders[colNumber - 1] = cellToString(cell.value).trim() || `column_${colNumber}`;
    });
    if (rawHeaders.length === 0) continue;
    const headers = dedupeHeaders(rawHeaders);
    const rows = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (row.cellCount === 0) continue;
      const obj = {};
      let hasValue = false;
      headers.forEach((h, i) => {
        const v = cellToString(row.getCell(i + 1).value);
        if (v !== "") hasValue = true;
        obj[h] = v;
      });
      if (hasValue) rows.push(obj);
    }
    if (rows.length === 0) continue;
    out.push({ sheet: ws.name, headers, rows });
  }
  return out;
}

// ---- scan + profile --------------------------------------------------------

function scanFolder(dir) {
  const found = []; // { file, depth }
  const skipped = [];
  const walk = (d, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.(csv|xlsx|xls)$/i.test(e.name)) {
        const size = fs.statSync(full).size;
        if (size > MAX_FILE_BYTES) skipped.push({ file: full, reason: "over 50MB" });
        else found.push({ file: full, depth });
      }
    }
  };
  walk(dir, 0);
  // Shallowest first: research folders typically keep curated summary
  // workbooks near the top and raw instrument dumps in deep subtrees, and the
  // MAX_SOURCES cap should spend its budget on the summaries.
  found.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  return { files: found.map((f) => f.file), skipped };
}

// Cache of parsed tables from the last analyze pass, so execute doesn't have
// to re-parse. Keyed by `${file}::${sheet ?? ""}`.
let parsedCache = new Map();

async function profileFolder(dir, onProgress) {
  const { files, skipped } = scanFolder(dir);
  if (files.length === 0) throw new Error("No CSV or Excel files found in this folder");

  parsedCache = new Map();
  const profiles = [];
  let sources = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (sources >= MAX_SOURCES) {
      skipped.push({ file, reason: `source cap (${MAX_SOURCES}) reached` });
      continue;
    }
    onProgress?.(`Reading ${path.basename(file)} (${i + 1}/${files.length})`);
    let tables = [];
    try {
      tables = /\.csv$/i.test(file) ? parseCsvFile(file) : await parseXlsxFile(file);
    } catch (err) {
      skipped.push({ file, reason: `parse error: ${err.message}` });
      continue;
    }
    const rel = path.relative(dir, file);
    for (const t of tables) {
      if (sources >= MAX_SOURCES) {
        skipped.push({ file: `${rel} [${t.sheet}]`, reason: `source cap (${MAX_SOURCES}) reached` });
        continue;
      }
      sources++;
      parsedCache.set(`${rel}::${t.sheet ?? ""}`, t);
      const headers = t.headers.slice(0, MAX_PROFILE_COLUMNS);
      const sampleRows = t.rows
        .slice(0, SAMPLE_ROWS)
        .map((r) => headers.map((h) => String(r[h] ?? "").slice(0, CELL_TRUNC)));
      profiles.push({
        file: rel,
        sheet: t.sheet,
        row_count: t.rows.length,
        columns: headers.map((h) => ({
          header: h,
          inferred_type: inferKind(h, t.rows.slice(0, 500).map((r) => r[h] ?? "")),
        })),
        truncated_columns: t.headers.length > MAX_PROFILE_COLUMNS ? t.headers.length - MAX_PROFILE_COLUMNS : 0,
        sample_rows: sampleRows,
      });
    }
  }
  return { profiles, skipped, folder: dir };
}

async function analyzeFolder(dir, onProgress) {
  const { profiles, skipped } = await profileFolder(dir, onProgress);
  onProgress?.(`Analyzing ${profiles.length} sources with Nemotron…`);
  const plan = await llm.analyzeProfiles(profiles);
  return { plan, profiles, skipped, folder: dir };
}

// ---- execute ----------------------------------------------------------------

async function getParsedTable(folder, source) {
  const key = `${source.file}::${source.sheet ?? ""}`;
  if (parsedCache.has(key)) return parsedCache.get(key);
  // Fallback: re-parse (e.g. app reloaded between analyze and execute).
  const full = resolveSourcePath(folder, source.file);
  const tables = /\.csv$/i.test(full) ? parseCsvFile(full) : await parseXlsxFile(full);
  for (const t of tables) parsedCache.set(`${source.file}::${t.sheet ?? ""}`, t);
  const found = parsedCache.get(key);
  if (!found) throw new Error(`Source not found: ${source.file} [${source.sheet ?? "csv"}]`);
  return found;
}

async function executeImportPlan({ folder, projectInput, tables }, onProgress) {
  const projectId = db.createProject(projectInput);
  try {
    return await executeImportPlanInner(projectId, folder, tables, onProgress);
  } catch (err) {
    try {
      db.deleteProject(projectId);
    } catch {
      /* best effort rollback */
    }
    throw err;
  }
}

async function executeImportPlanInner(projectId, folder, tables, onProgress) {
  const bindings = {};
  const results = [];

  for (const table of tables) {
    onProgress?.(`Creating table ${table.display_name}…`);
    const columns = table.columns.map((c) => ({
      name: c.name,
      original_name: c.source_header ?? c.name,
      type: c.type,
    }));
    const { dataset_id } = db.createProjectDataset({
      projectId,
      displayName: table.display_name,
      sourceFilename: table.sources.map((s) => s.file).join(", ").slice(0, 300),
      columns,
    });
    // createProjectDataset sanitizes/dedupes names; re-read the actual schema
    // so row keys line up exactly.
    const ds = db.listDatasets(projectId, "desc").find((d) => d.id === dataset_id);
    const schema = ds.column_schema; // [{name, original_name, type}] in plan order

    let inserted = 0;
    let invalid = 0;
    for (const source of table.sources) {
      const parsed = await getParsedTable(folder, source);
      onProgress?.(
        `Importing ${source.file}${source.sheet ? ` [${source.sheet}]` : ""} → ${table.display_name}…`,
      );
      const batch = [];
      for (const raw of parsed.rows) {
        const row = {};
        let ok = true;
        for (let i = 0; i < schema.length; i++) {
          const planCol = table.columns[i];
          const sc = schema[i];
          let rawVal;
          if (planCol && planCol.source_header === null) {
            // AI-introduced column (e.g. source_label)
            rawVal = planCol.name === "source_label" ? (source.source_label ?? source.sheet ?? source.file) : "";
          } else {
            rawVal = raw[planCol ? planCol.source_header : sc.original_name];
          }
          const res = coerceValue(sc.type, rawVal);
          if (!res.ok) {
            ok = false;
            break;
          }
          row[sc.name] = res.value;
        }
        if (ok) batch.push(row);
        else invalid++;
      }
      for (let i = 0; i < batch.length; i += 1000) {
        inserted += db.insertDatasetRowsTyped(dataset_id, batch.slice(i, i + 1000));
      }
    }
    bindings[table.key] = dataset_id;
    results.push({ key: table.key, display_name: table.display_name, inserted, invalid });
  }

  // Store the AI schema as a runtime template so the existing ErdDiagram +
  // overview UI render it.
  const aiTemplate = {
    key: "__ai_import__",
    name: db.getProject(projectId)?.project_name ?? "Imported project",
    tagline: "AI-generated schema",
    description: "Schema inferred from folder import",
    tables: tables.map((t) => ({
      key: t.key,
      display_name: t.display_name,
      description: t.description,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk || undefined })),
      fks: t.fks,
      step: t.step,
    })),
  };
  db.updateProjectTemplateMeta(projectId, { ai_template: aiTemplate, bindings });

  return { projectId, results };
}

module.exports = {
  scanFolder,
  profileFolder,
  analyzeFolder,
  executeImportPlan,
};
