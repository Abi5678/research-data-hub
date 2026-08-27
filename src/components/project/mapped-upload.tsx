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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileText,
  Link2,
  Loader2,
  Plus,
  Upload,
  X,
} from "lucide-react";
import {
  coerceRow,
  keyText,
  parseCsv,
  type ColumnKind,
  type ColumnSchema,
  type ParsedCsv,
} from "@/lib/csv";
import type { ProjectTemplate, TemplateTable } from "@/lib/templates";
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

type DatasetRow = {
  id: string;
  display_name: string;
  table_name: string;
  row_count: number | null;
  column_schema: ColumnSchema[];
};

type Mode = "create" | "append" | "replace";
type Action = "existing" | "skip" | "new";

type ColumnMap = {
  csv: string; // original CSV header
  action: Action;
  targetName?: string; // existing DB column name OR new column name
  newType?: ColumnKind;
};

type Stage = "pick" | "sheet" | "configure" | "validating" | "report" | "uploading";

type Report = {
  ok: Record<string, string | null>[];
  /** Cells stored as NULL because they failed their column type. */
  repaired: { line: number; reason: string }[];
  orphan: { line: number; column: string; value: string }[];
  duplicate: { line: number; key: string }[];
  /** Checks that could not be run in full, so the counts above understate. */
  warnings: string[];
};

// datasetColumnValues caps its result, and the SELECT DISTINCT behind it has no
// ORDER BY, so past this many distinct values the set is an arbitrary subset.
const KEY_SET_LIMIT = 200000;

