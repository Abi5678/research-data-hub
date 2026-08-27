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
import { coerceRow, parseCsv, type ColumnSchema } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const [datasetId, setDatasetId] = useState<string>("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
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
  const dataset = runnableDatasets.find((d) => d.id === datasetId) ?? null;

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

  useEffect(() => {
    if (!datasetId && runnableDatasets.length) setDatasetId(runnableDatasets[0].id);
  }, [runnableDatasets, datasetId]);

  useEffect(() => {
    return api.onScriptRunEvent((event) => {
      if (event.kind === "done") {
        setActiveRunId(null);
        setPendingRun(false);
        if (event.error) {
          setLog((prev) => [...prev, { kind: "stderr", text: event.error! }]);
          toast.error(event.error);
        } else if (event.run) {
          setLastRun(event.run);
        }
        void queryClient.invalidateQueries({ queryKey: ["script-runs", selectedId] });
        return;
      }
      setLog((prev) => [...prev, { kind: event.kind, text: event.text }]);
    });
  }, [queryClient, selectedId]);

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
    if (!selected || !dataset) return;
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
        datasetIds: [dataset.id],
      });
      setActiveRunId(runId);
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
            <p className="rounded-lg border border-dashed border-border/70 p-4 text-xs text-muted-foreground">
              Add an existing Python or MATLAB script. The file is copied in — the original on
              disk is never changed.
            </p>
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
              <Label className="text-xs">Dataset</Label>
              <Select value={datasetId} onValueChange={setDatasetId}>
                <SelectTrigger className="mt-1 h-9">
                  <SelectValue placeholder="Choose a dataset" />
                </SelectTrigger>
                <SelectContent>
                  {runnableDatasets.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => void startRun()} disabled={running || !dataset || !interpreter}>
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
                The data is at{" "}
                <code className="rounded bg-secondary px-1 py-0.5 text-[10px]">data.csv</code>
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Written into the working directory before your script runs.
              </p>
              <p className="mt-3 text-xs font-medium">Columns</p>
              <ul className="mt-1 max-h-[280px] space-y-0.5 overflow-y-auto text-[11px]">
                {dataset?.column_schema.map((c) => (
                  <li key={c.name} className="flex items-baseline justify-between gap-2">
                    <code className="truncate">{c.name}</code>
                    <span className="shrink-0 text-muted-foreground">{c.type}</span>
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
 * What the script left behind. Figures are shown rather than named — the figure
 * is usually the whole reason the script was run — and a result CSV can be
 * imported straight back, so script output becomes queryable project data.
 */
function RunOutputs({ run, projectId }: { run: ScriptRun; projectId: string }) {
  const queryClient = useQueryClient();
  const [images, setImages] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImages({});
    for (const out of run.outputs) {
      if (out.kind !== "image") continue;
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
  }, [run]);

  async function importCsv(name: string) {
    setImporting(name);
    try {
      const file = await api.readRunFile(run.id, name);
      const parsed = parseCsv(new TextDecoder().decode(base64ToBytes(file.base64)));
      if (parsed.columns.length === 0 || parsed.rows.length === 0) {
        throw new Error("That file has no rows to import.");
      }
      const created = await api.createProjectDataset({
        projectId,
        displayName: name.replace(/\.csv$/i, ""),
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
      void queryClient.invalidateQueries({ queryKey: ["datasets", projectId] });
      toast.success(`Imported ${rows.length.toLocaleString()} rows as a dataset`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setImporting(null);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium">Files this run wrote</p>
      <ul className="space-y-2">
        {run.outputs.map((out) => (
          <li key={out.name} className="rounded-md border border-border/70 p-2">
            <div className="flex items-center gap-2 text-[11px]">
              <code className="truncate">{out.name}</code>
              <span className="text-muted-foreground">{formatSize(out.size)}</span>
              {out.kind === "csv" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 text-[11px]"
                  disabled={!!importing}
                  onClick={() => void importCsv(out.name)}
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
            {images[out.name] && (
              <img
                src={images[out.name]}
                alt={out.name}
                className="mt-2 max-h-[420px] w-auto rounded border border-border/70 bg-white"
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function base64ToBytes(b64: string): Uint8Array {
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
