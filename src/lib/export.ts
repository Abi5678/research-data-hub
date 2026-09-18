import { api } from "@/lib/api";
import { toCsv } from "@/lib/csv";
import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export type ExportFormat = "csv" | "tsv" | "json" | "xlsx" | "pdf";

export const EXPORT_FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: "csv", label: "CSV", hint: "Excel / Sheets friendly" },
  { id: "xlsx", label: "Excel (.xlsx)", hint: "Native spreadsheet" },
  { id: "pdf", label: "PDF", hint: "Printable report" },
  { id: "tsv", label: "TSV", hint: "Tab-separated" },
  { id: "json", label: "JSON", hint: "For scripts / APIs" },
];

function safeSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "export"
  );
}

export function buildExportFilename(
  projectCode: string,
  label?: string | null,
  format: ExportFormat = "csv",
): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const base = label ? safeSlug(label) : stamp;
  return `${safeSlug(projectCode)}_${base}.${format}`;
}

function cellString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export function toTsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (s: string) => s.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  const lines = [columns.map(esc).join("\t")];
  for (const row of rows) {
    lines.push(columns.map((c) => esc(cellString(row[c]))).join("\t"));
  }
  return lines.join("\n");
}

export function toJson(rows: Record<string, unknown>[], columns: string[]): string {
  const projected = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const c of columns) o[c] = r[c] ?? null;
    return o;
  });
  return JSON.stringify(projected, null, 2);
}

async function toXlsxBuffer(
  rows: Record<string, unknown>[],
  columns: string[],
  sheetName: string,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Fieldbook";
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || "Data");
  ws.addRow(columns);
  ws.getRow(1).font = { bold: true };
  for (const row of rows) {
    ws.addRow(columns.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return null;
      if (typeof v === "number" || typeof v === "boolean") return v;
      return String(v);
    }));
  }
  columns.forEach((_, i) => {
    ws.getColumn(i + 1).width = Math.min(
      40,
      Math.max(12, ...rows.slice(0, 50).map((r) => cellString(r[columns[i]!]).length + 2), columns[i]!.length + 2),
    );
  });
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

function toPdfBlob(
  rows: Record<string, unknown>[],
  columns: string[],
  title: string,
): Blob {
  const doc = new jsPDF({ orientation: columns.length > 6 ? "landscape" : "portrait" });
  doc.setFontSize(12);
  doc.text(title.slice(0, 80), 14, 16);
  doc.setFontSize(8);
  doc.text(`Exported ${new Date().toLocaleString()} · ${rows.length} rows`, 14, 22);

  const head = [columns];
  const body = rows.map((r) => columns.map((c) => cellString(r[c])));

  autoTable(doc, {
    head,
    body,
    startY: 26,
    styles: { fontSize: 7, cellPadding: 1.5, overflow: "linebreak" },
    headStyles: { fillColor: [30, 64, 175], textColor: 255 },
    margin: { left: 10, right: 10 },
  });

  return doc.output("blob");
}

export function triggerDownload(filename: string, contents: string, mime = "text/csv;charset=utf-8") {
  const needsBom = mime.includes("csv") || mime.includes("tab-separated");
  const blob = new Blob([needsBom ? "\uFEFF" + contents : contents], { type: mime });
  triggerDownloadBlob(filename, blob);
}

export function triggerDownloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function logExport(params: {
  projectId: string;
  filename: string;
  rowCount: number;
  queryId?: string | null;
}) {
  await api.insertExportHistory({
    projectId: params.projectId,
    filename: params.filename,
    rowCount: params.rowCount,
    queryId: params.queryId ?? null,
  });
}

export async function exportRows(params: {
  projectId: string;
  projectCode: string;
  rows: Record<string, unknown>[];
  columns: string[];
  label?: string | null;
  queryId?: string | null;
  format?: ExportFormat;
}): Promise<string> {
  if (!params.columns.length) throw new Error("Select at least one column to export");
  if (!params.rows.length) throw new Error("No rows to export");

  const format = params.format ?? "csv";
  const filename = buildExportFilename(params.projectCode, params.label, format);
  const title = params.label || params.projectCode;

  switch (format) {
    case "csv":
      triggerDownload(filename, toCsv(params.rows, params.columns), "text/csv;charset=utf-8");
      break;
    case "tsv":
      triggerDownload(
        filename,
        toTsv(params.rows, params.columns),
        "text/tab-separated-values;charset=utf-8",
      );
      break;
    case "json":
      triggerDownload(filename, toJson(params.rows, params.columns), "application/json");
      break;
    case "xlsx": {
      const buf = await toXlsxBuffer(params.rows, params.columns, title);
      triggerDownloadBlob(
        filename,
        new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      break;
    }
    case "pdf": {
      const blob = toPdfBlob(params.rows, params.columns, title);
      triggerDownloadBlob(filename, blob);
      break;
    }
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }

  await logExport({
    projectId: params.projectId,
    filename,
    rowCount: params.rows.length,
    queryId: params.queryId ?? null,
  });
  return filename;
}
