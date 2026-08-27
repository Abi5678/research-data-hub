"use strict";

// Shared SELECT guardrails for runProjectQuery (SQLite + future HTTP API).

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

const BLOCKED = new Set(BLOCKED_KEYWORDS);

const FORBIDDEN_TABLES = new Set([
  "settings",
  "projects",
  "datasets",
  "saved_queries",
  "analysis_views",
  "export_history",
  "sqlite_master",
  "sqlite_schema",
  "sqlite_temp_master",
  "users",
  "sessions",
  "project_members",
]);

// Words that can appear where a table name or table alias would, but are not
// one. Meeting any of them ends the current FROM/JOIN list.
const NOT_A_TABLE = new Set([
  "select",
  "with",
  "where",
  "group",
  "order",
  "having",
  "window",
  "limit",
  "offset",
  "union",
  "except",
  "intersect",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "natural",
  "outer",
  "on",
  "using",
  "as",
  "values",
  "when",
  "then",
  "else",
  "end",
  "and",
  "or",
  "not",
  "by",
  "for",
  "into",
  "returning",
  "set",
  "fetch",
  "case",
  "all",
  "distinct",
  "from",
]);

/**
 * Blank out string literals and remove SQL comments, so every scan below sees
 * code only. One pass, because stripping the two independently lets a quote
 * inside a comment — or a `--` inside a literal — swallow the rest of the
 * query, and anything swallowed is a table reference the guard never sees.
 * Quoted identifiers are kept: `FROM "settings"` still has to be caught.
 */
function stripSqlText(sql) {
  const s = String(sql ?? "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " '' ";
      continue;
    }
    if (c === '"' || c === "`") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === c) {
          if (s[j + 1] === c) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === "-" && s[i + 1] === "-") {
      while (i < s.length && s[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Lowercased tokens: `name` is always an identifier, `word` may be a keyword. */
function tokenize(sql) {
  const re = /"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_$]*)|(\S)/g;
  const out = [];
  let m;
  while ((m = re.exec(sql))) {
    if (m[1] !== undefined) out.push({ t: "name", v: m[1].replace(/""/g, '"').toLowerCase() });
    else if (m[2] !== undefined) out.push({ t: "name", v: m[2].toLowerCase() });
    else if (m[3] !== undefined) out.push({ t: "name", v: m[3].toLowerCase() });
    else if (m[4] !== undefined) out.push({ t: "word", v: m[4].toLowerCase() });
    else out.push({ t: "punct", v: m[5] });
  }
  return out;
}

/** Index just past the `(` at `i` and its matching `)`; length when unbalanced. */
function skipParens(toks, i) {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].t !== "punct") continue;
    if (toks[j].v === "(") depth++;
    else if (toks[j].v === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return toks.length;
}

function isIdent(tok) {
  return tok && (tok.t === "name" || (tok.t === "word" && !NOT_A_TABLE.has(tok.v)));
}

/**
 * Every table named in a FROM or JOIN clause (lowercase).
 *
 * The whole comma-separated list is walked, not just its first entry: with a
 * `\bfrom\s+(\w+)` match, `SELECT * FROM ds_x, settings` reported only `ds_x`
 * and the second table was never checked against the project — which reads the
 * settings row holding the API key, or users.password_hash in server mode.
 */
function extractReferencedTables(sql) {
  const toks = tokenize(stripSqlText(sql));
  const tables = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== "word" || (t.v !== "from" && t.v !== "join")) continue;
    let j = i + 1;
    for (;;) {
      const cur = toks[j];
      if (!cur) break;
      if (cur.t === "punct" && cur.v === "(") {
        j = skipParens(toks, j); // derived table — its own FROM is scanned by the outer loop
      } else if (isIdent(cur)) {
        tables.add(cur.v);
        j++;
        // schema.table — neither half may name a forbidden table
        while (toks[j] && toks[j].t === "punct" && toks[j].v === "." && isIdent(toks[j + 1])) {
          tables.add(toks[j + 1].v);
          j += 2;
        }
        // table-valued function, e.g. pragma_table_info('datasets')
        if (toks[j] && toks[j].t === "punct" && toks[j].v === "(") j = skipParens(toks, j);
      } else break;
      if (toks[j] && toks[j].t === "word" && toks[j].v === "as") j++;
      if (isIdent(toks[j])) j++; // alias
      if (toks[j] && toks[j].t === "punct" && toks[j].v === ",") {
        j++;
        continue;
      }
      break;
    }
  }
  return [...tables];
}

