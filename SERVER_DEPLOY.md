# Research Data Hub — Lab server deployment

Run the shared **Postgres + API + web UI** on one lab machine. Colleagues open a browser on the LAN or over [Tailscale](https://tailscale.com/).

## Prerequisites

- Docker Desktop (Mac/Windows) or Docker Engine (Linux)
- Built web UI: `npm run build` in `CSV Graph Query-2/`
- A root `.env` file created from [`.env.example`](.env.example)

## Quick start

```bash
cd "CSV Graph Query-2"
npm install
npm run build:server
cp .env.example .env
cd server && npm install && cd ..
docker compose up --build
```

Open `http://<lab-machine-ip>:8080` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from [`server/.env.example`](server/.env.example) (or docker-compose `environment`).

## Development (API + Vite proxy)

Terminal 1 — Postgres:

```bash
docker compose up postgres
```

Terminal 2 — API:

```bash
cd server
cp .env.example .env
npm install
npm run dev
```

Terminal 3 — Web UI (server mode):

```bash
cd ..
VITE_SERVER_MODE=1 npm run dev
```

Vite proxies `/api` to `http://127.0.0.1:8080` (see `vite.config.ts`).

## Remote access (recommended: Tailscale)

1. Install Tailscale on the lab host and each colleague laptop.
2. On the host: `tailscale serve --bg http://127.0.0.1:8080` or expose port 8080 on the Tailscale IP.
3. Set `COOKIE_SECURE=1` when serving over HTTPS (Tailscale Serve provides TLS).
4. Do **not** port-forward 8080 to the public internet without a VPN.

## LAN-only access

- Bind is `0.0.0.0:8080` inside the API container.
- Restrict with your firewall to campus/LAN CIDRs.

## Roles

| Role | Projects |
|------|----------|
| **admin** (global) | All projects, NVIDIA API settings |
| **editor** (per project) | Upload, delete datasets, save queries |
| **viewer** (per project) | Query and export only |

Invite users on each project’s **Overview → Project access** (after they register).

## Desktop vs server

| Feature | Electron desktop | Lab server |
|---------|------------------|------------|
| CSV upload | Yes | Yes |
| Folder import | Yes (local folder) | Yes (browser folder picker; CSV/XLSX sheets) |
| Multi-user | No | Yes |
| NVIDIA API key | Local SQLite | Server DB (admin only) |

Server folder import parses files in the browser and uploads typed rows to PostgreSQL. It retains the relative source path in dataset metadata, but does not yet archive immutable copies of the original files; keep the source folder and maintain a separate backup until file archiving is added.

## Migrate from desktop SQLite

See [`scripts/migrate-sqlite-to-pg.mjs`](scripts/migrate-sqlite-to-pg.mjs):

```bash
node scripts/migrate-sqlite-to-pg.mjs \
  --sqlite data/local.sqlite3 \
  --pg "$DATABASE_URL"
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | Cookie signing |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | First admin (only when DB has no users) |
| `ALLOW_PUBLIC_REGISTER` | `1` to allow self-registration |
| `SERVE_SPA` | `1` to serve `dist/` from API |
| `COOKIE_SECURE` | `1` when using HTTPS |
| `CORS_ORIGIN` | Optional comma-separated allowed browser origins; leave unset for same-origin deployment |
