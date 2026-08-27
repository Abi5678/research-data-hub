import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import { z } from "zod";
import { DataStore, type AuthUser } from "./datastore.js";
import { DEFAULT_MODEL, llmChat, testLlmConnection, isAiAssistAvailable, cloudAllowed } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL || "postgres://rdh:rdh@127.0.0.1:5432/rdh";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const COOKIE_NAME = "rdh_session";

if (
  process.env.NODE_ENV === "production" &&
  (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32 ||
    process.env.SESSION_SECRET === "dev-change-me")
) {
  throw new Error("SESSION_SECRET must be at least 32 characters and not the default value in production");
}

const pool = new Pool({ connectionString: DATABASE_URL });
const store = new DataStore(pool);

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function runMigrations() {
  const migDir = path.join(__dirname, "..", "migrations");
  for (const file of ["001_init.sql", "002_import_history.sql"]) {
    const sql = await fs.readFile(path.join(migDir, file), "utf8");
    await store.migrate(sql);
  }
}

async function bootstrapAdmin() {
  const count = await store.countUsers();
  if (count > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn("No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin.");
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await store.createUser(email, hash, "admin");
  console.log(`Created admin user ${email}`);
}

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 20;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_MAX;
}

const SETTINGS_ALLOWLIST = new Set([
  "nvidia_api_key",
  "nvidia_model",
  "llm_base_url",
  "llm_provider",
]);

function isAllowedSettingKey(key: string): boolean {
  if (SETTINGS_ALLOWLIST.has(key)) return true;
  return /^(nvidia_|llm_)/.test(key);
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const app = Fastify({ logger: true });

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : false;

app.setErrorHandler((error, req, reply) => {
  const message = error instanceof Error ? error.message : "Request failed";
  const isValidationError = error instanceof z.ZodError;
  const knownClientError =
    isValidationError ||
    message === "Unauthorized" ||
    message === "Forbidden" ||
    message === "Not found" ||
    message === "Project not found" ||
    message === "Dataset not found" ||
    message.startsWith("Only ") ||
    message.startsWith("Query ") ||
    message.startsWith("Table ") ||
    message.startsWith("Invalid ") ||
    message.startsWith("At least one column") ||
    message.startsWith("Unknown column") ||
    message.startsWith("Column ") ||
    message === "User not found";
  const status = knownClientError
    ? isValidationError
      ? 400
      : message === "Unauthorized"
        ? 401
        : message === "Forbidden"
          ? 403
          : message.includes("not found")
            ? 404
            : 400
    : typeof (error as { statusCode?: unknown }).statusCode === "number" &&
        Number((error as { statusCode: number }).statusCode) < 500
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
  if (status >= 500) req.log.error(error);
  return reply
    .code(status)
    .send({
      error:
        status >= 500 ? "Internal server error" : isValidationError ? "Invalid request" : message,
    });
});

await app.register(cors, {
  origin: corsOrigins,
  credentials: true,
});
await app.register(cookie, { secret: process.env.SESSION_SECRET || "dev-change-me" });

app.decorateRequest("user", undefined);

app.addHook("preHandler", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  if (
    req.url === "/api/health" ||
    req.url.startsWith("/api/auth/login") ||
    req.url.startsWith("/api/auth/register")
  ) {
    return;
  }

  const raw = req.cookies[COOKIE_NAME];
  if (!raw) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  const user = await store.getUserBySessionToken(hashToken(raw));
  if (!user) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  req.user = user;
});

app.get("/api/health", async () => ({ ok: true }));

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

