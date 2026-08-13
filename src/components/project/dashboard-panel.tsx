import { forwardRef } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartSpec, DashboardSpec } from "@/lib/dashboard-spec";
import { formatKpiValue } from "@/lib/dashboard-spec";

// Charts are rasterized for PDF/Excel export, so every color has to be an
// inline hex value: CSS variables do not survive SVG serialization.
const CHART_COLORS = ["#1e40af", "#0ea5e9", "#f59e0b", "#10b981"];
const AXIS_COLOR = "#64748b";
const GRID_COLOR = "#e2e8f0";

const CHART_HEIGHT = 260;

export type DashboardMeta = {
  datasetName: string;
  rowCount: number;
  columnCount: number;
  filterLabel: string | null;
  selectedOnly: boolean;
};

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

function ChartCard({ chart, color }: { chart: ChartSpec; color: string }) {
  return (
    <div
      className="rounded-2xl border border-border/70 bg-card p-4 shadow-card"
      data-chart-id={chart.id}
      data-chart-title={chart.title}
    >
      <div className="mb-2 text-xs font-bold text-foreground">{chart.title}</div>
      <div style={{ width: "100%", height: CHART_HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%">
          {chart.kind === "line" ? (
            <LineChart data={chart.data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickFormatter={shortLabel} {...axisProps(true)} />
              <YAxis {...axisProps(false)} width={56} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                dot={chart.data.length <= 40}
                isAnimationActive={false}
              />
            </LineChart>
          ) : chart.kind === "bar" ? (
            <BarChart data={chart.data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tickFormatter={shortLabel} {...axisProps(true)} />
              <YAxis {...axisProps(false)} width={56} />
              <Tooltip />
              <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          ) : (
            <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" name={chart.xColumn} {...axisProps(false)} />
              <YAxis
                type="number"
                dataKey="y"
                name={chart.yColumn}
                width={56}
                {...axisProps(false)}
              />
              <Tooltip cursor={{ strokeDasharray: "3 3" }} />
              <Scatter data={chart.data} fill={color} isAnimationActive={false} />
            </ScatterChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export const DashboardPanel = forwardRef<
  HTMLDivElement,
  {
    spec: DashboardSpec;
    meta: DashboardMeta;
  }
>(function DashboardPanel({ spec, meta }, ref) {
  const empty = spec.kpis.length === 0 && spec.charts.length === 0;

  return (
    <div ref={ref} className="space-y-4">
      <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-card">
        <h3 className="text-sm font-bold text-foreground">{meta.datasetName} dashboard</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {meta.rowCount.toLocaleString()} {meta.selectedOnly ? "selected" : "filtered"} row
          {meta.rowCount === 1 ? "" : "s"} - {meta.columnCount} column
          {meta.columnCount === 1 ? "" : "s"}
          {meta.filterLabel ? ` - filter: ${meta.filterLabel}` : ""}
        </p>
      </div>

      {empty ? (
        <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-10 text-center text-sm text-muted-foreground">
          Nothing to chart yet. Pick at least one numeric, date, or low-cardinality text column.
        </div>
      ) : (
        <>
          {spec.kpis.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {spec.kpis.map((kpi) => (
                <div
                  key={kpi.column}
                  className="rounded-2xl border border-border/70 bg-card p-4 shadow-card"
                >
                  <div className="truncate font-mono text-[11px] font-semibold text-muted-foreground">
                    {kpi.column}
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

          {spec.charts.length > 0 && (
            <div className="grid gap-4 xl:grid-cols-2">
              {spec.charts.map((chart, i) => (
                <ChartCard
                  key={chart.id}
                  chart={chart}
                  color={CHART_COLORS[i % CHART_COLORS.length]!}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
});
