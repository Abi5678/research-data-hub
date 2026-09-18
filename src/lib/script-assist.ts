import type { ColumnSchema } from "@/lib/csv";

/**
 * Adapts an existing analysis script to a dataset in this project.
 *
 * The model never runs anything: it returns a rewritten file, the app diffs it
 * against the current source, and the user accepts or discards. Nothing reaches
 * the runner without a human having read the diff.
 */

/** Long scripts are truncated rather than refused; the model is told so. */
export const SCRIPT_CHAR_LIMIT = 24000;
/** Sample rows sent for context. Everything else stays on this machine. */
export const SAMPLE_ROWS = 5;

export type AssistDataset = {
  display_name: string;
  column_schema: ColumnSchema[];
  sampleRows: Record<string, unknown>[];
};

function describeColumns(columns: ColumnSchema[]): string {
  return columns
    .filter((c) => c.name !== "row_id")
    .map((c) => {
      const label = c.original_name?.trim();
      const friendly = label && label !== c.name ? `  (spreadsheet header: "${label}")` : "";
      return `  ${c.name}  ${c.type}${friendly}`;
    })
    .join("\n");
}

function describeRows(dataset: AssistDataset): string {
  const cols = dataset.column_schema.filter((c) => c.name !== "row_id").map((c) => c.name);
  if (dataset.sampleRows.length === 0) return "(no sample rows available)";
  const lines = [cols.join(",")];
  for (const row of dataset.sampleRows.slice(0, SAMPLE_ROWS)) {
    lines.push(cols.map((c) => formatCell(row[c])).join(","));
  }
  return lines.join("\n");
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

export function truncateScript(code: string): { code: string; truncated: boolean } {
  if (code.length <= SCRIPT_CHAR_LIMIT) return { code, truncated: false };
  return { code: code.slice(0, SCRIPT_CHAR_LIMIT), truncated: true };
}

export function assistSystemPrompt(language: "python" | "matlab"): string {
  const lang = language === "matlab" ? "MATLAB" : "Python";
  return `You adapt existing ${lang} analysis scripts so they run against a specific dataset.

The script runs with its working directory set to a folder that already contains the selected datasets as CSV files and an inputs.json manifest listing each file's display name. The first dataset is data.csv. It has no network access and no other input files.

Rules:
1. Change the data-loading line(s) to read data.csv (and other files from inputs.json) from the working directory. Do not use an absolute path.
2. Use ONLY the column names listed, spelled exactly. Rename references to old headers accordingly.
3. Change nothing else. Keep the author's structure, comments, variable names and analysis intent intact.
4. Do not add network calls, file deletion, shell commands, or installs.
5. Save figures and result tables to files in the working directory rather than displaying them interactively.

Reply with the COMPLETE rewritten file inside a single fenced code block, then a short plain-English list of what you changed. No other code blocks.`;
}

export function assistUserPrompt(args: {
  code: string;
  language: "python" | "matlab";
  dataset: AssistDataset;
  /** Set when re-asking after a failed run. */
  failure?: { stderr: string; exitCode: number | null };
}): string {
  const { code, truncated } = truncateScript(args.code);
  const parts = [
    `Dataset: ${args.dataset.display_name}`,
    ``,
    `This dataset is written to data.csv in the run folder. Other selected tables are listed in inputs.json.`,
    ``,
    `Columns in data.csv:`,
    describeColumns(args.dataset.column_schema),
    ``,
    `First ${SAMPLE_ROWS} rows of data.csv:`,
    describeRows(args.dataset),
    ``,
  ];

  if (args.failure) {
    parts.push(
      `The script below was run against this data and failed (exit code ${args.failure.exitCode ?? "unknown"}). Fix the cause of this error:`,
      ``,
      args.failure.stderr.slice(-4000),
      ``,
    );
  }

  parts.push(
    `Current script:`,
    "```",
    code,
    "```",
    truncated
      ? `\n(The script was truncated at ${SCRIPT_CHAR_LIMIT} characters. Return only the part you were shown, rewritten.)`
      : "",
  );
  return parts.join("\n");
}

export type AssistResult = { code: string; notes: string };

/**
 * Pulls the rewritten file out of the reply. A response with no fence is an
 * error rather than a best guess: the alternative is handing the user a diff
 * against the model's prose, which they might accept.
 */
export function parseAssistReply(reply: string): AssistResult {
  const fence = reply.match(/```[^\n]*\n([\s\S]*?)```/);
  if (!fence?.[1]) {
    throw new Error(
      "The assistant did not return a code block, so there is nothing to review. Try again.",
    );
  }
  const code = fence[1].replace(/\s+$/, "");
  if (!code.trim()) {
    throw new Error("The assistant returned an empty script.");
  }
  const notes = reply.slice(fence.index! + fence[0].length).trim();
  return { code, notes };
}
