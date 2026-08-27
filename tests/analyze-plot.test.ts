import { describe, expect, it } from "vitest";
import {
  ANALYZE_CATEGORY_CAP,
  analyzeKpis,
  analyzePlotTitle,
  buildAnalyzePlot,
  chartSeriesDataKey,
  defaultAnalyzeColumns,
  guessMeasureColumn,
  guessPlotDefaults,
  numericSelectedColumns,
  plotResultToChartTable,
  suggestNextPlot,
} from "../src/lib/analyze-plot.ts";

const dctColumns = [
  { name: "mix_id", type: "text" as const, original_name: "Mix ID" },
  { name: "specimen", type: "text" as const, original_name: "Specimen" },
  { name: "peak_load", type: "double precision" as const, original_name: "Peak load" },
  { name: "gf", type: "double precision" as const, original_name: "Gf" },
];

const dctRows = [
  { mix_id: "BL", specimen: "1", peak_load: 1200, gf: 400 },
  { mix_id: "BL", specimen: "2", peak_load: 1100, gf: 420 },
  { mix_id: "AC", specimen: "1", peak_load: 900, gf: 350 },
  { mix_id: "AC", specimen: "2", peak_load: null, gf: "" },
];

describe("analyze-plot", () => {
  it("guesses Gf as the measure and Mix ID vs mean Gf as the default bar", () => {
    expect(guessMeasureColumn(dctColumns)).toBe("gf");
    const spec = guessPlotDefaults(
      dctColumns,
      dctColumns.map((c) => c.name),
    );
    expect(spec).toMatchObject({
      kind: "bar",
      xColumn: "mix_id",
      yColumn: "gf",
      aggregation: "mean",
    });
    expect(analyzePlotTitle(spec)).toBe("Average gf by mix_id");
    // Spreadsheet headers replace SQL identifiers when a labeller is supplied.
    expect(
      analyzePlotTitle(spec, (n) => (n === "gf" ? "Fracture Energy (Gf)" : "Mix ID")),
    ).toBe("Average Fracture Energy (Gf) by Mix ID");
  });

  it("keeps Mix ID and Gf visible when the sheet has more than 12 columns", () => {
    const wide = [
      ...Array.from({ length: 12 }, (_, i) => ({
        name: `c${i}`,
        type: "text" as const,
        original_name: `c${i}`,
      })),
      { name: "mix_id", type: "text" as const, original_name: "Mix ID" },
      { name: "gf", type: "double precision" as const, original_name: "Gf" },
    ];
    const visible = defaultAnalyzeColumns(wide);
    expect(visible).toContain("mix_id");
    expect(visible).toContain("gf");
    expect(visible).toHaveLength(12);
  });

  it("averages Gf by mix and skips blank numeric cells", () => {
    const result = buildAnalyzePlot(
      { kind: "bar", xColumn: "mix_id", yColumn: "gf", aggregation: "mean" },
      dctRows,
    );
    expect(result).toMatchObject({ kind: "bar", aggregation: "mean" });
    expect(result!.data).toEqual([
      { label: "BL", value: 410 },
      { label: "AC", value: 350 },
    ]);
  });

  it("supports median, sum, and count aggregations", () => {
    const median = buildAnalyzePlot(
      { kind: "bar", xColumn: "mix_id", yColumn: "gf", aggregation: "median" },
      dctRows,
    );
    expect(median!.data.find((d) => d.label === "BL")?.value).toBe(410);

    const sum = buildAnalyzePlot(
      { kind: "bar", xColumn: "mix_id", yColumn: "gf", aggregation: "sum" },
      dctRows,
    );
    expect(sum!.data.find((d) => d.label === "BL")?.value).toBe(820);

    const count = buildAnalyzePlot(
      { kind: "bar", xColumn: "mix_id", yColumn: "gf", aggregation: "count" },
      dctRows,
    );
    expect(count!.data).toEqual([
      { label: "BL", value: 2 },
      { label: "AC", value: 2 },
    ]);
  });

  it("builds a scatter of Gf vs peak load and treats text-typed numerics as measures", () => {
    const scatter = buildAnalyzePlot(
      { kind: "scatter", xColumn: "peak_load", yColumn: "gf", aggregation: "mean" },
      dctRows,
    );
    expect(scatter).toMatchObject({ kind: "scatter", xColumn: "peak_load", yColumn: "gf" });
    expect(scatter!.data).toEqual([
      { x: 1200, y: 400 },
      { x: 1100, y: 420 },
      { x: 900, y: 350 },
    ]);

    const textTyped = [{ name: "gf", type: "text" as const, original_name: "Gf" }];
    expect(numericSelectedColumns(textTyped, ["gf"], [{ gf: "400.2" }, { gf: "350" }])).toEqual([
      "gf",
    ]);
  });

  it("caps bar categories and prefers Gf in the KPI strip", () => {
    const many = Array.from({ length: ANALYZE_CATEGORY_CAP + 3 }, (_, i) => ({
      mix_id: `M${i}`,
      gf: i + 1,
    }));
    const result = buildAnalyzePlot(
      { kind: "bar", xColumn: "mix_id", yColumn: "gf", aggregation: "mean" },
      many,
    );
    expect(result!.truncated).toBe(true);
    expect(result!.data).toHaveLength(ANALYZE_CATEGORY_CAP);

    const kpis = analyzeKpis(
      dctColumns,
      ["mix_id", "peak_load", "gf"],
      dctRows,
      ["gf"],
    );
    expect(kpis[0]?.column).toBe("gf");
    expect(kpis[0]?.count).toBe(3);
    expect(kpis[0]?.missing).toBe(1);
  });

  it("builds a line ordered by X and a two-bin histogram of Gf", () => {
    const line = buildAnalyzePlot(
      { kind: "line", xColumn: "specimen", yColumn: "gf", aggregation: "mean" },
      dctRows,
    );
    expect(line).toMatchObject({ kind: "line" });
    expect(line!.data.map((d) => d.label)).toEqual(["1", "2"]);
    expect(line!.data[0]).toMatchObject({ label: "1", value: 375 });

    const hist = buildAnalyzePlot(
      { kind: "histogram", xColumn: "gf", yColumn: "", aggregation: "count", bins: 2 },
      dctRows,
    );
    expect(hist).toMatchObject({ kind: "histogram" });
    expect(hist!.data).toHaveLength(2);
    const counts = hist!.data.map((d) => d.value as number);
    expect(counts.reduce((s, n) => s + n, 0)).toBe(3);
  });

  it("splits a bar and scatter by Mix ID series", () => {
    const bar = buildAnalyzePlot(
      {
        kind: "bar",
        xColumn: "specimen",
        yColumn: "gf",
        aggregation: "mean",
        seriesColumn: "mix_id",
      },
      dctRows,
    );
    expect(bar!.seriesKeys).toEqual(["BL", "AC"]);
    expect(bar!.data.find((d) => d.label === "1")).toMatchObject({ BL: 400, AC: 350 });

    const scatter = buildAnalyzePlot(
      {
        kind: "scatter",
        xColumn: "peak_load",
        yColumn: "gf",
        aggregation: "mean",
        seriesColumn: "mix_id",
      },
      dctRows,
    );
    expect(scatter).toMatchObject({ kind: "scatter" });
    expect(scatter!.groups.map((g) => g.key)).toEqual(["BL", "AC"]);
    expect(scatter!.groups.find((g) => g.key === "BL")!.data).toHaveLength(2);
  });

  it("keeps blank series cells and sanitizes numeric series keys for charts", () => {
    const rows = [
      { mix_id: "AC", temp: "-14.0", gf: 2000 },
      { mix_id: "AC", temp: "", gf: 1800 },
      { mix_id: "BL", temp: "-14.0", gf: 800 },
      { mix_id: "BL", temp: null, gf: 700 },
    ];
    const bar = buildAnalyzePlot(
      {
        kind: "bar",
        xColumn: "mix_id",
        yColumn: "gf",
        aggregation: "mean",
        seriesColumn: "temp",
      },
      rows,
    );
    expect(bar!.seriesKeys).toEqual(["-14.0", "(blank)"]);
    expect(bar!.data.find((d) => d.label === "AC")).toMatchObject({
      "(blank)": 1800,
      "-14.0": 2000,
    });
    expect(chartSeriesDataKey("-14.0")).toBe("s_14_0");
    expect(chartSeriesDataKey("BL")).toBe("BL");
  });

  it("suggests a second plot on an unused numeric and exports chart tables", () => {
    const first = guessPlotDefaults(
      dctColumns,
      dctColumns.map((c) => c.name),
    );
    const second = suggestNextPlot(
      dctColumns,
      dctColumns.map((c) => c.name),
      dctRows,
      [first],
    );
    expect(second.kind).toBe("bar");
    expect(second.xColumn).toBe("mix_id");
    expect(second.yColumn).toBe("peak_load");
    expect(second.id).not.toBe(first.id);

    const result = buildAnalyzePlot(first, dctRows);
    const table = plotResultToChartTable(result!);
    expect(table.headers).toEqual(["mix_id", "value"]);
    expect(table.rows[0]).toEqual(["BL", 410]);
  });

  it("leaves an untested combination empty instead of plotting it as zero", () => {
    // Section B was never tested with mix AC. A 0 there draws a bar and reads
    // as "measured, got zero"; null draws nothing, which is what happened.
    const rows = [
      { section: "A", mix_id: "BL", gf: 400 },
      { section: "A", mix_id: "AC", gf: 300 },
      { section: "B", mix_id: "BL", gf: 500 },
    ];
    const spec = {
      id: "p1",
      kind: "bar" as const,
      xColumn: "section",
      yColumn: "gf",
      aggregation: "mean" as const,
      seriesColumn: "mix_id",
      bins: 10,
    };
    const mean = buildAnalyzePlot(spec, rows);
    expect(mean!.data.find((d) => d.label === "B")).toEqual({ label: "B", BL: 500, AC: null });
    expect(plotResultToChartTable(mean!).rows).toContainEqual(["B", 500, null]);

    // A count of nothing genuinely is zero, so counts keep their zeros.
    const count = buildAnalyzePlot({ ...spec, aggregation: "count" as const }, rows);
    expect(count!.data.find((d) => d.label === "B")).toEqual({ label: "B", BL: 1, AC: 0 });
  });

  it("keeps empty histogram bins at zero", () => {
    // A bin is a range that was measured and found empty - not a gap.
    const result = buildAnalyzePlot(
      {
        id: "h1",
        kind: "histogram" as const,
        xColumn: "gf",
        yColumn: "",
        aggregation: "count" as const,
        seriesColumn: "",
        bins: 4,
      },
      [{ gf: 0 }, { gf: 1 }, { gf: 100 }],
    );
    expect(result!.data.every((d) => typeof d.value === "number")).toBe(true);
    expect(result!.data.some((d) => d.value === 0)).toBe(true);
  });
});
