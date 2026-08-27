import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("../electron/db.cjs");
const Database = require("better-sqlite3");

let tmpDir;
let tmpDb;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rdh-dbtest-"));
  tmpDb = path.join(tmpDir, "hub.sqlite3");
  db.open(tmpDb);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runProjectQuery limits", () => {
  it("flags a clipped result instead of reporting it as complete", () => {
    const projectId = db.createProject({
      project_name: "Limits",
      project_code: `LIM-${Date.now()}`,
    });
    const { dataset_id } = db.createProjectDataset({
      projectId,
      displayName: "rows",
      sourceFilename: null,
      columns: [{ name: "n", original_name: "n", type: "integer" }],
    });
    const ds = db.listDatasets(projectId, "desc").find((d) => d.id === dataset_id);
    db.insertDatasetRowsTyped(
      dataset_id,
      Array.from({ length: 25 }, (_, i) => ({ n: String(i) })),
    );

    const clipped = db.runProjectQuery(projectId, `SELECT n FROM ${ds.table_name}`, 10);
    expect(clipped.rows).toHaveLength(10);
    expect(clipped.truncated).toBe(true);

    const whole = db.runProjectQuery(projectId, `SELECT n FROM ${ds.table_name}`, 100);
    expect(whole.rows).toHaveLength(25);
    expect(whole.truncated).toBe(false);
  });

  it("allows a limit far above the old 5,000 export cap", () => {
    const projectId = db.createProject({ project_name: "Big", project_code: `BIG-${Date.now()}` });
    const { dataset_id } = db.createProjectDataset({
      projectId,
      displayName: "many",
      sourceFilename: null,
      columns: [{ name: "n", original_name: "n", type: "integer" }],
    });
    const ds = db.listDatasets(projectId, "desc").find((d) => d.id === dataset_id);
    db.insertDatasetRowsTyped(
      dataset_id,
      Array.from({ length: 6000 }, (_, i) => ({ n: String(i) })),
    );
    const res = db.runProjectQuery(projectId, `SELECT n FROM ${ds.table_name}`, 200000);
    expect(res.rows).toHaveLength(6000);
    expect(res.truncated).toBe(false);
  });
});

describe("detachSource", () => {
  it("leaves a similarly-named alias untouched", () => {
    // Two files named foo.db dedupe to aliases `foo` and `foo_1`. Matching
    // datasets by `att_foo_%` would sweep up `att_foo_1_*` as well.
    const files = ["a", "b"].map((sub) => {
      const dir = path.join(tmpDir, sub);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "foo.db");
      const src = new Database(file);
      src.exec("CREATE TABLE bar (x INTEGER); INSERT INTO bar VALUES (1);");
      src.close();
      return file;
    });

    const projectId = db.createProject({
      project_name: "Attach",
      project_code: `ATT-${Date.now()}`,
    });
    const first = db.attachSource(projectId, files[0]);
    const second = db.attachSource(projectId, files[1]);
    expect([first.alias, second.alias]).toEqual(["foo", "foo_1"]);

    db.detachSource(first.id);

    const remaining = db.listDatasets(projectId, "desc").map((d) => d.table_name);
    expect(remaining).toEqual([`att_${second.alias}_bar`]);
    expect(db.listAttachedSources(projectId).map((s) => [s.alias, s.table_count])).toEqual([
      ["foo_1", 1],
    ]);
  });
});

describe("attached source staleness", () => {
  it("re-reads row counts, new tables and dropped tables on refresh", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "stale-"));
    const file = path.join(dir, "pipeline.db");
    let src = new Database(file);
    src.exec("CREATE TABLE bar (x INTEGER); INSERT INTO bar VALUES (1);");
    src.close();

    const projectId = db.createProject({
      project_name: "Stale",
      project_code: `STL-${Date.now()}`,
    });
    const source = db.attachSource(projectId, file);
    const barView = `att_${source.alias}_bar`;
    const bazView = `att_${source.alias}_baz`;
    expect(db.listDatasets(projectId, "desc").find((d) => d.table_name === barView).row_count).toBe(
      1,
    );

    // The point of attaching rather than importing is that someone else's
    // pipeline keeps the file current, so simulate exactly that.
    src = new Database(file);
    src.exec("INSERT INTO bar VALUES (2), (3); CREATE TABLE baz (y TEXT);");
    src.close();

    db.refreshAttachedSources(projectId);
    let datasets = db.listDatasets(projectId, "desc");
    expect(datasets.find((d) => d.table_name === barView).row_count).toBe(3);
    expect(datasets.find((d) => d.table_name === bazView)).toBeTruthy();
    // A table that only appeared after attach has to be queryable, not just listed.
    expect(db.runProjectQuery(projectId, `SELECT COUNT(*) AS c FROM ${bazView}`).rows[0].c).toBe(0);

    src = new Database(file);
    src.exec("DROP TABLE baz;");
    src.close();

    db.refreshAttachedSources(projectId);
    datasets = db.listDatasets(projectId, "desc");
    expect(datasets.find((d) => d.table_name === bazView)).toBeUndefined();
  });

  it("flags a source whose file is gone instead of leaving ghost datasets", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "gone-"));
    const file = path.join(dir, "moved.db");
    const src = new Database(file);
    src.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
    src.close();

    const projectId = db.createProject({
      project_name: "Gone",
      project_code: `GON-${Date.now()}`,
    });
    const source = db.attachSource(projectId, file);
    expect(db.listAttachedSources(projectId)[0].available).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
    db.open(tmpDb); // restart: mounting is per-connection

    const listed = db.listAttachedSources(projectId);
    expect(listed[0].available).toBe(0);
    expect(listed[0].unavailable_reason).toContain("File not found");
    const ds = db.listDatasets(projectId, "desc").find((d) => d.table_name.startsWith("att_"));
    expect(ds.unavailable_reason).toContain("File not found");

    // Detaching must still work when nothing was ever ATTACHed.
    db.detachSource(source.id);
    expect(db.listAttachedSources(projectId)).toEqual([]);
  });
});

describe("addDatasetColumn", () => {
  it("renames a new column that would collide with the table's own row_id", () => {
    const projectId = db.createProject({
      project_name: "Columns",
      project_code: `COL-${Date.now()}`,
    });
    const { dataset_id } = db.createProjectDataset({
      projectId,
      displayName: "sheet",
      sourceFilename: null,
      columns: [{ name: "n", original_name: "n", type: "integer" }],
    });

    // row_id is the table's primary key, so ALTER TABLE ADD COLUMN "row_id"
    // used to surface SQLite's raw "duplicate column name" error instead.
    expect(db.addDatasetColumn(dataset_id, "Row ID", "text")).toBe("row_id_2");
    const ds = db.listDatasets(projectId, "desc").find((d) => d.id === dataset_id);
    expect(ds.column_schema.find((c) => c.name === "row_id_2").original_name).toBe("Row ID");
    expect(() =>
      db.runProjectQuery(projectId, `SELECT row_id_2 FROM ${ds.table_name}`),
    ).not.toThrow();
  });
});
