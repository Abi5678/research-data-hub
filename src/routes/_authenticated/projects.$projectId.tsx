import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { ColumnSchema } from "@/lib/csv";
import { isServerMode } from "@/lib/mode";
import type { CombineRecipe } from "@/lib/api";
import { DatasetUploadDialog } from "@/components/project/dataset-upload";
import { AttachedSources } from "@/components/project/attached-sources";
import { CombineBuilderDialog } from "@/components/project/combine-builder";
import { QueryTab } from "@/components/project/query-tab";
import { BrowseTab } from "@/components/project/browse-tab";
import { AnalyzeTab } from "@/components/project/analyze-tab";
import { ChatTab } from "@/components/project/chat-tab";
import { ScriptsTab } from "@/components/project/scripts-tab";
import { ResultsTable } from "@/components/project/results-table";
import { exportRows } from "@/lib/export";
import { ErdDiagram } from "@/components/project/erd-diagram";
import { getTemplate, type TemplateMeta } from "@/lib/templates";
import { resolveExampleQueries } from "@/lib/example-sql";
import { DataDictionary } from "@/components/project/data-dictionary";
import { GlobalSearch } from "@/components/project/global-search";
import { ProjectSharing } from "@/components/project/project-sharing";
import {
  ArrowLeft,
  Calendar,
  Database,
  Download,
  History,
  Layers,
  ListTree,
  Search,
  Snowflake,
  Clock,
  UploadCloud,
  Sparkles,
  Trash2,
  User2,
  FolderOpen,
  Table2,
  LineChart,
  MessageSquare,
  Terminal,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  head: () => ({
    meta: [{ title: "Project — Research Data Hub" }, { name: "robots", content: "noindex" }],
  }),
  component: ProjectDetailPage,
});

type Project = {
  id: string;
  project_name: string;
  project_code: string;
  description: string | null;
  sponsor: string | null;
  pi_name: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  template_key: string | null;
  template_meta: TemplateMeta | null;
};

type DatasetRow = {
  id: string;
  display_name: string;
  source_filename: string | null;
  table_name: string;
  /** Null on a combined dataset: its rows are counted on demand, never stored. */
  row_count: number | null;
  created_at: string;
  column_schema: ColumnSchema[];
  read_only?: 0 | 1;
  unavailable_reason?: string | null;
  /** Non-null only on a combined dataset — the recipe its view is built from. */
  recipe?: CombineRecipe | null;
};

