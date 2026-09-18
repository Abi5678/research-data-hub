import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { diffLines } from "diff";
import { api, type Script, type ScriptRun } from "@/lib/api";
import {
  assistSystemPrompt,
  assistUserPrompt,
  parseAssistReply,
  SAMPLE_ROWS,
} from "@/lib/script-assist";
import { coerceRow, parseCsv, type ColumnSchema, type ParsedCsv } from "@/lib/csv";
import { isXlsxFile, parseXlsx } from "@/lib/xlsx";
import { BUNDLED_SCRIPTS } from "@/lib/bundled-scripts";
import { ResultsTable } from "@/components/project/results-table";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  FileCode2,
  FilePlus2,
  FolderOpen,
  Play,
  Square,
  Trash2,
  AlertTriangle,
  Settings2,
  Sparkles,
  Wrench,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Recorded once per project, so the "this runs on your computer" warning is a
 *  real acknowledgement rather than a dialog people learn to click through. */
const TRUST_SETTING = (projectId: string) => `scripts_trusted_${projectId}`;

type LogLine = { kind: "status" | "stdout" | "stderr"; text: string };

/** Only what this tab needs, so it accepts the project page's dataset rows
 *  without them having to be a full `Dataset`. */
type DatasetOption = {
  id: string;
  display_name: string;
  column_schema: ColumnSchema[];
  unavailable_reason?: string | null;
};

