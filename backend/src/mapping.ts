import { db } from "./db.js";
import type { JiraProjectMapping, RepoRef } from "./types.js";

interface MappingRow {
  id: number;
  project_key: string;
  project_name: string;
  repo_owner: string;
  repo_name: string;
  repo_base: string;
}

function toMapping(row: MappingRow): JiraProjectMapping {
  return {
    id: row.id,
    projectKey: row.project_key,
    projectName: row.project_name,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoBase: row.repo_base,
  };
}

/** All JIRA project → GitHub repo mappings. */
export function listMappings(): JiraProjectMapping[] {
  const rows = db
    .prepare(`SELECT * FROM jira_project_map ORDER BY project_key ASC`)
    .all() as MappingRow[];
  return rows.map(toMapping);
}

/** Create (or replace) a mapping for a project. Returns the stored mapping. */
export function upsertMapping(input: {
  projectKey: string;
  projectName: string;
  repo: RepoRef;
}): JiraProjectMapping {
  db.prepare(
    `INSERT INTO jira_project_map (project_key, project_name, repo_owner, repo_name, repo_base)
     VALUES (@projectKey, @projectName, @owner, @name, @base)
     ON CONFLICT(project_key) DO UPDATE SET
       project_name = excluded.project_name,
       repo_owner = excluded.repo_owner,
       repo_name = excluded.repo_name,
       repo_base = excluded.repo_base`,
  ).run({
    projectKey: input.projectKey,
    projectName: input.projectName,
    owner: input.repo.owner,
    name: input.repo.name,
    base: input.repo.base,
  });
  const row = db
    .prepare(`SELECT * FROM jira_project_map WHERE project_key = ?`)
    .get(input.projectKey) as MappingRow;
  return toMapping(row);
}

/** Delete a mapping by id. Returns true when a row was removed. */
export function deleteMapping(id: number): boolean {
  const info = db.prepare(`DELETE FROM jira_project_map WHERE id = ?`).run(id);
  return info.changes > 0;
}

/** Resolve a JIRA project key to its mapped GitHub repo, or null if unmapped. */
export function repoForProject(projectKey: string): RepoRef | null {
  const row = db
    .prepare(`SELECT * FROM jira_project_map WHERE project_key = ?`)
    .get(projectKey) as MappingRow | undefined;
  if (!row) return null;
  return { owner: row.repo_owner, name: row.repo_name, base: row.repo_base };
}
