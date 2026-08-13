import { describe, expect, it } from "vitest";
import {
  buildBrowseSql,
  guessIdColumn,
  defaultVisibleColumns,
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
});
