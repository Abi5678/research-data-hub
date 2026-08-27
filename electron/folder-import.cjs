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
const { worksheetToTable } = require("./excel-table.cjs");

function normalizeRel(p) {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function resolveSourcePath(folder, relativeFile) {
  const root = path.resolve(folder);
  const rel = normalizeRel(relativeFile);
  const full = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) {
    throw new Error(`Path escapes import folder: ${relativeFile}`);
  }
  if (fs.existsSync(full)) return full;

  // Case-insensitive / basename fallback — models often rewrite paths slightly.
  const targetNorm = rel.toLowerCase();
  const targetBase = path.basename(rel).toLowerCase();
  const matches = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else {
        const r = normalizeRel(path.relative(root, abs));
        if (r.toLowerCase() === targetNorm || path.basename(r).toLowerCase() === targetBase) {
          matches.push(abs);
        }
      }
    }
  };
  walk(root);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const exactBase = matches.find(
      (m) => path.basename(m).toLowerCase() === targetBase && normalizeRel(path.relative(root, m)).toLowerCase().endsWith(targetNorm),
    );
    if (exactBase) return exactBase;
    // Prefer the shallowest match with the same basename.
    matches.sort((a, b) => a.length - b.length);
    return matches[0];
  }
  throw new Error(`File not found: ${relativeFile}`);
}

/** Rewrite AI-returned source paths to the real relative paths from the scan. */
function rematchPlanSources(plan, profiles) {
  const byNorm = new Map();
  const byBase = new Map();
  for (const p of profiles) {
    const real = normalizeRel(p.file);
    byNorm.set(real.toLowerCase(), real);
    const base = path.basename(real).toLowerCase();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(real);
  }

  for (const t of plan.tables) {
    const remapped = [];
    for (const s of t.sources || []) {
      const raw = normalizeRel(s.file);
      let file = byNorm.get(raw.toLowerCase());
      if (!file) {
        const cands = byBase.get(path.basename(raw).toLowerCase()) || [];
        if (cands.length === 1) file = cands[0];
        else {
          file = cands.find(
            (c) => c.toLowerCase().endsWith(raw.toLowerCase()) || raw.toLowerCase().endsWith(c.toLowerCase()),
          );
        }
      }
      if (!file) {
        // Keep source but mark — execute will try disk fallback; if that fails, skip.
        remapped.push({ ...s, file: raw, _unresolved: true });
      } else {
        remapped.push({ ...s, file, sheet: s.sheet ?? null });
      }
    }
    t.sources = remapped;
  }
  plan.tables = plan.tables.filter((t) => (t.sources || []).length > 0);
  if (plan.tables.length === 0) {
    throw new Error("AI plan referenced no readable spreadsheet files from the folder");
  }
  return plan;
}

// Tunable via env for large lab trees; defaults raised for multi-year field projects.
const MAX_FILE_BYTES = Number(process.env.IMPORT_MAX_FILE_BYTES || 200 * 1024 * 1024);
const MAX_SOURCES = Number(process.env.IMPORT_MAX_SOURCES || 120); // file::sheet pairs to the model
const MAX_DEPTH = Number(process.env.IMPORT_MAX_DEPTH || 12);
const SAMPLE_ROWS = Number(process.env.IMPORT_SAMPLE_ROWS || 20);
const MAX_PROFILE_COLUMNS = Number(process.env.IMPORT_MAX_COLUMNS || 80);
const CELL_TRUNC = 120;
const MAX_MB_LABEL = Math.round(MAX_FILE_BYTES / (1024 * 1024));

const TABULAR_RE = /\.(csv|tsv|txt|xlsx|xlsm)$/i;
const LEGACY_XLS_RE = /\.xls$/i;
const NON_TABULAR_HINT_RE = /\.(pdf|docx?|pptx?|png|jpe?g|gif|webp|zip|rar|7z|bin|dat|raw|hdf5?|nc|mat|mp4|mov)$/i;

