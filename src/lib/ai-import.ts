import type { ColumnKind } from "@/lib/csv";

// Shapes returned by the main-process folder analysis (electron/llm.cjs +
// electron/folder-import.cjs). PlannedTable mirrors TemplateTable closely so
// converting a plan into a runtime ProjectTemplate is a straight map.

export type PlannedColumn = {
  name: string;
  type: ColumnKind;
  pk?: boolean;
  source_header: string | null; // null = AI-introduced (e.g. source_label)
};

export type PlannedSource = {
  file: string; // relative to the imported folder
  sheet: string | null;
  source_label: string | null;
};

export type PlannedFk = {
  column: string;
  references: { table: string; column: string };
};

export type PlannedTable = {
  key: string;
  display_name: string;
  description: string;
  columns: PlannedColumn[];
  sources: PlannedSource[];
  fks: PlannedFk[];
  step: 1 | 2 | 3 | 4;
};

export type ImportPlan = {
  project_name: string;
  notes: string;
  tables: PlannedTable[];
  mode?: string;
};

export type SourceProfile = {
  file: string;
  sheet: string | null;
  row_count: number;
  columns: { header: string; inferred_type: ColumnKind }[];
  truncated_columns: number;
  sample_rows: string[][];
};

export type AnalyzeFolderResult = {
  plan: ImportPlan;
  profiles: SourceProfile[];
  skipped: { file: string; reason: string }[];
  folder: string;
  mode?: string;
};

export type ImportHistoryRow = {
  id: string;
  project_id: string;
  folder_path: string | null;
  mode: string;
  report: {
    mode?: string;
    results?: {
      key: string;
      display_name: string;
      inserted: number;
      invalid: number;
      repaired?: number;
    }[];
    skippedSources?: { file: string; reason: string }[];
    quarantine?: unknown[];
    totals?: {
      tables: number;
      inserted: number;
      invalid: number;
      /** Cells stored as NULL because they failed their column type. */
      repaired?: number;
      skippedSources: number;
    };
  };
  created_at: string;
};

export type ExecuteImportResult = {
  projectId: string;
  results: {
    key: string;
    display_name: string;
    inserted: number;
    invalid: number;
    repaired?: number;
  }[];
  skippedSources?: { file: string; reason: string }[];
  quarantine?: unknown[];
  report?: ImportHistoryRow["report"];
  importId?: string;
};
