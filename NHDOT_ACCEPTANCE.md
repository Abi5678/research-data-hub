# NHDOT Acceptance Checklist - Fieldbook

Use this checklist for production sign-off (lab server + desktop). Cloud NVIDIA NIM must remain **off** (`ALLOW_CLOUD_NIM` unset or not `1`).

## Environments under test

| Target | Host / version | Tester | Date |
|--------|----------------|--------|------|
| Lab server (browser) | | | |
| Desktop Electron | | | |

## A. Install & access

- [ ] Lab server: `docker compose up --build` from `research-data-hub`; login with admin credentials
- [ ] Desktop: launch Electron; SQLite path under Application Support is visible in Settings / logs
- [ ] Desktop from the DMG: drag to `/Applications`, then clear Gatekeeper once with
      `xattr -dr com.apple.quarantine /Applications/Fieldbook.app` and confirm it launches
- [ ] Tailscale or LAN access works; `COOKIE_SECURE=1` when using HTTPS
- [ ] Viewer cannot upload/import; editor can

> **Open item, not a test failure.** The current build is signed with an *Apple Development*
> certificate rather than *Developer ID Application*, so Gatekeeper blocks first launch on
> every machine until the `xattr` command above is run. Closing this needs a paid Apple
> Developer Program certificate plus notarization — see **Releasing** in the README.

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

## D3. Analysis scripts (desktop only)

The **Scripts** tab is hidden in server mode by design; the HTTP API answers
"Analysis scripts are only available in the desktop app."

- [ ] Server (browser): no **Scripts** tab appears
- [ ] Desktop: **Settings** lists Python candidates with their probed libraries
      (e.g. `Python 3.12.4 — pandas, numpy, matplotlib`) and MATLAB is found
      under `/Applications` even though `matlab` is not on `PATH`
- [ ] Choosing an interpreter persists across a restart (`python_path` / `matlab_path`)
- [ ] With no interpreter chosen, **Run** is disabled and the tab says which one to pick

### Running a script

- [ ] **Scripts -> Add** a researcher's own `.py`; the file on disk is **byte-identical afterwards**
- [ ] Bundled **IDEAL-CT Index** (Python and MATLAB) both appear as starting points
- [ ] First run in a project raises the trust prompt ("Scripts run on this computer
      with your full permissions"); it does **not** reappear on the second run
- [ ] Dataset picker shows the selected count (`N of M selected`) and **Select all** / **Clear** work
- [ ] Run streams the log live rather than only at exit; **Stop** ends a running script
- [ ] MATLAB run shows `Starting MATLAB — this takes 20-40 seconds…` instead of an empty log
- [ ] A script that raises is recorded as a **finished failed run** with its traceback — not an app error

### Data handed to the script

- [ ] Run folder under `Application Support/Fieldbook/script-runs/` contains
      `inputs.json` and the script snapshot
- [ ] First selected dataset arrives as `data.csv`, further ones as `data_<slug>.csv`
- [ ] Row count written matches the dataset's row count exactly (no silent truncation)
- [ ] After a **successful** run the seeded `data*.csv` are removed; after a **failed**
      run they are kept for diagnosis

### Results

- [ ] Figures render inline: the first two full size, the remaining per-specimen plots
      as thumbnails that expand on click
- [ ] A result `.csv` shows a 10-row preview with a "First 10 of N rows" footer
- [ ] A result `.xlsx` previews too, and a multi-sheet workbook names the sheet shown
- [ ] **Import as dataset** on a result file creates a queryable dataset (one per sheet
      for a workbook) and it appears in **Browse**
- [ ] **Open run folder** reveals the folder in Finder

### IDEAL-CT correctness (NH DOT 2025 data)

- [ ] Python and MATLAB templates produce the **same specimens and the same CT Index**
      from the same selected tables
- [ ] Specimens missing a measured diameter/thickness/temperature are listed in the
      `assumed_values` column **and** a warning states how many of how many
- [ ] Selecting the specimen-summary table alongside the trace tables clears those
      assumptions

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

- [ ] `npm test` passes (golden fixture + query guard + backup + browse/dashboard +
      script-runner specs)

> If `npm test` **fails**, the `&&` chain stops before its trailing
> `electron-rebuild` and leaves `better-sqlite3` built for Node, which breaks the
> next Electron start. Recover with `npx electron-rebuild -f -w better-sqlite3`
> before re-testing the desktop app.

## Sign-off

| Role | Name | Signature | Date |
|------|------|-----------|------|
| NHDOT IT | | | |
| Research lead | | | |
| Vendor / developer | | | |
