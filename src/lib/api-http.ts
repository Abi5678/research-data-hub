import type { LocalApi, ProjectInput } from "@/lib/api";
import type {
  AnalyzeFolderResult,
  ExecuteImportResult,
  PlannedTable,
} from "@/lib/ai-import";

const base = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const ATTACH_UNAVAILABLE =
  "Attaching an existing database is only available in the desktop app, which can reach your local files.";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const httpApi: LocalApi = {
  listProjects: () => req("/api/projects"),
  getProject: (id) => req(`/api/projects/${id}`),
  createProject: async (input: ProjectInput) => {
    const r = await req<{ id: string }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return r.id;
  },
  updateProjectTemplateMeta: (id, templateMeta) =>
    req(`/api/projects/${id}/template-meta`, {
      method: "PATCH",
      body: JSON.stringify({ templateMeta }),
    }),
  deleteProject: (id) => req(`/api/projects/${id}`, { method: "DELETE" }),
  listDatasets: (projectId, order = "desc") =>
    req(`/api/projects/${projectId}/datasets?order=${order}`),
  updateDatasetColumnSchema: (datasetId, columnSchema) =>
    req(`/api/datasets/${datasetId}/schema`, {
      method: "PATCH",
      body: JSON.stringify({ columnSchema }),
    }),
  createProjectDataset: (args) =>
    req("/api/datasets", { method: "POST", body: JSON.stringify(args) }),
  insertDatasetRowsTyped: async (datasetId, rows) => {
    const r = await req<{ inserted: number }>(`/api/datasets/${datasetId}/rows`, {
      method: "POST",
      body: JSON.stringify({ rows }),
    });
    return r.inserted;
  },
  replaceDatasetRowsTyped: async (datasetId, rows) => {
    const r = await req<{ inserted: number }>(`/api/datasets/${datasetId}/rows`, {
      method: "PUT",
      body: JSON.stringify({ rows }),
    });
    return r.inserted;
  },
  dropProjectDataset: (datasetId) => req(`/api/datasets/${datasetId}`, { method: "DELETE" }),
  truncateDataset: (datasetId) =>
    req(`/api/datasets/${datasetId}/truncate`, { method: "POST" }),
  addDatasetColumn: async (datasetId, columnName, columnType) => {
    const r = await req<{ name: string }>(`/api/datasets/${datasetId}/columns`, {
      method: "POST",
      body: JSON.stringify({ columnName, columnType }),
    });
    return r.name;
  },
  datasetColumnValues: (datasetId, columns, limit) =>
    req(
      `/api/datasets/${datasetId}/values?columns=${encodeURIComponent(columns.join(","))}&limit=${limit ?? 50000}`,
    ),
  queryDataset: (datasetId, limit) =>
    req(`/api/datasets/${datasetId}/query?limit=${limit ?? 5000}`),
  runProjectQuery: (projectId, sql, limit) =>
    req(`/api/projects/${projectId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql, limit }),
    }),
  listSavedQueries: (projectId) => req(`/api/projects/${projectId}/saved-queries`),
  insertSavedQuery: (projectId, name, sqlText) =>
    req(`/api/projects/${projectId}/saved-queries`, {
      method: "POST",
      body: JSON.stringify({ name, sqlText }),
    }),
  listAnalysisViews: (projectId) => req(`/api/projects/${projectId}/analysis-views`),
  insertAnalysisView: (projectId, name, spec) =>
    req(`/api/projects/${projectId}/analysis-views`, {
      method: "POST",
      body: JSON.stringify({ name, spec }),
    }),
  deleteAnalysisView: (projectId, id) =>
    req(`/api/projects/${projectId}/analysis-views/${id}`, { method: "DELETE" }),
  listExportHistory: (projectId, limit) =>
    req(`/api/projects/${projectId}/exports?limit=${limit ?? 50}`),
  insertExportHistory: (args) =>
    req(`/api/projects/${args.projectId}/exports`, {
      method: "POST",
      body: JSON.stringify({
        filename: args.filename,
        rowCount: args.rowCount,
        queryId: args.queryId ?? null,
      }),
    }),
  listImportHistory: (projectId, limit) =>
    req(`/api/projects/${projectId}/import-history?limit=${limit ?? 50}`),
  getSetting: async (key) => {
    const r = await req<{ value: string | null }>(`/api/settings/${encodeURIComponent(key)}`);
    return r.value;
  },
  setSetting: (key, value) =>
    req(`/api/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  testLlmConnection: () => req("/api/llm/test", { method: "POST" }),
  llmChat: async (messages, opts) => {
    const r = await req<{ content: string }>("/api/llm/chat", {
      method: "POST",
      body: JSON.stringify({ messages, ...opts }),
    });
    return r.content;
  },
  isAiAssistAvailable: async () => {
    const r = await req<{ available: boolean }>("/api/llm/available");
    return r.available;
  },
  cloudNimAllowed: async () => {
    const r = await req<{ cloud: boolean }>("/api/llm/available");
    return r.cloud;
  },
  backupDatabase: async () => {
    throw new Error("Database backup is only available in the desktop app.");
  },
  restoreDatabase: async () => {
    throw new Error("Database restore is only available in the desktop app.");
  },
  getDatabasePath: async () => null,
  pickImportFolder: async () => {
    throw new Error(
      "Native folder pick is desktop-only. Use Choose folder / Upload zip on this page.",
    );
  },
  analyzeFolder: async () => {
    throw new Error("AI folder analyze is desktop-only. Browser import is deterministic.");
  },
  executeImportPlan: async (payload) => {
    return req<ExecuteImportResult>("/api/import/folder-job", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  onImportProgress: () => () => {},
  pickDatabaseFile: async () => {
    throw new Error(ATTACH_UNAVAILABLE);
  },
  attachSource: async () => {
    throw new Error(ATTACH_UNAVAILABLE);
  },
  // Nothing can be attached in server mode, so the list is simply empty.
  listAttachedSources: async () => [],
  detachSource: async () => {
    throw new Error(ATTACH_UNAVAILABLE);
  },
};

export type AuthUser = { id: string; email: string; global_role: "admin" | "user" };

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch(`${base}/api/auth/me`, { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error("Auth check failed");
  return res.json() as Promise<AuthUser>;
}

export async function login(email: string, password: string) {
  return req<AuthUser>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function logout() {
  await req("/api/auth/logout", { method: "POST" });
}

export async function register(email: string, password: string) {
  return req<AuthUser>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function inviteProjectMember(
  projectId: string,
  email: string,
  role: "editor" | "viewer",
) {
  return req(`/api/projects/${projectId}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export async function listProjectMembers(projectId: string) {
  return req<{ email: string; role: string }[]>(`/api/projects/${projectId}/members`);
}
