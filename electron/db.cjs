"use strict";

// Local SQLite backend. Ports the Supabase/Postgres SECURITY DEFINER RPCs
// (see the old supabase/migrations) to better-sqlite3, minus auth/RLS —
// this is a single-user desktop app.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { prepareProjectSelect } = require("./query-guard.cjs");
const {
  assertRecipeScope,
  buildBranchFromSql,
  buildCombineSql,
  buildCreateViewSql,
  combinedColumnSchema,
  normalizeRecipe,
  referencedTables,
} = require("./combine-sql.cjs");

let db = null;
let dbFilePath = null;

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
  dbFilePath = dbPath;
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // 64 MB of page cache instead of the 2 MB default. A combined view re-runs
  // its joins on every query, so the pages it walks are read over and over —
  // this is the cheapest thing that helps at millions of rows.
  //
  // Deliberately not temp_store = MEMORY: it would move the temp B-trees that
  // ORDER BY and GROUP BY build into RAM, which is a win until a query over a
  // fifty-million-row view builds one too large to hold, and then it is an
  // out-of-memory crash instead of a slow query. Not synchronous = OFF either;
  // this is research data.
  db.pragma("cache_size = -65536");
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
    CREATE TABLE IF NOT EXISTS attached_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      alias TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attached_project_id ON attached_sources(project_id);
    CREATE TABLE IF NOT EXISTS import_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      folder_path TEXT,
      mode TEXT NOT NULL DEFAULT 'deterministic',
      report TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_import_history_project ON import_history(project_id);
    CREATE TABLE IF NOT EXISTS analysis_views (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_views_project ON analysis_views(project_id);
    CREATE TABLE IF NOT EXISTS scripts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      language TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      entry_filename TEXT NOT NULL,
      origin_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scripts_project ON scripts(project_id);
    CREATE TABLE IF NOT EXISTS script_runs (
      id TEXT PRIMARY KEY,
      script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      run_dir TEXT NOT NULL,
      code_snapshot TEXT NOT NULL,
      inputs TEXT NOT NULL DEFAULT '[]',
      outputs TEXT NOT NULL DEFAULT '[]',
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_script_runs_script ON script_runs(script_id);
  `);
  // Datasets backed by an attached database are query-only.
  const hasReadOnly = db
    .prepare("SELECT 1 FROM pragma_table_info('datasets') WHERE name = 'read_only'")
    .get();
  if (!hasReadOnly) {
    db.exec("ALTER TABLE datasets ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0");
  }
  // Which attached source a read-only dataset came from. Previously this was
  // recovered by matching `att_<alias>_%` against table_name, but aliases are
  // deduped as `foo`, `foo_1`, and 'att_foo_1_t' LIKE 'att_foo_%' is true — so
  // detaching `foo` also deleted `foo_1`'s datasets. Store the id instead.
  const hasSourceId = db
    .prepare("SELECT 1 FROM pragma_table_info('datasets') WHERE name = 'source_id'")
    .get();
  if (!hasSourceId) {
    db.exec("ALTER TABLE datasets ADD COLUMN source_id TEXT");
    backfillDatasetSourceIds();
  }
  // The recipe behind a combined dataset. NULL for every ordinary dataset, so
  // `read_only = 1 AND recipe IS NOT NULL` is what makes one combined. The
  // recipe is the durable artifact; the view itself is rebuilt at every open().
  const hasRecipe = db
    .prepare("SELECT 1 FROM pragma_table_info('datasets') WHERE name = 'recipe'")
    .get();
  if (!hasRecipe) {
    db.exec("ALTER TABLE datasets ADD COLUMN recipe TEXT");
  }
  mountAttachedSources();
  // After the attached sources, whose views a recipe may build on.
  mountCombinedViews();
  return dbPath;
}

// One-time backfill for databases created before datasets.source_id existed.
// Longest alias first, so `att_foo_1_t` is claimed by alias `foo_1` rather than
// by the shorter `foo` whose LIKE pattern also matches it.
function backfillDatasetSourceIds() {
  const sources = db
    .prepare("SELECT id, project_id, alias FROM attached_sources")
    .all()
    .sort((a, b) => b.alias.length - a.alias.length);
  const claim = db.prepare(
    `UPDATE datasets SET source_id = ?
      WHERE project_id = ? AND read_only = 1 AND source_id IS NULL AND table_name LIKE ?`,
  );
  for (const s of sources) {
    claim.run(s.id, s.project_id, `att_${s.alias}_%`);
  }
}

// ---------- attached source databases ----------
//
// A project can point at a curated SQLite file it does not own (a lab database
// built by an ETL pipeline, say). The file is ATTACHed and each of its tables
// is exposed as a TEMP VIEW named att_<alias>_<table>, so the existing SELECT
// guardrails — which only understand plain identifiers — keep working
// unchanged. Nothing here ever writes to the attached file: runProjectQuery
// runs under PRAGMA query_only, which SQLite enforces across all attached
// databases.

const SQLITE_DECLTYPE_TO_KIND = [
  [/int/i, "integer"],
  [/char|clob|text/i, "text"],
  [/real|floa|doub|num|dec/i, "double precision"],
  [/bool/i, "boolean"],
  [/date|time/i, "text"],
];

function declTypeToKind(declType) {
  const t = String(declType || "");
  for (const [re, kind] of SQLITE_DECLTYPE_TO_KIND) {
    if (re.test(t)) return kind;
  }
  return "text";
}

function viewNameFor(alias, tableName) {
  return `att_${alias}_${sanitizeIdent(tableName)}`;
}

// Sources that could not be mounted this session: source id -> reason. Their
// datasets stay listed, so the project still shows what it is missing, but
// flagged — before this a moved or deleted file only logged to the console and
// its tables sat in the UI until a click failed with a raw `no such table`.
const unavailableSources = new Map();

/** Tables and views in an attached database, excluding SQLite internals. */
function attachedTableNames(alias) {
  return db
    .prepare(
      `SELECT name FROM ${quoteIdent(alias)}.sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((r) => r.name);
}

function createViewsForAlias(alias) {
  const created = [];
  for (const table of attachedTableNames(alias)) {
    const view = viewNameFor(alias, table);
    db.exec(
      `CREATE TEMP VIEW IF NOT EXISTS ${quoteIdent(view)} AS SELECT * FROM ${quoteIdent(alias)}.${quoteIdent(table)}`,
    );
    created.push({ table, view });
  }
  return created;
}

/**
 * Re-read a mounted source's tables into `datasets`.
 *
 * row_count and column_schema used to be snapshotted once, at attach time, and
 * never refreshed — but the reason to attach a database instead of importing it
 * is that someone else's pipeline keeps it current. So the counts drifted for
 * good, a table added to the source afterwards got a view but no `datasets` row
 * (invisible and unqueryable), and a table dropped from it left a row pointing
 * at nothing.
 */
function syncAttachedDatasets(source) {
  const existing = new Map(
    db
      .prepare("SELECT id, table_name FROM datasets WHERE source_id = ?")
      .all(source.id)
      .map((d) => [d.table_name, d.id]),
  );
  const live = new Set();
  const t = now();
  const tx = db.transaction(() => {
    for (const table of attachedTableNames(source.alias)) {
      const view = viewNameFor(source.alias, table);
      live.add(view);
      const columns = db
        .prepare("SELECT name, type FROM pragma_table_info(?)")
        .all(view)
        .map((c) => ({ name: c.name, original_name: c.name, type: declTypeToKind(c.type) }));
      const rowCount = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(view)}`).get().c;
      const id = existing.get(view);
      if (id) {
        db.prepare("UPDATE datasets SET row_count = ?, column_schema = ? WHERE id = ?").run(
          rowCount,
          JSON.stringify(columns),
          id,
        );
      } else {
        db.prepare(
          `INSERT INTO datasets (id, project_id, table_name, display_name, source_filename, row_count, column_schema, created_at, read_only, source_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        ).run(
          uuid(),
          source.project_id,
          view,
          table,
          path.basename(source.file_path),
          rowCount,
          JSON.stringify(columns),
          t,
          source.id,
        );
      }
    }
    for (const [view, id] of existing) {
      if (live.has(view)) continue;
      if (/^[a-z0-9_]+$/.test(view)) db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(view)}`);
      db.prepare("DELETE FROM datasets WHERE id = ?").run(id);
    }
  });
  tx();
}

/** ATTACH one recorded source and bring its datasets up to date. */
function mountAttachedSource(row) {
  if (!fs.existsSync(row.file_path)) {
    unavailableSources.set(row.id, `File not found: ${row.file_path}`);
    return false;
  }
  try {
    if (unavailableSources.has(row.id) || !isAliasAttached(row.alias)) {
      db.prepare(`ATTACH DATABASE ? AS ${quoteIdent(row.alias)}`).run(row.file_path);
    }
    createViewsForAlias(row.alias);
    syncAttachedDatasets(row);
    unavailableSources.delete(row.id);
    return true;
  } catch (err) {
    unavailableSources.set(row.id, err.message);
    return false;
  }
}

function isAliasAttached(alias) {
  return db.prepare("SELECT 1 FROM pragma_database_list WHERE name = ?").get(alias) ? true : false;
}

/** Re-ATTACH every recorded source on startup; views are per-connection. */
function mountAttachedSources() {
  let rows;
  try {
    rows = db.prepare("SELECT id, project_id, alias, file_path FROM attached_sources").all();
  } catch {
    return; // table not created yet on a fresh database
  }
  unavailableSources.clear();
  for (const row of rows) {
    if (!mountAttachedSource(row)) {
      console.warn(
        `Attached source unavailable: ${row.file_path} - ${unavailableSources.get(row.id)}`,
      );
    }
  }
}

/**
 * Re-check this project's attached files on demand: pick up new or dropped
 * tables, refresh row counts, and recover a source whose file was missing at
 * startup but is reachable again.
 */
function refreshAttachedSources(projectId) {
  const rows = db
    .prepare("SELECT id, project_id, alias, file_path FROM attached_sources WHERE project_id = ?")
    .all(projectId);
  const unavailable = [];
  let refreshed = 0;
  for (const row of rows) {
    if (mountAttachedSource(row)) refreshed++;
    else unavailable.push({ alias: row.alias, reason: unavailableSources.get(row.id) });
  }
  return { refreshed, unavailable };
}

function attachSource(projectId, filePath) {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) throw new Error("Project not found");
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`No such database file: ${resolved}`);

  const already = db
    .prepare("SELECT 1 FROM attached_sources WHERE project_id = ? AND file_path = ?")
    .get(projectId, resolved);
  if (already) throw new Error("This database is already attached to the project");

  const base = sanitizeIdent(path.basename(resolved, path.extname(resolved))).slice(0, 40);
  let alias = base;
  let n = 0;
  const aliasTaken = db.prepare("SELECT 1 FROM attached_sources WHERE alias = ?");
  while (aliasTaken.get(alias)) {
    n += 1;
    alias = `${base}_${n}`;
  }

  db.prepare(`ATTACH DATABASE ? AS ${quoteIdent(alias)}`).run(resolved);
  let views;
  try {
    views = createViewsForAlias(alias);
    if (views.length === 0) throw new Error("That database has no tables to attach");

    const t = now();
    const id = uuid();
    const tx = db.transaction(() => {
      db.prepare(
        "INSERT INTO attached_sources (id, project_id, alias, file_path, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, projectId, alias, resolved, t);
      // Same path as a later refresh, so the first read of the file and every
      // one after it record datasets identically.
      syncAttachedDatasets({ id, project_id: projectId, alias, file_path: resolved });
    });
    tx();
    unavailableSources.delete(id);
    return { id, alias, file_path: resolved, table_count: views.length };
  } catch (err) {
    for (const { view } of views ?? []) {
      db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(view)}`);
    }
    db.exec(`DETACH DATABASE ${quoteIdent(alias)}`);
    throw err;
  }
}

