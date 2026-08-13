import type { ColumnSchema } from "./csv";
import {
  BROWSE_FETCH_LIMIT,
  type BrowseFilterOp,
  buildBrowseSql,
  guessIdColumn,
  litValue,
  quoteIdent,
} from "./browse-sql";
import {
  createPlotSpec,
  defaultAnalyzeColumns,
  guessMeasureColumn,
  guessPlotDefaults,
  type AnalyzePlotKind,
  type AnalyzePlotSpec,
  type BarAggregation,
} from "./analyze-plot";

export type AnalyzeColumnRef = {
  name: string;
  table: "left" | "right";
  column: string;
};

export type AnalyzeJoin = {
  leftTable: string;
  rightTable: string;
  leftColumn: string;
  rightColumn: string;
};

export type AnalyzeViewSpec = {
  version: 1;
  leftTable: string;
  join: Omit<AnalyzeJoin, "leftTable"> | null;
  visibleCols: string[];
  filter: { column: string; op: BrowseFilterOp; value: string } | null;
  plots: AnalyzePlotSpec[];
};

const PLOT_KINDS: AnalyzePlotKind[] = ["bar", "line", "scatter", "histogram"];
const AGGS: BarAggregation[] = ["mean", "median", "count", "sum"];

export function guessJoinColumns(
  left: ColumnSchema[],
  right: ColumnSchema[],
): { leftColumn: string; rightColumn: string } {
  const rightSet = new Set(right.map((c) => c.name));
  const shared = left
    .map((c) => c.name)
    .filter((n) => n !== "row_id" && rightSet.has(n))
    .map((n) => {
      const l = n.toLowerCase();
      let score = 0;
      if (/mix/.test(l) && /id/.test(l)) score += 12;
      if (/specimen/.test(l)) score += 9;
      if (/(_id|id)$/.test(l)) score += 6;
      if (/sample|section|code/.test(l)) score += 4;
      return { n, score };
    });
  shared.sort((a, b) => b.score - a.score);
  if (shared[0]) {
    return { leftColumn: shared[0].n, rightColumn: shared[0].n };
  }
  return { leftColumn: guessIdColumn(left), rightColumn: guessIdColumn(right) };
}

export function planJoinColumns(leftCols: string[], rightCols: string[]): AnalyzeColumnRef[] {
  const left = leftCols
    .filter((n) => n !== "row_id")
    .map((column) => ({ name: column, table: "left" as const, column }));
  const taken = new Set(left.map((c) => c.name));
  const right: AnalyzeColumnRef[] = [];
  for (const column of rightCols.filter((n) => n !== "row_id")) {
    let name = taken.has(column) ? `t2_${column}` : column;
    if (taken.has(name)) name = `t2_${column}_2`;
    taken.add(name);
    right.push({ name, table: "right", column });
  }
  return [...left, ...right];
}

export function toWorkingSchema(
  refs: AnalyzeColumnRef[],
  leftSchema: ColumnSchema[],
  rightSchema: ColumnSchema[],
): ColumnSchema[] {
  const leftMap = new Map(leftSchema.map((c) => [c.name, c]));
  const rightMap = new Map(rightSchema.map((c) => [c.name, c]));
  return refs.map((ref) => {
    const src = ref.table === "left" ? leftMap.get(ref.column) : rightMap.get(ref.column);
    return {
      name: ref.name,
      original_name: src?.original_name ?? ref.column,
      type: src?.type ?? "text",
    };
  });
}

export function defaultJoinVisibleColumns(
  refs: AnalyzeColumnRef[],
  leftSchema: ColumnSchema[],
  rightSchema: ColumnSchema[],
): string[] {
  const schema = toWorkingSchema(refs, leftSchema, rightSchema);
  const base = defaultAnalyzeColumns(schema);
  const extras = [
    refs.find((r) => r.table === "left" && r.column === guessIdColumn(leftSchema))?.name,
    refs.find((r) => r.table === "left" && r.column === guessMeasureColumn(leftSchema))?.name,
    refs.find((r) => r.table === "right" && r.column === guessMeasureColumn(rightSchema))?.name,
  ].filter((n): n is string => Boolean(n));
  return [...new Set([...extras, ...base])];
}

