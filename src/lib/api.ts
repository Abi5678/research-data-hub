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
  /** Null on a combined dataset: counting a live view re-runs its joins, so the
   *  number is fetched on demand with `datasetRowCount`, never stored. */
  row_count: number | null;
  column_schema: ColumnSchema[];
  created_at: string;
  /** 1 when the dataset is a view over an attached database — query only. */
  read_only?: 0 | 1;
  /** Set when the attached file backing this dataset could not be opened. */
  unavailable_reason?: string | null;
  /** Set only on a combined dataset: the recipe its view is generated from. */
  recipe?: CombineRecipe | null;
};

/** Where one output column's values come from, within one branch. */
export type CombineSource = {
  /** "spine", or the id of a join in the same branch. */
  from: string;
  column: string;
};

export type CombineJoin = {
  id: string;
  /** table_name being joined in. */
  table: string;
  /** "spine" or an earlier join's id — what this one hangs off. */
  leftFrom?: string;
  leftColumn: string;
  rightColumn: string;
  /** LEFT by default, because INNER silently drops unmatched spine rows. */
  type?: "left" | "inner";
  /** Native compare is indexable; text compare is stricter but forces a scan. */
  keyCompare?: "native" | "text";
};

/**
 * One dataset feeding a combined dataset: a spine table, any joins hanging off
 * it, and how its columns land in the shared output shape. Joins add columns;
 * extra branches add rows.
 */
export type CombineBranch = {
  id: string;
  label?: string;
  /** table_name every join in this branch hangs off. */
  spine: string;
  joins?: CombineJoin[];
  /** output column name -> where it comes from. Null means blank for this branch. */
  map: Record<string, CombineSource | null>;
};

export type CombineRecipe = {
  version: 1;
  branches: CombineBranch[];
  columns: { name: string; type: ColumnKind }[];
  /** Add a source_dataset column naming which branch each row came from. */
  provenance?: boolean;
};

export type CombineFinding = {
  /** "block" cannot be saved; "warn" can, once the user has seen it. */
  level: "block" | "warn";
  code: string;
  message: string;
  detail?: Record<string, unknown>;
};

export type CombinePreflight = {
  ok: boolean;
  findings: CombineFinding[];
  columns: ColumnSchema[];
  branches: {
    id: string;
    label: string;
    spine: string;
    spineRows: number | null;
    /** Null when the sources were too large to count exactly. */
    rows: number | null;
    unmapped: string[];
  }[];
  renames: { from: string; to: string }[];
  estimatedRows: number | null;
};

export type AttachedSource = {
  id: string;
  project_id: string;
  alias: string;
  file_path: string;
  created_at: string;
  table_count: number;
  /** 0 when the file could not be opened this session — its tables cannot be queried. */
  available?: 0 | 1;
  unavailable_reason?: string | null;
};

export type SavedQuery = {
  id: string;
  project_id: string;
  name: string;
  sql_text: string | null;
  created_at: string;
};

