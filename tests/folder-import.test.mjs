import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const fixtureRoot = path.join(root, "fixtures", "nhdot-mini");

const db = require("../electron/db.cjs");
const folderImport = require("../electron/folder-import.cjs");
const { prepareProjectSelect } = require("../electron/query-guard.cjs");

let tmpDb;

beforeAll(() => {
  tmpDb = path.join(os.tmpdir(), `rdh-test-${Date.now()}.sqlite3`);
  db.open(tmpDb);
});

afterAll(() => {
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ignore */
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(tmpDb + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe("deterministic plan", () => {
  it("builds one table per profile with snake_case columns", () => {
    const profiles = [
      {
        file: "2022/mix_samples.csv",
        sheet: null,
        columns: [
          { header: "Sample ID", inferred_type: "text" },
          { header: "binder_pct", inferred_type: "double precision" },
        ],
      },
      {
        file: "lab_results.csv",
        sheet: null,
        columns: [{ header: "sample_id", inferred_type: "text" }],
      },
    ];
    const plan = folderImport.buildDeterministicPlan(profiles, "nhdot-mini");
    expect(plan.tables).toHaveLength(2);
    expect(plan.tables[0].columns[0].name).toBe("sample_id");
    expect(plan.tables[0].sources[0].file).toBe("2022/mix_samples.csv");
  });
});

describe("path rematch", () => {
  it("maps AI-wrong parent prefix to real relative path", () => {
    const profiles = [{ file: "2022/mix_samples.csv" }];
    const plan = {
      tables: [
        {
          key: "mix",
          columns: [],
          sources: [{ file: "NHDOT LabField/2022/mix_samples.csv", sheet: null }],
          fks: [],
        },
      ],
    };
    const rematched = folderImport.rematchPlanSources(plan, profiles);
    expect(rematched.tables[0].sources[0].file).toBe("2022/mix_samples.csv");
  });
});

describe("type inference / coerce", () => {
  it("infers integer and rejects bad doubles", () => {
    expect(folderImport.inferKind("air_voids", ["4.1", "3.8", "4.0"])).toBe("double precision");
    expect(folderImport.coerceValue("double precision", "not_a_number").ok).toBe(false);
    expect(folderImport.coerceValue("integer", "12").ok).toBe(true);
  });
});

describe("fixture folder import", () => {
  it("imports nhdot-mini deterministically with quarantine for bad rows", async () => {
    expect(fs.existsSync(fixtureRoot)).toBe(true);
    const { plan, profiles, skipped, folder } = await folderImport.analyzeFolder(
      fixtureRoot,
      () => {},
      { useAi: false },
    );
    expect(profiles.length).toBeGreaterThanOrEqual(2);
    expect(skipped.some((s) => /\.pdf$/i.test(s.file))).toBe(true);
    expect(plan.mode || "deterministic").toMatch(/deterministic/);

    const planForced = {
      ...plan,
      tables: plan.tables.map((t) => {
        if (!/mix/i.test(t.display_name)) return t;
        return {
          ...t,
          columns: t.columns.map((c) =>
            c.name === "air_voids" || c.source_header === "air_voids"
              ? { ...c, type: "double precision" }
              : c,
          ),
        };
      }),
    };
    const code = `TEST-${Date.now()}`;
    const result = await folderImport.executeImportPlan({
      folder,
      mode: "deterministic",
      projectInput: {
        project_name: "NHDOT Mini Fixture",
        project_code: code,
        description: "test",
      },
      tables: planForced.tables,
    });

    expect(result.projectId).toBeTruthy();
    expect(result.results.length).toBe(planForced.tables.length);
    const mix = result.results.find((r) => /mix/i.test(r.display_name));
    expect(mix).toBeTruthy();
    // Force double on air_voids: 4 CSV rows; one invalid ? 3 inserted
    expect(mix.inserted).toBe(3);
    expect(mix.invalid).toBe(1);
    expect(result.quarantine?.length).toBeGreaterThanOrEqual(1);

    const history = db.listImportHistory(result.projectId, 5);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].report.totals.invalid).toBeGreaterThanOrEqual(1);

    const datasets = db.listDatasets(result.projectId, "desc");
    expect(datasets.length).toBe(planForced.tables.length);
  }, 60000);

  it("rolls back datasets when import fails mid-job on existing project", async () => {
    const projectId = db.createProject({
      project_name: "Rollback Project",
      project_code: `RB-${Date.now()}`,
    });
    const before = db.listDatasets(projectId, "desc").length;
    await expect(
      folderImport.executeImportPlan({
        folder: fixtureRoot,
        projectId,
        mode: "deterministic",
        tables: [
          {
            key: "broken",
            display_name: "Broken",
            description: "",
            columns: [{ name: "x", type: "integer", source_header: "x" }],
            sources: [{ file: "does-not-exist-anywhere.csv", sheet: null, source_label: null }],
            fks: [],
            step: 1,
          },
        ],
      }),
    ).rejects.toThrow();
    // rematch throws if no tables left - or empty import still shouldn't orphan if create failed
    const after = db.listDatasets(projectId, "desc").length;
    expect(after).toBe(before);
  });
});

describe("query guard", () => {
  it("rejects DDL/DML", () => {
    expect(() => prepareProjectSelect("DROP TABLE projects", ["ds_x"])).toThrow();
    expect(() => prepareProjectSelect("DELETE FROM ds_x", ["ds_x"])).toThrow();
    expect(() => prepareProjectSelect("SELECT * FROM ds_x", ["ds_x"])).not.toThrow();
  });
});

describe("backup", () => {
  it("creates a backup file", () => {
    const dest = path.join(os.tmpdir(), `rdh-bak-${Date.now()}.sqlite3`);
    db.backupDatabase(dest);
    expect(fs.existsSync(dest)).toBe(true);
    fs.unlinkSync(dest);
  });
});
