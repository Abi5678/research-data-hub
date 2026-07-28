"use strict";

// Local SQLite backend. Ports the Supabase/Postgres SECURITY DEFINER RPCs
// (see the old supabase/migrations) to better-sqlite3, minus auth/RLS —
// this is a single-user desktop app.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { prepareProjectSelect } = require("./query-guard.cjs");

let db = null;

const SQLITE_TYPE = {
  integer: "INTEGER",
  "double precision": "REAL",
  boolean: "INTEGER",
  date: "TEXT",
  timestamptz: "TEXT",
  text: "TEXT",
};

function now() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

// Port of public.sanitize_ident()
function sanitizeIdent(s) {
  const cleaned = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned === "" ? "col" : cleaned;
}

function quoteIdent(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      project_code TEXT NOT NULL UNIQUE,
      project_name TEXT NOT NULL,
      sponsor TEXT,
      pi_name TEXT,
      start_date TEXT,
      end_date TEXT,
      description TEXT,
      template_key TEXT,
      template_meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      table_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      source_filename TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      column_schema TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_datasets_project_id ON datasets(project_id);
    CREATE TABLE IF NOT EXISTS saved_queries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '{}',
      sql_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS export_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      query_id TEXT REFERENCES saved_queries(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return dbPath;
}

function parseProject(row) {
  if (!row) return null;
  return {
    ...row,
    template_meta: JSON.parse(row.template_meta || "{}"),
  };
}

function parseDataset(row) {
  return {
    ...row,
    column_schema: JSON.parse(row.column_schema || "[]"),
  };
}

function getDatasetOrThrow(datasetId) {
  const row = db.prepare("SELECT * FROM datasets WHERE id = ?").get(datasetId);
  if (!row) throw new Error("Dataset not found");
  if (!/^[a-z0-9_]+$/.test(row.table_name)) throw new Error("Invalid dataset table");
  return parseDataset(row);
}

// ---------- projects ----------

function listProjects() {
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM datasets d WHERE d.project_id = p.id) AS dataset_count
       FROM projects p ORDER BY p.created_at DESC`,
    )
    .all();
  return rows.map(parseProject);
}

function getProject(id) {
  const row = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM datasets d WHERE d.project_id = p.id) AS dataset_count
       FROM projects p WHERE p.id = ?`,
    )
    .get(id);
  return parseProject(row);
}

function createProject(input) {
  const id = uuid();
  const t = now();
  const exists = db
    .prepare("SELECT 1 FROM projects WHERE project_code = ?")
    .get(input.project_code);
  if (exists) throw new Error(`A project with code "${input.project_code}" already exists`);
  db.prepare(
    `INSERT INTO projects (id, project_code, project_name, sponsor, pi_name, start_date, end_date, description, template_key, template_meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
  ).run(
    id,
    input.project_code,
    input.project_name,
    input.sponsor ?? null,
    input.pi_name ?? null,
    input.start_date ?? null,
    input.end_date ?? null,
    input.description ?? null,
    input.template_key ?? null,
    t,
    t,
  );
  return id;
}

function updateProjectTemplateMeta(id, templateMeta) {
  db.prepare("UPDATE projects SET template_meta = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(templateMeta ?? {}),
    now(),
    id,
  );
}

function deleteProject(id) {
  const datasets = db.prepare("SELECT table_name FROM datasets WHERE project_id = ?").all(id);
  const tx = db.transaction(() => {
    for (const d of datasets) {
      if (/^[a-z0-9_]+$/.test(d.table_name)) {
        db.exec(`DROP TABLE IF EXISTS ${quoteIdent(d.table_name)}`);
      }
    }
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  });
  tx();
}

// ---------- datasets ----------

function listDatasets(projectId, order = "desc") {
  const dir = order === "asc" ? "ASC" : "DESC";
  return db
    .prepare(`SELECT * FROM datasets WHERE project_id = ? ORDER BY created_at ${dir}, id ${dir}`)
    .all(projectId)
    .map(parseDataset);
}

function updateDatasetColumnSchema(datasetId, columnSchema) {
  db.prepare("UPDATE datasets SET column_schema = ? WHERE id = ?").run(
    JSON.stringify(columnSchema ?? []),
    datasetId,
  );
}

// Port of public.create_project_dataset()
function createProjectDataset({ projectId, displayName, sourceFilename, columns }) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("At least one column is required");
  }
  const project = db.prepare("SELECT project_code FROM projects WHERE id = ?").get(projectId);
  if (!project) throw new Error("Project not found");

  let base = `ds_${sanitizeIdent(project.project_code)}_${sanitizeIdent(displayName)}`.slice(0, 55);
  let table = base;
  let n = 0;
  const tableExists = db.prepare("SELECT 1 FROM datasets WHERE table_name = ?");
  while (tableExists.get(table)) {
    n += 1;
    const suffix = `_${n}`;
    table = base.slice(0, 55 - suffix.length) + suffix;
  }

  // Deduplicate sanitized column names, build DDL + clean schema
  const seen = new Set();
  const colDefs = [];
  const cleanCols = [];
  for (const col of columns) {
    let name = sanitizeIdent(col.name);
    if (name === "row_id") name = "row_id_2"; // reserved for the PK
    if (seen.has(name)) {
      let k = 2;
      while (seen.has(`${name}_${k}`)) k += 1;
      name = `${name}_${k}`;
    }
    seen.add(name);
    const type = SQLITE_TYPE[col.type] ? col.type : "text";
    colDefs.push(`${quoteIdent(name)} ${SQLITE_TYPE[type]}`);
    cleanCols.push({ name, original_name: col.name, type });
  }

  const id = uuid();
  const tx = db.transaction(() => {
    db.exec(
      `CREATE TABLE ${quoteIdent(table)} (row_id INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs.join(", ")})`,
    );
    db.prepare(
      `INSERT INTO datasets (id, project_id, table_name, display_name, source_filename, row_count, column_schema, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, projectId, table, displayName, sourceFilename ?? null, JSON.stringify(cleanCols), now());
  });
  tx();
  return { dataset_id: id, table_name: table };
}

