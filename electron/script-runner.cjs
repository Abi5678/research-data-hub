"use strict";

// Runs a project's Python or MATLAB script against one of its datasets.
//
// The security shape matters more than anything else here: the renderer sends a
// script *id*, never a path. This module reads that script's text out of
// SQLite, writes it into a folder it constructs itself under userData, and
// executes that. Nothing the renderer says is ever passed to spawn(). The only
// path a user supplies is the file they pick in a dialog when importing, and
// that file is read once and copied into the database — never run, never
// modified.
//
// That is the boundary. Inside it, this is arbitrary code with the user's full
// privileges, exactly as if they had run it in a terminal. There is no sandbox
// and this module does not pretend to be one; the UI says so before the first
// run.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const db = require("./db.cjs");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Retained per stream. A runaway print loop should not put a gigabyte through
 *  IPC and into SQLite; the tail is what a traceback lives in. */
const MAX_LOG_BYTES = 1_000_000;
const MAX_OUTPUT_FILES = 200;
/** Grace between asking a process to stop and making it. */
const KILL_GRACE_MS = 5000;

let runsRoot = path.join(os.tmpdir(), "research-data-hub-script-runs");

/** Where run folders live. Set from main.cjs to Electron's userData; tests
 *  point it at a temp directory. */
function configure(opts = {}) {
  if (opts.runsRoot) runsRoot = opts.runsRoot;
  return runsRoot;
}

/** runId -> { child, cancelled, timedOut } for runs in flight. */
const active = new Map();

function slug(s) {
  return (
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "run"
  );
}

/** Keeps the last MAX_LOG_BYTES of a stream. Truncating the head rather than
 *  the tail is deliberate: the error is at the end. */
function makeLogBuffer() {
  let text = "";
  let dropped = false;
  return {
    push(chunk) {
      text += chunk;
      if (text.length > MAX_LOG_BYTES) {
        text = text.slice(text.length - MAX_LOG_BYTES);
        dropped = true;
      }
    },
    value() {
      return dropped ? `[earlier output truncated]\n${text}` : text;
    },
  };
}