export function guessJoinedPlotDefaults(
  refs: AnalyzeColumnRef[],
  leftSchema: ColumnSchema[],
  rightSchema: ColumnSchema[],
  selected: string[],
  rows: Record<string, unknown>[] = [],
): AnalyzePlotSpec {
  const x = refs.find(
    (r) => r.table === "left" && r.column === guessMeasureColumn(leftSchema),
  )?.name;
  const y = refs.find(
    (r) => r.table === "right" && r.column === guessMeasureColumn(rightSchema),
  )?.name;
  if (x && y && x !== y && selected.includes(x) && selected.includes(y)) {
    return createPlotSpec({ kind: "scatter", xColumn: x, yColumn: y, aggregation: "mean" });
  }
  return guessPlotDefaults(toWorkingSchema(refs, leftSchema, rightSchema), selected, rows);
}

function filterSql(
  expr: string,
  op: BrowseFilterOp | undefined,
  value: string | undefined,
): string {
  const raw = (value ?? "").trim();
  const filterOp = op ?? "equals";
  if (!raw && filterOp !== "equals") return "";
  if (filterOp === "equals" && raw.length > 0) {
    return `CAST(${expr} AS TEXT) = ${litValue(raw)}`;
  }
  if (filterOp === "contains" && raw.length > 0) {
    return `CAST(${expr} AS TEXT) LIKE ${litValue(`%${raw}%`)}`;
  }
  if (filterOp === "in" && raw.length > 0) {
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(litValue);
    if (items.length === 1) return `CAST(${expr} AS TEXT) = ${items[0]}`;
    if (items.length > 1) return `CAST(${expr} AS TEXT) IN (${items.join(", ")})`;
  }
  return "";
}

function sqlExprFor(ref: AnalyzeColumnRef): string {
  const alias = ref.table === "left" ? "t1" : "t2";
  return `${alias}.${quoteIdent(ref.column)}`;
}

export function buildAnalyzeSql(args: {
  leftTable: string;
  requested: string[];
  join?: AnalyzeJoin | null;
  columnRefs?: AnalyzeColumnRef[];
  filterColumn?: string;
  filterOp?: BrowseFilterOp;
  filterValue?: string;
  limit?: number;
}): string {
  if (!args.join) {
    return buildBrowseSql({
      tableName: args.leftTable,
      columns: args.requested,
      filterColumn: args.filterColumn,
      filterOp: args.filterOp,
      filterValue: args.filterValue,
      limit: args.limit,
    });
  }

  const refs = args.columnRefs ?? [];
  const wanted = new Set(args.requested.filter((n) => n !== "row_id"));
  const selected = refs.filter((r) => wanted.has(r.name));
  const selectParts = [
    `t1.row_id AS ${quoteIdent("row_id")}`,
    ...selected.map((r) => `${sqlExprFor(r)} AS ${quoteIdent(r.name)}`),
  ];

  const onExpr = `CAST(t1.${quoteIdent(args.join.leftColumn)} AS TEXT) = CAST(t2.${quoteIdent(args.join.rightColumn)} AS TEXT)`;
  let sql = `SELECT ${selectParts.join(", ")} FROM ${args.join.leftTable} AS t1 JOIN ${args.join.rightTable} AS t2 ON ${onExpr}`;

  const filterRef = refs.find((r) => r.name === args.filterColumn);
  const filterExpr = filterRef
    ? filterSql(sqlExprFor(filterRef), args.filterOp, args.filterValue)
    : "";
  if (filterExpr) sql += ` WHERE ${filterExpr}`;

  const limit = Math.min(Math.max(args.limit ?? BROWSE_FETCH_LIMIT, 1), BROWSE_FETCH_LIMIT);
  sql += ` LIMIT ${limit}`;
  return sql;
}

