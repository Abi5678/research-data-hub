import type { ColumnKind, ColumnSchema } from "@/lib/csv";

export const MAX_CHARTS = 4;
export const CATEGORY_MAX_DISTINCT = 25;
export const SCATTER_MAX_POINTS = 2000;
export const SERIES_MAX_POINTS = 200;

export type KpiCard = {
  column: string;
  count: number;
  missing: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
};

export type ChartSpec =
  | {
      id: string;
      kind: "line";
      title: string;
      xColumn: string;
      yColumn: string;
      data: { label: string; value: number }[];
    }
  | {
      id: string;
      kind: "bar";
      title: string;
      categoryColumn: string;
      valueColumn: string | null;
      aggregation: "average" | "count";
      data: { label: string; value: number }[];
    }
  | {
      id: string;
      kind: "scatter";
      title: string;
      xColumn: string;
      yColumn: string;
      data: { x: number; y: number }[];
    };

export type DashboardSpec = {
  kpis: KpiCard[];
  charts: ChartSpec[];
};

const NUMERIC_KINDS: ColumnKind[] = ["integer", "double precision"];
const TEMPORAL_KINDS: ColumnKind[] = ["date", "timestamptz"];
const CATEGORICAL_KINDS: ColumnKind[] = ["text", "boolean"];

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toLabel(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function classifyColumns(
  columns: ColumnSchema[],
  selected: string[],
): { numeric: string[]; temporal: string[]; categorical: string[] } {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const numeric: string[] = [];
  const temporal: string[] = [];
  const categorical: string[] = [];
  for (const name of selected) {
    const kind = byName.get(name)?.type;
    if (!kind) continue;
    if (NUMERIC_KINDS.includes(kind)) numeric.push(name);
    else if (TEMPORAL_KINDS.includes(kind)) temporal.push(name);
    else if (CATEGORICAL_KINDS.includes(kind)) categorical.push(name);
  }
  return { numeric, temporal, categorical };
}

export function computeKpi(rows: Record<string, unknown>[], column: string): KpiCard {
  const values: number[] = [];
  for (const row of rows) {
    const n = toNumber(row[column]);
    if (n !== null) values.push(n);
  }
  const count = values.length;
  const missing = rows.length - count;
  if (count === 0) {
    return { column, count: 0, missing, min: null, max: null, mean: null, median: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return {
    column,
    count,
    missing,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: values.reduce((s, v) => s + v, 0) / count,
    median,
  };
}

/** Distinct non-empty label count, short-circuited once past the cap. */
export function distinctLabels(
  rows: Record<string, unknown>[],
  column: string,
  cap = CATEGORY_MAX_DISTINCT,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const label = toLabel(row[column]);
    if (label === null) continue;
    seen.add(label);
    if (seen.size > cap) break;
  }
  return [...seen];
}

function groupAverage(
  rows: Record<string, unknown>[],
  categoryColumn: string,
  valueColumn: string,
): { label: string; value: number }[] {
  const sums = new Map<string, { total: number; n: number }>();
  for (const row of rows) {
    const label = toLabel(row[categoryColumn]);
    const value = toNumber(row[valueColumn]);
    if (label === null || value === null) continue;
    const entry = sums.get(label) ?? { total: 0, n: 0 };
    entry.total += value;
    entry.n += 1;
    sums.set(label, entry);
  }
  return [...sums.entries()]
    .map(([label, { total, n }]) => ({ label, value: total / n }))
    .sort((a, b) => b.value - a.value)
    .slice(0, CATEGORY_MAX_DISTINCT);
}

function groupCount(
  rows: Record<string, unknown>[],
  categoryColumn: string,
): { label: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = toLabel(row[categoryColumn]);
    if (label === null) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, CATEGORY_MAX_DISTINCT);
}

function timeSeries(
  rows: Record<string, unknown>[],
  xColumn: string,
  yColumn: string,
): { label: string; value: number }[] {
  const buckets = new Map<string, { total: number; n: number }>();
  for (const row of rows) {
    const label = toLabel(row[xColumn]);
    const value = toNumber(row[yColumn]);
    if (label === null || value === null) continue;
    const entry = buckets.get(label) ?? { total: 0, n: 0 };
    entry.total += value;
    entry.n += 1;
    buckets.set(label, entry);
  }
  const points = [...buckets.entries()]
    .map(([label, { total, n }]) => ({ label, value: total / n }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  if (points.length <= SERIES_MAX_POINTS) return points;
  const step = Math.ceil(points.length / SERIES_MAX_POINTS);
  return points.filter((_, i) => i % step === 0);
}

function scatterPoints(
  rows: Record<string, unknown>[],
  xColumn: string,
  yColumn: string,
): { x: number; y: number }[] {
  const pairs: { x: number; y: number }[] = [];
  for (const row of rows) {
    const x = toNumber(row[xColumn]);
    const y = toNumber(row[yColumn]);
    if (x === null || y === null) continue;
    pairs.push({ x, y });
  }
  if (pairs.length <= SCATTER_MAX_POINTS) return pairs;
  const step = Math.ceil(pairs.length / SCATTER_MAX_POINTS);
  return pairs.filter((_, i) => i % step === 0);
}

export function buildDashboardSpec(args: {
  columns: ColumnSchema[];
  selectedColumns: string[];
  rows: Record<string, unknown>[];
  maxCharts?: number;
}): DashboardSpec {
  const { columns, selectedColumns, rows } = args;
  const maxCharts = args.maxCharts ?? MAX_CHARTS;
  const { numeric, temporal, categorical } = classifyColumns(columns, selectedColumns);

  const kpis = numeric.map((c) => computeKpi(rows, c));

  // Categorical columns are only chartable when their cardinality stays readable.
  const lowCardinality = categorical.filter(
    (c) => distinctLabels(rows, c).length <= CATEGORY_MAX_DISTINCT,
  );

  const charts: ChartSpec[] = [];
  const push = (chart: ChartSpec) => {
    if (charts.length < maxCharts) charts.push(chart);
  };

  for (const x of temporal) {
    for (const y of numeric) {
      const data = timeSeries(rows, x, y);
      if (data.length > 1) {
        push({
          id: `line-${x}-${y}`,
          kind: "line",
          title: `${y} over ${x}`,
          xColumn: x,
          yColumn: y,
          data,
        });
      }
      if (charts.length >= maxCharts) return { kpis, charts };
    }
  }

  for (const category of lowCardinality) {
    for (const value of numeric) {
      const data = groupAverage(rows, category, value);
      if (data.length > 0) {
        push({
          id: `bar-${category}-${value}`,
          kind: "bar",
          title: `Average ${value} by ${category}`,
          categoryColumn: category,
          valueColumn: value,
          aggregation: "average",
          data,
        });
      }
      if (charts.length >= maxCharts) return { kpis, charts };
    }
  }

  for (const category of lowCardinality) {
    const alreadyCharted = charts.some((c) => c.kind === "bar" && c.categoryColumn === category);
    if (alreadyCharted) continue;
    const data = groupCount(rows, category);
    if (data.length > 0) {
      push({
        id: `count-${category}`,
        kind: "bar",
        title: `Row count by ${category}`,
        categoryColumn: category,
        valueColumn: null,
        aggregation: "count",
        data,
      });
    }
    if (charts.length >= maxCharts) return { kpis, charts };
  }

  if (numeric.length >= 2) {
    const [x, y] = [numeric[0]!, numeric[1]!];
    const data = scatterPoints(rows, x, y);
    if (data.length > 1) {
      push({
        id: `scatter-${x}-${y}`,
        kind: "scatter",
        title: `${y} vs ${x}`,
        xColumn: x,
        yColumn: y,
        data,
      });
    }
  }

  return { kpis, charts };
}

export function formatKpiValue(v: number | null): string {
  if (v === null) return "-";
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
