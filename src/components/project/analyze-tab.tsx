import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResultsTable } from "@/components/project/results-table";
import { AnalyzePlotCard } from "@/components/project/analyze-plot-card";
import type { ColumnSchema } from "@/lib/csv";
import {
  BROWSE_FETCH_LIMIT,
  type BrowseFilterOp,
  guessIdColumn,
  hasRowIdColumn,
  rowKey,
} from "@/lib/browse-sql";
import {
  ANALYZE_MAX_PLOTS,
  analyzeKpis,
  analyzeToDashboardSpec,
  buildAnalyzePlot,
  createPlotSpec,
  defaultAnalyzeColumns,
  guessPlotDefaults,
  numericSelectedColumns,
  plotResultToChartTable,
  plotSpecColumns,
  suggestNextPlot,
  type AnalyzePlotSpec,
} from "@/lib/analyze-plot";
import {
  buildAnalyzeSql,
  buildAnalyzeViewSpec,
  buildJoinUnmatchedSql,
  defaultJoinVisibleColumns,
  guessJoinColumns,
  guessJoinedPlotDefaults,
  parseAnalyzeViewSpec,
  planJoinColumns,
  toWorkingSchema,
  type AnalyzeJoin,
} from "@/lib/analyze-sql";
import { formatKpiValue } from "@/lib/dashboard-spec";
import { makeLabeller } from "@/lib/column-label";
import { captureCharts } from "@/lib/chart-image";
import { exportDashboard, type DashboardExportFormat } from "@/lib/export-dashboard";
import {
  ChevronDown,
  Filter,
  LineChart,
  Link2,
  Loader2,
  Plus,
  Save,
  Search,
  Table2,
  Trash2,
  X,
} from "lucide-react";

type Dataset = {
  id: string;
  display_name: string;
  table_name: string;
  row_count: number | null;
  column_schema: ColumnSchema[];
};

