"use strict";

// Recipe -> SQL for combined datasets.
//
// Pure: no database handle. The same generator serves view creation in db.cjs
// (which runs at open(), with no renderer alive) and the SQL preview shown in
// the builder, which reaches it over IPC. It lives here in CJS rather than
// src/lib because electron/*.cjs cannot import TypeScript from src/.
//
// A recipe is a list of branches stacked with UNION ALL. Each branch is a
// spine table plus zero or more joins hanging off it, and maps its own columns
// onto a shared output shape. One uniform branch shape covers both things the
// user asked for: joins add columns, extra branches add rows.

const { FORBIDDEN_TABLES } = require("./query-guard.cjs");

// Branch n's row_id is STRIDE*n plus the spine's row_id. That keeps row_id an
// INTEGER (global-search.tsx:86 runs Number() on it), unique across UNION ALL
// branches, and — unlike ROW_NUMBER() OVER (), which was measured turning every
// filtered read into a full scan of every branch — it still lets SQLite push a
// WHERE down into each branch and use that branch's index.
//
// A join that fans out repeats its spine row_id across the rows it multiplies
// into. That is real but bounded: fan-out already requires explicit
// acknowledgement in the preflight, and row_id here is a display and list-key
// column, never data and never an edit target (combined datasets are read-only).
const ROW_ID_STRIDE = 1000000000000;
const PROVENANCE_COLUMN = "source_dataset";

// The generator owns these two output names, so a source column of the same
// name gets suffixed out of the way rather than colliding.
const RESERVED_OUTPUT_COLUMNS = ["row_id", PROVENANCE_COLUMN];

// Port of public.sanitize_ident(), kept byte-identical to db.cjs:34 so a
// combined view's column names land in the same [a-z0-9_] space as an
// imported dataset's.
function sanitizeIdent(s) {
  const cleaned = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned === "" ? "col" : cleaned;
}

