// Миграции схемы SQLite. Только добавляются в конец; применённые не менять.
export interface Migration { version: number; name: string; sql: string }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  trigger_node_id TEXT,
  parent_run_id TEXT,
  parent_node_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT NOT NULL,
  trigger_data TEXT NOT NULL,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_runs_workflow ON runs(workflow_id, created_at DESC);
CREATE INDEX idx_runs_status ON runs(status);
CREATE UNIQUE INDEX idx_runs_child ON runs(parent_run_id, parent_node_id) WHERE parent_run_id IS NOT NULL;
CREATE TABLE run_nodes (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  input TEXT,
  outputs TEXT,
  error TEXT,
  summary TEXT,
  wait TEXT,
  resume_at INTEGER,
  resume_payload TEXT,
  log TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, node_id)
);
CREATE INDEX idx_run_nodes_wait ON run_nodes(status, resume_at);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- queued | claimed
  available_at INTEGER NOT NULL,
  locked_by TEXT,
  lease_until INTEGER,
  rerun INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- на один запуск не больше одного активного задания
CREATE UNIQUE INDEX idx_jobs_run_active ON jobs(run_id);
CREATE INDEX idx_jobs_claim ON jobs(status, available_at);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,             -- AES-256-GCM, v1:base64
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE schedule_state (
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  PRIMARY KEY (workflow_id, node_id)
);
CREATE TABLE telegram_offsets (token_hash TEXT PRIMARY KEY, next_offset INTEGER NOT NULL);
`,
  },
];
