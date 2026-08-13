/**
 * End-to-end smoke: import fixture ? query ? browse filter ? dashboard inputs ? backup ? rollback.
 * Run: node scripts/e2e-smoke.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const db = require(path.join(root, "electron/db.cjs"));
const folderImport = require(path.join(root, "electron/folder-import.cjs"));
const llm = require(path.join(root, "electron/llm.cjs"));
const { prepareProjectSelect } = require(path.join(root, "electron/query-guard.cjs"));

const fixture = path.join(root, "fixtures/nhdot-mini");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rdh-e2e-"));
const dbPath = path.join(tmp, "e2e.sqlite3");

const results = [];
function ok(name, detail = "") {
  results.push({ name, pass: true, detail });
  console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
}
function fail(name, err) {
  results.push({ name, pass: false, detail: String(err) });
  console.error(`FAIL  ${name} - ${err}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

try {
  assert(fs.existsSync(fixture), `fixture missing: ${fixture}`);
  db.open(dbPath);
  ok("openDatabase", dbPath);

  // --- A. Deterministic analyze + import ---
  const { plan, profiles, skipped, folder, mode } = await folderImport.analyzeFolder(
    fixture,
    () => {},
    { useAi: false },
  );
  assert(profiles.length >= 2, "expected >=2 spreadsheet profiles");
  assert(skipped.some((s) => /\.pdf$/i.test(s.file)), "PDF should be skipped");
  ok("analyzeFolder (deterministic)", `${plan.tables.length} tables, ${profiles.length} profiles, mode=${mode}`);

  const planForced = {
    ...plan,
    tables: plan.tables.map((t) => {
      if (!/mix/i.test(t.display_name)) return t;
      return {
        ...t,
        columns: t.columns.map((c) =>
          c.name === "air_voids" || c.source_header === "air_voids"
            ? { ...c, type: "double precision" }
            : c,
        ),
      };
    }),
  };

  const code = `E2E-${Date.now()}`;
  const imported = await folderImport.executeImportPlan({
    folder,
    mode: "deterministic",
    projectInput: {
      project_name: "E2E Smoke",
      project_code: code,
      description: "end-to-end smoke",
    },
    tables: planForced.tables,
  });
  assert(imported.projectId, "missing projectId");
  assert(imported.results?.length === planForced.tables.length, "table count mismatch");
  const mix = imported.results.find((r) => /mix/i.test(r.display_name));
  assert(mix, "mix dataset missing");
  assert(mix.inserted === 3, `expected 3 inserted, got ${mix.inserted}`);
  assert(mix.invalid === 1, `expected 1 invalid, got ${mix.invalid}`);
  assert((imported.quarantine?.length ?? 0) >= 1, "quarantine empty");
  ok(
    "executeImportPlan",
    `project=${imported.projectId} mix inserted=${mix.inserted} invalid=${mix.invalid} quarantine=${imported.quarantine.length}`,
  );

  const projectId = imported.projectId;
  const datasets = db.listDatasets(projectId, "asc");
  assert(datasets.length === planForced.tables.length, "dataset count mismatch");
  ok("listDatasets", `${datasets.length} datasets`);

  const history = db.listImportHistory(projectId, 5);
  assert(history.length >= 1, "import history empty");
  assert((history[0].report?.totals?.invalid ?? 0) >= 1, "history missing invalid totals");
  ok("importHistory", `${history.length} entries, invalid=${history[0].report.totals.invalid}`);

  // --- B. Query guard ---
  let threw = false;
  try {
    prepareProjectSelect("DROP TABLE projects", datasets.map((d) => d.table_name));
  } catch {
    threw = true;
  }
  assert(threw, "DDL should be rejected");
  threw = false;
  try {
    prepareProjectSelect("DELETE FROM " + datasets[0].table_name, datasets.map((d) => d.table_name));
  } catch {
    threw = true;
  }
  assert(threw, "DML should be rejected");
  prepareProjectSelect(`SELECT * FROM ${datasets[0].table_name}`, datasets.map((d) => d.table_name));
  ok("queryGuard rejects DDL/DML");

  // --- C. SELECT across imported data ---
  const ds = datasets.find((d) => /mix/i.test(d.display_name)) || datasets[0];
  const schema = ds.column_schema || [];
  const cols = schema.map((c) => c.name).filter((n) => n !== "row_id");
  const selectSql = `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${ds.table_name} LIMIT 50`;
  const { rows } = db.runProjectQuery(projectId, selectSql, 50);
  assert(rows.length === 3, `expected 3 valid mix rows, got ${rows.length}`);
  ok("runProjectQuery SELECT", `${rows.length} rows from ${ds.table_name}`);

  // --- D. Browse-style IN filter (IDs like 6001, 6002) ---
  const idCol =
    cols.find((c) => c === "sample_id") ||
    cols.find((c) => /id/i.test(c));
  assert(idCol, "no id column for browse filter");
  const sampleVals = [...new Set(rows.map((r) => String(r[idCol])).filter(Boolean))].slice(0, 2);
  assert(sampleVals.length >= 1, "no sample id values");
  const inList = sampleVals.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  const browseSql = `SELECT "row_id", ${cols.map((c) => `"${c}"`).join(", ")} FROM ${ds.table_name} WHERE CAST("${idCol}" AS TEXT) IN (${inList}) LIMIT 100`;
  const browsed = db.runProjectQuery(projectId, browseSql, 100);
  assert(browsed.rows.length >= 1, "browse filter returned 0");
  ok("browse-style IN filter", `${browsed.rows.length} rows for ${idCol} in [${sampleVals.join(", ")}]`);

  // --- E. Dashboard KPI / chart inputs from live rows ---
  const numericCols = schema.filter(
    (c) => c.type === "integer" || c.type === "double precision",
  );
  let kpiReady = 0;
  for (const col of numericCols) {
    const nums = browsed.rows
      .map((r) => {
        const v = r[col.name];
        if (typeof v === "number") return v;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      })
      .filter((n) => n !== null);
    if (nums.length) kpiReady += 1;
  }
  assert(kpiReady >= 1, "no numeric columns with values for KPIs");
  ok("dashboard KPI inputs", `${kpiReady}/${numericCols.length} numeric cols have values`);

  const allRows = db.runProjectQuery(projectId, `SELECT * FROM ${ds.table_name} LIMIT 500`, 500).rows;
  ok("dashboard row pool", `${allRows.length} rows available`);

  // Cross-table: all datasets queryable
  for (const d of datasets) {
    const q = db.runProjectQuery(projectId, `SELECT COUNT(*) AS n FROM ${d.table_name}`, 5);
    const n = Number(q.rows[0]?.n ?? 0);
    assert(n >= 0, `count failed for ${d.table_name}`);
  }
  ok("all tables queryable", datasets.map((d) => d.table_name).join(", "));

  // --- F. LLM gates (NHDOT: cloud off by default) ---
  const cloud = llm.cloudNimAllowed();
  const aiAvail = llm.isAiAssistAvailable();
  assert(cloud === false || typeof cloud === "boolean", "cloudNimAllowed not boolean");
  ok("llm gates", `aiAvailable=${aiAvail} cloudNimAllowed=${cloud}`);

  // --- G. Backup ---
  const bak = path.join(tmp, "backup.sqlite3");
  db.backupDatabase(bak);
  assert(fs.existsSync(bak) && fs.statSync(bak).size > 100, "backup missing/empty");
  ok("backupDatabase", `${fs.statSync(bak).size} bytes`);

  // --- H. Failed import rollback on existing project ---
  const beforeCount = db.listDatasets(projectId, "asc").length;
  let rolled = false;
  try {
    await folderImport.executeImportPlan({
      folder: fixture,
      projectId,
      mode: "deterministic",
      tables: [
        {
          key: "broken",
          display_name: "Broken",
          description: "",
          columns: [{ name: "x", type: "integer", source_header: "x" }],
          sources: [{ file: "does-not-exist-anywhere.csv", sheet: null, source_label: null }],
          fks: [],
          step: 1,
        },
      ],
    });
  } catch {
    rolled = true;
  }
  const afterCount = db.listDatasets(projectId, "asc").length;
  assert(rolled, "expected failing import to throw");
  assert(afterCount === beforeCount, `orphan datasets: before=${beforeCount} after=${afterCount}`);
  ok("failed import rollback", `datasets unchanged at ${afterCount}`);

  // --- I. Wiring sanity: preload + main IPC channel names ---
  const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  for (const ch of [
    "import:analyzeFolder",
    "import:executePlan",
    "db:backupDatabase",
    "llm:isAiAssistAvailable",
  ]) {
    assert(preload.includes(ch) || preload.includes(ch.replace(":", "")), `preload missing ${ch}`);
    assert(main.includes(ch), `main missing handler ${ch}`);
  }
  ok("IPC channels registered", "analyzeFolder, executePlan, backup, llm available");

  // UI route wiring
  const projectPage = fs.readFileSync(
    path.join(root, "src/routes/_authenticated/projects.$projectId.tsx"),
    "utf8",
  );
  assert(projectPage.includes("BrowseTab"), "BrowseTab not mounted");
  assert(projectPage.includes("AnalyzeTab"), "AnalyzeTab not mounted");
  assert(projectPage.includes('"browse"') || projectPage.includes("'browse'"), "browse tab missing");
  assert(projectPage.includes('"analyze"') || projectPage.includes("'analyze'"), "analyze tab missing");
  const browse = fs.readFileSync(path.join(root, "src/components/project/browse-tab.tsx"), "utf8");
  assert(browse.includes("DashboardPanel"), "DashboardPanel not wired");
  assert(browse.includes("exportDashboard"), "exportDashboard not wired");
  const analyze = fs.readFileSync(path.join(root, "src/components/project/analyze-tab.tsx"), "utf8");
  assert(analyze.includes("buildAnalyzeSql"), "analyze join SQL missing");
  assert(analyze.includes("insertAnalysisView"), "analyze save missing");
  ok("UI wiring", "Browse + Analyze + Dashboard + exportDashboard present");
} catch (err) {
  fail("fatal", err?.stack || err);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log("\n--- E2E smoke summary ---");
console.log(`passed=${passed} failed=${failed} total=${results.length}`);
process.exit(failed ? 1 : 0);
