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
const INT_RE = /^[+-]?\d+$/;
// Matches 1.5, .5, 5., +1.23E+05, 1e-3. Instrument and LIMS exports routinely
// write moduli and strains in scientific notation; a decimal-only pattern
// silently demotes those columns to text.
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
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
    else if (NUMBER_RE.test(v)) floats++;
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

export function parseCsv(text: string, delimiter?: string): ParsedCsv {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = delimiter ?? detectDelimiter(cleaned);
  const res = Papa.parse<Record<string, string>>(cleaned, {
    header: true,
    skipEmptyLines: "greedy",
    delimiter: delim,
  });
  const rows = (res.data ?? []).filter((r) => r && Object.keys(r).length > 0);
  const fields = res.meta.fields ?? [];
  const seen = new Map<string, number>();
  const headers = fields.map((h) => {
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n === 0 ? h : `${h}_${n + 1}`;
  });
  const mapped =
    fields.length === headers.length && fields.every((f, i) => f === headers[i])
      ? rows
      : rows.map((row) => {
          const out: Record<string, string> = {};
          fields.forEach((f, i) => {
            out[headers[i]] = row[f] ?? "";
          });
          return out;
        });
  return buildParsedTable(headers, mapped);
}

function detectDelimiter(text: string): string {
  const lines = text
    .slice(0, 8192)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 8);
  if (lines.length === 0) return ",";
  let commas = 0;
  let tabs = 0;
  let semis = 0;
  let pipes = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (ch === ",") commas++;
      else if (ch === "\t") tabs++;
      else if (ch === ";") semis++;
      else if (ch === "|") pipes++;
    }
  }
  if (tabs >= lines.length && tabs >= commas) return "\t";
  if (semis > commas && semis >= lines.length) return ";";
  if (pipes > commas && pipes >= lines.length) return "|";
  return ",";
}

/** Parse CSV/TSV/TXT by filename extension (auto-detect delimiter for .txt). */
export function parseTabularText(filename: string, text: string): ParsedCsv {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tsv")) return parseCsv(text, "\t");
  if (lower.endsWith(".txt")) return parseCsv(text);
  return parseCsv(text, ",");
}

export type BadCell = { column: string; value: string; reason: string };

export type CoerceResult = {
  row: Record<string, string | null>;
  /** Cells that could not be parsed. They are stored as NULL, not dropped. */
  bad: BadCell[];
};

// Validate a raw row against a column schema. Return string-encoded values;
// the DB casts each one on insert. Empty → null.
//
// An unparseable cell nulls that cell and is reported in `bad`; it never
// discards the row. One messy cell must not throw away every other
// measurement recorded on the same line.
export function coerceRow(
  raw: Record<string, string>,
  columns: ColumnSchema[],
): CoerceResult {
  const out: Record<string, string | null> = {};
  const bad: BadCell[] = [];
  const reject = (col: ColumnSchema, value: string, expected: string) => {
    out[col.name] = null;
    bad.push({
      column: col.name,
      value,
      reason: `"${col.name}" expects ${expected}, got "${value}"`,
    });
  };

  for (const col of columns) {
    const src = raw[col.original_name ?? col.name];
    const v = src == null ? "" : String(src).trim();
    if (v === "") {
      out[col.name] = null;
      continue;
    }
    switch (col.type) {
      case "integer": {
        // Pass plain digits through verbatim so long ids keep full precision.
        // Drop a leading "+": the server's bind step only accepts /^-?\d+$/.
        if (INT_RE.test(v)) {
          out[col.name] = v.replace(/^\+/, "");
          break;
        }
        // Spreadsheets write whole numbers as "12.0" or "1e3"; accept those.
        const n = NUMBER_RE.test(v) ? Number(v) : NaN;
        if (!Number.isSafeInteger(n)) {
          reject(col, v, "integer");
          break;
        }
        out[col.name] = String(n);
        break;
      }
      case "double precision": {
        if (!NUMBER_RE.test(v)) {
          reject(col, v, "number");
          break;
        }
        out[col.name] = v;
        break;
      }
      case "boolean": {
        const lv = v.toLowerCase();
        if (!BOOLISH.has(lv)) {
          reject(col, v, "boolean");
          break;
        }
        out[col.name] = lv === "true" || lv === "1" ? "true" : "false";
        break;
      }
      case "date": {
        if (!ISO_DATE.test(v)) {
          reject(col, v, "YYYY-MM-DD date");
          break;
        }
        out[col.name] = v;
        break;
      }
      case "timestamptz": {
        if (!ISO_DATETIME.test(v) && !ISO_DATE.test(v)) {
          reject(col, v, "timestamp");
          break;
        }
        out[col.name] = v;
        break;
      }
      default:
        out[col.name] = v;
    }
  }
  return { row: out, bad };
}

/**
 * Render a key value as text so two sides of a comparison can be matched.
 * They are written differently: a value read back from the database is already
 * typed — a numeric key arrives as the number 1 — while a value coming from a
 * CSV is a string. Under a numeric column "1.0" and " 1" therefore have to
 * match a stored 1; under a text column they must not, because "0001" is a
 * distinct code.
 */
export function keyText(value: unknown, kind: ColumnKind): string {
  if (value == null) return "";
  const s = String(value).trim();
  if (s === "" || (kind !== "integer" && kind !== "double precision")) return s;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  return Papa.unparse({ fields: columns, data: rows.map((r) => columns.map((c) => r[c])) });
}