export function buildJoinUnmatchedSql(join: AnalyzeJoin): string {
  const leftCol = quoteIdent(join.leftColumn);
  const rightCol = quoteIdent(join.rightColumn);
  return `SELECT (SELECT COUNT(*) FROM ${join.leftTable} t1 WHERE t1.${leftCol} IS NOT NULL AND CAST(t1.${leftCol} AS TEXT) != '' AND NOT EXISTS (SELECT 1 FROM ${join.rightTable} t2 WHERE CAST(t2.${rightCol} AS TEXT) = CAST(t1.${leftCol} AS TEXT))) AS unmatched_left, (SELECT COUNT(*) FROM ${join.rightTable} t2 WHERE t2.${rightCol} IS NOT NULL AND CAST(t2.${rightCol} AS TEXT) != '' AND NOT EXISTS (SELECT 1 FROM ${join.leftTable} t1 WHERE CAST(t1.${leftCol} AS TEXT) = CAST(t2.${rightCol} AS TEXT))) AS unmatched_right`;
}

function asPlotSpec(raw: unknown): AnalyzePlotSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.kind !== "string" || !PLOT_KINDS.includes(p.kind as AnalyzePlotKind)) return null;
  const aggregation = AGGS.includes(p.aggregation as BarAggregation)
    ? (p.aggregation as BarAggregation)
    : "mean";
  return createPlotSpec({
    id: typeof p.id === "string" ? p.id : undefined,
    kind: p.kind as AnalyzePlotKind,
    xColumn: typeof p.xColumn === "string" ? p.xColumn : "",
    yColumn: typeof p.yColumn === "string" ? p.yColumn : "",
    aggregation,
    seriesColumn: typeof p.seriesColumn === "string" ? p.seriesColumn : "",
    bins: typeof p.bins === "number" && Number.isFinite(p.bins) ? p.bins : 10,
  });
}

export function parseAnalyzeViewSpec(raw: unknown): AnalyzeViewSpec {
  const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!obj || typeof obj !== "object") throw new Error("Invalid analysis spec");
  const s = obj as Record<string, unknown>;
  if (typeof s.leftTable !== "string" || !s.leftTable) throw new Error("Analysis is missing a table");
  const plots = Array.isArray(s.plots)
    ? s.plots.map(asPlotSpec).filter((p): p is AnalyzePlotSpec => p !== null)
    : [];
  if (plots.length === 0) throw new Error("Analysis has no plots");

  let join: AnalyzeViewSpec["join"] = null;
  if (s.join && typeof s.join === "object") {
    const j = s.join as Record<string, unknown>;
    if (
      typeof j.rightTable === "string" &&
      typeof j.leftColumn === "string" &&
      typeof j.rightColumn === "string" &&
      j.rightTable &&
      j.leftColumn &&
      j.rightColumn
    ) {
      join = {
        rightTable: j.rightTable,
        leftColumn: j.leftColumn,
        rightColumn: j.rightColumn,
      };
    }
  }

  let filter: AnalyzeViewSpec["filter"] = null;
  if (s.filter && typeof s.filter === "object") {
    const f = s.filter as Record<string, unknown>;
    if (
      typeof f.column === "string" &&
      typeof f.op === "string" &&
      typeof f.value === "string" &&
      (f.op === "in" || f.op === "equals" || f.op === "contains")
    ) {
      filter = { column: f.column, op: f.op, value: f.value };
    }
  }

  return {
    version: 1,
    leftTable: s.leftTable,
    join,
    visibleCols: Array.isArray(s.visibleCols)
      ? s.visibleCols.filter((n): n is string => typeof n === "string")
      : [],
    filter,
    plots,
  };
}

export function buildAnalyzeViewSpec(args: {
  leftTable: string;
  join: AnalyzeJoin | null;
  visibleCols: string[];
  filter: { column: string; op: BrowseFilterOp; value: string } | null;
  plots: AnalyzePlotSpec[];
}): AnalyzeViewSpec {
  return {
    version: 1,
    leftTable: args.leftTable,
    join: args.join
      ? {
          rightTable: args.join.rightTable,
          leftColumn: args.join.leftColumn,
          rightColumn: args.join.rightColumn,
        }
      : null,
    visibleCols: args.visibleCols,
    filter: args.filter,
    plots: args.plots,
  };
}
