import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Pencil, Save, X, BookOpen } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ColumnSchema } from "@/lib/csv";

type Column = ColumnSchema & { description?: string };

export function DataDictionary({
  projectId,
  datasetId,
  columns,
}: {
  projectId: string;
  datasetId: string;
  columns: Column[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 rounded-xl border border-border/60 bg-secondary/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-semibold text-foreground"
      >
        <span className="inline-flex items-center gap-1.5">
          <BookOpen className="h-3.5 w-3.5 text-primary" />
          Data dictionary · {columns.length} columns
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border/60 p-3">
          <div className="space-y-2">
            {columns.map((c) => (
              <ColumnRow
                key={c.name}
                projectId={projectId}
                datasetId={datasetId}
                column={c}
                allColumns={columns}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ColumnRow({
  projectId,
  datasetId,
  column,
  allColumns,
}: {
  projectId: string;
  datasetId: string;
  column: Column;
  allColumns: Column[];
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.description ?? "");

  const samples = useQuery({
    queryKey: ["dict-samples", datasetId, column.name],
    queryFn: async (): Promise<string[]> => {
      const rows = await api.datasetColumnValues(datasetId, [column.name], 8);
      return rows
        .map((r) => r[column.name])
        .filter((v) => v !== null && v !== undefined && v !== "")
        .slice(0, 5)
        .map((v) => String(v));
    },
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: async () => {
      const next = allColumns.map((c) =>
        c.name === column.name ? { ...c, description: draft.trim() || undefined } : c,
      );
      await api.updateDatasetColumnSchema(datasetId, next);
    },
    onSuccess: () => {
      toast.success("Description saved");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["datasets", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <code className="rounded bg-secondary px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
              {column.name}
            </code>
            <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-primary">
              {column.type}
            </span>
            {column.original_name && column.original_name !== column.name && (
              <span className="text-[10px] text-muted-foreground">
                from “{column.original_name}”
              </span>
            )}
          </div>
        </div>
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              setDraft(column.description ?? "");
              setEditing(true);
            }}
          >
            <Pencil className="h-3 w-3" /> {column.description ? "Edit" : "Describe"}
          </Button>
        )}
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What does this column represent? Units, source, valid range…"
            className="min-h-[64px] text-xs"
          />
          <div className="flex items-center justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-[11px]"
              onClick={() => setEditing(false)}
            >
              <X className="h-3 w-3" /> Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 gap-1 text-[11px]"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              <Save className="h-3 w-3" /> Save
            </Button>
          </div>
        </div>
      ) : column.description ? (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {column.description}
        </p>
      ) : (
        <p className="mt-1.5 text-[11px] italic text-muted-foreground/70">
          No description yet.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        <span className="font-semibold uppercase tracking-wider">Samples</span>
        {samples.isLoading ? (
          <span>Loading…</span>
        ) : samples.data && samples.data.length > 0 ? (
          samples.data.map((s, i) => (
            <span
              key={i}
              className="max-w-[240px] truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
              title={s}
            >
              {s}
            </span>
          ))
        ) : (
          <span className="italic">no values yet</span>
        )}
      </div>
    </div>
  );
}
