import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const {
  PROVENANCE_COLUMN,
  referencedTables,
  assertRecipeScope,
  normalizeRecipe,
  buildCombineSql,
  combinedColumnSchema,
} = require("../electron/combine-sql.cjs");

const recipe = (o) => ({ version: 1, provenance: false, columns: [], branches: [], ...o });
const col = (name, type = "text") => ({ name, type });
const from = (column, source = "spine") => ({ from: source, column });

/** Run a recipe's SQL against a throwaway in-memory db. String assertions
 *  prove the shape; this proves the rows, which is what "accurate" means. */
function run(sql, setup) {
  const db = new Database(":memory:");
  db.exec(setup);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

const TWO_YEARS = `
  CREATE TABLE ds_2022 (row_id INTEGER PRIMARY KEY, mix_id TEXT, fi REAL);
  CREATE TABLE ds_2023 (row_id INTEGER PRIMARY KEY, fi REAL, mix_id TEXT);
  CREATE TABLE ds_mix  (row_id INTEGER PRIMARY KEY, mix_id TEXT, binder REAL);
  INSERT INTO ds_2022 (mix_id, fi) VALUES ('A', 1.5), ('B', 2.5), ('C', 3.5);
  INSERT INTO ds_2023 (fi, mix_id) VALUES (9.5, 'A'), (8.5, 'B');
  INSERT INTO ds_mix  (mix_id, binder) VALUES ('A', 5.1), ('B', 5.2);
`;

describe("joins add columns", () => {
  const joined = (type) =>
    recipe({
      columns: [col("mix_id"), col("binder", "double precision")],
      branches: [
        {
          id: "b1",
          spine: "ds_2022",
          joins: [{ id: "j1", table: "ds_mix", leftColumn: "mix_id", rightColumn: "mix_id", type }],
          map: { mix_id: from("mix_id"), binder: from("binder", "j1") },
        },
      ],
    });

  it("keeps unmatched spine rows with a LEFT join, and drops them with INNER", () => {
    // ds_2022 has mix C, ds_mix does not. That row is the whole point: LEFT
    // keeps it with a blank binder, INNER makes it disappear without a word.
    const left = run(buildCombineSql(joined("left"), ["ds_2022", "ds_mix"]), TWO_YEARS);
    expect(left).toHaveLength(3);
    expect(left.find((r) => r.mix_id === "C").binder).toBeNull();

    const inner = run(buildCombineSql(joined("inner"), ["ds_2022", "ds_mix"]), TWO_YEARS);
    expect(inner).toHaveLength(2);
    expect(inner.map((r) => r.mix_id)).toEqual(["A", "B"]);
  });

  it("defaults to LEFT, so a join never silently drops rows", () => {
    expect(buildCombineSql(joined(undefined))).toContain("LEFT JOIN");
  });

  it("compares keys natively by default and only casts when asked", () => {
    const sql = buildCombineSql(joined("left"));
    expect(sql).toContain('t0."mix_id" = t1."mix_id"');
    expect(sql).not.toContain("CAST");

    const cast = joined("left");
    cast.branches[0].joins[0].keyCompare = "text";
    expect(buildCombineSql(cast)).toContain(
      'CAST(t0."mix_id" AS TEXT) = CAST(t1."mix_id" AS TEXT)',
    );
  });
});

describe("extra branches add rows", () => {
  it("maps columns by name, not position", () => {
    // ds_2023 stores (fi, mix_id) — the opposite physical order to ds_2022.
    // Under positional alignment the two columns would swap here.
    const rows = run(
      buildCombineSql(
        recipe({
          columns: [col("mix_id"), col("fi", "double precision")],
          branches: [
            { id: "b1", spine: "ds_2022", map: { mix_id: from("mix_id"), fi: from("fi") } },
            { id: "b2", spine: "ds_2023", map: { mix_id: from("mix_id"), fi: from("fi") } },
          ],
        }),
        ["ds_2022", "ds_2023"],
      ),
      TWO_YEARS,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(typeof r.mix_id).toBe("string");
      expect(typeof r.fi).toBe("number");
    }
    expect(rows.filter((r) => r.mix_id === "A").map((r) => r.fi).sort()).toEqual([1.5, 9.5]);
  });

  it("fills an unmapped column with NULL without shifting its neighbours", () => {
    const rows = run(
      buildCombineSql(
        recipe({
          columns: [col("mix_id"), col("fi", "double precision"), col("binder", "double precision")],
          branches: [
            {
              id: "b1",
              spine: "ds_2022",
              joins: [
                { id: "j1", table: "ds_mix", leftColumn: "mix_id", rightColumn: "mix_id" },
              ],
              map: {
                mix_id: from("mix_id"),
                fi: from("fi"),
                binder: from("binder", "j1"),
              },
            },
            // No binder anywhere in this branch, and fi left unmapped entirely.
            { id: "b2", spine: "ds_2023", map: { mix_id: from("mix_id") } },
          ],
        }),
        ["ds_2022", "ds_2023"],
      ),
      TWO_YEARS,
    );
    const b2 = rows.filter((r) => r.fi === null);
    expect(b2).toHaveLength(2);
    for (const r of b2) {
      expect(r.binder).toBeNull();
      expect(["A", "B"]).toContain(r.mix_id); // not shifted into fi or binder
    }
  });

  it("stacks with UNION ALL, so identical rows from two sources both survive", () => {
    const both = recipe({
      provenance: true,
      columns: [col("mix_id")],
      branches: [
        { id: "b1", label: "2022", spine: "ds_2022", map: { mix_id: from("mix_id") } },
        { id: "b2", label: "2023", spine: "ds_2023", map: { mix_id: from("mix_id") } },
      ],
    });
    const sql = buildCombineSql(both, ["ds_2022", "ds_2023"]);
    expect(sql).toContain("UNION ALL");
    expect(sql.replace(/UNION ALL/g, "")).not.toContain("UNION");

    const rows = run(sql, TWO_YEARS);
    const a = rows.filter((r) => r.mix_id === "A");
    expect(a).toHaveLength(2);
    expect(a.map((r) => r[PROVENANCE_COLUMN]).sort()).toEqual(["2022", "2023"]);
  });

  it("lets a stacked branch carry its own join", () => {
    // The case a spine-plus-appends shape cannot express: two seasons stacked,
    // each pulling binder from mix designs.
    const rows = run(
      buildCombineSql(
        recipe({
          columns: [col("mix_id"), col("binder", "double precision")],
          branches: ["ds_2022", "ds_2023"].map((spine, i) => ({
            id: `b${i + 1}`,
            spine,
            joins: [{ id: "j1", table: "ds_mix", leftColumn: "mix_id", rightColumn: "mix_id" }],
            map: { mix_id: from("mix_id"), binder: from("binder", "j1") },
          })),
        }),
        ["ds_2022", "ds_2023"],
      ),
      TWO_YEARS,
    );
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.binder === 5.1)).toHaveLength(2); // mix A, both years
  });
});

