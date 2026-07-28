const BLOCKED_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "call",
  "vacuum",
  "analyze",
  "comment",
  "cluster",
  "reindex",
  "listen",
  "notify",
  "refresh",
  "attach",
  "detach",
  "pragma",
];

const FORBIDDEN_TABLES = new Set([
  "settings",
  "projects",
  "datasets",
  "saved_queries",
  "export_history",
  "users",
  "sessions",
  "project_members",
  "pg_catalog",
  "information_schema",
]);

function stripSqlLiterals(sql: string) {
  return sql.replace(/'(?:''|[^'])*'/g, " '' ");
}

export function extractReferencedTables(sql: string): string[] {
  const stripped = stripSqlLiterals(sql.toLowerCase());
  const tables = new Set<string>();
  const re = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) tables.add(m[1]);
  return [...tables];
}

export function prepareProjectSelect(sql: string, allowedTableNames: string[]): string {
  let clean = String(sql ?? "").trim();
  if (clean.endsWith(";")) clean = clean.slice(0, -1).trim();
  if (clean === "") throw new Error("Query is empty");
  if (clean.includes(";")) throw new Error("Only a single statement is allowed");

  const lower = clean.toLowerCase();
  if (!/^(select|with)\s/.test(lower)) {
    throw new Error("Only SELECT / WITH queries are allowed");
  }
  for (const bad of BLOCKED_KEYWORDS) {
    if (new RegExp(`\\b${bad}\\b`).test(lower)) {
      throw new Error(`Query contains disallowed keyword: ${bad}`);
    }
  }

  const allowed = new Set(allowedTableNames);
  if (allowed.size === 0) throw new Error("This project has no datasets yet");

  const referenced = extractReferencedTables(clean);
  if (referenced.length === 0) {
    throw new Error("Query must reference at least one dataset table");
  }
  for (const t of referenced) {
    if (FORBIDDEN_TABLES.has(t)) {
      throw new Error(`Table ${t} is not allowed in project queries`);
    }
    if (!allowed.has(t)) {
      throw new Error(`Table ${t} is not part of this project`);
    }
  }
  return clean;
}
