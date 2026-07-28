import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { prepareProjectSelect } from "./query-guard.js";

export type ColumnKind =
  "text" | "integer" | "double precision" | "boolean" | "date" | "timestamptz";

const PG_TYPE: Record<string, string> = {
  integer: "INTEGER",
  "double precision": "DOUBLE PRECISION",
  boolean: "BOOLEAN",
  date: "DATE",
  timestamptz: "TIMESTAMPTZ",
  text: "TEXT",
};

function now() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function sanitizeIdent(s: string) {
  const cleaned = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned === "" ? "col" : cleaned;
}

function quoteIdent(s: string) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

export type AuthUser = {
  id: string;
  email: string;
  global_role: "admin" | "user";
};

export class DataStore {
  constructor(private pool: Pool) {}

  async migrate(sql: string) {
    await this.pool.query(sql);
  }

  async getUserByEmail(email: string) {
    const r = await this.pool.query(
      "SELECT id, email, password_hash, global_role FROM users WHERE email = $1",
      [email.toLowerCase().trim()],
    );
    return r.rows[0] as
      | { id: string; email: string; password_hash: string; global_role: "admin" | "user" }
      | undefined;
  }

  async createUser(email: string, passwordHash: string, globalRole: "admin" | "user" = "user") {
    const id = uuid();
    await this.pool.query(
      "INSERT INTO users (id, email, password_hash, global_role) VALUES ($1, $2, $3, $4)",
      [id, email.toLowerCase().trim(), passwordHash, globalRole],
    );
    return id;
  }