// Convert client string values (see coerceRow in src/lib/csv.ts) to SQLite bindings.
function bindValue(type, v) {
  if (v === null || v === undefined || v === "") return null;
  switch (type) {
    case "integer":
      return parseInt(v, 10);
    case "double precision":
      return parseFloat(v);
    case "boolean":
      return v === "true" || v === "1" ? 1 : 0;
    default:
      return String(v);
  }
}

// Port of public.insert_dataset_rows_typed()
function insertDatasetRowsTyped(datasetId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const ds = getDatasetOrThrow(datasetId);
  const cols = ds.column_schema;
  const colList = cols.map((c) => quoteIdent(c.name)).join(", ");
  const placeholders = cols.map(() => "?").join(", ");
  const stmt = db.prepare(
    `INSERT INTO ${quoteIdent(ds.table_name)} (${colList}) VALUES (${placeholders})`,
  );
  const tx = db.transaction((batch) => {
    for (const row of batch) {
      // Rows arrive keyed by the client-side column name, which may not be
      // sanitized yet (schema names are). Fall back to a sanitized-key lookup.
      let norm = null;
      stmt.run(
        cols.map((c) => {
          let v = row[c.name];
          if (v === undefined) {
            if (!norm) {
              norm = {};
              for (const k of Object.keys(row)) norm[sanitizeIdent(k)] = row[k];
            }
            v = norm[c.name];
          }
          return bindValue(c.type, v);
        }),
      );
    }
    db.prepare("UPDATE datasets SET row_count = row_count + ? WHERE id = ?").run(
      batch.length,
      datasetId,
    );
  });
  tx(rows);
  return rows.length;
}

function replaceDatasetRowsTyped(datasetId, rows) {
  const ds = getDatasetOrThrow(datasetId);
  const cols = ds.column_schema;
  const colList = cols.map((c) => quoteIdent(c.name)).join(", ");
  const placeholders = cols.map(() => "?").join(", ");
  const insertStmt = db.prepare(
    `INSERT INTO ${quoteIdent(ds.table_name)} (${colList}) VALUES (${placeholders})`,
  );
  const batch = Array.isArray(rows) ? rows : [];
  const tx = db.transaction(() => {
    db.exec(`DELETE FROM ${quoteIdent(ds.table_name)}`);
    db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(ds.table_name);
    for (const row of batch) {
      let norm = null;
      insertStmt.run(
        cols.map((c) => {
          let v = row[c.name];
          if (v === undefined) {
            if (!norm) {
              norm = {};
              for (const k of Object.keys(row)) norm[sanitizeIdent(k)] = row[k];
            }
            v = norm[c.name];
          }
          return bindValue(c.type, v);
        }),
      );
    }
    db.prepare("UPDATE datasets SET row_count = ? WHERE id = ?").run(batch.length, datasetId);
  });
  tx();
  return batch.length;
}