function norm(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Score column-name overlap between CSV and a template table. */
function overlapScore(csvCols: string[], tmpl: TemplateTable): number {
  const set = new Set(tmpl.columns.map((c) => norm(c.name)));
  let hits = 0;
  for (const c of csvCols) if (set.has(norm(c))) hits++;
  return hits;
}

export function MappedDatasetUploadDialog({
  projectId,
  template,
  bindings,
  datasets,
  initialTableKey,
  onCreated,
  onReplaced,
  trigger,
}: {
  projectId: string;
  template: ProjectTemplate;
  bindings: Record<string, string>;
  datasets: DatasetRow[];
  /** Pre-select a target template table. */
  initialTableKey?: string;
  /** Fired after a NEW dataset table is created (first upload). */
  onCreated?: (info: { datasetId: string; tableKey: string; rowCount: number }) => void;
  /** Fired after appending/replacing rows into an existing dataset. */
  onReplaced?: (info: { datasetId: string; tableKey: string; rowCount: number }) => void;
  trigger?: React.ReactNode;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("pick");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [sheets, setSheets] = useState<XlsxSheet[] | null>(null);
  const [tableKey, setTableKey] = useState<string>(initialTableKey ?? template.tables[0]!.key);
  const [mode, setMode] = useState<Mode>("create");
  const [displayName, setDisplayName] = useState("");
  const [mappings, setMappings] = useState<ColumnMap[]>([]);
  const [uniqueKeys, setUniqueKeys] = useState<string[]>([]);
  const [includeOrphans, setIncludeOrphans] = useState(false);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");

  const templateTable = useMemo(
    () => template.tables.find((t) => t.key === tableKey)!,
    [template, tableKey],
  );
  const boundDatasetId = bindings[tableKey];
  const boundDataset = useMemo(
    () => datasets.find((d) => d.id === boundDatasetId),
    [datasets, boundDatasetId],
  );

  const reset = useCallback(() => {
    setStage("pick");
    setFile(null);
    setParsed(null);
    setSheets(null);
    setMappings([]);
    setUniqueKeys([]);
    setReport(null);
    setProgress(0);
    setProgressMsg("");
    setIncludeOrphans(false);
    setIncludeDuplicates(false);
    setMode("create");
    setDisplayName("");
  }, []);

  /** Auto-pick target table by best overlap, then build default mapping. */
  const initializeFromParse = useCallback(
    (p: ParsedCsv) => {
      const csvCols = p.columns.map((c) => c.original_name ?? c.name);
      const scored = template.tables
        .map((t) => ({ t, score: overlapScore(csvCols, t) }))
        .sort((a, b) => b.score - a.score);
      const bestKey =
        initialTableKey ??
        (scored[0] && scored[0].score > 0 ? scored[0].t.key : template.tables[0]!.key);
      setTableKey(bestKey);
      const defaultMode: Mode = bindings[bestKey] ? "append" : "create";
      setMode(defaultMode);
      setDisplayName(template.tables.find((t) => t.key === bestKey)!.display_name);
      setMappings(buildDefaultMappings(p, bestKey, bindings, datasets, template));
    },
    [bindings, datasets, initialTableKey, template],
  );

  const openSheet = useCallback(
    (sheet: XlsxSheet) => {
      setParsed(sheet.parsed);
      initializeFromParse(sheet.parsed);
      setStage("configure");
    },
    [initializeFromParse],
  );

  const handleFile = useCallback(
    async (f: File) => {
      if (!isSpreadsheetFile(f.name)) {
        toast.error("Only .csv, .xlsx, or .xls files are supported");
        return;
      }
      if (f.size > MAX_BYTES) {
        toast.error("File exceeds the 50MB limit");
        return;
      }
      setFile(f);

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
          openSheet(parsedSheets[0]!);
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
      openSheet({ name: f.name, parsed: p });
    },
    [openSheet],
  );

  /** Recompute mapping defaults when target table changes. */
  const changeTable = (nextKey: string) => {
    setTableKey(nextKey);
    if (parsed) {
      setMode(bindings[nextKey] ? "append" : "create");
      setDisplayName(template.tables.find((t) => t.key === nextKey)!.display_name);
      setMappings(buildDefaultMappings(parsed, nextKey, bindings, datasets, template));
      setUniqueKeys([]);
    }
  };

  const validate = useMutation({
    mutationFn: async () => {
      if (!parsed) throw new Error("No file");
      setStage("validating");

      // Effective target columns after mapping
      const targetCols = effectiveTargetColumns(mappings, boundDataset, mode);
      if (targetCols.length === 0) throw new Error("No columns mapped");

      const warnings: string[] = [];

      // For FK validation: which mapped columns are template FKs?
      const fkChecks: {
        csvHeader: string;
        targetName: string;
        kind: ColumnKind;
        validValues: Set<string>;
      }[] = [];
      for (const fk of templateTable.fks ?? []) {
        const parentDsId = bindings[fk.references.table];
        if (!parentDsId) continue; // parent not yet uploaded
        const parentDs = datasets.find((d) => d.id === parentDsId);
        if (!parentDs) continue;
        const parentCol = parentDs.column_schema.find((c) => c.name === fk.references.column);
        if (!parentCol) continue;
        const mapping = mappings.find((m) => m.action !== "skip" && m.targetName === fk.column);
        if (!mapping) continue;
        setProgressMsg(`Fetching valid ${fk.references.table}.${parentCol.name} values…`);
        const data = await api.datasetColumnValues(parentDsId, [parentCol.name], KEY_SET_LIMIT);
        if (data.length >= KEY_SET_LIMIT) {
          // An incomplete set of valid values makes almost every row look like an
          // orphan, and orphans are excluded by default — so skip the check and
          // say so, rather than quietly dropping good rows.
          warnings.push(
            `${fk.references.table}.${parentCol.name} has at least ${KEY_SET_LIMIT.toLocaleString()} distinct values, more than can be loaded for checking, so the foreign key on "${fk.column}" was not verified.`,
          );
          continue;
        }
        const values = new Set<string>(data.map((r) => keyText(r[parentCol.name], parentCol.type)));
        fkChecks.push({
          csvHeader: mapping.csv,
          targetName: fk.column,
          kind: parentCol.type,
          validValues: values,
        });
      }

      // For dedup: fetch existing unique-key combos (append only)
      const seenKeys = new Set<string>();
      const keyKinds = uniqueKeys.map(
        (k) => targetCols.find((c) => c.name === k)?.type ?? ("text" as ColumnKind),
      );
      if (uniqueKeys.length > 0 && mode === "append" && boundDatasetId) {
        setProgressMsg("Fetching existing keys for de-duplication…");
        const data = await api.datasetColumnValues(boundDatasetId, uniqueKeys, KEY_SET_LIMIT);
        if (data.length >= KEY_SET_LIMIT) {
          // Unlike the FK case this still runs: a partial set catches some
          // duplicates, and missing one inserts a row rather than dropping one.
          warnings.push(
            `The target table has at least ${KEY_SET_LIMIT.toLocaleString()} distinct key combinations, more than can be loaded at once, so duplicates against the rest of the table were not detected.`,
          );
        }
        for (const r of data) {
          seenKeys.add(uniqueKeys.map((k, ki) => keyText(r[k], keyKinds[ki])).join("\u241f"));
        }
      }

      // Iterate rows
      setProgressMsg("Validating rows…");
      const rep: Report = { ok: [], repaired: [], orphan: [], duplicate: [], warnings };
      const inBatchSeen = new Set<string>();

      parsed.rows.forEach((raw, i) => {
        const line = i + 2;
        // Build a raw view keyed by the target column name for coerceRow
        const remapped: Record<string, string> = {};
        for (const m of mappings) {
          if (m.action === "skip" || !m.targetName) continue;
          remapped[m.targetName] = raw[m.csv] ?? "";
        }
        const res = coerceRow(remapped, targetCols);
        // A cell that fails its type is stored as NULL, not a reason to throw
        // away the rest of the row — the row still goes through FK and dedup.
        for (const b of res.bad) rep.repaired.push({ line, reason: b.reason });
        // FK check
        let orphan = false;
        for (const chk of fkChecks) {
          // Compare what actually gets inserted, not the raw cell: the parent
          // stores a typed value, and coerceRow has already rewritten "1.0" to
          // the "1" that will land in the column.
          const v = keyText(res.row[chk.targetName], chk.kind);
          if (v !== "" && !chk.validValues.has(v)) {
            rep.orphan.push({
              line,
              column: chk.targetName,
              value: String(raw[chk.csvHeader] ?? "").trim(),
            });
            orphan = true;
            break;
          }
        }
        if (orphan && !includeOrphans) return;
        // Dedup check
        if (uniqueKeys.length > 0) {
          const key = uniqueKeys.map((k, ki) => keyText(res.row[k], keyKinds[ki])).join("\u241f");
          if (seenKeys.has(key) || inBatchSeen.has(key)) {
            rep.duplicate.push({ line, key });
            if (!includeDuplicates) return;
          }
          inBatchSeen.add(key);
        }
        rep.ok.push(res.row);
      });

      return rep;
    },
    onSuccess: (rep) => {
      setReport(rep);
      setStage("report");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Validation failed");
      setStage("configure");
    },
  });

  const runImport = useMutation({
    mutationFn: async () => {
      if (!parsed || !file || !report) throw new Error("Not ready");
      setStage("uploading");
      setProgress(2);

      let datasetId: string | undefined = boundDatasetId;
      let created = false;
      let inserted = 0;

      // 1) Create the dataset table if needed
      if (mode === "create") {
        setProgressMsg("Creating table…");
        const createCols = mappings
          .filter((m) => m.action !== "skip" && m.targetName)
          .map((m) => ({
            name: m.targetName!,
            original_name: m.csv,
            type:
              m.action === "new"
                ? (m.newType ?? "text")
                : (templateTable.columns.find((c) => c.name === m.targetName)?.type ?? "text"),
          }));
        const c = await api.createProjectDataset({
          projectId,
          displayName: displayName.trim() || templateTable.display_name,
          sourceFilename: file.name,
          columns: createCols as { name: string; original_name: string; type: ColumnKind }[],
        });
        datasetId = c.dataset_id;
        created = true;
      } else {
        if (!datasetId) throw new Error("No target dataset");
        // Add any "new" columns to the existing dataset
        const newCols = mappings.filter((m) => m.action === "new" && m.targetName);
        for (const m of newCols) {
          setProgressMsg(`Adding column ${m.targetName}…`);
          await api.addDatasetColumn(datasetId, m.targetName!, m.newType ?? "text");
        }
        if (mode === "replace") {
          setProgressMsg("Replacing existing rows…");
          const n = await api.replaceDatasetRowsTyped(datasetId, report.ok);
          inserted = Number(n ?? 0);
          setProgress(100);
          setProgressMsg("Done");
          return { datasetId: datasetId!, inserted, created };
        }
      }

      // 2) Insert rows in chunks (append)
      const CHUNK = 1000;
      const rows = report.ok;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        setProgressMsg(
          `Inserting ${i.toLocaleString()}–${Math.min(i + CHUNK, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}`,
        );
        const n = await api.insertDatasetRowsTyped(datasetId!, chunk);
        inserted += Number(n ?? 0);
        setProgress(5 + Math.round(((i + chunk.length) / Math.max(rows.length, 1)) * 92));
      }

      setProgress(100);
      setProgressMsg("Done");
      return { datasetId: datasetId!, inserted, created };
    },
    onSuccess: ({ datasetId, inserted, created }) => {
      toast.success(
        `${created ? "Imported" : mode === "replace" ? "Replaced with" : "Appended"} ${inserted.toLocaleString()} row${inserted === 1 ? "" : "s"}`,
      );
      qc.invalidateQueries({ queryKey: ["datasets", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      if (created) onCreated?.({ datasetId, tableKey, rowCount: inserted });
      else onReplaced?.({ datasetId, tableKey, rowCount: inserted });
      setTimeout(() => {
        setOpen(false);
        reset();
      }, 500);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Import failed");
      setStage("report");
    },
  });

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
            <Upload className="h-3.5 w-3.5" /> Upload CSV
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Upload CSV with mapping</DialogTitle>
          <DialogDescription>
            Map CSV columns to the template schema, validate foreign keys, and choose append vs
            replace before importing.
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
                Drag a .csv or .xlsx file here
              </div>
              <div className="text-xs text-muted-foreground">or</div>
              <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
                <Plus className="h-3.5 w-3.5" /> Choose file
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
              <p className="text-[11px] text-muted-foreground">.csv, .xlsx, .xls • max 50MB</p>
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
                Which sheet should be mapped to {templateTable.display_name}?
              </div>
              <div className="max-h-72 space-y-2 overflow-auto">
                {sheets.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => openSheet(s)}
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
            </div>
          )}

          {stage === "configure" && parsed && (
            <ConfigureStage
              parsed={parsed}
              fileName={file?.name ?? ""}
              template={template}
              tableKey={tableKey}
              onChangeTable={changeTable}
              mode={mode}
              setMode={setMode}
              boundDataset={boundDataset}
              displayName={displayName}
              setDisplayName={setDisplayName}
              mappings={mappings}
              setMappings={setMappings}
              uniqueKeys={uniqueKeys}
              setUniqueKeys={setUniqueKeys}
              bindings={bindings}
              datasets={datasets}
            />
          )}

          {stage === "validating" && (
            <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              {progressMsg || "Validating…"}
            </div>
          )}

          {stage === "report" && report && (
            <ReportStage
              report={report}
              totalParsed={parsed?.rows.length ?? 0}
              includeOrphans={includeOrphans}
              setIncludeOrphans={(v) => {
                setIncludeOrphans(v);
                validate.mutate();
              }}
              includeDuplicates={includeDuplicates}
              setIncludeDuplicates={(v) => {
                setIncludeDuplicates(v);
                validate.mutate();
              }}
              uniqueKeysCount={uniqueKeys.length}
            />
          )}

          {stage === "uploading" && (
            <div className="space-y-3 py-4">
              <div className="text-sm font-semibold text-foreground">Importing…</div>
              <Progress value={progress} />
              <div className="text-xs text-muted-foreground">{progressMsg}</div>
            </div>
          )}
        </div>

        {(stage === "configure" || stage === "report") && (
          <DialogFooter>
            {stage === "configure" && (
              <>
                <Button variant="ghost" onClick={reset} className="gap-1">
                  <X className="h-3.5 w-3.5" /> Choose different file
                </Button>
                <Button
                  onClick={() => validate.mutate()}
                  disabled={validate.isPending}
                  className="gap-1"
                >
                  Validate <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            {stage === "report" && report && (
              <>
                <Button variant="ghost" onClick={() => setStage("configure")} className="gap-1">
                  <ArrowLeft className="h-3.5 w-3.5" /> Back to mapping
                </Button>
                <Button
                  onClick={() => runImport.mutate()}
                  disabled={runImport.isPending || report.ok.length === 0}
                  className="gap-1"
                >
                  Import {report.ok.length.toLocaleString()} row
                  {report.ok.length === 1 ? "" : "s"}
                </Button>
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ helpers ------------------------------- */

function buildDefaultMappings(
  parsed: ParsedCsv,
  tableKey: string,
  bindings: Record<string, string>,
  datasets: DatasetRow[],
  template: ProjectTemplate,
): ColumnMap[] {
  const bound = datasets.find((d) => d.id === bindings[tableKey]);
  const templateTable = template.tables.find((t) => t.key === tableKey)!;
  // Available target columns are either the existing dataset's columns
  // (when appending/replacing) or the template's columns (for a new table).
  const targets = bound
    ? bound.column_schema.map((c) => ({ name: c.name, type: c.type }))
    : templateTable.columns.map((c) => ({ name: c.name, type: c.type }));
  const byNorm = new Map(targets.map((t) => [norm(t.name), t]));
  return parsed.columns.map((c) => {
    const hit = byNorm.get(norm(c.original_name ?? c.name));
    if (hit) {
      return { csv: c.original_name ?? c.name, action: "existing", targetName: hit.name };
    }
    return { csv: c.original_name ?? c.name, action: "skip" };
  });
}

function effectiveTargetColumns(
  mappings: ColumnMap[],
  boundDataset: DatasetRow | undefined,
  mode: Mode,
): ColumnSchema[] {
  const cols: ColumnSchema[] = [];
  for (const m of mappings) {
    if (m.action === "skip" || !m.targetName) continue;
    if (m.action === "new") {
      cols.push({ name: m.targetName, original_name: m.csv, type: m.newType ?? "text" });
      continue;
    }
    // existing
    if (mode === "create") {
      // In create mode, "existing" means the template-column type applies
      cols.push({ name: m.targetName, original_name: m.csv, type: "text" });
    } else if (boundDataset) {
      const c = boundDataset.column_schema.find((x) => x.name === m.targetName);
      if (c) cols.push({ name: c.name, original_name: m.csv, type: c.type });
    }
  }
  return cols;
}

/* ------------------------------ configure ----------------------------- */

function ConfigureStage({
  parsed,
  fileName,
  template,
  tableKey,
  onChangeTable,
  mode,
  setMode,
  boundDataset,
  displayName,
  setDisplayName,
  mappings,
  setMappings,
  uniqueKeys,
  setUniqueKeys,
  bindings,
  datasets,
}: {
  parsed: ParsedCsv;
  fileName: string;
  template: ProjectTemplate;
  tableKey: string;
  onChangeTable: (k: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  boundDataset?: DatasetRow;
  displayName: string;
  setDisplayName: (s: string) => void;
  mappings: ColumnMap[];
  setMappings: React.Dispatch<React.SetStateAction<ColumnMap[]>>;
  uniqueKeys: string[];
  setUniqueKeys: (k: string[]) => void;
  bindings: Record<string, string>;
  datasets: DatasetRow[];
}) {
  const templateTable = template.tables.find((t) => t.key === tableKey)!;
  const availableTargets = boundDataset
    ? boundDataset.column_schema.map((c) => ({ name: c.name, type: c.type }))
    : templateTable.columns.map((c) => ({ name: c.name, type: c.type }));
  const targetForDedup = availableTargets.map((c) => c.name);

  const fkColumns = new Set((templateTable.fks ?? []).map((f) => f.column));

  const csvCols = parsed.columns.map((c) => c.original_name ?? c.name);
  const scored = template.tables
    .map((t) => ({ t, score: overlapScore(csvCols, t) }))
    .sort((a, b) => b.score - a.score);
  const suggestion = scored[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileText className="h-3.5 w-3.5" />
        <span className="font-semibold text-foreground">{fileName}</span>
        <span>•</span>
        <span>{parsed.rows.length.toLocaleString()} rows</span>
        <span>•</span>
        <span>{parsed.columns.length} columns</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="text-xs">Target table</Label>
          <Select value={tableKey} onValueChange={onChangeTable}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {template.tables.map((t) => {
                const s = scored.find((x) => x.t.key === t.key)?.score ?? 0;
                return (
                  <SelectItem key={t.key} value={t.key}>
                    <span className="font-mono">{t.key}</span>
                    {s > 0 && (
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        {s} match{s === 1 ? "" : "es"}
                      </span>
                    )}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {suggestion && suggestion.score > 0 && suggestion.t.key !== tableKey && (
            <button
              type="button"
              onClick={() => onChangeTable(suggestion.t.key)}
              className="mt-1 text-[11px] font-medium text-primary underline-offset-2 hover:underline"
            >
              Suggested: {suggestion.t.key} ({suggestion.score} matching columns)
            </button>
          )}
        </div>
        <div>
          <Label className="text-xs">Mode</Label>
          {boundDataset ? (
            <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="append">Append (add rows)</SelectItem>
                <SelectItem value="replace">Replace (empty first)</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <div className="flex h-9 items-center gap-2 rounded-md border border-dashed border-border bg-secondary/40 px-3 text-xs text-muted-foreground">
              <Plus className="h-3 w-3" /> Creates a new table (no existing dataset)
            </div>
          )}
        </div>
      </div>

      {mode === "create" && (
        <div>
          <Label htmlFor="ds-name" className="text-xs">
            Display name
          </Label>
          <Input
            id="ds-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
      )}

      {boundDataset && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-gradient-primary-soft px-3 py-2 text-[11px]">
          <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
          <span>
            Target dataset <span className="font-semibold">{boundDataset.display_name}</span> has{" "}
            {boundDataset.row_count !== null && <>{boundDataset.row_count.toLocaleString()} rows and </>}
            {boundDataset.column_schema.length} columns.
          </span>
        </div>
      )}

      {/* Column mapping table */}
      <div>
        <div className="mb-1.5 text-xs font-semibold text-foreground">Column mapping</div>
        <div className="max-h-72 overflow-auto rounded-xl border border-border/70">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-secondary/80 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">CSV column</th>
                <th className="px-3 py-2 text-left font-semibold">Action</th>
                <th className="px-3 py-2 text-left font-semibold">Target / new column</th>
                <th className="px-3 py-2 text-left font-semibold">Type</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m, i) => {
                const isFk = m.targetName ? fkColumns.has(m.targetName) : false;
                const targetCol = availableTargets.find((t) => t.name === m.targetName);
                return (
                  <tr key={i} className="border-t border-border/50">
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-foreground">{m.csv}</span>
                      {isFk && (
                        <Badge
                          variant="outline"
                          className="ml-2 gap-1 border-primary/40 bg-primary/10 text-[9px] font-bold uppercase text-primary"
                        >
                          <Link2 className="h-2.5 w-2.5" /> FK
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <Select
                        value={m.action}
                        onValueChange={(v) =>
                          setMappings((arr) =>
                            arr.map((mm, j) =>
                              j === i
                                ? {
                                    ...mm,
                                    action: v as Action,
                                    // Reset targetName when switching modes
                                    targetName:
                                      v === "skip"
                                        ? undefined
                                        : v === "new"
                                          ? mm.csv
                                          : (mm.targetName ?? availableTargets[0]?.name),
                                    newType: v === "new" ? (mm.newType ?? "text") : mm.newType,
                                  }
                                : mm,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="h-7 w-[110px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="existing">Existing</SelectItem>
                          <SelectItem value="new">New column</SelectItem>
                          <SelectItem value="skip">Skip</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-3 py-1.5">
                      {m.action === "existing" && (
                        <Select
                          value={m.targetName ?? ""}
                          onValueChange={(v) =>
                            setMappings((arr) =>
                              arr.map((mm, j) => (j === i ? { ...mm, targetName: v } : mm)),
                            )
                          }
                        >
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue placeholder="Choose column…" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableTargets.map((t) => (
                              <SelectItem key={t.name} value={t.name}>
                                {t.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {m.action === "new" && (
                        <Input
                          value={m.targetName ?? ""}
                          className="h-7 text-xs"
                          onChange={(e) =>
                            setMappings((arr) =>
                              arr.map((mm, j) =>
                                j === i ? { ...mm, targetName: e.target.value } : mm,
                              ),
                            )
                          }
                        />
                      )}
                      {m.action === "skip" && (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {m.action === "new" ? (
                        <Select
                          value={m.newType ?? "text"}
                          onValueChange={(v) =>
                            setMappings((arr) =>
                              arr.map((mm, j) =>
                                j === i ? { ...mm, newType: v as ColumnKind } : mm,
                              ),
                            )
                          }
                        >
                          <SelectTrigger className="h-7 w-[100px] text-xs">
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
                      ) : m.action === "existing" && targetCol ? (
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                          {KIND_LABEL[targetCol.type]}
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Foreign key preview */}
      {(templateTable.fks ?? []).length > 0 && (
        <div className="rounded-lg border border-border/70 bg-secondary/40 p-3 text-[11px]">
          <div className="mb-1 flex items-center gap-1 font-semibold text-foreground">
            <Link2 className="h-3 w-3 text-primary" /> Foreign-key checks
          </div>
          <ul className="space-y-0.5 text-muted-foreground">
            {templateTable.fks!.map((fk) => {
              const parentBound = bindings[fk.references.table];
              const parentDs = datasets.find((d) => d.id === parentBound);
              return (
                <li key={fk.column} className="flex items-center gap-2">
                  <span className="font-mono">{fk.column}</span>
                  <ArrowRight className="h-3 w-3" />
                  <span className="font-mono">
                    {fk.references.table}.{fk.references.column}
                  </span>
                  {parentDs ? (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                      will validate against{" "}
                      {parentDs.row_count === null
                        ? "its combined rows"
                        : `${parentDs.row_count.toLocaleString()} rows`}
                    </span>
                  ) : (
                    <span className="text-amber-700">parent not loaded — skipped</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Dedup unique-key selector */}
      <div>
        <Label className="text-xs">
          De-duplicate on (unique key columns)
          <span className="ml-1 text-muted-foreground">— optional</span>
        </Label>
        <div className="mt-1 flex flex-wrap gap-2 rounded-lg border border-border/70 bg-secondary/30 p-2">
          {targetForDedup.length === 0 && (
            <span className="text-[11px] text-muted-foreground">
              No target columns available yet.
            </span>
          )}
          {targetForDedup.map((c) => {
            const on = uniqueKeys.includes(c);
            return (
              <label
                key={c}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition ${
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-white text-foreground hover:border-primary/40"
                }`}
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={(v) => {
                    if (v) setUniqueKeys([...uniqueKeys, c]);
                    else setUniqueKeys(uniqueKeys.filter((k) => k !== c));
                  }}
                  className="h-3 w-3"
                />
                <span className="font-mono">{c}</span>
              </label>
            );
          })}
        </div>
        {uniqueKeys.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Rows with duplicate combos of{" "}
            <span className="font-mono">{uniqueKeys.join(" + ")}</span> will be flagged.
          </p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- report ------------------------------ */

function ReportStage({
  report,
  totalParsed,
  includeOrphans,
  setIncludeOrphans,
  includeDuplicates,
  setIncludeDuplicates,
  uniqueKeysCount,
}: {
  report: Report;
  totalParsed: number;
  includeOrphans: boolean;
  setIncludeOrphans: (v: boolean) => void;
  includeDuplicates: boolean;
  setIncludeDuplicates: (v: boolean) => void;
  uniqueKeysCount: number;
}) {
  const okPct = totalParsed === 0 ? 0 : Math.round((report.ok.length / totalParsed) * 100);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="Rows OK" value={report.ok.length} tone="ok" />
        <Stat label="Repaired" value={report.repaired.length} tone="warn" />
        <Stat label="Orphan FK" value={report.orphan.length} tone="warn" />
        <Stat label="Duplicates" value={report.duplicate.length} tone="warn" />
      </div>
      <div className="text-[11px] text-muted-foreground">
        {okPct}% of {totalParsed.toLocaleString()} rows will be imported.
      </div>

      {/* A check that did not run is not a check that passed — say which. */}
      {report.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
          <div className="font-semibold">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            Some checks could not be completed
          </div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {report.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {report.orphan.length > 0 && (
        <details className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
          <summary className="cursor-pointer font-semibold">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            {report.orphan.length} orphan foreign-key value{report.orphan.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 max-h-32 space-y-0.5 overflow-auto">
            {report.orphan.slice(0, 20).map((o, i) => (
              <li key={i}>
                Line {o.line}: {o.column} = "{o.value}" not in parent table
              </li>
            ))}
            {report.orphan.length > 20 && <li>…and {report.orphan.length - 20} more</li>}
          </ul>
          <label className="mt-2 flex items-center gap-2">
            <Checkbox
              checked={includeOrphans}
              onCheckedChange={(v) => setIncludeOrphans(Boolean(v))}
            />
            Import orphan rows anyway
          </label>
        </details>
      )}

      {report.repaired.length > 0 && (
        <details className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
          <summary className="cursor-pointer font-semibold">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            {report.repaired.length} cells failed type checks (stored as empty)
          </summary>
          <ul className="mt-2 max-h-32 space-y-0.5 overflow-auto">
            {report.repaired.slice(0, 20).map((o, i) => (
              <li key={i}>
                Line {o.line}: {o.reason}
              </li>
            ))}
            {report.repaired.length > 20 && <li>…and {report.repaired.length - 20} more</li>}
          </ul>
        </details>
      )}

      {report.duplicate.length > 0 && uniqueKeysCount > 0 && (
        <details className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
          <summary className="cursor-pointer font-semibold">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            {report.duplicate.length} duplicate row{report.duplicate.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 max-h-32 space-y-0.5 overflow-auto">
            {report.duplicate.slice(0, 20).map((o, i) => (
              <li key={i}>
                Line {o.line}: key "{o.key.replace(/\u241f/g, " + ")}"
              </li>
            ))}
            {report.duplicate.length > 20 && <li>…and {report.duplicate.length - 20} more</li>}
          </ul>
          <label className="mt-2 flex items-center gap-2">
            <Checkbox
              checked={includeDuplicates}
              onCheckedChange={(v) => setIncludeDuplicates(Boolean(v))}
            />
            Import duplicate rows anyway
          </label>
        </details>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" }) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        tone === "ok"
          ? "border-primary/30 bg-gradient-primary-soft"
          : value > 0
            ? "border-amber-300 bg-amber-50"
            : "border-border/70 bg-secondary/40"
      }`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-extrabold text-foreground">{value.toLocaleString()}</div>
    </div>
  );
}
