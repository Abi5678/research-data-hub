import { describe, it, expect } from "vitest";
import {
  assistSystemPrompt,
  assistUserPrompt,
  parseAssistReply,
  truncateScript,
  SCRIPT_CHAR_LIMIT,
} from "../src/lib/script-assist";

const dataset = {
  display_name: "Ideal-RT 2025 — EL",
  column_schema: [
    { name: "row_id", type: "bigint" },
    { name: "el_rt_1_lvdt_mm", type: "double precision", original_name: "EL-RT-1 LVDT (mm)" },
    { name: "el_rt_1_force_kn", type: "double precision" },
  ],
  sampleRows: [
    { el_rt_1_lvdt_mm: 0, el_rt_1_force_kn: 0 },
    { el_rt_1_lvdt_mm: -0.000127, el_rt_1_force_kn: 0.001732 },
  ],
};

describe("assistUserPrompt", () => {
  const prompt = assistUserPrompt({
    code: "import pandas as pd\ndf = pd.read_csv('results2024.csv')\n",
    language: "python",
    dataset,
  });

  it("names the exact columns", () => {
    expect(prompt).toContain("el_rt_1_lvdt_mm");
    expect(prompt).toContain("el_rt_1_force_kn");
  });

  it("carries the original spreadsheet header so old references can be mapped", () => {
    expect(prompt).toContain("EL-RT-1 LVDT (mm)");
  });

  it("does not offer row_id as an analysis column", () => {
    expect(prompt).not.toContain("row_id");
  });

  it("includes the current script and sample rows", () => {
    expect(prompt).toContain("results2024.csv");
    expect(prompt).toContain("-0.000127");
  });

  it("mentions data.csv, which is where the runner puts the data", () => {
    expect(assistSystemPrompt("python")).toContain("data.csv");
    expect(prompt).toContain("data.csv");
  });

  it("passes a failed run's stderr back in", () => {
    const repair = assistUserPrompt({
      code: "x = 1",
      language: "python",
      dataset,
      failure: { stderr: "KeyError: 'Force (kN)'", exitCode: 1 },
    });
    expect(repair).toContain("KeyError: 'Force (kN)'");
    expect(repair).toContain("exit code 1");
  });
});

describe("truncateScript", () => {
  it("leaves short scripts alone", () => {
    expect(truncateScript("print(1)")).toEqual({ code: "print(1)", truncated: false });
  });

  it("caps long scripts and says so", () => {
    const r = truncateScript("x".repeat(SCRIPT_CHAR_LIMIT + 10));
    expect(r.truncated).toBe(true);
    expect(r.code).toHaveLength(SCRIPT_CHAR_LIMIT);
  });
});

describe("parseAssistReply", () => {
  it("extracts a fenced file", () => {
    const r = parseAssistReply("```python\nimport pandas as pd\ndf = pd.read_csv('data.csv')\n```");
    expect(r.code).toBe("import pandas as pd\ndf = pd.read_csv('data.csv')");
  });

  it("parses a reply wrapped in prose and keeps the notes", () => {
    const r = parseAssistReply(
      "Sure, here is the updated script:\n\n```\nprint(1)\n```\n\n- Pointed the load at data.csv",
    );
    expect(r.code).toBe("print(1)");
    expect(r.notes).toContain("Pointed the load at data.csv");
  });

  it("raises rather than returning prose to be run", () => {
    expect(() => parseAssistReply("I think you should change line 3.")).toThrow(/code block/i);
  });

  it("raises on an empty block", () => {
    expect(() => parseAssistReply("```\n\n```")).toThrow(/empty/i);
  });
});
