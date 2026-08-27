import type { ColumnSchema } from "./csv";
import { guessIdColumn } from "./browse-sql";
import {
  classifyColumns,
  computeKpi,
  SCATTER_MAX_POINTS,
  SERIES_MAX_POINTS,
  toNumber,
  type ChartSpec,
  type DashboardSpec,
  type KpiCard,
} from "./dashboard-spec";

export const ANALYZE_CATEGORY_CAP = 40;
export const ANALYZE_KPI_CAP = 4;
export const ANALYZE_DEFAULT_VISIBLE_COLS = 12;
export const ANALYZE_MAX_PLOTS = 6;
export const ANALYZE_SERIES_CAP = 8;
export const ANALYZE_DEFAULT_BINS = 10;
export const SERIES_NONE = "__none__";

export type AnalyzePlotKind = "bar" | "line" | "scatter" | "histogram";
export type BarAggregation = "mean" | "median" | "count" | "sum";

export type AnalyzePlotSpec = {
  id: string;
  kind: AnalyzePlotKind;
  xColumn: string;
  yColumn: string;
  aggregation: BarAggregation;
  seriesColumn: string;
  bins: number;
};

// null means "this combination was never measured" — Recharts draws a gap for
// it, where a 0 would draw a real bar and read as a measurement of zero.
export type CategoryRow = { label: string } & Record<string, string | number | null>;

export type CategoryPlotResult = {
  kind: "bar" | "line" | "histogram";
  title: string;
  xColumn: string;
  yColumn: string | null;
  aggregation: BarAggregation | "bin";
  seriesColumn: string | null;
  seriesKeys: string[];
  data: CategoryRow[];
  truncated: boolean;
  pointCount: number;
};

export type ScatterPlotResult = {
  kind: "scatter";
  title: string;
  xColumn: string;
  yColumn: string;
  seriesColumn: string | null;
  seriesKeys: string[];
  groups: { key: string; data: { x: number; y: number }[] }[];
  data: { x: number; y: number }[];
  truncated: boolean;
  pointCount: number;
};

export type AnalyzePlotResult = CategoryPlotResult | ScatterPlotResult;

export type AnalyzeChartTable = {
  title: string;
  headers: string[];
  rows: (string | number | null)[][];
};

const MEASURE_RE =
  /\bgf\b|g_f|fracture|energy|flexibility|\bfi\b|i-?fit|peak.?load|voids?|air.?void|binder|modulus|stiffness/i;
const ID_NAME_RE = /(_id|id)$|mix|sample|specimen|section|code|lot|lab/;

let plotSeq = 0;