app.post("/api/auth/register", async (req, reply) => {
  if (!checkRateLimit(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again later." });
  const count = await store.countUsers();
  const allow = process.env.ALLOW_PUBLIC_REGISTER === "1" || count === 0;
  if (!allow) return reply.code(403).send({ error: "Registration disabled" });

  const body = loginSchema.parse(req.body);
  const existing = await store.getUserByEmail(body.email);
  if (existing) return reply.code(409).send({ error: "Email already registered" });

  const role = count === 0 ? "admin" : "user";
  const hash = await bcrypt.hash(body.password, 12);
  const id = await store.createUser(body.email, hash, role);

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await store.createSession(id, hashToken(token), expires);

  reply.setCookie(COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "1",
    maxAge: SESSION_DAYS * 86400,
  });
  return { id, email: body.email.toLowerCase(), global_role: role };
});

app.post("/api/auth/login", async (req, reply) => {
  if (!checkRateLimit(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again later." });
  const body = loginSchema.parse(req.body);
  const row = await store.getUserByEmail(body.email);
  if (!row || !(await bcrypt.compare(body.password, row.password_hash))) {
    return reply.code(401).send({ error: "Invalid credentials" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await store.createSession(row.id, hashToken(token), expires);
  reply.setCookie(COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "1",
    maxAge: SESSION_DAYS * 86400,
  });
  return { id: row.id, email: row.email, global_role: row.global_role };
});

app.post("/api/auth/logout", async (req, reply) => {
  const raw = req.cookies[COOKIE_NAME];
  if (raw) await store.deleteSession(hashToken(raw));
  reply.clearCookie(COOKIE_NAME, { path: "/" });
  return { ok: true };
});

app.get("/api/auth/me", async (req, reply) => {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return reply.code(401).send({ error: "Unauthorized" });
  const user = await store.getUserBySessionToken(hashToken(raw));
  if (!user) return reply.code(401).send({ error: "Unauthorized" });
  return user;
});

function u(req: { user?: AuthUser }): AuthUser {
  if (!req.user) throw new Error("Unauthorized");
  return req.user;
}

app.get("/api/projects", async (req) => store.listProjects(u(req)));
app.get("/api/projects/:id", async (req, reply) => {
  const p = await store.getProject(u(req), (req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ error: "Not found" });
  return p;
});
app.post("/api/projects", async (req) => {
  const body = req.body as Record<string, unknown>;
  const id = await store.createProject(u(req), body as Parameters<DataStore["createProject"]>[1]);
  return { id };
});
app.patch("/api/projects/:id/template-meta", async (req) => {
  const { id } = req.params as { id: string };
  const { templateMeta } = req.body as { templateMeta: unknown };
  await store.updateProjectTemplateMeta(u(req), id, templateMeta);
  return { ok: true };
});
app.delete("/api/projects/:id", async (req) => {
  await store.deleteProject(u(req), (req.params as { id: string }).id);
  return { ok: true };
});

app.get("/api/projects/:id/datasets", async (req) => {
  const { id } = req.params as { id: string };
  const order = (req.query as { order?: string }).order === "asc" ? "asc" : "desc";
  return store.listDatasets(u(req), id, order);
});
app.post("/api/datasets", async (req) => store.createProjectDataset(u(req), req.body as never));
app.post("/api/datasets/:id/rows", async (req) => {
  const { id } = req.params as { id: string };
  const { rows } = req.body as { rows: Record<string, string | null>[] };
  const n = await store.insertDatasetRowsTyped(u(req), id, rows);
  return { inserted: n };
});
app.put("/api/datasets/:id/rows", async (req) => {
  const { id } = req.params as { id: string };
  const { rows } = req.body as { rows: Record<string, string | null>[] };
  const n = await store.replaceDatasetRowsTyped(u(req), id, rows);
  return { inserted: n };
});
app.delete("/api/datasets/:id", async (req) => {
  await store.dropProjectDataset(u(req), (req.params as { id: string }).id);
  return { ok: true };
});
app.post("/api/datasets/:id/truncate", async (req) => {
  await store.truncateDataset(u(req), (req.params as { id: string }).id);
  return { ok: true };
});
app.post("/api/datasets/:id/columns", async (req) => {
  const { id } = req.params as { id: string };
  const { columnName, columnType } = req.body as { columnName: string; columnType: string };
  const name = await store.addDatasetColumn(u(req), id, columnName, columnType as never);
  return { name };
});
app.patch("/api/datasets/:id/schema", async (req) => {
  const { id } = req.params as { id: string };
  const { columnSchema } = req.body as { columnSchema: unknown };
  await store.updateDatasetColumnSchema(u(req), id, columnSchema);
  return { ok: true };
});
app.get("/api/datasets/:id/values", async (req) => {
  const { id } = req.params as { id: string };
  const q = req.query as { columns?: string; limit?: string };
  const columns = (q.columns || "").split(",").filter(Boolean);
  return store.datasetColumnValues(u(req), id, columns, Number(q.limit || 50000));
});
app.get("/api/datasets/:id/query", async (req) => {
  const { id } = req.params as { id: string };
  const limit = Number((req.query as { limit?: string }).limit || 5000);
  return store.queryDataset(u(req), id, limit);
});

app.post("/api/projects/:id/query", async (req) => {
  const { id } = req.params as { id: string };
  const { sql, limit } = req.body as { sql: string; limit?: number };
  return store.runProjectQuery(u(req), id, sql, limit);
});

app.get("/api/projects/:id/saved-queries", async (req) =>
  store.listSavedQueries(u(req), (req.params as { id: string }).id),
);
app.post("/api/projects/:id/saved-queries", async (req) => {
  const { id } = req.params as { id: string };
  const { name, sqlText } = req.body as { name: string; sqlText: string };
  await store.insertSavedQuery(u(req), id, name, sqlText);
  return { ok: true };
});

app.get("/api/projects/:id/analysis-views", async (req) =>
  store.listAnalysisViews(u(req), (req.params as { id: string }).id),
);
app.post("/api/projects/:id/analysis-views", async (req) => {
  const { id } = req.params as { id: string };
  const { name, spec } = req.body as { name: string; spec: unknown };
  return store.insertAnalysisView(u(req), id, name, spec);
});
app.delete("/api/projects/:id/analysis-views/:viewId", async (req) => {
  const { id, viewId } = req.params as { id: string; viewId: string };
  await store.deleteAnalysisView(u(req), id, viewId);
  return { ok: true };
});

app.get("/api/projects/:id/exports", async (req) => {
  const { id } = req.params as { id: string };
  const limit = Number((req.query as { limit?: string }).limit || 50);
  return store.listExportHistory(u(req), id, limit);
});
app.post("/api/projects/:id/exports", async (req) => {
  const { id } = req.params as { id: string };
  const body = req.body as { filename: string; rowCount: number; queryId?: string | null };
  await store.insertExportHistory(u(req), { projectId: id, ...body });
  return { ok: true };
});

app.post("/api/import/folder-job", async (req, reply) => {
  const user = u(req);
  const body = req.body as {
    projectId?: string;
    projectInput?: Parameters<DataStore["createProject"]>[1];
    tables: Array<{
      displayName: string;
      sourceFilename: string;
      columns: { name: string; original_name: string; type: string }[];
      rows: Record<string, string | null>[];
    }>;
  };
  if (body.projectId) {
    if (!(await store.userCanAccessProject(user, body.projectId, "write"))) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  }
  const result = await store.importFolderJob(user, {
    projectId: body.projectId,
    projectInput: body.projectInput,
    tables: body.tables,
  });
  return result;
});

app.get("/api/projects/:id/import-history", async (req) => {
  const { id } = req.params as { id: string };
  const limit = Number((req.query as { limit?: string }).limit || 50);
  return store.listImportHistory(u(req), id, limit);
});

app.get("/api/projects/:id/members", async (req) =>
  store.listProjectMembers(u(req), (req.params as { id: string }).id),
);
app.post("/api/projects/:id/members", async (req) => {
  const { id } = req.params as { id: string };
  const { email, role } = req.body as { email: string; role: "editor" | "viewer" };
  await store.addProjectMember(u(req), id, email, role);
  return { ok: true };
});

app.get("/api/settings/:key", async (req, reply) => {
  const user = u(req);
  const { key } = req.params as { key: string };
  if (key === "nvidia_api_key") {
    if (user.global_role !== "admin") return reply.code(403).send({ error: "Forbidden" });
    const v = await store.getSetting(key);
    return { value: v ? "••••••••" : null, configured: Boolean(v) };
  }
  if (key === "nvidia_model") {
    // Only suggest the cloud model when cloud is the endpoint — see resolveModel.
    const v = await store.getSetting(key);
    return { value: v ?? (process.env.LLM_BASE_URL ? null : DEFAULT_MODEL) };
  }
  return { value: await store.getSetting(key) };
});

app.put("/api/settings/:key", async (req, reply) => {
  const user = u(req);
  const { key } = req.params as { key: string };
  const { value } = req.body as { value: string };
  if (!isAllowedSettingKey(key)) return reply.code(400).send({ error: "Setting key not allowed" });
  if (/^(nvidia_|llm_)/.test(key) && user.global_role !== "admin") {
    return reply.code(403).send({ error: "Forbidden" });
  }
  if (key === "nvidia_api_key" && value === "••••••••") return { ok: true };
  await store.setSetting(key, value);
  return { ok: true };
});

app.post("/api/llm/test", async (req, reply) => {
  const user = u(req);
  if (user.global_role !== "admin") return reply.code(403).send({ error: "Forbidden" });
  return testLlmConnection(store);
});

app.get("/api/llm/available", async () => ({
  available: isAiAssistAvailable(),
  cloud: cloudAllowed,
}));

// Any signed-in user may ask questions; the prompt is built client-side and the
// SQL it produces still goes through runProjectQuery's guardrails.
app.post("/api/llm/chat", async (req) => {
  u(req);
  const { messages, maxTokens, temperature } = req.body as {
    messages: { role: string; content: string }[];
    maxTokens?: number;
    temperature?: number;
  };
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Invalid request: messages are required");
  }
  const content = await llmChat(store, messages, { maxTokens, temperature });
  return { content };
});

const spaRoot = path.resolve(process.env.SPA_ROOT || path.join(__dirname, "..", "..", "dist"));
if (process.env.SERVE_SPA === "1") {
  await app.register(fastifyStatic, { root: spaRoot, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "Not found" });
  });
}

await runMigrations();
await bootstrapAdmin();

app.listen({ port: PORT, host: "0.0.0.0" });
