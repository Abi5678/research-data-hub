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
let projectId;
let samples;
let lab;
let numeric;

const rows = (ds, values) =>
  db.insertDatasetRowsTyped(
    ds.dataset_id,
    values.map((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]))),
  );

const make = (displayName, columns) =>
  db.createProjectDataset({ projectId, displayName, columns });

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rdh-preflight-"));
  db.open(path.join(tmpDir, "hub.sqlite3"));
  projectId = db.createProject({ project_code: "NRRA", project_name: "Field Mix" });

  // The exact shape that silently corrupts a joined table: three lab results
  // for sample A, none at all for sample C.
  samples = make("Samples", [
    { name: "sample_id", type: "text" },
    { name: "fi", type: "double precision" },
  ]);
  lab = make("Lab results", [
    { name: "sample_id", type: "text" },
    { name: "air_voids", type: "double precision" },
  ]);
  // sample_id stored as a number here, so a text/integer key mismatch is real.
  numeric = make("Numeric keys", [
    { name: "sample_id", type: "integer" },
    { name: "note", type: "text" },
  ]);

  rows(samples, [
    { sample_id: "A", fi: 1.5 },
    { sample_id: "B", fi: 2.5 },
    { sample_id: "C", fi: 3.5 },
  ]);
  rows(lab, [
    { sample_id: "A", air_voids: 4.0 },
    { sample_id: "A", air_voids: 4.2 },
    { sample_id: "A", air_voids: 4.4 },
    { sample_id: "B", air_voids: 5.0 },
  ]);
  rows(numeric, [
    { sample_id: 1, note: "one" },
    { sample_id: 2, note: "two" },
  ]);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A one-branch recipe: samples, optionally joined to `lab`. */
const withJoin = (join, extra = {}) => ({
  version: 1,
  columns: [
    { name: "sample_id", type: "text" },
    { name: "air_voids", type: "double precision" },
  ],
  branches: [
    {
      id: "b1",
      label: "Samples",
      spine: samples.table_name,
      joins: join ? [{ id: "j1", ...join }] : [],
      map: {
        sample_id: { from: "spine", column: "sample_id" },
        air_voids: join ? { from: "j1", column: "air_voids" } : null,
      },
    },
  ],
  ...extra,
});

const check = (recipe, datasetId = null) => db.preflightCombine(projectId, recipe, datasetId);
const codes = (report) => report.findings.map((f) => f.code);
const finding = (report, code) => report.findings.find((f) => f.code === code);

describe("a join that multiplies rows", () => {
  const fanOut = () =>
    check(withJoin({ table: lab.table_name, leftColumn: "sample_id", rightColumn: "sample_id" }));

  it("is reported, with what the row count actually becomes", () => {
    const r = fanOut();
    expect(codes(r)).toContain("fan_out");
    // 3 samples LEFT JOIN a lab table with 3 rows for A and 1 for B = 5 rows.
    // Silently turning 3 rows into 5 is the single most common way a joined
    // table ends up wrong while looking right.
    expect(r.estimatedRows).toBe(5);
    expect(r.branches[0].spineRows).toBe(3);
    expect(finding(r, "fan_out").message).toContain("2.0 rows per sample_id");
  });

  it("is a warning, not a block — sometimes that is the intent", () => {
    expect(fanOut().ok).toBe(true);
  });
});

describe("rows a join would drop", () => {
  it("counts them, and says what happens to them", () => {
    // Sample C matches nothing in the lab table.
    const left = check(
      withJoin({ table: lab.table_name, leftColumn: "sample_id", rightColumn: "sample_id" }),
    );
    expect(finding(left, "unmatched").detail.unmatched).toBe(1);
    expect(finding(left, "unmatched").message).toContain("kept");

    const inner = check(
      withJoin({
        table: lab.table_name,
        leftColumn: "sample_id",
        rightColumn: "sample_id",
        type: "inner",
      }),
    );
    expect(finding(inner, "unmatched").message).toContain("drops them");
    expect(inner.estimatedRows).toBe(4); // C is gone
  });
});