function listAttachedSources(projectId) {
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM datasets d WHERE d.source_id = s.id) AS table_count
       FROM attached_sources s WHERE s.project_id = ? ORDER BY s.created_at DESC`,
    )
    .all(projectId)
    .map((s) => ({
      ...s,
      available: unavailableSources.has(s.id) ? 0 : 1,
      unavailable_reason: unavailableSources.get(s.id) ?? null,
    }));
}

function detachSource(sourceId) {
  const row = db.prepare("SELECT * FROM attached_sources WHERE id = ?").get(sourceId);
  if (!row) throw new Error("Attached source not found");
  const datasets = db
    .prepare("SELECT id, table_name FROM datasets WHERE source_id = ?")
    .all(sourceId);
  // Detaching would otherwise leave any combined view built on these tables
  // resolving to nothing, and only fail later in front of the user.
  for (const d of datasets) assertNoCombinedDependents(d.table_name);

  const tx = db.transaction(() => {
    for (const d of datasets) {
      if (/^[a-z0-9_]+$/.test(d.table_name)) {
        db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(d.table_name)}`);
      }
      db.prepare("DELETE FROM datasets WHERE id = ?").run(d.id);
    }
    db.prepare("DELETE FROM attached_sources WHERE id = ?").run(sourceId);
  });
  tx();
  unavailableSources.delete(sourceId);
  // A source whose file was missing at startup was never ATTACHed.
  if (isAliasAttached(row.alias)) db.exec(`DETACH DATABASE ${quoteIdent(row.alias)}`);
}

// ---------- combined datasets ----------

// Combined views that could not be rebuilt this session: dataset id -> reason.
// Mirrors unavailableSources: the row stays listed so the project still shows
// what it is missing, but flagged, because querying it cannot work.
const unavailableCombined = new Map();

/** Which of these tables actually have a row_id column. Attached sources
 *  reflect arbitrary external tables and usually don't. */
function tablesWithRowId(tables) {
  const has = db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'row_id'");
  return tables.filter((t) => Boolean(has.get(t)));
}