// ---- type inference / row coercion --------------------------------------
// CJS port of the pure logic in src/lib/csv.ts + the header dedup in
// src/lib/xlsx.ts (renderer code is ESM/TS and can't be required here; keep
// the two in sync if the inference rules change).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const INT_RE = /^[+-]?\d+$/;
// Matches 1.5, .5, 5., +1.23E+05, 1e-3. Instrument and LIMS exports routinely
// write moduli and strains in scientific notation; a decimal-only pattern
// silently demotes those columns to text.
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
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
    else if (NUMBER_RE.test(v)) floats++;
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
    case "integer": {
      // Plain digits pass through verbatim so long ids keep full precision.
      // Drop a leading "+": the server's bind step only accepts /^-?\d+$/.
      if (INT_RE.test(v)) return { ok: true, value: v.replace(/^\+/, "") };
      // Spreadsheets write whole numbers as "12.0" or "1e3"; accept those.
      const n = NUMBER_RE.test(v) ? Number(v) : NaN;
      return Number.isSafeInteger(n) ? { ok: true, value: String(n) } : { ok: false };
    }
    case "double precision":
      return NUMBER_RE.test(v) ? { ok: true, value: v } : { ok: false };
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
  // Counting occurrences per name is not enough: headers ['a','a','a_2'] made
  // the second `a` into `a_2`, colliding with the real third column. Rows are
  // keyed by header, so that column's data was silently overwritten. Probe for
  // a suffix nothing has taken yet instead.
  const used = new Set();
  return rawHeaders.map((h) => {
    if (!used.has(h)) {
      used.add(h);
      return h;
    }
    let n = 2;
    while (used.has(`${h}_${n}`)) n += 1;
    const name = `${h}_${n}`;
    used.add(name);
    return name;
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

function detectDelimiter(text) {
  const sample = text.slice(0, 8192);
  const lines = sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
  if (lines.length === 0) return ",";
  let commas = 0;
  let tabs = 0;
  let semis = 0;
  let pipes = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (ch === ",") commas++;
      else if (ch === "\t") tabs++;
      else if (ch === ";") semis++;
      else if (ch === "|") pipes++;
    }
  }
  if (tabs >= lines.length && tabs >= commas) return "\t";
  if (semis > commas && semis >= lines.length) return ";";
  if (pipes > commas && pipes >= lines.length) return "|";
  return ",";
}

function parseDelimitedFile(filePath, forcedDelimiter) {
  const text = fs.readFileSync(filePath, "utf8");
  // Strip UTF-8 BOM if present
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = forcedDelimiter ?? detectDelimiter(cleaned);
  const res = Papa.parse(cleaned, {
    header: true,
    skipEmptyLines: "greedy",
    delimiter,
  });
  const rows = (res.data ?? []).filter((r) => r && Object.keys(r).length > 0);
  const headers = dedupeHeaders(res.meta.fields ?? []);
  if (headers.length === 0 || rows.length === 0) return [];
  // Re-key rows if headers were deduped (Papa keys by original field names).
  const fields = res.meta.fields ?? [];
  const mapped =
    fields.length === headers.length && fields.every((f, i) => f === headers[i])
      ? rows
      : rows.map((row) => {
          const out = {};
          fields.forEach((f, i) => {
            out[headers[i]] = row[f] ?? "";
          });
          return out;
        });
  return [{ sheet: null, headers, rows: mapped }];
}

function parseCsvFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsv") return parseDelimitedFile(filePath, "\t");
  if (ext === ".txt") return parseDelimitedFile(filePath, null);
  return parseDelimitedFile(filePath, ",");
}

async function parseXlsxFile(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const out = [];
  for (const ws of workbook.worksheets) {
    const table = worksheetToTable(ws);
    if (!table) continue;
    out.push({ sheet: ws.name, headers: table.headers, rows: table.rows });
  }
  return out;
}

// ---- scan + profile --------------------------------------------------------

