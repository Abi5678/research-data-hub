"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const dbApi = require("./db.cjs");
const llm = require("./llm.cjs");
const folderImport = require("./folder-import.cjs");

const DEV_URL = process.env.ELECTRON_START_URL || "http://127.0.0.1:5173";
const isDev = !app.isPackaged;

/** Normalized absolute paths approved for folder import (dialog or env). */
const approvedImportRoots = new Set();

/** Database files the user picked in a dialog, eligible to be attached. */
const approvedDatabaseFiles = new Set();

function assertApprovedDatabaseFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!approvedDatabaseFiles.has(resolved)) {
    throw new Error(
      "Database file not approved. Use “Attach database” in the app to pick the file first.",
    );
  }
  return resolved;
}

function approveImportRoot(folderPath) {
  if (!folderPath) return;
  approvedImportRoots.add(path.resolve(folderPath));
}

function assertApprovedImportFolder(folderPath) {
  const resolved = path.resolve(folderPath);
  for (const root of approvedImportRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }
  throw new Error(
    "Import folder not approved. Use “Pick folder” in the app before analyzing or importing.",
  );
}

function registerIpc() {
  // attachSource / backup / restore need dialog-backed handlers (paths must not
  // come from free-form renderer strings). Skip them in the generic loop.
  const manual = new Set(["open", "attachSource", "backupDatabase", "restoreDatabase"]);
  const methods = Object.keys(dbApi).filter((k) => !manual.has(k));
  for (const name of methods) {
    ipcMain.handle(`db:${name}`, (_event, ...args) => dbApi[name](...args));
  }

  ipcMain.handle("db:attachSource", (_event, projectId, filePath) =>
    dbApi.attachSource(projectId, assertApprovedDatabaseFile(filePath)),
  );

  ipcMain.handle("db:pickDatabaseFile", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: "Attach an existing database",
      properties: ["openFile"],
      filters: [
        { name: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const picked = res.canceled ? null : res.filePaths[0];
    if (picked) approvedDatabaseFiles.add(path.resolve(picked));
    return picked;
  });

  ipcMain.handle("llm:testConnection", () => llm.testConnection());

  // Free-form chat used by the Ask tab. Messages are built in the renderer so
  // desktop and server modes share one prompt; the key stays in the main process.
  ipcMain.handle("llm:chat", (_event, messages, opts) => llm.chat(messages, opts ?? {}));
  ipcMain.handle("llm:isAiAssistAvailable", () => llm.isAiAssistAvailable());
  ipcMain.handle("llm:cloudNimAllowed", () => llm.cloudNimAllowed());

  ipcMain.handle("db:backupDatabase", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showSaveDialog(win, {
      title: "Backup database",
      defaultPath: `research-data-hub-backup-${new Date().toISOString().slice(0, 10)}.sqlite3`,
      filters: [{ name: "SQLite", extensions: ["sqlite3", "db"] }],
    });
    if (res.canceled || !res.filePath) return null;
    dbApi.backupDatabase(res.filePath);
    return res.filePath;
  });

  ipcMain.handle("db:restoreDatabase", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const confirm = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Restore"],
      defaultId: 0,
      cancelId: 0,
      title: "Restore database",
      message: "Replace the current database with a backup?",
      detail: "This cannot be undone. Close other work first.",
    });
    if (confirm.response !== 1) return null;
    const res = await dialog.showOpenDialog(win, {
      title: "Choose backup file",
      properties: ["openFile"],
      filters: [{ name: "SQLite", extensions: ["sqlite3", "db", "sqlite"] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    dbApi.restoreDatabase(res.filePaths[0]);
    return res.filePaths[0];
  });

  ipcMain.handle("import:pickFolder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    const picked = res.canceled ? null : res.filePaths[0];
    if (picked) approveImportRoot(picked);
    return picked;
  });

  ipcMain.handle("import:analyzeFolder", (event, folderPath, opts) => {
    const folder = assertApprovedImportFolder(folderPath);
    return folderImport.analyzeFolder(
      folder,
      (msg) => {
        event.sender.send("import-progress", msg);
      },
      opts && typeof opts === "object" ? opts : {},
    );
  });

  ipcMain.handle("import:executePlan", (event, payload) => {
    const folder = assertApprovedImportFolder(payload.folder);
    return folderImport.executeImportPlan(
      { ...payload, folder },
      (msg) => {
        event.sender.send("import-progress", msg);
      },
    );
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Research Data Hub",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// Keep dev and packaged builds on the same userData directory. Research data
// must not live inside the source tree; set DB_PATH for an isolated dev copy.
app.setName("Research Data Hub");

app.whenReady().then(() => {
  const dbPath =
    process.env.DB_PATH || path.join(app.getPath("userData"), "research-data-hub.sqlite3");
  dbApi.open(dbPath);
  console.log(`SQLite database: ${dbPath}`);

  if (process.env.IMPORT_ROOT) {
    approveImportRoot(process.env.IMPORT_ROOT);
  }

  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
