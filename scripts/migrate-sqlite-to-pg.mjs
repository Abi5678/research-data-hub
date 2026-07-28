#!/usr/bin/env node
/**
 * One-shot migration: SQLite desktop DB → Postgres (lab server schema).
 * Usage: node scripts/migrate-sqlite-to-pg.mjs --sqlite path/to/local.sqlite3 --pg postgres://...
 */
import Database from "better-sqlite3";
import pg from "pg";

const args = process.argv.slice(2);
function get(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const sqlitePath = get("--sqlite");
const pgUrl = get("--pg");
if (!sqlitePath || !pgUrl) {
  console.error("Usage: --sqlite <file> --pg <DATABASE_URL>");
  process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new pg.Pool({ connectionString: pgUrl });

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const projects = sqlite.prepare("SELECT * FROM projects").all();
    for (const p of projects) {
      await client.query(
        `INSERT INTO projects (id, project_code, project_name, sponsor, pi_name, start_date, end_date, description, template_key, template_meta, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.id,
          p.project_code,
          p.project_name,
          p.sponsor,
          p.pi_name,
          p.start_date,
          p.end_date,
          p.description,
          p.template_key,
          p.template_meta,
          p.created_at,
          p.updated_at,
        ],
      );
    }
    const datasets = sqlite.prepare("SELECT * FROM datasets").all();
    for (const d of datasets) {
      const cols = JSON.parse(d.column_schema || "[]");
      const colDefs = cols.map((c) => {
        const type =
          c.type === "integer"
            ? "INTEGER"
            : c.type === "double precision"
              ? "DOUBLE PRECISION"
              : c.type === "boolean"
                ? "BOOLEAN"
                : "TEXT";
        return `"${c.name}" ${type}`;
      });
      await client.query(
        `CREATE TABLE IF NOT EXISTS "${d.table_name}" (row_id SERIAL PRIMARY KEY, ${colDefs.join(", ")})`,
      );
      const rows = sqlite.prepare(`SELECT * FROM "${d.table_name}"`).all();
      if (rows.length) {
        const names = cols.map((c) => `"${c.name}"`).join(", ");
        for (const row of rows) {
          const vals = cols.map((_, i) => `$${i + 1}`).join(", ");
          await client.query(
            `INSERT INTO "${d.table_name}" (${names}) VALUES (${vals})`,
            cols.map((c) => row[c.name]),
          );
        }
      }
      await client.query(
        `INSERT INTO datasets (id, project_id, table_name, display_name, source_filename, row_count, column_schema, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [
          d.id,
          d.project_id,
          d.table_name,
          d.display_name,
          d.source_filename,
          d.row_count,
          d.column_schema,
          d.created_at,
        ],
      );
    }
    const settings = sqlite.prepare("SELECT * FROM settings").all();
    for (const s of settings) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [s.key, s.value],
      );
    }
    await client.query("COMMIT");
    console.log(
      `Migrated ${projects.length} projects, ${datasets.length} datasets, ${settings.length} settings.`,
    );
    console.log("Assign project_members manually for lab users (creator as editor).");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