/** The tables a recipe in this project is allowed to read, excluding itself. */
function allowedTablesFor(projectId, excludeDatasetId = null) {
  return db
    .prepare("SELECT table_name FROM datasets WHERE project_id = ? AND id IS NOT ?")
    .all(projectId, excludeDatasetId)
    .map((r) => r.table_name);
}

/**
 * (Re)create one combined dataset's temp view.
 *
 * Temp, not persistent, and not by preference: a persistent view may not
 * reference an attached database or a temp view, and attached sources are
 * exposed as temp views — so a combined view that includes one has no choice.
 * Having only one kind avoids a recipe silently changing category when a user
 * adds an attached source to it.
 */
function createCombinedView(row) {
  const recipe = JSON.parse(row.recipe);
  // Re-checked here and not only at save: the query guard never resolves a
  // view's body, so a recipe edited directly in the database file would
  // otherwise become a permanent read primitive into any table it names.
  assertRecipeScope(recipe, allowedTablesFor(row.project_id, row.id));
  const sql = buildCreateViewSql(row.table_name, recipe, tablesWithRowId(referencedTables(recipe)));
  db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(row.table_name)}`);
  db.exec(sql);
}

/**
 * Prove a combined view actually resolves.
 *
 * CREATE TEMP VIEW succeeds even when the tables it names do not exist —
 * SQLite resolves a view body lazily — so creation is not a health check. A
 * prepare is enough: it surfaces the error without executing anything.
 */
function probeCombinedView(tableName) {
  db.prepare(`SELECT * FROM ${quoteIdent(tableName)} LIMIT 0`);
}

/** Rebuild every combined view on startup; temp views are per-connection. */
function mountCombinedViews() {
  let rows;
  try {
    rows = db
      .prepare(
        "SELECT id, project_id, table_name, display_name, recipe FROM datasets WHERE recipe IS NOT NULL",
      )
      .all();
  } catch {
    return; // column not added yet on a fresh database
  }
  unavailableCombined.clear();
  // Create them all before probing any: a recipe may build on another combined
  // view, and lazy resolution means creation order does not matter but probe
  // order does.
  const created = [];
  for (const row of rows) {
    try {
      createCombinedView(row);
      created.push(row);
    } catch (err) {
      unavailableCombined.set(row.id, err.message);
    }
  }
  for (const row of created) {
    try {
      probeCombinedView(row.table_name);
    } catch (err) {
      unavailableCombined.set(row.id, err.message);
      // A view that cannot resolve is worse than none: it would surface as a
      // raw SQLite error the first time someone opened Browse.
      db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(row.table_name)}`);
    }
  }
  for (const [id, reason] of unavailableCombined) {
    const row = rows.find((r) => r.id === id);
    console.warn(`Combined dataset unavailable: ${row?.display_name} - ${reason}`);
  }
}

/** Combined datasets whose recipe reads from `tableName`. */
function combinedDependents(tableName) {
  return db
    .prepare("SELECT id, display_name, recipe FROM datasets WHERE recipe IS NOT NULL")
    .all()
    .filter((row) => {
      try {
        return referencedTables(JSON.parse(row.recipe)).includes(tableName);
      } catch {
        return false;
      }
    })
    .map((row) => ({ id: row.id, display_name: row.display_name }));
}

/** Refuse to remove something a combined dataset is built on. Naming the
 *  dependents beats cascading a delete the user did not ask for. */
function assertNoCombinedDependents(tableName) {
  const dependents = combinedDependents(tableName);
  if (dependents.length === 0) return;
  const names = dependents.map((d) => `"${d.display_name}"`).join(", ");
  throw new Error(
    `This dataset is used by combined ${dependents.length === 1 ? "dataset" : "datasets"} ${names}. Remove it there first.`,
  );
}

/** The SQL a recipe would generate, for the builder's preview. */
function previewCombinedSql(projectId, recipe) {
  assertRecipeScope(recipe, allowedTablesFor(projectId));
  return buildCombineSql(recipe, tablesWithRowId(referencedTables(recipe)));
}

// ---------- preflight ----------

// Above this many rows the exact probes stop being worth their wall clock, and
// the report says what it knows instead of what it wishes it knew. An honest
// "this join multiplies rows" beats an exact figure the user waits a minute for.
const PREFLIGHT_EXACT_ROWS = 1000000;

/** column name -> kind, for a real table, an attached view, or a combined one.
 *  pragma_table_info answers for all three, so there is only one path. */
function columnKinds(table) {
  const out = new Map();
  for (const c of db.prepare("SELECT name, type FROM pragma_table_info(?)").all(table)) {
    out.set(c.name, declTypeToKind(c.type));
  }
  return out;
}

function tableExists(table) {
  return db.prepare("SELECT 1 FROM pragma_table_info(?) LIMIT 1").get(table) ? true : false;
}

/**
 * The declared size of a source, used only to decide how much probing to
 * afford — the probes that decide findings read the real table. Null means
 * unknown, which is treated as "too big to probe exactly": a combined source is
 * a view, and COUNT(*) on it re-runs every join underneath, which is precisely
 * the cost this number exists to avoid paying.
 */
function declaredRowCount(table) {
  const row = db.prepare("SELECT row_count, recipe FROM datasets WHERE table_name = ?").get(table);
  if (!row || row.recipe) return null;
  return typeof row.row_count === "number" ? row.row_count : null;
}

/**
 * Refuse a recipe that would make a view define itself, directly or through
 * another combined dataset. SQLite catches the direct case at query time with
 * "view is circularly defined"; it should never get that far, and the indirect
 * case is the one a user can build by accident.
 */
function findCombineCycle(recipe, selfTable) {
  if (!selfTable) return null;
  const recipes = new Map(
    db
      .prepare("SELECT table_name, recipe FROM datasets WHERE recipe IS NOT NULL")
      .all()
      .map((r) => {
        try {
          return [r.table_name, JSON.parse(r.recipe)];
        } catch {
          return [r.table_name, null];
        }
      }),
  );
  const seen = new Set([selfTable]);
  const walk = (rec, trail) => {
    for (const t of referencedTables(rec)) {
      if (t === selfTable) return [...trail, t];
      if (seen.has(t)) continue;
      seen.add(t);
      const nested = recipes.get(t);
      if (!nested) continue;
      const found = walk(nested, [...trail, t]);
      if (found) return found;
    }
    return null;
  };
  return walk(recipe, [selfTable]);
}

/**
 * Everything that can make a combined dataset quietly wrong, checked against
 * the real data before anything is saved.
 *
 * Reports rather than throws, and splits its findings in two: `block` means the
 * recipe cannot be saved (it names something that does not exist, or a join
 * that matches nothing — a wrong key, not a valid empty result); `warn` means it
 * can, once the user has seen it. Fan-out and unmatched rows are sometimes
 * exactly what a researcher wants, so refusing them would be wrong — but they
 * must never be silent, which is what both existing join UIs get wrong today.
 *
 * @param datasetId the combined dataset being edited, excluded from its own
 *   allowed-tables list and used as the cycle root. Null when creating.
 */
