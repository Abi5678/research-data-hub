import type { ColumnSchema } from "@/lib/csv";

/**
 * Turns plain-English questions into a guarded SELECT plus a spoken answer.
 *
 * The model never touches the database: it proposes SQL, the app runs it through
 * runProjectQuery (SELECT-only, project tables only), and the rows come back for
 * a grounded second pass. A wrong guess is a failed query, not a data change.
 */

export type ChatTable = {
  table_name: string;
  display_name: string;
  /** Null for a combined dataset, whose rows are never counted up front. */
  row_count: number | null;
  column_schema: ColumnSchema[];
};

export type ChatPlan = {
  /** Null when the question needs no data (definitions, follow-ups, chit-chat). */
  sql: string | null;
  /** Shown while the query runs, and kept if the query returns nothing. */
  answer: string;
  chart: { kind: "bar" | "line" | "scatter"; x: string; y: string } | null;
};

export const CHAT_ROW_LIMIT = 500;
/** Initial attempt plus model-driven repairs from the database error. */
export const CHAT_REPAIR_ATTEMPTS = 3;
/** Rows fed back to the model for the grounded answer. */
export const CHAT_CONTEXT_ROWS = 40;

function describeTable(t: ChatTable): string {
  const cols = t.column_schema
    .filter((c) => c.name !== "row_id")
    .map((c) => {
      const label = c.original_name?.trim();
      const friendly = label && label !== c.name ? ` -- "${label}"` : "";
      return `    ${c.name} ${c.type}${friendly}`;
    })
    .join("\n");
  // An unknown count is described as such rather than as zero: a model told a
  // table has no rows will route around it, and a combined view is often the
  // biggest table in the project.
  const size =
    t.row_count === null ? "combined from other tables" : `${t.row_count.toLocaleString()} rows`;
  return `  ${t.table_name}  (${size}) -- ${t.display_name}\n${cols}`;
}

export function buildSchemaPrompt(tables: ChatTable[]): string {
  return tables.map(describeTable).join("\n\n");
}

/** How many tables the model is shown for one question. */
export const CHAT_MAX_TABLES = 5;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "what", "which", "show", "give", "have", "has",
  "how", "many", "much", "does", "did", "was", "were", "are", "is", "all",
  "each", "per", "from", "that", "this", "these", "those", "across", "average",
  "avg", "mean", "highest", "lowest", "max", "min", "top", "bottom", "compare",
  "between", "over", "under", "about", "into", "list", "find", "there", "their",
  "them", "they", "you", "your", "can", "any", "who", "when", "where", "why",
]);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * A small local model loses track of a 200-column schema, so show it only the
 * tables whose names and headers actually overlap the question. Ties and
 * no-match questions fall back to the biggest tables, which is where the real
 * measurements live.
 */
export function selectRelevantTables(
  tables: ChatTable[],
  question: string,
  max = CHAT_MAX_TABLES,
): ChatTable[] {
  if (tables.length <= max) return tables;
  const qTerms = terms(question);

  const scored = tables.map((t) => {
    const haystack = terms(
      [
        t.table_name,
        t.display_name,
        ...t.column_schema.flatMap((c) => [c.name, c.original_name ?? ""]),
      ].join(" "),
    );
    const bag = new Set(haystack);
    let score = 0;
    for (const term of qTerms) {
      if (bag.has(term)) score += 2;
      else if (haystack.some((h) => h.includes(term) || term.includes(h))) score += 1;
    }
    return { table: t, score };
  });

  // Size only breaks ties between equally relevant tables. An uncounted
  // combined view sorts as if it were empty, which costs it nothing but the
  // tiebreak against a table the question matched just as well.
  scored.sort((a, b) => b.score - a.score || (b.table.row_count ?? 0) - (a.table.row_count ?? 0));
  return scored.slice(0, max).map((s) => s.table);
}

export function planSystemPrompt(tables: ChatTable[]): string {
  return `You help a pavement-research team explore their own data. They are not SQL users, so answer like a knowledgeable colleague, not a database manual.

These are the ONLY tables you may query (SQLite). The comment after each column is the original spreadsheet header:

${buildSchemaPrompt(tables)}

Rules:
1. Write ONE SQLite SELECT statement. No INSERT/UPDATE/DELETE/CREATE/DROP/PRAGMA/ATTACH, no semicolons, no CTEs, no comma-joins — use explicit JOIN ... ON.
2. Only reference the table and column names listed above, exactly as spelled.
3. Numeric columns may contain empty strings; guard aggregates with WHERE <col> != '' when averaging.
4. Prefer readable output: alias columns to friendly names, round long decimals, ORDER BY something sensible, and LIMIT to at most ${CHAT_ROW_LIMIT} rows.
5. If the question does not need data at all, set "sql" to null and just answer.
6. Suggest a chart only when the result is naturally visual; x and y must be column aliases you SELECTed.

Respond with ONLY a JSON object:
{
  "answer": string,        // one or two plain sentences describing what you are about to show
  "sql": string | null,
  "chart": { "kind": "bar" | "line" | "scatter", "x": string, "y": string } | null
}`;
}

