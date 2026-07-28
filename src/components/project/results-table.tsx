import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function ResultsTable({
  columns,
  rows,
  emptyLabel = "No rows",
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  emptyLabel?: string;
}) {
  const previewRows = useMemo(() => rows.slice(0, 500), [rows]);
  if (columns.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-secondary/50 p-8 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-card">
      <div className="max-h-[520px] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-secondary/90 backdrop-blur">
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c} className="whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {previewRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-8 text-center text-sm text-muted-foreground">
                  {emptyLabel}
                </TableCell>
              </TableRow>
            ) : (
              previewRows.map((r, i) => (
                <TableRow key={i}>
                  {columns.map((c) => (
                    <TableCell key={c} className="whitespace-nowrap font-mono text-xs">
                      {formatCell(r[c])}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {rows.length > previewRows.length && (
        <div className="border-t border-border/70 bg-secondary/40 px-4 py-2 text-[11px] text-muted-foreground">
          Showing first {previewRows.length.toLocaleString()} of{" "}
          {rows.length.toLocaleString()} rows. Export to see all.
        </div>
      )}
    </div>
  );
}

function formatCell(v: unknown) {
  if (v === null || v === undefined || v === "") return <span className="text-slate-300">—</span>;
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return String(v);
}