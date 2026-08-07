import type {
  AnalyzeFolderResult,
  ExecuteImportResult,
  PlannedTable,
} from "@/lib/ai-import";
import type { ColumnKind, ColumnSchema } from "@/lib/csv";
import { isServerMode } from "@/lib/mode";
import { httpApi } from "@/lib/api-http";

export type Project = {
  id: string;
  project_code: string;
  project_name: string;
  sponsor: string | null;
  pi_name: string | null;
  start_date: string | null;
  end_date: string | null;
  description: string | null;
  template_key: string | null;
  template_meta: unknown;
  created_at: string;
  updated_at: string;
  dataset_count: number;
};

export type Dataset = {
  id: string;
  project_id: string;
  table_name: string;
  display_name: string;
  source_filename: string | null;
  row_count: number;
  column_schema: ColumnSchema[];
  created_at: string;
  /** 1 when the dataset is a view over an attached database — query only. */
  read_only?: 0 | 1;
};

export type AttachedSource = {
  id: string;
  project_id: string;
  alias: string;
  file_path: string;
  created_at: string;
  table_count: number;
};

export type SavedQuery = {
  id: string;
  project_id: string;
  name: string;
  sql_text: string | null;
  created_at: string;
};

export type ExportHistoryRow = {
  id: string;
  project_id: string;
  query_id: string | null;
  filename: string;
  row_count: number;
  created_at: string;
};

export type ProjectInput = {
  project_name: string;
  project_code: string;
  description?: string | null;
  sponsor?: string | null;
  pi_name?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  template_key?: string | null;
};

export type LocalApi = {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(input: ProjectInput): Promise<string>;
  updateProjectTemplateMeta(id: string, templateMeta: unknown): Promise<void>;
  deleteProject(id: string): Promise<void>;
  listDatasets(projectId: string, order?: "asc" | "desc"): Promise<Dataset[]>;
  updateDatasetColumnSchema(datasetId: string, columnSchema: ColumnSchema[]): Promise<void>;
  createProjectDataset(args: {
    projectId: string;
    displayName: string;
    sourceFilename: string | null;
    columns: { name: string; original_name: string; type: ColumnKind }[];
  }): Promise<{ dataset_id: string; table_name: string }>;
  insertDatasetRowsTyped(
    datasetId: string,
    rows: Record<string, string | null>[],
  ): Promise<number>;
  replaceDatasetRowsTyped(
    datasetId: string,
    rows: Record<string, string | null>[],
  ): Promise<number>;
  dropProjectDataset(datasetId: string): Promise<void>;
  truncateDataset(datasetId: string): Promise<void>;
  addDatasetColumn(datasetId: string, columnName: string, columnType: ColumnKind): Promise<string>;
  datasetColumnValues(
    datasetId: string,
    columns: string[],
    limit?: number,
  ): Promise<Record<string, unknown>[]>;
  queryDataset(datasetId: string, limit?: number): Promise<Record<string, unknown>[]>;
  runProjectQuery(
    projectId: string,
    sql: string,
    limit?: number,
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }>;
  listSavedQueries(projectId: string): Promise<SavedQuery[]>;
  insertSavedQuery(projectId: string, name: string, sqlText: string): Promise<void>;
  listExportHistory(projectId: string, limit?: number): Promise<ExportHistoryRow[]>;
  insertExportHistory(args: {
    projectId: string;
    filename: string;
    rowCount: number;
    queryId?: string | null;
  }): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  /** Desktop only — the lab server has no local filesystem to attach from. */
  pickDatabaseFile(): Promise<string | null>;
  attachSource(
    projectId: string,
    filePath: string,
  ): Promise<{ id: string; alias: string; file_path: string; table_count: number }>;
  listAttachedSources(projectId: string): Promise<AttachedSource[]>;
  detachSource(sourceId: string): Promise<void>;
  testLlmConnection(): Promise<{ model: string; reply: string }>;
  pickImportFolder(): Promise<string | null>;
  analyzeFolder(folderPath: string): Promise<AnalyzeFolderResult>;
  executeImportPlan(payload: {
    folder: string;
    projectInput: ProjectInput;
    tables: PlannedTable[];
  }): Promise<ExecuteImportResult>;
  onImportProgress(cb: (msg: string) => void): () => void;
};

declare global {
  interface Window {
    api: LocalApi;
  }
}

function missingBridge(): never {
  throw new Error(
    "Local database bridge is unavailable. Launch the Electron app or set VITE_SERVER_MODE=1 for the lab server.",
  );
}

const electronApi: LocalApi =
  typeof window !== "undefined" && window.api
    ? window.api
    : (new Proxy({}, { get: () => missingBridge }) as LocalApi);

export const api: LocalApi = isServerMode ? httpApi : electronApi;