describe("row_id", () => {
  const stacked = recipe({
    columns: [col("mix_id")],
    branches: [
      { id: "b1", spine: "ds_2022", map: { mix_id: from("mix_id") } },
      { id: "b2", spine: "ds_2023", map: { mix_id: from("mix_id") } },
    ],
  });

  it("is an integer and unique across branches when every spine has one", () => {
    const rows = run(buildCombineSql(stacked, ["ds_2022", "ds_2023"]), TWO_YEARS);
    const ids = rows.map((r) => r.row_id);
    expect(new Set(ids).size).toBe(rows.length);
    for (const id of ids) expect(Number.isInteger(id)).toBe(true);
  });

  it("is omitted entirely when a source has none, rather than emitted as NULL", () => {
    // Attached sources reflect arbitrary external tables and usually have no
    // row_id. Half a row_id column looks like an identifier and isn't one.
    const sql = buildCombineSql(stacked, ["ds_2022"]);
    expect(sql).not.toContain("row_id");
    expect(combinedColumnSchema(stacked, ["ds_2022"]).map((c) => c.name)).toEqual(["mix_id"]);
    expect(combinedColumnSchema(stacked, ["ds_2022", "ds_2023"]).map((c) => c.name)).toEqual([
      "row_id",
      "mix_id",
    ]);
  });
});

