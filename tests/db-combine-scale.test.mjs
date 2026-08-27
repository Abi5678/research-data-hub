import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("../electron/db.cjs");
const Database = require("better-sqlite3");

// Its own temp dir and database, for the same reason db-combine.test.mjs has
// one: db.open() never closes the previous connection.
let tmpDir;
let tmpDb;
let projectId;
let seasons;
let mixes;

const rows = (ds, values) =>
  db.insertDatasetRowsTyped(
    ds.dataset_id,
    values.map((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]))),
  );

/** A second read-only handle, so the plan is read the way SQLite sees it rather
 *  than through the query guard, which refuses EXPLAIN. */
const onRealDb = (fn) => {
  const ro = new Database(tmpDb, { readonly: true });
  try {
    return fn(ro);
  } finally {
    ro.close();
  }
};

const planFor = (sql) =>
  onRealDb((ro) =>
    ro
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((r) => r.detail)
      .join(" | "),
  );

const indexesOn = (table) =>
  onRealDb((ro) =>
    ro
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all(table),
  );

const find = (name) => db.listDatasets(projectId).find((d) => d.display_name === name);

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rdh-scale-"));
  tmpDb = path.join(tmpDir, "hub.sqlite3");
  db.open(tmpDb);

  projectId = db.createProject({ project_code: "SCALE", project_name: "Scale" });
  seasons = db.createProjectDataset({
    projectId,
    displayName: "iFIT 2022",
    columns: [
      { name: "mix_id", type: "text" },
      { name: "fi", type: "double precision" },
    ],
  });
  mixes = db.createProjectDataset({
    projectId,
    displayName: "Mix designs",
    columns: [
      { name: "mix_id", type: "text" },
      { name: "binder", type: "double precision" },
    ],
  });
  rows(seasons, [
    { mix_id: "A", fi: 1.5 },
    { mix_id: "B", fi: 2.5 },
    { mix_id: "C", fi: 3.5 },
  ]);
  rows(mixes, [
    { mix_id: "A", binder: 5.1 },
    { mix_id: "B", binder: 5.2 },
  ]);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const recipeWith = (keyCompare) => ({
  version: 1,
  provenance: false,
  columns: [
    { name: "mix_id", type: "text" },
    { name: "fi", type: "double precision" },
    { name: "binder", type: "double precision" },
  ],
  branches: [
    {
      id: "b1",
      spine: seasons.table_name,
      joins: [
        {
          id: "j1",
          table: mixes.table_name,
          leftColumn: "mix_id",
          rightColumn: "mix_id",
          keyCompare,
        },
      ],
      map: {
        mix_id: { from: "spine", column: "mix_id" },
        fi: { from: "spine", column: "fi" },
        binder: { from: "j1", column: "binder" },
      },
    },
  ],
});

describe("join keys get indexed", () => {
  it("indexes both sides of the join when the combination is saved", () => {
    expect(indexesOn(mixes.table_name)).toHaveLength(0);

    db.createCombinedDataset({
      projectId,
      displayName: "Native join",
      recipe: recipeWith("native"),
    });

    for (const table of [seasons.table_name, mixes.table_name]) {
      const made = indexesOn(table);
      expect(made).toHaveLength(1);
      expect(made[0].sql).toContain('"mix_id"');
    }
  });

  it("makes the join searchable instead of scanned", () => {
    // The plan is what actually matters: an index nothing uses is not a fix.
    const plan = planFor(
      `SELECT * FROM ${seasons.table_name} AS l
         LEFT JOIN ${mixes.table_name} AS r ON l."mix_id" = r."mix_id"`,
    );
    expect(plan).toMatch(new RegExp(`SEARCH r USING (COVERING )?INDEX idx_${mixes.table_name}`));
  });

  it("indexes the expression, not the column, when the keys are compared as text", () => {
    db.createCombinedDataset({
      projectId,
      displayName: "Text join",
      recipe: recipeWith("text"),
    });

    const textIndex = indexesOn(mixes.table_name).find((i) => i.name.endsWith("_text"));
    expect(textIndex).toBeDefined();
    expect(textIndex.sql).toContain("CAST");

    // Without the expression index this comparison is a full scan of r; that is
    // the whole reason text compare needs its own index rather than reusing the
    // plain one sitting on the same column.
    const plan = planFor(
      `SELECT * FROM ${seasons.table_name} AS l
         LEFT JOIN ${mixes.table_name} AS r
           ON CAST(l."mix_id" AS TEXT) = CAST(r."mix_id" AS TEXT)`,
    );
    expect(plan).toContain(textIndex.name);
    expect(plan).not.toMatch(/SCAN r\b/);
  });

  it("saves a combination over an unindexable source rather than refusing it", () => {
    // An attached source is a temp view and cannot carry an index. That makes
    // the join slower; it must not make the combination unsavable.
    const extPath = path.join(tmpDir, "lab.sqlite3");
    const ext = new Database(extPath);
    ext.exec(`
      CREATE TABLE results (mix_id TEXT, av REAL);
      INSERT INTO results VALUES ('A', 4.1), ('B', 4.4);
    `);
    ext.close();
    db.attachSource(projectId, extPath);
    const attached = find("results");
    expect(attached).toBeDefined();

    const made = db.createCombinedDataset({
      projectId,
      displayName: "Over attached",
      recipe: {
        version: 1,
        columns: [
          { name: "mix_id", type: "text" },
          { name: "av", type: "double precision" },
        ],
        branches: [
          {
            id: "b1",
            spine: seasons.table_name,
            joins: [
              { id: "j1", table: attached.table_name, leftColumn: "mix_id", rightColumn: "mix_id" },
            ],
            map: {
              mix_id: { from: "spine", column: "mix_id" },
              av: { from: "j1", column: "av" },
            },
          },
        ],
      },
    });
    expect(
      db.runProjectQuery(projectId, `SELECT av FROM ${made.table_name} ORDER BY mix_id`, 10).rows,
    ).toHaveLength(3);
    expect(indexesOn(attached.table_name)).toHaveLength(0);
  });
});