/**
 * Names bound by a leading WITH clause. SQLite and Postgres both resolve these
 * ahead of any real table, so they are not project datasets and must not be
 * checked against the dataset list — before this, every CTE was rejected as
 * "not part of this project", making WITH queries unusable despite being
 * explicitly allowed.
 */
function extractCteNames(sql) {
  const toks = tokenize(stripSqlText(sql));
  if (!toks.length || toks[0].t !== "word" || toks[0].v !== "with") return [];
  const names = [];
  let j = 1;
  if (toks[j] && toks[j].t === "word" && toks[j].v === "recursive") j++;
  for (;;) {
    if (!isIdent(toks[j])) break;
    const name = toks[j].v;
    j++;
    if (toks[j] && toks[j].t === "punct" && toks[j].v === "(") j = skipParens(toks, j); // column list
    if (!toks[j] || toks[j].t !== "word" || toks[j].v !== "as") break;
    j++;
    if (toks[j] && toks[j].t === "word" && toks[j].v === "not") j++;
    if (toks[j] && toks[j].t === "word" && toks[j].v === "materialized") j++;
    if (!toks[j] || toks[j].t !== "punct" || toks[j].v !== "(") break;
    names.push(name);
    j = skipParens(toks, j);
    if (toks[j] && toks[j].t === "punct" && toks[j].v === ",") {
      j++;
      continue;
    }
    break;
  }
  return names;
}

/**
 * A blocked keyword only matters where a statement could actually start: the
 * head of the query, or just inside an opening paren (`WITH x AS (DELETE …)`).
 * Scanning raw SQL for the bare word instead rejected ordinary data — a column
 * named `comment`, an alias named `copy`, a value like 'Update 2023'. The word
 * must also be followed by another token, so `upper(comment)` stays a column.
 */
function findBlockedKeyword(sql) {
  const s = stripSqlText(sql).toLowerCase();
  const re = /(?:^|\()\s*([a-z][a-z0-9_]*)\s+(?=[a-z_"'*(])/g;
  let m;
  while ((m = re.exec(s))) {
    if (BLOCKED.has(m[1])) return m[1];
    re.lastIndex = m.index + 1; // overlapping starts: "((delete from"
  }
  return null;
}

function prepareProjectSelect(sql, allowedTableNames) {
  let clean = String(sql ?? "").trim();
  if (clean.endsWith(";")) clean = clean.slice(0, -1).trim();
  if (clean === "") throw new Error("Query is empty");
  // A `;` inside a string literal cannot start a statement, so only code counts.
  if (stripSqlText(clean).includes(";")) {
    throw new Error("Only a single statement is allowed");
  }

  if (!/^(select|with)\s/.test(clean.toLowerCase())) {
    throw new Error("Only SELECT / WITH queries are allowed");
  }
  const blocked = findBlockedKeyword(clean);
  if (blocked) throw new Error(`Query contains disallowed keyword: ${blocked}`);

  const allowed = new Set(allowedTableNames);
  if (allowed.size === 0) {
    throw new Error("This project has no datasets yet");
  }

  const ctes = new Set(extractCteNames(clean));
  const referenced = extractReferencedTables(clean);
  let realTables = 0;

  for (const t of referenced) {
    // Checked before the CTE skip: a CTE must not be able to launder a name.
    if (FORBIDDEN_TABLES.has(t)) {
      throw new Error(`Table ${t} is not allowed in project queries`);
    }
    if (ctes.has(t)) continue;
    if (!allowed.has(t)) {
      throw new Error(`Table ${t} is not part of this project`);
    }
    realTables++;
  }
  if (realTables === 0) {
    throw new Error("Query must reference at least one dataset table");
  }

  return clean;
}

module.exports = {
  BLOCKED_KEYWORDS,
  FORBIDDEN_TABLES,
  extractCteNames,
  extractReferencedTables,
  prepareProjectSelect,
};
