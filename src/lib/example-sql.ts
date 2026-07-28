import type { ExampleQuery } from "@/lib/templates";
import type { TemplateMeta } from "@/lib/templates";

/** Map template example SQL (ds_<table_key>) to real dataset table names. */
export function resolveExampleQueries(
  examples: ExampleQuery[] | undefined,
  meta: TemplateMeta | null | undefined,
  datasets: { id: string; table_name: string }[],
): ExampleQuery[] {
  if (!examples?.length) return [];
  const bindings = meta?.bindings ?? {};
  const byId = new Map(datasets.map((d) => [d.id, d.table_name]));
  const keyToTable = new Map<string, string>();
  for (const [key, datasetId] of Object.entries(bindings)) {
    const table = byId.get(datasetId);
    if (table) keyToTable.set(key, table);
  }

  return examples.map((ex) => ({
    ...ex,
    sql: ex.sql.replace(/\bds_([a-z0-9_]+)\b/gi, (_, rawKey: string) => {
      const table = keyToTable.get(rawKey);
      return table ?? `ds_${rawKey}`;
    }),
  }));
}
