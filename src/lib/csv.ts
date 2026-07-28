import Papa from "papaparse";

export type ColumnKind =
  | "text"
  | "integer"
  | "double precision"
  | "boolean"
  | "date"
  | "timestamptz";

export type ColumnSchema = {
  name: string;
  original_name?: string;
  type: ColumnKind;
};

export type ParsedCsv = {
  columns: ColumnSchema[];
  rows: Record<string, string>[]; // raw string cells keyed by original header
  meta: {
    totalRows: number;
  };
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+$/;
const BOOLISH = new Set(["true", "false", "0", "1"]);

function inferKind(colName: string, values: string[]): ColumnKind {
  const nameHasDate = /date|_at$|_on$|timestamp/i.test(colName);
  let seen = 0;
  let ints = 0;
  let floats = 0;
  let bools = 0;
  let dates = 0;
  let datetimes = 0;
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (v === "") continue;
    seen++;
    if (BOOLISH.has(v.toLowerCase())) bools++;
    if (INT_RE.test(v)) ints++;
    else if (FLOAT_RE.test(v)) floats++;
    if (ISO_DATETIME.test(v)) datetimes++;
    else if (ISO_DATE.test(v)) dates++;
  }
  if (seen === 0) return "text";

  // Prefer date/timestamp when name suggests it OR every value parses as one
  if (datetimes === seen) return "timestamptz";
  if (dates === seen) return "date";
  if (nameHasDate && dates + datetimes === seen) {
    return datetimes > 0 ? "timestamptz" : "date";
  }

  // Boolean must be all boolean-like AND not purely numeric (avoid classifying 0/1 counts as boolean unless column really looks boolean)
  if (bools === seen && ints < seen) return "boolean";
  // For pure 0/1 with tiny sample, treat as integer
  if (ints === seen) return "integer";
  if (ints + floats === seen && floats > 0) return "double precision";
  return "text";
}

// Shared by parseCsv and the XLSX sheet parser (src/lib/xlsx.ts) — both
// end up with the same shape (headers + string-keyed rows) and need
// identical type inference.
export function buildParsedTable(
  headers: string[],
  rows: Record<string, string>[],
): ParsedCsv {
  const sample = rows.slice(0, 500);
  const columns: ColumnSchema[] = headers.map((h) => ({
    name: h,
    original_name: h,
    type: inferKind(h, sample.map((r) => r[h] ?? "")),
  }));
  return { columns, rows, meta: { totalRows: rows.length } };
}

export function parseCsv(text: string): ParsedCsv {
  const res = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
  });
  const rows = (res.data ?? []).filter((r) => r && Object.keys(r).length > 0);
  const headers = res.meta.fields ?? [];
  return buildParsedTable(headers, rows);
}

export type CoerceResult =
  | { ok: true; row: Record<string, string | null> }
  | { ok: false; reason: string };

// Validate a raw row against a column schema. Return string-encoded values;
// the DB casts each one on insert. Empty → null.
export function coerceRow(
  raw: Record<string, string>,
  columns: ColumnSchema[],
): CoerceResult {
  const out: Record<string, string | null> = {};
  for (const col of columns) {
    const src = raw[col.original_name ?? col.name];
    const v = src == null ? "" : String(src).trim();
    if (v === "") {
      out[col.name] = null;
      continue;
    }
    switch (col.type) {
      case "integer": {
        if (!INT_RE.test(v)) return { ok: false, reason: `"${col.name}" expects integer, got "${v}"` };
        out[col.name] = v;
        break;
      }
      case "double precision": {
        if (!INT_RE.test(v) && !FLOAT_RE.test(v)) return { ok: false, reason: `"${col.name}" expects number, got "${v}"` };
        out[col.name] = v;
        break;
      }
      case "boolean": {
        const lv = v.toLowerCase();
        if (!BOOLISH.has(lv)) return { ok: false, reason: `"${col.name}" expects boolean, got "${v}"` };
        out[col.name] = lv === "true" || lv === "1" ? "true" : "false";
        break;
      }
      case "date": {
        if (!ISO_DATE.test(v)) return { ok: false, reason: `"${col.name}" expects YYYY-MM-DD date, got "${v}"` };
        out[col.name] = v;
        break;
      }
      case "timestamptz": {
        if (!ISO_DATETIME.test(v) && !ISO_DATE.test(v))
          return { ok: false, reason: `"${col.name}" expects timestamp, got "${v}"` };
        out[col.name] = v;
        break;
      }
      default:
        out[col.name] = v;
    }
  }
  return { ok: true, row: out };
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  return Papa.unparse({ fields: columns, data: rows.map((r) => columns.map((c) => r[c])) });
}