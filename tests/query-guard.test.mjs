import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  prepareProjectSelect,
  extractReferencedTables,
  extractCteNames,
} = require("../electron/query-guard.cjs");

const ALLOWED = ["ds_x", "ds_p_notes"];
const ok = (sql) => expect(() => prepareProjectSelect(sql, ALLOWED)).not.toThrow();
const no = (sql) => expect(() => prepareProjectSelect(sql, ALLOWED)).toThrow();

describe("CTEs", () => {
  it("accepts a WITH query instead of calling its CTE a missing table", () => {
    ok("WITH avg_e AS (SELECT 1 AS v FROM ds_x) SELECT * FROM avg_e");
    ok("WITH RECURSIVE t(n) AS (SELECT 1 FROM ds_x) SELECT n FROM t");
    ok(
      "WITH a AS (SELECT 1 AS v FROM ds_x), b AS (SELECT v FROM a) SELECT * FROM a JOIN b ON a.v = b.v",
    );
    expect(extractCteNames("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT 1")).toEqual(["a", "b"]);
  });

  it("still requires a real dataset and cannot launder a forbidden name", () => {
    no("WITH t AS (SELECT 1) SELECT * FROM t");
    no("WITH settings AS (SELECT 1 FROM ds_x) SELECT * FROM settings");
  });
});

describe("blocked keywords", () => {
  it("does not match inside literals, columns or aliases", () => {
    ok("SELECT * FROM ds_x WHERE label = 'Update 2023'");
    ok("SELECT * FROM ds_p_notes WHERE body LIKE '%create%'");
    ok("SELECT comment FROM ds_p_notes");
    ok("SELECT id AS copy FROM ds_p_notes");
    ok("SELECT upper(comment) FROM ds_p_notes");
    ok("SELECT * FROM ds_x WHERE note = 'a;b'");
  });

  it("still rejects a statement, including one hidden in a CTE", () => {
    no("DELETE FROM ds_x");
    no("DROP TABLE ds_x");
    no("WITH x AS (DELETE FROM ds_x RETURNING *) SELECT * FROM x");
    no("SELECT * FROM ds_x; DROP TABLE ds_x");
  });
});

describe("table extraction", () => {
  it("checks every table in a comma-separated FROM, not just the first", () => {
    expect(extractReferencedTables("SELECT * FROM ds_x, settings")).toEqual(["ds_x", "settings"]);
    no("SELECT * FROM ds_x, settings");
    no("SELECT * FROM ds_x, users u WHERE 1=1");
    no("SELECT * FROM ds_x /* , x */, sessions");
  });

  it("sees through quoting and comments", () => {
    no('SELECT * FROM "settings"');
    no("SELECT * FROM ds_x -- c\nUNION SELECT id, 1, 2 FROM users");
    ok("SELECT * FROM ds_x a JOIN ds_p_notes b ON a.id = b.id");
    ok("SELECT * FROM (SELECT id FROM ds_x) t");
  });
});