function preflightCombine(projectId, recipe, datasetId = null) {
  const findings = [];
  const add = (level, code, message, detail) =>
    findings.push({ level, code, message, ...(detail ? { detail } : {}) });
  const report = (extra = {}) => ({
    ok: !findings.some((f) => f.level === "block"),
    findings,
    columns: [],
    branches: [],
    renames: [],
    estimatedRows: null,
    ...extra,
  });

  try {
    assertRecipeScope(recipe, allowedTablesFor(projectId, datasetId));
  } catch (err) {
    add("block", "scope", err.message);
    return report();
  }

  let r;
  try {
    r = normalizeRecipe(recipe);
  } catch (err) {
    add("block", "recipe", err.message);
    return report();
  }

  const selfTable = datasetId
    ? db.prepare("SELECT table_name FROM datasets WHERE id = ?").get(datasetId)?.table_name
    : null;
  const cycle = findCombineCycle(r, selfTable);
  if (cycle) {
    add("block", "cycle", `This would make the dataset build on itself: ${cycle.join(" → ")}.`);
    return report();
  }

  // Every table exists before any probe runs it — a probe against a missing
  // table throws, and a thrown preflight tells the user nothing about the rest.
  const missing = referencedTables(r).filter((t) => !tableExists(t));
  for (const t of missing) add("block", "missing_table", `Table ${t} no longer exists.`);
  if (missing.length > 0) return report();

  const kinds = new Map(referencedTables(r).map((t) => [t, columnKinds(t)]));
  const label = (table) =>
    db.prepare("SELECT display_name FROM datasets WHERE table_name = ?").get(table)?.display_name ??
    table;

  for (const c of r.columns) {
    if (sanitizeIdent(c.originalName) !== c.name) {
      add(
        "warn",
        "renamed",
        `Column "${c.originalName}" is shown as "${c.name}" — that name was already taken.`,
      );
    }
  }
  const renames = r.columns
    .filter((c) => sanitizeIdent(c.originalName) !== c.name)
    .map((c) => ({ from: c.originalName, to: c.name }));

  const sizes = new Map(referencedTables(r).map((t) => [t, declaredRowCount(t)]));
  // Unknown counts as too big: guessing small and being wrong costs a minute of
  // the user's time, guessing big only costs a less specific report.
  const smallEnough = (...tables) =>
    tables.every((t) => sizes.get(t) !== null && sizes.get(t) <= PREFLIGHT_EXACT_ROWS);

  const branches = [];
  let estimatedRows = 0;
  let exact = true;

  for (const b of r.branches) {
    const tableFor = (from) =>
      from === "spine" ? b.spine : (b.joins.find((j) => j.id === from)?.table ?? b.spine);

    // Missing columns first, for the same reason as missing tables.
    let columnsOk = true;
    for (const [target, src] of Object.entries(b.map)) {
      if (!src) continue;
      const t = tableFor(src.from);
      if (!kinds.get(t)?.has(src.column)) {
        columnsOk = false;
        add(
          "block",
          "missing_column",
          `"${label(b.spine)}" maps ${target} to ${src.column}, which ${label(t)} no longer has.`,
        );
      }
    }

    const unmapped = r.columns.filter((c) => !b.map[c.name]).map((c) => c.name);
    if (unmapped.length > 0) {
      add(
        "warn",
        "unmapped",
        `"${b.label}" has no source for ${unmapped.join(", ")} — those cells will be blank for its rows.`,
        { branchId: b.id, columns: unmapped },
      );
    }

    for (const j of b.joins) {
      const leftTable = tableFor(j.leftFrom);
      const leftKinds = kinds.get(leftTable);
      const rightKinds = kinds.get(j.table);
      if (!leftKinds?.has(j.leftColumn) || !rightKinds?.has(j.rightColumn)) {
        columnsOk = false;
        add(
          "block",
          "missing_key",
          `The join between "${label(leftTable)}" and "${label(j.table)}" uses a column one of them no longer has.`,
        );
        continue;
      }
      preflightJoin({
        branch: b,
        join: j,
        leftTable,
        leftKinds,
        rightKinds,
        affordable: smallEnough(leftTable, j.table),
        add,
        label,
      });
    }

    let branchRows = null;
    if (columnsOk && smallEnough(b.spine, ...b.joins.map((j) => j.table))) {
      branchRows = db.prepare(`SELECT COUNT(*) AS n FROM ${buildBranchFromSql(b)}`).get().n;
      estimatedRows += branchRows;
    } else {
      exact = false;
    }
    branches.push({
      id: b.id,
      label: b.label,
      spine: b.spine,
      spineRows: sizes.get(b.spine),
      rows: branchRows,
      unmapped,
    });
  }

  return report({
    columns: combinedColumnSchema(r, tablesWithRowId(referencedTables(r))),
    branches,
    renames,
    estimatedRows: exact ? estimatedRows : null,
  });
}

/** The three ways one join step goes quietly wrong: it matches nothing, it
 *  multiplies rows, or it drops them. */
