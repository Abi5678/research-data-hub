import type { ColumnSchema } from "@/lib/csv";

export const BROWSE_FETCH_LIMIT = 10000;
// One row past the display cap. Fetching it is how Browse tells a complete
// result from a clipped one: an exact row count of BROWSE_FETCH_LIMIT is
// ambiguous, and guessing from it warned either never or wrongly.
export const BROWSE_PROBE_LIMIT = BROWSE_FETCH_LIMIT + 1;
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

/**
 * Whether a dataset's own schema declares a row_id.
 *
 * Every dataset this app imports has one (it is the table's PK), but an
 * attached source reflects an arbitrary external table and a combined dataset
 * only exposes one when all of its sources do — so it has to be asked, not
 * assumed.
 */
export function hasRowIdColumn(columns: ColumnSchema[]): boolean {
  return columns.some((c) => c.name === "row_id");
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
  /** Whether the table actually has a row_id. Attached sources reflect
   *  arbitrary external tables and usually do not, and asking for one made
   *  Browse fail with a raw `no such column: row_id`. Defaults to true, which
   *  is the case for every dataset this app creates itself. */
  hasRowId?: boolean;
}): string {
  const named = args.columns.filter((c) => c !== "row_id");
  const selected = args.hasRowId === false ? named : ["row_id", ...named];
  const cols = args.columns.length > 0 && selected.length > 0 ? selected.map(quoteIdent) : ["*"];
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

  const limit = Math.min(Math.max(args.limit ?? BROWSE_FETCH_LIMIT, 1), BROWSE_PROBE_LIMIT);
  sql += ` LIMIT ${limit}`;
  return sql;
}

export function rowKey(row: Record<string, unknown>, index: number): string {
  const id = row.row_id ?? row.__row;
  if (id !== null && id !== undefined && id !== "") return String(id);
  return `idx-${index}`;
}
