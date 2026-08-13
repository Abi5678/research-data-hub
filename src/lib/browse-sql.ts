import type { ColumnSchema } from "@/lib/csv";

export const BROWSE_FETCH_LIMIT = 10000;
export const BROWSE_DEFAULT_VISIBLE_COLS = 12;

export type BrowseFilterOp = "equals" | "in" | "contains";

export function quoteIdent(s: string): string {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

export function litValue(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Prefer sample/mix/section/code/id columns for the default filter. */
export function guessIdColumn(columns: ColumnSchema[]): string {
  if (columns.length === 0) return "";
  const scored = columns.map((c) => {
    const n = c.name.toLowerCase();
    let score = 0;
    if (/(_id|id)$/.test(n)) score += 5;
    if (/sample|specimen|mix|section|code|lot|lab/.test(n)) score += 4;
    if (c.type === "integer" || c.type === "text") score += 1;
    return { name: c.name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.name ?? columns[0]!.name;
}

export function defaultVisibleColumns(columns: ColumnSchema[]): string[] {
  const names = columns.map((c) => c.name).filter((n) => n !== "row_id");
  if (names.length <= BROWSE_DEFAULT_VISIBLE_COLS) return names;
  return names.slice(0, BROWSE_DEFAULT_VISIBLE_COLS);
}

export function buildBrowseSql(args: {
  tableName: string;
  columns: string[];
  filterColumn?: string;
  filterOp?: BrowseFilterOp;
  filterValue?: string;
  limit?: number;
}): string {
  const cols =
    args.columns.length > 0
      ? ["row_id", ...args.columns.filter((c) => c !== "row_id")].map(quoteIdent)
      : ["*"];
  const select = cols.join(", ");
  let sql = `SELECT ${select} FROM ${args.tableName}`;

  const col = args.filterColumn?.trim();
  const raw = (args.filterValue ?? "").trim();
  const op = args.filterOp ?? "equals";

  if (col && (op === "contains" ? raw.length > 0 : raw.length > 0 || op === "equals")) {
    const qCol = quoteIdent(col);
    if (op === "equals" && raw.length > 0) {
      sql += ` WHERE CAST(${qCol} AS TEXT) = ${litValue(raw)}`;
    } else if (op === "contains" && raw.length > 0) {
      sql += ` WHERE CAST(${qCol} AS TEXT) LIKE ${litValue(`%${raw}%`)}`;
    } else if (op === "in" && raw.length > 0) {
      const items = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(litValue);
      if (items.length === 1) {
        sql += ` WHERE CAST(${qCol} AS TEXT) = ${items[0]}`;
      } else if (items.length > 1) {
        sql += ` WHERE CAST(${qCol} AS TEXT) IN (${items.join(", ")})`;
      }
    }
  }

  const limit = Math.min(Math.max(args.limit ?? BROWSE_FETCH_LIMIT, 1), BROWSE_FETCH_LIMIT);
  sql += ` LIMIT ${limit}`;
  return sql;
}

export function rowKey(row: Record<string, unknown>, index: number): string {
  const id = row.row_id ?? row.__row;
  if (id !== null && id !== undefined && id !== "") return String(id);
  return `idx-${index}`;
}