function preflightJoin({ branch, join, leftTable, leftKinds, rightKinds, affordable, add, label }) {
  // Aliased, because nothing stops a dataset being joined to itself on two
  // different columns, and `FROM t, t` is a duplicate-name error.
  const L = `${quoteIdent(leftTable)} AS pl`;
  const R = `${quoteIdent(join.table)} AS pr`;
  const left = `pl.${quoteIdent(join.leftColumn)}`;
  const right = `pr.${quoteIdent(join.rightColumn)}`;
  const pair = `"${label(leftTable)}" and "${label(join.table)}"`;

  // Existence only, so it costs one lookup however large the tables are — but
  // only if it is written so SQLite can build an index for it. `FROM L, R
  // WHERE l = r` gets that automatically; a CAST() on both sides of a plain
  // join defeats it, turning "one lookup" into a full L×R nested-loop scan
  // (minutes, not milliseconds, at real dataset sizes). A non-correlated `IN`
  // subquery keeps the same semantics but lets SQLite materialize the right
  // side once — CAST included — before probing it, whichever compare mode is
  // in play. Both compare modes are probed, because a key that matches
  // nothing as-is but matches under a text compare is a fixable setting, not
  // a wrong column.
  const matches = (compare) => {
    const le = compare === "text" ? `CAST(${left} AS TEXT)` : left;
    const re = compare === "text" ? `CAST(${right} AS TEXT)` : right;
    return db
      .prepare(
        `SELECT 1 FROM ${L} WHERE ${left} IS NOT NULL AND ${le} IN
           (SELECT ${re} FROM ${R} WHERE ${right} IS NOT NULL) LIMIT 1`,
      )
      .get();
  };
  if (!matches(join.keyCompare)) {
    const otherCompare = join.keyCompare === "text" ? "native" : "text";
    if (matches(otherCompare)) {
      add(
        "warn",
        "wrong_compare",
        `Nothing in ${pair} matches on ${join.leftColumn} = ${join.rightColumn} the way it is compared now, but ${join.keyCompare === "text" ? "comparing the values as-is" : "comparing them as text"} does match. Switch the comparison.`,
        { branchId: branch.id, joinId: join.id },
      );
    } else {
      add(
        "block",
        "zero_matches",
        `No row of ${pair} matches on ${join.leftColumn} = ${join.rightColumn}. That is a wrong key, not an empty result.`,
        { branchId: branch.id, joinId: join.id },
      );
    }
    return;
  }

  // Native and text compare are lossy in opposite directions — native matches
  // '1', '01' and '1.0' to integer 1; text matches only '1' — so neither is
  // universally right. Rather than pick, show what each one actually matches.
  const leftKind = leftKinds.get(join.leftColumn);
  const rightKind = rightKinds.get(join.rightColumn);
  if (leftKind !== rightKind && affordable) {
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM ${L} WHERE ${left} IN
              (SELECT DISTINCT ${right} FROM ${R} WHERE ${right} IS NOT NULL)) AS native,
           (SELECT COUNT(*) FROM ${L} WHERE CAST(${left} AS TEXT) IN
              (SELECT DISTINCT CAST(${right} AS TEXT) FROM ${R} WHERE ${right} IS NOT NULL)) AS text`,
      )
      .get();
    add(
      "warn",
      "key_type",
      `${join.leftColumn} is ${leftKind} and ${join.rightColumn} is ${rightKind}. Comparing as-is matches ${counts.native} rows; comparing as text matches ${counts.text}. Text compare also stops the join using an index.`,
      { branchId: branch.id, joinId: join.id, native: counts.native, text: counts.text },
    );
  }

  // Does the right side repeat its key? Existence with GROUP BY ... HAVING
  // early-exits on a covering index; COUNT(DISTINCT) would force a temp b-tree
  // over the whole column just to find out whether the answer is "yes".
  const qRight = quoteIdent(join.rightColumn);
  const fansOut = db
    .prepare(
      `SELECT 1 FROM ${quoteIdent(join.table)} WHERE ${qRight} IS NOT NULL
       GROUP BY ${qRight} HAVING COUNT(*) > 1 LIMIT 1`,
    )
    .get();
  if (fansOut) {
    let detail = "";
    if (affordable) {
      const m = db
        .prepare(
          `SELECT COUNT(*) AS n, COUNT(DISTINCT ${qRight}) AS d
           FROM ${quoteIdent(join.table)} WHERE ${qRight} IS NOT NULL`,
        )
        .get();
      detail = ` It averages ${(m.n / m.d).toFixed(1)} rows per ${join.rightColumn}.`;
    }
    add(
      "warn",
      "fan_out",
      `"${label(join.table)}" has more than one row per ${join.rightColumn}, so this join multiplies rows rather than adding columns.${detail}`,
      { branchId: branch.id, joinId: join.id },
    );
  }

  // A LEFT join keeps unmatched rows as blanks and an INNER join deletes them;
  // either way the count is the thing the user has to see before saving.
  if (affordable) {
    const le = join.keyCompare === "text" ? `CAST(${left} AS TEXT)` : left;
    const re = join.keyCompare === "text" ? `CAST(${right} AS TEXT)` : right;
    const unmatched = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${L}
         WHERE ${left} IS NOT NULL AND ${le} NOT IN
           (SELECT ${re} FROM ${R} WHERE ${right} IS NOT NULL)`,
      )
      .get().n;
    if (unmatched > 0) {
      add(
        "warn",
        "unmatched",
        join.type === "inner"
          ? `${unmatched} rows of "${label(leftTable)}" match nothing in "${label(join.table)}" and this join drops them. A left join would keep them with blanks.`
          : `${unmatched} rows of "${label(leftTable)}" match nothing in "${label(join.table)}"; they are kept, with those columns blank.`,
        { branchId: branch.id, joinId: join.id, unmatched },
      );
    }
  }
}

/** Blocking findings are enforced here, not only in the builder: a check the
 *  renderer could skip is a suggestion, and the user asked for accuracy. */
function assertPreflightPasses(projectId, recipe, datasetId) {
  const check = preflightCombine(projectId, recipe, datasetId);
  if (check.ok) return;
  throw new Error(
    check.findings
      .filter((f) => f.level === "block")
      .map((f) => f.message)
      .join(" "),
  );
}

/** Only a real table in main can be indexed. Combined and attached sources are
 *  both temp views, which live in temp.sqlite_master and cannot carry one. */