describe("a key that cannot be right", () => {
  it("blocks a join that matches nothing at all", () => {
    const r = check(
      withJoin({ table: numeric.table_name, leftColumn: "sample_id", rightColumn: "sample_id" }),
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("zero_matches");
    // And the block is enforced where it counts, not only in the report.
    expect(() =>
      db.createCombinedDataset({
        projectId,
        displayName: "Impossible",
        recipe: withJoin({
          table: numeric.table_name,
          leftColumn: "sample_id",
          rightColumn: "sample_id",
        }),
      }),
    ).toThrow(/wrong key/);
  });

  it("blocks a column that no longer exists", () => {
    const r = check(
      withJoin({ table: lab.table_name, leftColumn: "sample_id", rightColumn: "not_a_column" }),
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("missing_key");
  });

  it("shows both match counts when the key types differ, instead of picking one", () => {
    // '01' and '3.0' in a text column against 1 and 3 in an integer one:
    // comparing as-is matches all three (column affinity converts the text),
    // comparing as text matches only the one written '2'. Neither direction is
    // universally right, so the report hands the user both real numbers rather
    // than choosing for them.
    const textKeys = make("Text keys", [
      { name: "sample_id", type: "text" },
      { name: "note", type: "text" },
    ]);
    rows(textKeys, [
      { sample_id: "01", note: "a" },
      { sample_id: "2", note: "b" },
      { sample_id: "3.0", note: "c" },
    ]);
    rows(numeric, [{ sample_id: 3, note: "three" }]);

    const recipe = {
      version: 1,
      columns: [{ name: "note", type: "text" }],
      branches: [
        {
          id: "b1",
          label: "Text keys",
          spine: textKeys.table_name,
          joins: [
            {
              id: "j1",
              table: numeric.table_name,
              leftColumn: "sample_id",
              rightColumn: "sample_id",
            },
          ],
          map: { note: { from: "j1", column: "note" } },
        },
      ],
    };
    const f = finding(check(recipe), "key_type");
    expect(f).toBeDefined();
    expect(f.detail.native).toBe(3);
    expect(f.detail.text).toBe(1);
    expect(f.message).toContain("stops the join using an index");
  });
});

describe("stacking branches", () => {
  it("names the columns that will be blank for each source", () => {
    const recipe = withJoin(null);
    recipe.branches.push({
      id: "b2",
      label: "Lab results",
      spine: lab.table_name,
      map: { air_voids: { from: "spine", column: "air_voids" } },
    });
    const r = check(recipe);
    const unmapped = r.findings.filter((f) => f.code === "unmapped");
    expect(unmapped).toHaveLength(2);
    expect(unmapped.find((f) => f.detail.branchId === "b2").detail.columns).toEqual(["sample_id"]);
    expect(r.estimatedRows).toBe(7); // 3 samples stacked on 4 lab rows
  });

  it("reports the renames a name collision forces", () => {
    const recipe = withJoin(null);
    recipe.columns = [
      { name: "sample_id", type: "text" },
      { name: "sample_id", type: "text" },
    ];
    const r = check(recipe);
    expect(r.renames).toEqual([{ from: "sample_id", to: "sample_id_2" }]);
    expect(codes(r)).toContain("renamed");
  });
});

describe("a dataset cannot build on itself", () => {
  it("blocks a recipe that reaches back through another combined dataset", () => {
    const first = db.createCombinedDataset({
      projectId,
      displayName: "Joined",
      recipe: withJoin({ table: lab.table_name, leftColumn: "sample_id", rightColumn: "sample_id" }),
    });
    const second = db.createCombinedDataset({
      projectId,
      displayName: "Stacked on joined",
      recipe: {
        version: 1,
        columns: [{ name: "sample_id", type: "text" }],
        branches: [
          {
            id: "b1",
            label: "Joined",
            spine: first.table_name,
            map: { sample_id: { from: "spine", column: "sample_id" } },
          },
        ],
      },
    });

    // Now point the first one at the second: first -> second -> first.
    const cyclic = {
      version: 1,
      columns: [{ name: "sample_id", type: "text" }],
      branches: [
        {
          id: "b1",
          label: "Stacked",
          spine: second.table_name,
          map: { sample_id: { from: "spine", column: "sample_id" } },
        },
      ],
    };
    const r = check(cyclic, first.dataset_id);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("cycle");
    expect(() => db.updateCombinedDataset(first.dataset_id, { recipe: cyclic })).toThrow(
      /build on itself/,
    );
    // And the working view is still working, not half-rewritten.
    expect(
      db.runProjectQuery(projectId, `SELECT * FROM ${first.table_name}`, 10).rows,
    ).toHaveLength(5);
  });
});
