-- Import history tracking

CREATE TABLE IF NOT EXISTS import_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_path TEXT,
  mode TEXT NOT NULL DEFAULT 'deterministic',
  report JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_history_project ON import_history(project_id);
