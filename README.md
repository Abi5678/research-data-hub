# Fieldbook

An offline desktop app for pavement-lab research data. Import a folder of
spreadsheets, browse and query them, and run existing Python or MATLAB analysis
scripts against them without exporting anything back out to disk.

Built for NH DOT / NRRA work. **Everything runs locally** — the database is one
SQLite file on the researcher's machine, and cloud AI is off by default.

- Desktop app: Electron + React + SQLite (`better-sqlite3`)
- Optional lab-server mode: see [SERVER_DEPLOY.md](SERVER_DEPLOY.md)
- Sign-off checklist: [NHDOT_ACCEPTANCE.md](NHDOT_ACCEPTANCE.md)

---

## Getting the app

### From the built DMG

`release/Fieldbook-1.0.0-arm64.dmg` (Apple Silicon).

**macOS will refuse to open it on first try.** The build is signed with an
*Apple Development* certificate, not a *Developer ID Application* certificate,
so Gatekeeper rejects it as an unidentified developer. Confirmed with
`spctl -a -vvv`. After dragging Fieldbook to `/Applications`, run once:

```bash
xattr -dr com.apple.quarantine /Applications/Fieldbook.app
```

The app then launches normally, and you never need to do it again on that
machine. To remove this step for good, the build has to be signed with a
Developer ID Application certificate (paid Apple Developer Program) and
notarized — see [Releasing](#releasing).

### From source

Node 22 (this tree was built and tested on v22.23.1).

```bash
npm install
npm run electron:dev
```

That starts Vite on `127.0.0.1:5173` and opens Electron against it, with hot
reload for the renderer. Changes to anything under `electron/` need a restart.

---

## Where the data lives

One directory, and nothing outside it:

```
~/Library/Application Support/Fieldbook/
├── fieldbook.sqlite3     the whole database — projects, datasets, scripts, runs
└── script-runs/          one folder per script run (see below)
```

Dev and packaged builds deliberately share this directory
([main.cjs:258](electron/main.cjs:258)) so you don't end up with research data
split across two databases. `DB_PATH` overrides the file if you need a scratch
database.

**Backing up = copying `fieldbook.sqlite3`.** That is the entire point of the
single-file design.

---

## The Scripts tab

The feature that distinguishes this from a spreadsheet viewer: a researcher's
existing `.py` or `.m` file runs against project data, unmodified.

### How a run works

1. Pick one or more datasets, pick a script, press **Run**.
2. The app creates `script-runs/<projectId>/<runId>/` and writes into it:
   - the first selected dataset as **`data.csv`**, and any others as
     `data_<slug>.csv`
   - **`inputs.json`** — which file came from which dataset, with row counts
   - a snapshot of the script itself
3. That folder becomes the process working directory, so a script that already
   says `pd.read_csv("data.csv")` just works.
4. **Every file in the folder that the app did not put there is an output.**
   No output convention to learn — `plt.savefig("figure.png")` is enough.

Outputs come back in the run report: figures inline (the first two full size,
the rest as thumbnails that expand), CSV and Excel results previewed as a
table, and any result table importable back into the project as a dataset.

### The first run in a project asks permission

Scripts execute **with the user's full privileges and no sandbox**. That is
deliberate for a desktop research tool, and the app says so once per project
before the first run (stored as `scripts_trusted_<projectId>` in settings).
Nothing from the renderer is ever executed as a path — the renderer sends a
script *id*, and the main process reads that script's text out of SQLite.

Importing a script **copies its text into the database**. The original file on
disk is never modified, so AI edits and hand edits can't corrupt a
researcher's working script.

### Choosing interpreters

**Settings → interpreters.** Discovery is not `which` — on a typical lab Mac
`matlab` is not on `PATH` at all while MATLAB is installed under
`/Applications`, and `which -a python3` can return six interpreters of which
only some have pandas. So the app globs known install locations, *probes* each
candidate, and shows what it found:

```
Python 3.12.4 — pandas, numpy, matplotlib
Python 3.8.0  — none
```

Pick the one with the libraries. Stored as `python_path` / `matlab_path`.

MATLAB runs take about 90 seconds on a full workbook, most of it startup — the
log says `Starting MATLAB — this takes 20-40 seconds…` so an empty log doesn't
look like a hang. The run timeout is 10 minutes.

### Bundled IDEAL-CT templates

`templates/scripts/ct_index.py` and `ct_index.m` compute the IDEAL-CT (CT
Index) from Force/LVDT traces. They are offered as starting points in the
Scripts tab and handle the real lab export shape: one specimen per *column
pair* named only in the header (`ABPL-RT-1 Force, kN` / `ABPL-RT-1 LVDT, mm`),
with diameter/thickness/temperature living in a separate summary sheet.

Where a geometry value is missing entirely, the script falls back to a default
**and records which values were assumed in an `assumed_values` column**, plus a
warning line. CT Index scales as 1/(D²·t), so a silently guessed diameter is
small enough to look right in a report and wrong enough to matter — hence the
column.

The two templates agree to floating-point round-off (worst relative difference
3.3e-15 on CT Index across 29 specimens of the NH DOT 2025 data).

---

## AI is optional and off by default

`isAiAssistAvailable()` ([llm.cjs:24](electron/llm.cjs:24)) returns false unless
either:

- `LLM_BASE_URL` (env or the `llm_base_url` setting) points at a local/on-prem
  OpenAI-compatible endpoint, or
- `ALLOW_CLOUD_NIM=1` **and** an `nvidia_api_key` setting is stored — **not used
  for NH DOT production.**

Every AI-touched path has a working manual equivalent: folder import is
deterministic, and the Scripts tab is fully usable with the AI button hidden.
When AI is on, it never executes anything — it proposes a rewritten script as a
diff the user must accept, and running is still a separate click.

---

## Development

```bash
npm run electron:dev     # app with hot reload
npm test                 # vitest + native-module rebuild (see warning below)
npx tsc --noEmit         # typecheck
npx vite build           # renderer build
npm run lint             # eslint — NOT clean at HEAD, compare against a baseline
```

> **`npm test` gotcha.** The script is
> `npm rebuild better-sqlite3 && vitest run && npx electron-rebuild -f -w better-sqlite3`.
> The `&&` chain means **a failing test run short-circuits before the trailing
> rebuild and leaves `better-sqlite3` on the Node ABI**, which breaks the next
> Electron start with a version-mismatch error. If that happens:
>
> ```bash
> npx electron-rebuild -f -w better-sqlite3
> ```

Vitest picks up `.test.{js,mjs,cjs,ts}` — **not `.tsx`**. Renderer components
have no unit coverage by design; they are verified by `tsc`, `vite build`, and
running the app.

### Layout

```
electron/     main process — db.cjs (SQLite + all CRUD), script-runner.cjs,
              runtimes.cjs (interpreter discovery), llm.cjs, main.cjs, preload.cjs
src/          renderer — routes/, components/project/<tab>.tsx, lib/
templates/    bundled IDEAL-CT scripts
tests/        vitest suites (158 tests, 18 files)
server/       optional lab-server mode
```

A project page is a set of tabs — Overview, Ask, Datasets, Browse, Analyze,
Query, Search, Scripts, Exports — each one a component in
`src/components/project/`.

---

## Releasing

```bash
npm run electron:build       # macOS  → release/Fieldbook-<version>-arm64.dmg
npm run electron:build:win   # Windows → release/*.exe
```

**Before shipping to anyone outside this machine**, the signing gap above needs
closing, or every recipient has to run the `xattr` command:

1. A **Developer ID Application** certificate in the keychain (requires a paid
   Apple Developer Program membership). Today the only identity present is
   `Apple Development: …`, which Gatekeeper rejects for distribution.
2. Notarization credentials, so `electron-builder` stops reporting
   `skipped macOS notarization`.

The app icon is drawn by [scripts/make-icon.py](scripts/make-icon.py) rather
than checked in only as a binary, so a colour or proportion can be changed
without a design tool:

```bash
python3 scripts/make-icon.py
```

It writes `build/icon.png`, `build/icon.icns` (via macOS `iconutil`) and
`build/icon.ico`, which `electron-builder` picks up from `buildResources`.
Needs Pillow.

The Windows installer in `release/` is older than the macOS one and predates
the rename to Fieldbook; rebuild it before handing it to anyone.
