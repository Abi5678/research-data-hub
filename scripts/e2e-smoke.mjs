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
  // The unparseable air_voids cell is nulled and quarantined rather than the
  // whole line being rejected, so the other measurements on it survive.
  assert(mix.inserted === 4, `expected 4 inserted, got ${mix.inserted}`);
  assert(mix.invalid === 0, `expected 0 invalid, got ${mix.invalid}`);
  assert(mix.repaired === 1, `expected 1 repaired, got ${mix.repaired}`);
  assert((imported.quarantine?.length ?? 0) >= 1, "quarantine empty");
  ok(
    "executeImportPlan",
    `project=${imported.projectId} mix inserted=${mix.inserted} repaired=${mix.repaired} quarantine=${imported.quarantine.length}`,
  );

  const projectId = imported.projectId;
  const datasets = db.listDatasets(projectId, "asc");
  assert(datasets.length === planForced.tables.length, "dataset count mismatch");
  ok("listDatasets", `${datasets.length} datasets`);

  const history = db.listImportHistory(projectId, 5);
  assert(history.length >= 1, "import history empty");
  assert((history[0].report?.totals?.repaired ?? 0) >= 1, "history missing repaired totals");
  ok("importHistory", `${history.length} entries, repaired=${history[0].report.totals.repaired}`);

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
  assert(rows.length === 4, `expected 4 mix rows, got ${rows.length}`);
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

  // --- I. Combined datasets: one table built from many, live ---
  const mixDs = datasets.find((d) => /mix/i.test(d.display_name));
  const labDs = datasets.find((d) => /lab/i.test(d.display_name));
  const notesDs = datasets.find((d) => /note/i.test(d.display_name));
  assert(mixDs && labDs && notesDs, "fixture datasets missing for combine");

  // Mix samples widened with their lab results. lab_results holds 3 rows across
  // only 2 sample_ids, so this join multiplies rows - the exact shape that
  // silently corrupts a joined table, and the reason for the preflight.
  const joinRecipe = () => ({
    version: 1,
    provenance: true,
    columns: [
      { name: "sample_id", type: "text" },
      { name: "mix_type", type: "text" },
      { name: "test_name", type: "text" },
      { name: "result_value", type: "double precision" },
    ],
    branches: [
      {
        id: "b1",
        label: "Mix samples",
        spine: mixDs.table_name,
        joins: [
          {
            id: "j1",
            table: labDs.table_name,
            leftFrom: "spine",
            leftColumn: "sample_id",
            rightColumn: "sample_id",
            type: "left",
          },
        ],
        map: {
          sample_id: { from: "spine", column: "sample_id" },
          mix_type: { from: "spine", column: "mix_type" },
          test_name: { from: "j1", column: "test_name" },
          result_value: { from: "j1", column: "result_value" },
        },
      },
    ],
  });

  const pre = db.preflightCombine(projectId, joinRecipe());
  const codes = pre.findings.map((f) => f.code);
  assert(pre.ok, `preflight blocked: ${JSON.stringify(pre.findings)}`);
  assert(codes.includes("fan_out"), `fan-out not reported: ${codes.join(", ")}`);
  // 4 mix rows LEFT JOIN a lab table with 2 results for S-001 and 1 for S-002.
  assert(pre.estimatedRows === 5, `expected 5 projected rows, got ${pre.estimatedRows}`);
  const unmatched = pre.findings.find((f) => f.code === "unmatched");
  assert(unmatched, "unmatched rows not reported");
  // S-003 and S-004 have no lab result at all; LEFT keeps them as blanks.
  assert(
    unmatched.detail.unmatched === 2,
    `expected 2 unmatched, got ${unmatched.detail.unmatched}`,
  );
  ok(
    "preflightCombine",
    `${pre.estimatedRows} rows projected, warns: ${codes.join(", ")}`,
  );

  const combined = db.createCombinedDataset({
    projectId,
    displayName: "All mixes with lab results",
    recipe: joinRecipe(),
  });
  const withCombined = db.listDatasets(projectId, "asc");
  const listed = withCombined.find((d) => d.id === combined.dataset_id);
  assert(listed, "combined dataset not listed alongside imported ones");
  assert(listed.recipe, "listed combined dataset carries no recipe");
  assert(listed.read_only === 1, "combined dataset should be read-only");
  assert(!listed.unavailable_reason, `combined view unhealthy: ${listed.unavailable_reason}`);

  // The query guard is table-name based, so a combined view is reachable from
  // Query and Analyze exactly like an imported table.
  prepareProjectSelect(
    `SELECT * FROM ${combined.table_name}`,
    withCombined.map((d) => d.table_name),
  );
  const joined = db.runProjectQuery(projectId, `SELECT * FROM ${combined.table_name}`, 100);
  assert(joined.rows.length === 5, `expected 5 combined rows, got ${joined.rows.length}`);
  const s001 = joined.rows.filter((r) => r.sample_id === "S-001");
  assert(s001.length === 2, `S-001 should fan out to 2 rows, got ${s001.length}`);
  assert(
    new Set(s001.map((r) => r.test_name)).size === 2,
    "the two S-001 rows should carry different lab results",
  );
  const s004 = joined.rows.find((r) => r.sample_id === "S-004");
  assert(s004 && s004.test_name === null, "unmatched spine row should keep a blank lab result");
  assert(s004.source_dataset === "Mix samples", "provenance column missing or wrong");
  ok("createCombinedDataset", `${joined.rows.length} rows through ${combined.table_name}`);

  // Add rows from another dataset: a second branch stacks underneath.
  const stacked = joinRecipe();
  stacked.branches.push({
    id: "b2",
    label: "Notes",
    spine: notesDs.table_name,
    joins: [],
    map: { sample_id: { from: "spine", column: "sample_id" } },
  });
  const stackPre = db.preflightCombine(projectId, stacked, combined.dataset_id);
  assert(stackPre.ok, `stacking blocked: ${JSON.stringify(stackPre.findings)}`);
  const unmapped = stackPre.findings.filter((f) => f.code === "unmapped");
  assert(
    unmapped.some((f) => f.detail.branchId === "b2" && f.detail.columns.includes("mix_type")),
    "the columns Notes cannot fill were not named",
  );
  db.updateCombinedDataset(combined.dataset_id, { recipe: stacked });
  const afterStack = db.runProjectQuery(projectId, `SELECT * FROM ${combined.table_name}`, 100);
  assert(afterStack.rows.length === 6, `expected 6 rows after stacking, got ${afterStack.rows.length}`);
  const noteRow = afterStack.rows.find((r) => r.source_dataset === "Notes");
  assert(noteRow && noteRow.mix_type === null, "stacked row should blank the columns it has no source for");
  ok("updateCombinedDataset (add rows)", `${afterStack.rows.length} rows across 2 branches`);

  // Drop a column: a recipe edit, never a change to the source data.
  const dropped = { ...stacked, columns: stacked.columns.filter((c) => c.name !== "mix_type") };
  db.updateCombinedDataset(combined.dataset_id, { recipe: dropped });
  const afterDrop = db.runProjectQuery(projectId, `SELECT * FROM ${combined.table_name}`, 100);
  assert(!("mix_type" in afterDrop.rows[0]), "dropped column still exposed by the view");
  assert(afterDrop.rows.length === 6, "dropping a column should not change the row count");
  const sourceStill = db.runProjectQuery(
    projectId,
    `SELECT mix_type FROM ${mixDs.table_name} WHERE sample_id = 'S-001'`,
    5,
  );
  assert(sourceStill.rows[0]?.mix_type === "HMA", "dropping a column damaged the source dataset");
  ok("drop a column", "view no longer exposes mix_type; source dataset untouched");

  // A source cannot be deleted out from under a combined dataset.
  const dependents = db.combinedDependents(mixDs.table_name);
  assert(dependents.some((d) => d.id === combined.dataset_id), "dependent not reported");
  let blockedDrop = "";
  try {
    db.dropProjectDataset(mixDs.id);
  } catch (err) {
    blockedDrop = String(err.message || err);
  }
  assert(
    blockedDrop.includes("All mixes with lab results"),
    `dropping a source should name its dependent, got: ${blockedDrop || "no error"}`,
  );
  ok("dependency guard", blockedDrop);

  // A live view carries no stored count, so the number is asked for, not read.
  const liveListed = db.listDatasets(projectId, "asc").find((d) => d.id === combined.dataset_id);
  assert(liveListed.row_count === null, "a combined dataset must not report a stored row count");
  const counted = db.datasetRowCount(combined.dataset_id);
  assert(counted === 6, `expected 6 rows counted on demand, got ${counted}`);
  ok("row count on demand", `list says unknown, count says ${counted}`);

  // The escape hatch: the same rows, in a table that no longer follows them.
  const liveRows = db.runProjectQuery(
    projectId,
    `SELECT sample_id, test_name, result_value, source_dataset FROM ${combined.table_name} ORDER BY sample_id, test_name`,
    50,
  ).rows;
  const frozen = db.freezeCombinedDataset(combined.dataset_id, { displayName: "Frozen mixes" });
  assert(frozen.row_count === 6, `frozen copy should hold 6 rows, got ${frozen.row_count}`);
  const frozenRows = db.runProjectQuery(
    projectId,
    `SELECT sample_id, test_name, result_value, source_dataset FROM ${frozen.table_name} ORDER BY sample_id, test_name`,
    50,
  ).rows;
  assert(
    JSON.stringify(frozenRows) === JSON.stringify(liveRows),
    "the frozen copy does not match the view it was taken from",
  );
  const frozenDs = db.listDatasets(projectId, "asc").find((d) => d.id === frozen.dataset_id);
  assert(frozenDs.recipe == null && frozenDs.read_only === 0, "a frozen copy must be an ordinary table");
  db.dropProjectDataset(frozen.dataset_id);
  ok("freeze to a table", `${frozen.row_count} rows copied, row-for-row identical, then cleaned up`);

  // The combined dataset itself owns nothing but a recipe and a view.
  db.dropProjectDataset(combined.dataset_id);
  const afterRemove = db.listDatasets(projectId, "asc");
  assert(!afterRemove.some((d) => d.id === combined.dataset_id), "combined dataset not removed");
  assert(
    afterRemove.length === datasets.length,
    `sources should survive: expected ${datasets.length}, got ${afterRemove.length}`,
  );
  const mixAfter = db.runProjectQuery(projectId, `SELECT COUNT(*) AS n FROM ${mixDs.table_name}`, 5);
  assert(Number(mixAfter.rows[0].n) === 4, "removing the combination damaged the source");
  ok("remove combination", `${afterRemove.length} datasets left, source still has 4 rows`);

  // --- J. Wiring sanity: preload + main IPC channel names ---
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

  // main.cjs derives db:* channels from db.cjs's exports, but preload's bridge
  // list is hand-written, so a new db method reaches the renderer only if it is
  // added there too. That asymmetry is what silently breaks a new feature.
  for (const m of [
    "previewCombinedSql",
    "preflightCombine",
    "createCombinedDataset",
    "updateCombinedDataset",
    "combinedDependents",
    "freezeCombinedDataset",
    "datasetRowCount",
  ]) {
    assert(typeof db[m] === "function", `db.cjs does not export ${m}`);
    assert(preload.includes(`"${m}"`), `preload DB_METHODS missing ${m}`);
  }
  ok("combine bridge exposed", "7 combine methods exported and bridged");

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
  assert(projectPage.includes("CombineBuilderDialog"), "combine builder not mounted");
  const builder = fs.readFileSync(
    path.join(root, "src/components/project/combine-builder.tsx"),
    "utf8",
  );
  assert(builder.includes("preflightCombine"), "builder does not run the preflight");
  assert(builder.includes("warningsAccepted"), "builder does not gate save on acknowledgement");
  assert(projectPage.includes("freezeCombinedDataset"), "no way to freeze a combination from the UI");
  assert(projectPage.includes("CombinedRowCount"), "combined datasets never offer their row count");
  ok("UI wiring", "Browse + Analyze + Dashboard + Combine builder + freeze/count present");
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
