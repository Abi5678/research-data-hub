import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { ChartImage } from "@/lib/chart-image";
import type { DashboardSpec } from "@/lib/dashboard-spec";
import { buildExportFilename, logExport, triggerDownloadBlob } from "@/lib/export";

export type DashboardExportFormat = "pdf" | "xlsx";

/** Rows beyond this are left out of the report; the full grid export has them all. */
export const REPORT_ROW_LIMIT = 1000;

const KPI_HEADERS = ["Column", "Values", "Blank", "Min", "Max", "Average", "Median"];

export type ChartDataTable = {
  title: string;
  headers: string[];
  rows: (string | number | null)[][];
};

export type DashboardExportInput = {
  projectId: string;
  projectCode: string;
  datasetName: string;
  columns: string[];
  rows: Record<string, unknown>[];
  spec: DashboardSpec;
  charts: ChartImage[];
  filterLabel: string | null;
  selectedOnly: boolean;
  format: DashboardExportFormat;
  exportLabel?: string;
  chartTables?: ChartDataTable[];
};

function cellString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function num(v: number | null): string {
  if (v === null) return "-";
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

function kpiRows(spec: DashboardSpec): string[][] {
  return spec.kpis.map((k) => [
    k.column,
    String(k.count),
    String(k.missing),
    num(k.min),
    num(k.max),
    num(k.mean),
    num(k.median),
  ]);
}

function subtitle(input: DashboardExportInput): string {
  const parts = [
    `${input.rows.length.toLocaleString()} ${input.selectedOnly ? "selected" : "filtered"} rows`,
    `${input.columns.length} columns`,
    `generated ${new Date().toLocaleString()}`,
  ];
  if (input.filterLabel) parts.splice(1, 0, `filter: ${input.filterLabel}`);
  return parts.join("  |  ");
}

function buildPdf(input: DashboardExportInput): Blob {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;

  doc.setFontSize(15);
  doc.text(`${input.projectCode} - ${input.datasetName}`, margin, 18);
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(subtitle(input), margin, 24, { maxWidth: contentWidth });
  doc.setTextColor(0);

  let y = 32;

  if (input.spec.kpis.length > 0) {
    doc.setFontSize(11);
    doc.text("Summary statistics", margin, y);
    autoTable(doc, {
      head: [KPI_HEADERS],
      body: kpiRows(input.spec),
      startY: y + 3,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [30, 64, 175], textColor: 255 },
      margin: { left: margin, right: margin },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  }

  for (const chart of input.charts) {
    const imgHeight = Math.min(90, (contentWidth * chart.height) / chart.width);
    if (y + imgHeight + 12 > pageHeight - margin) {
      doc.addPage();
      y = margin + 4;
    }
    doc.setFontSize(10);
    doc.text(chart.title || "Chart", margin, y);
    doc.addImage(chart.dataUrl, "PNG", margin, y + 3, contentWidth, imgHeight);
    y += imgHeight + 14;
  }

  const dataRows = input.rows.slice(0, REPORT_ROW_LIMIT);
  doc.addPage(undefined, input.columns.length > 6 ? "landscape" : "portrait");
  doc.setFontSize(11);
  doc.text("Data", margin, 16);
  doc.setFontSize(8);
  doc.setTextColor(100);
  doc.text(
    dataRows.length < input.rows.length
      ? `First ${dataRows.length.toLocaleString()} of ${input.rows.length.toLocaleString()} rows`
      : `${dataRows.length.toLocaleString()} rows`,
    margin,
    21,
  );
  doc.setTextColor(0);
  autoTable(doc, {
    head: [input.columns],
    body: dataRows.map((r) => input.columns.map((c) => cellString(r[c]))),
    startY: 25,
    styles: { fontSize: 7, cellPadding: 1.5, overflow: "linebreak" },
    headStyles: { fillColor: [30, 64, 175], textColor: 255 },
    margin: { left: 10, right: 10 },
  });

  return doc.output("blob");
}

async function buildXlsx(input: DashboardExportInput): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Research Data Hub";
  wb.created = new Date();

  const summary = wb.addWorksheet("Summary");
  summary.addRow([`${input.projectCode} - ${input.datasetName}`]);
  summary.getRow(1).font = { bold: true, size: 14 };
  summary.addRow([subtitle(input)]);
  summary.addRow([]);
  if (input.spec.kpis.length > 0) {
    summary.addRow(KPI_HEADERS);
    summary.getRow(summary.rowCount).font = { bold: true };
    for (const k of input.spec.kpis) {
      summary.addRow([k.column, k.count, k.missing, k.min, k.max, k.mean, k.median]);
    }
  }
  summary.getColumn(1).width = 34;
  for (let i = 2; i <= KPI_HEADERS.length; i += 1) summary.getColumn(i).width = 14;

  const data = wb.addWorksheet("Data");
  data.addRow(input.columns);
  data.getRow(1).font = { bold: true };
  for (const row of input.rows) {
    data.addRow(
      input.columns.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return null;
        if (typeof v === "number" || typeof v === "boolean") return v;
        return String(v);
      }),
    );
  }
  input.columns.forEach((c, i) => {
    data.getColumn(i + 1).width = Math.min(
      40,
      Math.max(
        12,
        c.length + 2,
        ...input.rows.slice(0, 50).map((r) => cellString(r[c]).length + 2),
      ),
    );
  });
  data.views = [{ state: "frozen", ySplit: 1 }];

  if (input.charts.length > 0) {
    const sheet = wb.addWorksheet("Charts");
    let topRow = 1;
    for (const chart of input.charts) {
      sheet.getCell(`A${topRow}`).value = chart.title || "Chart";
      sheet.getCell(`A${topRow}`).font = { bold: true };
      const imageId = wb.addImage({
        base64: chart.dataUrl.split(",")[1] ?? "",
        extension: "png",
      });
      sheet.addImage(imageId, {
        tl: { col: 0, row: topRow },
        ext: { width: chart.width, height: chart.height },
      });
      topRow += Math.ceil(chart.height / 20) + 3;
    }
    sheet.getColumn(1).width = 30;
  }

  // Chart data is kept alongside the pictures so numbers stay auditable.
  const chartTables: ChartDataTable[] =
    input.chartTables && input.chartTables.length > 0
      ? input.chartTables
      : input.spec.charts.map((chart) => {
          if (chart.kind === "scatter") {
            return {
              title: chart.title,
              headers: [chart.xColumn, chart.yColumn],
              rows: chart.data.map((p) => [p.x, p.y]),
            };
          }
          return {
            title: chart.title,
            headers: [
              chart.kind === "line" ? chart.xColumn : chart.categoryColumn,
              chart.kind === "bar" && chart.aggregation === "count" ? "count" : "value",
            ],
            rows: chart.data.map((p) => [p.label, p.value]),
          };
        });

  if (chartTables.length > 0) {
    const sheet = wb.addWorksheet("Chart data");
    for (const table of chartTables) {
      sheet.addRow([table.title]);
      sheet.getRow(sheet.rowCount).font = { bold: true };
      sheet.addRow(table.headers);
      for (const row of table.rows) sheet.addRow(row);
      sheet.addRow([]);
    }
    sheet.getColumn(1).width = 34;
    sheet.getColumn(2).width = 18;
  }

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export async function exportDashboard(input: DashboardExportInput): Promise<string> {
  if (!input.columns.length) throw new Error("Select at least one column to export");
  if (!input.rows.length) throw new Error("No rows to export");

  const filename = buildExportFilename(
    input.projectCode,
    input.exportLabel ?? `${input.datasetName}-dashboard`,
    input.format,
  );

  if (input.format === "pdf") {
    triggerDownloadBlob(filename, buildPdf(input));
  } else {
    const buf = await buildXlsx(input);
    triggerDownloadBlob(
      filename,
      new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
  }

  await logExport({
    projectId: input.projectId,
    filename,
    rowCount: input.rows.length,
  });
  return filename;
}