  async countUsers() {
    const r = await this.pool.query("SELECT COUNT(*)::int AS c FROM users");
    return r.rows[0].c as number;
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date) {
    const id = uuid();
    await this.pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
      [id, userId, tokenHash, expiresAt.toISOString()],
    );
    return id;
  }

  async getUserBySessionToken(tokenHash: string) {
    const r = await this.pool.query(
      `SELECT u.id, u.email, u.global_role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    return r.rows[0] as AuthUser | undefined;
  }

  async deleteSession(tokenHash: string) {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async userCanAccessProject(user: AuthUser, projectId: string, need: "read" | "write") {
    if (user.global_role === "admin") return true;
    const r = await this.pool.query(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
      [projectId, user.id],
    );
    const role = r.rows[0]?.role as string | undefined;
    if (!role) return false;
    if (need === "read") return true;
    return role === "editor";
  }

  async listProjects(user: AuthUser) {
    if (user.global_role === "admin") {
      const r = await this.pool.query(
        `SELECT p.*, (SELECT COUNT(*)::int FROM datasets d WHERE d.project_id = p.id) AS dataset_count
         FROM projects p ORDER BY p.created_at DESC`,
      );
      return r.rows.map(parseProjectRow);
    }
    const r = await this.pool.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM datasets d WHERE d.project_id = p.id) AS dataset_count
       FROM projects p
       JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
       ORDER BY p.created_at DESC`,
      [user.id],
    );
    return r.rows.map(parseProjectRow);
  }

  async getProject(user: AuthUser, id: string) {
    if (!(await this.userCanAccessProject(user, id, "read"))) return null;
    const r = await this.pool.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM datasets d WHERE d.project_id = p.id) AS dataset_count
       FROM projects p WHERE p.id = $1`,
      [id],
    );
    return r.rows[0] ? parseProjectRow(r.rows[0]) : null;
  }

  async createProject(
    user: AuthUser,
    input: {
      project_name: string;
      project_code: string;
      description?: string | null;
      sponsor?: string | null;
      pi_name?: string | null;
      start_date?: string | null;
      end_date?: string | null;
      template_key?: string | null;
    },
  ) {
    const id = uuid();
    const t = now();
    await this.pool.query(
      `INSERT INTO projects (id, project_code, project_name, sponsor, pi_name, start_date, end_date, description, template_key, template_meta, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}',$10,$10)`,
      [
        id,
        input.project_code,
        input.project_name,
        input.sponsor ?? null,
        input.pi_name ?? null,
        input.start_date ?? null,
        input.end_date ?? null,
        input.description ?? null,
        input.template_key ?? null,
        t,
      ],
    );
    await this.pool.query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')",
      [id, user.id],
    );
    return id;
  }

  async updateProjectTemplateMeta(user: AuthUser, id: string, templateMeta: unknown) {
    if (!(await this.userCanAccessProject(user, id, "write"))) throw new Error("Forbidden");
    await this.pool.query("UPDATE projects SET template_meta = $1, updated_at = $2 WHERE id = $3", [
      JSON.stringify(templateMeta ?? {}),
      now(),
      id,
    ]);
  }

  async deleteProject(user: AuthUser, id: string) {
    if (!(await this.userCanAccessProject(user, id, "write"))) throw new Error("Forbidden");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ds = await client.query("SELECT table_name FROM datasets WHERE project_id = $1", [id]);
      for (const row of ds.rows) {
        const tn = row.table_name as string;
        if (/^[a-z0-9_]+$/.test(tn)) {
          await client.query(`DROP TABLE IF EXISTS ${quoteIdent(tn)}`);
        }
      }
      await client.query("DELETE FROM projects WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async listDatasets(user: AuthUser, projectId: string, order: "asc" | "desc" = "desc") {
    if (!(await this.userCanAccessProject(user, projectId, "read"))) throw new Error("Forbidden");
    const dir = order === "asc" ? "ASC" : "DESC";
    const r = await this.pool.query(
      `SELECT * FROM datasets WHERE project_id = $1 ORDER BY created_at ${dir}, id ${dir}`,
      [projectId],
    );
    return r.rows.map(parseDatasetRow);
  }

  async getDatasetOrThrow(datasetId: string) {
    const r = await this.pool.query("SELECT * FROM datasets WHERE id = $1", [datasetId]);
    if (!r.rows[0]) throw new Error("Dataset not found");
    const row = parseDatasetRow(r.rows[0]);
    if (!/^[a-z0-9_]+$/.test(row.table_name)) throw new Error("Invalid dataset table");
    return row;
  }

  async createProjectDataset(
    user: AuthUser,
    args: {
      projectId: string;
      displayName: string;
      sourceFilename: string | null;
      columns: { name: string; original_name: string; type: ColumnKind }[];
    },
  ) {
    if (!(await this.userCanAccessProject(user, args.projectId, "write"))) {
      throw new Error("Forbidden");
    }
    if (!args.columns.length) throw new Error("At least one column is required");

    const pr = await this.pool.query("SELECT project_code FROM projects WHERE id = $1", [
      args.projectId,
    ]);
    if (!pr.rows[0]) throw new Error("Project not found");

    let base =
      `ds_${sanitizeIdent(pr.rows[0].project_code)}_${sanitizeIdent(args.displayName)}`.slice(
        0,
        55,
      );
    let table = base;
    let n = 0;
    while (true) {
      const ex = await this.pool.query("SELECT 1 FROM datasets WHERE table_name = $1", [table]);
      if (ex.rowCount === 0) break;
      n += 1;
      const suffix = `_${n}`;
      table = base.slice(0, 55 - suffix.length) + suffix;
    }

    const seen = new Set<string>();
    const colDefs: string[] = [];
    const cleanCols: { name: string; original_name: string; type: ColumnKind }[] = [];
    for (const col of args.columns) {
      let name = sanitizeIdent(col.name);
      if (name === "row_id") name = "row_id_2";
      if (seen.has(name)) {
        let k = 2;
        while (seen.has(`${name}_${k}`)) k += 1;
        name = `${name}_${k}`;
      }
      seen.add(name);
      const type = PG_TYPE[col.type] ? col.type : "text";
      colDefs.push(`${quoteIdent(name)} ${PG_TYPE[type]}`);
      cleanCols.push({ name, original_name: col.name, type: type as ColumnKind });
    }

    const id = uuid();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `CREATE TABLE ${quoteIdent(table)} (row_id SERIAL PRIMARY KEY, ${colDefs.join(", ")})`,
      );
      await client.query(
        `INSERT INTO datasets (id, project_id, table_name, display_name, source_filename, row_count, column_schema, created_at)
         VALUES ($1,$2,$3,$4,$5,0,$6,$7)`,
        [
          id,
          args.projectId,
          table,
          args.displayName,
          args.sourceFilename,
          JSON.stringify(cleanCols),
          now(),
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return { dataset_id: id, table_name: table };
  }

  bindValue(type: ColumnKind, v: string | null) {
    if (v === null || v === undefined || v === "") return null;
    switch (type) {
      case "integer": {
        if (!/^-?\d+$/.test(String(v).trim())) {
          throw new Error(`Invalid integer value: ${String(v)}`);
        }
        return Number(v);
      }
      case "double precision": {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          throw new Error(`Invalid numeric value: ${String(v)}`);
        }
        return n;
      }
      case "boolean":
        if (v !== "true" && v !== "false" && v !== "1" && v !== "0") {
          throw new Error(`Invalid boolean value: ${String(v)}`);
        }
        return v === "true" || v === "1";
      default:
        return String(v);
    }
  }

  async insertDatasetRowsTyped(
    user: AuthUser,
    datasetId: string,
    rows: Record<string, string | null>[],
  ) {
    if (!rows.length) return 0;
    const ds = await this.getDatasetOrThrow(datasetId);
    if (!(await this.userCanAccessProject(user, ds.project_id, "write"))) {
      throw new Error("Forbidden");
    }
    const cols = ds.column_schema as { name: string; type: ColumnKind }[];
    const colList = cols.map((c) => quoteIdent(c.name)).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO ${quoteIdent(ds.table_name)} (${colList}) VALUES (${placeholders})`;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        let norm: Record<string, string | null> | null = null;
        const values = cols.map((c) => {
          let v = row[c.name];
          if (v === undefined) {
            if (!norm) {
              norm = {};
              for (const k of Object.keys(row)) norm[sanitizeIdent(k)] = row[k];
            }
            v = norm[c.name];
          }
          return this.bindValue(c.type, v);
        });
        await client.query(sql, values);
      }
      await client.query("UPDATE datasets SET row_count = row_count + $1 WHERE id = $2", [
        rows.length,
        datasetId,
      ]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return rows.length;
  }

  async replaceDatasetRowsTyped(
    user: AuthUser,
    datasetId: string,
    rows: Record<string, string | null>[],
  ) {
    const ds = await this.getDatasetOrThrow(datasetId);
    if (!(await this.userCanAccessProject(user, ds.project_id, "write"))) {
      throw new Error("Forbidden");
    }
    const cols = ds.column_schema as { name: string; type: ColumnKind }[];
    const colList = cols.map((c) => quoteIdent(c.name)).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const insertSql = `INSERT INTO ${quoteIdent(ds.table_name)} (${colList}) VALUES (${placeholders})`;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`TRUNCATE ${quoteIdent(ds.table_name)} RESTART IDENTITY`);
      for (const row of rows) {
        let norm: Record<string, string | null> | null = null;
        const values = cols.map((c) => {
          let v = row[c.name];
          if (v === undefined) {
            if (!norm) {
              norm = {};
              for (const k of Object.keys(row)) norm[sanitizeIdent(k)] = row[k];
            }
            v = norm[c.name];
          }
          return this.bindValue(c.type, v);
        });
        await client.query(insertSql, values);
      }
      await client.query("UPDATE datasets SET row_count = $1 WHERE id = $2", [
        rows.length,
        datasetId,
      ]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return rows.length;
  }

  async dropProjectDataset(user: AuthUser, datasetId: string) {
    const ds = await this.getDatasetOrThrow(datasetId);
    if (!(await this.userCanAccessProject(user, ds.project_id, "write"))) {
      throw new Error("Forbidden");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DROP TABLE IF EXISTS ${quoteIdent(ds.table_name)}`);
      await client.query("DELETE FROM datasets WHERE id = $1", [datasetId]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    const project = await this.getProject(user, ds.project_id);
    if (project?.template_meta && typeof project.template_meta === "object") {
      const meta = { ...(project.template_meta as Record<string, unknown>) };
      const bindings = { ...((meta.bindings as Record<string, string>) ?? {}) };
      for (const [k, v] of Object.entries(bindings)) {
        if (v === datasetId) delete bindings[k];
      }
      meta.bindings = bindings;
      await this.updateProjectTemplateMeta(user, ds.project_id, meta);
    }
  }

  async truncateDataset(user: AuthUser, datasetId: string) {
    const ds = await this.getDatasetOrThrow(datasetId);
    if (!(await this.userCanAccessProject(user, ds.project_id, "write"))) {
      throw new Error("Forbidden");
    }
    await this.pool.query(`TRUNCATE ${quoteIdent(ds.table_name)} RESTART IDENTITY`);
    await this.pool.query("UPDATE datasets SET row_count = 0 WHERE id = $1", [datasetId]);
  }

  async addDatasetColumn(
    user: AuthUser,
    datasetId: string,
    columnName: string,
    columnType: ColumnKind,
  ) {
    const ds = await this.getDatasetOrThrow(datasetId);
    if (!(await this.userCanAccessProject(user, ds.project_id, "write"))) {
      throw new Error("Forbidden");
    }
    const clean = sanitizeIdent(columnName);
    const schema = ds.column_schema as { name: string; original_name: string; type: ColumnKind }[];
    if (schema.some((c) => c.name === clean)) throw new Error(`Column ${clean} already exists`);
    const type = PG_TYPE[columnType] ? columnType : "text";
    const nextSchema = [
      ...schema,
      { name: clean, original_name: columnName, type: type as ColumnKind },
    ];
    await this.pool.query(
      `ALTER TABLE ${quoteIdent(ds.table_name)} ADD COLUMN ${quoteIdent(clean)} ${PG_TYPE[type]}`,
    );
    await this.pool.query("UPDATE datasets SET column_schema = $1 WHERE id = $2", [
      JSON.stringify(nextSchema),
      datasetId,
    ]);
    return clean;
  }

  async updateDatasetColumnSchema(user: AuthUser, datasetId: string, columnSchema: unknown) {
    const ds = await this.getDatasetOrThrow(datasetId);
    if (!(await this.userCanAccessProject(user, ds.project_id, "write"))) {
      throw new Error("Forbidden");
    }
    await this.pool.query("UPDATE datasets SET column_schema = $1 WHERE id = $2", [
      JSON.stringify(columnSchema ?? []),
      datasetId,
    ]);
  }

  async datasetColumnValues(user: AuthUser, datasetId: string, columns: string[], limit = 50000) {
    const ds = await this.getDatasetOrThrow(datasetId);
    if (!(await this.userCanAccessProject(user, ds.project_id, "read"))) {
      throw new Error("Forbidden");
    }
    const lim = Math.min(Math.max(Number(limit) || 50000, 1), 200000);
    const valid = new Set((ds.column_schema as { name: string }[]).map((c) => c.name));
    for (const c of columns) {
      if (!valid.has(c)) throw new Error(`Unknown column: ${c}`);
    }
    const colList = columns.map(quoteIdent).join(", ");
    const r = await this.pool.query(
      `SELECT DISTINCT ${colList} FROM ${quoteIdent(ds.table_name)} LIMIT ${lim}`,
    );
    return r.rows;
  }

  async queryDataset(user: AuthUser, datasetId: string, limit = 5000) {
    const ds = await this.getDatasetOrThrow(datasetId);
    if (!(await this.userCanAccessProject(user, ds.project_id, "read"))) {
      throw new Error("Forbidden");
    }
    const lim = Math.min(Math.max(Number(limit) || 5000, 1), 50000);
    const colList = (ds.column_schema as { name: string }[])
      .map((c) => quoteIdent(c.name))
      .join(", ");
    const r = await this.pool.query(
      `SELECT ${colList} FROM ${quoteIdent(ds.table_name)} LIMIT ${lim}`,
    );
    return r.rows;
  }

  async runProjectQuery(user: AuthUser, projectId: string, sql: string, limit = 500) {
    if (!(await this.userCanAccessProject(user, projectId, "read"))) {
      throw new Error("Forbidden");
    }
    const lim = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const allowed = (
      await this.pool.query("SELECT table_name FROM datasets WHERE project_id = $1", [projectId])
    ).rows.map((r) => r.table_name as string);
    const clean = prepareProjectSelect(sql, allowed);
    const r = await this.pool.query(`SELECT * FROM (${clean}) AS _q LIMIT ${lim}`);
    const columns = r.fields.map((f) => f.name);
    return { rows: r.rows, columns };
  }

  async listSavedQueries(user: AuthUser, projectId: string) {
    if (!(await this.userCanAccessProject(user, projectId, "read"))) throw new Error("Forbidden");
    const r = await this.pool.query(
      "SELECT id, project_id, name, sql_text, created_at FROM saved_queries WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId],
    );
    return r.rows;
  }

  async insertSavedQuery(user: AuthUser, projectId: string, name: string, sqlText: string) {
    if (!(await this.userCanAccessProject(user, projectId, "write"))) throw new Error("Forbidden");
    const t = now();
    await this.pool.query(
      `INSERT INTO saved_queries (id, project_id, name, spec, sql_text, created_at, updated_at)
       VALUES ($1,$2,$3,'{}',$4,$5,$5)`,
      [uuid(), projectId, name, sqlText, t],
    );
  }

  async listExportHistory(user: AuthUser, projectId: string, limit = 50) {
    if (!(await this.userCanAccessProject(user, projectId, "read"))) throw new Error("Forbidden");
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const r = await this.pool.query(
      `SELECT * FROM export_history WHERE project_id = $1 ORDER BY created_at DESC LIMIT ${lim}`,
      [projectId],
    );
    return r.rows;
  }

  async insertExportHistory(
    user: AuthUser,
    args: { projectId: string; filename: string; rowCount: number; queryId?: string | null },
  ) {
    if (!(await this.userCanAccessProject(user, args.projectId, "read"))) {
      throw new Error("Forbidden");
    }
    await this.pool.query(
      `INSERT INTO export_history (id, project_id, query_id, filename, row_count, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), args.projectId, args.queryId ?? null, args.filename, args.rowCount, now()],
    );
  }

  async getSetting(key: string) {
    const r = await this.pool.query("SELECT value FROM settings WHERE key = $1", [key]);
    return (r.rows[0]?.value as string | undefined) ?? null;
  }

  async setSetting(key: string, value: string) {
    await this.pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }

  async addProjectMember(
    admin: AuthUser,
    projectId: string,
    email: string,
    role: "editor" | "viewer",
  ) {
    if (
      admin.global_role !== "admin" &&
      !(await this.userCanAccessProject(admin, projectId, "write"))
    ) {
      throw new Error("Forbidden");
    }
    const u = await this.getUserByEmail(email);
    if (!u) throw new Error("User not found");
    await this.pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [projectId, u.id, role],
    );
  }

  async listProjectMembers(user: AuthUser, projectId: string) {
    if (!(await this.userCanAccessProject(user, projectId, "read"))) throw new Error("Forbidden");
    const r = await this.pool.query(
      `SELECT u.email, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1`,
      [projectId],
    );
    return r.rows;
  }
}

function parseProjectRow(row: Record<string, unknown>) {
  return {
    ...row,
    template_meta:
      typeof row.template_meta === "string"
        ? JSON.parse(row.template_meta)
        : (row.template_meta ?? {}),
    dataset_count: Number(row.dataset_count ?? 0),
  };
}

function parseDatasetRow(row: Record<string, unknown>) {
  return {
    ...(row as {
      id: string;
      project_id: string;
      table_name: string;
      display_name: string;
      source_filename: string | null;
      row_count: number;
      column_schema: unknown;
      created_at: string;
    }),
    column_schema:
      typeof row.column_schema === "string"
        ? JSON.parse(row.column_schema)
        : (row.column_schema ?? []),
    row_count: Number(row.row_count ?? 0),
  };
}
