import { describe, expect, it } from "vitest";
import {
  buildBrowseSql,
  guessIdColumn,
  defaultVisibleColumns,
  hasRowIdColumn,
  BROWSE_FETCH_LIMIT,
  BROWSE_PROBE_LIMIT,
} from "../src/lib/browse-sql.ts";

describe("browse-sql", () => {
  it("guesses id-like columns", () => {
    expect(
      guessIdColumn([
        { name: "notes", type: "text", original_name: "notes" },
        { name: "sample_id", type: "text", original_name: "sample_id" },
        { name: "value", type: "double precision", original_name: "value" },
      ]),
    ).toBe("sample_id");
  });

  it("builds IN filter for comma list", () => {
    const sql = buildBrowseSql({
      tableName: "ds_test_mix",
      columns: ["sample_id", "binder_pct"],
      filterColumn: "sample_id",
      filterOp: "in",
      filterValue: "6001, 6002",
      limit: 100,
    });
    expect(sql).toContain('SELECT "row_id", "sample_id", "binder_pct" FROM ds_test_mix');
    expect(sql).toContain(`CAST("sample_id" AS TEXT) IN ('6001', '6002')`);
    expect(sql).toContain("LIMIT 100");
  });

  it("defaults to first 12 columns", () => {
    const cols = Array.from({ length: 20 }, (_, i) => ({
      name: `c${i}`,
      type: "text" as const,
      original_name: `c${i}`,
    }));
    expect(defaultVisibleColumns(cols)).toHaveLength(12);
  });

  it("allows the one probe row past the display cap", () => {
    // Browse fetches one row more than it shows; that row is how it knows the
    // result was clipped. Clamping it away made the truncation notice dead code.
    expect(BROWSE_PROBE_LIMIT).toBe(BROWSE_FETCH_LIMIT + 1);
    const sql = buildBrowseSql({
      tableName: "ds_test_mix",
      columns: ["sample_id"],
      limit: BROWSE_PROBE_LIMIT,
    });
    expect(sql).toContain(`LIMIT ${BROWSE_PROBE_LIMIT}`);
  });

  it("omits row_id for a table that has none, instead of failing the query", () => {
    // An attached source reflects an arbitrary external table, which usually has
    // no row_id — asking for one anyway made Browse fail on every such dataset
    // with a raw `no such column: row_id`.
    const attached = [
      { name: "sample_id", type: "text" as const, original_name: "sample_id" },
      { name: "av", type: "double precision" as const, original_name: "av" },
    ];
    expect(hasRowIdColumn(attached)).toBe(false);

    const sql = buildBrowseSql({
      tableName: "att_lab_results",
      columns: ["sample_id", "av"],
      hasRowId: false,
    });
    expect(sql).toContain('SELECT "sample_id", "av" FROM att_lab_results');
    expect(sql).not.toContain("row_id");

    // Unchanged for everything this app imports itself.
    expect(hasRowIdColumn([{ name: "row_id", type: "integer", original_name: "row_id" }])).toBe(
      true,
    );
    expect(buildBrowseSql({ tableName: "ds_x", columns: ["a"] })).toContain('SELECT "row_id", "a"');
  });
});
