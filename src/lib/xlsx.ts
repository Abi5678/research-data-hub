import ExcelJS from "exceljs";
import { buildParsedTable, type ParsedCsv } from "@/lib/csv";

export type XlsxSheet = {
  name: string;
  parsed: ParsedCsv;
};

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    // Rich text / formula / hyperlink cells
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return cellToString(value.result as ExcelJS.CellValue);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join("");
    }
    return "";
  }
  return String(value);
}

// Parses every non-empty worksheet in a workbook. Row 1 of each sheet is
// treated as the header row, matching the CSV upload's "header: true" mode.
export async function parseXlsx(file: File): Promise<XlsxSheet[]> {
  const buf = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf);

  const sheets: XlsxSheet[] = [];
  for (const ws of workbook.worksheets) {
    if (ws.rowCount < 2) continue; // needs at least a header + one data row

    const headerRow = ws.getRow(1);
    const rawHeaders: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      rawHeaders[colNumber - 1] = cellToString(cell.value).trim() || `column_${colNumber}`;
    });
    if (rawHeaders.length === 0) continue;

    // Deduplicate repeated header text (common in hand-formatted workbooks
    // with merged/copy-pasted header rows). Each row is keyed by header
    // text below, so leaving duplicates in would silently collapse distinct
    // columns' values onto a single key and lose data.
    const seen = new Map<string, number>();
    const headers = rawHeaders.map((h) => {
      const n = seen.get(h) ?? 0;
      seen.set(h, n + 1);
      return n === 0 ? h : `${h}_${n + 1}`;
    });

    const rows: Record<string, string>[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (row.cellCount === 0) continue;
      const obj: Record<string, string> = {};
      let hasValue = false;
      headers.forEach((h, i) => {
        const v = cellToString(row.getCell(i + 1).value);
        if (v !== "") hasValue = true;
        obj[h] = v;
      });
      if (hasValue) rows.push(obj);
    }
    if (rows.length === 0) continue;

    sheets.push({ name: ws.name, parsed: buildParsedTable(headers, rows) });
  }
  return sheets;
}

export function isSpreadsheetFile(filename: string): boolean {
  // ExcelJS supports OOXML workbooks, not legacy binary .xls files.
  return /\.(csv|xlsx|xlsm)$/i.test(filename);
}

export function isXlsxFile(filename: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(filename);
}
