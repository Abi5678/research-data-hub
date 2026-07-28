import type { ColumnKind } from "@/lib/csv";

export type TemplateColumn = {
  name: string;
  type: ColumnKind;
  pk?: boolean;
  note?: string;
};

export type TemplateTable = {
  key: string;
  display_name: string;
  description: string;
  columns: TemplateColumn[];
  /** Which columns act as foreign keys to another template table. */
  fks?: { column: string; references: { table: string; column: string } }[];
  /** Wizard step this table belongs to (1 = sections, 2 = specimens, 3 = results, 4 = extras). */
  step: 1 | 2 | 3 | 4;
};

export type ProjectTemplate = {
  key: string;
  name: string;
  tagline: string;
  description: string;
  tables: TemplateTable[];
  example_queries?: ExampleQuery[];
};

export type ExampleQuery = {
  name: string;
  description: string;
  sql: string;
};

export const ASPHALT_TEMPLATE: ProjectTemplate = {
  key: "asphalt_field_mix",
  name: "Asphalt Field Mix Research",
  tagline: "NRRA pavement research schema",
  description:
    "Pre-built schema for asphalt field mix studies. Includes test sections, specimens, IFIT, complex modulus, DTCF, field performance, binder tests, and a file registry.",
  tables: [
    {
      key: "test_sections",
      display_name: "Test Sections",
      description: "Field-built pavement sections with mix design metadata.",
      step: 1,
      columns: [
        { name: "section_id", type: "integer", pk: true, note: "PK" },
        { name: "construction_date", type: "text" },
        { name: "with_ra", type: "boolean" },
        { name: "rejuvenator_type", type: "text" },
        { name: "section_code", type: "text" },
        { name: "pg_grade", type: "text" },
        { name: "rap_content", type: "double precision" },
        { name: "ac_percent", type: "double precision" },
        { name: "nmas_mm", type: "double precision" },
        { name: "mix_description", type: "text" },
      ],
    },
    {
      key: "specimens",
      display_name: "Specimens",
      description: "Field cores / lab-compacted specimens tied to a test section.",
      step: 2,
      columns: [
        { name: "id", type: "integer", pk: true },
        { name: "section_id", type: "integer" },
        { name: "specimen_code", type: "text" },
        { name: "core_year", type: "text" },
        { name: "aging_condition", type: "text" },
        { name: "diameter_mm", type: "double precision" },
        { name: "height_mm", type: "double precision" },
        { name: "air_voids_pct", type: "double precision" },
        { name: "gmm", type: "double precision" },
        { name: "test_date", type: "text" },
      ],
      fks: [
        { column: "section_id", references: { table: "test_sections", column: "section_id" } },
      ],
    },
    {
      key: "ifit_results",
      display_name: "I-FIT Results",
      description: "Illinois Flexibility Index Test results.",
      step: 3,
      columns: [
        { name: "id", type: "integer", pk: true },
        { name: "specimen_id", type: "integer" },
        { name: "flexibility_index", type: "double precision" },
        { name: "m_value", type: "double precision" },
        { name: "peak_load_kn", type: "double precision" },
        { name: "fracture_energy_nm", type: "double precision" },
        { name: "test_temperature_c", type: "double precision" },
      ],
      fks: [{ column: "specimen_id", references: { table: "specimens", column: "id" } }],
    },
    {
      key: "complex_modulus_results",
      display_name: "Complex Modulus",
      description: "|E*| dynamic modulus and phase angle at temperature/frequency sweeps.",
      step: 3,
      columns: [
        { name: "id", type: "integer", pk: true },
        { name: "specimen_id", type: "integer" },
        { name: "temperature_c", type: "double precision" },
        { name: "frequency_hz", type: "double precision" },
        { name: "dynamic_modulus_mpa", type: "double precision" },
        { name: "phase_angle_deg", type: "double precision" },
      ],
      fks: [{ column: "specimen_id", references: { table: "specimens", column: "id" } }],
    },
    {
      key: "dtcf_results",
      display_name: "DT-CF Results",
      description: "Direct Tension Cyclic Fatigue outputs (Sapp, Dr, alpha).",
      step: 3,
      columns: [
        { name: "id", type: "integer", pk: true },
        { name: "specimen_id", type: "integer" },
        { name: "sapp", type: "double precision" },
        { name: "dr", type: "double precision" },
        { name: "alpha", type: "double precision" },
      ],
      fks: [{ column: "specimen_id", references: { table: "specimens", column: "id" } }],
    },
    {
      key: "field_performance",
      display_name: "Field Performance",
      description: "Longitudinal IRI, rutting, and texture measurements.",
      step: 3,
      columns: [
        { name: "id", type: "integer", pk: true },
        { name: "section_id", type: "integer" },
        { name: "measurement_date", type: "text" },
        { name: "iri_avg_long", type: "double precision" },
        { name: "rut_avg_long", type: "double precision" },
        { name: "tex_avg_long", type: "double precision" },
      ],
      fks: [
        { column: "section_id", references: { table: "test_sections", column: "section_id" } },
      ],
    },
    {
      key: "binder_tests",
      display_name: "Binder Tests",
      description: "Recovered binder rheology (Glover-Rowe, delta Tc, G*).",
      step: 3,
      columns: [
        { name: "id", type: "integer", pk: true },
        { name: "section_id", type: "integer" },
        { name: "sample_id", type: "text" },
        { name: "aging_condition", type: "text" },
        { name: "binder_source", type: "text" },
        { name: "glover_rowe", type: "double precision" },
        { name: "delta_tc", type: "double precision" },
        { name: "g_star", type: "double precision" },
      ],
      fks: [
        { column: "section_id", references: { table: "test_sections", column: "section_id" } },
      ],
    },
    {
      key: "file_registry",
      display_name: "File Registry",
      description: "Index of raw files linked to a section or test category.",
      step: 4,
      columns: [
        { name: "id", type: "integer", pk: true },
        { name: "file_path", type: "text" },
        { name: "file_type", type: "text" },
        { name: "section_id", type: "integer" },
        { name: "test_category", type: "text" },
        { name: "description", type: "text" },
      ],
      fks: [
        { column: "section_id", references: { table: "test_sections", column: "section_id" } },
      ],
    },
  ],
  example_queries: [
    {
      name: "All 5-year cores |E*| at 30°C, 10 Hz",
      description:
        "Dynamic modulus at 30°C and 10 Hz for specimens tagged as 5-year field cores, joined to section metadata.",
      sql: `-- Replace the ds_* table names with the ones in this project.
SELECT
  s.section_code,
  s.pg_grade,
  sp.specimen_code,
  sp.core_year,
  cm.temperature_c,
  cm.frequency_hz,
  cm.dynamic_modulus_mpa,
  cm.phase_angle_deg
FROM ds_complex_modulus_results cm
JOIN ds_specimens sp     ON sp.id         = cm.specimen_id
JOIN ds_test_sections s  ON s.section_id  = sp.section_id
WHERE cm.temperature_c BETWEEN 29 AND 31
  AND cm.frequency_hz  BETWEEN 9.5 AND 10.5
  AND sp.core_year LIKE '%5%'
ORDER BY s.section_code, sp.specimen_code`,
    },
    {
      name: "FI vs Sapp correlation",
      description:
        "Per-specimen flexibility index (I-FIT) alongside DT-CF Sapp, ready to plot or copy into a stats tool.",
      sql: `SELECT
  s.section_code,
  sp.specimen_code,
  sp.air_voids_pct,
  AVG(i.flexibility_index) AS fi_avg,
  AVG(d.sapp)              AS sapp_avg
FROM ds_specimens sp
JOIN ds_test_sections s   ON s.section_id  = sp.section_id
LEFT JOIN ds_ifit_results i ON i.specimen_id = sp.id
LEFT JOIN ds_dtcf_results d ON d.specimen_id = sp.id
GROUP BY s.section_code, sp.specimen_code, sp.air_voids_pct
HAVING AVG(i.flexibility_index) IS NOT NULL
   AND AVG(d.sapp) IS NOT NULL
ORDER BY s.section_code, sp.specimen_code`,
    },
    {
      name: "Field performance summary by section",
      description:
        "Average IRI, rutting, and texture per section across all measurement dates.",
      sql: `SELECT
  s.section_code,
  s.rejuvenator_type,
  COUNT(fp.*)              AS measurements,
  AVG(fp.iri_avg_long)     AS iri_avg,
  AVG(fp.rut_avg_long)     AS rut_avg,
  AVG(fp.tex_avg_long)     AS tex_avg
FROM ds_test_sections s
LEFT JOIN ds_field_performance fp ON fp.section_id = s.section_id
GROUP BY s.section_code, s.rejuvenator_type
ORDER BY s.section_code`,
    },
    {
      name: "Recovered binder — Glover-Rowe & ΔTc",
      description:
        "Binder rheology by section and aging condition, sorted by cracking-risk index.",
      sql: `SELECT
  s.section_code,
  b.aging_condition,
  b.binder_source,
  b.glover_rowe,
  b.delta_tc,
  b.g_star
FROM ds_binder_tests b
JOIN ds_test_sections s ON s.section_id = b.section_id
ORDER BY b.glover_rowe DESC NULLS LAST`,
    },
  ],
};

export const TEMPLATES: ProjectTemplate[] = [ASPHALT_TEMPLATE];

export function getTemplate(key: string | null | undefined): ProjectTemplate | null {
  if (!key) return null;
  return TEMPLATES.find((t) => t.key === key) ?? null;
}

export type TemplateMeta = {
  /** Map from template table key -> dataset.id (uuid) once uploaded. */
  bindings?: Record<string, string>;
  /** Confirmed FK column mappings: template table key -> { fkColumn: parentColumn } */
  fk_mappings?: Record<string, Record<string, string>>;
  /** Runtime template generated by the AI folder import (renders in ErdDiagram). */
  ai_template?: ProjectTemplate;
};
