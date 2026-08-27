"use strict";

// Finding the Python and MATLAB the user actually meant.
//
// PATH is not enough, and on a packaged Mac app it is barely anything: an app
// launched from Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin`, not the shell
// PATH, so Homebrew and pyenv are invisible. Verified on this machine, `matlab`
// is not on PATH at all while MATLAB R2026a is installed under /Applications,
// and `which -a python3` finds six interpreters of which only some have pandas.
//
// So: gather candidates from PATH *and* from the places these tools are
// actually installed, then probe each Python for the libraries that decide
// whether a research script runs. Guessing produces `ModuleNotFoundError:
// pandas` on a machine that has pandas, which is the least debuggable failure
// this feature could hand someone.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const IS_WIN = process.platform === "win32";
const PROBE_TIMEOUT_MS = 8000;

function run(file, args, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Directories matching a `R*`-style pattern, sorted newest-looking first, so a
 *  machine with several MATLAB releases offers the latest at the top. */
function globVersionDirs(parent, prefix) {
  try {
    return fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(prefix))
      .sort()
      .reverse()
      .map((n) => path.join(parent, n));
  } catch {
    return [];
  }
}

function pathDirs() {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function dedupe(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    let real = p;
    try {
      real = fs.realpathSync(p);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(p);
  }
  return out;
}

// ---------- python ----------

const PYTHON_LIBRARIES = ["pandas", "numpy", "matplotlib", "scipy"];

// Written as a real multi-line program rather than a semicolon one-liner so the
// try/except works; execFile passes it as one argv entry, no shell involved.
const PYTHON_PROBE = `
import sys, json
mods = {}
for m in ${JSON.stringify(PYTHON_LIBRARIES)}:
    try:
        __import__(m)
        mods[m] = True
    except Exception:
        mods[m] = False
print(json.dumps({"version": "%d.%d.%d" % sys.version_info[:3], "libraries": mods}))
`;

function pythonCandidatePaths(extraDirs = []) {
  const names = IS_WIN
    ? ["python.exe", "python3.exe"]
    : ["python3", "python3.13", "python3.12", "python3.11", "python3.10", "python"];
  const dirs = [
    ...extraDirs,
    ...pathDirs(),
    ...(IS_WIN
      ? [
          ...globVersionDirs(
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Python"),
            "Python3",
          ),
          ...globVersionDirs("C:\\", "Python3"),
        ]
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          ...globVersionDirs("/Library/Frameworks/Python.framework/Versions", "3").map((d) =>
            path.join(d, "bin"),
          ),
          ...globVersionDirs(path.join(os.homedir(), ".pyenv", "versions"), "3").map((d) =>
            path.join(d, "bin"),
          ),
        ]),
  ];
  const found = [];
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (isExecutableFile(p)) found.push(p);
    }
  }
  return dedupe(found);
}

async function probePython(binPath) {
  if (!isExecutableFile(binPath)) {
    return { path: binPath, ok: false, detail: "Not an executable file" };
  }
  const { err, stdout } = await run(binPath, ["-c", PYTHON_PROBE]);
  if (err) {
    return { path: binPath, ok: false, detail: err.killed ? "Timed out" : "Did not run" };
  }
  try {
    const info = JSON.parse(stdout.trim().split("\n").pop());
    const have = PYTHON_LIBRARIES.filter((m) => info.libraries[m]);
    return {
      path: binPath,
      ok: true,
      version: info.version,
      libraries: info.libraries,
      // What the picker shows. "none" is the important case to state out loud:
      // it is the interpreter that will fail on the first import.
      detail: `Python ${info.version} — ${have.length ? have.join(", ") : "no analysis libraries"}`,
    };
  } catch {
    return { path: binPath, ok: false, detail: "Unrecognized response" };
  }
}

// ---------- matlab ----------

function matlabCandidatePaths(extraDirs = []) {
  const name = IS_WIN ? "matlab.exe" : "matlab";
  const roots = IS_WIN
    ? [
        ...globVersionDirs("C:\\Program Files\\MATLAB", "R"),
        ...globVersionDirs("C:\\Program Files (x86)\\MATLAB", "R"),
      ]
    : process.platform === "darwin"
      ? globVersionDirs("/Applications", "MATLAB_R")
      : globVersionDirs("/usr/local/MATLAB", "R");
  const dirs = [
    ...extraDirs,
    ...pathDirs(),
    ...roots.map((r) => path.join(r, "bin")),
    // macOS installs are .app bundles; the binary is one level deeper.
    ...roots.map((r) => path.join(r, "Contents", "bin")),
  ];
  const found = [];
  for (const dir of dirs) {
    const p = path.join(dir, name);
    if (isExecutableFile(p)) found.push(p);
  }
  return dedupe(found);
}

/** The release, read off the install path. MATLAB's own `-batch "disp(version)"`
 *  takes 20-40 seconds to answer because it boots the whole engine, which is far
 *  too slow to do while a settings page is loading. Settings offers an explicit
 *  Test button for the real thing. */
function describeMatlab(binPath) {
  const release = binPath.match(/MATLAB[_/\\]?(R\d{4}[ab])/i);
  return {
    path: binPath,
    ok: true,
    version: release ? release[1] : null,
    detail: release ? `MATLAB ${release[1]}` : "MATLAB",
  };
}

async function testMatlab(binPath) {
  if (!isExecutableFile(binPath)) {
    return { ok: false, detail: "Not an executable file" };
  }
  // 90s: a cold MATLAB start is routinely 20-40s and slower on first launch
  // after boot, and a false "not working" here sends people to reinstall.
  const { err, stdout, stderr } = await run(binPath, ["-batch", "disp(version)"], 90000);
  if (err) {
    return {
      ok: false,
      detail: err.killed ? "MATLAB did not respond within 90s" : stderr.trim().slice(0, 300),
    };
  }
  return { ok: true, detail: `MATLAB ${stdout.trim().split("\n").pop()}` };
}

/**
 * Every candidate for both languages, probed where probing is cheap.
 * `selected` is the saved setting when it is still valid, otherwise the best
 * candidate — for Python, the one with the most analysis libraries.
 */
async function detect({ pythonSetting, matlabSetting } = {}) {
  const pythonPaths = pythonCandidatePaths(pythonSetting ? [path.dirname(pythonSetting)] : []);
  if (pythonSetting && !pythonPaths.includes(pythonSetting)) pythonPaths.unshift(pythonSetting);
  const python = await Promise.all(pythonPaths.map(probePython));

  const matlab = matlabCandidatePaths(matlabSetting ? [path.dirname(matlabSetting)] : []).map(
    describeMatlab,
  );

  const bestPython =
    python.find((c) => c.path === pythonSetting && c.ok) ??
    python
      .filter((c) => c.ok)
      .sort(
        (a, b) =>
          PYTHON_LIBRARIES.filter((m) => b.libraries[m]).length -
          PYTHON_LIBRARIES.filter((m) => a.libraries[m]).length,
      )[0];

  return {
    python: { candidates: python, selected: bestPython?.path ?? null },
    matlab: {
      candidates: matlab,
      selected: matlab.find((c) => c.path === matlabSetting)?.path ?? matlab[0]?.path ?? null,
    },
  };
}

module.exports = {
  detect,
  probePython,
  testMatlab,
  pythonCandidatePaths,
  matlabCandidatePaths,
  describeMatlab,
  isExecutableFile,
  globVersionDirs,
  PYTHON_LIBRARIES,
};
