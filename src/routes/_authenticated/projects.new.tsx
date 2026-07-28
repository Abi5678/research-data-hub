import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, FolderOpen, Layers, Loader2, Sparkles } from "lucide-react";
import { TEMPLATES } from "@/lib/templates";

export const Route = createFileRoute("/_authenticated/projects/new")({
  head: () => ({
    meta: [
      { title: "New project — Research Data Hub" },
      {
        name: "description",
        content:
          "Create a new pavement research project with its own isolated database of CSV-backed datasets.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: NewProjectPage,
});

const schema = z.object({
  project_name: z.string().trim().min(2, "Project name is required").max(120),
  project_code: z
    .string()
    .trim()
    .min(2, "Project code is required")
    .max(40)
    .regex(/^[A-Za-z0-9\-_. ]+$/i, "Only letters, numbers, dashes, dots, spaces"),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
  sponsor: z.string().trim().max(120).optional().or(z.literal("")),
  pi_name: z.string().trim().max(120).optional().or(z.literal("")),
  start_date: z.string().optional().or(z.literal("")),
  end_date: z.string().optional().or(z.literal("")),
});

function NewProjectPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [form, setForm] = useState({
    project_name: "",
    project_code: "",
    description: "",
    sponsor: "",
    pi_name: "",
    start_date: "",
    end_date: "",
  });

  const create = useMutation({
    mutationFn: async (payload: typeof form) => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
      return api.createProject({
        project_name: parsed.data.project_name,
        project_code: parsed.data.project_code,
        description: parsed.data.description || null,
        sponsor: parsed.data.sponsor || null,
        pi_name: parsed.data.pi_name || null,
        start_date: parsed.data.start_date || null,
        end_date: parsed.data.end_date || null,
        template_key: templateKey,
      });
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project created");
      if (templateKey) {
        navigate({ to: "/projects/$projectId/setup", params: { projectId: id } });
      } else {
        navigate({ to: "/projects/$projectId", params: { projectId: id } });
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
      <Link
        to="/dashboard"
        className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to projects
      </Link>
      <h1 className="text-3xl font-extrabold tracking-tight text-foreground">
        New research project
      </h1>
      <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
        Start with a folder of research files, or create an empty project and add files later.
      </p>

      <div className="mt-6 flex flex-col items-start justify-between gap-4 rounded-2xl border border-primary/25 bg-gradient-primary-soft p-5 shadow-card sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
            <FolderOpen className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-foreground">Have a folder of data?</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Choose a folder containing CSV and Excel files. We’ll review the files and create the
              project and tables together.
            </p>
          </div>
        </div>
        <Button asChild variant="outline" className="shrink-0 gap-1.5 bg-background">
          <Link to="/import-folder">
            <FolderOpen className="h-4 w-4" /> Create from folder
          </Link>
        </Button>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setTemplateKey(null)}
          className={`rounded-2xl border p-4 text-left transition-all ${
            templateKey === null
              ? "border-primary/60 bg-gradient-primary-soft shadow-cta"
              : "border-border/70 bg-card hover:border-primary/40"
          }`}
        >
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-primary">
            <Layers className="h-3.5 w-3.5" /> Blank project
          </div>
          <div className="mt-1 text-sm font-bold text-foreground">Start empty</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Add CSV datasets manually and define your own schema.
          </p>
        </button>
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTemplateKey(t.key)}
            className={`rounded-2xl border p-4 text-left transition-all ${
              templateKey === t.key
                ? "border-primary/60 bg-gradient-primary-soft shadow-cta"
                : "border-border/70 bg-card hover:border-primary/40"
            }`}
          >
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-primary">
              <Sparkles className="h-3.5 w-3.5" /> Template · {t.tables.length} tables
            </div>
            <div className="mt-1 text-sm font-bold text-foreground">{t.name}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(form);
        }}
        className="mt-8 space-y-6 rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8"
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Project name *" htmlFor="project_name">
            <Input
              id="project_name"
              value={form.project_name}
              onChange={(e) => setForm({ ...form, project_name: e.target.value })}
              placeholder="e.g. Field Mix Evaluation Phase II"
              required
              maxLength={120}
            />
          </Field>
          <Field label="Project code *" htmlFor="project_code">
            <Input
              id="project_code"
              value={form.project_code}
              onChange={(e) => setForm({ ...form, project_code: e.target.value })}
              placeholder="NRRA-RA-P2"
              required
              maxLength={40}
            />
          </Field>
          <Field label="Principal investigator" htmlFor="pi_name">
            <Input
              id="pi_name"
              value={form.pi_name}
              onChange={(e) => setForm({ ...form, pi_name: e.target.value })}
              placeholder="Dr. Jane Doe"
              maxLength={120}
            />
          </Field>
          <Field label="Sponsor" htmlFor="sponsor">
            <Input
              id="sponsor"
              value={form.sponsor}
              onChange={(e) => setForm({ ...form, sponsor: e.target.value })}
              placeholder="MnDOT / FHWA"
              maxLength={120}
            />
          </Field>
          <Field label="Start date" htmlFor="start_date">
            <Input
              id="start_date"
              type="date"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
            />
          </Field>
          <Field label="End date" htmlFor="end_date">
            <Input
              id="end_date"
              type="date"
              value={form.end_date}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Description" htmlFor="description">
          <Textarea
            id="description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Short summary of scope, sites, or research questions."
            rows={4}
            maxLength={1000}
          />
        </Field>

        <div className="flex items-center justify-end gap-3 pt-2">
          <Button asChild variant="ghost">
            <Link to="/dashboard">Cancel</Link>
          </Button>
          <Button
            type="submit"
            disabled={create.isPending}
            className="bg-gradient-primary text-white shadow-cta hover-lift-sm hover:opacity-95"
          >
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {templateKey ? "Create & set up template" : "Create project"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-semibold text-slate-700">
        {label}
      </Label>
      {children}
    </div>
  );
}
