import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isServerMode } from "@/lib/mode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2,
  Database,
  HardDriveDownload,
  HardDriveUpload,
  KeyRound,
  Loader2,
  Sparkles,
  Terminal,
} from "lucide-react";

const DEFAULT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-instruct";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [llmBase, setLlmBase] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [cloudAllowed, setCloudAllowed] = useState(false);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const [key, m, base, cloud] = await Promise.all([
        api.getSetting("nvidia_api_key"),
        api.getSetting("nvidia_model"),
        api.getSetting("llm_base_url"),
        api.cloudNimAllowed().catch(() => false),
      ]);
      return {
        key: key ?? "",
        // Only prefill the cloud model when cloud is the endpoint. Offering it
        // to someone pointing at a local server just gets that name posted to
        // Ollama, which answers 404.
        model: m ?? (cloud && !(base ?? "").trim() ? DEFAULT_MODEL : ""),
        llmBase: base ?? "",
        cloud,
      };
    },
  });

  useEffect(() => {
    if (settings.data) {
      const k = settings.data.key;
      setApiKey(k && !k.startsWith("•") ? k : "");
      setModel(settings.data.model);
      setLlmBase(settings.data.llmBase);
      setCloudAllowed(settings.data.cloud);
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: async () => {
      await api.setSetting("nvidia_api_key", apiKey.trim());
      await api.setSetting("nvidia_model", model.trim());
      await api.setSetting("llm_base_url", llmBase.trim());
    },
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  const test = useMutation({
    mutationFn: async () => {
      await api.setSetting("nvidia_api_key", apiKey.trim());
      await api.setSetting("nvidia_model", model.trim());
      await api.setSetting("llm_base_url", llmBase.trim());
      return api.testLlmConnection();
    },
    onSuccess: (r) => {
      setTestResult(`Connected (${r.mode || "llm"}) — ${r.model} replied: "${r.reply}"`);
      toast.success("LLM connection works");
    },
    onError: (err) => {
      setTestResult(null);
      toast.error(err instanceof Error ? err.message : "Connection failed");
    },
  });

  const backup = useMutation({
    mutationFn: () => api.backupDatabase(),
    onSuccess: (path) => {
      if (path) toast.success(`Backup saved: ${path}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Backup failed"),
  });

  const restore = useMutation({
    mutationFn: () => api.restoreDatabase(),
    onSuccess: (res) => {
      if (res) {
        toast.success("Database restored — reload the app window", {
          description: res.previous ? `Replaced database kept at ${res.previous}` : undefined,
        });
        qc.invalidateQueries();
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Restore failed"),
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
      <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Settings</h1>
      <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
        Folder import works without AI. Optional local/on-prem LLM can improve schemas. Cloud
        NVIDIA NIM is {cloudAllowed ? "enabled" : "disabled"} for this build (NHDOT default: off).
      </p>

      {!isServerMode && (
        <div className="mt-8 space-y-4 rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8">
          <div className="flex items-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-secondary">
              <Database className="h-4 w-4 text-foreground" />
            </div>
            <div>
              <div className="text-sm font-bold text-foreground">Local database backup</div>
              <div className="text-[11px] text-muted-foreground">
                Export or restore the SQLite file used by this desktop app.
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => backup.mutate()}
              disabled={backup.isPending}
            >
              <HardDriveDownload className="h-3.5 w-3.5" />
              {backup.isPending ? "Backing up…" : "Backup database…"}
            </Button>
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => restore.mutate()}
              disabled={restore.isPending}
            >
              <HardDriveUpload className="h-3.5 w-3.5" />
              {restore.isPending ? "Restoring…" : "Restore from backup…"}
            </Button>
          </div>
        </div>
      )}

      {!isServerMode && <RuntimesCard />}

      <div className="mt-8 space-y-6 rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-primary shadow-glow">
            <Sparkles className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <div className="text-sm font-bold text-foreground">Optional AI schema assist</div>
            <div className="text-[11px] text-muted-foreground">
              Prefer a local OpenAI-compatible endpoint (LLM_BASE_URL). Cloud NIM requires
              ALLOW_CLOUD_NIM=1 and is not used for NHDOT production.
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="llm-base" className="text-xs font-semibold">
            Local LLM base URL
          </Label>
          <Input
            id="llm-base"
            value={llmBase}
            onChange={(e) => setLlmBase(e.target.value)}
            placeholder="http://127.0.0.1:8000/v1"
            className="font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="nvidia-key" className="text-xs font-semibold">
            API key {cloudAllowed ? "(cloud or local)" : "(local endpoint auth, optional)"}
          </Label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="nvidia-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={cloudAllowed ? "nvapi-…" : "optional"}
              className="pl-8 font-mono"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="nvidia-model" className="text-xs font-semibold">
            Model {llmBase.trim() ? "(required for a local endpoint)" : ""}
          </Label>
          <Input
            id="nvidia-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={llmBase.trim() ? "the model your server serves" : DEFAULT_MODEL}
            className="font-mono"
          />
          {llmBase.trim() && (
            <p className="text-[11px] text-muted-foreground">
              Use a name your server actually serves — list them at{" "}
              <code className="rounded bg-secondary px-1 py-0.5">
                {llmBase.trim().replace(/\/$/, "")}/models
              </code>
              .
            </p>
          )}
        </div>

        {testResult && (
          <div className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> {testResult}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => test.mutate()}
            disabled={test.isPending || (!llmBase.trim() && !cloudAllowed)}
            className="gap-1.5"
          >
            {test.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Test connection
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which Python and MATLAB the Scripts tab runs.
 *
 * A picker rather than a detected default because PATH is not enough to decide:
 * this machine has six python3s and the first one on PATH has no pandas, so
 * guessing produces "ModuleNotFoundError: pandas" on a machine that has pandas.
 * Each candidate is shown with what it can actually import.
 */
function RuntimesCard() {
  const qc = useQueryClient();
  const detected = useQuery({ queryKey: ["runtimes"], queryFn: () => api.detectRuntimes() });
  const [matlabTest, setMatlabTest] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      await api.setSetting(key, value);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["runtimes"] });
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const testMatlab = useMutation({
    mutationFn: (binPath: string) => api.testMatlab(binPath),
    onSuccess: (res) => setMatlabTest(res.detail),
    onError: (err) => toast.error(err instanceof Error ? err.message : "MATLAB test failed"),
  });

  const python = detected.data?.python;
  const matlab = detected.data?.matlab;

  return (
    <div className="mt-8 space-y-6 rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8">
      <div className="flex items-center gap-2">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-secondary">
          <Terminal className="h-4 w-4 text-foreground" />
        </div>
        <div>
          <div className="text-sm font-bold text-foreground">Analysis runtimes</div>
          <div className="text-[11px] text-muted-foreground">
            Which Python and MATLAB the Scripts tab runs.
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-semibold">Python</Label>
        <Select
          value={python?.selected ?? ""}
          onValueChange={(v) => save.mutate({ key: "python_path", value: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder={detected.isLoading ? "Looking…" : "No Python found"} />
          </SelectTrigger>
          <SelectContent>
            {python?.candidates
              .filter((c) => c.ok)
              .map((c) => (
                <SelectItem key={c.path} value={c.path}>
                  {c.detail} — {c.path}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {python && python.candidates.filter((c) => c.ok).length === 0 && !detected.isLoading && (
          <p className="text-[11px] text-muted-foreground">
            No working Python found. Install one (python.org or Homebrew) and reopen Settings.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-semibold">MATLAB</Label>
        <div className="flex gap-2">
          <Select
            value={matlab?.selected ?? ""}
            onValueChange={(v) => save.mutate({ key: "matlab_path", value: v })}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder={detected.isLoading ? "Looking…" : "No MATLAB found"} />
            </SelectTrigger>
            <SelectContent>
              {matlab?.candidates.map((c) => (
                <SelectItem key={c.path} value={c.path}>
                  {c.detail} — {c.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={!matlab?.selected || testMatlab.isPending}
            onClick={() => matlab?.selected && testMatlab.mutate(matlab.selected)}
            className="gap-1.5"
          >
            {testMatlab.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Test
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {matlabTest ??
            "The release is read from the install path. Testing actually starts MATLAB, which takes 20–40 seconds."}
        </p>
      </div>
    </div>
  );
}