function toLabel(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function aggregateValues(values: number[], aggregation: BarAggregation): number {
  if (values.length === 0) return 0;
  if (aggregation === "count") return values.length;
  if (aggregation === "sum") return values.reduce((s, v) => s + v, 0);
  if (aggregation === "median") return median(values);
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function compareLabels(a: string, b: string): number {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatBin(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function normalizeSpec(spec: AnalyzePlotSpec | Omit<AnalyzePlotSpec, "id" | "seriesColumn" | "bins"> & Partial<AnalyzePlotSpec>): AnalyzePlotSpec {
  return {
    id: spec.id ?? newPlotId(),
    kind: spec.kind,
    xColumn: spec.xColumn,
    yColumn: spec.yColumn,
    aggregation: spec.aggregation,
    seriesColumn: spec.seriesColumn ?? "",
    bins: spec.bins ?? ANALYZE_DEFAULT_BINS,
  };
}

export function newPlotId(): string {
  plotSeq += 1;
  return `plot-${plotSeq}`;
}

export function createPlotSpec(init?: Partial<AnalyzePlotSpec>): AnalyzePlotSpec {
  return {
    id: init?.id ?? newPlotId(),
    kind: init?.kind ?? "bar",
    xColumn: init?.xColumn ?? "",
    yColumn: init?.yColumn ?? "",
    aggregation: init?.aggregation ?? "mean",
    seriesColumn: init?.seriesColumn ?? "",
    bins: init?.bins ?? ANALYZE_DEFAULT_BINS,
  };
}

/** Prefer fracture energy / FI / voids-style measures over IDs. */
export function guessMeasureColumn(columns: ColumnSchema[]): string {
  const candidates = columns.filter((c) => c.name !== "row_id");
  if (candidates.length === 0) return "";
  const scored = candidates.map((c) => {
    const n = c.name.toLowerCase();
    let score = 0;
    if (/\bgf\b|g_f|fracture/.test(n)) score += 14;
    else if (/flexibility|\bfi\b|i-?fit/.test(n)) score += 12;
    else if (MEASURE_RE.test(n)) score += 8;
    if (c.type === "double precision") score += 3;
    if (c.type === "integer") score += 1;
    if (ID_NAME_RE.test(n)) score -= 6;
    return { name: c.name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.score > 0 ? scored[0]!.name : "";
}

/** Keep Mix ID + Gf visible even when the sheet has more than 12 columns. */
export function defaultAnalyzeColumns(columns: ColumnSchema[]): string[] {
  const names = columns.map((c) => c.name).filter((n) => n !== "row_id");
  if (names.length <= ANALYZE_DEFAULT_VISIBLE_COLS) return names;
  const preferred = [guessIdColumn(columns), guessMeasureColumn(columns)].filter(
    (n, i, arr) => Boolean(n) && names.includes(n) && arr.indexOf(n) === i,
  );
  const rest = names.filter((n) => !preferred.includes(n));
  return [...preferred, ...rest].slice(0, ANALYZE_DEFAULT_VISIBLE_COLS);
}

function looksNumeric(rows: Record<string, unknown>[], column: string): boolean {
  let seen = 0;
  let ok = 0;
  for (const row of rows) {
    const raw = row[column];
    if (raw === null || raw === undefined || String(raw).trim() === "") continue;
    seen += 1;
    if (toNumber(raw) !== null) ok += 1;
    if (seen >= 40) break;
  }
  return seen > 0 && ok / seen >= 0.8;
}

/** Schema numerics plus text columns that parse as numbers in the working set. */
export function numericSelectedColumns(
  columns: ColumnSchema[],
  selected: string[],
  rows: Record<string, unknown>[],
): string[] {
  const bySchema = new Set(classifyColumns(columns, selected).numeric);
  const out: string[] = [];
  for (const name of selected) {
    if (bySchema.has(name)) {
      out.push(name);
      continue;
    }
    if (ID_NAME_RE.test(name.toLowerCase())) continue;
    if (looksNumeric(rows, name)) out.push(name);
  }
  return out;
}

export function plotSpecColumns(spec: AnalyzePlotSpec): string[] {
  return [spec.xColumn, spec.yColumn, spec.seriesColumn].filter(Boolean);
}

export function guessPlotDefaults(
  columns: ColumnSchema[],
  selected: string[],
  rows: Record<string, unknown>[] = [],
): AnalyzePlotSpec {
  const names = selected.filter((n) => n !== "row_id");
  const numeric = numericSelectedColumns(columns, names, rows);
  const selectedSchema = columns.filter((c) => names.includes(c.name));
  const id = guessIdColumn(selectedSchema.length > 0 ? selectedSchema : columns);
  const measure = guessMeasureColumn(selectedSchema.length > 0 ? selectedSchema : columns);

  const x =
    (names.includes(id) ? id : "") ||
    names.find((n) => !numeric.includes(n)) ||
    names[0] ||
    "";
  const y =
    (names.includes(measure) && measure !== x ? measure : "") ||
    numeric.find((n) => n !== x) ||
    "";

  if (x && y) {
    return createPlotSpec({ kind: "bar", xColumn: x, yColumn: y, aggregation: "mean" });
  }
  if (numeric.length >= 2) {
    return createPlotSpec({
      kind: "scatter",
      xColumn: numeric[0]!,
      yColumn: numeric[1]!,
      aggregation: "mean",
    });
  }
  return createPlotSpec({
    kind: "bar",
    xColumn: x,
    yColumn: y,
    aggregation: y ? "mean" : "count",
  });
}

export function suggestNextPlot(
  columns: ColumnSchema[],
  selected: string[],
  rows: Record<string, unknown>[],
  existing: AnalyzePlotSpec[],
): AnalyzePlotSpec {
  const numeric = numericSelectedColumns(columns, selected, rows);
  const { temporal } = classifyColumns(columns, selected);
  const used = new Set(existing.map((p) => `${p.kind}|${p.xColumn}|${p.yColumn}`));
  const base = existing[0];

  if (base?.xColumn) {
    for (const y of numeric) {
      if (y === base.xColumn) continue;
      const key = `bar|${base.xColumn}|${y}`;
      if (!used.has(key)) {
        return createPlotSpec({
          kind: "bar",
          xColumn: base.xColumn,
          yColumn: y,
          aggregation: "mean",
        });
      }
    }
  }

  if (numeric.length >= 2) {
    const key = `scatter|${numeric[0]}|${numeric[1]}`;
    if (!used.has(key)) {
      return createPlotSpec({
        kind: "scatter",
        xColumn: numeric[0]!,
        yColumn: numeric[1]!,
        aggregation: "mean",
      });
    }
  }

  if (numeric[0]) {
    const key = `histogram|${numeric[0]}|`;
    if (!used.has(key)) {
      return createPlotSpec({
        kind: "histogram",
        xColumn: numeric[0]!,
        yColumn: "",
        aggregation: "count",
        bins: ANALYZE_DEFAULT_BINS,
      });
    }
  }

  if (temporal[0] && numeric[0]) {
    const key = `line|${temporal[0]}|${numeric[0]}`;
    if (!used.has(key)) {
      return createPlotSpec({
        kind: "line",
        xColumn: temporal[0]!,
        yColumn: numeric[0]!,
        aggregation: "mean",
      });
    }
  }

  return createPlotSpec(guessPlotDefaults(columns, selected, rows));
}

/**
 * Titles are read by people, so they use spreadsheet headers when a labeller is
 * supplied. Defaults to the raw column name so callers without a schema still work.
 */
export function analyzePlotTitle(
  spec: AnalyzePlotSpec,
  label: (name: string) => string = (n) => n,
): string {
  const x = spec.xColumn ? label(spec.xColumn) : "";
  const y = spec.yColumn ? label(spec.yColumn) : "";
  const series = spec.seriesColumn ? ` split by ${label(spec.seriesColumn)}` : "";
  if (spec.kind === "scatter") {
    if (!spec.xColumn || !spec.yColumn) return "Scatter";
    return `${y} vs ${x}${series}`;
  }
  if (spec.kind === "histogram") {
    return spec.xColumn ? `Distribution of ${x}${series}` : "Histogram";
  }
  const aggLabel =
    spec.aggregation === "mean"
      ? "Average"
      : spec.aggregation === "median"
        ? "Median"
        : spec.aggregation === "sum"
          ? "Total"
          : "Count";
  if (spec.kind === "line") {
    if (!spec.xColumn || !spec.yColumn) return "Line";
    return `${aggLabel} ${y} over ${x}${series}`;
  }
  if (spec.aggregation === "count") {
    return spec.xColumn ? `Count by ${x}${series}` : "Bar";
  }
  if (!spec.xColumn || !spec.yColumn) return "Bar";
  return `${aggLabel} ${y} by ${x}${series}`;
}

/** Blank series cells stay in the plot instead of dropping the row. */
export const SERIES_BLANK = "(blank)";

/**
 * Recharts treats numeric-looking dataKeys (especially negatives like "-14.0")
 * as indexes and draws nothing. Keep display labels separate from object keys.
 */
export function chartSeriesDataKey(seriesKey: string): string {
  if (seriesKey === "value") return "value";
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seriesKey)) return seriesKey;
  return `s_${seriesKey.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "key"}`;
}

function topSeriesKeys(
  rows: Record<string, unknown>[],
  seriesColumn: string,
  cap = ANALYZE_SERIES_CAP,
): { keys: string[]; truncated: boolean } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = toLabel(row[seriesColumn]) ?? SERIES_BLANK;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const truncated = ranked.length > cap;
  const keys = ranked.slice(0, cap).map(([k]) => k);
  if (truncated) keys.push("Other");
  return { keys, truncated };
}

function seriesKeyFor(row: Record<string, unknown>, seriesColumn: string, keys: string[]): string | null {
  const raw = toLabel(row[seriesColumn]) ?? SERIES_BLANK;
  if (keys.includes(raw)) return raw;
  return keys.includes("Other") ? "Other" : null;
}

function groupCategory(
  rows: Record<string, unknown>[],
  xColumn: string,
  yColumn: string,
  aggregation: BarAggregation,
  seriesColumn: string,
): { data: CategoryRow[]; seriesKeys: string[]; truncated: boolean; pointCount: number } {
  const hasSeries = Boolean(seriesColumn);
  const seriesInfo = hasSeries ? topSeriesKeys(rows, seriesColumn) : { keys: ["value"], truncated: false };
  const buckets = new Map<string, Map<string, number[]>>();

  for (const row of rows) {
    const label = toLabel(row[xColumn]);
    if (label === null) continue;
    const series = hasSeries ? seriesKeyFor(row, seriesColumn, seriesInfo.keys) : "value";
    if (series === null) continue;
    if (aggregation !== "count") {
      const n = toNumber(row[yColumn]);
      if (n === null) continue;
      if (!buckets.has(label)) buckets.set(label, new Map());
      const inner = buckets.get(label)!;
      const arr = inner.get(series) ?? [];
      arr.push(n);
      inner.set(series, arr);
    } else {
      if (!buckets.has(label)) buckets.set(label, new Map());
      const inner = buckets.get(label)!;
      const arr = inner.get(series) ?? [];
      arr.push(1);
      inner.set(series, arr);
    }
  }

  const data: CategoryRow[] = [...buckets.entries()].map(([label, inner]) => {
    const row: CategoryRow = { label };
    for (const key of seriesInfo.keys) {
      const vals = inner.get(key) ?? [];
      // A count of nothing really is 0; a mean/median/sum of nothing is not a
      // number at all. Reporting those as 0 made a section x mix combination
      // that was never tested look like it had been tested and come out zero.
      if (vals.length === 0) row[key] = aggregation === "count" ? 0 : null;
      else row[key] = aggregateValues(vals, aggregation);
    }
    return row;
  });

  return {
    data,
    seriesKeys: seriesInfo.keys,
    truncated: seriesInfo.truncated || data.length > ANALYZE_CATEGORY_CAP,
    pointCount: data.length,
  };
}

function sortAndCapCategory(
  data: CategoryRow[],
  seriesKeys: string[],
  order: "value" | "label",
  cap: number,
): { data: CategoryRow[]; truncated: boolean } {
  const sorted =
    order === "label"
      ? [...data].sort((a, b) => compareLabels(String(a.label), String(b.label)))
      : [...data].sort((a, b) => {
          const sum = (row: CategoryRow) =>
            seriesKeys.reduce((s, k) => s + (typeof row[k] === "number" ? (row[k] as number) : 0), 0);
          return sum(b) - sum(a);
        });
  return { data: sorted.slice(0, cap), truncated: sorted.length > cap };
}

function downsampleCategory(data: CategoryRow[], cap: number): { data: CategoryRow[]; truncated: boolean } {
  if (data.length <= cap) return { data, truncated: false };
  const step = Math.ceil(data.length / cap);
  return { data: data.filter((_, i) => i % step === 0), truncated: true };
}

function scatterPoints(
  rows: Record<string, unknown>[],
  xColumn: string,
  yColumn: string,
  seriesColumn: string,
): {
  data: { x: number; y: number }[];
  groups: { key: string; data: { x: number; y: number }[] }[];
  seriesKeys: string[];
  truncated: boolean;
  pointCount: number;
} {
  const hasSeries = Boolean(seriesColumn);
  const seriesInfo = hasSeries ? topSeriesKeys(rows, seriesColumn) : { keys: ["value"], truncated: false };
  const groups = new Map<string, { x: number; y: number }[]>();
  for (const key of seriesInfo.keys) groups.set(key, []);

  const pairs: { x: number; y: number }[] = [];
  for (const row of rows) {
    const x = toNumber(row[xColumn]);
    const y = toNumber(row[yColumn]);
    if (x === null || y === null) continue;
    const series = hasSeries ? seriesKeyFor(row, seriesColumn, seriesInfo.keys) : "value";
    if (series === null) continue;
    pairs.push({ x, y });
    groups.get(series)?.push({ x, y });
  }

  const downsample = <T,>(arr: T[]): T[] => {
    if (arr.length <= SCATTER_MAX_POINTS) return arr;
    const step = Math.ceil(arr.length / SCATTER_MAX_POINTS);
    return arr.filter((_, i) => i % step === 0);
  };

  const truncated = pairs.length > SCATTER_MAX_POINTS || seriesInfo.truncated;
  return {
    data: downsample(pairs),
    groups: seriesInfo.keys.map((key) => ({ key, data: downsample(groups.get(key) ?? []) })),
    seriesKeys: seriesInfo.keys,
    truncated,
    pointCount: pairs.length,
  };
}

function buildHistogram(
  rows: Record<string, unknown>[],
  xColumn: string,
  binCount: number,
  seriesColumn: string,
): { data: CategoryRow[]; seriesKeys: string[]; truncated: boolean; pointCount: number } | null {
  const nBins = Math.max(2, Math.min(binCount, 30));
  const hasSeries = Boolean(seriesColumn);
  const seriesInfo = hasSeries ? topSeriesKeys(rows, seriesColumn) : { keys: ["value"], truncated: false };
  const points: { value: number; series: string }[] = [];

  for (const row of rows) {
    const value = toNumber(row[xColumn]);
    if (value === null) continue;
    const series = hasSeries ? seriesKeyFor(row, seriesColumn, seriesInfo.keys) : "value";
    if (series === null) continue;
    points.push({ value, series });
  }
  if (points.length === 0) return null;

  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const width = max === min ? 1 : (max - min) / nBins;

  const data: CategoryRow[] = [];
  for (let i = 0; i < nBins; i += 1) {
    const lo = min + i * width;
    const hi = i === nBins - 1 || max === min ? max : lo + width;
    const label = max === min ? formatBin(min) : `${formatBin(lo)}-${formatBin(hi)}`;
    const row: CategoryRow = { label };
    for (const key of seriesInfo.keys) row[key] = 0;
    data.push(row);
  }

  for (const p of points) {
    let idx = max === min ? 0 : Math.floor((p.value - min) / width);
    if (idx >= nBins) idx = nBins - 1;
    if (idx < 0) idx = 0;
    const cur = data[idx]![p.series];
    data[idx]![p.series] = (typeof cur === "number" ? cur : 0) + 1;
  }

  return {
    data,
    seriesKeys: seriesInfo.keys,
    truncated: seriesInfo.truncated,
    pointCount: points.length,
  };
}

export function buildAnalyzePlot(
  spec: AnalyzePlotSpec | Omit<AnalyzePlotSpec, "id" | "seriesColumn" | "bins">,
  rows: Record<string, unknown>[],
  label: (name: string) => string = (n) => n,
): AnalyzePlotResult | null {
  const full = normalizeSpec(spec);
  if (!full.xColumn) return null;

  if (full.kind === "scatter") {
    if (!full.yColumn) return null;
    const built = scatterPoints(rows, full.xColumn, full.yColumn, full.seriesColumn);
    if (built.data.length === 0) return null;
    return {
      kind: "scatter",
      title: analyzePlotTitle(full, label),
      xColumn: full.xColumn,
      yColumn: full.yColumn,
      seriesColumn: full.seriesColumn || null,
      seriesKeys: built.seriesKeys,
      groups: built.groups,
      data: built.data,
      truncated: built.truncated,
      pointCount: built.pointCount,
    };
  }

  if (full.kind === "histogram") {
    const built = buildHistogram(rows, full.xColumn, full.bins, full.seriesColumn);
    if (!built) return null;
    return {
      kind: "histogram",
      title: analyzePlotTitle(full, label),
      xColumn: full.xColumn,
      yColumn: null,
      aggregation: "bin",
      seriesColumn: full.seriesColumn || null,
      seriesKeys: built.seriesKeys,
      data: built.data,
      truncated: built.truncated,
      pointCount: built.pointCount,
    };
  }

  if (full.aggregation !== "count" && !full.yColumn) return null;
  const grouped = groupCategory(rows, full.xColumn, full.yColumn, full.aggregation, full.seriesColumn);
  if (grouped.data.length === 0) return null;

  const ordered =
    full.kind === "line"
      ? downsampleCategory(
          sortAndCapCategory(grouped.data, grouped.seriesKeys, "label", grouped.data.length).data,
          SERIES_MAX_POINTS,
        )
      : sortAndCapCategory(grouped.data, grouped.seriesKeys, "value", ANALYZE_CATEGORY_CAP);

  return {
    kind: full.kind,
    title: analyzePlotTitle(full, label),
    xColumn: full.xColumn,
    yColumn: full.aggregation === "count" ? null : full.yColumn,
    aggregation: full.aggregation,
    seriesColumn: full.seriesColumn || null,
    seriesKeys: grouped.seriesKeys,
    data: ordered.data,
    truncated: grouped.truncated || ordered.truncated,
    pointCount: grouped.pointCount,
  };
}

export function analyzeKpis(
  columns: ColumnSchema[],
  selected: string[],
  rows: Record<string, unknown>[],
  preferred: string[] = [],
): KpiCard[] {
  const numeric = numericSelectedColumns(columns, selected, rows);
  const ordered = [
    ...preferred.filter((n) => numeric.includes(n)),
    ...numeric.filter((n) => !preferred.includes(n)),
  ];
  return ordered.slice(0, ANALYZE_KPI_CAP).map((column) => computeKpi(rows, column));
}

export function plotResultToChartTable(result: AnalyzePlotResult): AnalyzeChartTable {
  if (result.kind === "scatter") {
    const headers = result.seriesColumn
      ? [result.xColumn, result.yColumn, result.seriesColumn]
      : [result.xColumn, result.yColumn];
    const rows: (string | number | null)[][] = [];
    if (result.seriesColumn) {
      for (const group of result.groups) {
        for (const p of group.data) rows.push([p.x, p.y, group.key]);
      }
    } else {
      for (const p of result.data) rows.push([p.x, p.y]);
    }
    return { title: result.title, headers, rows };
  }

  const headers = [result.xColumn, ...result.seriesKeys];
  const rows = result.data.map((row) => [
    row.label,
    ...result.seriesKeys.map((k) => (typeof row[k] === "number" ? (row[k] as number) : null)),
  ]);
  return { title: result.title, headers, rows };
}

export function analyzeToDashboardSpec(args: {
  kpis: KpiCard[];
  results: AnalyzePlotResult[];
}): DashboardSpec {
  const charts: ChartSpec[] = [];
  for (const [i, result] of args.results.entries()) {
    const id = `analyze-${i}`;
    if (result.kind === "scatter") {
      charts.push({
        id,
        kind: "scatter",
        title: result.title,
        xColumn: result.xColumn,
        yColumn: result.yColumn,
        data: result.data,
      });
      continue;
    }
    const valueKey = result.seriesKeys[0] ?? "value";
    const data = result.data.map((row) => ({
      label: String(row.label),
      value: typeof row[valueKey] === "number" ? (row[valueKey] as number) : 0,
    }));
    if (result.kind === "line") {
      charts.push({
        id,
        kind: "line",
        title: result.title,
        xColumn: result.xColumn,
        yColumn: result.yColumn ?? valueKey,
        data,
      });
    } else {
      charts.push({
        id,
        kind: "bar",
        title: result.title,
        categoryColumn: result.xColumn,
        valueColumn: result.yColumn,
        aggregation: result.aggregation === "count" || result.kind === "histogram" ? "count" : "average",
        data,
      });
    }
  }
  return { kpis: args.kpis, charts };
}