export type AnalysisView = {
  id: string;
  project_id: string;
  name: string;
  spec: unknown;
  created_at: string;
  updated_at: string;
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

export type ScriptLanguage = "python" | "matlab";

export type Script = {
  id: string;
  project_id: string;
  name: string;
  language: ScriptLanguage;
  /** The script text, copied into the database at import. The file on disk is
   *  never modified, so `origin_path` and this can diverge — deliberately. */
  code: string;
  /** What the file is called inside a run folder. For MATLAB its stem is a valid
   *  identifier, because `-batch` takes a function name. */
  entry_filename: string;
  origin_path: string | null;
  created_at: string;
  updated_at: string;
  run_count?: number;
};

export type ScriptRunInput = {
  dataset_id: string;
  display_name: string;
  /** Filename in the run folder — `data.csv` for the first dataset. */
  file: string;
  row_count: number;
  columns: string[];
};

export type ScriptRunOutput = {
  name: string;
  size: number;
  kind: "image" | "pdf" | "csv" | "file";
};

export type ScriptRun = {
  id: string;
  script_id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "failed" | "cancelled" | "timeout";
  exit_code: number | null;
  run_dir: string;
  /** Exactly the code that ran, so a later edit cannot rewrite history. */
  code_snapshot: string;
  inputs: ScriptRunInput[];
  outputs: ScriptRunOutput[];
  stdout: string;
  stderr: string;
};

export type ScriptRunEvent =
  | { runId: string; kind: "status" | "stdout" | "stderr"; text: string }
  | { runId: string; kind: "done"; run?: ScriptRun; error?: string };

export type RuntimeCandidate = {
  path: string;
  ok: boolean;
  version?: string | null;
  libraries?: Record<string, boolean>;
  /** What the picker shows, e.g. "Python 3.12.4 — pandas, numpy". */
  detail: string;
};

export type RuntimeDetection = {
  python: { candidates: RuntimeCandidate[]; selected: string | null };
  matlab: { candidates: RuntimeCandidate[]; selected: string | null };
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
    /** `truncated` is true when the result hit `limit` and more rows exist. */
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[]; truncated?: boolean }>;
  listSavedQueries(projectId: string): Promise<SavedQuery[]>;
  insertSavedQuery(projectId: string, name: string, sqlText: string): Promise<void>;
  listAnalysisViews(projectId: string): Promise<AnalysisView[]>;
  insertAnalysisView(projectId: string, name: string, spec: unknown): Promise<{ id: string }>;
  deleteAnalysisView(projectId: string, id: string): Promise<void>;
  listExportHistory(projectId: string, limit?: number): Promise<ExportHistoryRow[]>;
  insertExportHistory(args: {
    projectId: string;
    filename: string;
    rowCount: number;
    queryId?: string | null;
  }): Promise<void>;
  listImportHistory(projectId: string, limit?: number): Promise<import("@/lib/ai-import").ImportHistoryRow[]>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  /** Desktop only — the lab server has no local filesystem to attach from. */
  pickDatabaseFile(): Promise<string | null>;
  attachSource(
    projectId: string,
    filePath: string,
  ): Promise<{ id: string; alias: string; file_path: string; table_count: number }>;
  listAttachedSources(projectId: string): Promise<AttachedSource[]>;
  /** Re-read attached files: new/dropped tables, fresh row counts, missing files. */
  refreshAttachedSources(
    projectId: string,
  ): Promise<{ refreshed: number; unavailable: { alias: string; reason: string }[] }>;
  detachSource(sourceId: string): Promise<void>;
  /** Desktop only — combined datasets are SQLite temp views. */
  previewCombinedSql(projectId: string, recipe: CombineRecipe): Promise<string>;
  /** Everything that could make the result quietly wrong, checked against the
   *  real data. `datasetId` is the combined dataset being edited, if any. */
  preflightCombine(
    projectId: string,
    recipe: CombineRecipe,
    datasetId?: string | null,
  ): Promise<CombinePreflight>;
  createCombinedDataset(args: {
    projectId: string;
    displayName: string;
    recipe: CombineRecipe;
  }): Promise<{ dataset_id: string; table_name: string }>;
  updateCombinedDataset(
    datasetId: string,
    args: { displayName?: string; recipe?: CombineRecipe },
  ): Promise<{ dataset_id: string; table_name: string }>;
  /** Combined datasets built on this table — what blocks removing it. */
  combinedDependents(tableName: string): Promise<{ id: string; display_name: string }[]>;
  /** Copy a combined view's current rows into an ordinary table. The snapshot
   *  stops following its sources; the combination itself is left in place. */
  freezeCombinedDataset(
    datasetId: string,
    args?: { displayName?: string },
  ): Promise<{ dataset_id: string; table_name: string; row_count: number }>;
  /** Counted now for a combined view, read from storage otherwise. Null when a
   *  combined view is currently unreadable. */
  datasetRowCount(datasetId: string): Promise<number | null>;
  testLlmConnection(): Promise<{ model: string; reply: string; mode?: string }>;
  /** Free-form chat; the Ask tab builds the messages. */
  llmChat(
    messages: { role: string; content: string }[],
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string>;
  isAiAssistAvailable(): Promise<boolean>;
  cloudNimAllowed(): Promise<boolean>;
  backupDatabase(): Promise<string | null>;
  /** `previous` is where the replaced database was copied, so a wrong pick is recoverable. */
  restoreDatabase(): Promise<{ restored: string; previous: string | null } | null>;
  getDatabasePath(): Promise<string | null>;
  pickImportFolder(): Promise<string | null>;
  analyzeFolder(
    folderPath: string,
    opts?: { useAi?: boolean },
  ): Promise<AnalyzeFolderResult>;
  executeImportPlan(payload: {
    folder: string;
    projectInput?: ProjectInput;
    projectId?: string;
    tables: PlannedTable[];
    mode?: string;
  }): Promise<ExecuteImportResult>;
  onImportProgress(cb: (msg: string) => void): () => void;

  // ---------- scripts (desktop only — running code needs a local machine) ----------
  listScripts(projectId: string): Promise<Script[]>;
  getScript(scriptId: string): Promise<Script>;
  createScript(args: {
    projectId: string;
    name: string;
    language: ScriptLanguage;
    code?: string;
    originPath?: string | null;
  }): Promise<Script>;
  updateScript(scriptId: string, args: { name?: string; code?: string }): Promise<Script>;
  /** Resolves with the deleted script's name, for the confirmation message. */
  deleteScript(scriptId: string): Promise<string>;
  /** The filename a script would get in a run folder, for showing in the UI
   *  before it is saved. */
  scriptEntryFilename(name: string, language: ScriptLanguage): Promise<string>;
  listScriptRuns(scriptId: string, limit?: number): Promise<ScriptRun[]>;
  getScriptRun(runId: string): Promise<ScriptRun>;
  /** Opens a file picker and reads the text; the file itself is never run. */
  pickScriptFile(): Promise<{
    path: string;
    name: string;
    language: ScriptLanguage;
    code: string;
  } | null>;
  /** Returns once the run has an id. Completion arrives as a `done` event on
   *  `onScriptRunEvent`, so a ten-minute MATLAB run does not sit on an open IPC
   *  promise. */
  runScript(payload: {
    scriptId: string;
    datasetIds: string[];
    timeoutMs?: number;
  }): Promise<{ runId: string }>;
  cancelScriptRun(runId: string): Promise<boolean>;
  readRunFile(runId: string, name: string): Promise<{ name: string; size: number; base64: string }>;
  openRunFolder(runId: string): Promise<void>;
  detectRuntimes(): Promise<RuntimeDetection>;
  testMatlab(binPath: string): Promise<{ ok: boolean; detail: string }>;
  onScriptRunEvent(cb: (event: ScriptRunEvent) => void): () => void;
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
