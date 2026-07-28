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
  KeyRound,
  Link2,
  Loader2,
  Sparkles,
} from "lucide-react";
import { isServerMode } from "@/lib/mode";
import { parseCsv, coerceRow, type ColumnSchema, type ParsedCsv } from "@/lib/csv";
import { isSpreadsheetFile, isXlsxFile, parseXlsx } from "@/lib/xlsx";

export const Route = createFileRoute("/_authenticated/import-folder")({
  component: ImportFolderPage,
});

type Stage = "pick" | "analyzing" | "review" | "importing";

function slugCode(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "AI-IMPORT"
  );
}

function ImportFolderPage() {
  if (isServerMode) return <ServerFolderImportPage />;

  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("pick");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [analysis, setAnalysis] = useState<AnalyzeFolderResult | null>(null);
  const [tables, setTables] = useState<PlannedTable[]>([]);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [projectName, setProjectName] = useState("");
  const [projectCode, setProjectCode] = useState("");

  useEffect(() => {
    void api.getSetting("nvidia_api_key").then((k) => setHasKey(Boolean(k)));
  }, []);

  useEffect(() => {
    const off = api.onImportProgress((msg) => setProgress(msg));
    return off;
  }, []);

  const analyze = useMutation({
    mutationFn: async () => {
      const folder = await api.pickImportFolder();
      if (!folder) return null;
      setStage("analyzing");
      setProgress("Scanning folder…");
      return api.analyzeFolder(folder);
    },
    onSuccess: (res) => {
      if (!res) {
        setStage("pick");
        return;
      }
      setAnalysis(res);
      setTables(res.plan.tables);
      setIncluded(Object.fromEntries(res.plan.tables.map((t) => [t.key, true])));
      setProjectName(res.plan.project_name);
      setProjectCode(slugCode(res.plan.project_name));
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
      if (!projectName.trim() || !projectCode.trim()) {
        throw new Error("Project name and code are required");
      }
      setStage("importing");
      setProgress("Creating project…");
      return api.executeImportPlan({
        folder: analysis.folder,
        projectInput: {
          project_name: projectName.trim(),
          project_code: projectCode.trim(),
          description: analysis.plan.notes || null,
        },
        tables: chosen,
      });
    },
    onSuccess: (res) => {
      const total = res.results.reduce((s, r) => s + r.inserted, 0);
      toast.success(`Imported ${res.results.length} tables, ${total.toLocaleString()} rows`);
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
      name: projectName || "AI import",
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

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <Link
        to="/dashboard"
        className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to projects
      </Link>
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
          <Bot className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">
            Create project from folder
          </h1>
          <p className="text-sm text-muted-foreground">
            Review the files and sheets first, then build a shared research workspace.
          </p>
        </div>
      </div>

      {stage === "pick" && (
        <div className="mt-8 rounded-2xl border border-border/70 bg-card p-10 text-center shadow-card">
          {hasKey === false ? (
            <div className="mx-auto max-w-md">
              <KeyRound className="mx-auto h-8 w-8 text-muted-foreground" />
              <h2 className="mt-3 text-lg font-bold text-foreground">NVIDIA API key needed</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Folder analysis uses NVIDIA's Nemotron API. Add your key (free at build.nvidia.com)
                in Settings first.
              </p>
              <Button asChild className="mt-4">
                <Link to="/settings">Open Settings</Link>
              </Button>
            </div>
          ) : (
            <div className="mx-auto max-w-md">
              <FolderOpen className="mx-auto h-8 w-8 text-primary" />
              <h2 className="mt-3 text-lg font-bold text-foreground">Pick a data folder</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                CSV, .xlsx, and .xlsm files inside the folder are reviewed. Legacy .xls files are
                not supported.
              </p>
              <Button
                className="mt-4 gap-1.5 bg-gradient-primary text-white shadow-cta hover-lift-sm hover:opacity-95"
                onClick={() => analyze.mutate()}
                disabled={analyze.isPending || hasKey === null}
              >
                <FolderOpen className="h-4 w-4" /> Choose folder…
              </Button>
            </div>
          )}
        </div>
      )}

      {(stage === "analyzing" || stage === "importing") && (
        <div className="mt-8 rounded-2xl border border-border/70 bg-card p-10 text-center shadow-card">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <h2 className="mt-3 text-lg font-bold text-foreground">
            {stage === "analyzing" ? "Analyzing folder…" : "Building your database…"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{progress}</p>
        </div>
      )}

      {stage === "review" && analysis && (
        <div className="mt-8 space-y-6">
          {analysis.plan.notes && (
            <div className="rounded-2xl border border-primary/25 bg-gradient-primary-soft p-4 text-sm text-foreground shadow-card">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-primary">
                <Sparkles className="h-3.5 w-3.5" /> AI modeling notes
              </div>
              {analysis.plan.notes}
            </div>
          )}

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

          <div className="space-y-3">
            <h2 className="text-lg font-bold text-foreground">
              Proposed tables ({tables.filter((t) => included[t.key]).length}/{tables.length})
            </h2>
            {tables.map((t, ti) => (
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
                      onCheckedChange={(v) => setIncluded((m) => ({ ...m, [t.key]: Boolean(v) }))}
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
            ))}
          </div>

          {analysis.skipped.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
              Skipped {analysis.skipped.length} file(s):{" "}
              {analysis.skipped
                .slice(0, 5)
                .map((s) => `${s.file} (${s.reason})`)
                .join("; ")}
              {analysis.skipped.length > 5 && " …"}
            </div>
          )}

          {previewTemplate.tables.length > 0 && <ErdDiagram template={previewTemplate} />}

          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setStage("pick")} className="gap-1">
              <ArrowLeft className="h-3.5 w-3.5" /> Start over
            </Button>
            <Button
              onClick={() => runImport.mutate()}
              disabled={runImport.isPending}
              className="gap-1.5 bg-gradient-primary text-white shadow-cta hover-lift-sm hover:opacity-95"
            >
              Create project & import <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type ServerSource = {
  file: File;
  sheet: string | null;
  parsed: ParsedCsv;
  columns: ColumnSchema[];
};

function ServerFolderImportPage() {
  const navigate = useNavigate();
  const [sources, setSources] = useState<ServerSource[]>([]);
  const [projectName, setProjectName] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function selectFolder(files: FileList | null) {
    if (!files) return;
    const next: ServerSource[] = [];
    for (const file of Array.from(files)) {
      if (!isSpreadsheetFile(file.name) || file.size > 50 * 1024 * 1024) continue;
      try {
        if (isXlsxFile(file.name)) {
          for (const sheet of await parseXlsx(file)) {
            next.push({
              file,
              sheet: sheet.name,
              parsed: sheet.parsed,
              columns: sheet.parsed.columns,
            });
          }
        } else {
          const parsed = parseCsv(await file.text());
          if (parsed.columns.length && parsed.rows.length)
            next.push({ file, sheet: null, parsed, columns: parsed.columns });
        }
      } catch {
        // Unreadable files are omitted from the review list; the researcher can retry them individually.
      }
    }
    setSources(next);
    if (next.length) {
      const root = next[0]?.file.webkitRelativePath?.split("/")[0] || "Imported research data";
      setProjectName(root);
      setProjectCode(slugCode(root));
    }
  }

  async function importFolder() {
    if (!sources.length || !projectName.trim() || !projectCode.trim()) return;
    setBusy(true);
    let projectId: string | null = null;
    try {
      setProgress("Creating project…");
      projectId = await api.createProject({
        project_name: projectName.trim(),
        project_code: projectCode.trim(),
        description: "Imported from a folder",
      });
      let completed = 0;
      for (const source of sources) {
        const base = source.sheet
          ? `${source.file.name.replace(/\.[^.]+$/, "")} — ${source.sheet}`
          : source.file.name.replace(/\.[^.]+$/, "");
        const created = await api.createProjectDataset({
          projectId,
          displayName: base.slice(0, 80),
          sourceFilename: source.file.webkitRelativePath || source.file.name,
          columns: source.columns,
        });
        const valid: Record<string, string | null>[] = [];
        for (const row of source.parsed.rows) {
          const result = coerceRow(row, source.columns);
          if (result.ok) valid.push(result.row);
        }
        for (let i = 0; i < valid.length; i += 1000) {
          await api.insertDatasetRowsTyped(created.dataset_id, valid.slice(i, i + 1000));
        }
        completed++;
        setProgress(`Imported ${completed} of ${sources.length} files/sheets…`);
      }
      toast.success(`Imported ${sources.length} files/sheets into ${projectName}`);
      navigate({ to: "/projects/$projectId", params: { projectId } });
    } catch (err) {
      if (projectId) {
        try {
          await api.deleteProject(projectId);
        } catch {
          // Preserve the original import error if cleanup is unavailable.
        }
      }
      toast.error(err instanceof Error ? err.message : "Folder import failed");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:py-14">
      <Link
        to="/dashboard"
        className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to projects
      </Link>
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
          <FolderOpen className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Import a research folder</h1>
          <p className="text-sm text-muted-foreground">
            Choose a folder containing CSV and Excel files. Each non-empty sheet becomes a
            searchable data table.
          </p>
        </div>
      </div>
      <div className="mt-6 grid gap-2 sm:grid-cols-3" aria-label="Import steps">
        {[
          ["1", "Choose folder"],
          ["2", "Review files"],
          ["3", "Import data"],
        ].map(([number, label], index) => (
          <div
            key={number}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
              index === 0
                ? "border-primary/40 bg-primary/5 text-primary"
                : "border-border/70 text-muted-foreground"
            }`}
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-secondary text-[11px]">
              {number}
            </span>
            {label}
          </div>
        ))}
      </div>
      <div className="mt-8 space-y-6 rounded-2xl border border-border/70 bg-card p-6 shadow-card">
        {/* @ts-expect-error React's DOM types do not yet include the directory picker attribute. */}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          webkitdirectory="true"
          accept=".csv,.xlsx,.xlsm"
          aria-label="Choose a research folder"
          onChange={(e) => {
            void selectFolder(e.target.files);
            // Allow selecting the same folder again after correcting a file.
            e.currentTarget.value = "";
          }}
        />
        <Button onClick={() => inputRef.current?.click()} disabled={busy} className="gap-2">
          <FolderOpen className="h-4 w-4" /> Choose folder
        </Button>
        {sources.length > 0 && (
          <>
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
            <div className="rounded-xl border border-border/70">
              <div className="border-b p-3 text-sm font-semibold">
                Ready to import {sources.length} files/sheets
              </div>
              <div className="max-h-72 overflow-auto">
                {sources.map((s, i) => (
                  <div
                    key={`${s.file.name}-${s.sheet}-${i}`}
                    className="border-b px-3 py-2 text-xs last:border-0"
                  >
                    <span className="font-medium">{s.file.webkitRelativePath || s.file.name}</span>
                    {s.sheet && <span className="text-muted-foreground"> — {s.sheet}</span>}
                    <span className="ml-2 text-muted-foreground">
                      {s.parsed.rows.length.toLocaleString()} rows · {s.columns.length} columns
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Nothing changes on the lab server until you click Import. Files are checked in your
              browser, then the resulting data is uploaded. Source paths are retained for
              provenance; unsupported or unreadable files are not imported.
            </p>
            <Button
              onClick={() => void importFolder()}
              disabled={busy || !projectName.trim() || !projectCode.trim()}
            >
              {busy ? progress || "Importing…" : "Create database and import"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
