"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// ipcRenderer.invoke wraps errors as "Error invoking remote method 'x': Error: <msg>".
// Strip that prefix so the UI shows the real message.
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((err) => {
    const msg = String(err && err.message ? err.message : err).replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      "",
    );
    throw new Error(msg);
  });
}

const DB_METHODS = [
  "listProjects",
  "getProject",
  "createProject",
  "updateProjectTemplateMeta",
  "deleteProject",
  "listDatasets",
  "updateDatasetColumnSchema",
  "createProjectDataset",
  "insertDatasetRowsTyped",
  "replaceDatasetRowsTyped",
  "dropProjectDataset",
  "truncateDataset",
  "addDatasetColumn",
  "datasetColumnValues",
  "queryDataset",
  "runProjectQuery",
  "listSavedQueries",
  "insertSavedQuery",
  "listAnalysisViews",
  "insertAnalysisView",
  "deleteAnalysisView",
  "listExportHistory",
  "insertExportHistory",
  "listImportHistory",
  "insertImportHistory",
  "getSetting",
  "setSetting",
  "attachSource",
  "listAttachedSources",
  "refreshAttachedSources",
  "detachSource",
  "previewCombinedSql",
  "preflightCombine",
  "createCombinedDataset",
  "updateCombinedDataset",
  "combinedDependents",
  "freezeCombinedDataset",
  "datasetRowCount",
  "pickDatabaseFile",
  "getDatabasePath",
];

const api = {};
for (const name of DB_METHODS) {
  api[name] = (...args) => invoke(`db:${name}`, ...args);
}

api.backupDatabase = () => invoke("db:backupDatabase");
api.restoreDatabase = () => invoke("db:restoreDatabase");
api.testLlmConnection = () => invoke("llm:testConnection");
api.llmChat = (messages, opts) => invoke("llm:chat", messages, opts);
api.isAiAssistAvailable = () => invoke("llm:isAiAssistAvailable");
api.cloudNimAllowed = () => invoke("llm:cloudNimAllowed");
api.pickImportFolder = () => invoke("import:pickFolder");
api.analyzeFolder = (folderPath, opts) => invoke("import:analyzeFolder", folderPath, opts || {});
api.executeImportPlan = (payload) => invoke("import:executePlan", payload);
api.onImportProgress = (cb) => {
  const listener = (_event, msg) => cb(msg);
  ipcRenderer.on("import-progress", listener);
  return () => ipcRenderer.removeListener("import-progress", listener);
};

contextBridge.exposeInMainWorld("api", api);