function scanFolder(dir) {
  const found = []; // { file, depth }
  const skipped = [];
  let depthSkipped = 0;
  const walk = (d, depth) => {
    if (depth > MAX_DEPTH) {
      depthSkipped += 1;
      return;
    }
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
      } else if (TABULAR_RE.test(e.name)) {
        const size = fs.statSync(full).size;
        if (size > MAX_FILE_BYTES) {
          skipped.push({
            file: full,
            reason: `over ${MAX_MB_LABEL}MB — split the file or raise IMPORT_MAX_FILE_BYTES`,
          });
        } else {
          found.push({ file: full, depth });
        }
      } else if (LEGACY_XLS_RE.test(e.name)) {
        skipped.push({
          file: full,
          reason: "legacy .xls — open in Excel and Save As .xlsx / .csv",
        });
      } else if (NON_TABULAR_HINT_RE.test(e.name)) {
        skipped.push({
          file: full,
          reason: "not a spreadsheet — export tables to CSV/XLSX first",
        });
      }
    }
  };
  walk(dir, 0);
  if (depthSkipped > 0) {
    skipped.push({
      file: dir,
      reason: `${depthSkipped} folder(s) deeper than ${MAX_DEPTH} levels — move CSVs up or raise IMPORT_MAX_DEPTH`,
    });
  }
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
  if (files.length === 0) {
    throw new Error(
      "No CSV, TSV, TXT, or Excel (.xlsx/.xlsm) files found. Export tables from PDF/Word to CSV first.",
    );
  }

  parsedCache = new Map();
  const profiles = [];
  let sources = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (sources >= MAX_SOURCES) {
      skipped.push({
        file,
        reason: `source cap (${MAX_SOURCES}) reached — raise IMPORT_MAX_SOURCES or import remaining CSVs manually`,
      });
      continue;
    }
    onProgress?.(`Reading ${path.basename(file)} (${i + 1}/${files.length})`);
    let tables = [];
    try {
      tables = /\.(csv|tsv|txt)$/i.test(file)
        ? parseCsvFile(file)
        : await parseXlsxFile(file);
    } catch (err) {
      skipped.push({ file, reason: `parse error: ${err.message}` });
      continue;
    }
    const rel = normalizeRel(path.relative(dir, file));
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

async function analyzeFolder(dir, onProgress, opts = {}) {
  const { profiles, skipped } = await profileFolder(dir, onProgress);
  if (profiles.length === 0) {
    throw new Error("No readable CSV/TSV/TXT/Excel files found in this folder");
  }
  const folderName = path.basename(dir);
  const wantAi = Boolean(opts.useAi);
  let plan;
  let mode = "deterministic";

  if (wantAi && llm.isAiAssistAvailable()) {
    try {
      onProgress?.(`Analyzing ${profiles.length} sources with AI…`);
      plan = await llm.analyzeProfiles(profiles);
      plan = rematchPlanSources(plan, profiles);
      mode = "ai";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.(`AI failed (${msg}); using deterministic plan…`);
      plan = buildDeterministicPlan(profiles, folderName);
      mode = "deterministic_fallback";
    }
  } else {
    onProgress?.(`Building deterministic schema for ${profiles.length} sources…`);
    plan = buildDeterministicPlan(profiles, folderName);
  }
  plan.mode = mode;
  return { plan, profiles, skipped, folder: dir, mode };
}

function toSnake(s) {
  return (
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "col"
  );
}

/** One table per file/sheet — guaranteed path when AI is off or fails. */
function buildDeterministicPlan(profiles, folderName) {
  const keys = new Set();
  const tables = profiles.map((p, idx) => {
    const baseName = path.basename(p.file, path.extname(p.file));
    let key = toSnake(baseName);
    if (p.sheet) key = `${key}_${toSnake(p.sheet)}`;
    if (!key) key = `table_${idx + 1}`;
    let unique = key;
    let n = 2;
    while (keys.has(unique)) {
      unique = `${key}_${n}`;
      n += 1;
    }
    keys.add(unique);

    const seen = new Set();
    const columns = (p.columns || []).map((c) => {
      let name = toSnake(c.header);
      if (seen.has(name)) {
        let k = 2;
        while (seen.has(`${name}_${k}`)) k += 1;
        name = `${name}_${k}`;
      }
      seen.add(name);
      return {
        name,
        type: c.inferred_type || "text",
        source_header: c.header,
      };
    });

    return {
      key: unique,
      display_name: p.sheet ? `${path.basename(p.file)} — ${p.sheet}` : path.basename(p.file),
      description: `Imported from ${p.file}`,
      columns,
      sources: [{ file: p.file, sheet: p.sheet ?? null, source_label: null }],
      fks: [],
      step: 1,
    };
  });

  return {
    project_name: folderName || "Imported project",
    notes:
      "Deterministic import: one table per file/sheet. Column types inferred from sample values.",
    tables,
  };
}