function isIndexableTable(name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

/**
 * Index every join key a recipe uses.
 *
 * A live view re-runs its joins on every query, so an unindexed key means a
 * full scan of the joined table per spine row. The app creates no indexes
 * anywhere else, which is affordable at ten thousand rows and is not at ten
 * million. A `text` key compare needs an *expression* index on the same CAST
 * the join emits, because `CAST(a AS TEXT) = ?` cannot use a plain index on a.
 *
 * Best effort by design: an index that cannot be created must never stop a
 * combined dataset from being saved. The result is slower, not wrong.
 */
function ensureJoinIndexes(recipe) {
  const r = normalizeRecipe(recipe);
  const made = [];
  for (const branch of r.branches) {
    // leftFrom names the spine or an earlier join; both resolve to a table.
    const tableOf = new Map([["spine", branch.spine]]);
    for (const join of branch.joins) {
      const keys = [
        { table: tableOf.get(join.leftFrom) ?? branch.spine, column: join.leftColumn },
        { table: join.table, column: join.rightColumn },
      ];
      tableOf.set(join.id, join.table);
      for (const { table, column } of keys) {
        if (!table || !column || !isIndexableTable(table)) continue;
        const asText = join.keyCompare === "text";
        const name = `idx_${sanitizeIdent(table)}_${sanitizeIdent(column)}${asText ? "_text" : ""}`.slice(
          0,
          60,
        );
        const target = asText ? `CAST(${quoteIdent(column)} AS TEXT)` : quoteIdent(column);
        try {
          db.exec(
            `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(table)} (${target})`,
          );
          made.push(name);
        } catch {
          // A dropped column, a renamed table, a read-only file: none of these
          // make the combination wrong, so none of them may block the save.
        }
      }
    }
  }
  return made;
}

function createCombinedDataset({ projectId, displayName, recipe }) {
  const project = db.prepare("SELECT project_code FROM projects WHERE id = ?").get(projectId);
  if (!project) throw new Error("Project not found");
  assertPreflightPasses(projectId, recipe, null);

  const base = `cb_${sanitizeIdent(project.project_code)}_${sanitizeIdent(displayName)}`.slice(
    0,
    55,
  );
  let table = base;
  let n = 0;
  const tableExists = db.prepare("SELECT 1 FROM datasets WHERE table_name = ?");
  while (tableExists.get(table)) {
    n += 1;
    const suffix = `_${n}`;
    table = base.slice(0, 55 - suffix.length) + suffix;
  }

  const withRowId = tablesWithRowId(referencedTables(recipe));
  const columns = combinedColumnSchema(recipe, withRowId);
  const id = uuid();
  const tx = db.transaction(() => {
    db.exec(buildCreateViewSql(table, recipe, withRowId));
    // Inside the transaction, so a recipe that does not resolve never persists.
    probeCombinedView(table);
    db.prepare(
      `INSERT INTO datasets (id, project_id, table_name, display_name, source_filename, row_count, column_schema, created_at, read_only, recipe)
       VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 1, ?)`,
    ).run(
      id,
      projectId,
      table,
      displayName,
      JSON.stringify(columns),
      now(),
      JSON.stringify(recipe),
    );
  });
  tx();
  // After the commit, never inside it: indexing a large table is slow, and a
  // slow index has no business rolling back a combination that already saved.
  ensureJoinIndexes(recipe);
  unavailableCombined.delete(id);
  return { dataset_id: id, table_name: table };
}

/**
 * Edit a combined dataset in place: adding or dropping a column, or changing
 * what it joins, is a recipe change plus a view rebuild. No source data is
 * read, written, or copied, so it costs the same at fifty million rows.
 */
function updateCombinedDataset(datasetId, { displayName, recipe }) {
  const ds = getDatasetOrThrow(datasetId);
  if (!ds.recipe) throw new Error("This dataset is not a combined dataset");
  const next = recipe ?? ds.recipe;
  assertPreflightPasses(ds.project_id, next, datasetId);

  const withRowId = tablesWithRowId(referencedTables(next));
  const columns = combinedColumnSchema(next, withRowId);
  const tx = db.transaction(() => {
    db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(ds.table_name)}`);
    db.exec(buildCreateViewSql(ds.table_name, next, withRowId));
    probeCombinedView(ds.table_name);
    db.prepare(
      "UPDATE datasets SET display_name = ?, column_schema = ?, recipe = ? WHERE id = ?",
    ).run(displayName ?? ds.display_name, JSON.stringify(columns), JSON.stringify(next), datasetId);
  });
  tx();
  ensureJoinIndexes(next);
  unavailableCombined.delete(datasetId);
  return { dataset_id: datasetId, table_name: ds.table_name };
}

/**
 * Copy what a combined view currently returns into an ordinary table.
 *
 * The escape hatch for when live stops paying. A live view re-runs every join
 * on every query, which is right until the joins are expensive enough that
 * opening Browse is a wait. Freezing buys that back by giving up freshness:
 * the copy is a snapshot and does not follow its sources afterwards, which is
 * why it is a deliberate action producing a separate dataset, and why the
 * original combination is left in place rather than replaced.
 */
function freezeCombinedDataset(datasetId, { displayName } = {}) {
  const ds = getDatasetOrThrow(datasetId);
  if (!ds.recipe) throw new Error("This dataset is not a combined dataset");
  const broken = unavailableCombined.get(datasetId);
  if (broken) throw new Error(`"${ds.display_name}" cannot be read right now: ${broken}`);

  // The view's row_id is synthesised from its branches and means nothing
  // outside it; the frozen table gets a real one of its own.
  const columns = (ds.column_schema ?? []).filter((c) => c.name !== "row_id");
  if (columns.length === 0) throw new Error("This combined dataset has no columns to freeze");

  const frozen = createProjectDataset({
    projectId: ds.project_id,
    displayName: displayName || `${ds.display_name} (frozen)`,
    sourceFilename: null,
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
  });

  // Paired through original_name rather than by position: createProjectDataset
  // sanitises and de-duplicates the names it is given, so the column it made is
  // not always the column that was asked for.
  const schema = getDatasetOrThrow(frozen.dataset_id).column_schema;
  const target = schema.map((c) => quoteIdent(c.name)).join(", ");
  const source = schema.map((c) => quoteIdent(c.original_name)).join(", ");

  let count = 0;
  const tx = db.transaction(() => {
    // Copied inside SQLite rather than through JavaScript: at these sizes the
    // round trip is the cost, and the values land under the destination
    // column's own affinity instead of being re-parsed out of strings.
    db.exec(
      `INSERT INTO ${quoteIdent(frozen.table_name)} (${target}) SELECT ${source} FROM ${quoteIdent(ds.table_name)}`,
    );
    count = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(frozen.table_name)}`).get().n;
    db.prepare("UPDATE datasets SET row_count = ? WHERE id = ?").run(count, frozen.dataset_id);
  });
  try {
    tx();
  } catch (err) {
    // A half-copied table is worse than none: the insert rolled back, but the
    // empty dataset the copy was going into is still registered.
    try {
      dropProjectDataset(frozen.dataset_id);
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err;
  }
  return { dataset_id: frozen.dataset_id, table_name: frozen.table_name, row_count: count };
}

function parseProject(row) {
  if (!row) return null;
  return {
    ...row,
    template_meta: JSON.parse(row.template_meta || "{}"),
  };
}

function parseDataset(row) {
  const recipe = row.recipe ? JSON.parse(row.recipe) : null;
  return {
    ...row,
    column_schema: JSON.parse(row.column_schema || "[]"),
    // Non-null only for a combined dataset, and the builder edits it directly.
    recipe,
    // Unknown, not zero. A combined view stores no count because counting it
    // re-runs every join underneath, which is the cost the live design exists
    // to avoid paying on every list. Null forces the caller to either say so
    // or ask for it; a stored number would be a lie the moment a source grew.
    row_count: recipe ? null : row.row_count,
  };
}

/**
 * The row count of one dataset, counted now for a combined view.
 *
 * Separate from listDatasets on purpose: this is the expensive one, paid once
 * by the screen that actually shows a number rather than by every screen that
 * lists a name.
 */
