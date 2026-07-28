# NVIDIA NIM — AI folder import

Research Data Hub uses **NVIDIA NIM** (OpenAI-compatible chat) for **Create project from folder**: column headers and a few sample rows are sent to the cloud so Nemotron can propose a relational schema.

## Default model

- **Primary:** `nvidia/llama-3.3-nemotron-super-49b-instruct`
- Configure under **Settings** (desktop) or **admin Settings** (lab server).
- Use **Test connection** — if the model 404s, pick another **Nemotron Instruct** id from [build.nvidia.com](https://build.nvidia.com).

## What is sent to NVIDIA

- File paths (relative to the folder you picked)
- Sheet names
- Column headers and inferred types
- Up to **5 sample rows** per source (truncated cells)
- Not sent: full CSV contents, unless they appear in those sample rows

## What is not used (v1)

- NVIDIA Agent Toolkit / AIQ multi-agent flows
- Local Triton / on-GPU NIM (optional future work for air-gapped labs)

## Lab server

- API keys are stored in Postgres **`settings`** table; only **global admins** can read/update.
- Keys are **never returned** to the browser after save (masked as `••••••••`).
- Folder import remains **desktop-only**; browser users upload CSVs per dataset.

## PI / data handling

Before using cloud NIM on sensitive field data, confirm with your sponsor (e.g. NHDOT) that sending **metadata + sample rows** to NVIDIA’s API is acceptable. For stricter control, use desktop-only mode without configuring an API key, or plan a future local-NIM deployment.
