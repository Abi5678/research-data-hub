import ExcelJS from "exceljs";
import { buildParsedTable, type ParsedCsv } from "@/lib/csv";

export type XlsxSheet = {
  name: string;
  parsed: ParsedCsv;
};

const HEADER_SCAN = 40;
const MAX_HEADER_ROWS = 3;

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return cellToString(value.result as ExcelJS.CellValue);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join("");
    }
    if ("hyperlink" in value && (value as { hyperlink?: string }).hyperlink) {
      return cellToString((value as { text?: ExcelJS.CellValue }).text ?? "");
    }
    return "";
  }
  return String(value);
}

function isNumericish(t: string): boolean {
  const s = String(t).trim().replace(/[%$,]/g, "");
  if (s === "") return false;
  const n = Number(s);
  return Number.isFinite(n);
}

function dedupeHeaders(rawHeaders: string[]): string[] {
  const seen = new Map<string, number>();
  return rawHeaders.map((h) => {
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n === 0 ? h : `${h}_${n + 1}`;
  });
}

function usedCols(ws: ExcelJS.Worksheet): { c0: number; c1: number } {
  let min = Infinity;
  let max = 0;
  const last = Math.min(ws.rowCount || 1, Math.max(HEADER_SCAN, 80));
  for (let r = 1; r <= last; r++) {
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      if (cellToString(cell.value).trim() === "") return;
      if (col < min) min = col;
      if (col > max) max = col;
    });
  }
  if (!Number.isFinite(min)) return { c0: 1, c1: 1 };
  return { c0: min, c1: max };
}

function rowStats(ws: ExcelJS.Worksheet, r: number, c0: number, c1: number) {
  let filled = 0;
  let numeric = 0;
  for (let c = c0; c <= c1; c++) {
    const t = cellToString(ws.getRow(r).getCell(c).value).trim();
    if (!t) continue;
    filled += 1;
    if (isNumericish(t)) numeric += 1;
  }
  return { r, filled, numeric };
}

function findHeaderBlock(ws: ExcelJS.Worksheet, c0: number, c1: number) {
  const width = c1 - c0 + 1;
  const minFilled = Math.max(2, Math.ceil(width * 0.35));
  const scan = Math.min(ws.rowCount || 1, HEADER_SCAN);
  const stats = [];
  for (let r = 1; r <= scan; r++) stats.push(rowStats(ws, r, c0, c1));

  const headerLike = (s: { filled: number; numeric: number }) =>
    s.filled >= minFilled && s.numeric / Math.max(s.filled, 1) < 0.45;

  let best: { start: number; end: number; score: number } | null = null;
  for (let i = 0; i < stats.length; i++) {
    if (!headerLike(stats[i]!)) continue;
    let j = i;
    while (
      j + 1 < stats.length &&
      headerLike(stats[j + 1]!) &&
      j - i + 1 < MAX_HEADER_ROWS
    ) {
      j += 1;
    }
    const after = stats[j + 1];
    const followedByData = Boolean(after && after.filled >= 2 && after.numeric > 0);
    const score =
      stats[i]!.filled * 10 + (j - i) * 3 + (followedByData ? 80 : 0) + stats[i]!.r * 0.01;
    if (!best || score > best.score) best = { start: stats[i]!.r, end: stats[j]!.r, score };
    i = j;
  }
  return best;
}

function worksheetToTable(ws: ExcelJS.Worksheet) {
  if ((ws.rowCount || 0) < 2) return null;
  const { c0, c1 } = usedCols(ws);
  const block = findHeaderBlock(ws, c0, c1);
  if (!block) return null;

  const headers: string[] = [];
  for (let c = c0; c <= c1; c++) {
    const parts: string[] = [];
    for (let r = block.start; r <= block.end; r++) {
      const v = cellToString(ws.getRow(r).getCell(c).value).trim();
      if (v && parts[parts.length - 1] !== v) parts.push(v);
    }
    headers.push(parts.join(" ") || `column_${c}`);
  }
  const unique = dedupeHeaders(headers);
  if (unique.every((h) => /^column_\d+$/.test(h))) return null;

  const rows: Record<string, string>[] = [];
  for (let r = block.end + 1; r <= (ws.rowCount || block.end + 1); r++) {
    const obj: Record<string, string> = {};
    let hasValue = false;
    unique.forEach((h, i) => {
      const v = cellToString(ws.getRow(r).getCell(c0 + i).value).trim();
      if (v !== "") hasValue = true;
      obj[h] = v;
    });
    if (hasValue) rows.push(obj);
  }
  if (rows.length === 0) return null;

  for (const h of unique) {
    const nonempty = rows.map((row) => row[h]).filter((v) => String(v ?? "").trim() !== "");
    if (nonempty.length === 0) continue;
    const numeric = nonempty.filter((v) => isNumericish(String(v))).length;
    if (numeric / nonempty.length >= 0.5) continue;
    let prev = "";
    for (const row of rows) {
      const cur = String(row[h] ?? "").trim();
      if (cur) prev = cur;
      else if (prev) row[h] = prev;
    }
  }

  const keep = unique.filter((h) => rows.some((row) => String(row[h] ?? "").trim() !== ""));
  if (keep.length === 0) return null;
  const trimmed =
    keep.length === unique.length
      ? rows
      : rows.map((row) => {
          const o: Record<string, string> = {};
          for (const h of keep) o[h] = row[h] ?? "";
          return o;
        });
  return { headers: keep, rows: trimmed };
}

/** Parses every worksheet that contains a detectable header + data block. */
export async function parseXlsx(file: File): Promise<XlsxSheet[]> {
  const buf = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf);

  const sheets: XlsxSheet[] = [];
  for (const ws of workbook.worksheets) {
    const table = worksheetToTable(ws);
    if (!table) continue;
    sheets.push({ name: ws.name, parsed: buildParsedTable(table.headers, table.rows) });
  }
  return sheets;
}

export function isSpreadsheetFile(filename: string): boolean {
  return /\.(csv|tsv|txt|xlsx|xlsm)$/i.test(filename);
}

export function isXlsxFile(filename: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(filename);
}

export function isDelimitedTextFile(filename: string): boolean {
  return /\.(csv|tsv|txt)$/i.test(filename);
}