function quoteIdent(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function quoteLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** Every table_name a recipe reads from, deduped. Feeds the scope check, the
 *  preflight, and the drop/detach dependency guards. */
function referencedTables(recipe) {
  const out = [];
  for (const b of recipe?.branches ?? []) {
    if (b?.spine) out.push(b.spine);
    for (const j of b?.joins ?? []) if (j?.table) out.push(j.table);
  }
  return [...new Set(out)];
}

/**
 * Reject a recipe that reaches outside its project.
 *
 * The query guard (query-guard.cjs:285) only checks the table *names* written
 * in the submitted SQL — it never resolves a view's body. So a saved view is a
 * permanent hole: once `cb_x` is in the project's datasets, `SELECT * FROM cb_x`
 * passes the guard no matter what the view reads underneath. Recipes are only
 * ever built through dataset pickers, but the recipe is JSON in a file the user
 * can edit, so this is checked on save *and* again at mount.
 */
function assertRecipeScope(recipe, allowedTableNames) {
  const allowed = new Set(allowedTableNames);
  for (const t of referencedTables(recipe)) {
    if (FORBIDDEN_TABLES.has(t)) {
      throw new Error(`Table ${t} is not allowed in a combined dataset`);
    }
    if (!allowed.has(t)) {
      throw new Error(`Table ${t} is not part of this project`);
    }
  }
}

/**
 * Fill in defaults and make the output column names unique.
 *
 * This only guarantees the recipe is structurally usable — that the SQL it
 * generates references nothing it hasn't defined. Whether the tables and
 * columns exist, and whether the join is *correct*, is the preflight's job,
 * which reports rather than throws.
 */
function normalizeRecipe(raw) {
  const rawBranches = raw?.branches ?? [];
  if (rawBranches.length === 0) {
    throw new Error("A combined dataset needs at least one dataset to build on");
  }

  // Output names are their own namespace, so two sources can both offer a
  // column called `value` without either being renamed away silently.
  const taken = new Set(RESERVED_OUTPUT_COLUMNS);
  const columns = (raw?.columns ?? []).map((c) => {
    const base = sanitizeIdent(c.name);
    let name = base;
    let n = 2;
    while (taken.has(name)) {
      name = `${base}_${n}`;
      n += 1;
    }
    taken.add(name);
    return { name, originalName: c.name, type: c.type ?? "text" };
  });

  const branches = rawBranches.map((b, i) => {
    if (!b?.spine) throw new Error(`Dataset ${i + 1} in this combination is missing a table`);
    const joins = (b.joins ?? []).map((j, k) => {
      if (!j?.table) throw new Error(`Join ${k + 1} is missing a table`);
      return {
        id: j.id ?? `j${k + 1}`,
        table: j.table,
        leftFrom: j.leftFrom || "spine",
        leftColumn: j.leftColumn ?? "",
        rightColumn: j.rightColumn ?? "",
        // LEFT is the default because an INNER join silently drops the spine
        // rows that didn't match, the quietest way to end up with a wrong table.
        type: j.type === "inner" ? "inner" : "left",
        // Native compare is indexable; a cast is only emitted when the recipe
        // explicitly asks, and the preflight shows what each choice matches.
        keyCompare: j.keyCompare === "text" ? "text" : "native",
      };
    });
    const sources = new Set(["spine", ...joins.map((j) => j.id)]);

    // Keyed by *target* name, never positional, so a source that is missing a
    // column yields a missing key rather than a short list — one column cannot
    // shift its neighbours' values into the wrong field. Both a missing key and
    // an explicit null mean "absent in this branch"; the preflight reports them.
    const map = {};
    for (const c of columns) {
      const src = b.map?.[c.name] ?? b.map?.[c.originalName] ?? null;
      if (src && !sources.has(src.from)) {
        throw new Error(
          `Column "${c.name}" reads from "${src.from}", which this dataset does not join in`,
        );
      }
      map[c.name] = src && src.column ? { from: src.from, column: src.column } : null;
    }
    return { id: b.id ?? `b${i + 1}`, label: b.label || b.spine, spine: b.spine, joins, map };
  });

  return { version: 1, branches, columns, provenance: Boolean(raw?.provenance) };
}

/** spine -> t0, joins -> t1..tn, branch-local. Keyed by join id rather than
 *  table name so the same table can be joined in twice on different keys. */
function branchAliases(branch) {
  const aliases = new Map([["spine", "t0"]]);
  branch.joins.forEach((j, i) => aliases.set(j.id, `t${i + 1}`));
  return aliases;
}

function joinOnSql(step, aliases) {
  const left = `${aliases.get(step.leftFrom)}.${quoteIdent(step.leftColumn)}`;
  const right = `${aliases.get(step.id)}.${quoteIdent(step.rightColumn)}`;
  // The only place in this file permitted to emit a CAST into an ON clause.
  // Native and text compare are lossy in opposite directions — native matches
  // '1', '01' and '1.0' to integer 1, text matches only '1' — so neither is
  // universally right and the preflight makes the user choose on real counts.
  return step.keyCompare === "text"
    ? `CAST(${left} AS TEXT) = CAST(${right} AS TEXT)`
    : `${left} = ${right}`;
}

/**
 * The FROM clause for one *normalized* branch.
 *
 * Split out so the preflight can count what a branch will really produce by
 * running the same joins the view will — a second, hand-written FROM would be
 * free to disagree with the view about the thing it is supposed to be checking.
 */
function buildBranchFromSql(branch) {
  const aliases = branchAliases(branch);
  let from = `${quoteIdent(branch.spine)} AS t0`;
  for (const step of branch.joins) {
    const kind = step.type === "inner" ? "JOIN" : "LEFT JOIN";
    from += `\n  ${kind} ${quoteIdent(step.table)} AS ${aliases.get(step.id)} ON ${joinOnSql(step, aliases)}`;
  }
  return from;
}

function branchSql(branch, recipe, branchIndex, rowIdAvailable) {
  const aliases = branchAliases(branch);
  const parts = [];

  if (rowIdAvailable) {
    const stride = ROW_ID_STRIDE * (branchIndex + 1);
    parts.push(`(${stride} + t0.${quoteIdent("row_id")}) AS ${quoteIdent("row_id")}`);
  }
  if (recipe.provenance) {
    parts.push(`${quoteLiteral(branch.label)} AS ${quoteIdent(PROVENANCE_COLUMN)}`);
  }
  for (const c of recipe.columns) {
    const src = branch.map[c.name];
    // A plain NULL, not CAST(NULL AS REAL): the bare NULL still lets the
    // declared type come from the branches that do have the column.
    parts.push(
      src
        ? `${aliases.get(src.from)}.${quoteIdent(src.column)} AS ${quoteIdent(c.name)}`
        : `NULL AS ${quoteIdent(c.name)}`,
    );
  }

  return `SELECT ${parts.join(", ")}\n  FROM ${buildBranchFromSql(branch)}`;
}

/**
 * The SELECT behind a combined dataset.
 *
 * Never `SELECT *`: a star view re-expands at query time, so a source gaining a
 * column would silently change the combined table's shape underneath the stored
 * column_schema. No LIMIT and no ORDER BY either — callers add the limit, and an
 * ORDER BY in the view would force a full sort before any outer LIMIT applied,
 * turning a ten-row Browse into a fifty-million-row sort.
 *
 * @param tablesWithRowId names of referenced tables that have a row_id column.
 *   Defaults to none, which omits row_id — degraded but always valid, the right
 *   way to be wrong about whether a column exists.
 */
function buildCombineSql(recipe, tablesWithRowId = []) {
  const r = normalizeRecipe(recipe);
  const withRowId = new Set(tablesWithRowId);
  // All or nothing: a row_id present in some branches and NULL in others is
  // worse than absent, because it looks like an identifier and isn't one.
  const rowIdAvailable = r.branches.every((b) => withRowId.has(b.spine));
  const branches = r.branches.map((b, i) => branchSql(b, r, i, rowIdAvailable));
  // UNION ALL, never UNION: UNION de-duplicates, which is data loss wearing
  // tidiness as a disguise. The recipe has no field that can ask for dedupe.
  return branches.join("\nUNION ALL\n");
}

function buildCreateViewSql(viewName, recipe, tablesWithRowId = []) {
  return `CREATE TEMP VIEW ${quoteIdent(viewName)} AS\n${buildCombineSql(recipe, tablesWithRowId)}`;
}

/**
 * The column_schema a combined dataset registers, derived from the same
 * normalized recipe the SQL comes from — so the stored schema and the view's
 * real columns cannot drift apart.
 */
function combinedColumnSchema(recipe, tablesWithRowId = []) {
  const r = normalizeRecipe(recipe);
  const withRowId = new Set(tablesWithRowId);
  const schema = [];
  if (r.branches.every((b) => withRowId.has(b.spine))) {
    schema.push({ name: "row_id", original_name: "row_id", type: "integer" });
  }
  if (r.provenance) {
    schema.push({
      name: PROVENANCE_COLUMN,
      original_name: PROVENANCE_COLUMN,
      type: "text",
    });
  }
  for (const c of r.columns) {
    schema.push({ name: c.name, original_name: c.originalName, type: c.type });
  }
  return schema;
}

module.exports = {
  ROW_ID_STRIDE,
  PROVENANCE_COLUMN,
  RESERVED_OUTPUT_COLUMNS,
  sanitizeIdent,
  quoteIdent,
  referencedTables,
  assertRecipeScope,
  normalizeRecipe,
  buildBranchFromSql,
  buildCombineSql,
  buildCreateViewSql,
  combinedColumnSchema,
};