describe("counting a live view", () => {
  it("reports an unknown count in the list rather than a stale or zero one", () => {
    expect(find("Native join").row_count).toBeNull();
    expect(find("iFIT 2022").row_count).toBe(3);
  });

  it("counts on demand, and follows its sources", () => {
    const ds = find("Native join");
    expect(db.datasetRowCount(ds.id)).toBe(3);
    expect(db.datasetRowCount(find("iFIT 2022").id)).toBe(3);

    rows(seasons, [{ mix_id: "D", fi: 4.5 }]);
    // No rebuild, no refresh: the count is re-derived from the sources.
    expect(db.datasetRowCount(ds.id)).toBe(4);
  });
});

describe("freezing a combined dataset", () => {
  it("copies the view's rows into an ordinary table of its own", () => {
    const ds = find("Native join");
    const live = db.runProjectQuery(
      projectId,
      `SELECT mix_id, fi, binder FROM ${ds.table_name} ORDER BY mix_id`,
      100,
    ).rows;

    const frozen = db.freezeCombinedDataset(ds.id);
    expect(frozen.row_count).toBe(live.length);

    const copy = db.runProjectQuery(
      projectId,
      `SELECT mix_id, fi, binder FROM ${frozen.table_name} ORDER BY mix_id`,
      100,
    ).rows;
    // Row for row, value for value — including the NULLs the LEFT JOIN made.
    expect(copy).toEqual(live);

    const row = find("Native join (frozen)");
    expect(row.recipe).toBeNull();
    expect(row.read_only).toBe(0);
    expect(row.row_count).toBe(live.length);
  });

  it("stops following its sources, and leaves the combination live", () => {
    const frozen = find("Native join (frozen)");
    const ds = find("Native join");

    rows(seasons, [{ mix_id: "E", fi: 5.5 }]);

    expect(db.datasetRowCount(frozen.id)).toBe(4);
    expect(db.datasetRowCount(ds.id)).toBe(5);
    expect(find("Native join")).toBeDefined();
  });

  it("refuses a dataset that is not combined", () => {
    expect(() => db.freezeCombinedDataset(find("iFIT 2022").id)).toThrow(/not a combined dataset/i);
  });

  it("refuses to freeze a view it cannot read, without leaving a dataset behind", () => {
    // The realistic failure: the file under an attached source is moved away,
    // so the combination built on it no longer resolves. Freezing it would
    // otherwise register an empty dataset and then fail on the copy.
    fs.rmSync(path.join(tmpDir, "lab.sqlite3"));
    db.open(tmpDb);

    const before = db.listDatasets(projectId).length;
    const ds = find("Over attached");
    expect(ds.unavailable_reason).toBeTruthy();

    expect(() => db.freezeCombinedDataset(ds.id)).toThrow(/cannot be read/i);
    expect(db.listDatasets(projectId)).toHaveLength(before);
    expect(find("Over attached (frozen)")).toBeUndefined();
  });
});