function datasetRowCount(datasetId) {
  const ds = getDatasetOrThrow(datasetId);
  if (!ds.recipe) return ds.row_count ?? 0;
  const broken = unavailableCombined.get(datasetId);
  if (broken) return null;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(ds.table_name)}`).get().n;
}

function getDatasetOrThrow(datasetId) {
  const row = db.prepare("SELECT * FROM datasets WHERE id = ?").get(datasetId);
  if (!row) throw new Error("Dataset not found");
  if (!/^[a-z0-9_]+$/.test(row.table_name)) throw new Error("Invalid dataset table");
  return parseDataset(row);
}

/** Datasets backed by an attached database are read-only; detach to remove.
 *  Combined datasets are read-only too, but for a different reason and with a
 *  different remedy, so they must not borrow the attached-database wording. */
function getWritableDatasetOrThrow(datasetId) {
  const ds = getDatasetOrThrow(datasetId);
  if (ds.recipe) {
    throw new Error(
      `"${ds.display_name}" is a combined dataset built from other datasets. Edit how it is built, or change the datasets it draws from.`,
    );
  }
  if (ds.read_only) {
    throw new Error(
      `Dataset "${ds.display_name}" comes from an attached database and cannot be modified here`,
    );
  }
  return ds;
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
  // Detach first: those datasets are views over a file the project doesn't own,
  // and the source file itself must survive deleting the project.
  for (const s of db.prepare("SELECT id FROM attached_sources WHERE project_id = ?").all(id)) {
    detachSource(s.id);
  }
  const datasets = db
    .prepare("SELECT table_name FROM datasets WHERE project_id = ? AND read_only = 0")
    .all(id);
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
    .map((row) => {
      const ds = parseDataset(row);
      // Still listed, so the project shows what it is missing rather than
      // quietly shrinking — but flagged, because querying it cannot work.
      ds.unavailable_reason =
        (ds.source_id ? unavailableSources.get(ds.source_id) : null) ??
        unavailableCombined.get(ds.id) ??
        null;
      return ds;
    });
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
  const ds = getWritableDatasetOrThrow(datasetId);
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
  const ds = getWritableDatasetOrThrow(datasetId);
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
  // A combined dataset owns nothing but its recipe and a temp view, so it is
  // removable even though it is read-only — unlike an attached dataset, which
  // getWritableDatasetOrThrow still sends to detachSource.
  const combined = getDatasetOrThrow(datasetId);
  const isCombined = Boolean(combined.recipe);
  const ds = isCombined ? combined : getWritableDatasetOrThrow(datasetId);
  assertNoCombinedDependents(ds.table_name);
  const projectId = ds.project_id;
  const tx = db.transaction(() => {
    if (isCombined) {
      db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(ds.table_name)}`);
    } else {
      db.exec(`DROP TABLE IF EXISTS ${quoteIdent(ds.table_name)}`);
    }
    db.prepare("DELETE FROM datasets WHERE id = ?").run(datasetId);
  });
  tx();
  unavailableCombined.delete(datasetId);
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
  const ds = getWritableDatasetOrThrow(datasetId);
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
  const ds = getWritableDatasetOrThrow(datasetId);
  let clean = sanitizeIdent(columnName);
  // Same rename createProjectDataset applies: row_id is the table's own PK, so
  // adding a column called "Row ID" here used to surface SQLite's raw
  // "duplicate column name" instead of just working.
  if (clean === "row_id") clean = "row_id_2";
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

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Write a whole dataset to a CSV file for a script to read.
 *
 * Deliberately uncapped, unlike every other read path here. The 200k row cap on
 * queries exists because those rows go into memory and then into a browser; this
 * goes row by row into a file, so the cap would buy nothing and cost the thing
 * that matters — a script silently analysing the first 200,000 rows of a
 * 2,000,000-row dataset produces a wrong answer that looks entirely right.
 *
 * Works on a combined dataset unchanged: it is an ordinary datasets row whose
 * table is a view, and iterate() walks a view the same as a table.
 */