function ProjectDetailPage() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<string>("overview");

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async (): Promise<Project> => {
      const data = await api.getProject(projectId);
      if (!data) throw new Error("Project not found");
      return data as unknown as Project;
    },
  });

  const { data: datasets } = useQuery({
    queryKey: ["datasets", projectId],
    queryFn: async (): Promise<DatasetRow[]> => {
      return api.listDatasets(projectId, "desc");
    },
  });

  const deleteProject = useMutation({
    mutationFn: async () => {
      await api.deleteProject(projectId);
    },
    onSuccess: () => {
      toast.success("Project deleted");
      qc.invalidateQueries({ queryKey: ["projects"] });
      navigate({ to: "/dashboard" });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  if (isLoading || !project) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <Link
        to="/dashboard"
        className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All projects
      </Link>

      <header className="relative overflow-hidden rounded-2xl border border-border/70 bg-card p-6 shadow-card sm:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-gradient-primary opacity-15 blur-3xl"
        />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-primary">
              {project.project_code}
            </div>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
              {project.project_name}
            </h1>
            {project.description && (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {project.description}
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              {project.pi_name && (
                <span className="inline-flex items-center gap-1">
                  <User2 className="h-3 w-3" /> {project.pi_name}
                </span>
              )}
              {project.sponsor && (
                <Badge variant="secondary" className="font-semibold">
                  {project.sponsor}
                </Badge>
              )}
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" /> Created{" "}
                {new Date(project.created_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <Badge variant="secondary" className="gap-1 font-semibold">
                <Database className="h-3 w-3" /> {datasets?.length ?? 0} dataset
                {datasets?.length === 1 ? "" : "s"}
              </Badge>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button asChild size="sm" className="gap-1.5">
              <Link to="/import-folder" search={{ projectId }}>
                <FolderOpen className="h-3.5 w-3.5" /> Import folder
              </Link>
            </Button>
            <DatasetUploadDialog
              projectId={projectId}
              trigger={
                <Button variant="outline" size="sm" className="gap-1.5">
                  <UploadCloud className="h-3.5 w-3.5" /> Upload CSV
                </Button>
              }
            />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    All datasets, rows, saved queries, and export history for this project will be
                    permanently removed. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => deleteProject.mutate()}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-8">
        <TabsList className="h-auto min-h-9 flex-wrap justify-start">
          <TabsTrigger value="overview" className="gap-1.5">
            <Sparkles className="h-3.5 w-3.5" /> Overview
          </TabsTrigger>
          <TabsTrigger value="ask" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" /> Ask
          </TabsTrigger>
          <TabsTrigger value="datasets" className="gap-1.5">
            <Database className="h-3.5 w-3.5" /> Datasets
          </TabsTrigger>
          <TabsTrigger value="browse" className="gap-1.5">
            <Table2 className="h-3.5 w-3.5" /> Browse
          </TabsTrigger>
          <TabsTrigger value="analyze" className="gap-1.5">
            <LineChart className="h-3.5 w-3.5" /> Analyze
          </TabsTrigger>
          <TabsTrigger value="query" className="gap-1.5">
            <ListTree className="h-3.5 w-3.5" /> Query
          </TabsTrigger>
          <TabsTrigger value="search" className="gap-1.5">
            <Search className="h-3.5 w-3.5" /> Search
          </TabsTrigger>
          {!isServerMode && (
            <TabsTrigger value="scripts" className="gap-1.5">
              <Terminal className="h-3.5 w-3.5" /> Scripts
            </TabsTrigger>
          )}
          <TabsTrigger value="exports" className="gap-1.5">
            <History className="h-3.5 w-3.5" /> Export history
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab
            projectId={projectId}
            project={project}
            datasets={datasets ?? []}
            onGoToTab={setActiveTab}
          />
        </TabsContent>
        <TabsContent value="ask" className="mt-6">
          <ChatTab projectId={projectId} datasets={datasets ?? []} />
        </TabsContent>
        <TabsContent value="datasets" className="mt-6">
          <DatasetsTab
            projectId={projectId}
            projectCode={project.project_code}
            datasets={datasets ?? []}
          />
        </TabsContent>
        <TabsContent value="browse" className="mt-6">
          <BrowseTab
            projectId={projectId}
            projectCode={project.project_code}
            datasets={datasets ?? []}
          />
        </TabsContent>
        <TabsContent value="analyze" className="mt-6">
          <AnalyzeTab
            projectId={projectId}
            projectCode={project.project_code}
            datasets={datasets ?? []}
          />
        </TabsContent>
        <TabsContent value="query" className="mt-6">
          <QueryTab
            projectId={projectId}
            projectCode={project.project_code}
            datasets={datasets ?? []}
            examples={resolveExampleQueries(
              getTemplate(project.template_key)?.example_queries,
              project.template_meta as TemplateMeta,
              datasets ?? [],
            )}
          />
        </TabsContent>
        <TabsContent value="search" className="mt-6">
          <GlobalSearch projectId={projectId} datasets={datasets ?? []} />
        </TabsContent>
        <TabsContent value="scripts" className="mt-6">
          <ScriptsTab projectId={projectId} datasets={datasets ?? []} />
        </TabsContent>
        <TabsContent value="exports" className="mt-6">
          <ExportsTab projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OverviewTab({
  projectId,
  project,
  datasets,
  onGoToTab,
}: {
  projectId: string;
  project: Project;
  datasets: DatasetRow[];
  onGoToTab: (tab: string) => void;
}) {
  // Combined datasets are excluded: their rows already live in the sources
  // below them, so counting both would report the same rows twice.
  const totalRows = datasets.reduce((s, d) => s + (d.recipe ? 0 : (d.row_count ?? 0)), 0);
  const meta = (project.template_meta ?? {}) as TemplateMeta;
  // AI folder imports store their generated schema in template_meta.
  const template = meta.ai_template ?? getTemplate(project.template_key);
  const lastUpload = datasets.reduce<Date | null>((acc, d) => {
    const t = new Date(d.created_at);
    return !acc || t > acc ? t : acc;
  }, null);
  const stats = [
    { label: "Datasets", value: datasets.length.toLocaleString(), icon: Database },
    { label: "Total rows", value: totalRows.toLocaleString(), icon: Layers },
    {
      label: "Columns tracked",
      value: datasets.reduce((s, d) => s + d.column_schema.length, 0).toLocaleString(),
      icon: ListTree,
    },
    {
      label: "Last upload",
      value: lastUpload
        ? lastUpload.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "—",
      icon: Clock,
    },
  ];
  return (
    <div className="space-y-6">
      {template && (
        <div className="rounded-2xl border border-primary/30 bg-gradient-primary-soft p-5 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-primary">
                Template · {template.name}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {Object.keys(meta.bindings ?? {}).length} of {template.tables.length} template
                tables loaded.
              </p>
            </div>
            {/* Guided setup only exists for hardcoded templates, not AI imports */}
            {!meta.ai_template && (
              <Button asChild size="sm" variant="outline">
                <Link to="/projects/$projectId/setup" params={{ projectId: project.id }}>
                  <Sparkles className="h-3.5 w-3.5" /> Guided setup
                </Link>
              </Button>
            )}
          </div>
        </div>
      )}
      <ProjectSharing projectId={projectId} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map((s) => (
              <div
                key={s.label}
                className="rounded-xl border border-border/70 bg-card p-4 shadow-card"
              >
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <s.icon className="h-3.5 w-3.5 text-primary" /> {s.label}
                </div>
                <div className="mt-2 text-2xl font-extrabold tracking-tight text-foreground">
                  {s.value}
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-card">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-foreground">Quick access</h3>
              <span className="text-[11px] text-muted-foreground">Open a table in Browse</span>
            </div>
            {datasets.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-border bg-secondary/40 p-6 text-center">
                <UploadCloud className="mx-auto h-6 w-6 text-muted-foreground" />
                <p className="mt-2 text-xs text-muted-foreground">
                  No tables yet. Upload a CSV in the Datasets tab to populate this project's
                  database.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => onGoToTab("datasets")}
                >
                  Go to Datasets
                </Button>
              </div>
            ) : (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {datasets.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onGoToTab("browse")}
                    className="group flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-secondary/40 px-3 py-2 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-foreground">
                        {d.display_name}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {d.row_count === null ? "combined" : `${d.row_count.toLocaleString()} rows`}{" "}
                        · {d.column_schema.length} cols
                      </div>
                    </div>
                    <ArrowLeft className="h-3.5 w-3.5 rotate-180 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-card">
            <h3 className="text-sm font-bold text-foreground">Recent datasets</h3>
            {datasets.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                No datasets yet. Head to the Datasets tab to upload your first CSV.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border/60">
                {datasets.slice(0, 5).map((d) => (
                  <li key={d.id} className="flex items-center justify-between py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {d.display_name}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {d.column_schema.length} columns •{" "}
                        {d.row_count === null ? "combined" : `${d.row_count.toLocaleString()} rows`}
                      </div>
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {new Date(d.created_at).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="rounded-2xl border border-border/70 bg-gradient-primary-soft p-6 shadow-card">
          <h3 className="text-sm font-bold text-foreground">Project details</h3>
          <dl className="mt-4 space-y-3 text-xs">
            <Detail label="Code" value={project.project_code} />
            <Detail label="PI" value={project.pi_name ?? "—"} />
            <Detail label="Sponsor" value={project.sponsor ?? "—"} />
            <Detail
              label="Start"
              value={project.start_date ? new Date(project.start_date).toLocaleDateString() : "—"}
            />
            <Detail
              label="End"
              value={project.end_date ? new Date(project.end_date).toLocaleDateString() : "—"}
            />
          </dl>
        </div>
      </div>
      {template && <ErdDiagram template={template} bindings={meta.bindings} />}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate text-right font-semibold text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The size of a combined dataset, counted only when asked for.
 *
 * A combined dataset is a live view, so counting it re-runs every join
 * underneath. That is affordable once, on a click; it is not affordable on
 * every render of a list that may hold a dozen of them.
 */
function CombinedRowCount({ datasetId }: { datasetId: string }) {
  const [asked, setAsked] = useState(false);
  const count = useQuery({
    queryKey: ["dataset-row-count", datasetId],
    queryFn: () => api.datasetRowCount(datasetId),
    enabled: asked,
    retry: false,
  });

  if (!asked) {
    return (
      <button
        type="button"
        onClick={() => setAsked(true)}
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        rows read live from its sources — count them
      </button>
    );
  }
  if (count.isPending) return <span>counting rows…</span>;
  // An unreadable or errored view says what it is rather than showing a zero.
  if (count.isError || count.data === null || count.data === undefined) {
    return <span>rows read live from its sources</span>;
  }
  return <span>{count.data.toLocaleString()} rows, counted just now</span>;
}

function DatasetsTab({
  projectId,
  projectCode,
  datasets,
}: {
  projectId: string;
  projectCode: string;
  datasets: DatasetRow[];
}) {
  const qc = useQueryClient();
  const [tableSearch, setTableSearch] = useState("");
  const filteredDatasets = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    if (!q) return datasets;
    return datasets.filter(
      (d) =>
        d.display_name.toLowerCase().includes(q) ||
        d.table_name.toLowerCase().includes(q) ||
        (d.source_filename ?? "").toLowerCase().includes(q),
    );
  }, [datasets, tableSearch]);
  const del = useMutation({
    mutationFn: async (id: string) => {
      await api.dropProjectDataset(id);
    },
    onSuccess: () => {
      toast.success("Dataset removed");
      qc.invalidateQueries({ queryKey: ["datasets", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });
  const freeze = useMutation({
    mutationFn: async (d: DatasetRow) => api.freezeCombinedDataset(d.id),
    onSuccess: ({ row_count }) => {
      toast.success(`Frozen — ${row_count.toLocaleString()} rows copied into a table of their own`);
      qc.invalidateQueries({ queryKey: ["datasets", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });
  const exportOne = useMutation({
    mutationFn: async (d: DatasetRow) => {
      const limit = 50000;
      const rows = await api.queryDataset(d.id, limit);
      const cols = d.column_schema.map((c) => c.name);
      await exportRows({
        projectId,
        projectCode,
        rows,
        columns: cols,
        label: d.display_name,
      });
      // A combined dataset has no stored total to compare against, so the
      // limit itself is the signal: a full page back means there may be more.
      return { exported: rows.length, total: d.row_count, capped: rows.length >= limit };
    },
    onSuccess: ({ exported, total, capped }) => {
      if (total !== null && exported < total) {
        toast.warning(
          `Exported ${exported.toLocaleString()} of ${total.toLocaleString()} rows (server limit)`,
        );
      } else if (total === null && capped) {
        toast.warning(`Exported the first ${exported.toLocaleString()} rows (server limit)`);
      } else {
        toast.success(`Exported ${exported.toLocaleString()} rows`);
      }
      qc.invalidateQueries({ queryKey: ["exports", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground">Datasets</h2>
          <p className="text-xs text-muted-foreground">
            Upload CSVs or import a whole folder of spreadsheets into this project.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CombineBuilderDialog
            projectId={projectId}
            datasets={datasets}
            trigger={
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={datasets.length === 0}
              >
                <Layers className="h-3.5 w-3.5" /> Combine datasets
              </Button>
            }
          />
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to="/import-folder" search={{ projectId }}>
              <FolderOpen className="h-3.5 w-3.5" /> Import folder
            </Link>
          </Button>
          <DatasetUploadDialog projectId={projectId} />
        </div>
      </div>
      <AttachedSources projectId={projectId} />
      {datasets.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-10 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-gradient-primary shadow-glow">
            <UploadCloud className="h-5 w-5 text-white" />
          </div>
          <h3 className="mt-4 text-sm font-bold text-foreground">Upload your first CSV</h3>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
            Drop in a CSV — headers become columns, types are inferred, and the file becomes a
            queryable table inside this project's database.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              placeholder="Search tables by name..."
              className="h-9 pl-9 text-xs"
            />
          </div>
          {filteredDatasets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-secondary/30 p-6 text-center text-xs text-muted-foreground">
              No tables match "{tableSearch.trim()}".
            </div>
          ) : (
            filteredDatasets.map((d) => (
              <div
                key={d.id}
                className="rounded-2xl border border-border/70 bg-card p-5 shadow-card"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-primary">
                      {d.table_name}
                    </div>
                    <h3 className="mt-0.5 flex items-center gap-2 truncate text-base font-bold text-foreground">
                      {d.display_name}
                      {d.recipe ? (
                        <Badge variant="outline" className="shrink-0 text-[9px]">
                          combined · live view
                        </Badge>
                      ) : (
                        d.read_only === 1 && (
                          <Badge variant="outline" className="shrink-0 text-[9px]">
                            attached · read-only
                          </Badge>
                        )
                      )}
                      {d.unavailable_reason && (
                        <Badge variant="destructive" className="shrink-0 text-[9px]">
                          unavailable
                        </Badge>
                      )}
                    </h3>
                    {/* Named here rather than left to fail as a raw "no such table". */}
                    {d.unavailable_reason && (
                      <p className="mt-1 text-[11px] text-destructive">
                        {d.unavailable_reason} —{" "}
                        {d.recipe
                          ? "edit how it is combined, or restore the dataset it reads from."
                          : "refresh or detach it under Attached databases."}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      {/* A combined view stores no row count: it is re-read from
                          its sources on every query, so a stored number would go
                          stale the moment a source changed. */}
                      {d.recipe ? (
                        <CombinedRowCount datasetId={d.id} />
                      ) : (
                        <span>{(d.row_count ?? 0).toLocaleString()} rows</span>
                      )}
                      <span>•</span>
                      <span>{d.column_schema.length} columns</span>
                      {d.source_filename && (
                        <>
                          <span>•</span>
                          <span className="truncate">{d.source_filename}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => exportOne.mutate(d)}
                      disabled={exportOne.isPending}
                    >
                      <Download className="h-3.5 w-3.5" /> Export CSV
                    </Button>
                    {d.recipe && (
                      <CombineBuilderDialog
                        projectId={projectId}
                        datasets={datasets}
                        editing={d}
                        trigger={
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <Layers className="h-3.5 w-3.5" /> Edit combination
                          </Button>
                        }
                      />
                    )}
                    {/* The escape hatch from live to fixed. A live view re-runs
                        its joins on every query, which stops being affordable
                        somewhere in the millions of rows; freezing trades that
                        cost for a copy that no longer follows its sources. */}
                    {d.recipe && !d.unavailable_reason && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-foreground"
                            disabled={freeze.isPending}
                          >
                            <Snowflake className="h-3.5 w-3.5" /> Freeze
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              Freeze "{d.display_name}" to a table?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              This copies the rows it returns right now into an ordinary table
                              called "{d.display_name} (frozen)". The copy stops following its
                              sources — later changes to them will not appear in it — and both this
                              combination and every dataset it reads from are left in place. On a
                              large combination the copy can take a while.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => freeze.mutate(d)}>
                              Freeze to a table
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                    {/* A combined dataset owns nothing but a recipe and a view,
                        so removing it is safe; an attached one must be detached. */}
                    {(d.read_only !== 1 || d.recipe) && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Remove
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete "{d.display_name}"?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {d.recipe ? (
                                <>
                                  This removes the combination only. Every dataset it reads from is
                                  left exactly as it is — no rows are deleted.
                                </>
                              ) : (
                                <>
                                  This drops the underlying database table
                                  <code className="mx-1 rounded bg-secondary px-1 py-0.5 text-[10px]">
                                    {d.table_name}
                                  </code>
                                  and removes {(d.row_count ?? 0).toLocaleString()} rows. This
                                  cannot be undone.
                                </>
                              )}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => del.mutate(d.id)}
                            >
                              {d.recipe ? "Remove combination" : "Delete dataset"}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {d.column_schema.map((c) => (
                    <span
                      key={c.name}
                      className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-secondary/60 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
                    >
                      {c.name}
                      <span className="rounded bg-background px-1 text-[9px] font-bold uppercase text-primary">
                        {c.type}
                      </span>
                    </span>
                  ))}
                </div>
                <DataDictionary projectId={projectId} datasetId={d.id} columns={d.column_schema} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ExportsTab({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["exports", projectId],
    queryFn: async () => {
      return api.listExportHistory(projectId, 50);
    },
  });
  const imports = useQuery({
    queryKey: ["imports", projectId],
    queryFn: async () => api.listImportHistory(projectId, 20),
  });
  if (isLoading) return <Skeleton className="h-40 rounded-2xl" />;
  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 text-sm font-bold text-foreground">Import history</h3>
        {!imports.data?.length ? (
          <p className="text-xs text-muted-foreground">No folder imports logged yet.</p>
        ) : (
          <div className="space-y-2">
            {imports.data.map((row) => (
              <div
                key={row.id}
                className="rounded-xl border border-border/70 bg-card p-3 text-xs shadow-card"
              >
                <div className="font-semibold">
                  {row.mode} · {new Date(row.created_at).toLocaleString()}
                </div>
                <div className="mt-1 text-muted-foreground">
                  {row.report?.totals
                    ? `${row.report.totals.tables} tables · ${row.report.totals.inserted.toLocaleString()} rows · ${row.report.totals.invalid} invalid · ${row.report.totals.skippedSources} sources skipped`
                    : "—"}
                </div>
                {row.folder_path && (
                  <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    {row.folder_path}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-bold text-foreground">Export history</h3>
        {!data || data.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-10 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-gradient-primary shadow-glow">
              <Download className="h-5 w-5 text-white" />
            </div>
            <h3 className="mt-4 text-sm font-bold text-foreground">No exports yet</h3>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
              Every CSV you download from the Query or Datasets tab is logged here.
            </p>
          </div>
        ) : (
          <ResultsTable
            columns={["filename", "row_count", "created_at"]}
            rows={data.map((r) => ({
              filename: r.filename,
              row_count: r.row_count,
              created_at: new Date(r.created_at).toLocaleString(),
            }))}
          />
        )}
      </div>
    </div>
  );
}
