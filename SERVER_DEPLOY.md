# Fieldbook — Lab server deployment

Run the shared **Postgres + API + web UI** on one lab machine. Colleagues open a browser on the LAN or over [Tailscale](https://tailscale.com/).

## Prerequisites

- Docker Desktop (Mac/Windows) or Docker Engine (Linux)
- Built web UI: `npm run build:server` in `research-data-hub/`
- A root `.env` file created from [`.env.example`](.env.example)

## Quick start

```bash
cd research-data-hub
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

## Folder / zip import

- **Desktop:** **Import research folder** — deterministic by default (no API key). Optional local AI if configured.
- **Browser:** same page → **Choose folder** or **Upload .zip**; atomic `POST /api/import/folder-job`.
- PDF/Word/images are skipped until exported to CSV/XLSX.
- Import history is stored per project (see Exports / history tab).

## Backup & restore (Postgres)

```bash
# From research-data-hub/
./scripts/pg-backup.sh ./backups/rdh-$(date +%Y%m%d).sql
./scripts/pg-restore.sh ./backups/rdh-YYYYMMDD.sql
```

Schedule a nightly cron on the lab host. Keep copies off the lab machine as well.

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
| **admin** (global) | All projects, LLM settings |
| **editor** (per project) | Upload, delete datasets, save queries, folder import |
| **viewer** (per project) | Query and export only |

Invite users on each project’s **Overview → Project access** (after they register).

## Desktop vs server

| Feature | Electron desktop | Lab server |
|---------|------------------|------------|
| CSV upload | Yes | Yes |
| Folder import | Yes (deterministic default) | Yes (browser folder / zip) |
| Multi-user | No | Yes |
| AI schema assist | Local LLM only (cloud off by default) | Same |
| Backup | Settings → Backup SQLite | `scripts/pg-backup.sh` |

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
| `SESSION_SECRET` | Cookie signing (≥32 chars; required in production; not `dev-change-me`) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | First admin (only when DB has no users) |
| `ALLOW_PUBLIC_REGISTER` | `1` to allow self-registration |
| `SERVE_SPA` | `1` to serve `dist/` from API |
| `COOKIE_SECURE` | `1` when using HTTPS |
| `CORS_ORIGIN` | Optional comma-separated allowed browser origins |
| `ALLOW_CLOUD_NIM` | Must stay unset/`0` for NHDOT; `1` enables cloud NVIDIA (non-prod only) |
| `LLM_BASE_URL` | Optional on-prem OpenAI-compatible base URL (e.g. `http://127.0.0.1:8000/v1`) |

## Acceptance

See [`NHDOT_ACCEPTANCE.md`](NHDOT_ACCEPTANCE.md).