// Port of public.drop_project_dataset()
function dropProjectDataset(datasetId) {
  const ds = getDatasetOrThrow(datasetId);
  const projectId = ds.project_id;
  const tx = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(ds.table_name)}`);
    db.prepare("DELETE FROM datasets WHERE id = ?").run(datasetId);
  });
  tx();
  const project = getProject(projectId);
  if (project?.template_meta && typeof project.template_meta === "object") {
    const meta = { ...project.template_meta };
    if (meta.bindings && typeof meta.bindings === "object") {
      const bindings = { ...meta.bindings };
      for (const [key, id] of Object.entries(bindings)) {
        if (id === datasetId) delete bindings[key];
      }
      meta.bindings = bindings;
      updateProjectTemplateMeta(projectId, meta);
    }
  }
}

// Port of public.truncate_dataset()
function truncateDataset(datasetId) {
  const ds = getDatasetOrThrow(datasetId);
  const tx = db.transaction(() => {
    db.exec(`DELETE FROM ${quoteIdent(ds.table_name)}`);
    // Reset the AUTOINCREMENT counter (TRUNCATE ... RESTART IDENTITY equivalent)
    db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(ds.table_name);
    db.prepare("UPDATE datasets SET row_count = 0 WHERE id = ?").run(datasetId);
  });
  tx();
}

// Port of public.add_dataset_column()
function addDatasetColumn(datasetId, columnName, columnType) {
  const ds = getDatasetOrThrow(datasetId);
  const clean = sanitizeIdent(columnName);
  const type = SQLITE_TYPE[columnType] ? columnType : "text";
  if (ds.column_schema.some((c) => c.name === clean)) {
    throw new Error(`Column ${clean} already exists`);
  }
  const nextSchema = [
    ...ds.column_schema,
    { name: clean, original_name: columnName, type },
  ];
  const tx = db.transaction(() => {
    db.exec(
      `ALTER TABLE ${quoteIdent(ds.table_name)} ADD COLUMN ${quoteIdent(clean)} ${SQLITE_TYPE[type]}`,
    );
    db.prepare("UPDATE datasets SET column_schema = ? WHERE id = ?").run(
      JSON.stringify(nextSchema),
      datasetId,
    );
  });
  tx();
  return clean;
}

// Port of public.dataset_column_values()
function datasetColumnValues(datasetId, columns, limit = 50000) {
  const ds = getDatasetOrThrow(datasetId);
  const lim = Math.min(Math.max(Number(limit) || 50000, 1), 200000);
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("At least one column is required");
  }
  const valid = new Set(ds.column_schema.map((c) => c.name));
  for (const c of columns) {
    if (!valid.has(c)) throw new Error(`Unknown column: ${c}`);
  }
  const colList = columns.map(quoteIdent).join(", ");
  return db
    .prepare(`SELECT DISTINCT ${colList} FROM ${quoteIdent(ds.table_name)} LIMIT ${lim}`)
    .all();
}

// Port of public.query_dataset()
function queryDataset(datasetId, limit = 5000) {
  const ds = getDatasetOrThrow(datasetId);
  const lim = Math.min(Math.max(Number(limit) || 5000, 1), 50000);
  const colList = ds.column_schema.map((c) => quoteIdent(c.name)).join(", ");
  return db
    .prepare(`SELECT ${colList} FROM ${quoteIdent(ds.table_name)} LIMIT ${lim}`)
    .all();
}

// Port of public.run_project_query() — same guardrails, SQLite execution.
function runProjectQuery(projectId, sql, limit = 500) {
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 5000);

  const allowedTables = db
    .prepare("SELECT table_name FROM datasets WHERE project_id = ?")
    .all(projectId)
    .map((r) => r.table_name);
  const clean = prepareProjectSelect(sql, allowedTables);

  const stmt = db.prepare(`SELECT * FROM (${clean}) LIMIT ${lim}`);
  const rows = stmt.all();
  const columns = stmt.columns().map((c) => c.name);
  return { rows, columns };
}

// ---------- saved queries ----------

function listSavedQueries(projectId) {
  return db
    .prepare(
      "SELECT id, project_id, name, sql_text, created_at FROM saved_queries WHERE project_id = ? ORDER BY created_at DESC",
    )
    .all(projectId);
}

function insertSavedQuery(projectId, name, sqlText) {
  const t = now();
  db.prepare(
    "INSERT INTO saved_queries (id, project_id, name, spec, sql_text, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?, ?)",
  ).run(uuid(), projectId, name, sqlText, t, t);
}

// ---------- settings ----------

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// ---------- export history ----------

function listExportHistory(projectId, limit = 50) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return db
    .prepare(
      `SELECT * FROM export_history WHERE project_id = ? ORDER BY created_at DESC LIMIT ${lim}`,
    )
    .all(projectId);
}

function insertExportHistory({ projectId, filename, rowCount, queryId }) {
  db.prepare(
    "INSERT INTO export_history (id, project_id, query_id, filename, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(uuid(), projectId, queryId ?? null, filename, rowCount, now());
}

module.exports = {
  open,
  getSetting,
  setSetting,
  listProjects,
  getProject,
  createProject,
  updateProjectTemplateMeta,
  deleteProject,
  listDatasets,
  updateDatasetColumnSchema,
  createProjectDataset,
  insertDatasetRowsTyped,
  replaceDatasetRowsTyped,
  dropProjectDataset,
  truncateDataset,
  addDatasetColumn,
  datasetColumnValues,
  queryDataset,
  runProjectQuery,
  listSavedQueries,
  insertSavedQuery,
  listExportHistory,
  insertExportHistory,
};
