# NHDOT Acceptance Checklist - Research Data Hub

Use this checklist for production sign-off (lab server + desktop). Cloud NVIDIA NIM must remain **off** (`ALLOW_CLOUD_NIM` unset or not `1`).

## Environments under test

| Target | Host / version | Tester | Date |
|--------|----------------|--------|------|
| Lab server (browser) | | | |
| Desktop Electron | | | |

## A. Install & access

- [ ] Lab server: `docker compose up --build` from `research-data-hub`; login with admin credentials
- [ ] Desktop: launch Electron; SQLite path under Application Support is visible in Settings / logs
- [ ] Tailscale or LAN access works; `COOKIE_SECURE=1` when using HTTPS
- [ ] Viewer cannot upload/import; editor can

## B. Deterministic folder import (no AI)

- [ ] Desktop: **Import research folder** works **without** API key
- [ ] Server: **Choose folder** or **Upload .zip** creates tables
- [ ] PDF listed as skipped; CSV/TSV/XLSX imported
- [ ] Bad typed cells counted as invalid; valid rows still load (see fixture `fixtures/nhdot-mini`)
- [ ] **Datasets -> Import folder** adds into an **existing** project
- [ ] Import history shows mode, table/row/invalid counts (Exports / history tab)

## C. Failure & rollback

- [ ] Failed import into existing project leaves **no orphan** empty datasets
- [ ] Failed new-project import does not leave a half-created project

## D. Query & export

- [ ] SELECT queries work across imported tables
- [ ] DDL/DML rejected by query guard
- [ ] CSV export succeeds; export history logged

## D2. Browse & dashboard (no SQL)

- [ ] **Browse** tab: pick a table, check columns, filter IDs (e.g. `6001, 6002`), rows load
- [ ] Row checkboxes limit the export to the checked rows
- [ ] Export menu produces CSV, XLSX, PDF, TSV and JSON of the visible columns
- [ ] **Dashboard** view shows averages/min/max per numeric column and up to 4 charts
- [ ] Dashboard PDF contains the summary table, chart images and the data table
- [ ] Dashboard Excel has Summary, Data, Charts and Chart data sheets
- [ ] Every dashboard export is written to export history

## E. Backup & restore

- [ ] Desktop: Settings -> Backup database creates a `.sqlite3` file
- [ ] Desktop: Restore from backup restores prior projects (confirm with a test project)
- [ ] Server: `scripts/pg-backup.sh` / `scripts/pg-restore.sh` documented and dry-run successfully

## F. AI (optional - local only)

- [ ] Cloud NIM disabled by default; Settings explains NHDOT policy
- [ ] With `LLM_BASE_URL` only: optional "Improve schema with AI" appears
- [ ] Without local AI: deterministic path remains available

## G. Automated tests

```bash
cd research-data-hub
npm install
npm test
```

- [ ] `npm test` passes (golden fixture + query guard + backup + browse/dashboard specs)

## Sign-off

| Role | Name | Signature | Date |
|------|------|-----------|------|
| NHDOT IT | | | |
| Research lead | | | |
| Vendor / developer | | | |
