import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("../electron/db.cjs");
const Database = require("better-sqlite3");

let tmpDir;
let tmpDb;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rdh-restore-"));
  tmpDb = path.join(tmpDir, "hub.sqlite3");
  db.open(tmpDb);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("restoreDatabase", () => {
  it("refuses a file that is not a backup, leaving the live database open", () => {
    const junk = path.join(tmpDir, "notes.txt");
    fs.writeFileSync(junk, "this is not a database");
    expect(() => db.restoreDatabase(junk)).toThrow(/not a readable SQLite database/i);

    const foreign = path.join(tmpDir, "foreign.sqlite3");
    const other = new Database(foreign);
    other.exec("CREATE TABLE foo (x INTEGER)");
    other.close();
    expect(() => db.restoreDatabase(foreign)).toThrow(/not a Research Data Hub backup/i);

    // Nothing was closed or copied, so the app is still working.
    expect(() => db.listProjects()).not.toThrow();
  });

  it("keeps a copy of the database it replaces", () => {
    const backupPath = path.join(tmpDir, "before.sqlite3");
    db.backupDatabase(backupPath);
    const code = `RST-${Date.now()}`;
    db.createProject({ project_name: "Made after the backup", project_code: code });
    expect(db.listProjects().some((p) => p.project_code === code)).toBe(true);

    const { previous } = db.restoreDatabase(backupPath);
    expect(db.listProjects().some((p) => p.project_code === code)).toBe(false);

    // Restoring the wrong backup is recoverable: the work done since it was
    // taken is set aside, not overwritten.
    expect(fs.existsSync(previous)).toBe(true);
    db.restoreDatabase(previous);
    expect(db.listProjects().some((p) => p.project_code === code)).toBe(true);
  });
});
