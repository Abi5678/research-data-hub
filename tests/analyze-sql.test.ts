import { describe, expect, it } from "vitest";
import {
  buildAnalyzeSql,
  buildJoinUnmatchedSql,
  defaultJoinVisibleColumns,
  guessJoinColumns,
  guessJoinedPlotDefaults,
  parseAnalyzeViewSpec,
  planJoinColumns,
} from "../src/lib/analyze-sql.ts";

const dct = [
  { name: "mix_id", type: "text" as const, original_name: "Mix ID" },
  { name: "peak_load", type: "double precision" as const, original_name: "Peak load" },
  { name: "gf", type: "double precision" as const, original_name: "Gf" },
];
const ifit = [
  { name: "mix_id", type: "text" as const, original_name: "Mix ID" },
  { name: "fi", type: "double precision" as const, original_name: "FI" },
];

describe("analyze-sql", () => {
  it("guesses Mix ID as the join key on both tables", () => {
    expect(guessJoinColumns(dct, ifit)).toEqual({
      leftColumn: "mix_id",
      rightColumn: "mix_id",
    });
  });

  it("aliases colliding right-hand columns and keeps unique names", () => {
    const refs = planJoinColumns(
      dct.map((c) => c.name),
      ifit.map((c) => c.name),
    );
    expect(refs.find((r) => r.table === "left" && r.column === "mix_id")?.name).toBe("mix_id");
    expect(refs.find((r) => r.table === "right" && r.column === "mix_id")?.name).toBe("t2_mix_id");
    expect(refs.find((r) => r.table === "right" && r.column === "fi")?.name).toBe("fi");
  });

  it("builds an inner join of DCT Gf to I-FIT FI on Mix ID", () => {
    const refs = planJoinColumns(
      dct.map((c) => c.name),
      ifit.map((c) => c.name),
    );
    const sql = buildAnalyzeSql({
      leftTable: "ds_dct",
      requested: ["mix_id", "gf", "fi"],
      columnRefs: refs,
      join: {
        leftTable: "ds_dct",
        rightTable: "ds_ifit",
        leftColumn: "mix_id",
        rightColumn: "mix_id",
      },
      filterColumn: "mix_id",
      filterOp: "in",
      filterValue: "BL, AC",
      limit: 100,
    });
    expect(sql).toContain("FROM ds_dct AS t1 JOIN ds_ifit AS t2 ON");
    expect(sql).toContain('CAST(t1."mix_id" AS TEXT) = CAST(t2."mix_id" AS TEXT)');
    expect(sql).toContain('t1."gf" AS "gf"');
    expect(sql).toContain('t2."fi" AS "fi"');
    expect(sql).toContain(`CAST(t1."mix_id" AS TEXT) IN ('BL', 'AC')`);
    expect(sql).toContain("LIMIT 100");
  });

  it("defaults a joined scatter of Gf vs FI and keeps both measures visible", () => {
    const refs = planJoinColumns(
      dct.map((c) => c.name),
      ifit.map((c) => c.name),
    );
    const visible = defaultJoinVisibleColumns(refs, dct, ifit);
    expect(visible).toEqual(expect.arrayContaining(["mix_id", "gf", "fi"]));
    const plot = guessJoinedPlotDefaults(refs, dct, ifit, visible);
    expect(plot).toMatchObject({ kind: "scatter", xColumn: "gf", yColumn: "fi" });
  });

  it("counts unmatched Mix IDs without dropping them silently", () => {
    const sql = buildJoinUnmatchedSql({
      leftTable: "ds_dct",
      rightTable: "ds_ifit",
      leftColumn: "mix_id",
      rightColumn: "mix_id",
    });
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("unmatched_left");
    expect(sql).toContain("unmatched_right");
  });

  it("round-trips a saved analysis spec", () => {
    const spec = parseAnalyzeViewSpec({
      version: 1,
      leftTable: "ds_dct",
      join: { rightTable: "ds_ifit", leftColumn: "mix_id", rightColumn: "mix_id" },
      visibleCols: ["mix_id", "gf", "fi"],
      filter: null,
      plots: [{ kind: "scatter", xColumn: "gf", yColumn: "fi", aggregation: "mean" }],
    });
    expect(spec.join?.rightTable).toBe("ds_ifit");
    expect(spec.plots[0]).toMatchObject({ kind: "scatter", xColumn: "gf", yColumn: "fi" });
    expect(spec.plots[0]!.id).toBeTruthy();
  });
});
