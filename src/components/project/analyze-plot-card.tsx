import { useRef } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SERIES_NONE,
  analyzePlotTitle,
  chartSeriesDataKey,
  type AnalyzePlotKind,
  type AnalyzePlotResult,
  type AnalyzePlotSpec,
  type BarAggregation,
  type CategoryPlotResult,
} from "@/lib/analyze-plot";
import { svgToPngDataUrl } from "@/lib/chart-image";
import { triggerDownloadBlob } from "@/lib/export";
import { Download, X } from "lucide-react";

const CHART_COLORS = [
  "#1e40af",
  "#0ea5e9",
  "#f59e0b",
  "#10b981",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#f97316",
];
const AXIS_COLOR = "#64748b";
const GRID_COLOR = "#e2e8f0";
const CHART_HEIGHT = 280;
const BIN_CHOICES = [5, 8, 10, 12, 15, 20];

function shortLabel(v: string): string {
  return v.length > 14 ? `${v.slice(0, 13)}...` : v;
}

function axisProps(angled: boolean) {
  return {
    tick: { fill: AXIS_COLOR, fontSize: 10 },
    stroke: AXIS_COLOR,
    ...(angled ? { angle: -30, textAnchor: "end" as const, height: 60 } : {}),
  };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "plot"
  );
}

function applyKind(
  spec: AnalyzePlotSpec,
  kind: AnalyzePlotKind,
  yOptions: string[],
): AnalyzePlotSpec {
  if (kind === "histogram") {
    const x = yOptions.includes(spec.xColumn) ? spec.xColumn : (yOptions[0] ?? spec.xColumn);
    return { ...spec, kind, xColumn: x, yColumn: "", aggregation: "count" };
  }
  if (kind === "scatter") {
    const x = yOptions.includes(spec.xColumn) ? spec.xColumn : (yOptions[0] ?? spec.xColumn);
    const y =
      spec.yColumn && spec.yColumn !== x
        ? spec.yColumn
        : (yOptions.find((n) => n !== x) ?? spec.yColumn);
    return { ...spec, kind, xColumn: x, yColumn: y };
  }
  if (kind === "line") {
    return {
      ...spec,
      kind,
      aggregation: spec.aggregation === "count" && spec.yColumn ? "mean" : spec.aggregation,
    };
  }
  return { ...spec, kind };
}

function withSafeCategoryKeys(result: CategoryPlotResult): {
  data: CategoryPlotResult["data"];
  series: { key: string; dataKey: string }[];
} {
  const series = result.seriesKeys.map((key) => ({ key, dataKey: chartSeriesDataKey(key) }));
  const data = result.data.map((row) => {
    const next: CategoryPlotResult["data"][number] = { label: row.label };
    for (const { key, dataKey } of series) {
      next[dataKey] = row[key] ?? 0;
    }
    return next;
  });
  return { data, series };
}

/**
 * ResponsiveContainer measures itself and injects `width`/`height` into its
 * direct child via cloneElement. This wrapper IS that direct child, so it has
 * to forward them to the real chart — without them the chart renders nothing.
 */
