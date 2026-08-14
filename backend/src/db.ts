import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });

export const db = new Database(config.sqlitePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_base TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  issue_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  current_version_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'generated',
  feedback_prompt TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  nano_aiu INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  session_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  session_ref TEXT,
  pr_number INTEGER,
  url TEXT,
  branch TEXT,
  agent_state TEXT,
  review_state TEXT,
  review_error TEXT,
  screenshot_url TEXT,
  raw_output TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- Migrations for existing databases ---
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Per-repo plans (UI repository selection, issue #2): backfill repo_base.
if (
  !(db.prepare(`PRAGMA table_info(plans)`).all() as { name: string }[]).some(
    (c) => c.name === "repo_base",
  )
) {
  db.exec(`ALTER TABLE plans ADD COLUMN repo_base TEXT`);
  db.prepare(`UPDATE plans SET repo_base = ? WHERE repo_base IS NULL OR repo_base = ''`).run(
    config.repo.base,
  );
}

// Track per-attempt token/cost on the jobs table so cumulative usage is
// retained even when an attempt fails or a plan is re-run (issue #11).
ensureColumn("jobs", "input_tokens", "input_tokens INTEGER NOT NULL DEFAULT 0");
ensureColumn("jobs", "output_tokens", "output_tokens INTEGER NOT NULL DEFAULT 0");
ensureColumn("jobs", "nano_aiu", "nano_aiu INTEGER NOT NULL DEFAULT 0");
ensureColumn("jobs", "model", "model TEXT");
ensureColumn("jobs", "duration_ms", "duration_ms INTEGER NOT NULL DEFAULT 0");
ensureColumn("prs", "review_state", "review_state TEXT");
ensureColumn("prs", "review_error", "review_error TEXT");

// --- Multi-source issues (GitHub Issues + JIRA) ---
// Issues can now come from GitHub (integer number) or JIRA (string key like
// "PROJ-123"). `issue_key` is the stable identity for both; `issue_number`
// remains the GitHub issue number (0 for JIRA rows). `issue_source` selects the
// provider. Additive + backfilled so existing GitHub plans keep working.
ensureColumn("plans", "issue_source", "issue_source TEXT NOT NULL DEFAULT 'github'");
ensureColumn("plans", "issue_key", "issue_key TEXT");
db.prepare(
  `UPDATE plans SET issue_key = CAST(issue_number AS TEXT)
   WHERE issue_key IS NULL OR issue_key = ''`,
).run();

// Maps a JIRA project to the GitHub repo used to clone (planning) and open the
// draft PR (execution). Managed from the Settings page. 1 project → 1 repo.
db.exec(`
CREATE TABLE IF NOT EXISTS jira_project_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL UNIQUE,
  project_name TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_base TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function now(): string {
  return new Date().toISOString();
}