export function ScriptsTab({
  projectId,
  datasets,
}: {
  projectId: string;
  datasets: DatasetOption[];
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  /** Set while the editor holds unsaved edits, so switching scripts does not
   *  silently discard them and saving does not fight the query cache. */
  const [dirty, setDirty] = useState(false);
  const [datasetIds, setDatasetIds] = useState<string[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  /** The script that owns the in-flight run — distinct from `selectedId`
   *  because the sidebar doesn't lock while a run is going, so what's running
   *  and what's displayed can point at two different scripts. */
  const [activeScriptId, setActiveScriptId] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<ScriptRun | null>(null);
  const [pendingRun, setPendingRun] = useState(false);
  const [confirmTrust, setConfirmTrust] = useState(false);
  const [deleting, setDeleting] = useState<Script | null>(null);
  /** The AI's rewrite, held here until the user accepts it. Nothing can run
   *  from this state — accepting copies it into the editor, and running is
   *  still a separate click. */
  const [proposal, setProposal] = useState<{ code: string; notes: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const scripts = useQuery({
    queryKey: ["scripts", projectId],
    queryFn: () => api.listScripts(projectId),
  });
  const runtimes = useQuery({ queryKey: ["runtimes"], queryFn: () => api.detectRuntimes() });
  const trusted = useQuery({
    queryKey: ["scripts-trusted", projectId],
    queryFn: () => api.getSetting(TRUST_SETTING(projectId)),
  });
  // False in this build unless an LLM is configured, so every AI control is an
  // addition to a tab that already works without it.
  const aiAvailable = useQuery({
    queryKey: ["ai-available"],
    queryFn: () => api.isAiAssistAvailable(),
  });

  const selected = useMemo(
    () => scripts.data?.find((s) => s.id === selectedId) ?? null,
    [scripts.data, selectedId],
  );
  const runnableDatasets = useMemo(
    () => datasets.filter((d) => !d.unavailable_reason),
    [datasets],
  );
  const selectedDatasets = useMemo(
    () => runnableDatasets.filter((d) => datasetIds.includes(d.id)),
    [runnableDatasets, datasetIds],
  );
  const dataset = selectedDatasets[0] ?? null;
  // Counted off selectedDatasets, not datasetIds: an id left over from a dataset
  // that has since become unavailable would otherwise read as a selection.
  const allSelected =
    runnableDatasets.length > 0 && selectedDatasets.length === runnableDatasets.length;

  const interpreter = selected
    ? selected.language === "matlab"
      ? runtimes.data?.matlab.selected
      : runtimes.data?.python.selected
    : null;

  const runs = useQuery({
    queryKey: ["script-runs", selectedId],
    queryFn: () => api.listScriptRuns(selectedId!),
    enabled: !!selectedId,
  });

  // Load the selected script into the editor. Skipped while dirty so a
  // background refetch cannot overwrite what someone is typing.
  useEffect(() => {
    if (selected && !dirty) setCode(selected.code);
  }, [selected, dirty]);

  useEffect(() => {
    if (!selectedId && scripts.data?.length) setSelectedId(scripts.data[0].id);
  }, [scripts.data, selectedId]);

  const datasetsInitialized = useRef(false);
  useEffect(() => {
    if (datasetsInitialized.current || runnableDatasets.length === 0) return;
    datasetsInitialized.current = true;
    setDatasetIds(runnableDatasets.map((d) => d.id));
  }, [runnableDatasets]);

  useEffect(() => {
    return api.onScriptRunEvent((event) => {
      // A stray/late event from a run this tab is no longer tracking (e.g. it
      // already reported "done" once). Never let it reopen a finished run.
      if (event.runId !== activeRunId) return;
      // The run belongs to whichever script started it, which may not be the
      // one currently open in the editor — don't paint another script's
      // output into this one's log.
      const forSelectedScript = activeScriptId === selectedId;
      if (event.kind === "done") {
        setActiveRunId(null);
        setPendingRun(false);
        if (event.error) {
          if (forSelectedScript) setLog((prev) => [...prev, { kind: "stderr", text: event.error! }]);
          toast.error(event.error);
        } else if (event.run) {
          if (forSelectedScript) setLastRun(event.run);
        }
        void queryClient.invalidateQueries({ queryKey: ["script-runs", activeScriptId] });
        return;
      }
      if (forSelectedScript) setLog((prev) => [...prev, { kind: event.kind, text: event.text }]);
    });
  }, [queryClient, selectedId, activeRunId, activeScriptId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const createScript = useMutation({
    mutationFn: (args: Parameters<typeof api.createScript>[0]) => api.createScript(args),
    onSuccess: (script) => {
      void queryClient.invalidateQueries({ queryKey: ["scripts", projectId] });
      setDirty(false);
      setCode(script.code);
      setSelectedId(script.id);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const saveScript = useMutation({
    mutationFn: () => api.updateScript(selectedId!, { code }),
    onSuccess: () => {
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["scripts", projectId] });
      toast.success("Saved");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteScript = useMutation({
    mutationFn: (id: string) => api.deleteScript(id),
    onSuccess: (name) => {
      setDeleting(null);
      setSelectedId(null);
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["scripts", projectId] });
      toast.success(`Deleted “${name}”`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function addFromFile() {
    const picked = await api.pickScriptFile();
    if (!picked) return;
    createScript.mutate({
      projectId,
      name: picked.name,
      language: picked.language,
      code: picked.code,
      originPath: picked.path,
    });
  }

  /** `trustChecked` is passed by the confirmation dialog. Re-reading
   *  `trusted.data` there would see the pre-refetch value and reopen the dialog
   *  forever, since this closure captured it at render. */
  async function startRun(trustChecked = false) {
    if (!selected || selectedDatasets.length === 0) return;
    if (!trustChecked && !trusted.data) {
      setConfirmTrust(true);
      return;
    }
    // Whatever is in the editor is what should run; saving first is the only way
    // to make that true, since the runner reads the code out of the database.
    if (dirty) await saveScript.mutateAsync();
    setLog([]);
    setLastRun(null);
    setPendingRun(true);
    try {
      const { runId } = await api.runScript({
        scriptId: selected.id,
        datasetIds: selectedDatasets.map((d) => d.id),
      });
      setActiveRunId(runId);
      setActiveScriptId(selected.id);
    } catch (err) {
      setPendingRun(false);
      toast.error((err as Error).message);
    }
  }

  /** Asks the model to rewrite the file. It returns a proposal and nothing more:
   *  the code is not saved and not run until the user reads the diff. */
  async function askAi(failure?: { stderr: string; exitCode: number | null }) {
    if (!selected || !dataset) return;
    setAsking(true);
    try {
      const rows = await api.queryDataset(dataset.id, SAMPLE_ROWS);
      const reply = await api.llmChat([
        { role: "system", content: assistSystemPrompt(selected.language) },
        {
          role: "user",
          content: assistUserPrompt({
            code,
            language: selected.language,
            dataset: {
              display_name: dataset.display_name,
              column_schema: dataset.column_schema,
              sampleRows: rows,
            },
            failure,
          }),
        },
      ]);
      const result = parseAssistReply(reply);
      if (result.code.trim() === code.trim()) {
        toast.info("The assistant returned the script unchanged.");
        return;
      }
      setProposal(result);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setAsking(false);
    }
  }

  const running = pendingRun || !!activeRunId;
  const canAsk = !!aiAvailable.data && !!dataset && !asking && !running;
  const failedRun = lastRun && lastRun.status !== "ok" ? lastRun : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-3">
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={() => void addFromFile()}>
            <FolderOpen className="h-3.5 w-3.5" /> Add file
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              createScript.mutate({
                projectId,
                name: "New analysis.py",
                language: "python",
                code: "import pandas as pd\n\ndf = pd.read_csv('data.csv')\nprint(df.head())\n",
              })
            }
          >
            <FilePlus2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="space-y-1">
          {scripts.data?.length === 0 && (
            <div className="space-y-2 rounded-lg border border-dashed border-border/70 p-3">
              <p className="text-xs text-muted-foreground">
                Add an existing Python or MATLAB script, or start with IDEAL-CT. The file is copied
                in — the original on disk is never changed.
              </p>
              {BUNDLED_SCRIPTS.map((bundled) => (
                <Button
                  key={bundled.id}
                  size="sm"
                  variant="secondary"
                  className="w-full justify-start text-left"
                  onClick={() =>
                    createScript.mutate({
                      projectId,
                      name: bundled.name,
                      language: bundled.language,
                      code: bundled.code,
                    })
                  }
                >
                  <FileCode2 className="h-3.5 w-3.5" /> {bundled.name}
                </Button>
              ))}
            </div>
          )}
          {scripts.data?.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setDirty(false);
                setSelectedId(s.id);
                setLog([]);
                setLastRun(null);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs",
                s.id === selectedId ? "bg-secondary" : "hover:bg-secondary/50",
              )}
            >
              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {s.run_count ? `${s.run_count} runs` : s.language}
              </span>
            </button>
          ))}
          {BUNDLED_SCRIPTS.filter(
            (b) => !scripts.data?.some((s) => s.name === b.name),
          ).map((bundled) => (
            <button
              key={bundled.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] text-muted-foreground hover:bg-secondary/50"
              onClick={() =>
                createScript.mutate({
                  projectId,
                  name: bundled.name,
                  language: bundled.language,
                  code: bundled.code,
                })
              }
            >
              <FilePlus2 className="h-3.5 w-3.5 shrink-0" />
              Add {bundled.name}
            </button>
          ))}
        </div>
      </aside>

      {!selected ? (
        <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed border-border/70 text-sm text-muted-foreground">
          Select a script, or add one.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">Datasets</Label>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {/* The count is what the box cannot show once the list scrolls. */}
                  {runnableDatasets.length > 0 && (
                    <span>
                      {selectedDatasets.length} of {runnableDatasets.length} selected
                    </span>
                  )}
                  <button
                    type="button"
                    className="underline disabled:no-underline disabled:opacity-50"
                    disabled={runnableDatasets.length === 0}
                    onClick={() => {
                      setDatasetIds(allSelected ? [] : runnableDatasets.map((d) => d.id));
                    }}
                  >
                    {allSelected ? "Clear" : "Select all"}
                  </button>
                </div>
              </div>
              <div className="mt-1 max-h-72 space-y-1 overflow-y-auto rounded-md border border-border/70 p-2">
                {runnableDatasets.length === 0 && (
                  <p className="text-[11px] text-muted-foreground">Import an Excel or CSV first.</p>
                )}
                {runnableDatasets.map((d) => (
                  <label key={d.id} className="flex cursor-pointer items-start gap-2 text-xs">
                    <Checkbox
                      checked={datasetIds.includes(d.id)}
                      onCheckedChange={(on) =>
                        setDatasetIds((prev) =>
                          on ? [...prev, d.id] : prev.filter((id) => id !== d.id),
                        )
                      }
                    />
                    <span className="min-w-0 leading-4">
                      <span className="block truncate">{d.display_name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {d.column_schema.filter((c) => c.name !== "row_id").length} columns
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <Button
              onClick={() => void startRun()}
              disabled={running || selectedDatasets.length === 0 || !interpreter}
            >
              <Play className="h-3.5 w-3.5" /> Run
            </Button>
            {running && (
              <Button
                variant="outline"
                onClick={() => activeRunId && void api.cancelScriptRun(activeRunId)}
              >
                <Square className="h-3.5 w-3.5" /> Stop
              </Button>
            )}
            {aiAvailable.data && (
              <Button variant="outline" disabled={!canAsk} onClick={() => void askAi()}>
                {asking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Adapt to this dataset
              </Button>
            )}
            <Button variant="outline" disabled={!dirty} onClick={() => saveScript.mutate()}>
              Save
            </Button>
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(selected)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Only once detection has actually finished. Probing every interpreter
              takes several seconds, and saying "no Python" while still looking
              sends people to Settings to fix a problem they do not have. */}
          {runtimes.isSuccess && !interpreter && (
            <p className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <Settings2 className="h-3.5 w-3.5 shrink-0" />
              No {selected.language === "matlab" ? "MATLAB" : "Python"} chosen. Pick one under
              Settings before running.
            </p>
          )}

          {proposal && (
            <ProposedChange
              current={code}
              proposal={proposal}
              onAccept={() => {
                setCode(proposal.code);
                setDirty(true);
                setProposal(null);
              }}
              onDiscard={() => setProposal(null)}
            />
          )}

          <div className="grid gap-4 xl:grid-cols-[1fr_240px]">
            <div className="overflow-hidden rounded-lg border border-border/70">
              <CodeMirror
                value={code}
                height="380px"
                // MATLAB gets no highlighting mode; CodeMirror has no MATLAB
                // grammar and Python's would mis-colour it more than it helps.
                extensions={selected.language === "python" ? [python()] : []}
                onChange={(v) => {
                  setCode(v);
                  setDirty(true);
                }}
                basicSetup={{ lineNumbers: true, foldGutter: false }}
              />
            </div>

            {/* The exact column names, next to the code. Most of the work of
                adapting an old script is finding out what the columns are
                actually called this year. */}
            <div className="rounded-lg border border-border/70 p-3">
              <p className="text-xs font-medium">
                Selected tables are written as CSV files plus{" "}
                <code className="rounded bg-secondary px-1 py-0.5 text-[10px]">inputs.json</code>
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                The first table is{" "}
                <code className="rounded bg-secondary px-1 py-0.5 text-[10px]">data.csv</code>.
                Each extra sheet or file is{" "}
                <code className="rounded bg-secondary px-1 py-0.5 text-[10px]">data_&lt;name&gt;.csv</code>
                . IDEAL-CT finds specimens in those tables automatically.
              </p>
              <p className="mt-3 text-xs font-medium">
                Columns{selectedDatasets.length > 1 ? ` · ${selectedDatasets.length} tables` : ""}
              </p>
              <ul className="mt-1 max-h-[280px] space-y-2 overflow-y-auto text-[11px]">
                {selectedDatasets.map((ds) => (
                  <li key={ds.id}>
                    <p className="truncate font-medium text-muted-foreground">{ds.display_name}</p>
                    {ds.column_schema
                      .filter((c) => c.name !== "row_id")
                      .map((c) => (
                        <div key={c.name} className="flex items-baseline justify-between gap-2 pl-1">
                          <code className="truncate">{c.name}</code>
                          <span className="shrink-0 text-muted-foreground">{c.type}</span>
                        </div>
                      ))}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {(log.length > 0 || lastRun) && (
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-xs">
                <span className="font-medium">Output</span>
                {lastRun && (
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] uppercase",
                      lastRun.status === "ok"
                        ? "bg-emerald-500/15 text-emerald-600"
                        : "bg-destructive/15 text-destructive",
                    )}
                  >
                    {lastRun.status}
                  </span>
                )}
                {lastRun && (
                  <button
                    className="text-[11px] text-muted-foreground underline"
                    onClick={() => void api.openRunFolder(lastRun.id)}
                  >
                    Open run folder
                  </button>
                )}
                {failedRun && aiAvailable.data && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[11px]"
                    disabled={!canAsk}
                    onClick={() =>
                      void askAi({
                        stderr: failedRun.stderr ?? "",
                        exitCode: failedRun.exit_code,
                      })
                    }
                  >
                    <Wrench className="h-3 w-3" /> Ask AI to fix this
                  </Button>
                )}
              </div>
              <div
                ref={logRef}
                className="max-h-[280px] overflow-y-auto rounded-lg border border-border/70 bg-secondary/30 p-3 font-mono text-[11px] whitespace-pre-wrap"
              >
                {log.map((line, i) => (
                  <span
                    key={i}
                    className={cn(
                      line.kind === "stderr" && "text-destructive",
                      line.kind === "status" && "text-muted-foreground",
                    )}
                  >
                    {line.kind === "status" ? `• ${line.text}\n` : line.text}
                  </span>
                ))}
              </div>
              {lastRun && lastRun.outputs.length > 0 && (
                <RunOutputs run={lastRun} projectId={projectId} />
              )}
            </div>
          )}

          {runs.data && runs.data.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              {runs.data.length} recent run{runs.data.length === 1 ? "" : "s"} — latest{" "}
              {runs.data[0].status} at {new Date(runs.data[0].started_at).toLocaleString()}
            </div>
          )}
        </div>
      )}

      <AlertDialog open={confirmTrust} onOpenChange={setConfirmTrust}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Run scripts in this project?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Scripts run on this computer with your full permissions — they can read and write
              your files, exactly as if you had run them in a terminal. Only run scripts you
              trust. Asked once per project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await api.setSetting(TRUST_SETTING(projectId), "1");
                void trusted.refetch();
                void startRun(true);
              }}
            >
              I understand — run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The script and its run history are removed from this project. The original file on
              disk is not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleting && deleteScript.mutate(deleting.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/**
 * How many figures render at full size before the rest become thumbnails.
 *
 * A per-specimen script writes one plot per specimen — the IDEAL-CT template
 * writes 30 — and at 420px each that is thirty screens of scrolling with the
 * log stranded at the top. Figures are ordered by how deep in the run folder
 * they sit, so a summary figure written beside the results (ct_index.png) is
 * the one that stays big and a folder of per-item plots collapses.
 */
const FULL_SIZE_FIGURES = 2;

/** Rows of a result CSV shown inline before the reader is told to go look. */
const PREVIEW_ROWS = 10;

/**
 * Result CSVs above this size are listed but not previewed. The preview reads
 * the whole file back over IPC and parses it in the renderer to show ten rows;
 * a deliverable table is kilobytes, and a script that dumps half a million rows
 * should not stall the run report to show the top of it.
 */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

type CsvPreview = {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  /** Set only for a workbook: which sheet is shown, and how many there are. */
  sheet?: string;
  sheets?: number;
};

/** A result file the run report can read as a table. */
function isTabular(out: { name: string; kind: string }): boolean {
  return out.kind === "csv" || isXlsxFile(out.name);
}

/**
 * A result file as named tables — one for a CSV, one per sheet for a workbook.
 *
 * The .xlsx is usually the copy that actually gets emailed, so it has to be
 * readable here on the same terms as the CSV rather than being a filename with
 * no way in.
 */
async function readOutputTables(
  runId: string,
  name: string,
): Promise<{ label: string; parsed: ParsedCsv }[]> {
  const file = await api.readRunFile(runId, name);
  const bytes = base64ToBytes(file.base64);
  if (isXlsxFile(name)) {
    const sheets = await parseXlsx(new File([bytes], name));
    return sheets.map((s) => ({ label: s.name, parsed: s.parsed }));
  }
  return [{ label: "", parsed: parseCsv(new TextDecoder().decode(bytes)) }];
}

/**
 * What the script left behind. Figures are shown rather than named — the figure
 * is usually the whole reason the script was run — and a result CSV can be
 * imported straight back, so script output becomes queryable project data.
 */
function RunOutputs({ run, projectId }: { run: ScriptRun; projectId: string }) {
  const queryClient = useQueryClient();
  const [images, setImages] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Record<string, CsvPreview>>({});
  const [importing, setImporting] = useState<string | null>(null);

  const figures = useMemo(
    () =>
      run.outputs
        .filter((o) => o.kind === "image")
        .sort((a, b) => depthOf(a.name) - depthOf(b.name)),
    [run],
  );
  const files = useMemo(() => run.outputs.filter((o) => o.kind !== "image"), [run]);

  useEffect(() => {
    let cancelled = false;
    setImages({});
    setExpanded(new Set());
    for (const out of figures) {
      const ext = out.name.split(".").pop()?.toLowerCase() ?? "";
      const mime = IMAGE_MIME[ext];
      if (!mime) continue;
      void api
        .readRunFile(run.id, out.name)
        .then((f) => {
          if (!cancelled) {
            setImages((prev) => ({ ...prev, [out.name]: `data:${mime};base64,${f.base64}` }));
          }
        })
        // A figure that cannot be read back is not worth interrupting the run
        // report for; the file is still listed and the folder still opens.
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [figures]);

  useEffect(() => {
    let cancelled = false;
    setPreviews({});
    for (const out of files) {
      if (!isTabular(out) || out.size > PREVIEW_MAX_BYTES) continue;
      void readOutputTables(run.id, out.name)
        .then((tables) => {
          // A workbook previews its first sheet; the row says how many there are.
          const first = tables[0];
          if (cancelled || !first || first.parsed.columns.length === 0) return;
          const { parsed } = first;
          setPreviews((prev) => ({
            ...prev,
            [out.name]: {
              columns: parsed.columns.map((c) => c.name),
              rows: parsed.rows.slice(0, PREVIEW_ROWS).map((r) => previewRow(r, parsed.columns)),
              total: parsed.meta.totalRows,
              sheet: first.label || undefined,
              sheets: tables.length > 1 ? tables.length : undefined,
            },
          }));
        })
        // Same as a figure that will not read back: the file row and the run
        // folder are still there, so a preview is not worth an error for.
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [files]);

  async function importTables(name: string) {
    setImporting(name);
    try {
      const tables = (await readOutputTables(run.id, name)).filter(
        (t) => t.parsed.columns.length > 0 && t.parsed.rows.length > 0,
      );
      if (tables.length === 0) throw new Error("That file has no rows to import.");

      // A workbook becomes one dataset per sheet, named so two sheets of the same
      // workbook cannot collide and so the row still says where it came from.
      const base = name.replace(/\.(csv|xlsx|xlsm)$/i, "");
      let imported = 0;
      for (const { label, parsed } of tables) {
        const created = await api.createProjectDataset({
          projectId,
          displayName: tables.length > 1 ? `${base} — ${label}` : base,
          sourceFilename: name,
          columns: parsed.columns.map((c) => ({
            name: c.name,
            original_name: c.original_name ?? c.name,
            type: c.type,
          })),
        });
        const rows = parsed.rows.map((raw) => coerceRow(raw, parsed.columns).row);
        const CHUNK = 1000;
        for (let i = 0; i < rows.length; i += CHUNK) {
          await api.insertDatasetRowsTyped(created.dataset_id, rows.slice(i, i + CHUNK));
        }
        imported += rows.length;
      }
      void queryClient.invalidateQueries({ queryKey: ["datasets", projectId] });
      toast.success(
        tables.length > 1
          ? `Imported ${tables.length} sheets, ${imported.toLocaleString()} rows`
          : `Imported ${imported.toLocaleString()} rows as a dataset`,
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setImporting(null);
    }
  }

  function toggle(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  const big = figures.slice(0, FULL_SIZE_FIGURES);
  const small = figures.slice(FULL_SIZE_FIGURES);

  return (
    <div className="space-y-4">
      {figures.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium">
            {figures.length === 1 ? "1 figure" : `${figures.length} figures`}
          </p>
          {big.map((out) => (
            <div key={out.name} className="rounded-md border border-border/70 p-2">
              <div className="flex items-center gap-2 text-[11px]">
                <code className="truncate">{out.name}</code>
                <span className="text-muted-foreground">{formatSize(out.size)}</span>
              </div>
              {images[out.name] && (
                <img
                  src={images[out.name]}
                  alt={out.name}
                  className="mt-2 max-h-[420px] w-auto rounded border border-border/70 bg-white"
                />
              )}
            </div>
          ))}
          {small.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {small.map((out) =>
                expanded.has(out.name) ? (
                  <button
                    key={out.name}
                    type="button"
                    title={`${out.name} — click to collapse`}
                    className="w-full rounded-md border border-border/70 p-2 text-left"
                    onClick={() => toggle(out.name)}
                  >
                    <div className="flex items-center gap-2 text-[11px]">
                      <code className="truncate">{out.name}</code>
                      <span className="text-muted-foreground">{formatSize(out.size)}</span>
                    </div>
                    {images[out.name] && (
                      <img
                        src={images[out.name]}
                        alt={out.name}
                        className="mt-2 max-h-[420px] w-auto rounded border border-border/70 bg-white"
                      />
                    )}
                  </button>
                ) : (
                  <button
                    key={out.name}
                    type="button"
                    title={`${out.name} — click to enlarge`}
                    className="rounded border border-border/70 bg-white p-0.5 hover:border-primary"
                    onClick={() => toggle(out.name)}
                  >
                    {images[out.name] ? (
                      <img src={images[out.name]} alt={out.name} className="h-20 w-auto" />
                    ) : (
                      <span className="flex h-20 w-28 items-center justify-center px-1 text-[10px] text-muted-foreground">
                        {out.name}
                      </span>
                    )}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      )}
      {files.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium">Files this run wrote</p>
          <ul className="space-y-2">
            {files.map((out) => (
              <li key={out.name} className="rounded-md border border-border/70 p-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <code className="truncate">{out.name}</code>
                  <span className="text-muted-foreground">{formatSize(out.size)}</span>
                  {isTabular(out) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-6 text-[11px]"
                      disabled={!!importing}
                      onClick={() => void importTables(out.name)}
                    >
                      {importing === out.name ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <FilePlus2 className="h-3 w-3" />
                      )}
                      Import as dataset
                    </Button>
                  )}
                </div>
                {previews[out.name] && (
                  <div className="mt-2">
                    {/* Only worth saying which sheet this is when there is more than one. */}
                    {previews[out.name].sheets && (
                      <p className="mb-1 text-[10px] text-muted-foreground">
                        Sheet “{previews[out.name].sheet}” of {previews[out.name].sheets} — Import
                        as dataset brings in all of them.
                      </p>
                    )}
                    <ResultsTable
                      columns={previews[out.name].columns}
                      rows={previews[out.name].rows}
                    />
                    {previews[out.name].total > previews[out.name].rows.length && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        First {previews[out.name].rows.length} of{" "}
                        {previews[out.name].total.toLocaleString()} rows — import it as a dataset
                        to see them all.
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Path separators in an output's name — 0 for a file beside the results. */
function depthOf(name: string): number {
  return (name.match(/[/\\]/g) ?? []).length;
}

/**
 * One preview row, typed enough for ResultsTable to format it.
 *
 * parseCsv hands back raw strings, and ResultsTable only rounds actual numbers,
 * so a float column would otherwise show all 17 digits of 149.49666666666667.
 * Converting here makes the preview read the way the same table reads after
 * Import as dataset — which is the round trip the preview exists to save.
 */
function previewRow(raw: Record<string, string>, columns: ColumnSchema[]) {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    const v = raw[c.original_name ?? c.name] ?? "";
    const numeric = c.type === "integer" || c.type === "double precision";
    out[c.name] = numeric && v !== "" ? Number(v) : v;
  }
  return out;
}

// The ArrayBuffer parameter is what lets the result go straight into a File:
// a plain Uint8Array could in principle be backed by a SharedArrayBuffer, and
// this one never is.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The gate between the model and the runner. The whole point is that someone
 * reads this before the code is theirs, so unchanged stretches are collapsed to
 * keep the changed lines visible rather than buried in a 300-line file.
 */
function ProposedChange({
  current,
  proposal,
  onAccept,
  onDiscard,
}: {
  current: string;
  proposal: { code: string; notes: string };
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const parts = useMemo(() => diffLines(current, proposal.code), [current, proposal.code]);

  return (
    <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <Sparkles className="h-3.5 w-3.5" /> Proposed changes
        </span>
        <span className="text-[11px] text-muted-foreground">
          Nothing runs until you accept this.
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={onDiscard}>
            Discard
          </Button>
          <Button size="sm" onClick={onAccept}>
            Accept
          </Button>
        </div>
      </div>

      <div className="max-h-[320px] overflow-auto rounded-md border border-border/70 bg-background font-mono text-[11px]">
        {parts.map((part, i) => {
          const lines = part.value.replace(/\n$/, "").split("\n");
          // Long runs of untouched code are context, not the review. Three
          // lines each side is enough to place a change in the file.
          const trimmed =
            !part.added && !part.removed && lines.length > 8
              ? [...lines.slice(0, 3), `… ${lines.length - 6} unchanged lines …`, ...lines.slice(-3)]
              : lines;
          return trimmed.map((line, j) => (
            <div
              key={`${i}-${j}`}
              className={cn(
                "px-2 whitespace-pre-wrap",
                part.added && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
                part.removed && "bg-destructive/10 text-destructive",
                !part.added && !part.removed && "text-muted-foreground",
              )}
            >
              {part.added ? "+ " : part.removed ? "- " : "  "}
              {line}
            </div>
          ));
        })}
      </div>

      {proposal.notes && (
        <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">{proposal.notes}</p>
      )}
    </div>
  );
}