// ---- execute ----------------------------------------------------------------

async function getParsedTable(folder, source) {
  const rel = normalizeRel(source.file);
  const sheetKey = source.sheet ?? "";
  const key = `${rel}::${sheetKey}`;
  if (parsedCache.has(key)) return parsedCache.get(key);

  // Cache keys from analyze use the scan's relative path; also try basename.
  for (const [k, v] of parsedCache.entries()) {
    const [cachedRel, cachedSheet] = k.split("::");
    if ((cachedSheet || "") !== sheetKey) continue;
    if (
      normalizeRel(cachedRel).toLowerCase() === rel.toLowerCase() ||
      path.basename(cachedRel).toLowerCase() === path.basename(rel).toLowerCase()
    ) {
      return v;
    }
  }

  // Fallback: re-parse from disk (e.g. app reloaded between analyze and execute).
  const full = resolveSourcePath(folder, rel);
  const tables = /\.(csv|tsv|txt)$/i.test(full)
    ? parseCsvFile(full)
    : await parseXlsxFile(full);
  const realRel = normalizeRel(path.relative(path.resolve(folder), full));
  for (const t of tables) parsedCache.set(`${realRel}::${t.sheet ?? ""}`, t);
  const found =
    parsedCache.get(`${realRel}::${sheetKey}`) ||
    parsedCache.get(key) ||
    [...parsedCache.entries()].find(([k]) => {
      const [r, s] = k.split("::");
      return path.basename(r).toLowerCase() === path.basename(rel).toLowerCase() && (s || "") === sheetKey;
    })?.[1];
  if (!found) throw new Error(`Source not found: ${source.file} [${source.sheet ?? "csv"}]`);
  return found;
}

function listRelativeSpreadsheetFiles(folder) {
  const root = path.resolve(folder);
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(csv|tsv|txt|xlsx|xlsm)$/i.test(e.name)) {
        out.push(normalizeRel(path.relative(root, abs)));
      }
    }
  };
  walk(root);
  return out;
}

function rollbackDatasets(datasetIds) {
  for (const id of [...datasetIds].reverse()) {
    try {
      db.dropProjectDataset(id);
    } catch {
      /* best effort */
    }
  }
}

async function executeImportPlan({ folder, projectInput, tables, projectId: existingId, mode }, onProgress) {
  let projectId = existingId || null;
  let created = false;
  if (projectId) {
    const existing = db.getProject(projectId);
    if (!existing) throw new Error("Project not found");
  } else {
    if (!projectInput?.project_name || !projectInput?.project_code) {
      throw new Error("Project name and code are required");
    }
    projectId = db.createProject(projectInput);
    created = true;
  }
  // Rematch again at execute time against the live folder (AI paths often drift).
  const liveProfiles = listRelativeSpreadsheetFiles(folder).map((file) => ({ file }));
  const rematched = rematchPlanSources(
    { project_name: "", notes: "", tables: tables || [] },
    liveProfiles,
  );
  const createdDatasets = [];
  try {
    const result = await executeImportPlanInner(
      projectId,
      folder,
      rematched.tables,
      onProgress,
      createdDatasets,
      mode || "deterministic",
    );
    return result;
  } catch (err) {
    rollbackDatasets(createdDatasets);
    if (created) {
      try {
        db.deleteProject(projectId);
      } catch {
        /* best effort rollback */
      }
    }
    throw err;
  }
}

