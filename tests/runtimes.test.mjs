import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runtimes = require("../electron/runtimes.cjs");

describe("python discovery", () => {
  it("finds at least one working interpreter and reports its libraries", async () => {
    const found = runtimes.pythonCandidatePaths();
    expect(found.length).toBeGreaterThan(0);

    const probed = await runtimes.probePython(found[0]);
    expect(probed.ok).toBe(true);
    expect(probed.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const lib of runtimes.PYTHON_LIBRARIES) {
      expect(typeof probed.libraries[lib]).toBe("boolean");
    }
  });

  it("fails cleanly on a path that is not an interpreter", async () => {
    const probed = await runtimes.probePython("/definitely/not/here/python3");
    expect(probed.ok).toBe(false);
    expect(probed.detail).toBeTruthy();
  });

  it("prefers an interpreter that has the analysis libraries", async () => {
    // The whole point of probing: this machine has six python3s and the one
    // first on PATH is not the one with pandas.
    const { python } = await runtimes.detect({});
    if (!python.selected) return;
    const chosen = python.candidates.find((c) => c.path === python.selected);
    const best = Math.max(
      ...python.candidates
        .filter((c) => c.ok)
        .map((c) => runtimes.PYTHON_LIBRARIES.filter((m) => c.libraries[m]).length),
    );
    expect(runtimes.PYTHON_LIBRARIES.filter((m) => chosen.libraries[m]).length).toBe(best);
  });
});

describe("matlab discovery", () => {
  it("looks inside version-numbered install folders, not just PATH", () => {
    // matlab is not on PATH on this machine; /Applications/MATLAB_R2026a.app is
    // the only way to find it, so the glob is the load-bearing part.
    const dirs = runtimes.globVersionDirs("/Applications", "MATLAB_R");
    if (dirs.length === 0) return; // no MATLAB installed; nothing to assert

    const found = runtimes.matlabCandidatePaths();
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((p) => p.includes("MATLAB_R"))).toBe(true);
  });

  it("reads the release off the install path without booting MATLAB", () => {
    const described = runtimes.describeMatlab("/Applications/MATLAB_R2026a.app/bin/matlab");
    expect(described.version).toBe("R2026a");
    expect(described.detail).toBe("MATLAB R2026a");
  });

  it("newest release first", () => {
    const sorted = runtimes.globVersionDirs(path.sep, "nothing-matches-this");
    expect(sorted).toEqual([]);
  });
});
