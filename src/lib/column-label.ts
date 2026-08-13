import type { ColumnSchema } from "@/lib/csv";

/**
 * Datasets carry two names per column: the sanitised SQL identifier
 * (`dct_testing_results_fracture_energy_gf`) and the header as it appeared in
 * the researcher's spreadsheet (`DCT Testing Results Fracture Energy (Gf)`).
 * SQL uses the former; every label a person reads should use the latter.
 */
export function columnLabel(name: string, schema: ColumnSchema[]): string {
  const hit = schema.find((c) => c.name === name);
  const original = hit?.original_name?.trim();
  return original && original.length > 0 ? original : name;
}

/** Reusable lookup when labelling many columns at once. */
export function makeLabeller(schema: ColumnSchema[]): (name: string) => string {
  const byName = new Map<string, string>();
  for (const c of schema) {
    const original = c.original_name?.trim();
    byName.set(c.name, original && original.length > 0 ? original : c.name);
  }
  return (name: string) => byName.get(name) ?? name;
}
