import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Search, AlertTriangle, FileSearch } from "lucide-react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ColumnSchema } from "@/lib/csv";

type Dataset = {
  id: string;
  display_name: string;
  table_name: string;
  column_schema: ColumnSchema[];
};

type Hit = {
  dataset: string;
  table: string;
  row_id: number;
  preview: Record<string, unknown>;
  matched_columns: string[];
};

const PER_TABLE_LIMIT = 25;
const TOTAL_LIMIT = 300;

function textishColumns(cols: ColumnSchema[]) {
  // Search across everything — cast to text — but skip nothing so numeric IDs work too.
  return cols.map((c) => c.name);
}

// SQLite: LIKE is case-insensitive for ASCII by default; concatenate every
// column cast to text and substring-match. One query per dataset table.
function buildDatasetSearchSql(d: Dataset, q: string): string {
  const escaped = q.replace(/'/g, "''");
  const cols = textishColumns(d.column_schema);
  if (cols.length === 0) return "";
  const concat = cols
    .map((c) => `COALESCE(CAST("${c.replace(/"/g, '""')}" AS TEXT),'')`)
    .join(` || ' ' || `);
  return `SELECT row_id AS __row, * FROM ${d.table_name} WHERE (${concat}) LIKE '%${escaped}%' LIMIT ${PER_TABLE_LIMIT}`;
}

function findMatchedColumns(row: Record<string, unknown>, q: string): string[] {
  const needle = q.toLowerCase();
  const out: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    if (String(v).toLowerCase().includes(needle)) out.push(k);
  }
  return out;
}

export function GlobalSearch({
  projectId,
  datasets,
}: {
  projectId: string;
  datasets: Dataset[];
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      const trimmed = q.trim();
      if (trimmed.length < 2) throw new Error("Enter at least 2 characters");
      const searchable = datasets.filter((d) => d.column_schema.length > 0);
      if (searchable.length === 0) throw new Error("No searchable columns in this project");

      const parsed: Hit[] = [];
      for (const d of searchable) {
        if (parsed.length >= TOTAL_LIMIT) break;
        const sql = buildDatasetSearchSql(d, trimmed);
        if (!sql) continue;
        const { rows } = await api.runProjectQuery(projectId, sql, PER_TABLE_LIMIT);
        for (const r of rows) {
          const { __row, row_id: _rowId, ...preview } = r as Record<string, unknown> & {
            __row?: unknown;
            row_id?: unknown;
          };
          parsed.push({
            dataset: d.display_name,
            table: d.table_name,
            row_id: Number(__row ?? 0),
            preview,
            matched_columns: findMatchedColumns(preview, trimmed),
          });
          if (parsed.length >= TOTAL_LIMIT) break;
        }
      }
      return parsed;
    },
    onSuccess: (data) => {
      setError(null);
      setHits(data);
    },
    onError: (err) => {
      setHits(null);
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  if (datasets.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-10 text-center text-sm text-muted-foreground">
        Upload at least one dataset to enable search.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
        <div className="text-xs font-semibold text-foreground">Search this project</div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Substring search across every column in every dataset. Best for specimen
          codes, section IDs, sponsor names, or any text fragment.
        </p>
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate();
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. 6007, WMA-RA, or Section 3"
              className="pl-8"
            />
          </div>
          <Button type="submit" disabled={run.isPending || q.trim().length < 2}>
            {run.isPending ? "Searching…" : "Search"}
          </Button>
        </form>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <div className="flex items-center gap-1 font-semibold">
            <AlertTriangle className="h-3 w-3" /> Search failed
          </div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{error}</pre>
        </div>
      )}

      {hits && hits.length === 0 && !error && (
        <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-8 text-center text-sm text-muted-foreground">
          <FileSearch className="mx-auto mb-2 h-6 w-6 opacity-60" />
          No rows matched “{q.trim()}”.
        </div>
      )}

      {hits && hits.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {hits.length.toLocaleString()} result{hits.length === 1 ? "" : "s"}
            {hits.length >= TOTAL_LIMIT && " (capped)"}
          </div>
          {hits.map((h, i) => (
            <HitCard key={`${h.table}-${h.row_id}-${i}`} hit={h} query={q.trim()} />
          ))}
        </div>
      )}
    </div>
  );
}

function HitCard({ hit, query }: { hit: Hit; query: string }) {
  const entries = Object.entries(hit.preview).filter(([, v]) => v !== null && v !== "");
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-bold uppercase tracking-wider text-primary">
          {hit.dataset}
        </div>
        <div className="text-[10px] text-muted-foreground">row #{hit.row_id}</div>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {entries.slice(0, 12).map(([k, v]) => {
          const matched = hit.matched_columns.includes(k);
          return (
            <div
              key={k}
              className={`rounded-md border px-2 py-1 text-[11px] ${
                matched
                  ? "border-primary/40 bg-primary/10"
                  : "border-border/60 bg-secondary/50"
              }`}
            >
              <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                {k}
              </div>
              <div className="truncate font-mono text-foreground" title={String(v)}>
                {highlight(String(v), query)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-primary/25 px-0.5 text-foreground">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}