export function AnalyzeTab({
  projectId,
  projectCode,
  datasets,
}: {
  projectId: string;
  projectCode: string;
  datasets: Dataset[];
}) {
  const qc = useQueryClient();
  const plotsRef = useRef<HTMLDivElement>(null);
  const skipTableReset = useRef(false);
  const [tableName, setTableName] = useState(datasets[0]?.table_name ?? "");
  const dataset = datasets.find((d) => d.table_name === tableName) ?? datasets[0] ?? null;

  useEffect(() => {
    if (!datasets.length) return;
    if (!tableName || !datasets.some((d) => d.table_name === tableName)) {
      setTableName(datasets[0]!.table_name);
    }
  }, [datasets, tableName]);

  const [visibleCols, setVisibleCols] = useState<string[]>([]);
  const [tableSearch, setTableSearch] = useState("");
  const [filterColumn, setFilterColumn] = useState("");
  const [filterOp, setFilterOp] = useState<BrowseFilterOp>("in");
  const [filterValue, setFilterValue] = useState("");
  const [applied, setApplied] = useState<{
    column: string;
    op: BrowseFilterOp;
    value: string;
  } | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [plots, setPlots] = useState<AnalyzePlotSpec[]>([createPlotSpec()]);
  const [joinEnabled, setJoinEnabled] = useState(false);
  const [rightTable, setRightTable] = useState("");
  const [leftJoinCol, setLeftJoinCol] = useState("");
  const [rightJoinCol, setRightJoinCol] = useState("");
  const [loadedViewId, setLoadedViewId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  const rightDataset =
    joinEnabled && rightTable && rightTable !== dataset?.table_name
      ? (datasets.find((d) => d.table_name === rightTable) ?? null)
      : null;

  const columnRefs = useMemo(() => {
    if (!dataset) return [];
    const leftCols = dataset.column_schema.map((c) => c.name);
    if (!rightDataset) {
      return leftCols
        .filter((n) => n !== "row_id")
        .map((column) => ({ name: column, table: "left" as const, column }));
    }
    return planJoinColumns(
      leftCols,
      rightDataset.column_schema.map((c) => c.name),
    );
  }, [dataset, rightDataset]);

  const workingSchema = useMemo((): ColumnSchema[] => {
    if (!dataset) return [];
    if (!rightDataset) return dataset.column_schema;
    return toWorkingSchema(columnRefs, dataset.column_schema, rightDataset.column_schema);
  }, [dataset, rightDataset, columnRefs]);

  useEffect(() => {
    if (!dataset) return;
    if (skipTableReset.current) {
      skipTableReset.current = false;
      return;
    }
    setJoinEnabled(false);
    setRightTable("");
    setLeftJoinCol("");
    setRightJoinCol("");
    const cols = defaultAnalyzeColumns(dataset.column_schema);
    setVisibleCols(cols);
    setFilterColumn(guessIdColumn(dataset.column_schema));
    setFilterOp("in");
    setFilterValue("");
    setApplied(null);
    setSelectedRowIds(new Set());
    setPlots([guessPlotDefaults(dataset.column_schema, cols)]);
    setLoadedViewId(null);
  }, [dataset?.id]);

  const allColNames = useMemo(
    () => columnRefs.map((c) => c.name).filter((n) => n !== "row_id"),
    [columnRefs],
  );
  const filteredTables = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    if (!q) return datasets;
    return datasets.filter(
      (d) => d.display_name.toLowerCase().includes(q) || d.table_name.toLowerCase().includes(q),
    );
  }, [datasets, tableSearch]);

  const join: AnalyzeJoin | null =
    dataset && rightDataset && leftJoinCol && rightJoinCol
      ? {
          leftTable: dataset.table_name,
          rightTable: rightDataset.table_name,
          leftColumn: leftJoinCol,
          rightColumn: rightJoinCol,
        }
      : null;

  const queryCols = useMemo(() => {
    const set = new Set(visibleCols);
    for (const plot of plots) {
      for (const col of plotSpecColumns(plot)) set.add(col);
    }
    return [...set].filter((n) => n !== "row_id");
  }, [visibleCols, plots]);

  const sql = useMemo(() => {
    if (!dataset || queryCols.length === 0) return "";
    return buildAnalyzeSql({
      leftTable: dataset.table_name,
      requested: queryCols,
      join,
      columnRefs,
      filterColumn: applied?.column,
      filterOp: applied?.op,
      filterValue: applied?.value,
      limit: BROWSE_FETCH_LIMIT,
      hasRowId: hasRowIdColumn(dataset.column_schema),
    });
  }, [dataset, queryCols, join, columnRefs, applied]);

  const analyzeQuery = useQuery({
    queryKey: ["analyze", projectId, dataset?.id, sql],
    enabled: Boolean(dataset && sql),
    queryFn: async () => {
      const { rows } = await api.runProjectQuery(projectId, sql, BROWSE_FETCH_LIMIT);
      return { rows };
    },
  });

  const unmatchedSql = join ? buildJoinUnmatchedSql(join) : "";
  const unmatchedQuery = useQuery({
    queryKey: ["analyze-unmatched", projectId, unmatchedSql],
    enabled: Boolean(join && unmatchedSql),
    queryFn: async () => {
      const { rows } = await api.runProjectQuery(projectId, unmatchedSql, 1);
      const row = rows[0] ?? {};
      return {
        unmatchedLeft: Number(row.unmatched_left ?? 0),
        unmatchedRight: Number(row.unmatched_right ?? 0),
      };
    },
  });

  const savedViews = useQuery({
    queryKey: ["analysis-views", projectId],
    queryFn: () => api.listAnalysisViews(projectId),
  });

  const rows = useMemo(() => analyzeQuery.data?.rows ?? [], [analyzeQuery.data]);
  const truncated = rows.length >= BROWSE_FETCH_LIMIT;

  const workingRows = useMemo(() => {
    if (selectedRowIds.size === 0) return rows;
    return rows.filter((r, i) => selectedRowIds.has(rowKey(r, i)));
  }, [rows, selectedRowIds]);

  useEffect(() => {
    if (!dataset || rows.length === 0) return;
    setPlots((prev) => {
      const first = prev[0];
      if (!first || first.yColumn || first.kind === "histogram") return prev;
      const next = rightDataset
        ? guessJoinedPlotDefaults(
            columnRefs,
            dataset.column_schema,
            rightDataset.column_schema,
            allColNames,
            rows,
          )
        : guessPlotDefaults(dataset.column_schema, allColNames, rows);
      if (!next.yColumn) return prev;
      return [{ ...next, id: first.id }, ...prev.slice(1)];
    });
  }, [dataset, rightDataset, columnRefs, allColNames, rows]);

  const yOptions = useMemo(() => {
    if (!workingSchema.length) return [];
    return numericSelectedColumns(workingSchema, allColNames, workingRows);
  }, [workingSchema, allColNames, workingRows]);

  const kpis = useMemo(() => {
    if (!workingSchema.length) return [];
    const preferred = plots.map((p) => p.yColumn || p.xColumn);
    const selected = [...new Set([...visibleCols, ...plots.flatMap(plotSpecColumns)].filter(Boolean))];
    return analyzeKpis(workingSchema, selected, workingRows, preferred);
  }, [workingSchema, visibleCols, workingRows, plots]);

  const label = useMemo(() => makeLabeller(workingSchema), [workingSchema]);

  const plotResults = useMemo(
    () => plots.map((plot) => ({ plot, result: buildAnalyzePlot(plot, workingRows, label) })),
    [plots, workingRows, label],
  );

  const filterLabel = [
    join ? `join ${dataset?.display_name} + ${rightDataset?.display_name}` : null,
    applied ? `${applied.column} ${applied.op} ${applied.value}` : null,
  ]
    .filter(Boolean)
    .join(" - ");

  const currentSpec = () => {
    if (!dataset) throw new Error("Pick a table first");
    return buildAnalyzeViewSpec({
      leftTable: dataset.table_name,
      join,
      visibleCols,
      filter: applied,
      plots,
    });
  };

  const exportMutation = useMutation({
    mutationFn: async (format: DashboardExportFormat) => {
      if (!dataset) throw new Error("Pick a table first");
      if (workingRows.length === 0) throw new Error("No rows to export");
      const columns = visibleCols.length > 0 ? visibleCols : allColNames;
      if (columns.length === 0) throw new Error("Select at least one column");
      const results = plotResults.map((p) => p.result).filter((r) => r !== null);
      const spec = analyzeToDashboardSpec({ kpis, results });
      const charts = await captureCharts(plotsRef.current);
      const label = rightDataset
        ? `${dataset.display_name}-${rightDataset.display_name}-analyze`
        : `${dataset.display_name}-analyze`;
      const filename = await exportDashboard({
        projectId,
        projectCode,
        datasetName: rightDataset
          ? `${dataset.display_name} + ${rightDataset.display_name}`
          : dataset.display_name,
        columns,
        rows: workingRows.map((r) => {
          const o: Record<string, unknown> = {};
          for (const c of columns) o[c] = r[c];
          return o;
        }),
        spec,
        charts,
        chartTables: results.map(plotResultToChartTable),
        filterLabel: filterLabel || null,
        selectedOnly: selectedRowIds.size > 0,
        format,
        exportLabel: label,
      });
      return { filename, format, charts: charts.length };
    },
    onSuccess: ({ format, charts }) => {
      toast.success(
        `Analysis exported as ${format.toUpperCase()}${charts ? ` with ${charts} chart(s)` : ""}`,
      );
      qc.invalidateQueries({ queryKey: ["exports", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Export failed"),
  });

  const saveView = useMutation({
    mutationFn: async () => {
      const name = saveName.trim();
      if (!name) throw new Error("Name is required");
      return api.insertAnalysisView(projectId, name, currentSpec());
    },
    onSuccess: ({ id }) => {
      toast.success("Analysis saved");
      setLoadedViewId(id);
      setSaveOpen(false);
      qc.invalidateQueries({ queryKey: ["analysis-views", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  const deleteView = useMutation({
    mutationFn: async (id: string) => api.deleteAnalysisView(projectId, id),
    onSuccess: () => {
      toast.success("Analysis deleted");
      setLoadedViewId(null);
      qc.invalidateQueries({ queryKey: ["analysis-views", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  const applyJoinTo = (left: Dataset, right: Dataset) => {
    const keys = guessJoinColumns(left.column_schema, right.column_schema);
    const refs = planJoinColumns(
      left.column_schema.map((c) => c.name),
      right.column_schema.map((c) => c.name),
    );
    const visible = defaultJoinVisibleColumns(refs, left.column_schema, right.column_schema);
    setJoinEnabled(true);
    setRightTable(right.table_name);
    setLeftJoinCol(keys.leftColumn);
    setRightJoinCol(keys.rightColumn);
    setVisibleCols(visible);
    setFilterColumn(keys.leftColumn);
    setApplied(null);
    setSelectedRowIds(new Set());
    setPlots([guessJoinedPlotDefaults(refs, left.column_schema, right.column_schema, visible)]);
  };

  const loadView = (id: string) => {
    const row = savedViews.data?.find((v) => v.id === id);
    if (!row) return;
    try {
      const spec = parseAnalyzeViewSpec(row.spec);
      const left = datasets.find((d) => d.table_name === spec.leftTable);
      if (!left) throw new Error(`Table ${spec.leftTable} is not in this project`);
      const right = spec.join
        ? datasets.find((d) => d.table_name === spec.join!.rightTable)
        : null;
      if (spec.join && !right) throw new Error(`Join table ${spec.join.rightTable} is missing`);
      skipTableReset.current = spec.leftTable !== tableName;
      setTableName(spec.leftTable);
      setLoadedViewId(id);
      if (spec.join && right) {
        setJoinEnabled(true);
        setRightTable(spec.join.rightTable);
        setLeftJoinCol(spec.join.leftColumn);
        setRightJoinCol(spec.join.rightColumn);
      } else {
        setJoinEnabled(false);
        setRightTable("");
        setLeftJoinCol("");
        setRightJoinCol("");
      }
      setVisibleCols(spec.visibleCols);
      setApplied(spec.filter);
      setFilterColumn(spec.filter?.column || guessIdColumn(left.column_schema));
      setFilterOp(spec.filter?.op ?? "in");
      setFilterValue(spec.filter?.value ?? "");
      setSelectedRowIds(new Set());
      setPlots(spec.plots);
      toast.success(`Loaded ${row.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load analysis");
    }
  };

  if (datasets.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-10 text-center text-sm text-muted-foreground">
        Upload a dataset first, then build plots here by choosing a table, columns, and rows.
      </div>
    );
  }

  const toggleCol = (name: string, on: boolean) => {
    setVisibleCols((prev) => {
      if (on) return prev.includes(name) ? prev : [...prev, name];
      return prev.filter((c) => c !== name);
    });
  };

  const applyFilter = () => {
    if (!filterColumn) {
      toast.error("Pick a filter column");
      return;
    }
    if (!filterValue.trim()) {
      toast.error(filterOp === "in" ? "Enter values like BL, AC" : "Enter a filter value");
      return;
    }
    setApplied({ column: filterColumn, op: filterOp, value: filterValue.trim() });
    setSelectedRowIds(new Set());
  };

  const clearFilter = () => {
    setFilterValue("");
    setApplied(null);
    setSelectedRowIds(new Set());
  };

  const addPlot = () => {
    if (!dataset || plots.length >= ANALYZE_MAX_PLOTS) return;
    setPlots((prev) => [
      ...prev,
      suggestNextPlot(workingSchema, allColNames, workingRows, prev),
    ]);
  };

  const otherTables = datasets.filter((d) => d.table_name !== dataset?.table_name);
  const unmatchedLeft = unmatchedQuery.data?.unmatchedLeft ?? 0;
  const unmatchedRight = unmatchedQuery.data?.unmatchedRight ?? 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3">
        <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-card">
          <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-bold text-foreground">
            <Table2 className="h-3.5 w-3.5 text-primary" /> Tables
          </div>
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              placeholder="Search tables..."
              className="h-8 pl-8 text-xs"
            />
          </div>
          <div className="max-h-[220px] space-y-0.5 overflow-auto">
            {filteredTables.length === 0 ? (
              <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                No tables match
              </div>
            ) : (
              filteredTables.map((d) => {
                const active = d.table_name === dataset?.table_name;
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setTableName(d.table_name)}
                    className={`w-full rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      active
                        ? "bg-primary/10 font-semibold text-primary"
                        : "text-foreground hover:bg-secondary/70"
                    }`}
                  >
                    <div className="truncate">{d.display_name}</div>
                    <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">
                      {d.row_count === null ? "live" : `${d.row_count.toLocaleString()} rows`} -{" "}
                      {d.column_schema.length} cols
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {dataset && (
          <>
            <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-card">
              <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-bold text-foreground">
                <Link2 className="h-3.5 w-3.5" /> Join
              </div>
              {otherTables.length === 0 ? (
                <p className="px-1 text-[11px] text-muted-foreground">
                  Import a second table to join on Mix ID or Specimen ID.
                </p>
              ) : (
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-[11px] font-medium">
                    <Checkbox
                      checked={joinEnabled}
                      onCheckedChange={(v) => {
                        if (!v) {
                          setJoinEnabled(false);
                          setRightTable("");
                          const cols = defaultAnalyzeColumns(dataset.column_schema);
                          setVisibleCols(cols);
                          setFilterColumn(guessIdColumn(dataset.column_schema));
                          setPlots([guessPlotDefaults(dataset.column_schema, cols)]);
                          setApplied(null);
                          setSelectedRowIds(new Set());
                          return;
                        }
                        const other = otherTables[0];
                        if (other) applyJoinTo(dataset, other);
                      }}
                    />
                    Inner join a second table
                  </label>
                  {joinEnabled && (
                    <>
                      <Select
                        value={rightTable}
                        onValueChange={(name) => {
                          const other = datasets.find((d) => d.table_name === name);
                          if (other) applyJoinTo(dataset, other);
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Right table" />
                        </SelectTrigger>
                        <SelectContent>
                          {otherTables.map((d) => (
                            <SelectItem key={d.id} value={d.table_name}>
                              {d.display_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="grid grid-cols-2 gap-2">
                        <Select value={leftJoinCol} onValueChange={setLeftJoinCol}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Left key" />
                          </SelectTrigger>
                          <SelectContent>
                            {dataset.column_schema
                              .map((c) => c.name)
                              .filter((n) => n !== "row_id")
                              .map((n) => (
                                <SelectItem key={n} value={n} className="text-xs">
                                  {n}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Select value={rightJoinCol} onValueChange={setRightJoinCol}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Right key" />
                          </SelectTrigger>
                          <SelectContent>
                            {(rightDataset?.column_schema ?? [])
                              .map((c) => c.name)
                              .filter((n) => n !== "row_id")
                              .map((n) => (
                                <SelectItem key={n} value={n} className="text-xs">
                                  {n}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        ON {leftJoinCol || "?"} = {rightJoinCol || "?"}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-card">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <Label className="text-xs font-bold">Columns</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setVisibleCols([...allColNames])}
                  >
                    All
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setVisibleCols([])}
                  >
                    None
                  </Button>
                </div>
              </div>
              <div className="max-h-44 space-y-1.5 overflow-auto rounded-xl border border-border/60 bg-secondary/30 p-2">
                {allColNames.map((name) => (
                  <label
                    key={name}
                    className="flex items-center gap-1.5 text-[11px] font-medium text-foreground"
                  >
                    <Checkbox
                      checked={visibleCols.includes(name)}
                      onCheckedChange={(v) => toggleCol(name, Boolean(v))}
                    />
                    <span className="truncate" title={name}>
                      {label(name)}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-card">
              <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-bold text-foreground">
                <Filter className="h-3.5 w-3.5" /> Filter rows
              </div>
              <div className="space-y-2">
                <Select value={filterColumn} onValueChange={setFilterColumn}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Column" />
                  </SelectTrigger>
                  <SelectContent>
                    {allColNames.map((n) => (
                      <SelectItem key={n} value={n} className="text-xs">
                        {label(n)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={filterOp} onValueChange={(v) => setFilterOp(v as BrowseFilterOp)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in">in list</SelectItem>
                    <SelectItem value="equals">equals</SelectItem>
                    <SelectItem value="contains">contains</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  className="h-8 font-mono text-xs"
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  placeholder={filterOp === "in" ? "BL, AC" : "value"}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyFilter();
                  }}
                />
                <div className="flex gap-2">
                  <Button size="sm" className="h-8 flex-1" onClick={applyFilter}>
                    Apply
                  </Button>
                  {applied && (
                    <Button size="sm" variant="ghost" className="h-8 gap-1" onClick={clearFilter}>
                      <X className="h-3.5 w-3.5" /> Clear
                    </Button>
                  )}
                </div>
                {applied && (
                  <p className="text-[11px] text-muted-foreground">
                    Active:{" "}
                    <span className="text-foreground">
                      {label(applied.column)} {applied.op} {applied.value}
                    </span>
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="min-w-0 space-y-4">
        {dataset && (
          <>
            <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <LineChart className="mt-0.5 h-4 w-4 text-primary" />
                  <div>
                    <h2 className="text-sm font-bold text-foreground">
                      {rightDataset
                        ? `${dataset.display_name} + ${rightDataset.display_name}`
                        : dataset.display_name}
                    </h2>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {join
                        ? `Inner join on ${leftJoinCol} = ${rightJoinCol}. Unmatched Mix IDs are dropped and counted below.`
                        : "Working set for plots: choose columns and filters on the left. Empty numeric cells stay missing."}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {savedViews.data && savedViews.data.length > 0 && (
                    <Select value={loadedViewId ?? undefined} onValueChange={loadView}>
                      <SelectTrigger className="h-8 w-44 text-xs">
                        <SelectValue placeholder="Load analysis..." />
                      </SelectTrigger>
                      <SelectContent>
                        {savedViews.data.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {loadedViewId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => deleteView.mutate(loadedViewId)}
                      aria-label="Delete saved analysis"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    onClick={() => {
                      const fallback = join
                        ? `${dataset.display_name} vs ${rightDataset?.display_name ?? "join"}`
                        : dataset.display_name;
                      setSaveName(
                        savedViews.data?.find((v) => v.id === loadedViewId)?.name ?? fallback,
                      );
                      setSaveOpen(true);
                    }}
                  >
                    <Save className="h-3.5 w-3.5" /> Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    onClick={addPlot}
                    disabled={plots.length >= ANALYZE_MAX_PLOTS}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add plot
                    <span className="text-[10px] text-muted-foreground">
                      {plots.length}/{ANALYZE_MAX_PLOTS}
                    </span>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        className="h-8 gap-1.5"
                        disabled={
                          exportMutation.isPending ||
                          workingRows.length === 0 ||
                          (visibleCols.length === 0 && allColNames.length === 0)
                        }
                      >
                        {exportMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        Export
                        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                        {workingRows.length.toLocaleString()} rows - {plots.length} plot
                        {plots.length === 1 ? "" : "s"}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="flex flex-col items-start gap-0.5"
                        onClick={() => exportMutation.mutate("pdf")}
                      >
                        <span className="text-xs font-semibold">Analysis PDF</span>
                        <span className="text-[10px] text-muted-foreground">
                          Stats, charts and data table
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="flex flex-col items-start gap-0.5"
                        onClick={() => exportMutation.mutate("xlsx")}
                      >
                        <span className="text-xs font-semibold">Analysis Excel</span>
                        <span className="text-[10px] text-muted-foreground">
                          Summary, data and chart sheets
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>

            {join && (unmatchedLeft > 0 || unmatchedRight > 0) && (
              <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-[11px] text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
                Inner join dropped {unmatchedLeft.toLocaleString()} unmatched left row
                {unmatchedLeft === 1 ? "" : "s"} and {unmatchedRight.toLocaleString()} unmatched
                right row{unmatchedRight === 1 ? "" : "s"}.
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>
                {analyzeQuery.isFetching ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                  </span>
                ) : (
                  <>
                    {workingRows.length.toLocaleString()} row
                    {workingRows.length === 1 ? "" : "s"}
                    {selectedRowIds.size > 0 ? " selected" : ""}
                    {truncated ? ` (capped at ${BROWSE_FETCH_LIMIT.toLocaleString()})` : ""}
                    {" - "}
                    {visibleCols.length} column{visibleCols.length === 1 ? "" : "s"} in table
                  </>
                )}
              </span>
              {selectedRowIds.size > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => setSelectedRowIds(new Set())}
                >
                  Use all filtered rows
                </Button>
              )}
            </div>

            {analyzeQuery.isError ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                {analyzeQuery.error instanceof Error
                  ? analyzeQuery.error.message
                  : "Failed to load rows"}
              </div>
            ) : (
              <>
                {kpis.length > 0 && (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {kpis.map((kpi) => (
                      <div
                        key={kpi.column}
                        className="rounded-2xl border border-border/70 bg-card p-4 shadow-card"
                      >
                        <div
                          className="truncate text-[11px] font-semibold text-muted-foreground"
                          title={kpi.column}
                        >
                          {label(kpi.column)}
                        </div>
                        <div className="mt-1 text-xl font-bold text-foreground">
                          {formatKpiValue(kpi.mean)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">average</div>
                        <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
                          <span>min {formatKpiValue(kpi.min)}</span>
                          <span>max {formatKpiValue(kpi.max)}</span>
                          <span>median {formatKpiValue(kpi.median)}</span>
                          <span>
                            {kpi.count.toLocaleString()} values
                            {kpi.missing > 0 ? `, ${kpi.missing.toLocaleString()} blank` : ""}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div ref={plotsRef} className="grid gap-4 xl:grid-cols-2">
                  {plotResults.map(({ plot, result }) => (
                    <div
                      key={plot.id}
                      className={`min-w-0 ${plots.length === 1 ? "xl:col-span-2" : ""}`}
                    >
                      <AnalyzePlotCard
                        spec={plot}
                        onChange={(next) =>
                          setPlots((prev) => prev.map((p) => (p.id === plot.id ? next : p)))
                        }
                        onRemove={() => setPlots((prev) => prev.filter((p) => p.id !== plot.id))}
                        canRemove={plots.length > 1}
                        xOptions={allColNames}
                        yOptions={yOptions}
                        result={result}
                        label={label}
                      />
                    </div>
                  ))}
                </div>

                <div>
                  <h3 className="mb-2 text-xs font-bold text-foreground">Working set</h3>
                  <ResultsTable
                    columns={visibleCols}
                    rows={rows}
                    emptyLabel={
                      visibleCols.length === 0
                        ? "Select at least one column to preview rows"
                        : applied
                          ? "No rows match this filter"
                          : join
                            ? "No rows matched this inner join"
                            : "No rows in this table"
                    }
                    selectable
                    selectedRowIds={selectedRowIds}
                    onToggleRow={(id, checked) => {
                      setSelectedRowIds((prev) => {
                        const next = new Set(prev);
                        if (checked) next.add(id);
                        else next.delete(id);
                        return next;
                      });
                    }}
                    onToggleAllVisible={(ids, checked) => {
                      setSelectedRowIds((prev) => {
                        const next = new Set(prev);
                        for (const id of ids) {
                          if (checked) next.add(id);
                          else next.delete(id);
                        }
                        return next;
                      });
                    }}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save analysis</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="aname" className="text-xs">
              Name
            </Label>
            <Input
              id="aname"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="DCT Gf vs I-FIT FI"
              onKeyDown={(e) => {
                if (e.key === "Enter") saveView.mutate();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => saveView.mutate()} disabled={saveView.isPending}>
              {saveView.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
