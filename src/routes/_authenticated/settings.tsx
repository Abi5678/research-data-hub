import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isServerMode } from "@/lib/mode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, KeyRound, Loader2, Sparkles } from "lucide-react";

const DEFAULT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-instruct";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [testResult, setTestResult] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const [key, m] = await Promise.all([
        api.getSetting("nvidia_api_key"),
        api.getSetting("nvidia_model"),
      ]);
      return { key: key ?? "", model: m ?? DEFAULT_MODEL };
    },
  });

  useEffect(() => {
    if (settings.data) {
      const k = settings.data.key;
      setApiKey(k && !k.startsWith("•") ? k : "");
      setModel(settings.data.model);
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: async () => {
      await api.setSetting("nvidia_api_key", apiKey.trim());
      await api.setSetting("nvidia_model", model.trim() || DEFAULT_MODEL);
    },
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  const test = useMutation({
    mutationFn: async () => {
      // Save first so the main process reads the latest values.
      await api.setSetting("nvidia_api_key", apiKey.trim());
      await api.setSetting("nvidia_model", model.trim() || DEFAULT_MODEL);
      return api.testLlmConnection();
    },
    onSuccess: (r) => {
      setTestResult(`Connected — ${r.model} replied: "${r.reply}"`);
      toast.success("NVIDIA API connection works");
    },
    onError: (err) => {
      setTestResult(null);
      toast.error(err instanceof Error ? err.message : "Connection failed");
    },
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
      <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Settings</h1>
      <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {isServerMode
          ? "NVIDIA API key for AI features (admin only on the lab server). See NVIDIA_AI.md in the project for what data is sent to the cloud."
          : "Configure the AI used by Create project from folder. Your key is stored only in this app's local database on this Mac."}
      </p>

      <div className="mt-8 space-y-6 rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-primary shadow-glow">
            <Sparkles className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <div className="text-sm font-bold text-foreground">NVIDIA API (Nemotron)</div>
            <div className="text-[11px] text-muted-foreground">
              Get a free key at build.nvidia.com — folder analysis sends column
              headers and a few sample rows to this API.
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="nvidia-key" className="text-xs font-semibold">
            API key
          </Label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="nvidia-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="nvapi-…"
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
          <p className="text-[11px] text-muted-foreground">
            Any chat model id from build.nvidia.com works (Nemotron recommended).
          </p>
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
            disabled={test.isPending || !apiKey.trim()}
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
