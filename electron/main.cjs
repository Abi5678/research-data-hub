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
  const methods = Object.keys(dbApi).filter((k) => k !== "open");
  for (const name of methods) {
    ipcMain.handle(`db:${name}`, (_event, ...args) => dbApi[name](...args));
  }

  ipcMain.handle("llm:testConnection", () => llm.testConnection());

  ipcMain.handle("import:pickFolder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    const picked = res.canceled ? null : res.filePaths[0];
    if (picked) approveImportRoot(picked);
    return picked;
  });

  ipcMain.handle("import:analyzeFolder", (event, folderPath) => {
    const folder = assertApprovedImportFolder(folderPath);
    return folderImport.analyzeFolder(folder, (msg) => {
      event.sender.send("import-progress", msg);
    });
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

app.whenReady().then(() => {
  const dbPath =
    process.env.DB_PATH ||
    (isDev
      ? path.join(__dirname, "..", "data", "local.sqlite3")
      : path.join(app.getPath("userData"), "nrra-data.sqlite3"));
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
