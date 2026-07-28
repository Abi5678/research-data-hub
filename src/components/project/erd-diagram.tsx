import type { ProjectTemplate, TemplateTable } from "@/lib/templates";
import { KeyRound, Link2 } from "lucide-react";

type Props = {
  template: ProjectTemplate;
  bindings?: Record<string, string>; // template table key -> dataset uuid
};

const COLS: Record<1 | 2 | 3 | 4, string> = {
  1: "Sections",
  2: "Specimens",
  3: "Test Results",
  4: "Registry",
};

/**
 * Lightweight ERD: a 4-column layout by step, with FK edges drawn
 * as an SVG overlay behind the cards.
 */
export function ErdDiagram({ template, bindings }: Props) {
  const groups: Record<1 | 2 | 3 | 4, TemplateTable[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const t of template.tables) groups[t.step].push(t);

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-foreground">Schema diagram</h3>
          <p className="text-[11px] text-muted-foreground">
            {template.name} · {template.tables.length} tables
          </p>
        </div>
        <div className="hidden gap-3 text-[10px] text-muted-foreground sm:flex">
          <span className="inline-flex items-center gap-1">
            <KeyRound className="h-3 w-3 text-primary" /> primary key
          </span>
          <span className="inline-flex items-center gap-1">
            <Link2 className="h-3 w-3 text-primary" /> foreign key
          </span>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        {([1, 2, 3, 4] as const).map((step) => (
          <div key={step} className="space-y-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {COLS[step]}
            </div>
            {groups[step].map((t) => (
              <TableCard
                key={t.key}
                table={t}
                bound={Boolean(bindings?.[t.key])}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function TableCard({ table, bound }: { table: TemplateTable; bound: boolean }) {
  return (
    <div
      className={`overflow-hidden rounded-xl border shadow-card ${
        bound
          ? "border-primary/40 bg-gradient-primary-soft"
          : "border-dashed border-border bg-secondary/40"
      }`}
    >
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <div className="truncate text-[11px] font-bold text-foreground">
          {table.display_name}
        </div>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
            bound ? "bg-primary text-white" : "bg-secondary text-muted-foreground"
          }`}
        >
          {bound ? "loaded" : "empty"}
        </span>
      </div>
      <ul className="divide-y divide-border/50 text-[10px]">
        {table.columns.slice(0, 6).map((c) => {
          const isFk = table.fks?.some((f) => f.column === c.name);
          return (
            <li
              key={c.name}
              className="flex items-center justify-between gap-2 px-3 py-1"
            >
              <span className="flex items-center gap-1 truncate font-mono text-foreground">
                {c.pk && <KeyRound className="h-2.5 w-2.5 text-primary" />}
                {isFk && !c.pk && <Link2 className="h-2.5 w-2.5 text-primary" />}
                {c.name}
              </span>
              <span className="text-muted-foreground">{c.type.replace("double precision", "real")}</span>
            </li>
          );
        })}
        {table.columns.length > 6 && (
          <li className="px-3 py-1 text-center text-[9px] text-muted-foreground">
            +{table.columns.length - 6} more
          </li>
        )}
      </ul>
      {table.fks && table.fks.length > 0 && (
        <div className="border-t border-border/60 bg-secondary/40 px-3 py-1 text-[9px] text-muted-foreground">
          → {table.fks.map((f) => `${f.column} → ${f.references.table}.${f.references.column}`).join(", ")}
        </div>
      )}
    </div>
  );
}
