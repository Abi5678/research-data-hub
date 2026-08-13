import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AnalyzeFolderResult, PlannedTable } from "@/lib/ai-import";
import type { ProjectTemplate } from "@/lib/templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ErdDiagram } from "@/components/project/erd-diagram";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  FolderOpen,
  Link2,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";
import { isServerMode } from "@/lib/mode";
import { parseTabularText, coerceRow, type ColumnSchema, type ParsedCsv } from "@/lib/csv";
import { isSpreadsheetFile, isXlsxFile, isDelimitedTextFile, parseXlsx } from "@/lib/xlsx";

const SERVER_MAX_FILE_BYTES = 200 * 1024 * 1024;
const SERVER_MAX_SOURCES = 120;

export const Route = createFileRoute("/_authenticated/import-folder")({
  validateSearch: (s: Record<string, unknown>) => ({
    projectId: typeof s.projectId === "string" && s.projectId ? s.projectId : undefined,
  }),
  component: ImportFolderPage,
});

type Stage = "pick" | "analyzing" | "review" | "importing";

function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function slugCode(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "AI-IMPORT"
  );
}

function ReviewImportActions({
  intoExisting,
  pending,
  onStartOver,
  onImport,
}: {
  intoExisting: boolean;
  pending: boolean;
  onStartOver: () => void;
  onImport: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button variant="ghost" onClick={onStartOver} className="gap-1">
        <ArrowLeft className="h-3.5 w-3.5" /> Start over
      </Button>
      <Button
        onClick={onImport}
        disabled={pending}
        className="gap-1.5 bg-gradient-primary text-white shadow-cta hover-lift-sm hover:opacity-95"
      >
        {intoExisting ? "Import into project" : "Create project & import"}{" "}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function ImportFolderPage() {
  if (isServerMode) return <ServerFolderImportPage />;

  const navigate = useNavigate();
  const { projectId: existingProjectId } = Route.useSearch();
  const intoExisting = Boolean(existingProjectId);
  const [stage, setStage] = useState<Stage>("pick");
  const [aiAvailable, setAiAvailable] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [analysis, setAnalysis] = useState<AnalyzeFolderResult | null>(null);
  const [tables, setTables] = useState<PlannedTable[]>([]);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [projectName, setProjectName] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const [tableSearch, setTableSearch] = useState("");

  useEffect(() => {
    void api
      .isAiAssistAvailable()
      .then(setAiAvailable)
      .catch(() => setAiAvailable(false));
  }, []);

  useEffect(() => {
    if (!existingProjectId) return;
    void api.getProject(existingProjectId).then((p) => {
      if (!p) return;
      setProjectName(p.project_name);
      setProjectCode(p.project_code);
    });
  }, [existingProjectId]);

  useEffect(() => {
    const off = api.onImportProgress((msg) => setProgress(msg));
    return off;
  }, []);

  const analyze = useMutation({
    mutationFn: async (opts: { useAi: boolean }) => {
      const folder = await api.pickImportFolder();
      if (!folder) return null;
      setStage("analyzing");
      setProgress("Scanning folder…");
      return api.analyzeFolder(folder, { useAi: opts.useAi });
    },
    onSuccess: (res) => {
      if (!res) {
        setStage("pick");
        return;
      }
      setAnalysis(res);
      setTables(res.plan.tables);
      setIncluded(Object.fromEntries(res.plan.tables.map((t) => [t.key, true])));
      setTableSearch("");
      if (!intoExisting) {
        setProjectName(res.plan.project_name);
        setProjectCode(slugCode(res.plan.project_name));
      }
      setStage("review");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Analysis failed");
      setStage("pick");
    },
  });

  const runImport = useMutation({
    mutationFn: async () => {
      if (!analysis) throw new Error("Nothing analyzed");
      const chosen = tables.filter((t) => included[t.key]);
      if (chosen.length === 0) throw new Error("Select at least one table");
      if (!intoExisting && (!projectName.trim() || !projectCode.trim())) {
        throw new Error("Project name and code are required");
      }
      setStage("importing");
      setProgress(intoExisting ? "Importing into project…" : "Creating project…");
      return api.executeImportPlan({
        folder: analysis.folder,
        projectId: existingProjectId,
        mode: analysis.mode || analysis.plan.mode || "deterministic",
        projectInput: intoExisting
          ? undefined
          : {
              project_name: projectName.trim(),
              project_code: projectCode.trim(),
              description: analysis.plan.notes || null,
            },
        tables: chosen,
      });
    },
    onSuccess: (res) => {
      const total = res.results.reduce((s, r) => s + r.inserted, 0);
      const invalid = res.results.reduce((s, r) => s + (r.invalid || 0), 0);
      const skipped = res.skippedSources?.length ?? 0;
      toast.success(
        `Imported ${res.results.length} tables, ${total.toLocaleString()} rows` +
          (invalid ? `, ${invalid} invalid rows quarantined` : "") +
          (skipped ? `, ${skipped} source(s) skipped` : ""),
      );
      navigate({ to: "/projects/$projectId", params: { projectId: res.projectId } });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Import failed");
      setStage("review");
    },
  });

  const previewTemplate: ProjectTemplate = useMemo(
    () => ({
      key: "__ai_preview__",
      name: projectName || "Folder import",
      tagline: "",
      description: "",
      tables: tables
        .filter((t) => included[t.key])
        .map((t) => ({
          key: t.key,
          display_name: t.display_name,
          description: t.description,
          columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })),
          fks: t.fks,
          step: t.step,
        })),
    }),
    [tables, included, projectName],
  );

  const filteredTables = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => {
      if (t.display_name.toLowerCase().includes(q)) return true;
      if (t.description?.toLowerCase().includes(q)) return true;
      if (t.columns.some((c) => c.name.toLowerCase().includes(q))) return true;
      return t.sources.some(
        (s) =>
          s.file.toLowerCase().includes(q) ||
          (s.sheet ?? "").toLowerCase().includes(q) ||
          (s.source_label ?? "").toLowerCase().includes(q),
      );
    });
  }, [tables, tableSearch]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <Link
        to={intoExisting ? "/projects/$projectId" : "/dashboard"}
        params={intoExisting ? { projectId: existingProjectId! } : undefined}
        className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />{" "}
        {intoExisting ? "Back to project" : "Back to projects"}
      </Link>
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
          <FolderOpen className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">
            {intoExisting ? "Add folder to project" : "Create project from folder"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {intoExisting
              ? `Import spreadsheets into ${projectName || "this project"}.`
              : "Works offline with deterministic schema — one table per file/sheet."}
          </p>
        </div>
      </div>

      {stage === "pick" && (
        <div className="mt-8 rounded-2xl border border-border/70 bg-card p-10 text-center shadow-card">
          <div className="mx-auto max-w-md">
            <FolderOpen className="mx-auto h-8 w-8 text-primary" />
            <h2 className="mt-3 text-lg font-bold text-foreground">Pick a data folder</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Scans CSV, TSV, TXT, and Excel (.xlsx/.xlsm). PDF/Word/images are listed as skipped.
              No API key required.
            </p>
            {aiAvailable && (
              <label className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={useAi} onCheckedChange={(v) => setUseAi(Boolean(v))} />
                Improve schema with local AI (optional)
              </label>
            )}
            <Button
              className="mt-4 gap-1.5 bg-gradient-primary text-white shadow-cta hover-lift-sm hover:opacity-95"
              onClick={() => analyze.mutate({ useAi: useAi && aiAvailable })}
              disabled={analyze.isPending}
            >
              <FolderOpen className="h-4 w-4" /> Choose folder…
            </Button>
          </div>
        </div>
      )}

      {(stage === "analyzing" || stage === "importing") && (
        <div className="mt-8 rounded-2xl border border-border/70 bg-card p-10 text-center shadow-card">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <h2 className="mt-3 text-lg font-bold text-foreground">
            {stage === "analyzing" ? "Scanning folder…" : "Building your database…"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{progress}</p>
        </div>
      )}

      {stage === "review" && analysis && (
        <div className="mt-8 space-y-6">
          <div className="sticky top-14 z-20 -mx-4 border-b border-border/70 bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
            <ReviewImportActions
              intoExisting={intoExisting}
              pending={runImport.isPending}
              onStartOver={() => setStage("pick")}
              onImport={() => runImport.mutate()}
            />
          </div>
          {analysis.plan.notes && (
            <div className="rounded-2xl border border-primary/25 bg-gradient-primary-soft p-4 text-sm text-foreground shadow-card">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-primary">
                {(analysis.mode || "").startsWith("ai") ? (
                  <Sparkles className="h-3.5 w-3.5" />
                ) : (
                  <Bot className="h-3.5 w-3.5" />
                )}{" "}
                {(analysis.mode || "deterministic").replace("_", " ")} plan
              </div>
              {analysis.plan.notes}
            </div>
          )}

          {!intoExisting && (
            <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-card">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pname" className="text-xs font-semibold">
                    Project name
                  </Label>
                  <Input
                    id="pname"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pcode" className="text-xs font-semibold">
                    Project code
                  </Label>
                  <Input
                    id="pcode"
                    value={projectCode}
                    onChange={(e) => setProjectCode(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="text-lg font-bold text-foreground">
                Proposed tables ({tables.filter((t) => included[t.key]).length}/{tables.length})
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-[11px]"
                  onClick={() =>
                    setIncluded((m) => {
                      const next = { ...m };
                      for (const t of filteredTables) next[t.key] = true;
                      return next;
                    })
                  }
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-[11px]"
                  onClick={() =>
                    setIncluded((m) => {
                      const next = { ...m };
                      for (const t of filteredTables) next[t.key] = false;
                      return next;
                    })
                  }
                >
                  None
                </Button>
                <div className="relative w-full sm:w-64">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={tableSearch}
                    onChange={(e) => setTableSearch(e.target.value)}
                    placeholder="Search proposed tables..."
                    className="h-9 pl-8 text-xs"
                  />
                </div>
              </div>
            </div>
            {filteredTables.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-secondary/30 p-6 text-center text-xs text-muted-foreground">
                No tables match "{tableSearch.trim()}".
              </div>
            ) : (
              filteredTables.map((t) => {
                const ti = tables.findIndex((x) => x.key === t.key);
                return (
                  <div
                    key={t.key}
                    className={`rounded-2xl border p-5 shadow-card transition-opacity ${
                      included[t.key]
                        ? "border-border/70 bg-card"
                        : "border-border/40 bg-secondary/30 opacity-60"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={included[t.key]}
                          onCheckedChange={(v) =>
                            setIncluded((m) => ({ ...m, [t.key]: Boolean(v) }))
                          }
                          className="mt-1.5"
                        />
                        <div className="min-w-0">
                          <Input
                            value={t.display_name}
                            onChange={(e) =>
                              setTables((ts) =>
                                ts.map((x, i) =>
                                  i === ti ? { ...x, display_name: e.target.value } : x,
                                ),
                              )
                            }
                            className="h-8 w-72 text-sm font-bold"
                          />
                          <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                            {t.sources.map((s, i) => (
                              <Badge key={i} variant="secondary" className="font-mono text-[10px]">
                                {s.file}
                                {s.sheet ? ` › ${s.sheet}` : ""}
                                {s.source_label ? ` (${s.source_label})` : ""}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {t.columns.map((c) => (
                        <span
                          key={c.name}
                          className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-secondary/60 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
                        >
                          {c.name}
                          <span className="rounded bg-background px-1 text-[9px] font-bold uppercase text-primary">
                            {c.type.replace("double precision", "real")}
                          </span>
                          {c.pk && (
                            <span className="rounded bg-primary px-1 text-[9px] font-bold uppercase text-white">
                              pk
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                    {t.fks.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {t.fks.map((fk, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-semibold text-primary"
                          >
                            <Link2 className="h-3 w-3" />
                            {fk.column} → {fk.references.table}.{fk.references.column}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {analysis.skipped.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
              Skipped {analysis.skipped.length} file(s):{" "}
              {analysis.skipped
                .slice(0, 15)
                .map((s) => `${pathBasename(s.file)} (${s.reason})`)
                .join("; ")}
              {analysis.skipped.length > 15 && " …"}
            </div>
          )}

          {previewTemplate.tables.length > 0 && <ErdDiagram template={previewTemplate} />}

          <ReviewImportActions
            intoExisting={intoExisting}
            pending={runImport.isPending}
            onStartOver={() => setStage("pick")}
            onImport={() => runImport.mutate()}
          />
        </div>
      )}
    </div>
  );
}

type ServerSource = {
  fileName: string;
  relativePath: string;
  sheet: string | null;
  parsed: ParsedCsv;
  columns: ColumnSchema[];
};

async function filesFromZip(file: File): Promise<{ path: string; blob: Blob }[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const out: { path: string; blob: Blob }[] = [];
  const entries = Object.keys(zip.files);
  for (const path of entries) {
    const entry = zip.files[path];
    if (!entry || entry.dir) continue;
    const base = path.split("/").pop() || path;
    if (base.startsWith(".") || base.startsWith("~$")) continue;
    if (!isSpreadsheetFile(base)) continue;
    out.push({ path, blob: await entry.async("blob") });
  }
  return out;
}

async function parseSpreadsheetBlob(
  name: string,
  blob: Blob,
): Promise<{ sheet: string | null; parsed: ParsedCsv }[]> {
  if (isXlsxFile(name)) {
    const file = new File([blob], name);
    const sheets = await parseXlsx(file);
    return sheets.map((s) => ({ sheet: s.name, parsed: s.parsed }));
  }
  if (isDelimitedTextFile(name)) {
    const parsed = parseTabularText(name, await blob.text());
    if (parsed.columns.length && parsed.rows.length) return [{ sheet: null, parsed }];
  }
  return [];
}

function ServerFolderImportPage() {
  const navigate = useNavigate();
  const { projectId: existingProjectId } = Route.useSearch();
  const intoExisting = Boolean(existingProjectId);
  const [sources, setSources] = useState<ServerSource[]>([]);
  const [skipped, setSkipped] = useState<{ file: string; reason: string }[]>([]);
  const [projectName, setProjectName] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [sourceSearch, setSourceSearch] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!existingProjectId) return;
    void api.getProject(existingProjectId).then((p) => {
      if (!p) return;
      setProjectName(p.project_name);
      setProjectCode(p.project_code);
    });
  }, [existingProjectId]);

  async function ingestFiles(
    items: { relativePath: string; fileName: string; blob: Blob; size: number }[],
    defaultName: string,
  ) {
    const next: ServerSource[] = [];
    const skip: { file: string; reason: string }[] = [];
    for (const item of items) {
      if (item.size > SERVER_MAX_FILE_BYTES) {
        skip.push({
          file: item.relativePath,
          reason: "over 200MB — split the file",
        });
        continue;
      }
      if (!isSpreadsheetFile(item.fileName)) {
        if (/\.xls$/i.test(item.fileName)) {
          skip.push({
            file: item.relativePath,
            reason: "legacy .xls — Save As .xlsx / .csv",
          });
        } else if (/\.(pdf|docx?|pptx?|png|jpe?g)$/i.test(item.fileName)) {
          skip.push({
            file: item.relativePath,
            reason: "not a spreadsheet — export tables to CSV/XLSX",
          });
        }
        continue;
      }
      if (next.length >= SERVER_MAX_SOURCES) {
        skip.push({
          file: item.relativePath,
          reason: `source cap (${SERVER_MAX_SOURCES}) — import remaining files later`,
        });
        continue;
      }
      try {
        const tables = await parseSpreadsheetBlob(item.fileName, item.blob);
        if (tables.length === 0) {
          skip.push({ file: item.relativePath, reason: "empty or unreadable" });
          continue;
        }
        for (const t of tables) {
          if (next.length >= SERVER_MAX_SOURCES) {
            skip.push({
              file: `${item.relativePath}${t.sheet ? ` [${t.sheet}]` : ""}`,
              reason: `source cap (${SERVER_MAX_SOURCES})`,
            });
            break;
          }
          next.push({
            fileName: item.fileName,
            relativePath: item.relativePath,
            sheet: t.sheet,
            parsed: t.parsed,
            columns: t.parsed.columns,
          });
        }
      } catch (err) {
        skip.push({
          file: item.relativePath,
          reason: err instanceof Error ? err.message : "parse error",
        });
      }
    }
    setSources(next);
    setSkipped(skip);
    setSourceSearch("");
    if (next.length) {
      if (!intoExisting) {
        setProjectName(defaultName);
        setProjectCode(slugCode(defaultName));
      }
    } else {
      toast.error("No tabular files found. Use CSV, TSV, TXT, or .xlsx/.xlsm.");
    }
  }

  async function selectFolder(files: FileList | null) {
    if (!files) return;
    const items = Array.from(files).map((file) => ({
      relativePath: file.webkitRelativePath || file.name,
      fileName: file.name,
      blob: file as Blob,
      size: file.size,
    }));
    const root = items[0]?.relativePath.split("/")[0] || "Imported research data";
    await ingestFiles(items, root);
  }

  async function selectZip(file: File | null) {
    if (!file) return;
    setProgress("Reading zip…");
    setBusy(true);
    try {
      const extracted = await filesFromZip(file);
      const items = extracted.map((e) => ({
        relativePath: e.path,
        fileName: e.path.split("/").pop() || e.path,
        blob: e.blob,
        size: e.blob.size,
      }));
      const defaultName = file.name.replace(/\.zip$/i, "") || "Imported research data";
      await ingestFiles(items, defaultName);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read zip");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  async function importFolder() {
    if (!sources.length) return;
    if (!intoExisting && (!projectName.trim() || !projectCode.trim())) return;
    setBusy(true);
    try {
      setProgress(intoExisting ? "Importing into project…" : "Creating project…");
      const tables = sources.map((source) => {
        const base = source.sheet
          ? `${source.fileName.replace(/\.[^.]+$/, "")} — ${source.sheet}`
          : source.fileName.replace(/\.[^.]+$/, "");
        const valid: Record<string, string | null>[] = [];
        let invalid = 0;
        for (const row of source.parsed.rows) {
          const result = coerceRow(row, source.columns);
          if (result.ok) valid.push(result.row);
          else invalid++;
        }
        return {
          displayName: base.slice(0, 80),
          sourceFilename: source.relativePath,
          columns: source.columns.map((c) => ({
            name: c.name,
            original_name: c.original_name ?? c.name,
            type: c.type,
          })),
          rows: valid,
          invalid,
        };
      });
      const res = await api.executeImportPlan({
        folder: "browser-upload",
        projectId: existingProjectId,
        mode: "deterministic",
        projectInput: intoExisting
          ? undefined
          : {
              project_name: projectName.trim(),
              project_code: projectCode.trim(),
              description: "Imported from a folder / zip",
            },
        // Server folder-job accepts prepared tables via this cast shape.
        tables: tables as never,
      });
      const total = res.results.reduce((s, r) => s + r.inserted, 0);
      toast.success(`Imported ${res.results.length} tables, ${total.toLocaleString()} rows`);
      navigate({ to: "/projects/$projectId", params: { projectId: res.projectId } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Folder import failed");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const filteredSources = useMemo(() => {
    const q = sourceSearch.trim().toLowerCase();
    if (!q) return sources;
    return sources.filter(
      (s) =>
        s.relativePath.toLowerCase().includes(q) ||
        s.fileName.toLowerCase().includes(q) ||
        (s.sheet ?? "").toLowerCase().includes(q) ||
        s.columns.some((c) => c.name.toLowerCase().includes(q)),
    );
  }, [sources, sourceSearch]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:py-14">
      <Link
        to={intoExisting ? "/projects/$projectId" : "/dashboard"}
        params={intoExisting ? { projectId: existingProjectId! } : undefined}
        className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />{" "}
        {intoExisting ? "Back to project" : "Back to projects"}
      </Link>
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
          <FolderOpen className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">
            {intoExisting ? "Add folder to project" : "Import a research folder"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Choose a folder or upload a .zip of CSV/TSV/TXT/Excel files. Each non-empty sheet
            becomes a searchable table (up to {SERVER_MAX_SOURCES} sources).
          </p>
        </div>
      </div>
      <div className="mt-8 space-y-6 rounded-2xl border border-border/70 bg-card p-6 shadow-card">
        <input
          ref={folderInputRef}
          type="file"
          className="hidden"
          multiple
          // Directory picker (Chromium); cast for React DOM typings.
          {...({ webkitdirectory: "true", directory: "true" } as object)}
          accept=".csv,.tsv,.txt,.xlsx,.xlsm"
          aria-label="Choose a research folder"
          onChange={(e) => {
            void selectFolder(e.target.files);
            e.currentTarget.value = "";
          }}
        />
        <input
          ref={zipInputRef}
          type="file"
          className="hidden"
          accept=".zip,application/zip"
          aria-label="Upload a zip of research files"
          onChange={(e) => {
            void selectZip(e.target.files?.[0] ?? null);
            e.currentTarget.value = "";
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => folderInputRef.current?.click()} disabled={busy} className="gap-2">
            <FolderOpen className="h-4 w-4" /> Choose folder
          </Button>
          <Button
            variant="outline"
            onClick={() => zipInputRef.current?.click()}
            disabled={busy}
            className="gap-2"
          >
            Upload .zip
          </Button>
        </div>
        {busy && progress && (
          <p className="text-sm text-muted-foreground">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            {progress}
          </p>
        )}
        {sources.length > 0 && (
          <>
            {!intoExisting && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Project name</Label>
                  <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} />
                </div>
                <div>
                  <Label>Project code</Label>
                  <Input value={projectCode} onChange={(e) => setProjectCode(e.target.value)} />
                </div>
              </div>
            )}
            <div className="rounded-xl border border-border/70">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
                <div className="text-sm font-semibold">
                  Ready to import {sources.length} files/sheets
                  {intoExisting ? ` into ${projectName || "project"}` : ""}
                </div>
                <div className="relative w-full sm:w-64">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={sourceSearch}
                    onChange={(e) => setSourceSearch(e.target.value)}
                    placeholder="Search proposed tables..."
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              </div>
              <div className="max-h-72 overflow-auto">
                {filteredSources.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    No tables match "{sourceSearch.trim()}".
                  </div>
                ) : (
                  filteredSources.map((s, i) => (
                    <div
                      key={`${s.relativePath}-${s.sheet}-${i}`}
                      className="border-b px-3 py-2 text-xs last:border-0"
                    >
                      <span className="font-medium">{s.relativePath}</span>
                      {s.sheet && <span className="text-muted-foreground"> — {s.sheet}</span>}
                      <span className="ml-2 text-muted-foreground">
                        {s.parsed.rows.length.toLocaleString()} rows · {s.columns.length} columns
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
            {skipped.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
                Skipped {skipped.length}:{" "}
                {skipped
                  .slice(0, 12)
                  .map((s) => `${pathBasename(s.file)} (${s.reason})`)
                  .join("; ")}
                {skipped.length > 12 && " …"}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Files are parsed in your browser, then uploaded. PDF/Word/images are skipped until
              exported to CSV/XLSX.
            </p>
            <Button
              onClick={() => void importFolder()}
              disabled={busy || (!intoExisting && (!projectName.trim() || !projectCode.trim()))}
            >
              {busy
                ? progress || "Importing…"
                : intoExisting
                  ? "Import into project"
                  : "Create database and import"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
