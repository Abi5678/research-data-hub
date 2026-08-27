import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isServerMode } from "@/lib/mode";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { AlertTriangle, Database, Link2Off, Plus, RefreshCw } from "lucide-react";

/**
 * Projects whose data already lives in a curated database — built by an ETL
 * pipeline, maintained outside this app — can attach that file instead of
 * re-importing copies of it. Attached tables are queryable but never written to.
 */
export function AttachedSources({ projectId }: { projectId: string }) {
  const qc = useQueryClient();

  const { data: sources } = useQuery({
    queryKey: ["attached-sources", projectId],
    queryFn: () => api.listAttachedSources(projectId),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["attached-sources", projectId] });
    qc.invalidateQueries({ queryKey: ["datasets", projectId] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };

  const attach = useMutation({
    mutationFn: async () => {
      const filePath = await api.pickDatabaseFile();
      if (!filePath) return null;
      return api.attachSource(projectId, filePath);
    },
    onSuccess: (result) => {
      if (!result) return; // dialog cancelled
      toast.success(`Attached ${result.alias} — ${result.table_count} tables`);
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not attach"),
  });

  /**
   * An attached database is maintained by someone else's pipeline, so its
   * contents move under us: tables get added or dropped and row counts change.
   * Nothing here polls for that — this re-reads on demand, and also picks the
   * source back up if its file was missing when the app started.
   */
  const reload = useMutation({
    mutationFn: () => api.refreshAttachedSources(projectId),
    onSuccess: (res) => {
      if (res.unavailable.length > 0) {
        toast.warning(
          `${res.unavailable.length} database(s) unavailable: ${res.unavailable
            .map((u) => `${u.alias} (${u.reason})`)
            .join(", ")}`,
        );
      } else {
        toast.success(`Re-read ${res.refreshed} attached database(s)`);
      }
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not refresh"),
  });

  const detach = useMutation({
    mutationFn: (id: string) => api.detachSource(id),
    onSuccess: () => {
      toast.success("Database detached — the file itself was not changed");
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not detach"),
  });

  // The lab server has no local filesystem to attach from.
  if (isServerMode) return null;

  const rows = sources ?? [];

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-foreground">Attached databases</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Query an existing SQLite database in place. Its tables appear as read-only
            datasets; the file is never modified.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => reload.mutate()}
              disabled={reload.isPending}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${reload.isPending ? "animate-spin" : ""}`} />
              {reload.isPending ? "Re-reading…" : "Refresh"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => attach.mutate()}
            disabled={attach.isPending}
          >
            <Plus className="h-3.5 w-3.5" />
            {attach.isPending ? "Attaching…" : "Attach database"}
          </Button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="mt-4 space-y-2">
          {rows.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-secondary/30 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Database
                  className={`h-3.5 w-3.5 shrink-0 ${s.available === 0 ? "text-destructive" : "text-primary"}`}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-foreground">
                      {s.alias}
                    </span>
                    <Badge variant="outline" className="text-[9px]">
                      {s.table_count} tables
                    </Badge>
                    {s.available === 0 && (
                      <Badge variant="destructive" className="gap-1 text-[9px]">
                        <AlertTriangle className="h-2.5 w-2.5" /> unavailable
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">{s.file_path}</div>
                  {s.available === 0 && (
                    <div className="truncate text-[10px] text-destructive">
                      {s.unavailable_reason} — its tables cannot be queried until the file is
                      back. Restore it and press Refresh, or detach it.
                    </div>
                  )}
                </div>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground hover:text-destructive"
                  >
                    <Link2Off className="h-3.5 w-3.5" /> Detach
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Detach "{s.alias}"?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Its {s.table_count} tables stop appearing in this project and any saved
                      query referencing them will fail. The database file at
                      <code className="mx-1 rounded bg-secondary px-1 py-0.5 text-[10px]">
                        {s.file_path}
                      </code>
                      is left untouched — you can attach it again later.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => detach.mutate(s.id)}>
                      Detach
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
