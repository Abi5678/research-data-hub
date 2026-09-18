import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("../electron/db.cjs");
const runner = require("../electron/script-runner.cjs");
const runtimes = require("../electron/runtimes.cjs");

let tmpDir;
let projectId;
let datasetId;
/** A real interpreter on this machine, preferring one that has pandas. */
let python;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rdh-scripts-"));
  db.open(path.join(tmpDir, "hub.sqlite3"));
  runner.configure({ runsRoot: path.join(tmpDir, "runs") });

  projectId = db.createProject({ project_code: "SCRIPTS", project_name: "Scripts test" });
  const ds = db.createProjectDataset({
    projectId,
    displayName: "Mix results",
    sourceFilename: "mix.csv",
    columns: [
      { name: "sample_id", type: "text" },
      { name: "air_voids", type: "double precision" },
      { name: "note", type: "text" },
    ],
  });
  datasetId = ds.dataset_id;
  db.insertDatasetRowsTyped(datasetId, [
    { sample_id: "A-1", air_voids: 4.2, note: "ok" },
    { sample_id: "A-2", air_voids: 5.75, note: 'has "quotes", and a comma' },
    { sample_id: "A-3", air_voids: null, note: "line\nbreak" },
  ]);

  const detected = await runtimes.detect({});
  python = detected.python.selected;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeScript(code, language = "python", name = "analysis") {
  return db.createScript({ projectId, name, language, code });
}

async function run(script, opts = {}) {
  const events = [];
  const result = await runner.startRun(
    {
      runId: `run-${Math.random().toString(36).slice(2)}`,
      scriptId: script.id,
      datasetIds: [datasetId],
      interpreter: python,
      timeoutMs: 30000,
      ...opts,
    },
    (e) => events.push(e),
  );
  return { result, events };
}

describe("writeDatasetCsv", () => {
  it("writes every row with a header matching column_schema, escaping CSV specials", () => {
    const out = path.join(tmpDir, "out.csv");
    const written = db.writeDatasetCsv(datasetId, out);

    expect(written.row_count).toBe(3);
    expect(written.columns).toEqual(["sample_id", "air_voids", "note"]);

    const text = fs.readFileSync(out, "utf8");
    expect(text.split("\n")[0]).toBe("sample_id,air_voids,note");
    // Quotes doubled, embedded comma and newline kept inside quotes, NULL blank.
    expect(text).toContain('"has ""quotes"", and a comma"');
    expect(text).toContain('"line\nbreak"');
    expect(text).toContain("A-3,,");
  });
});

describe("script entry filenames", () => {
  it("produces a MATLAB-invocable identifier", () => {
    // -batch takes a function name, so a leading digit or punctuation would
    // make a file that exists but cannot be called.
    expect(db.scriptEntryFilename("2024 mix analysis", "matlab")).toBe("s_2024_mix_analysis.m");
    expect(db.scriptEntryFilename("plot-voids.py", "python")).toBe("plot_voids.py");
  });
});

describe("startRun", () => {
  it("runs a script that reads the dataset and captures its stdout", async () => {
    const script = makeScript(
      "import csv\n" +
        "rows = list(csv.DictReader(open('data.csv')))\n" +
        "print('rows', len(rows))\n" +
        "print('cols', ','.join(rows[0].keys()))\n",
    );
    const { result, events } = await run(script);

    expect(result.status).toBe("ok");
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("rows 3");
    expect(result.stdout).toContain("cols sample_id,air_voids,note");
    expect(result.inputs[0]).toMatchObject({ file: "data.csv", row_count: 3 });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.run_dir, "inputs.json"), "utf8"),
    );
    expect(manifest.inputs[0].file).toBe("data.csv");
    expect(manifest.inputs[0].display_name).toBe("Mix results");
    // The live log streamed rather than arriving only at exit.
    expect(events.some((e) => e.kind === "stdout")).toBe(true);
  });

  it("records a failing script as a finished run with its traceback, not an error", async () => {
    const script = makeScript("raise ValueError('no column called mix_id')\n");
    const { result } = await run(script);

    expect(result.status).toBe("failed");
    expect(result.exit_code).not.toBe(0);
    expect(result.stderr).toContain("no column called mix_id");
  });

  it("detects files the script wrote as outputs, and ignores the ones we seeded", async () => {
    const script = makeScript(
      "open('figure.png','wb').write(b'\\x89PNG fake')\n" +
        "open('summary.csv','w').write('a,b\\n1,2\\n')\n",
    );
    const { result } = await run(script);

    expect(result.status).toBe("ok");
    const names = result.outputs.map((o) => o.name).sort();
    expect(names).toEqual(["figure.png", "summary.csv"]);
    expect(result.outputs.find((o) => o.name === "figure.png").kind).toBe("image");
    expect(result.outputs.find((o) => o.name === "summary.csv").kind).toBe("csv");
    // data.csv and the script itself are inputs, not results.
    expect(names).not.toContain("data.csv");
    expect(names).not.toContain("inputs.json");
  });

  it("kills a script that runs past its timeout", async () => {
    const script = makeScript("import time\ntime.sleep(60)\n");
    const { result } = await run(script, { timeoutMs: 1500 });

    expect(result.status).toBe("timeout");
  });

  it("snapshots the code that ran, so a later edit cannot rewrite history", async () => {
    const script = makeScript("print('first version')\n");
    const { result } = await run(script);
    db.updateScript(script.id, { code: "print('edited since')\n" });

    expect(db.getScriptRun(result.id).code_snapshot).toBe("print('first version')\n");
  });

  it("refuses a dataset from another project", async () => {
    const otherProject = db.createProject({ project_code: "OTHER", project_name: "Other" });
    const otherDs = db.createProjectDataset({
      projectId: otherProject,
      displayName: "Elsewhere",
      columns: [{ name: "x", type: "integer" }],
    });
    const script = makeScript("print('should not run')\n");

    await expect(
      run(script, { datasetIds: [otherDs.dataset_id] }),
    ).rejects.toThrow(/not part of this project/i);
  });

  it("names the missing interpreter instead of failing with spawn ENOENT", async () => {
    const script = makeScript("print('hi')\n");
    const { result } = await run(script, { interpreter: path.join(tmpDir, "no-such-python") });

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("Could not start");
  });
});

describe("run environment", () => {
  it("forces a headless matplotlib backend", () => {
    // Without this an existing script ending in plt.show() blocks forever and
    // looks like the app has hung.
    expect(runner.runEnv("/tmp/x").MPLBACKEND).toBe("Agg");
  });

  it("invokes MATLAB by function name, not filename", () => {
    const { args } = runner.spawnArgs("matlab", "mix_analysis.m", "/runs/1", "/bin/matlab");
    expect(args).toEqual(["-sd", "/runs/1", "-batch", "mix_analysis"]);
  });
});

describe("readRunFile", () => {
  it("reads a file the script wrote", async () => {
    const script = makeScript("open('note.txt','w').write('hello')\n");
    const { result } = await run(script);
    expect(Buffer.from(runner.readRunFile(result.id, "note.txt").base64, "base64").toString()).toBe(
      "hello",
    );
  });

  it("refuses to escape the run folder", async () => {
    const script = makeScript("print('ok')\n");
    const { result } = await run(script);
    expect(() => runner.readRunFile(result.id, "../../../../etc/hosts")).toThrow(
      /outside the run folder/i,
    );
  });
});
