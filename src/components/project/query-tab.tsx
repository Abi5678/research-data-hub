import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Play,
  Plus,
  X,
  Save,
  Download,
  ChevronDown,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Code2,
  Wand2,
  Clipboard,
  Sliders,
  BookOpen,
  Lightbulb,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ColumnSchema } from "@/lib/csv";
import { exportRows, EXPORT_FORMATS, type ExportFormat } from "@/lib/export";
import { toCsv } from "@/lib/csv";
import { ResultsTable } from "@/components/project/results-table";
import type { ExampleQuery } from "@/lib/templates";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Dataset = {
  id: string;
  display_name: string;
  table_name: string;
  column_schema: ColumnSchema[];
};

type FilterOp =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "contains"
  | "is null"
  | "in";

type BuilderFilter = {
  id: string;
  table: string; // table_name
  column: string;
  op: FilterOp;
  value: string;
};

type BuilderJoin = {
  id: string;
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
};

type BuilderState = {
  tables: string[]; // ordered table_names selected
  columns: { table: string; column: string }[];
  filters: BuilderFilter[];
  joins: BuilderJoin[];
};

const OPS: FilterOp[] = ["=", "!=", ">", "<", ">=", "<=", "contains", "is null", "in"];
const PAGE_SIZE = 50;
const QUERY_FETCH_LIMIT = 5000;

function quoteIdent(s: string) {
  return '"' + s.replace(/"/g, '""') + '"';
}

function litValue(v: string): string {
  const escaped = v.replace(/'/g, "''");
  return `'${escaped}'`;
}

function aliasFor(index: number) {
  return `t${index + 1}`;
}

function buildSql(state: BuilderState, datasets: Dataset[], limit = 500): string {
  if (state.tables.length === 0) return "";
  const byName = new Map(datasets.map((d) => [d.table_name, d]));
  const aliases = new Map(state.tables.map((t, i) => [t, aliasFor(i)]));

  // SELECT
  let selectCols: string[];
  if (state.columns.length === 0) {
    selectCols = state.tables.map((t) => `${aliases.get(t)}.*`);
  } else {
    selectCols = state.columns.map(
      (c) => `${aliases.get(c.table)}.${quoteIdent(c.column)}`,
    );
  }

  // FROM + JOINs
  const first = state.tables[0]!;
  let fromClause = `${first} AS ${aliases.get(first)}`;
  for (let i = 1; i < state.tables.length; i++) {
    const t = state.tables[i]!;
    const join = state.joins.find(
      (j) =>
        (j.leftTable === t && aliases.has(j.rightTable)) ||
        (j.rightTable === t && aliases.has(j.leftTable)),
    );
    if (join) {
      const isRight = join.rightTable === t;
      const otherTable = isRight ? join.leftTable : join.rightTable;
      const thisCol = isRight ? join.rightColumn : join.leftColumn;
      const otherCol = isRight ? join.leftColumn : join.rightColumn;
      fromClause += ` JOIN ${t} AS ${aliases.get(t)} ON ${aliases.get(t)}.${quoteIdent(
        thisCol,
      )} = ${aliases.get(otherTable)}.${quoteIdent(otherCol)}`;
    } else {
      // Fallback CROSS JOIN when no join defined (should be rare; UI warns)
      fromClause += ` CROSS JOIN ${t} AS ${aliases.get(t)}`;
    }
  }

  // WHERE
  const whereParts: string[] = [];
  for (const f of state.filters) {
    if (!byName.has(f.table)) continue;
    const a = aliases.get(f.table);
    if (!a) continue;
    const col = `${a}.${quoteIdent(f.column)}`;
    switch (f.op) {
      case "is null":
        whereParts.push(`${col} IS NULL`);
        break;
      case "contains":
        // SQLite LIKE is case-insensitive for ASCII by default
        whereParts.push(`CAST(${col} AS TEXT) LIKE ${litValue("%" + f.value + "%")}`);
        break;
      case "in": {
        const items = f.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map(litValue);
        if (items.length) whereParts.push(`${col} IN (${items.join(", ")})`);
        break;
      }
      default:
        whereParts.push(`${col} = ${litValue(f.value)}`.replace("=", f.op));
    }
  }

  let sqlStr = `SELECT ${selectCols.join(", ")}\nFROM ${fromClause}`;
  if (whereParts.length) sqlStr += `\nWHERE ${whereParts.join(" AND ")}`;
  sqlStr += `\nLIMIT ${limit}`;
  return sqlStr;
}

export function QueryTab({
  projectId,
  projectCode,
  datasets,
  examples,
}: {
  projectId: string;
  projectCode: string;
  datasets: Dataset[];
  examples?: ExampleQuery[];
}) {
  if (datasets.length === 0) {
    return (
      <QueryEmptyState />
    );
  }
  const [mode, setMode] = useState<"builder" | "sql">("builder");
  const [sqlSeed, setSqlSeed] = useState<string>("");
  const loadExample = (sql: string) => {
    setSqlSeed(sql);
    setMode("sql");
  };
  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as "builder" | "sql")} className="space-y-4">
      <TabsList>
        <TabsTrigger value="builder" className="gap-1.5">
          <Wand2 className="h-3.5 w-3.5" /> Visual builder
        </TabsTrigger>
        <TabsTrigger value="sql" className="gap-1.5">
          <Code2 className="h-3.5 w-3.5" /> SQL editor
        </TabsTrigger>
      </TabsList>
      <TabsContent value="builder">
        <BuilderMode projectId={projectId} projectCode={projectCode} datasets={datasets} />
      </TabsContent>
      <TabsContent value="sql">
        <SqlMode
          projectId={projectId}
          projectCode={projectCode}
          datasets={datasets}
          initialSql={sqlSeed}
          examples={examples}
          onLoadExample={loadExample}
        />
      </TabsContent>
    </Tabs>
  );
}

function QueryEmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-10 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-gradient-primary shadow-glow">
        <Wand2 className="h-5 w-5 text-white" />
      </div>
      <h3 className="mt-4 text-sm font-bold text-foreground">Nothing to query yet</h3>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        Upload a CSV in the Datasets tab. Column types are inferred and the
        visual builder becomes available immediately after the first upload.
      </p>
    </div>
  );
}

// ============ BUILDER MODE ============

function BuilderMode({
  projectId,
  projectCode,
  datasets,
}: {
  projectId: string;
  projectCode: string;
  datasets: Dataset[];
}) {
  const [state, setState] = useState<BuilderState>({
    tables: datasets[0] ? [datasets[0].table_name] : [],
    columns: [],
    filters: [],
    joins: [],
  });

  const generatedSql = useMemo(
    () => buildSql(state, datasets, PAGE_SIZE * 20),
    [state, datasets],
  );
  const selectedDatasets = state.tables
    .map((t) => datasets.find((d) => d.table_name === t))
    .filter((d): d is Dataset => !!d);

  const toggleTable = (tableName: string) => {
    setState((s) => {
      if (s.tables.includes(tableName)) {
        return {
          ...s,
          tables: s.tables.filter((t) => t !== tableName),
          columns: s.columns.filter((c) => c.table !== tableName),
          filters: s.filters.filter((f) => f.table !== tableName),
          joins: s.joins.filter(
            (j) => j.leftTable !== tableName && j.rightTable !== tableName,
          ),
        };
      }
      return { ...s, tables: [...s.tables, tableName] };
    });
  };

  const toggleColumn = (table: string, column: string) => {
    setState((s) => {
      const has = s.columns.some((c) => c.table === table && c.column === column);
      return {
        ...s,
        columns: has
          ? s.columns.filter((c) => !(c.table === table && c.column === column))
          : [...s.columns, { table, column }],
      };
    });
  };

  const addFilter = () => {
    const first = selectedDatasets[0];
    if (!first) return;
    setState((s) => ({
      ...s,
      filters: [
        ...s.filters,
        {
          id: Math.random().toString(36).slice(2),
          table: first.table_name,
          column: first.column_schema[0]?.name ?? "",
          op: "=",
          value: "",
        },
      ],
    }));
  };

  const addJoin = () => {
    if (selectedDatasets.length < 2) return;
    const left = selectedDatasets[0]!;
    const right = selectedDatasets[1]!;
    setState((s) => ({
      ...s,
      joins: [
        ...s.joins,
        {
          id: Math.random().toString(36).slice(2),
          leftTable: left.table_name,
          leftColumn: left.column_schema[0]?.name ?? "",
          rightTable: right.table_name,
          rightColumn: right.column_schema[0]?.name ?? "",
        },
      ],
    }));
  };

  return (
    <div className="space-y-4">
      {/* Datasets */}
      <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
        <div className="text-xs font-semibold text-foreground">Tables</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {datasets.map((d) => (
            <label
              key={d.id}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-xs transition-colors ${
                state.tables.includes(d.table_name)
                  ? "border-primary/60 bg-primary/5"
                  : "border-border/70 hover:bg-secondary/60"
              }`}
            >
              <Checkbox
                checked={state.tables.includes(d.table_name)}
                onCheckedChange={() => toggleTable(d.table_name)}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <div className="truncate font-semibold text-foreground">
                  {d.display_name}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {d.table_name}
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Columns per selected table */}
      {selectedDatasets.length > 0 && (
        <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-foreground">
              Columns to display
            </div>
            <div className="text-[11px] text-muted-foreground">
              Leave empty to select *
            </div>
          </div>
          <div className="mt-3 space-y-3">
            {selectedDatasets.map((d) => (
              <div key={d.id}>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">
                  {d.display_name}
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {d.column_schema.map((c) => {
                    const active = state.columns.some(
                      (x) => x.table === d.table_name && x.column === c.name,
                    );
                    return (
                      <button
                        key={c.name}
                        type="button"
                        onClick={() => toggleColumn(d.table_name, c.name)}
                        className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border/70 bg-secondary/60 text-slate-700 hover:bg-secondary"
                        }`}
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Joins */}
      {selectedDatasets.length >= 2 && (
        <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-foreground">Joins</div>
            <Button size="sm" variant="ghost" onClick={addJoin} className="h-7 gap-1">
              <Plus className="h-3 w-3" /> Add join
            </Button>
          </div>
          {state.joins.length === 0 ? (
            <div className="mt-2 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-900">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              No join defined — multiple tables will produce a cross join.
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              {state.joins.map((j) => (
                <div key={j.id} className="flex flex-wrap items-center gap-1.5">
                  <TableColSelect
                    datasets={selectedDatasets}
                    table={j.leftTable}
                    column={j.leftColumn}
                    onChange={(t, c) =>
                      setState((s) => ({
                        ...s,
                        joins: s.joins.map((x) =>
                          x.id === j.id ? { ...x, leftTable: t, leftColumn: c } : x,
                        ),
                      }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">=</span>
                  <TableColSelect
                    datasets={selectedDatasets}
                    table={j.rightTable}
                    column={j.rightColumn}
                    onChange={(t, c) =>
                      setState((s) => ({
                        ...s,
                        joins: s.joins.map((x) =>
                          x.id === j.id ? { ...x, rightTable: t, rightColumn: c } : x,
                        ),
                      }))
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    onClick={() =>
                      setState((s) => ({
                        ...s,
                        joins: s.joins.filter((x) => x.id !== j.id),
                      }))
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      {selectedDatasets.length > 0 && (
        <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-foreground">Filters</div>
            <Button size="sm" variant="ghost" onClick={addFilter} className="h-7 gap-1">
              <Plus className="h-3 w-3" /> Add filter
            </Button>
          </div>
          {state.filters.length === 0 ? (
            <div className="mt-2 rounded-lg border border-dashed border-border/70 p-3 text-[11px] text-muted-foreground">
              No filters
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              {state.filters.map((f) => (
                <div key={f.id} className="flex flex-wrap items-center gap-1.5">
                  <TableColSelect
                    datasets={selectedDatasets}
                    table={f.table}
                    column={f.column}
                    onChange={(t, c) =>
                      setState((s) => ({
                        ...s,
                        filters: s.filters.map((x) =>
                          x.id === f.id ? { ...x, table: t, column: c } : x,
                        ),
                      }))
                    }
                  />
                  <Select
                    value={f.op}
                    onValueChange={(v) =>
                      setState((s) => ({
                        ...s,
                        filters: s.filters.map((x) =>
                          x.id === f.id ? { ...x, op: v as FilterOp } : x,
                        ),
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {f.op !== "is null" && (
                    <Input
                      className="h-8 flex-1 text-xs"
                      value={f.value}
                      onChange={(e) =>
                        setState((s) => ({
                          ...s,
                          filters: s.filters.map((x) =>
                            x.id === f.id ? { ...x, value: e.target.value } : x,
                          ),
                        }))
                      }
                      placeholder={f.op === "in" ? "a, b, c" : "value"}
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    onClick={() =>
                      setState((s) => ({
                        ...s,
                        filters: s.filters.filter((x) => x.id !== f.id),
                      }))
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Generated SQL + runner */}
      <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
        <Collapsible defaultOpen={false}>
          <div className="flex items-center justify-between">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                <ChevronDown className="h-3 w-3" /> Generated SQL
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="mt-2">
            <pre className="max-h-64 overflow-auto rounded-lg border border-border/70 bg-secondary/60 p-3 text-[11px] leading-relaxed text-slate-800">
              {generatedSql || "-- Select at least one table"}
            </pre>
          </CollapsibleContent>
        </Collapsible>
        <div className="mt-3">
          <QueryRunner
            projectId={projectId}
            projectCode={projectCode}
            sql={generatedSql}
            canRun={state.tables.length > 0}
          />
        </div>
      </div>
    </div>
  );
}

function TableColSelect({
  datasets,
  table,
  column,
  onChange,
}: {
  datasets: Dataset[];
  table: string;
  column: string;
  onChange: (table: string, column: string) => void;
}) {
  const current = datasets.find((d) => d.table_name === table) ?? datasets[0]!;
  return (
    <div className="flex items-center gap-1">
      <Select value={table} onValueChange={(v) => onChange(v, column)}>
        <SelectTrigger className="h-8 min-w-[110px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {datasets.map((d) => (
            <SelectItem key={d.id} value={d.table_name}>
              {d.display_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">.</span>
      <Select value={column} onValueChange={(v) => onChange(table, v)}>
        <SelectTrigger className="h-8 min-w-[110px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {current.column_schema.map((c) => (
            <SelectItem key={c.name} value={c.name}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ============ SQL MODE ============

function SqlMode({
  projectId,
  projectCode,
  datasets,
  initialSql,
  examples,
  onLoadExample,
}: {
  projectId: string;
  projectCode: string;
  datasets: Dataset[];
  initialSql: string;
  examples?: ExampleQuery[];
  onLoadExample?: (sql: string) => void;
}) {
  const defaultSql = `-- Reference tables by their internal name:\n${datasets
    .map((d) => `-- ${d.display_name}: ${d.table_name}`)
    .join("\n")}\n\nSELECT *\nFROM ${datasets[0]?.table_name ?? "your_table"}\nLIMIT 50`;
  const [sqlText, setSqlText] = useState<string>(initialSql || defaultSql);
  useEffect(() => {
    if (initialSql && initialSql !== sqlText) {
      setSqlText(initialSql);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSql]);

  const savedQueries = useQuery({
    queryKey: ["saved-queries", projectId],
    queryFn: async () => {
      return api.listSavedQueries(projectId);
    },
  });

  const [loadedName, setLoadedName] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {examples && examples.length > 0 && (
        <ExampleQueriesPanel
          examples={examples}
          onLoad={(ex) => {
            setSqlText(ex.sql);
            setLoadedName(ex.name);
            onLoadExample?.(ex.sql);
          }}
        />
      )}
      <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-foreground">SQL</div>
          <div className="flex items-center gap-2">
            {savedQueries.data && savedQueries.data.length > 0 && (
              <Select
                onValueChange={(v) => {
                  const q = savedQueries.data!.find((x) => x.id === v);
                  if (q?.sql_text) {
                    setSqlText(q.sql_text);
                    setLoadedName(q.name);
                  }
                }}
              >
                <SelectTrigger className="h-8 w-56 text-xs">
                  <SelectValue placeholder="Load saved query…" />
                </SelectTrigger>
                <SelectContent>
                  {savedQueries.data.map((q) => (
                    <SelectItem key={q.id} value={q.id}>
                      {q.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <SaveQueryDialog projectId={projectId} sqlText={sqlText} />
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-border/70">
          <CodeMirror
            value={sqlText}
            height="240px"
            extensions={[sql()]}
            onChange={(v) => setSqlText(v)}
            basicSetup={{ lineNumbers: true, foldGutter: false }}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Only SELECT / WITH statements are allowed (SQLite dialect). Reference
          tables via their internal name (shown as
          <code className="mx-1 rounded bg-secondary px-1 py-0.5 text-[10px]">
            ds_&lt;project&gt;_&lt;name&gt;
          </code>
          ).
        </p>
      </div>
      <QueryRunner
        projectId={projectId}
        projectCode={projectCode}
        sql={sqlText}
        canRun={sqlText.trim().length > 0}
        queryLabel={loadedName}
      />
    </div>
  );
}

function SaveQueryDialog({ projectId, sqlText }: { projectId: string; sqlText: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Name is required");
      await api.insertSavedQuery(projectId, name.trim(), sqlText);
    },
    onSuccess: () => {
      toast.success("Query saved");
      qc.invalidateQueries({ queryKey: ["saved-queries", projectId] });
      setOpen(false);
      setName("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1 text-xs">
          <Save className="h-3.5 w-3.5" /> Save
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save query</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="qname" className="text-xs">
            Name
          </Label>
          <Input
            id="qname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Flexibility index by section"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save query
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExampleQueriesPanel({
  examples,
  onLoad,
}: {
  examples: ExampleQuery[];
  onLoad: (ex: ExampleQuery) => void;
}) {
  return (
    <div className="rounded-2xl border border-primary/25 bg-gradient-primary-soft p-4 shadow-card">
      <div className="flex items-center gap-1.5">
        <Lightbulb className="h-3.5 w-3.5 text-primary" />
        <div className="text-xs font-bold text-foreground">Example queries</div>
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
          template
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Curated starting points for this template. Click to load into the editor —
        adjust dataset names if you renamed them at upload.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {examples.map((ex) => (
          <button
            key={ex.name}
            type="button"
            onClick={() => onLoad(ex)}
            className="group rounded-lg border border-border/70 bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
          >
            <div className="flex items-start gap-2">
              <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="truncate text-xs font-bold text-foreground">
                  {ex.name}
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                  {ex.description}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ============ RUNNER + RESULTS ============

type QueryResult = { columns: string[]; rows: Record<string, unknown>[] };

function QueryRunner({
  projectId,
  projectCode,
  sql,
  canRun,
  queryLabel,
}: {
  projectId: string;
  projectCode: string;
  sql: string;
  canRun: boolean;
  queryLabel?: string | null;
}) {
  const qc = useQueryClient();
  const [results, setResults] = useState<QueryResult | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedCols, setSelectedCols] = useState<string[] | null>(null);

  // Reset column selection whenever a new result set is loaded.
  useEffect(() => {
    if (results) setSelectedCols(results.columns);
  }, [results]);

  const run = useMutation({
    mutationFn: async () => {
      return api.runProjectQuery(projectId, sql, QUERY_FETCH_LIMIT);
    },
    onSuccess: (data) => {
      setError(null);
      setResults({ rows: data.rows ?? [], columns: data.columns ?? [] });
      setPage(0);
    },
    onError: (err) => {
      setResults(null);
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  const exportCsv = useMutation({
    mutationFn: async (format: ExportFormat) => {
      if (!sql.trim()) throw new Error("Nothing to export");
      const full = await api.runProjectQuery(projectId, sql, QUERY_FETCH_LIMIT);
      const cols =
        selectedCols?.length && results
          ? selectedCols.filter((c) => full.columns.includes(c))
          : full.columns;
      await exportRows({
        projectId,
        projectCode,
        rows: full.rows,
        columns: cols,
        label: queryLabel ?? null,
        format,
      });
      return { n: full.rows.length, format };
    },
    onSuccess: ({ n, format }) => {
      toast.success(`Exported ${n.toLocaleString()} rows as ${format.toUpperCase()}`);
      qc.invalidateQueries({ queryKey: ["exports", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  const copyToClipboard = useMutation({
    mutationFn: async () => {
      if (!results) throw new Error("Nothing to copy");
      const cols = selectedCols?.length ? selectedCols : results.columns;
      const csv = toCsv(results.rows, cols);
      await navigator.clipboard.writeText(csv);
    },
    onSuccess: () => toast.success("Copied to clipboard"),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  const totalPages = results ? Math.max(1, Math.ceil(results.rows.length / PAGE_SIZE)) : 0;
  const pageRows = useMemo(() => {
    if (!results) return [];
    const start = page * PAGE_SIZE;
    return results.rows.slice(start, start + PAGE_SIZE);
  }, [results, page]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => run.mutate()}
          disabled={!canRun || run.isPending}
          className="gap-1.5"
        >
          <Play className="h-3.5 w-3.5" />
          {run.isPending ? "Running…" : "Run query"}
        </Button>
        {results && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-1.5">
                <Sliders className="h-3.5 w-3.5" /> Columns
                <span className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold">
                  {(selectedCols ?? results.columns).length}/{results.columns.length}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-3">
              <div className="mb-2 flex items-center justify-between text-[11px] font-semibold">
                <span>Columns to export</span>
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setSelectedCols(results.columns)}
                >
                  Reset
                </button>
              </div>
              <div className="max-h-64 space-y-1 overflow-auto">
                {results.columns.map((c) => {
                  const checked = (selectedCols ?? results.columns).includes(c);
                  return (
                    <label
                      key={c}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-secondary/60"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          const base = selectedCols ?? results.columns;
                          setSelectedCols(
                            v
                              ? Array.from(new Set([...base, c]))
                              : base.filter((x) => x !== c),
                          );
                        }}
                      />
                      <span className="truncate">{c}</span>
                    </label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              disabled={!results || exportCsv.isPending}
              className="gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              {exportCsv.isPending ? "Exporting…" : "Download"}
              <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
              Export query results
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {EXPORT_FORMATS.map((f) => (
              <DropdownMenuItem
                key={f.id}
                className="flex flex-col items-start gap-0.5"
                onClick={() => exportCsv.mutate(f.id)}
              >
                <span className="text-xs font-semibold">{f.label}</span>
                <span className="text-[10px] text-muted-foreground">{f.hint}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {results && results.rows.length > 0 && results.rows.length < 1000 && (
          <Button
            variant="ghost"
            onClick={() => copyToClipboard.mutate()}
            disabled={copyToClipboard.isPending}
            className="gap-1.5"
          >
            <Clipboard className="h-3.5 w-3.5" /> Copy
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <div className="flex items-center gap-1 font-semibold">
            <AlertTriangle className="h-3 w-3" /> Query error
          </div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">
            {error}
          </pre>
        </div>
      )}

      {results && (
        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-card">
          <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <div>
              {results.rows.length.toLocaleString()} row
              {results.rows.length === 1 ? "" : "s"} · page {page + 1} of {totalPages}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <ResultsTable columns={results.columns} rows={pageRows} />
        </div>
      )}
    </div>
  );
}