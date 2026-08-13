import { describe, expect, it } from "vitest";
import {
  buildDashboardSpec,
  classifyColumns,
  computeKpi,
  CATEGORY_MAX_DISTINCT,
  MAX_CHARTS,
} from "../src/lib/dashboard-spec.ts";

const columns = [
  { name: "sample_id", type: "text" as const, original_name: "sample_id" },
  { name: "mix_type", type: "text" as const, original_name: "mix_type" },
  { name: "sampled_on", type: "date" as const, original_name: "sampled_on" },
  { name: "binder_pct", type: "double precision" as const, original_name: "binder_pct" },
  { name: "air_voids", type: "double precision" as const, original_name: "air_voids" },
];

const rows = [
  { sample_id: "6001", mix_type: "A", sampled_on: "2026-01-01", binder_pct: 5.1, air_voids: 3.9 },
  { sample_id: "6002", mix_type: "A", sampled_on: "2026-01-02", binder_pct: "5.5", air_voids: 4.1 },
  { sample_id: "6003", mix_type: "B", sampled_on: "2026-01-03", binder_pct: 6.3, air_voids: null },
  { sample_id: "6004", mix_type: "B", sampled_on: "2026-01-04", binder_pct: "", air_voids: 4.4 },
];

describe("dashboard-spec", () => {
  it("classifies selected columns by schema type", () => {
    const { numeric, temporal, categorical } = classifyColumns(
      columns,
      columns.map((c) => c.name),
    );
    expect(numeric).toEqual(["binder_pct", "air_voids"]);
    expect(temporal).toEqual(["sampled_on"]);
    expect(categorical).toEqual(["sample_id", "mix_type"]);
  });

  it("computes KPI stats over numeric-like cells and counts missing", () => {
    const kpi = computeKpi(rows, "binder_pct");
    expect(kpi.count).toBe(3);
    expect(kpi.missing).toBe(1);
    expect(kpi.min).toBe(5.1);
    expect(kpi.max).toBe(6.3);
    expect(kpi.median).toBe(5.5);
    expect(kpi.mean).toBeCloseTo(5.6333, 3);
  });

  it("returns null stats when no numeric values are present", () => {
    const kpi = computeKpi([{ v: "x" }, { v: null }], "v");
    expect(kpi).toMatchObject({ count: 0, missing: 2, min: null, mean: null });
  });

  it("prefers a line chart for date + numeric selections", () => {
    const spec = buildDashboardSpec({
      columns,
      selectedColumns: ["sampled_on", "binder_pct"],
      rows,
    });
    expect(spec.kpis.map((k) => k.column)).toEqual(["binder_pct"]);
    expect(spec.charts[0]).toMatchObject({
      kind: "line",
      xColumn: "sampled_on",
      yColumn: "binder_pct",
    });
    expect(spec.charts[0]!.data).toHaveLength(3);
  });

  it("averages a numeric by a low-cardinality category", () => {
    const spec = buildDashboardSpec({
      columns,
      selectedColumns: ["mix_type", "air_voids"],
      rows,
    });
    const bar = spec.charts.find((c) => c.kind === "bar");
    expect(bar).toMatchObject({ aggregation: "average", categoryColumn: "mix_type" });
    expect(bar!.data).toEqual([
      { label: "B", value: 4.4 },
      { label: "A", value: 4 },
    ]);
  });

  it("falls back to a count chart when only a category is selected", () => {
    const spec = buildDashboardSpec({
      columns,
      selectedColumns: ["mix_type"],
      rows,
    });
    expect(spec.kpis).toHaveLength(0);
    expect(spec.charts[0]).toMatchObject({ aggregation: "count", valueColumn: null });
  });

  it("skips high-cardinality categories", () => {
    const manyCols = [{ name: "code", type: "text" as const, original_name: "code" }];
    const manyRows = Array.from({ length: CATEGORY_MAX_DISTINCT + 5 }, (_, i) => ({
      code: `c${i}`,
    }));
    const spec = buildDashboardSpec({
      columns: manyCols,
      selectedColumns: ["code"],
      rows: manyRows,
    });
    expect(spec.charts).toHaveLength(0);
  });

  it("adds a scatter for two numerics and never exceeds the chart cap", () => {
    const spec = buildDashboardSpec({
      columns,
      selectedColumns: ["binder_pct", "air_voids"],
      rows,
    });
    expect(spec.charts.some((c) => c.kind === "scatter")).toBe(true);
    const full = buildDashboardSpec({
      columns,
      selectedColumns: columns.map((c) => c.name),
      rows,
    });
    expect(full.charts.length).toBeLessThanOrEqual(MAX_CHARTS);
  });
});