function writeDatasetCsv(datasetId, filePath) {
  const ds = getDatasetOrThrow(datasetId);
  const cols = ds.column_schema.map((c) => c.name);
  if (cols.length === 0) throw new Error(`Dataset "${ds.display_name}" has no columns`);
  const colList = cols.map(quoteIdent).join(", ");

  const fd = fs.openSync(filePath, "w");
  let rowCount = 0;
  try {
    // Batched into one write per few thousand rows: a write syscall per row
    // dominates the runtime at millions of rows.
    let buf = cols.map(csvCell).join(",") + "\n";
    const stmt = db.prepare(`SELECT ${colList} FROM ${quoteIdent(ds.table_name)}`);
    for (const row of stmt.iterate()) {
      buf += cols.map((c) => csvCell(row[c])).join(",") + "\n";
      rowCount += 1;
      if (buf.length > 1 << 20) {
        fs.writeSync(fd, buf);
        buf = "";
      }
    }
    if (buf.length > 0) fs.writeSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  return { path: filePath, row_count: rowCount, columns: cols };
}

// Upper bound on rows a single query may return. High enough that exports of
// a full dataset are not silently clipped; low enough to stay in memory.
const MAX_QUERY_ROWS = 200000;

// Port of public.run_project_query() — same guardrails, SQLite execution.
function runProjectQuery(projectId, sql, limit = 500) {
  const lim = Math.min(Math.max(Number(limit) || 500, 1), MAX_QUERY_ROWS);

  const allowedTables = db
    .prepare("SELECT table_name FROM datasets WHERE project_id = ?")
    .all(projectId)
    .map((r) => r.table_name);
  const clean = prepareProjectSelect(sql, allowedTables);

  // Defence in depth behind the SELECT guard: query_only makes SQLite reject
  // any write for the duration, including writes to attached source databases.
  db.pragma("query_only = ON");
  try {
    // Fetch one past the limit so callers can tell a full result from a
    // clipped one — an export that silently stops at the cap looks complete.
    const stmt = db.prepare(`SELECT * FROM (${clean}) LIMIT ${lim + 1}`);
    const rows = stmt.all();
    const columns = stmt.columns().map((c) => c.name);
    const truncated = rows.length > lim;
    if (truncated) rows.length = lim;
    return { rows, columns, truncated };
  } finally {
    db.pragma("query_only = OFF");
  }
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

// ---------- analysis views ----------

function listAnalysisViews(projectId) {
  return db
    .prepare(
      "SELECT id, project_id, name, spec, created_at, updated_at FROM analysis_views WHERE project_id = ? ORDER BY updated_at DESC",
    )
    .all(projectId)
    .map((row) => ({
      ...row,
      spec: JSON.parse(row.spec || "{}"),
    }));
}

function insertAnalysisView(projectId, name, spec) {
  const t = now();
  const id = uuid();
  db.prepare(
    "INSERT INTO analysis_views (id, project_id, name, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, projectId, String(name || "").trim(), JSON.stringify(spec ?? {}), t, t);
  return { id };
}

function deleteAnalysisView(projectId, id) {
  db.prepare("DELETE FROM analysis_views WHERE id = ? AND project_id = ?").run(id, projectId);
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

// ---------- import history ----------

function listImportHistory(projectId, limit = 50) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return db
    .prepare(
      `SELECT * FROM import_history WHERE project_id = ? ORDER BY created_at DESC LIMIT ${lim}`,
    )
    .all(projectId)
    .map((row) => ({
      ...row,
      report: JSON.parse(row.report || "{}"),
    }));
}

function insertImportHistory({ projectId, folderPath, mode, report }) {
  const id = uuid();
  db.prepare(
    "INSERT INTO import_history (id, project_id, folder_path, mode, report, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, projectId, folderPath ?? null, mode || "deterministic", JSON.stringify(report ?? {}), now());
  return id;
}

// ---------- backup / restore ----------

// ---------- scripts ----------

const SCRIPT_LANGUAGES = { python: ".py", matlab: ".m" };

function assertLanguage(language) {
  if (!Object.hasOwn(SCRIPT_LANGUAGES, language)) {
    throw new Error(`Unsupported script language: ${language}`);
  }
  return language;
}

/** A filename the runner can safely write into a run folder and hand to an
 *  interpreter. MATLAB is the strict one: `-batch` takes a function name, so
 *  the stem must be a valid identifier — a leading digit or a hyphen makes a
 *  script that exists but cannot be invoked. */
function scriptEntryFilename(name, language) {
  const ext = SCRIPT_LANGUAGES[assertLanguage(language)];
  let stem = sanitizeIdent(String(name ?? "").replace(/\.(py|m)$/i, ""));
  if (/^[0-9]/.test(stem)) stem = `s_${stem}`;
  return `${stem.slice(0, 48) || "analysis"}${ext}`;
}

function listScripts(projectId) {
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM script_runs r WHERE r.script_id = s.id) AS run_count
       FROM scripts s WHERE s.project_id = ? ORDER BY s.updated_at DESC`,
    )
    .all(projectId);
}

function getScript(scriptId) {
  const row = db.prepare("SELECT * FROM scripts WHERE id = ?").get(scriptId);
  if (!row) throw new Error("Script not found");
  return row;
}

function createScript({ projectId, name, language, code, originPath }) {
  assertLanguage(language);
  const t = now();
  const id = uuid();
  const displayName = String(name || "").trim() || "Untitled script";
  db.prepare(
    `INSERT INTO scripts (id, project_id, name, language, code, entry_filename, origin_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    displayName,
    language,
    String(code ?? ""),
    scriptEntryFilename(displayName, language),
    originPath ?? null,
    t,
    t,
  );
  return getScript(id);
}

/** Renaming rewrites entry_filename, so a MATLAB script's file keeps matching
 *  the name shown in the UI — the name is what `-batch` invokes. */
function updateScript(scriptId, { name, code }) {
  const s = getScript(scriptId);
  const nextName = name === undefined ? s.name : String(name).trim() || s.name;
  db.prepare(
    "UPDATE scripts SET name = ?, code = ?, entry_filename = ?, updated_at = ? WHERE id = ?",
  ).run(
    nextName,
    code === undefined ? s.code : String(code),
    scriptEntryFilename(nextName, s.language),
    now(),
    scriptId,
  );
  return getScript(scriptId);
}

function deleteScript(scriptId) {
  const s = getScript(scriptId);
  // Run rows cascade; the run folders on disk are the runner's to remove.
  const dirs = db
    .prepare("SELECT run_dir FROM script_runs WHERE script_id = ?")
    .all(scriptId)
    .map((r) => r.run_dir);
  db.prepare("DELETE FROM scripts WHERE id = ?").run(scriptId);
  return { deleted: s.name, run_dirs: dirs };
}

function parseRun(row) {
  if (!row) return null;
  return {
    ...row,
    inputs: JSON.parse(row.inputs || "[]"),
    outputs: JSON.parse(row.outputs || "[]"),
  };
}

function listScriptRuns(scriptId, limit = 25) {
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 200);
  return db
    .prepare(`SELECT * FROM script_runs WHERE script_id = ? ORDER BY started_at DESC LIMIT ${lim}`)
    .all(scriptId)
    .map(parseRun);
}

function getScriptRun(runId) {
  const row = db.prepare("SELECT * FROM script_runs WHERE id = ?").get(runId);
  if (!row) throw new Error("Run not found");
  return parseRun(row);
}

/** Recorded before the process starts, so a run that crashes the app still
 *  leaves a row saying what was attempted and where its folder is. */
function createScriptRun({ runId, scriptId, runDir, codeSnapshot, inputs }) {
  db.prepare(
    `INSERT INTO script_runs (id, script_id, started_at, status, run_dir, code_snapshot, inputs)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`,
  ).run(runId, scriptId, now(), runDir, String(codeSnapshot ?? ""), JSON.stringify(inputs ?? []));
  return getScriptRun(runId);
}

function finishScriptRun(runId, { status, exitCode, stdout, stderr, outputs }) {
  db.prepare(
    `UPDATE script_runs SET finished_at = ?, status = ?, exit_code = ?, stdout = ?, stderr = ?, outputs = ?
     WHERE id = ?`,
  ).run(
    now(),
    status,
    exitCode ?? null,
    String(stdout ?? ""),
    String(stderr ?? ""),
    JSON.stringify(outputs ?? []),
    runId,
  );
  return getScriptRun(runId);
}

function getDatabasePath() {
  return dbFilePath;
}

function backupDatabase(destPath) {
  if (!db || !dbFilePath) throw new Error("Database not open");
  if (!destPath) throw new Error("Backup destination required");
  // better-sqlite3 backup() returns a Backup object that must be stepped/run.
  // Use VACUUM INTO for a simple consistent snapshot (SQLite ≥ 3.27).
  db.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
  return destPath;
}

/**
 * Everything worth knowing about the chosen file, checked before a single byte
 * moves. Restore used to copy whatever was picked straight over the live
 * database: point it at the wrong file and the working data was simply gone.
 */
function assertRestorable(srcPath) {
  let probe = null;
  let integrity;
  let tables;
  // A non-database file only fails once it is read, not when it is opened, so
  // the read is inside the same try as the open.
  try {
    probe = new Database(srcPath, { readonly: true, fileMustExist: true });
    integrity = probe.pragma("integrity_check", { simple: true });
    tables = new Set(
      probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    );
  } catch (err) {
    throw new Error(`That file is not a readable SQLite database: ${err.message}`);
  } finally {
    try {
      if (probe) probe.close();
    } catch {
      /* ignore */
    }
  }
  if (integrity !== "ok") throw new Error(`That backup is damaged (${integrity})`);
  for (const required of ["projects", "datasets"]) {
    if (!tables.has(required)) {
      throw new Error(`That file is not a Research Data Hub backup (no "${required}" table)`);
    }
  }
}

function restoreDatabase(srcPath) {
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error("Backup file not found");
  if (!dbFilePath) throw new Error("Database path unknown");
  const target = dbFilePath;
  if (path.resolve(srcPath) === path.resolve(target)) {
    throw new Error("That file is the database currently in use");
  }
  assertRestorable(srcPath);

  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = null;

  // Keep what is being replaced. Closing first checkpoints the WAL, so the
  // file on disk is now a complete copy of the database being retired.
  let previous = null;
  if (fs.existsSync(target)) {
    previous = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(target, previous);
  }

  try {
    fs.copyFileSync(srcPath, target);
  } catch (err) {
    if (previous) fs.copyFileSync(previous, target);
    open(target);
    throw err;
  }
  // Also remove WAL/SHM so restore is clean
  for (const suffix of ["-wal", "-shm"]) {
    const p = target + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  open(target);
  return { restored: target, previous };
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
  listAnalysisViews,
  insertAnalysisView,
  deleteAnalysisView,
  listExportHistory,
  insertExportHistory,
  listImportHistory,
  insertImportHistory,
  attachSource,
  refreshAttachedSources,
  listAttachedSources,
  detachSource,
  previewCombinedSql,
  preflightCombine,
  createCombinedDataset,
  updateCombinedDataset,
  combinedDependents,
  freezeCombinedDataset,
  datasetRowCount,
  writeDatasetCsv,
  listScripts,
  getScript,
  createScript,
  updateScript,
  deleteScript,
  listScriptRuns,
  getScriptRun,
  createScriptRun,
  finishScriptRun,
  scriptEntryFilename,
  getDatabasePath,
  backupDatabase,
  restoreDatabase,
};