async function executeImportPlanInner(projectId, folder, tables, onProgress, createdDatasets, mode) {
  const bindings = {};
  const results = [];
  const skippedSources = [];
  const quarantine = [];

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
    createdDatasets.push(dataset_id);
    const ds = db.listDatasets(projectId, "desc").find((d) => d.id === dataset_id);
    const schema = ds.column_schema;

    let inserted = 0;
    // Cells stored as NULL because they failed their column type. Rows are
    // never dropped here, so there is no row-level invalid count.
    let repaired = 0;
    for (const source of table.sources) {
      let parsed;
      try {
        parsed = await getParsedTable(folder, source);
      } catch (err) {
        skippedSources.push({
          file: source.file,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      onProgress?.(
        `Importing ${source.file}${source.sheet ? ` [${source.sheet}]` : ""} → ${table.display_name}…`,
      );
      const batch = [];
      for (const raw of parsed.rows) {
        const row = {};
        const bad = {};
        for (let i = 0; i < schema.length; i++) {
          const planCol = table.columns[i];
          const sc = schema[i];
          let rawVal;
          if (planCol && planCol.source_header === null) {
            rawVal =
              planCol.name === "source_label"
                ? (source.source_label ?? source.sheet ?? source.file)
                : "";
          } else {
            rawVal = raw[planCol ? planCol.source_header : sc.original_name];
          }
          const res = coerceValue(sc.type, rawVal);
          // A cell that fails its column type is stored as NULL and recorded in
          // the quarantine. Discarding the whole row would throw away every
          // other measurement recorded on the same line.
          if (res.ok) row[sc.name] = res.value;
          else {
            row[sc.name] = null;
            bad[sc.name] = String(rawVal ?? "");
          }
        }
        batch.push(row);
        const badCols = Object.keys(bad);
        if (badCols.length > 0) {
          repaired += badCols.length;
          if (quarantine.length < 500) {
            quarantine.push({
              table: table.key,
              file: source.file,
              sheet: source.sheet,
              columns: badCols,
              values: Object.keys(raw).length ? raw : bad,
            });
          }
        }
      }
      for (let i = 0; i < batch.length; i += 1000) {
        inserted += db.insertDatasetRowsTyped(dataset_id, batch.slice(i, i + 1000));
      }
    }
    bindings[table.key] = dataset_id;
    results.push({
      key: table.key,
      display_name: table.display_name,
      dataset_id,
      inserted,
      invalid: 0,
      repaired,
      columns: schema,
    });
  }

  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  if (results.length > 0 && totalInserted === 0 && skippedSources.length > 0) {
    throw new Error(
      `Import produced no rows. Failed sources: ${skippedSources
        .slice(0, 5)
        .map((s) => `${s.file} (${s.reason})`)
        .join("; ")}`,
    );
  }

  const project = db.getProject(projectId);
  const prevMeta =
    project?.template_meta && typeof project.template_meta === "object"
      ? { ...project.template_meta }
      : {};
  const prevBindings =
    prevMeta.bindings && typeof prevMeta.bindings === "object" ? { ...prevMeta.bindings } : {};
  const aiTemplate = {
    key: "__ai_import__",
    name: project?.project_name ?? "Imported project",
    tagline: mode === "ai" ? "AI-assisted schema" : "Deterministic import",
    description: "Schema from folder import",
    tables: [
      ...((prevMeta.ai_template && prevMeta.ai_template.tables) || []),
      ...tables.map((t) => ({
        key: t.key,
        display_name: t.display_name,
        description: t.description,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk || undefined })),
        fks: t.fks,
        step: t.step,
      })),
    ],
  };
  db.updateProjectTemplateMeta(projectId, {
    ...prevMeta,
    ai_template: aiTemplate,
    bindings: { ...prevBindings, ...bindings },
  });

  const report = {
    mode,
    results,
    skippedSources,
    quarantine,
    totals: {
      tables: results.length,
      inserted: results.reduce((s, r) => s + r.inserted, 0),
      invalid: results.reduce((s, r) => s + r.invalid, 0),
      repaired: results.reduce((s, r) => s + (r.repaired || 0), 0),
      skippedSources: skippedSources.length,
    },
  };
  const importId = db.insertImportHistory({
    projectId,
    folderPath: folder,
    mode,
    report,
  });

  return { projectId, results, skippedSources, quarantine, report, importId };
}

module.exports = {
  scanFolder,
  profileFolder,
  analyzeFolder,
  executeImportPlan,
  buildDeterministicPlan,
  rematchPlanSources,
  resolveSourcePath,
  normalizeRel,
  inferKind,
  coerceValue,
  toSnake,
};
