import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Upload, FileText, Plus, X, AlertTriangle } from "lucide-react";
import { coerceRow, parseCsv, type ColumnKind, type ColumnSchema, type ParsedCsv } from "@/lib/csv";
import { isSpreadsheetFile, isXlsxFile, parseXlsx, type XlsxSheet } from "@/lib/xlsx";

const MAX_BYTES = 50 * 1024 * 1024;
const KINDS: ColumnKind[] = [
  "text",
  "integer",
  "double precision",
  "boolean",
  "date",
  "timestamptz",
];
const KIND_LABEL: Record<ColumnKind, string> = {
  text: "text",
  integer: "integer",
  "double precision": "real",
  boolean: "boolean",
  date: "date",
  timestamptz: "timestamp",
};

type Stage = "pick" | "sheet" | "review" | "uploading";

export type ExpectedColumn = { name: string; type: ColumnKind };

export function DatasetUploadDialog({
  projectId,
  trigger,
  defaultDisplayName,
  expectedColumns,
  onCreated,
  buttonLabel = "Upload CSV",
}: {
  projectId: string;
  trigger?: React.ReactNode;
  defaultDisplayName?: string;
  expectedColumns?: ExpectedColumn[];
  onCreated?: (info: { datasetId: string; rowCount: number }) => void;
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [sheets, setSheets] = useState<XlsxSheet[] | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [columns, setColumns] = useState<ColumnSchema[]>([]);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [repaired, setRepaired] = useState<{ row: number; reason: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const reset = useCallback(() => {
    setStage("pick");
    setFile(null);
    setParsed(null);
    setSheets(null);
    setDisplayName("");
    setColumns([]);
    setProgress(0);
    setProgressMsg("");
    setRepaired([]);
  }, []);

  const applyExpected = useCallback(
    (cols: ColumnSchema[]): ColumnSchema[] => {
      if (!expectedColumns || expectedColumns.length === 0) return cols;
      const norm = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
      const expectedMap = new Map(expectedColumns.map((c) => [norm(c.name), c]));
      return cols.map((c) => {
        const hit =
          expectedMap.get(norm(c.name)) ?? expectedMap.get(norm(c.original_name ?? c.name));
        if (!hit) return c;
        return { ...c, name: hit.name, type: hit.type };
      });
    },
    [expectedColumns],
  );

  const openSheet = useCallback(
    (sheet: XlsxSheet, f: File) => {
      const p = sheet.parsed;
      setParsed(p);
      setColumns(applyExpected(p.columns));
      setDisplayName(
        defaultDisplayName ??
          (sheet.name.toLowerCase() === "sheet1"
            ? f.name.replace(/\.(xlsx|xls|csv)$/i, "")
            : sheet.name),
      );
      setStage("review");
    },
    [applyExpected, defaultDisplayName],
  );

  const handleFile = useCallback(
    async (f: File) => {
      if (!isSpreadsheetFile(f.name)) {
        toast.error("Only .csv, .xlsx, or .xlsm files are supported");
        return;
      }
      if (f.size > MAX_BYTES) {
        toast.error("File exceeds the 50MB limit");
        return;
      }
      setFile(f);
      setProgressMsg("Parsing file…");

      if (isXlsxFile(f.name)) {
        let parsedSheets: XlsxSheet[];
        try {
          parsedSheets = await parseXlsx(f);
        } catch {
          toast.error("Could not read this Excel file");
          return;
        }
        if (parsedSheets.length === 0) {
          toast.error("No sheets with data found in this workbook");
          return;
        }
        if (parsedSheets.length === 1) {
          openSheet(parsedSheets[0]!, f);
        } else {
          setSheets(parsedSheets);
          setStage("sheet");
        }
        return;
      }

      const text = await f.text();
      const p = parseCsv(text);
      if (p.columns.length === 0 || p.rows.length === 0) {
        toast.error("CSV appears to be empty");
        return;
      }
      setParsed(p);
      setColumns(applyExpected(p.columns));
      setDisplayName(defaultDisplayName ?? f.name.replace(/\.csv$/i, ""));
      setStage("review");
    },
    [applyExpected, defaultDisplayName, openSheet],
  );

  const upload = useMutation({
    mutationFn: async () => {
      if (!parsed || !file) throw new Error("No file");
      if (!displayName.trim()) throw new Error("Name is required");

      setStage("uploading");
      setProgress(2);
      setProgressMsg("Creating table…");

      const created = await api.createProjectDataset({
        projectId,
        displayName: displayName.trim(),
        sourceFilename: file.name,
        columns: columns.map((c) => ({
          name: c.name,
          original_name: c.original_name ?? c.name,
          type: c.type,
        })),
      });
      const datasetId = created.dataset_id;

      // Coerce rows client-side. Cells that fail their column type are stored
      // as NULL and reported; the rest of the row is still imported.
      const goodRows: Record<string, string | null>[] = [];
      const badCells: { row: number; reason: string }[] = [];
      parsed.rows.forEach((raw, i) => {
        const res = coerceRow(raw, columns);
        goodRows.push(res.row);
        for (const b of res.bad) badCells.push({ row: i + 2, reason: b.reason }); // +2 = header + 1-index
      });
      setRepaired(badCells);

      // Chunked insert
      const CHUNK = 1000;
      let inserted = 0;
      for (let i = 0; i < goodRows.length; i += CHUNK) {
        const chunk = goodRows.slice(i, i + CHUNK);
        setProgressMsg(
          `Inserting ${i.toLocaleString()}–${Math.min(i + CHUNK, goodRows.length).toLocaleString()} of ${goodRows.length.toLocaleString()}`,
        );
        const n = await api.insertDatasetRowsTyped(datasetId, chunk);
        inserted += Number(n ?? 0);
        setProgress(5 + Math.round(((i + chunk.length) / goodRows.length) * 92));
      }

      setProgress(100);
      setProgressMsg("Done");
      return { inserted, badCount: badCells.length, datasetId };
    },
    onSuccess: ({ inserted, badCount, datasetId }) => {
      toast.success(
        `Imported ${inserted.toLocaleString()} rows${
          badCount > 0 ? ` — ${badCount} cell${badCount === 1 ? "" : "s"} stored as empty` : ""
        }`,
      );
      qc.invalidateQueries({ queryKey: ["datasets", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      onCreated?.({ datasetId, rowCount: inserted });
      setTimeout(() => {
        setOpen(false);
        reset();
      }, 400);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Upload failed");
      setStage("review");
    },
  });

  const preview = useMemo(() => parsed?.rows.slice(0, 20) ?? [], [parsed]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" className="gap-1.5">
            <Upload className="h-3.5 w-3.5" /> {buttonLabel}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col gap-3 overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Upload dataset</DialogTitle>
          <DialogDescription>
            Bring a CSV or Excel file up to 50MB. We'll infer column types and create a typed
            database table.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {stage === "pick" && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void handleFile(f);
              }}
              className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
                dragging ? "border-primary bg-primary/5" : "border-border bg-secondary/40"
              }`}
            >
              <div className="rounded-full bg-white p-3 shadow-card">
                <Upload className="h-6 w-6 text-primary" />
              </div>
              <div className="text-sm font-semibold text-foreground">
                Drag a .csv, .xlsx, or .xlsm file here
              </div>
              <div className="text-xs text-muted-foreground">or</div>
              <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
                <Plus className="h-3.5 w-3.5" /> Choose file
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv,.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
              <p className="text-[11px] text-muted-foreground">.csv, .xlsx, .xlsm • max 50MB</p>
            </div>
          )}

          {stage === "sheet" && sheets && file && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                <span className="font-semibold text-foreground">{file.name}</span>
                <span>•</span>
                <span>{sheets.length} sheets with data</span>
              </div>
              <div className="text-xs font-semibold text-foreground">
                Which sheet should become a dataset?
              </div>
              <div className="max-h-72 space-y-2 overflow-auto">
                {sheets.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => openSheet(s, file)}
                    className="flex w-full items-center justify-between rounded-xl border border-border/70 bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
                  >
                    <div>
                      <div className="text-sm font-semibold text-foreground">{s.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {s.parsed.rows.length.toLocaleString()} rows • {s.parsed.columns.length}{" "}
                        columns
                      </div>
                    </div>
                    <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Each sheet is imported as its own dataset — repeat for more sheets in this workbook.
              </p>
            </div>
          )}

          {stage === "review" && parsed && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                <span className="font-semibold text-foreground">{file?.name}</span>
                <span>•</span>
                <span>{parsed.rows.length.toLocaleString()} rows</span>
                <span>•</span>
                <span>{parsed.columns.length} columns</span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="ds-name" className="text-xs">
                    Display name
                  </Label>
                  <Input
                    id="ds-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Field Cores 2024"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-xs font-semibold text-foreground">Columns</div>
                <div className="max-h-56 overflow-auto rounded-xl border border-border/70">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-secondary/80 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold">Source</th>
                        <th className="px-3 py-2 text-left font-semibold">Column name</th>
                        <th className="px-3 py-2 text-left font-semibold">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((c, i) => (
                        <tr key={i} className="border-t border-border/50">
                          <td className="px-3 py-1.5 text-muted-foreground">{c.original_name}</td>
                          <td className="px-3 py-1.5">
                            <Input
                              value={c.name}
                              className="h-7 text-xs"
                              onChange={(e) =>
                                setColumns((cols) =>
                                  cols.map((cc, j) =>
                                    j === i ? { ...cc, name: e.target.value } : cc,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-3 py-1.5">
                            <Select
                              value={c.type}
                              onValueChange={(v) =>
                                setColumns((cols) =>
                                  cols.map((cc, j) =>
                                    j === i ? { ...cc, type: v as ColumnKind } : cc,
                                  ),
                                )
                              }
                            >
                              <SelectTrigger className="h-7 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {KINDS.map((k) => (
                                  <SelectItem key={k} value={k}>
                                    {KIND_LABEL[k]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-xs font-semibold text-foreground">
                  Preview (first {preview.length} rows)
                </div>
                <div className="max-h-64 overflow-auto rounded-xl border border-border/70">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-secondary/80 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        {columns.map((c) => (
                          <th
                            key={c.original_name}
                            className="whitespace-nowrap px-3 py-2 text-left font-semibold"
                          >
                            {c.name}
                            <span className="ml-1 rounded bg-white px-1 text-[9px] font-bold uppercase text-primary">
                              {KIND_LABEL[c.type]}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((r, i) => (
                        <tr key={i} className="border-t border-border/50">
                          {columns.map((c) => (
                            <td
                              key={c.original_name}
                              className="whitespace-nowrap px-3 py-1.5 text-muted-foreground"
                            >
                              {r[c.original_name ?? c.name] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {stage === "uploading" && (
            <div className="space-y-3 py-4">
              <div className="text-sm font-semibold text-foreground">Importing…</div>
              <Progress value={progress} />
              <div className="text-xs text-muted-foreground">{progressMsg}</div>
              {repaired.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
                  <div className="mb-1 flex items-center gap-1 font-semibold">
                    <AlertTriangle className="h-3 w-3" /> {repaired.length} cell
                    {repaired.length === 1 ? "" : "s"} stored as empty
                  </div>
                  <ul className="max-h-24 space-y-0.5 overflow-auto">
                    {repaired.slice(0, 5).map((s, i) => (
                      <li key={`${s.row}-${i}`}>
                        Line {s.row}: {s.reason}
                      </li>
                    ))}
                    {repaired.length > 5 && <li>…and {repaired.length - 5} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {stage === "review" && (
          <DialogFooter>
            <Button variant="ghost" onClick={reset} className="gap-1">
              <X className="h-3.5 w-3.5" /> Choose different file
            </Button>
            <Button
              onClick={() => upload.mutate()}
              disabled={upload.isPending || !displayName.trim()}
            >
              Import {parsed?.rows.length.toLocaleString()} rows
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
