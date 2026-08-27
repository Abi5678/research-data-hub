import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("../electron/db.cjs");

// Its own temp dir and database: db.open() never closes the previous
// connection, so sharing one with another test file causes lock contention.
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

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rdh-combine-"));
  tmpDb = path.join(tmpDir, "hub.sqlite3");
  db.open(tmpDb);

  projectId = db.createProject({ project_code: "NRRA", project_name: "Field Mix" });
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

const joinRecipe = () => ({
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
        { id: "j1", table: mixes.table_name, leftColumn: "mix_id", rightColumn: "mix_id" },
      ],
      map: {
        mix_id: { from: "spine", column: "mix_id" },
        fi: { from: "spine", column: "fi" },
        binder: { from: "j1", column: "binder" },
      },
    },
  ],
});

const find = (name) => db.listDatasets(projectId).find((d) => d.display_name === name);

describe("creating a combined dataset", () => {
  it("registers as an ordinary dataset and is queryable through the query guard", () => {
    const made = db.createCombinedDataset({
      projectId,
      displayName: "All mixes",
      recipe: joinRecipe(),
    });
    expect(made.table_name).toMatch(/^cb_nrra_all_mixes/);

    // Nothing in the Query tab or the guard knows this is a view.
    const res = db.runProjectQuery(
      projectId,
      `SELECT mix_id, binder FROM ${made.table_name} ORDER BY mix_id`,
      100,
    );
    expect(res.rows).toHaveLength(3);
    expect(res.rows[0]).toMatchObject({ mix_id: "A", binder: 5.1 });
    expect(res.rows[2].binder).toBeNull(); // C has no mix design, LEFT keeps it
  });

  it("stores a column_schema matching the view's real columns", () => {
    const ds = find("All mixes");
    const actual = db
      .runProjectQuery(projectId, `SELECT * FROM ${ds.table_name} LIMIT 1`, 1)
      .columns;
    expect(ds.column_schema.map((c) => c.name)).toEqual(actual);
  });

  it("refuses a recipe reaching outside the project", () => {
    expect(() =>
      db.createCombinedDataset({
        projectId,
        displayName: "Sneaky",
        recipe: {
          version: 1,
          columns: [{ name: "value", type: "text" }],
          branches: [{ id: "b1", spine: "settings", map: {} }],
        },
      }),
    ).toThrow(/not allowed/);
  });

  it("refuses a recipe naming a table that does not exist, instead of saving a broken view", () => {
    expect(() =>
      db.createCombinedDataset({
        projectId,
        displayName: "Broken",
        recipe: {
          version: 1,
          columns: [{ name: "x", type: "text" }],
          branches: [{ id: "b1", spine: "ds_nope", map: {} }],
        },
      }),
    ).toThrow(/not part of this project/);
    expect(find("Broken")).toBeUndefined();
  });
});

describe("the view survives a restart", () => {
  it("is rebuilt from its recipe when the database is reopened", () => {
    const ds = find("All mixes");
    db.open(tmpDb); // temp views do not survive a connection; the recipe does
    const res = db.runProjectQuery(projectId, `SELECT * FROM ${ds.table_name}`, 100);
    expect(res.rows).toHaveLength(3);
    expect(find("All mixes").unavailable_reason).toBeNull();
  });
});

describe("editing what the table is built from", () => {
  it("drops a column without touching the source data", () => {
    const ds = find("All mixes");
    const recipe = ds.recipe;
    recipe.columns = recipe.columns.filter((c) => c.name !== "fi");
    delete recipe.branches[0].map.fi;
    db.updateCombinedDataset(ds.id, { recipe });

    const after = find("All mixes");
    expect(after.column_schema.map((c) => c.name)).not.toContain("fi");
    // The source still has it: this was a recipe edit, not a data change.
    expect(find("iFIT 2022").column_schema.map((c) => c.name)).toContain("fi");
    expect(
      db.runProjectQuery(projectId, `SELECT fi FROM ${seasons.table_name}`, 10).rows,
    ).toHaveLength(3);
  });

  it("adds rows from another dataset by stacking a branch", () => {
    const later = db.createProjectDataset({
      projectId,
      displayName: "iFIT 2023",
      columns: [
        { name: "fi", type: "double precision" },
        { name: "mix_id", type: "text" },
      ],
    });
    rows(later, [{ fi: 9.5, mix_id: "A" }]);

    const ds = find("All mixes");
    const recipe = ds.recipe;
    recipe.provenance = true;
    recipe.branches.push({
      id: "b2",
      label: "2023",
      spine: later.table_name,
      joins: [{ id: "j1", table: mixes.table_name, leftColumn: "mix_id", rightColumn: "mix_id" }],
      map: {
        mix_id: { from: "spine", column: "mix_id" },
        binder: { from: "j1", column: "binder" },
      },
    });
    db.updateCombinedDataset(ds.id, { recipe });

    const res = db.runProjectQuery(
      projectId,
      `SELECT source_dataset, mix_id, binder FROM ${ds.table_name} ORDER BY source_dataset, mix_id`,
      100,
    );
    // Three rows from the original branch plus the one new row, which brought
    // its own join with it: binder comes from mix designs, not from iFIT 2023.
    expect(res.rows).toHaveLength(4);
    const added = res.rows.filter((r) => r.source_dataset === "2023");
    expect(added).toEqual([{ source_dataset: "2023", mix_id: "A", binder: 5.1 }]);
  });
});

describe("dependencies cannot dangle", () => {
  it("refuses to remove a dataset a combined dataset is built on, and names it", () => {
    const source = find("Mix designs");
    expect(() => db.dropProjectDataset(source.id)).toThrow(/used by combined dataset "All mixes"/);
    expect(find("Mix designs")).toBeDefined();
  });

  it("removes the combined dataset itself, leaving its sources alone", () => {
    const ds = find("All mixes");
    db.dropProjectDataset(ds.id);
    expect(find("All mixes")).toBeUndefined();
    expect(find("Mix designs")).toBeDefined();
    expect(
      db.runProjectQuery(projectId, `SELECT * FROM ${mixes.table_name}`, 10).rows,
    ).toHaveLength(2);
    // The view is gone with it, not left behind for the next open() to rebuild.
    expect(() => db.runProjectQuery(projectId, `SELECT * FROM ${ds.table_name}`, 10)).toThrow();
  });

  it("reports a combined dataset as unavailable when the file under it disappears", () => {
    // The realistic way a source vanishes: a combined dataset built over an
    // attached database whose file is later moved or deleted.
    const extPath = path.join(tmpDir, "lab.sqlite3");
    const Database = require("better-sqlite3");
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
      displayName: "Fragile",
      recipe: {
        version: 1,
        columns: [{ name: "av", type: "double precision" }],
        branches: [
          {
            id: "b1",
            spine: attached.table_name,
            map: { av: { from: "spine", column: "av" } },
          },
        ],
      },
    });
    expect(db.runProjectQuery(projectId, `SELECT av FROM ${made.table_name}`, 10).rows).toHaveLength(
      2,
    );

    fs.rmSync(extPath);
    db.open(tmpDb);

    const ds = db.listDatasets(projectId).find((d) => d.id === made.dataset_id);
    expect(ds.unavailable_reason).toMatch(/no such table/i);
    // Flagged, not silently dropped from the list, and not left queryable.
    expect(() => db.runProjectQuery(projectId, `SELECT * FROM ${ds.table_name}`, 10)).toThrow();
  });
});
