import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  CombineBranch,
  CombineFinding,
  CombinePreflight,
  CombineRecipe,
  CombineSource,
} from "@/lib/api";
import type { ColumnKind, ColumnSchema } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  ChevronDown,
  Code2,
  Layers,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

/** What the builder needs from a dataset to offer it as a source. */
export type CombineSourceDataset = {
  id: string;
  display_name: string;
  table_name: string;
  column_schema: ColumnSchema[];
  unavailable_reason?: string | null;
  recipe?: CombineRecipe | null;
};

// Radix forbids an empty SelectItem value, so "no source" needs a sentinel.
const BLANK = "__blank__";

let seq = 0;
const nid = (prefix: string) => `${prefix}${(seq += 1)}`;

type BuilderJoin = {
  id: string;
  table: string;
  leftFrom: string;
  leftColumn: string;
  rightColumn: string;
  type: "left" | "inner";
  keyCompare: "native" | "text";
};

type BuilderBranch = {
  id: string;
  label: string;
  spine: string;
  joins: BuilderJoin[];
  /** column *id* -> where this branch reads it from. Keyed by id, not name, so
   *  renaming an output column cannot orphan its mapping. */
  map: Record<string, CombineSource | null>;
};

type BuilderColumn = { id: string; name: string; type: ColumnKind };

type BuilderState = {
  branches: BuilderBranch[];
  columns: BuilderColumn[];
  provenance: boolean;
};

/** One place a branch can read a column from: its spine, or one of its joins. */
type SourceRef = { from: string; table: string; label: string };