/**
 * Small local models routinely invent a column name. The database's own error is
 * the cheapest correction signal available, so hand it straight back.
 */
export function repairPrompt(failedSql: string, error: string): string {
  return `That query failed.

SQL you wrote:
${failedSql}

Database error:
${error}

Rewrite it using ONLY the table and column names from the schema above, spelled exactly. Respond with the same JSON shape as before.`;
}

/** Turns SQLite/Postgres jargon into something a researcher can act on. */
export function friendlyQueryError(error: string): string {
  const noColumn = error.match(/no such column:?\s*([\w.]+)/i);
  if (noColumn) {
    return `I couldn't find a column called "${noColumn[1]}" in this project, so I couldn't answer that. Try naming the table or measurement you mean — or check the Datasets tab for the exact wording.`;
  }
  const noTable = error.match(/no such table:?\s*([\w.]+)/i);
  if (noTable) {
    return `I looked for a table called "${noTable[1]}" and it isn't in this project. Try mentioning one of the tables listed under Datasets.`;
  }
  if (/not part of this project|not allowed/i.test(error)) {
    return "That question would need data outside this project, so I stopped. Try asking about this project's own tables.";
  }
  return `I couldn't complete that lookup: ${error}`;
}

export function answerSystemPrompt(): string {
  return `You are helping a pavement-research team read their own query results. Answer the question directly in 1-4 short sentences, quoting the actual numbers you were given. Round sensibly and include units when the column name implies them. If the rows do not answer the question, say so plainly. No markdown headings, no code, no preamble.`;
}

/** Pulls a JSON object out of a reply that may carry prose or code fences. */
export function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("The assistant did not return a usable answer. Try rephrasing the question.");
  }
  return JSON.parse(t.slice(start, end + 1));
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|pragma|attach|detach|grant|revoke|vacuum|replace)\b/i;

/**
 * Local sanity check so obvious mistakes fail with a readable message instead of
 * a guard error. runProjectQuery remains the real security boundary.
 */
export function normalizePlanSql(raw: string): string {
  let sql = String(raw ?? "").trim();
  const fence = sql.match(/```(?:sql)?\s*([\s\S]*?)```/);
  if (fence?.[1]) sql = fence[1].trim();
  sql = sql.replace(/;\s*$/, "").trim();
  if (!sql) throw new Error("The assistant returned an empty query.");
  if (!/^select\s/i.test(sql)) {
    throw new Error("The assistant tried something other than a read-only lookup, so it was blocked.");
  }
  if (FORBIDDEN.test(sql)) {
    throw new Error("The assistant tried to modify data, so the request was blocked.");
  }
  return sql;
}

export function parseChatPlan(reply: string): ChatPlan {
  const raw = extractJsonObject(reply) as Record<string, unknown>;
  const answer = typeof raw.answer === "string" && raw.answer.trim() ? raw.answer.trim() : "";
  const sql = typeof raw.sql === "string" && raw.sql.trim() ? normalizePlanSql(raw.sql) : null;

  let chart: ChatPlan["chart"] = null;
  const c = raw.chart as Record<string, unknown> | null | undefined;
  if (c && typeof c === "object") {
    const kind = c.kind;
    if ((kind === "bar" || kind === "line" || kind === "scatter") &&
        typeof c.x === "string" && typeof c.y === "string" && c.x && c.y) {
      chart = { kind, x: c.x, y: c.y };
    }
  }
  return { sql, answer: answer || "Here's what I found.", chart };
}

/** Compact table text so the model answers from real numbers, not guesses. */
export function rowsForContext(
  rows: Record<string, unknown>[],
  columns: string[],
  limit = CHAT_CONTEXT_ROWS,
): string {
  if (rows.length === 0) return "(no rows)";
  const head = rows.slice(0, limit);
  const lines = [columns.join(" | ")];
  for (const r of head) {
    lines.push(columns.map((c) => formatCell(r[c])).join(" | "));
  }
  if (rows.length > head.length) {
    lines.push(`... ${rows.length - head.length} more rows not shown`);
  }
  return lines.join("\n");
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
  }
  return String(v);
}

export const CHAT_SUGGESTIONS = [
  "What tables do I have and what's in them?",
  "Which mix has the highest average fracture energy?",
  "Compare average fracture energy across all mixes",
  "Show how fracture energy varies with test temperature",
];
