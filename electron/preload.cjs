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
  "listExportHistory",
  "insertExportHistory",
  "getSetting",
  "setSetting",
  "attachSource",
  "listAttachedSources",
  "detachSource",
  "pickDatabaseFile",
];

const api = {};
for (const name of DB_METHODS) {
  api[name] = (...args) => invoke(`db:${name}`, ...args);
}

api.testLlmConnection = () => invoke("llm:testConnection");
api.pickImportFolder = () => invoke("import:pickFolder");
api.analyzeFolder = (folderPath) => invoke("import:analyzeFolder", folderPath);
api.executeImportPlan = (payload) => invoke("import:executePlan", payload);
api.onImportProgress = (cb) => {
  const listener = (_event, msg) => cb(msg);
  ipcRenderer.on("import-progress", listener);
  return () => ipcRenderer.removeListener("import-progress", listener);
};

contextBridge.exposeInMainWorld("api", api);
