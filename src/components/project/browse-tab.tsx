import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ResultsTable } from "@/components/project/results-table";
import { exportRows, EXPORT_FORMATS, type ExportFormat } from "@/lib/export";
import type { ColumnSchema } from "@/lib/csv";
import {
  BROWSE_FETCH_LIMIT,
  BROWSE_PROBE_LIMIT,
  type BrowseFilterOp,
  buildBrowseSql,
  defaultVisibleColumns,
  guessIdColumn,
  hasRowIdColumn,
  rowKey,
} from "@/lib/browse-sql";
import { DashboardPanel } from "@/components/project/dashboard-panel";
import { buildDashboardSpec } from "@/lib/dashboard-spec";
import { captureCharts } from "@/lib/chart-image";
import { exportDashboard, type DashboardExportFormat } from "@/lib/export-dashboard";
import {
  BarChart3,
  ChevronDown,
  Download,
  Filter,
  LayoutGrid,
  Loader2,
  Search,
  Table2,
  X,
} from "lucide-react";
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
  row_count: number | null;
  column_schema: ColumnSchema[];
};

export function BrowseTab({
  projectId,
  projectCode,
  datasets,
}: {
  projectId: string;
  projectCode: string;
  datasets: Dataset[];
}) {
  const qc = useQueryClient();
  const [tableName, setTableName] = useState(datasets[0]?.table_name ?? "");
  const dataset = datasets.find((d) => d.table_name === tableName) ?? datasets[0] ?? null;

  useEffect(() => {
    if (!datasets.length) return;
    if (!tableName || !datasets.some((d) => d.table_name === tableName)) {
      setTableName(datasets[0]!.table_name);
    }
  }, [datasets, tableName]);

  const [visibleCols, setVisibleCols] = useState<string[]>([]);
  const [showAllCols, setShowAllCols] = useState(false);

  const [filterColumn, setFilterColumn] = useState("");
  const [filterOp, setFilterOp] = useState<BrowseFilterOp>("in");
  const [filterValue, setFilterValue] = useState("");
  const [applied, setApplied] = useState<{
    column: string;
    op: BrowseFilterOp;
    value: string;
  } | null>(null);

  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"grid" | "dashboard">("grid");
  const [tableSearch, setTableSearch] = useState("");
  const dashboardRef = useRef<HTMLDivElement>(null);

  // Reset column / filter state when table changes.
  useEffect(() => {
    if (!dataset) return;
    setVisibleCols(defaultVisibleColumns(dataset.column_schema));
    setShowAllCols(dataset.column_schema.length <= 12);
    setFilterColumn(guessIdColumn(dataset.column_schema));
    setFilterOp("in");
    setFilterValue("");
    setApplied(null);
    setSelectedRowIds(new Set());
  }, [dataset?.id]);

  const allColNames = useMemo(
    () => (dataset?.column_schema ?? []).map((c) => c.name).filter((n) => n !== "row_id"),
    [dataset],
  );

  const columnsForPicker = showAllCols ? allColNames : allColNames.slice(0, 12);

  const filteredTables = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    if (!q) return datasets;
    return datasets.filter(
      (d) => d.display_name.toLowerCase().includes(q) || d.table_name.toLowerCase().includes(q),
    );
  }, [datasets, tableSearch]);

  const sql = useMemo(() => {
    if (!dataset || visibleCols.length === 0) return "";
    return buildBrowseSql({
      tableName: dataset.table_name,
      columns: visibleCols,
      filterColumn: applied?.column,
      filterOp: applied?.op,
      filterValue: applied?.value,
      limit: BROWSE_PROBE_LIMIT,
      hasRowId: hasRowIdColumn(dataset.column_schema),
    });
  }, [dataset, visibleCols, applied]);

  const browseQuery = useQuery({
    queryKey: ["browse", projectId, dataset?.id, sql],
    enabled: Boolean(dataset && sql),
    queryFn: async () => {
      const { rows } = await api.runProjectQuery(projectId, sql, BROWSE_PROBE_LIMIT);
      // The extra probe row is proof there is more, not something to show.
      const capped = rows.length > BROWSE_FETCH_LIMIT;
      return {
        rows: capped ? rows.slice(0, BROWSE_FETCH_LIMIT) : rows,
        truncated: capped,
        columns: visibleCols,
      };
    },
  });

  // Stable identity keeps the dashboard from recomputing on every render.
  const rows = useMemo(() => browseQuery.data?.rows ?? [], [browseQuery.data]);
  const truncated = browseQuery.data?.truncated ?? false;

  // Rows that feed exports and the dashboard: checked rows win over the full filtered set.
  const exportRowsData = useMemo(() => {
    const out =
      selectedRowIds.size > 0 ? rows.filter((r, i) => selectedRowIds.has(rowKey(r, i))) : rows;
    return out.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of visibleCols) o[c] = r[c];
      return o;
    });
  }, [rows, selectedRowIds, visibleCols]);

  const filterLabel = applied ? `${applied.column} ${applied.op} ${applied.value}` : null;

  const dashboardSpec = useMemo(() => {
    if (view !== "dashboard" || !dataset) return null;
    return buildDashboardSpec({
      columns: dataset.column_schema,
      selectedColumns: visibleCols,
      rows: exportRowsData,
    });
  }, [view, dataset, visibleCols, exportRowsData]);

  const exportMutation = useMutation({
    mutationFn: async (format: ExportFormat) => {
      if (!dataset || visibleCols.length === 0) throw new Error("Select at least one column");
      const projected = exportRowsData;
      if (projected.length === 0) throw new Error("No rows to export");
      const filename = await exportRows({
        projectId,
        projectCode,
        rows: projected,
        columns: visibleCols,
        label: `${dataset.display_name}-browse`,
        format,
      });
      return { filename, format, count: projected.length, selected: selectedRowIds.size > 0 };
    },
    onSuccess: ({ format, count, selected }) => {
      const msg = `Exported ${count.toLocaleString()} ${selected ? "selected " : ""}row(s) as ${format.toUpperCase()}`;
      // Browse only ever holds the first page; never call a clipped one complete.
      if (truncated && !selected) {
        toast.warning(
          `${msg} — the table has more than ${BROWSE_FETCH_LIMIT.toLocaleString()} matching rows; filter, or use the Query tab to export the rest`,
        );
      } else {
        toast.success(msg);
      }
      qc.invalidateQueries({ queryKey: ["exports", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Export failed"),
  });

  const dashboardExport = useMutation({
    mutationFn: async (format: DashboardExportFormat) => {
      if (!dataset || !dashboardSpec) throw new Error("Switch to the dashboard view first");
      if (exportRowsData.length === 0) throw new Error("No rows to export");
      const charts = await captureCharts(dashboardRef.current);
      const filename = await exportDashboard({
        projectId,
        projectCode,
        datasetName: dataset.display_name,
        columns: visibleCols,
        rows: exportRowsData,
        spec: dashboardSpec,
        charts,
        filterLabel,
        selectedOnly: selectedRowIds.size > 0,
        format,
      });
      return { filename, format, charts: charts.length };
    },
    onSuccess: ({ format, charts }) => {
      toast.success(
        `Dashboard exported as ${format.toUpperCase()}${charts ? ` with ${charts} chart(s)` : ""}`,
      );
      qc.invalidateQueries({ queryKey: ["exports", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Dashboard export failed"),
  });

  if (datasets.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-10 text-center text-sm text-muted-foreground">
        Upload a dataset first, then browse columns and rows here.
      </div>
    );
  }

  const toggleCol = (name: string, on: boolean) => {
    setVisibleCols((prev) => {
      if (on) return prev.includes(name) ? prev : [...prev, name];
      return prev.filter((c) => c !== name);
    });
    setSelectedRowIds(new Set());
  };

  const applyFilter = () => {
    if (!filterColumn) {
      toast.error("Pick a filter column");
      return;
    }
    if (!filterValue.trim()) {
      toast.error(filterOp === "in" ? "Enter values like 6001, 6002" : "Enter a filter value");
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

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      {/* Table list */}
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
        <div className="max-h-[520px] space-y-0.5 overflow-auto">
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
                    {/* A combined view has no stored count; counting one here
                        would re-run its joins for every dataset in the list. */}
                    {d.row_count === null ? "live" : `${d.row_count.toLocaleString()} rows`} -{" "}
                    {d.column_schema.length} cols
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Main panel */}
      <div className="space-y-4">
        {dataset && (
          <>
            <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-foreground">{dataset.display_name}</h2>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Pick columns, filter rows (e.g. IDs{" "}
                    <span className="font-mono">6001, 6002</span>
                    ), optionally check rows, then export - no SQL.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-lg border border-border/70 bg-secondary/40 p-0.5">
                    <button
                      type="button"
                      onClick={() => setView("grid")}
                      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                        view === "grid"
                          ? "bg-card text-primary shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <LayoutGrid className="h-3.5 w-3.5" /> Grid
                    </button>
                    <button
                      type="button"
                      onClick={() => setView("dashboard")}
                      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                        view === "dashboard"
                          ? "bg-card text-primary shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <BarChart3 className="h-3.5 w-3.5" /> Dashboard
                    </button>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={
                          exportMutation.isPending ||
                          dashboardExport.isPending ||
                          rows.length === 0 ||
                          visibleCols.length === 0
                        }
                      >
                        {exportMutation.isPending || dashboardExport.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        Export
                        {selectedRowIds.size > 0
                          ? ` (${selectedRowIds.size})`
                          : ` (${rows.length.toLocaleString()})`}
                        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                        {selectedRowIds.size > 0
                          ? `${selectedRowIds.size} checked rows - ${visibleCols.length} columns`
                          : `${rows.length.toLocaleString()} filtered rows - ${visibleCols.length} columns`}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {view === "dashboard" && (
                        <>
                          <DropdownMenuItem
                            className="flex flex-col items-start gap-0.5"
                            onClick={() => dashboardExport.mutate("pdf")}
                          >
                            <span className="text-xs font-semibold">Dashboard PDF</span>
                            <span className="text-[10px] text-muted-foreground">
                              Stats, charts and data table
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="flex flex-col items-start gap-0.5"
                            onClick={() => dashboardExport.mutate("xlsx")}
                          >
                            <span className="text-xs font-semibold">Dashboard Excel</span>
                            <span className="text-[10px] text-muted-foreground">
                              Summary, data and chart sheets
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                            Data only
                          </DropdownMenuLabel>
                        </>
                      )}
                      {EXPORT_FORMATS.map((f) => (
                        <DropdownMenuItem
                          key={f.id}
                          className="flex flex-col items-start gap-0.5"
                          onClick={() => exportMutation.mutate(f.id)}
                        >
                          <span className="text-xs font-semibold">{f.label}</span>
                          <span className="text-[10px] text-muted-foreground">{f.hint}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Columns */}
              <div className="mt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <Label className="text-xs font-semibold">Columns</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => {
                        setVisibleCols([...allColNames]);
                        setShowAllCols(true);
                      }}
                    >
                      Select all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setVisibleCols([])}
                    >
                      None
                    </Button>
                  </div>
                </div>
                <div className="flex max-h-36 flex-wrap gap-x-3 gap-y-2 overflow-auto rounded-xl border border-border/60 bg-secondary/30 p-3">
                  {columnsForPicker.map((name) => (
                    <label
                      key={name}
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium text-foreground"
                    >
                      <Checkbox
                        checked={visibleCols.includes(name)}
                        onCheckedChange={(v) => toggleCol(name, Boolean(v))}
                      />
                      <span className="font-mono">{name}</span>
                    </label>
                  ))}
                </div>
                {!showAllCols && allColNames.length > 12 && (
                  <Button
                    type="button"
                    variant="link"
                    className="mt-1 h-auto p-0 text-[11px]"
                    onClick={() => setShowAllCols(true)}
                  >
                    Show all {allColNames.length} columns...
                  </Button>
                )}
              </div>

              {/* Filter */}
              <div className="mt-4 rounded-xl border border-border/60 bg-secondary/20 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Filter className="h-3.5 w-3.5" /> Filter rows
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Column</Label>
                    <Select value={filterColumn} onValueChange={setFilterColumn}>
                      <SelectTrigger className="h-8 w-44 text-xs">
                        <SelectValue placeholder="Column" />
                      </SelectTrigger>
                      <SelectContent>
                        {allColNames.map((n) => (
                          <SelectItem key={n} value={n} className="font-mono text-xs">
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Match</Label>
                    <Select
                      value={filterOp}
                      onValueChange={(v) => setFilterOp(v as BrowseFilterOp)}
                    >
                      <SelectTrigger className="h-8 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="in">in list</SelectItem>
                        <SelectItem value="equals">equals</SelectItem>
                        <SelectItem value="contains">contains</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-[180px] flex-1 space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Value</Label>
                    <Input
                      className="h-8 font-mono text-xs"
                      value={filterValue}
                      onChange={(e) => setFilterValue(e.target.value)}
                      placeholder={filterOp === "in" ? "6001, 6002" : "value"}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") applyFilter();
                      }}
                    />
                  </div>
                  <Button size="sm" className="h-8" onClick={applyFilter}>
                    Apply
                  </Button>
                  {applied && (
                    <Button size="sm" variant="ghost" className="h-8 gap-1" onClick={clearFilter}>
                      <X className="h-3.5 w-3.5" /> Clear
                    </Button>
                  )}
                </div>
                {applied && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Active:{" "}
                    <span className="font-mono text-foreground">
                      {applied.column} {applied.op} {applied.value}
                    </span>
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>
                {browseQuery.isFetching ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                  </span>
                ) : (
                  <>
                    {rows.length.toLocaleString()} row
                    {rows.length === 1 ? "" : "s"}
                    {truncated ? ` (capped at ${BROWSE_FETCH_LIMIT.toLocaleString()})` : ""}
                    {selectedRowIds.size > 0 ? ` - ${selectedRowIds.size} checked` : ""}
                    {" - "}
                    {visibleCols.length} column{visibleCols.length === 1 ? "" : "s"}
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
                  Clear selection
                </Button>
              )}
            </div>

            {browseQuery.isError ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                {browseQuery.error instanceof Error
                  ? browseQuery.error.message
                  : "Failed to load rows"}
              </div>
            ) : view === "dashboard" ? (
              dashboardSpec && (
                <DashboardPanel
                  ref={dashboardRef}
                  spec={dashboardSpec}
                  meta={{
                    datasetName: dataset.display_name,
                    rowCount: exportRowsData.length,
                    columnCount: visibleCols.length,
                    filterLabel,
                    selectedOnly: selectedRowIds.size > 0,
                  }}
                />
              )
            ) : (
              <ResultsTable
                columns={visibleCols}
                rows={rows}
                emptyLabel={applied ? "No rows match this filter" : "No rows in this table"}
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
            )}
          </>
        )}
      </div>
    </div>
  );
}
