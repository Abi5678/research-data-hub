import type { ColumnKind, ColumnSchema } from "./csv";

export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts_with"
  | "is_null"
  | "not_null";

export type Filter = {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
};

export type SortSpec = {
  column: string;
  direction: "asc" | "desc";
};

export type AggFn = "count" | "sum" | "avg" | "min" | "max";

export type QuerySpec = {
  select: string[]; // if empty & no groupBy -> all columns
  filters: Filter[];
  sort: SortSpec[];
  groupBy: string[];
  aggregations: { column: string; fn: AggFn; alias: string }[];
  limit?: number;
};

export const emptyQuery = (): QuerySpec => ({
  select: [],
  filters: [],
  sort: [],
  groupBy: [],
  aggregations: [],
  limit: 500,
});

function coerceForCompare(kind: ColumnKind, raw: string): number | string | boolean | null {
  if (raw === "") return null;
  if (kind === "integer" || kind === "double precision") {
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  }
  if (kind === "boolean") return raw === "true";
  return raw;
}

function matches(
  row: Record<string, unknown>,
  filter: Filter,
  schema: Map<string, ColumnKind>,
): boolean {
  const cell = row[filter.column];
  const kind = schema.get(filter.column) ?? "text";
  const v = coerceForCompare(kind, filter.value);
  switch (filter.op) {
    case "is_null":
      return cell === null || cell === undefined || cell === "";
    case "not_null":
      return !(cell === null || cell === undefined || cell === "");
    case "eq":
      return cell == v;
    case "neq":
      return cell != v;
    case "gt":
      return cell != null && v != null && (cell as number) > (v as number);
    case "gte":
      return cell != null && v != null && (cell as number) >= (v as number);
    case "lt":
      return cell != null && v != null && (cell as number) < (v as number);
    case "lte":
      return cell != null && v != null && (cell as number) <= (v as number);
    case "contains":
      return String(cell ?? "").toLowerCase().includes(String(v ?? "").toLowerCase());
    case "starts_with":
      return String(cell ?? "").toLowerCase().startsWith(String(v ?? "").toLowerCase());
  }
}

export function runQuery(
  rows: Record<string, unknown>[],
  columns: ColumnSchema[],
  spec: QuerySpec,
): { columns: string[]; rows: Record<string, unknown>[] } {
  const schema = new Map(columns.map((c) => [c.name, c.type]));

  // filter
  let out = rows;
  if (spec.filters.length) {
    out = out.filter((row) => spec.filters.every((f) => matches(row, f, schema)));
  }

  // group + aggregate
  if (spec.groupBy.length || spec.aggregations.length) {
    const keyFn = (row: Record<string, unknown>) =>
      spec.groupBy.map((c) => String(row[c] ?? "∅")).join("\u241f");
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of out) {
      const k = keyFn(row);
      let list = groups.get(k);
      if (!list) {
        list = [];
        groups.set(k, list);
      }
      list.push(row);
    }
    const aggregated: Record<string, unknown>[] = [];
    for (const list of groups.values()) {
      const first = list[0]!;
      const result: Record<string, unknown> = {};
      for (const g of spec.groupBy) result[g] = first[g];
      for (const a of spec.aggregations) {
        const values = list.map((r) => r[a.column]).filter((v) => v !== null && v !== "");
        const nums = values.map(Number).filter((n) => !Number.isNaN(n));
        let v: number | null = null;
        switch (a.fn) {
          case "count":
            v = values.length;
            break;
          case "sum":
            v = nums.reduce((s, n) => s + n, 0);
            break;
          case "avg":
            v = nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
            break;
          case "min":
            v = nums.length ? Math.min(...nums) : null;
            break;
          case "max":
            v = nums.length ? Math.max(...nums) : null;
            break;
        }
        result[a.alias] = v;
      }
      aggregated.push(result);
    }
    out = aggregated;
  } else if (spec.select.length) {
    out = out.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of spec.select) o[c] = r[c];
      return o;
    });
  }

  // sort
  if (spec.sort.length) {
    out = [...out].sort((a, b) => {
      for (const s of spec.sort) {
        const av = a[s.column];
        const bv = b[s.column];
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv));
        return s.direction === "asc" ? cmp : -cmp;
      }
      return 0;
    });
  }

  // determine output columns
  let outCols: string[];
  if (spec.groupBy.length || spec.aggregations.length) {
    outCols = [...spec.groupBy, ...spec.aggregations.map((a) => a.alias)];
  } else if (spec.select.length) {
    outCols = spec.select;
  } else {
    outCols = columns.map((c) => c.name);
  }

  // limit
  if (spec.limit && out.length > spec.limit) out = out.slice(0, spec.limit);

  return { columns: outCols, rows: out };
}