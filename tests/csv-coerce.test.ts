import { describe, expect, it } from "vitest";
import { coerceRow, keyText, parseCsv, type ColumnSchema } from "../src/lib/csv";

describe("numeric inference", () => {
  it("treats scientific notation as numeric", () => {
    const p = parseCsv("specimen,modulus\nA-1,1.23E+05\nA-2,4.5e-3\nA-3,.75");
    expect(p.columns.find((c) => c.name === "modulus")?.type).toBe("double precision");
  });

  it("still refuses non-numeric text", () => {
    const p = parseCsv("specimen,note\nA-1,1.23E+05\nA-2,n/a");
    expect(p.columns.find((c) => c.name === "note")?.type).toBe("text");
  });
});

describe("coerceRow", () => {
  const cols: ColumnSchema[] = [
    { name: "specimen", type: "text" },
    { name: "modulus", type: "double precision" },
    { name: "count", type: "integer" },
  ];

  it("accepts scientific notation for doubles", () => {
    const res = coerceRow({ specimen: "A", modulus: "1.23E+05", count: "3" }, cols);
    expect(res.bad).toEqual([]);
    expect(res.row.modulus).toBe("1.23E+05");
  });

  it("accepts integral floats for integers and normalises them", () => {
    expect(coerceRow({ specimen: "A", modulus: "1", count: "12.0" }, cols).row.count).toBe("12");
    expect(coerceRow({ specimen: "A", modulus: "1", count: "1e3" }, cols).row.count).toBe("1000");
    expect(coerceRow({ specimen: "A", modulus: "1", count: "+7" }, cols).row.count).toBe("7");
  });

  it("keeps long integers exact rather than round-tripping through Number", () => {
    const big = "900719925474099111";
    expect(coerceRow({ specimen: "A", modulus: "1", count: big }, cols).row.count).toBe(big);
  });

  it("rejects integers too large to represent exactly", () => {
    const res = coerceRow({ specimen: "A", modulus: "1", count: "1e21" }, cols);
    expect(res.row.count).toBeNull();
    expect(res.bad).toHaveLength(1);
  });

  it("nulls a bad cell instead of discarding the whole row", () => {
    const res = coerceRow({ specimen: "A-9", modulus: "n/a", count: "42" }, cols);
    expect(res.row).toEqual({ specimen: "A-9", modulus: null, count: "42" });
    expect(res.bad).toEqual([
      { column: "modulus", value: "n/a", reason: '"modulus" expects number, got "n/a"' },
    ]);
  });

  it("reports every bad cell in a row", () => {
    const res = coerceRow({ specimen: "A", modulus: "x", count: "y" }, cols);
    expect(res.bad.map((b) => b.column)).toEqual(["modulus", "count"]);
  });
});

describe("keyText", () => {
  it("matches a CSV spelling of a number to the value the database returns", () => {
    // The parent side arrives typed (SQLite hands back the number 1); the child
    // side is text. Comparing them raw made "1.0" a false orphan.
    for (const written of ["1", "1.0", " 1 ", "01", "1e0"]) {
      expect(keyText(written, "integer")).toBe(keyText(1, "integer"));
      expect(keyText(written, "double precision")).toBe(keyText(1, "double precision"));
    }
  });

  it("keeps text codes distinct, so 0001 is not 1", () => {
    expect(keyText("0001", "text")).toBe("0001");
    expect(keyText("0001", "text")).not.toBe(keyText(1, "text"));
  });

  it("treats empty and null as no key", () => {
    expect(keyText(null, "integer")).toBe("");
    expect(keyText("   ", "text")).toBe("");
  });

  it("agrees with what coerceRow will actually insert", () => {
    const cols: ColumnSchema[] = [{ name: "sample_id", original_name: "sample_id", type: "integer" }];
    const { row } = coerceRow({ sample_id: "1.0" }, cols);
    expect(keyText(row.sample_id, "integer")).toBe(keyText(1, "integer"));
  });
});
