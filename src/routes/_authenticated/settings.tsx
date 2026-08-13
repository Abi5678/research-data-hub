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
  CheckCircle2,
  Database,
  HardDriveDownload,
  HardDriveUpload,
  KeyRound,
  Loader2,
  Sparkles,
} from "lucide-react";

const DEFAULT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-instruct";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
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
        model: m ?? DEFAULT_MODEL,
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
      await api.setSetting("nvidia_model", model.trim() || DEFAULT_MODEL);
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
      await api.setSetting("nvidia_model", model.trim() || DEFAULT_MODEL);
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
    onSuccess: (path) => {
      if (path) {
        toast.success("Database restored — reload the app window");
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
            Model
          </Label>
          <Input
            id="nvidia-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={DEFAULT_MODEL}
            className="font-mono"
          />
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