function PlotGraphic({
  result,
  width,
  height,
}: {
  result: AnalyzePlotResult;
  width?: number;
  height?: number;
}) {
  const showLegend = Boolean(result.seriesColumn) && result.seriesKeys.length > 1;
  const size = { width, height };

  if (result.kind === "scatter") {
    return (
      <ScatterChart {...size} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" />
        <XAxis type="number" dataKey="x" name={result.xColumn} {...axisProps(false)} />
        <YAxis
          type="number"
          dataKey="y"
          name={result.yColumn}
          width={56}
          {...axisProps(false)}
        />
        <Tooltip cursor={{ strokeDasharray: "3 3" }} />
        {showLegend && <Legend wrapperStyle={{ fontSize: 10 }} />}
        {result.groups.map((group, i) => (
          <Scatter
            key={group.key}
            name={group.key === "value" ? result.yColumn : group.key}
            data={group.data}
            fill={CHART_COLORS[i % CHART_COLORS.length]}
            isAnimationActive={false}
          />
        ))}
      </ScatterChart>
    );
  }

  const { data, series } = withSafeCategoryKeys(result);
  const angled = result.kind !== "line";
  if (result.kind === "line") {
    return (
      <LineChart {...size} data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" />
        <XAxis dataKey="label" tickFormatter={shortLabel} {...axisProps(true)} />
        <YAxis {...axisProps(false)} width={56} />
        <Tooltip />
        {showLegend && <Legend wrapperStyle={{ fontSize: 10 }} />}
        {series.map(({ key, dataKey }, i) => (
          <Line
            key={dataKey}
            type="monotone"
            dataKey={dataKey}
            name={key === "value" ? result.yColumn ?? "value" : key}
            stroke={CHART_COLORS[i % CHART_COLORS.length]}
            strokeWidth={2}
            dot={data.length <= 40}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  }

  return (
    <BarChart {...size} data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
      <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey="label" tickFormatter={shortLabel} {...axisProps(angled)} />
      <YAxis {...axisProps(false)} width={56} />
      <Tooltip />
      {showLegend && <Legend wrapperStyle={{ fontSize: 10 }} />}
      {series.map(({ key, dataKey }, i) => (
        <Bar
          key={dataKey}
          dataKey={dataKey}
          name={key === "value" ? result.yColumn ?? "count" : key}
          fill={CHART_COLORS[i % CHART_COLORS.length]}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      ))}
    </BarChart>
  );
}

export function AnalyzePlotCard({
  spec,
  onChange,
  onRemove,
  canRemove,
  xOptions,
  yOptions,
  result,
  label = (n) => n,
}: {
  spec: AnalyzePlotSpec;
  onChange: (next: AnalyzePlotSpec) => void;
  onRemove?: () => void;
  canRemove?: boolean;
  xOptions: string[];
  yOptions: string[];
  result: AnalyzePlotResult | null;
  label?: (name: string) => string;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const yRequired = spec.kind === "scatter" || spec.kind === "line" || spec.aggregation !== "count";
  const numericX = spec.kind === "scatter" || spec.kind === "histogram";
  const xList = numericX && yOptions.length > 0 ? yOptions : xOptions;
  const seriesOptions = xOptions.filter((n) => n !== spec.xColumn && n !== spec.yColumn);
  const title = analyzePlotTitle(spec, label);

  const downloadPng = async () => {
    const svg = chartRef.current?.querySelector("svg");
    if (!svg) {
      toast.error("Nothing to capture yet");
      return;
    }
    try {
      const { dataUrl } = await svgToPngDataUrl(svg as SVGSVGElement);
      const res = await fetch(dataUrl);
      triggerDownloadBlob(`${slug(title)}.png`, await res.blob());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save PNG");
    }
  };

  return (
    <div className="min-w-0 rounded-2xl border border-border/70 bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-foreground">Plot</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Pick what to compare and what to measure. Filters on the left apply to every plot.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-[11px]"
            onClick={() => void downloadPng()}
            disabled={!result}
          >
            <Download className="h-3.5 w-3.5" /> PNG
          </Button>
          {canRemove && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={onRemove}
              aria-label="Remove plot"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">Type</Label>
          <Select
            value={spec.kind}
            onValueChange={(kind) => onChange(applyKind(spec, kind as AnalyzePlotKind, yOptions))}
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bar">Bar</SelectItem>
              <SelectItem value="line">Line</SelectItem>
              <SelectItem value="scatter">Scatter</SelectItem>
              <SelectItem value="histogram">Histogram</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            {spec.kind === "histogram"
              ? "Measure to distribute"
              : spec.kind === "bar"
                ? "Group by"
                : spec.kind === "line"
                  ? "Along"
                  : "Horizontal"}
          </Label>
          <Select
            value={spec.xColumn || undefined}
            onValueChange={(xColumn) =>
              onChange({
                ...spec,
                xColumn,
                seriesColumn: spec.seriesColumn === xColumn ? "" : spec.seriesColumn,
              })
            }
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder="Column" />
            </SelectTrigger>
            <SelectContent>
              {xList.map((n) => (
                <SelectItem key={n} value={n} className="text-xs">
                  {label(n)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {spec.kind !== "histogram" && (
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">
              {spec.kind === "bar" ? "Measure" : "Vertical"}
            </Label>
            <Select
              value={spec.yColumn || undefined}
              onValueChange={(yColumn) => onChange({ ...spec, yColumn })}
              disabled={yOptions.length === 0}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder={yRequired ? "Numeric column" : "Optional"} />
              </SelectTrigger>
              <SelectContent>
                {yOptions.map((n) => (
                  <SelectItem key={n} value={n} className="text-xs">
                    {label(n)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {(spec.kind === "bar" || spec.kind === "line") && (
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Show</Label>
            <Select
              value={spec.aggregation}
              onValueChange={(aggregation) =>
                onChange({ ...spec, aggregation: aggregation as BarAggregation })
              }
            >
              <SelectTrigger className="h-8 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mean">Average</SelectItem>
                <SelectItem value="median">Median</SelectItem>
                <SelectItem value="sum">Total</SelectItem>
                <SelectItem value="count">Count of rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {spec.kind === "histogram" && (
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Bins</Label>
            <Select
              value={String(spec.bins)}
              onValueChange={(v) => onChange({ ...spec, bins: Number(v) })}
            >
              <SelectTrigger className="h-8 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BIN_CHOICES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            {spec.kind === "scatter" ? "Colour by" : "Split by"}
          </Label>
          <Select
            value={spec.seriesColumn || SERIES_NONE}
            onValueChange={(v) => onChange({ ...spec, seriesColumn: v === SERIES_NONE ? "" : v })}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SERIES_NONE}>None</SelectItem>
              {seriesOptions.map((n) => (
                <SelectItem key={n} value={n} className="text-xs">
                  {label(n)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-3 text-xs font-bold text-foreground">{title}</div>

      {!result ? (
        <div className="mt-3 rounded-xl border border-dashed border-border bg-secondary/40 p-10 text-center text-sm text-muted-foreground">
          {spec.kind === "histogram"
            ? "Pick a numeric column for X. Empty cells are skipped, not treated as zero."
            : spec.kind === "scatter" || yRequired
              ? "Pick X and a numeric Y. Empty numeric cells are skipped, not treated as zero."
              : "Pick a category column for X."}
        </div>
      ) : (
        <>
          <div
            ref={chartRef}
            data-chart-id={spec.id}
            data-chart-title={title}
            style={{ width: "100%", height: CHART_HEIGHT }}
            className="mt-2 min-w-0 overflow-hidden"
          >
            <ResponsiveContainer width="100%" height="100%">
              <PlotGraphic result={result} />
            </ResponsiveContainer>
          </div>
          {result.truncated && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {result.kind === "scatter"
                ? `Showing ${result.data.length.toLocaleString()} of ${result.pointCount.toLocaleString()} points.`
                : result.kind === "line"
                  ? `Showing ${result.data.length.toLocaleString()} of ${result.pointCount.toLocaleString()} X values.`
                  : result.kind === "histogram"
                    ? "Some series were grouped into Other (top 8)."
                    : `Showing ${result.data.length} of ${result.pointCount} categories.`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
