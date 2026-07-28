import { api } from "@/lib/api";
import { toCsv } from "@/lib/csv";

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
): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const base = label ? safeSlug(label) : stamp;
  return `${safeSlug(projectCode)}_${base}.csv`;
}

export function triggerDownload(filename: string, contents: string) {
  // Prepend BOM so Excel opens UTF-8 correctly
  const blob = new Blob(["\uFEFF" + contents], { type: "text/csv;charset=utf-8" });
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
}): Promise<string> {
  const csv = toCsv(params.rows, params.columns);
  const filename = buildExportFilename(params.projectCode, params.label);
  triggerDownload(filename, csv);
  await logExport({
    projectId: params.projectId,
    filename,
    rowCount: params.rows.length,
    queryId: params.queryId ?? null,
  });
  return filename;
}