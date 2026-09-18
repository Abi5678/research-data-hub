import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MappedDatasetUploadDialog } from "@/components/project/mapped-upload";
import { ErdDiagram } from "@/components/project/erd-diagram";
import {
  getTemplate,
  stepLabels,
  type TemplateMeta,
  type TemplateTable,
  type ProjectTemplate,
} from "@/lib/templates";
import type { ColumnSchema } from "@/lib/csv";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  Upload,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/projects/$projectId/setup")({
  head: () => ({
    meta: [
      { title: "Set up template — Fieldbook" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SetupWizardPage,
});

type ProjectRow = {
  id: string;
  project_code: string;
  project_name: string;
  template_key: string | null;
  template_meta: TemplateMeta | null;
};

type DatasetRow = {
  id: string;
  display_name: string;
  table_name: string;
  row_count: number | null;
  column_schema: ColumnSchema[];
};

/**
 * Wizard steps 1-3 upload the template's step 1, 2 and 3+4 tables; wizard step 4
 * maps foreign keys. Labels come from the template so the wizard reads correctly
 * for any discipline, not just pavement research.
 */
function wizardSteps(template: ProjectTemplate) {
  const [one, two, three] = stepLabels(template);
  return [
    { n: 1 as const, label: one },
    { n: 2 as const, label: two },
    { n: 3 as const, label: three },
    { n: 4 as const, label: "Foreign keys" },
  ];
}

function SetupWizardPage() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async (): Promise<ProjectRow> => {
      const data = await api.getProject(projectId);
      if (!data) throw new Error("Project not found");
      return data as unknown as ProjectRow;
    },
  });

  const { data: datasets } = useQuery({
    queryKey: ["datasets", projectId],
    queryFn: async (): Promise<DatasetRow[]> => {
      return api.listDatasets(projectId, "asc");
    },
  });

  const template = useMemo(() => getTemplate(project?.template_key), [project]);
  const meta = (project?.template_meta ?? {}) as TemplateMeta;
  const bindings = meta.bindings ?? {};

  const saveMeta = useMutation({
    mutationFn: async (next: TemplateMeta) => {
      await api.updateProjectTemplateMeta(projectId, next);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  if (isLoading || !project) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10">
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    );
  }

  if (!template) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <p className="text-sm text-muted-foreground">
          This project was not created from a template.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/projects/$projectId" params={{ projectId }}>
            Go to project
          </Link>
        </Button>
      </div>
    );
  }

  const bindTable = async (tableKey: string, datasetId: string) => {
    const nextBindings = { ...bindings, [tableKey]: datasetId };
    // seed default FK mapping from template
    const nextFkMap = { ...(meta.fk_mappings ?? {}) };
    const tt = template.tables.find((t) => t.key === tableKey);
    if (tt?.fks) {
      nextFkMap[tableKey] = nextFkMap[tableKey] ?? {};
      for (const fk of tt.fks) {
        nextFkMap[tableKey]![fk.column] = nextFkMap[tableKey]![fk.column] ?? fk.references.column;
      }
    }
    await saveMeta.mutateAsync({ bindings: nextBindings, fk_mappings: nextFkMap });
  };

  // Driven by the template's own step numbers — never by hardcoded table keys,
  // so a template with no "test_sections"/"specimens" table still works.
  const step1Tables = template.tables.filter((t) => t.step === 1);
  const step2Tables = template.tables.filter((t) => t.step === 2);
  const resultsTables = template.tables.filter((t) => t.step === 3 || t.step === 4);
  const STEPS = wizardSteps(template);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-10">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to project
      </Link>

      <header className="mb-8 rounded-2xl border border-border/70 bg-card p-6 shadow-card">
        <div className="text-[10px] font-bold uppercase tracking-wider text-primary">
          {project.project_code} · {template.name}
        </div>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
          Guided template setup
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Upload your CSVs in order. Column names and types are auto-mapped to the
          template schema; you can still adjust each one before importing.
        </p>

        <ol className="mt-6 grid gap-2 sm:grid-cols-4">
          {STEPS.map((s) => {
            const active = step === s.n;
            const done = s.n < step;
            return (
              <li
                key={s.n}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
                  active
                    ? "border-primary/50 bg-gradient-primary-soft"
                    : done
                      ? "border-primary/30 bg-secondary/60"
                      : "border-border/70 bg-secondary/30"
                }`}
              >
                {done ? (
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-semibold text-foreground">{s.n}.</span>
                <span className="truncate">{s.label}</span>
              </li>
            );
          })}
        </ol>
      </header>

      {step === 1 && (
        <UploadStep
          projectId={projectId}
          stepNumber={1}
          title={STEPS[0].label}
          template={template}
          bindings={bindings}
          datasets={datasets ?? []}
          tables={step1Tables}
          onUploaded={bindTable}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <UploadStep
          projectId={projectId}
          stepNumber={2}
          title={STEPS[1].label}
          template={template}
          bindings={bindings}
          datasets={datasets ?? []}
          tables={step2Tables}
          onUploaded={bindTable}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <UploadStep
          projectId={projectId}
          stepNumber={3}
          title={STEPS[2].label}
          template={template}
          bindings={bindings}
          datasets={datasets ?? []}
          tables={resultsTables}
          onUploaded={bindTable}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      )}

      {step === 4 && (
        <StepForeignKeys
          projectId={projectId}
          template={template}
          datasets={datasets ?? []}
          meta={meta}
          onSave={async (next) => {
            await saveMeta.mutateAsync(next);
          }}
          onBack={() => setStep(3)}
          onFinish={() => navigate({ to: "/projects/$projectId", params: { projectId } })}
        />
      )}

      <div className="mt-10">
        <ErdDiagram template={template} bindings={bindings} />
      </div>
    </div>
  );
}

/**
 * One wizard step covering however many template tables sit at that step:
 * the single-table layout when there is exactly one, the grid otherwise.
 */
function UploadStep({
  projectId,
  stepNumber,
  title,
  template,
  bindings,
  datasets,
  tables,
  onUploaded,
  onBack,
  onNext,
}: {
  projectId: string;
  stepNumber: number;
  title: string;
  template: ProjectTemplate;
  bindings: Record<string, string>;
  datasets: DatasetRow[];
  tables: TemplateTable[];
  onUploaded: (tableKey: string, datasetId: string) => Promise<void>;
  onBack?: () => void;
  onNext: () => void;
}) {
  if (tables.length === 1) {
    const table = tables[0];
    return (
      <StepUploadOne
        projectId={projectId}
        table={table}
        template={template}
        bindings={bindings}
        datasets={datasets}
        boundDatasetId={bindings[table.key]}
        onUploaded={(id) => onUploaded(table.key, id)}
        onBack={onBack}
        onNext={onNext}
      />
    );
  }
  return (
    <StepResults
      projectId={projectId}
      stepNumber={stepNumber}
      title={title}
      template={template}
      bindings={bindings}
      datasets={datasets}
      tables={tables}
      onUploaded={onUploaded}
      onBack={onBack}
      onNext={onNext}
    />
  );
}

function StepUploadOne({
  projectId,
  table,
  template,
  bindings,
  datasets,
  boundDatasetId,
  onUploaded,
  onBack,
  onNext,
}: {
  projectId: string;
  table: TemplateTable;
  template: ProjectTemplate;
  bindings: Record<string, string>;
  datasets: DatasetRow[];
  boundDatasetId?: string;
  onUploaded: (datasetId: string) => Promise<void> | void;
  onBack?: () => void;
  onNext: () => void;
}) {
  const done = Boolean(boundDatasetId);
  return (
    <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-foreground">
            Step {table.step}: Upload <span className="font-mono">{table.key}.csv</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{table.description}</p>
        </div>
        {done && (
          <Badge className="bg-primary text-white">
            <Check className="mr-1 h-3 w-3" /> Loaded
          </Badge>
        )}
      </div>

      <ExpectedSchema table={table} />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <MappedDatasetUploadDialog
          projectId={projectId}
          template={template}
          bindings={bindings}
          datasets={datasets}
          initialTableKey={table.key}
          onCreated={({ datasetId }) => void onUploaded(datasetId)}
          onReplaced={({ datasetId }) => void onUploaded(datasetId)}
          trigger={
            <Button className="gap-1.5 bg-gradient-primary text-white shadow-cta hover-lift-sm hover:opacity-95">
              <Upload className="h-3.5 w-3.5" />
              {done ? "Upload more / replace" : `Upload ${table.key}.csv`}
            </Button>
          }
        />
        <div className="flex items-center gap-2">
          {onBack && (
            <Button variant="ghost" onClick={onBack} className="gap-1">
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Button>
          )}
          <Button onClick={onNext} disabled={!done} className="gap-1">
            Next <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function StepResults({
  projectId,
  stepNumber,
  title,
  template,
  datasets,
  tables,
  bindings,
  onUploaded,
  onBack,
  onNext,
}: {
  projectId: string;
  stepNumber: number;
  title: string;
  template: ProjectTemplate;
  datasets: DatasetRow[];
  tables: TemplateTable[];
  bindings: Record<string, string>;
  onUploaded: (tableKey: string, datasetId: string) => Promise<void>;
  onBack?: () => void;
  onNext: () => void;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8">
      <h2 className="text-lg font-bold text-foreground">
        Step {stepNumber}: Upload {title} CSVs
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick the target template table for each CSV. You can skip any you don't have —
        empty tables stay in the schema and can be filled in later.
      </p>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {tables.map((t) => {
          const done = Boolean(bindings[t.key]);
          return (
            <div
              key={t.key}
              className={`rounded-xl border p-4 ${
                done ? "border-primary/40 bg-gradient-primary-soft" : "border-border/70 bg-card"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-foreground">
                    {t.display_name}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {t.key}
                  </div>
                </div>
                {done && (
                  <Badge className="bg-primary text-white">
                    <Check className="mr-1 h-3 w-3" /> Loaded
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{t.description}</p>
              <div className="mt-3">
                <MappedDatasetUploadDialog
                  projectId={projectId}
                  template={template}
                  bindings={bindings}
                  datasets={datasets}
                  initialTableKey={t.key}
                  onCreated={({ datasetId }) => void onUploaded(t.key, datasetId)}
                  onReplaced={({ datasetId }) => void onUploaded(t.key, datasetId)}
                  trigger={
                    <Button variant="outline" size="sm" className="gap-1.5">
                      <Upload className="h-3 w-3" />
                      {done ? `Upload more / replace` : `Upload ${t.key}.csv`}
                    </Button>
                  }
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex items-center justify-between">
        {onBack ? (
          <Button variant="ghost" onClick={onBack} className="gap-1">
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={onNext} className="gap-1">
          Next <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </section>
  );
}

function StepForeignKeys({
  template,
  datasets,
  meta,
  onSave,
  onBack,
  onFinish,
}: {
  projectId: string;
  template: ReturnType<typeof getTemplate> & {};
  datasets: DatasetRow[];
  meta: TemplateMeta;
  onSave: (next: TemplateMeta) => Promise<void>;
  onBack: () => void;
  onFinish: () => void;
}) {
  const bindings = meta.bindings ?? {};
  const [fkMap, setFkMap] = useState<Record<string, Record<string, string>>>(
    meta.fk_mappings ?? {},
  );

  const boundTables = template.tables.filter(
    (t) => bindings[t.key] && (t.fks?.length ?? 0) > 0,
  );

  const columnsFor = (tableKey: string): string[] => {
    const dsId = bindings[tableKey];
    if (!dsId) return [];
    const ds = datasets.find((d) => d.id === dsId);
    return ds?.column_schema.map((c) => c.name) ?? [];
  };

  const save = async () => {
    await onSave({ bindings, fk_mappings: fkMap });
    toast.success("Relationships saved");
    onFinish();
  };

  return (
    <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8">
      <h2 className="text-lg font-bold text-foreground">Step 4: Confirm foreign keys</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Match each foreign-key column in your uploaded CSVs to the primary-key column of
        the parent table. Defaults follow the template schema.
      </p>

      {boundTables.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-border bg-secondary/40 p-6 text-center text-sm text-muted-foreground">
          No tables with foreign keys have been uploaded yet.
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          {boundTables.map((t) => {
            const childCols = columnsFor(t.key);
            return (
              <div
                key={t.key}
                className="rounded-xl border border-border/70 bg-secondary/40 p-4"
              >
                <div className="text-sm font-bold text-foreground">{t.display_name}</div>
                <div className="mt-3 space-y-2">
                  {t.fks!.map((fk) => {
                    const parentCols = columnsFor(fk.references.table);
                    const childValue = fkMap[t.key]?.[fk.column] ?? fk.column;
                    const parentValue =
                      fkMap[t.key]?.[`__parent_${fk.column}`] ?? fk.references.column;
                    return (
                      <div
                        key={fk.column}
                        className="grid items-center gap-2 rounded-lg bg-white p-3 text-xs sm:grid-cols-[1fr_auto_1fr]"
                      >
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {t.key}.column
                          </div>
                          <Select
                            value={childValue}
                            onValueChange={(v) =>
                              setFkMap((m) => ({
                                ...m,
                                [t.key]: { ...(m[t.key] ?? {}), [fk.column]: v },
                              }))
                            }
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(childCols.length ? childCols : [fk.column]).map((c) => (
                                <SelectItem key={c} value={c}>
                                  {c}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <ArrowRight className="mx-auto hidden h-4 w-4 text-muted-foreground sm:block" />
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {fk.references.table}.column
                          </div>
                          <Select
                            value={parentValue}
                            onValueChange={(v) =>
                              setFkMap((m) => ({
                                ...m,
                                [t.key]: {
                                  ...(m[t.key] ?? {}),
                                  [`__parent_${fk.column}`]: v,
                                },
                              }))
                            }
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(parentCols.length ? parentCols : [fk.references.column]).map(
                                (c) => (
                                  <SelectItem key={c} value={c}>
                                    {c}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} className="gap-1">
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </Button>
        <Button
          onClick={save}
          className="gap-1 bg-gradient-primary text-white shadow-cta hover-lift-sm hover:opacity-95"
        >
          Finish setup <Check className="h-3.5 w-3.5" />
        </Button>
      </div>
    </section>
  );
}

function ExpectedSchema({ table }: { table: TemplateTable }) {
  return (
    <div className="mt-4 rounded-xl border border-border/70 bg-secondary/40 p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        Expected columns
      </div>
      <div className="flex flex-wrap gap-1.5">
        {table.columns.map((c) => (
          <span
            key={c.name}
            className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-white px-1.5 py-0.5 font-mono text-[10px] text-foreground"
          >
            {c.name}
            <span className="text-[9px] font-bold uppercase text-primary">
              {c.type.replace("double precision", "real")}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
