import { describe, expect, it } from "vitest";
import {
  friendlyQueryError,
  normalizePlanSql,
  parseChatPlan,
  planSystemPrompt,
  repairPrompt,
  rowsForContext,
  selectRelevantTables,
} from "../src/lib/data-chat";
import type { ColumnSchema } from "../src/lib/csv";

const tables = [
  {
    table_name: "ds_p_results",
    display_name: "results",
    row_count: 20,
    column_schema: [
      { name: "row_id", type: "integer" },
      { name: "mix_id", original_name: "Mixes Details Mix ID", type: "text" },
      { name: "gf", original_name: "DCT Fracture Energy (Gf)", type: "double precision" },
    ] as ColumnSchema[],
  },
];

describe("data chat planning", () => {
  it("gives the model the spreadsheet header alongside the SQL column", () => {
    const prompt = planSystemPrompt(tables);
    expect(prompt).toContain("ds_p_results");
    expect(prompt).toContain('gf double precision -- "DCT Fracture Energy (Gf)"');
    // row_id is an internal surrogate key; the model should not select it.
    expect(prompt).not.toContain("row_id");
  });

  it("parses a fenced JSON plan", () => {
    const plan = parseChatPlan(
      '```json\n{"answer":"Here you go.","sql":"SELECT mix_id FROM ds_p_results","chart":null}\n```',
    );
    expect(plan.sql).toBe("SELECT mix_id FROM ds_p_results");
    expect(plan.answer).toBe("Here you go.");
    expect(plan.chart).toBeNull();
  });

  it("keeps a chart suggestion only when it is fully specified", () => {
    const good = parseChatPlan(
      '{"answer":"a","sql":"SELECT a, b FROM ds_p_results","chart":{"kind":"bar","x":"a","y":"b"}}',
    );
    expect(good.chart).toEqual({ kind: "bar", x: "a", y: "b" });

    const bad = parseChatPlan(
      '{"answer":"a","sql":"SELECT a FROM ds_p_results","chart":{"kind":"pie","x":"a","y":"b"}}',
    );
    expect(bad.chart).toBeNull();
  });

  it("allows questions that need no data at all", () => {
    const plan = parseChatPlan('{"answer":"Gf is fracture energy.","sql":null,"chart":null}');
    expect(plan.sql).toBeNull();
    expect(plan.answer).toContain("fracture energy");
  });

  it("strips code fences and trailing semicolons from SQL", () => {
    expect(normalizePlanSql("```sql\nSELECT 1 FROM t;\n```")).toBe("SELECT 1 FROM t");
  });

  it("refuses anything that is not a read-only SELECT", () => {
    expect(() => normalizePlanSql("DELETE FROM ds_p_results")).toThrow(/read-only/i);
    expect(() => normalizePlanSql("DROP TABLE ds_p_results")).toThrow(/read-only/i);
    expect(() => normalizePlanSql("")).toThrow(/empty/i);
    // Statement-chaining hidden behind a leading SELECT.
    expect(() => normalizePlanSql("SELECT 1; DROP TABLE ds_p_results")).toThrow(/modify data/i);
  });

  it("summarises rows compactly and flags what was withheld", () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({ mix_id: `M${i}`, gf: i + 0.5 }));
    const text = rowsForContext(rows, ["mix_id", "gf"]);
    expect(text.split("\n")[0]).toBe("mix_id | gf");
    expect(text).toContain("M0 | 0.5");
    expect(text).toContain("5 more rows not shown");
    expect(rowsForContext([], ["mix_id"])).toBe("(no rows)");
  });
});

describe("query error recovery", () => {
  it("hands the failed SQL and the database error back to the model", () => {
    const p = repairPrompt("SELECT specimen FROM t", "no such column: specimen");
    expect(p).toContain("SELECT specimen FROM t");
    expect(p).toContain("no such column: specimen");
    expect(p).toMatch(/exactly/i);
  });

  it("translates database jargon into something a researcher can act on", () => {
    const col = friendlyQueryError("SqliteError: no such column: specimen");
    expect(col).toContain('"specimen"');
    expect(col).not.toMatch(/SqliteError/);

    expect(friendlyQueryError("no such table: ds_missing")).toContain('"ds_missing"');
    expect(friendlyQueryError("Table users is not part of this project")).toMatch(
      /outside this project/i,
    );
    // Anything unrecognised is still surfaced rather than swallowed.
    expect(friendlyQueryError("disk I/O error")).toContain("disk I/O error");
  });
});

describe("schema scoping", () => {
  const many: typeof tables = Array.from({ length: 12 }, (_, i) => ({
    table_name: `ds_t${i}`,
    display_name: `Table ${i}`,
    row_count: i * 10,
    column_schema: [{ name: `col${i}`, type: "text" }] as ColumnSchema[],
  }));

  it("returns everything when the project is already small", () => {
    expect(selectRelevantTables(tables, "anything").length).toBe(tables.length);
  });

  it("puts the table matching the question first and caps the count", () => {
    const withMatch = [
      ...many,
      {
        table_name: "ds_fracture",
        display_name: "DCT results",
        row_count: 1,
        column_schema: [
          { name: "gf", original_name: "Fracture Energy (Gf)", type: "double precision" },
        ] as ColumnSchema[],
      },
    ];
    const picked = selectRelevantTables(withMatch, "average fracture energy by mix", 5);
    expect(picked).toHaveLength(5);
    expect(picked[0]!.table_name).toBe("ds_fracture");
  });

  it("falls back to the largest tables when nothing matches", () => {
    const picked = selectRelevantTables(many, "zzzz qqqq", 3);
    expect(picked.map((t) => t.row_count)).toEqual([110, 100, 90]);
  });
});