describe("output shape", () => {
  it("never selects *, orders, or limits inside the view", () => {
    const sql = buildCombineSql(
      recipe({
        columns: [col("mix_id")],
        branches: [{ id: "b1", spine: "ds_2022", map: { mix_id: from("mix_id") } }],
      }),
    );
    expect(sql).not.toContain("*");
    expect(sql.toUpperCase()).not.toContain("ORDER BY");
    expect(sql.toUpperCase()).not.toContain("LIMIT");
  });

  it("suffixes duplicate and reserved output names instead of colliding", () => {
    const r = normalizeRecipe(
      recipe({
        columns: [col("value"), col("value"), col("row_id"), col(PROVENANCE_COLUMN)],
        branches: [{ id: "b1", spine: "ds_2022", map: {} }],
      }),
    );
    expect(r.columns.map((c) => c.name)).toEqual([
      "value",
      "value_2",
      "row_id_2",
      `${PROVENANCE_COLUMN}_2`,
    ]);
  });

  it("sanitises output names into the same space as an imported dataset's", () => {
    const r = normalizeRecipe(
      recipe({
        columns: [col("Air Voids (%)")],
        branches: [{ id: "b1", spine: "ds_2022", map: {} }],
      }),
    );
    expect(r.columns[0].name).toBe("air_voids");
  });

  it("keeps a stale map entry working when a column has been renamed", () => {
    const r = normalizeRecipe(
      recipe({
        columns: [col("value"), col("value")],
        branches: [
          { id: "b1", spine: "ds_2022", map: { value: from("fi") } },
        ],
      }),
    );
    // The second `value` became `value_2`; its map key is still the old name.
    expect(r.branches[0].map.value_2).toEqual({ from: "spine", column: "fi" });
  });
});

describe("recipe validation", () => {
  const scoped = recipe({
    columns: [col("mix_id")],
    branches: [
      {
        id: "b1",
        spine: "ds_2022",
        joins: [{ id: "j1", table: "ds_mix", leftColumn: "mix_id", rightColumn: "mix_id" }],
        map: { mix_id: from("mix_id") },
      },
      { id: "b2", spine: "ds_2023", map: { mix_id: from("mix_id") } },
    ],
  });

  it("lists every table a recipe reads from", () => {
    expect(referencedTables(scoped).sort()).toEqual(["ds_2022", "ds_2023", "ds_mix"]);
  });

  it("refuses a recipe reaching outside its project", () => {
    const allowed = ["ds_2022", "ds_2023", "ds_mix"];
    expect(() => assertRecipeScope(scoped, allowed)).not.toThrow();
    expect(() => assertRecipeScope(scoped, ["ds_2022", "ds_2023"])).toThrow(/not part of this project/);
  });

  it("refuses a recipe reaching into an app table the query guard would block", () => {
    // The guard only checks names in the submitted SQL, never a view's body, so
    // without this a saved view is a permanent read primitive into settings.
    const sneaky = recipe({
      columns: [col("v")],
      branches: [{ id: "b1", spine: "settings", map: {} }],
    });
    expect(() => assertRecipeScope(sneaky, ["settings", "ds_2022"])).toThrow(/not allowed/);
  });

  it("refuses a column reading from a join the branch does not have", () => {
    expect(() =>
      normalizeRecipe(
        recipe({
          columns: [col("binder")],
          branches: [{ id: "b1", spine: "ds_2022", map: { binder: from("binder", "j9") } }],
        }),
      ),
    ).toThrow(/does not join in/);
  });

  it("refuses a recipe with no source at all", () => {
    expect(() => normalizeRecipe(recipe({}))).toThrow(/at least one dataset/);
  });
});
