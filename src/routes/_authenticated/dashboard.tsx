import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Bot, Database, FolderPlus, Sparkles, Calendar, User2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Research Data Hub" },
      {
        name: "description",
        content:
          "All your pavement research projects in one place. Open a project to manage datasets, run queries, and export results.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DashboardPage,
});

type ProjectCard = {
  id: string;
  project_name: string;
  project_code: string;
  description: string | null;
  sponsor: string | null;
  pi_name: string | null;
  created_at: string;
  dataset_count: number;
};

function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: async (): Promise<ProjectCard[]> => {
      const data = await api.listProjects();
      return data.map((p) => ({
        id: p.id,
        project_name: p.project_name,
        project_code: p.project_code,
        description: p.description,
        sponsor: p.sponsor,
        pi_name: p.pi_name,
        created_at: p.created_at,
        dataset_count: p.dataset_count,
      }));
    },
  });

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
      <header className="mb-8 flex flex-col gap-4 sm:mb-10 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-accent px-3 py-1 text-[11px] font-semibold text-accent-foreground">
            <Sparkles className="h-3 w-3" /> Your research workspace
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
            Projects
          </h1>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Keep your research files organized in shared projects. Upload a folder, review what was
            found, then explore and export the data.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" className="hover-lift-sm">
            <Link to="/import-folder">
              <Bot className="h-4 w-4" /> Import research folder
            </Link>
          </Button>
          <Button
            asChild
            className="bg-gradient-primary text-white shadow-cta hover-lift-sm hover:opacity-95"
          >
            <Link to="/projects/new">
              <FolderPlus className="h-4 w-4" /> New project
            </Link>
          </Button>
        </div>
      </header>

      {isLoading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-2xl" />
          ))}
        </div>
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {data!.map((p) => (
            <ProjectCardView key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCardView({ p }: { p: ProjectCard }) {
  return (
    <Link to="/projects/$projectId" params={{ projectId: p.id }} className="group block">
      <article className="hover-lift flex h-full flex-col rounded-2xl border border-border/70 bg-card p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-primary">
              {p.project_code}
            </div>
            <h3 className="mt-1 line-clamp-2 text-base font-bold leading-snug text-foreground">
              {p.project_name}
            </h3>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
        </div>
        {p.description && (
          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {p.description}
          </p>
        )}
        <div className="mt-auto pt-4">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <Badge variant="secondary" className="gap-1 font-semibold">
              <Database className="h-3 w-3" /> {p.dataset_count} dataset
              {p.dataset_count === 1 ? "" : "s"}
            </Badge>
            {p.pi_name && (
              <span className="inline-flex items-center gap-1">
                <User2 className="h-3 w-3" /> {p.pi_name}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-3 w-3" />{" "}
              {new Date(p.created_at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
        </div>
      </article>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-border/70 bg-gradient-primary-soft p-10 text-center sm:p-16">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-gradient-primary opacity-30 blur-3xl"
      />
      <div className="relative mx-auto max-w-md">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-primary shadow-glow">
          <FolderPlus className="h-6 w-6 text-white" />
        </div>
        <h2 className="mt-5 text-xl font-extrabold tracking-tight text-foreground">
          Start your first project
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Upload your research folder to organize files, review imported data, and share it with
          your lab team.
        </p>
        <Button
          asChild
          className="mt-6 bg-gradient-primary text-white shadow-cta hover-lift-sm hover:opacity-95"
        >
          <Link to="/import-folder">
            <FolderPlus className="h-4 w-4" /> Upload a research folder
          </Link>
        </Button>
      </div>
    </div>
  );
}