function branchSources(branch: BuilderBranch, name: (t: string) => string): SourceRef[] {
  return [
    { from: "spine", table: branch.spine, label: name(branch.spine) },
    ...branch.joins
      .filter((j) => j.table)
      .map((j) => ({ from: j.id, table: j.table, label: name(j.table) })),
  ].filter((s) => s.table);
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function toRecipe(state: BuilderState): CombineRecipe {
  return {
    version: 1,
    provenance: state.provenance,
    columns: state.columns.map((c) => ({ name: c.name, type: c.type })),
    branches: state.branches.map((b) => ({
      id: b.id,
      label: b.label || undefined,
      spine: b.spine,
      joins: b.joins.map((j) => ({
        id: j.id,
        table: j.table,
        leftFrom: j.leftFrom,
        leftColumn: j.leftColumn,
        rightColumn: j.rightColumn,
        type: j.type,
        keyCompare: j.keyCompare,
      })),
      map: Object.fromEntries(state.columns.map((c) => [c.name, b.map[c.id] ?? null])),
    })),
  };
}

/** Reverse of toRecipe, for editing a saved combined dataset. */
function fromRecipe(recipe: CombineRecipe): BuilderState {
  const columns = recipe.columns.map((c) => ({ id: nid("c"), name: c.name, type: c.type }));
  return {
    provenance: Boolean(recipe.provenance),
    columns,
    branches: recipe.branches.map((b: CombineBranch) => ({
      id: b.id,
      label: b.label ?? "",
      spine: b.spine,
      joins: (b.joins ?? []).map((j) => ({
        id: j.id,
        table: j.table,
        leftFrom: j.leftFrom ?? "spine",
        leftColumn: j.leftColumn,
        rightColumn: j.rightColumn,
        type: j.type ?? "left",
        keyCompare: j.keyCompare ?? "native",
      })),
      map: Object.fromEntries(columns.map((c) => [c.id, b.map?.[c.name] ?? null])),
    })),
  };
}

const emptyState = (): BuilderState => ({
  branches: [{ id: nid("b"), label: "", spine: "", joins: [], map: {} }],
  columns: [],
  provenance: false,
});

/**
 * Build one table out of several: joins add columns, extra sources add rows.
 *
 * The result is a live view over the sources, never a copy — so nothing here
 * ever writes to, reshapes, or deletes the datasets it reads from, and dropping
 * a column from the combination leaves that column exactly where it was.
 */
export function CombineBuilderDialog({
  projectId,
  datasets,
  editing,
  trigger,
}: {
  projectId: string;
  datasets: CombineSourceDataset[];
  editing?: CombineSourceDataset;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit "${editing.display_name}"` : "New combined dataset"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Combine datasets into one table. Joining adds columns; stacking adds rows. The result is
            a live view — the datasets it reads from are never copied or changed.
          </DialogDescription>
        </DialogHeader>
        {/* Remounted per open so an abandoned edit never leaks into the next one. */}
        {open && (
          <CombineBuilder
            key={editing?.id ?? "new"}
            projectId={projectId}
            datasets={datasets}
            editing={editing}
            onDone={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CombineBuilder({
  projectId,
  datasets,
  editing,
  onDone,
}: {
  projectId: string;
  datasets: CombineSourceDataset[];
  editing?: CombineSourceDataset;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(editing?.display_name ?? "");
  const [state, setState] = useState<BuilderState>(() =>
    editing?.recipe ? fromRecipe(editing.recipe) : emptyState(),
  );

  // A dataset whose file went missing would only fail again in the preflight,
  // and a combined dataset cannot be built on itself.
  const sources = useMemo(
    () => datasets.filter((d) => !d.unavailable_reason && d.id !== editing?.id),
    [datasets, editing?.id],
  );
  const byTable = useMemo(() => new Map(sources.map((d) => [d.table_name, d])), [sources]);
  const name = (table: string) => byTable.get(table)?.display_name ?? table;
  const columnsOf = (table: string) => byTable.get(table)?.column_schema ?? [];

  const patchBranch = (id: string, patch: Partial<BuilderBranch>) =>
    setState((s) => ({
      ...s,
      branches: s.branches.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    }));

  /** The same-named column in a branch, if it has one — the auto-map guess. */
  const guessSource = (branch: BuilderBranch, colName: string): CombineSource | null => {
    for (const src of branchSources(branch, name)) {
      const hit = columnsOf(src.table).find((c) => c.name === colName);
      if (hit) return { from: src.from, column: hit.name };
    }
    return null;
  };

  const addColumn = (branchId: string, src: SourceRef, col: ColumnSchema) =>
    setState((s) => {
      const id = nid("c");
      const colName = uniqueName(col.name, new Set(s.columns.map((c) => c.name)));
      const next: BuilderColumn = { id, name: colName, type: col.type };
      return {
        ...s,
        columns: [...s.columns, next],
        branches: s.branches.map((b) => ({
          ...b,
          map: {
            ...b.map,
            // The branch it was picked from binds exactly; every other branch
            // gets a same-name guess, which the preflight then reports on.
            [id]:
              b.id === branchId ? { from: src.from, column: col.name } : guessSource(b, col.name),
          },
        })),
      };
    });

  const removeColumn = (id: string) =>
    setState((s) => ({ ...s, columns: s.columns.filter((c) => c.id !== id) }));

  const addBranch = () =>
    setState((s) => ({
      ...s,
      branches: [...s.branches, { id: nid("b"), label: "", spine: "", joins: [], map: {} }],
    }));

  const setSpine = (branchId: string, table: string) =>
    setState((s) => ({
      ...s,
      branches: s.branches.map((b) => {
        if (b.id !== branchId) return b;
        // Joins hang off the spine, and the columns were read through it, so
        // both are stale the moment it changes. Re-guess rather than keep a
        // mapping that now points at a table this branch no longer reads.
        const next: BuilderBranch = { ...b, spine: table, joins: [], map: {} };
        for (const c of s.columns) next.map[c.id] = guessSource(next, c.name);
        return next;
      }),
    }));

  const addJoin = (branch: BuilderBranch) =>
    patchBranch(branch.id, {
      joins: [
        ...branch.joins,
        {
          id: nid("j"),
          table: "",
          leftFrom: "spine",
          leftColumn: "",
          rightColumn: "",
          // LEFT by default: an inner join silently deletes the rows that did
          // not match, which is the quietest way to end up with a wrong table.
          type: "left",
          keyCompare: "native",
        },
      ],
    });

  const patchJoin = (branch: BuilderBranch, joinId: string, patch: Partial<BuilderJoin>) =>
    patchBranch(branch.id, {
      joins: branch.joins.map((j) => (j.id === joinId ? { ...j, ...patch } : j)),
    });

  const removeJoin = (branch: BuilderBranch, joinId: string) =>
    setState((s) => ({
      ...s,
      branches: s.branches.map((b) =>
        b.id !== branch.id
          ? b
          : {
              ...b,
              joins: b.joins.filter((j) => j.id !== joinId),
              // Columns read through the removed join have nowhere to come from.
              map: Object.fromEntries(
                Object.entries(b.map).map(([k, v]) => [k, v?.from === joinId ? null : v]),
              ),
            },
      ),
    }));

  const recipe = useMemo(() => toRecipe(state), [state]);

  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const c of state.columns) {
      if (seen.has(c.name)) dupes.add(c.name);
      seen.add(c.name);
    }
    return [...dupes];
  }, [state.columns]);

  const incomplete =
    state.branches.some(
      (b) => !b.spine || b.joins.some((j) => !j.table || !j.leftColumn || !j.rightColumn),
    ) ||
    state.columns.length === 0 ||
    duplicateNames.length > 0;

  // The recipe changes on every keystroke in a column name; the preflight runs
  // real counting queries, so it follows at a distance rather than per stroke.
  const [settled, setSettled] = useState(recipe);
  useEffect(() => {
    const t = setTimeout(() => setSettled(recipe), 400);
    return () => clearTimeout(t);
  }, [recipe]);

  const preflight = useQuery({
    queryKey: ["combine-preflight", projectId, editing?.id ?? null, JSON.stringify(settled)],
    queryFn: () => api.preflightCombine(projectId, settled, editing?.id ?? null),
    enabled: !incomplete,
    retry: false,
  });

  const preview = useQuery({
    queryKey: ["combine-sql", projectId, JSON.stringify(settled)],
    queryFn: () => api.previewCombinedSql(projectId, settled),
    enabled: !incomplete,
    retry: false,
  });

  const blocks = (preflight.data?.findings ?? []).filter((f) => f.level === "block");
  const warns = (preflight.data?.findings ?? []).filter((f) => f.level === "warn");

  // Acknowledgement is tied to the exact warnings shown. Change the join and
  // the tick clears, so nobody accepts a fan-out they never saw.
  const warnSignature = warns.map((f) => `${f.code}:${f.message}`).join("|");
  const [acked, setAcked] = useState("");
  const warningsAccepted = warns.length === 0 || acked === warnSignature;

  const save = useMutation({
    mutationFn: async () => {
      if (editing) {
        return api.updateCombinedDataset(editing.id, { displayName: displayName.trim(), recipe });
      }
      return api.createCombinedDataset({
        projectId,
        displayName: displayName.trim(),
        recipe,
      });
    },
    onSuccess: () => {
      toast.success(editing ? "Combined dataset updated" : "Combined dataset created");
      qc.invalidateQueries({ queryKey: ["datasets", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      onDone();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const canSave =
    !incomplete &&
    displayName.trim().length > 0 &&
    preflight.data?.ok === true &&
    warningsAccepted &&
    !save.isPending;

  if (sources.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-secondary/30 p-6 text-center text-xs text-muted-foreground">
        There are no datasets in this project to combine yet. Upload a CSV or attach a database
        first.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs">Name</Label>
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="All mixes, 2022–2024"
          className="h-9 text-xs"
        />
      </div>

      {/* ---------- sources ---------- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-foreground">Sources</h3>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={addBranch}>
            <Layers className="h-3.5 w-3.5" /> Stack another dataset
          </Button>
        </div>

        {state.branches.map((branch, i) => (
          <div
            key={branch.id}
            className="rounded-xl border border-border/70 bg-card p-4 shadow-card"
          >
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[13rem] flex-1 space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">
                  {i === 0 ? "Start from" : "Stack rows from"}
                </Label>
                <Select value={branch.spine} onValueChange={(v) => setSpine(branch.id, v)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Choose a dataset" />
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((d) => (
                      <SelectItem key={d.id} value={d.table_name} className="text-xs">
                        {d.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {state.provenance && (
                <div className="min-w-[10rem] flex-1 space-y-1.5">
                  <Label className="text-[11px] text-muted-foreground">Labelled as</Label>
                  <Input
                    value={branch.label}
                    onChange={(e) => patchBranch(branch.id, { label: e.target.value })}
                    placeholder={branch.spine ? name(branch.spine) : "source name"}
                    className="h-8 text-xs"
                  />
                </div>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                disabled={!branch.spine}
                onClick={() => addJoin(branch)}
              >
                <Plus className="h-3.5 w-3.5" /> Join a dataset
              </Button>
              {state.branches.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      branches: s.branches.filter((b) => b.id !== branch.id),
                    }))
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {branch.joins.map((join, ji) => (
              <JoinRow
                key={join.id}
                join={join}
                sources={sources}
                // Only what the branch already has above this join can be
                // joined onto — a join cannot hang off a later one.
                upstream={branchSources({ ...branch, joins: branch.joins.slice(0, ji) }, name)}
                columnsOf={columnsOf}
                onPatch={(patch) => patchJoin(branch, join.id, patch)}
                onRemove={() => removeJoin(branch, join.id)}
              />
            ))}

            {branch.spine && (
              <ColumnPicker
                branch={branch}
                sourceRefs={branchSources(branch, name)}
                columnsOf={columnsOf}
                onAdd={(src, col) => addColumn(branch.id, src, col)}
              />
            )}
          </div>
        ))}

        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Checkbox
            checked={state.provenance}
            onCheckedChange={(v) => setState((s) => ({ ...s, provenance: v === true }))}
          />
          Add a <code className="rounded bg-secondary px-1">source_dataset</code> column naming
          which source each row came from
        </label>
      </section>

      {/* ---------- output columns ---------- */}
      <section className="space-y-2">
        <h3 className="text-sm font-bold text-foreground">Columns in the combined table</h3>
        {state.columns.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-secondary/30 p-4 text-center text-xs text-muted-foreground">
            Pick columns from the sources above. Removing one here never touches the dataset it came
            from.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/70">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-bold">Column</th>
                  {state.branches.map((b, i) => (
                    <th key={b.id} className="px-3 py-2 text-left font-bold">
                      From {b.spine ? name(b.spine) : `source ${i + 1}`}
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {state.columns.map((c) => (
                  <tr key={c.id} className="border-t border-border/60">
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={c.name}
                          onChange={(e) =>
                            setState((s) => ({
                              ...s,
                              columns: s.columns.map((x) =>
                                x.id === c.id ? { ...x, name: e.target.value } : x,
                              ),
                            }))
                          }
                          className="h-7 w-40 text-xs"
                        />
                        <Badge variant="outline" className="shrink-0 text-[9px]">
                          {c.type}
                        </Badge>
                      </div>
                    </td>
                    {state.branches.map((b) => {
                      const refs = branchSources(b, name);
                      const current = b.map[c.id];
                      const value = current ? `${current.from}::${current.column}` : BLANK;
                      return (
                        <td key={b.id} className="px-3 py-1.5">
                          <Select
                            value={value}
                            onValueChange={(v) =>
                              patchBranch(b.id, {
                                map: {
                                  ...b.map,
                                  [c.id]:
                                    v === BLANK
                                      ? null
                                      : {
                                          from: v.split("::")[0]!,
                                          column: v.slice(v.indexOf("::") + 2),
                                        },
                                },
                              })
                            }
                          >
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue placeholder="blank" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={BLANK} className="text-xs">
                                (blank)
                              </SelectItem>
                              {refs.flatMap((src) =>
                                columnsOf(src.table).map((col) => (
                                  <SelectItem
                                    key={`${src.from}::${col.name}`}
                                    value={`${src.from}::${col.name}`}
                                    className="text-xs"
                                  >
                                    {src.label} · {col.name}
                                  </SelectItem>
                                )),
                              )}
                            </SelectContent>
                          </Select>
                        </td>
                      );
                    })}
                    <td className="px-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => removeColumn(c.id)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {duplicateNames.length > 0 && (
          <p className="text-[11px] font-semibold text-destructive">
            Two columns are both named {duplicateNames.map((n) => `"${n}"`).join(", ")}. Rename one
            — otherwise there is no way to tell which source a value came from.
          </p>
        )}
      </section>

      {/* ---------- preflight ---------- */}
      <section className="space-y-2">
        <h3 className="text-sm font-bold text-foreground">Check</h3>
        {incomplete ? (
          <p className="text-[11px] text-muted-foreground">
            Finish choosing sources, join keys and columns, and this checks the combination against
            the real data before anything is saved.
          </p>
        ) : preflight.isFetching ? (
          <p className="text-[11px] text-muted-foreground">Checking against the data…</p>
        ) : preflight.error ? (
          <Finding
            level="block"
            message={preflight.error instanceof Error ? preflight.error.message : "Check failed"}
          />
        ) : preflight.data ? (
          <div className="space-y-2">
            {blocks.map((f, i) => (
              <Finding key={`b${i}`} level="block" message={f.message} />
            ))}
            {warns.map((f, i) => (
              <Finding key={`w${i}`} level="warn" message={f.message} />
            ))}
            {blocks.length === 0 && warns.length === 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                Nothing looks wrong: every key matches, no join multiplies or drops rows.
              </div>
            )}
            {/* A blocked recipe returns before it counts anything, so there is
                no row summary to show — only the reason it stopped. */}
            {blocks.length === 0 && <RowSummary preflight={preflight.data} />}
            {warns.length > 0 && blocks.length === 0 && (
              <label className="flex items-start gap-2 text-[11px] text-foreground">
                <Checkbox
                  className="mt-0.5"
                  checked={warningsAccepted}
                  onCheckedChange={(v) => setAcked(v === true ? warnSignature : "")}
                />
                I have read the warnings above and this is what I want.
              </label>
            )}
          </div>
        ) : null}
      </section>

      {/* ---------- SQL preview ---------- */}
      {preview.data && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <Code2 className="h-3.5 w-3.5" /> Show the SQL this builds
              <ChevronDown className="h-3 w-3" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-56 overflow-auto rounded-xl border border-border/70 bg-secondary/40 p-3 font-mono text-[10px] leading-relaxed text-foreground">
              {preview.data}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={!canSave} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : editing ? "Save changes" : "Create combined dataset"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function JoinRow({
  join,
  sources,
  upstream,
  columnsOf,
  onPatch,
  onRemove,
}: {
  join: BuilderJoin;
  sources: CombineSourceDataset[];
  upstream: SourceRef[];
  columnsOf: (table: string) => ColumnSchema[];
  onPatch: (patch: Partial<BuilderJoin>) => void;
  onRemove: () => void;
}) {
  const leftTable = upstream.find((s) => s.from === join.leftFrom)?.table ?? upstream[0]?.table;

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-border/60 bg-secondary/30 p-2.5">
      <div className="min-w-[11rem] flex-1 space-y-1">
        <Label className="text-[10px] text-muted-foreground">Add columns from</Label>
        <Select value={join.table} onValueChange={(v) => onPatch({ table: v, rightColumn: "" })}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Choose a dataset" />
          </SelectTrigger>
          <SelectContent>
            {sources.map((d) => (
              <SelectItem key={d.id} value={d.table_name} className="text-xs">
                {d.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {upstream.length > 1 && (
        <div className="min-w-[9rem] space-y-1">
          <Label className="text-[10px] text-muted-foreground">Onto</Label>
          <Select
            value={join.leftFrom}
            onValueChange={(v) => onPatch({ leftFrom: v, leftColumn: "" })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {upstream.map((s) => (
                <SelectItem key={s.from} value={s.from} className="text-xs">
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="min-w-[9rem] space-y-1">
        <Label className="text-[10px] text-muted-foreground">Matching</Label>
        <Select value={join.leftColumn} onValueChange={(v) => onPatch({ leftColumn: v })}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="key column" />
          </SelectTrigger>
          <SelectContent>
            {columnsOf(leftTable ?? "").map((c) => (
              <SelectItem key={c.name} value={c.name} className="text-xs">
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <span className="pb-2 text-xs text-muted-foreground">=</span>
      <div className="min-w-[9rem] space-y-1">
        <Label className="text-[10px] text-muted-foreground">To</Label>
        <Select
          value={join.rightColumn}
          onValueChange={(v) => onPatch({ rightColumn: v })}
          disabled={!join.table}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="key column" />
          </SelectTrigger>
          <SelectContent>
            {columnsOf(join.table).map((c) => (
              <SelectItem key={c.name} value={c.name} className="text-xs">
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-[12rem] space-y-1">
        <Label className="text-[10px] text-muted-foreground">Rows that match nothing</Label>
        <Select
          value={join.type}
          onValueChange={(v) => onPatch({ type: v as BuilderJoin["type"] })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left" className="text-xs">
              Keep them, blank
            </SelectItem>
            <SelectItem value="inner" className="text-xs">
              Drop them
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-[11rem] space-y-1">
        <Label className="text-[10px] text-muted-foreground">Compare keys</Label>
        <Select
          value={join.keyCompare}
          onValueChange={(v) => onPatch({ keyCompare: v as BuilderJoin["keyCompare"] })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="native" className="text-xs">
              As they are
            </SelectItem>
            <SelectItem value="text" className="text-xs">
              As text (strict)
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/** Chips for every column a branch can offer; clicking one adds it to the output. */
function ColumnPicker({
  branch,
  sourceRefs,
  columnsOf,
  onAdd,
}: {
  branch: BuilderBranch;
  sourceRefs: SourceRef[];
  columnsOf: (table: string) => ColumnSchema[];
  onAdd: (src: SourceRef, col: ColumnSchema) => void;
}) {
  const used = new Set(
    Object.values(branch.map)
      .filter((v): v is CombineSource => Boolean(v))
      .map((v) => `${v.from}::${v.column}`),
  );
  return (
    <div className="mt-3 space-y-2">
      {sourceRefs.map((src) => (
        <div key={src.from} className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {src.label}
          </span>
          {columnsOf(src.table)
            // row_id is generated for the combined table, never carried across.
            .filter((c) => c.name !== "row_id")
            .map((c) => {
              const taken = used.has(`${src.from}::${c.name}`);
              return (
                <button
                  key={c.name}
                  type="button"
                  disabled={taken}
                  onClick={() => onAdd(src, c)}
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                    taken
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border/70 bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  }`}
                >
                  {c.name}
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}

function Finding({ level, message }: { level: CombineFinding["level"]; message: string }) {
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
        level === "block"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      }`}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function RowSummary({ preflight }: { preflight: CombinePreflight }) {
  return (
    <div className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
      {preflight.estimatedRows === null ? (
        // Saying nothing beats an exact-looking number that is a guess.
        <>
          These sources are too large to count exactly without a wait, so the row count is left
          unstated until the table is built.
        </>
      ) : (
        <>
          <span className="font-semibold text-foreground">
            {preflight.estimatedRows.toLocaleString()} rows
          </span>{" "}
          in the combined table
          {preflight.branches.length > 1 && (
            <>
              {" "}
              ={" "}
              {preflight.branches
                .map((b) => `${b.label} ${b.rows === null ? "?" : b.rows.toLocaleString()}`)
                .join(" + ")}
            </>
          )}
          {preflight.branches
            .filter((b) => b.rows !== null && b.spineRows !== null && b.rows !== b.spineRows)
            .map((b) => (
              <div key={b.id} className="mt-0.5">
                "{b.label}" has {b.spineRows!.toLocaleString()} rows on its own and{" "}
                {b.rows!.toLocaleString()} after its joins.
              </div>
            ))}
        </>
      )}
    </div>
  );
}