function listFilesRecursive(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_OUTPUT_FILES) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFilesRecursive(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf"]);

function describeOutput(runDir, rel) {
  let size = 0;
  try {
    size = fs.statSync(path.join(runDir, rel)).size;
  } catch {
    /* raced with something; report it with an unknown size */
  }
  const ext = path.extname(rel).toLowerCase();
  return {
    name: rel,
    size,
    kind: IMAGE_EXT.has(ext) ? (ext === ".pdf" ? "pdf" : "image") : ext === ".csv" ? "csv" : "file",
  };
}

/**
 * The environment a script runs in.
 *
 * Inherited rather than stripped down, on purpose. A trimmed env is tidier but
 * breaks the two things most likely to be needed: MATLAB finds its licence
 * through LM_LICENSE_FILE / MLM_LICENSE_FILE, and conda and pyenv Pythons find
 * their own installs through variables a whitelist would drop. The overrides
 * are what actually matter:
 *
 *  - MPLBACKEND=Agg, or an existing script ending in plt.show() opens a window
 *    and blocks forever. That is the single most likely way a working script
 *    appears to hang, and it would look like our bug, not matplotlib's.
 *  - MPLCONFIGDIR, because matplotlib warns loudly when its default cache
 *    directory is not writable, which it often is not under a packaged app.
 *  - PYTHONUNBUFFERED, belt and braces with `-u`, so the live log fills as the
 *    script runs instead of all at once when it exits.
 */
function runEnv(runDir) {
  return {
    ...process.env,
    MPLBACKEND: "Agg",
    MPLCONFIGDIR: path.join(runDir, ".mplconfig"),
    PYTHONUNBUFFERED: "1",
  };
}

function spawnArgs(language, entryFilename, runDir, interpreter) {
  if (language === "python") {
    return { file: interpreter, args: ["-u", entryFilename] };
  }
  // -batch is the non-interactive form: no desktop, no splash, nonzero exit on
  // an uncaught error, diagnostics on stderr. It takes a *function name*, not a
  // filename, which is why entry_filename's stem is a valid identifier.
  return {
    file: interpreter,
    args: ["-sd", runDir, "-batch", path.basename(entryFilename, path.extname(entryFilename))],
  };
}

/**
 * Prepare a run folder: the dataset as CSV, the script as its entry file.
 * Split out from startRun so a test can inspect what a script would see.
 */
function prepareRun({ runId, script, datasets }) {
  const runDir = path.join(runsRoot, script.project_id, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const inputs = [];
  datasets.forEach((ds, i) => {
    const name = i === 0 ? "data.csv" : `data_${slug(ds.display_name)}.csv`;
    const written = db.writeDatasetCsv(ds.id, path.join(runDir, name));
    inputs.push({
      dataset_id: ds.id,
      display_name: ds.display_name,
      file: name,
      row_count: written.row_count,
      columns: written.columns,
    });
  });

  fs.writeFileSync(path.join(runDir, script.entry_filename), script.code, "utf8");
  // Not an output, and not something to offer back to the user as one.
  const seeded = new Set([script.entry_filename, ...inputs.map((i) => i.file)]);
  return { runDir, inputs, seeded };
}

/**
 * Run a script to completion. Resolves with the finished run row; a script that
 * fails is a resolved run with a nonzero exit code, not a rejection — a failing
 * analysis is an ordinary outcome the UI shows, not an app error.
 */
async function startRun({ runId, scriptId, datasetIds, interpreter, timeoutMs }, onEvent) {
  const script = db.getScript(scriptId);
  // Looked up within the script's own project rather than by bare id, so a
  // renderer cannot feed a script a dataset from somewhere else.
  const inProject = new Map(db.listDatasets(script.project_id).map((d) => [d.id, d]));
  const datasets = (datasetIds ?? []).map((id) => {
    const ds = inProject.get(id);
    if (!ds) throw new Error("Dataset is not part of this project");
    if (ds.unavailable_reason) {
      throw new Error(`"${ds.display_name}" cannot be read: ${ds.unavailable_reason}`);
    }
    return ds;
  });
  if (!interpreter) {
    throw new Error(
      script.language === "matlab"
        ? "No MATLAB chosen. Pick one under Settings."
        : "No Python chosen. Pick one under Settings.",
    );
  }

  const emit = (kind, text) => {
    try {
      onEvent?.({ runId, kind, text });
    } catch {
      /* a closed window must not take the run down with it */
    }
  };

  emit("status", "Preparing data…");
  const { runDir, inputs, seeded } = prepareRun({ runId, script, datasets });
  db.createScriptRun({ runId, scriptId, runDir, codeSnapshot: script.code, inputs });
  for (const i of inputs) {
    emit("status", `Wrote ${i.file} — ${i.row_count.toLocaleString()} rows`);
  }

  const { file, args } = spawnArgs(script.language, script.entry_filename, runDir, interpreter);
  emit(
    "status",
    script.language === "matlab"
      ? "Starting MATLAB — this takes 20-40 seconds…"
      : `Running ${script.entry_filename}…`,
  );

  const stdout = makeLogBuffer();
  const stderr = makeLogBuffer();
  const startedAt = Date.now();

  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd: runDir, env: runEnv(runDir), windowsHide: true });
    } catch (err) {
      resolve({ status: "failed", exitCode: null, spawnError: err.message });
      return;
    }
    const state = { child, cancelled: false, timedOut: false };
    active.set(runId, state);

    const timer = setTimeout(() => {
      state.timedOut = true;
      stop(runId);
    }, Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout.push(d);
      emit("stdout", d);
    });
    child.stderr.on("data", (d) => {
      stderr.push(d);
      emit("stderr", d);
    });

    // "close" is normally the right signal — it waits for stdout/stderr to
    // finish flushing, so the captured log is complete. But if the interpreter
    // leaves a grandchild holding those pipes open (MATLAB does this: it spawns
    // a background update-check service that inherits stdio and outlives the
    // batch run), "close" never fires at all even though the process is long
    // done — the run sits in "running" forever with its output already on
    // disk. So "exit" still wins if "close" doesn't show up shortly after it;
    // the grace period is just to give an on-time "close" first crack at it,
    // since it carries whatever final output arrived in that window.
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(runId);
      resolve({
        status: state.timedOut
          ? "timeout"
          : state.cancelled
            ? "cancelled"
            : code === 0
              ? "ok"
              : "failed",
        exitCode: code,
      });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(runId);
      resolve({ status: "failed", exitCode: null, spawnError: err.message });
    });
    child.on("exit", (code) => setTimeout(() => finish(code), 500));
    child.on("close", finish);
  });

  if (result.spawnError) {
    // "spawn ENOENT" tells a researcher nothing. Name the thing that is missing.
    stderr.push(`Could not start ${file}: ${result.spawnError}\n`);
    emit("stderr", `Could not start ${file}: ${result.spawnError}\n`);
  }

  const outputs = listFilesRecursive(runDir)
    .filter((rel) => !seeded.has(rel) && !rel.startsWith(".mplconfig" + path.sep))
    .map((rel) => describeOutput(runDir, rel));

  const finished = db.finishScriptRun(runId, {
    status: result.status,
    exitCode: result.exitCode,
    stdout: stdout.value(),
    stderr: stderr.value(),
    outputs,
  });
  emit("status", `${result.status} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return finished;
}

/** Ask a run to stop, then make it. Returns false if it already finished. */
function stop(runId) {
  const state = active.get(runId);
  if (!state) return false;
  state.cancelled = state.cancelled || !state.timedOut;
  state.child.kill("SIGTERM");
  setTimeout(() => {
    if (active.has(runId)) state.child.kill("SIGKILL");
  }, KILL_GRACE_MS).unref?.();
  return true;
}

/**
 * Read one file out of a run folder, for showing a figure inline.
 *
 * `name` comes from the renderer, so it is resolved and checked to be inside
 * the run folder — a name like `../../../.ssh/id_rsa` must not read anything.
 */
function readRunFile(runId, name) {
  const run = db.getScriptRun(runId);
  const full = path.resolve(run.run_dir, name);
  const root = path.resolve(run.run_dir);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("File is outside the run folder");
  }
  const stat = fs.statSync(full);
  if (stat.size > 25 * 1024 * 1024) throw new Error("File is too large to preview");
  return {
    name,
    size: stat.size,
    base64: fs.readFileSync(full).toString("base64"),
  };
}

function removeRunDirs(dirs) {
  for (const dir of dirs ?? []) {
    const full = path.resolve(dir);
    // Only ever inside our own runs root, whatever the caller passed.
    if (full.startsWith(path.resolve(runsRoot) + path.sep)) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
}

module.exports = {
  configure,
  startRun,
  stop,
  readRunFile,
  removeRunDirs,
  prepareRun,
  runEnv,
  spawnArgs,
  DEFAULT_TIMEOUT_MS,
};
