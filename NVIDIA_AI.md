# AI schema assist (optional)

Folder import is **deterministic by default** (one table per file/sheet). No API key is required.

## NHDOT production policy

- **Cloud NVIDIA NIM is OFF** unless `ALLOW_CLOUD_NIM=1` (do not enable for NHDOT production).
- Profiles and sample rows must not leave the NHDOT network via cloud APIs.
- Optional assist: set `LLM_BASE_URL` (or Settings → Local LLM base URL) to an on-prem OpenAI-compatible endpoint.

## Desktop

1. **Import research folder** — works offline.
2. If a local LLM is configured, optionally check **Improve schema with AI**.
3. If AI fails or is unavailable, the app falls back to the deterministic plan.

## What would be sent to an LLM (when enabled)

- Relative file paths, sheet names
- Column headers and inferred types
- Up to **20 sample rows** per source (truncated cells)
- Not sent: full file contents beyond those samples

## Scan limits

| Setting | Default | Env override |
|---------|---------|--------------|
| Folder depth | 12 | `IMPORT_MAX_DEPTH` |
| Sources (file/sheet) | 120 | `IMPORT_MAX_SOURCES` |
| Max file size | 200 MB | `IMPORT_MAX_FILE_BYTES` |
| Sample rows per source | 20 | `IMPORT_SAMPLE_ROWS` |

**Accepted:** `.csv`, `.tsv`, `.txt`, `.xlsx`, `.xlsm`  
**Skipped:** legacy `.xls`, PDF/Word/images/archives

## Lab server

- Browser folder/zip import is always deterministic and uses atomic `POST /api/import/folder-job`.
- LLM settings are admin-only; cloud remains gated by `ALLOW_CLOUD_NIM`.
