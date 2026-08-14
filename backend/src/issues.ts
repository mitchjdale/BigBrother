import * as github from "./github.js";
import * as jira from "./jira.js";
import { repoForProject } from "./mapping.js";
import type { Issue, IssueSource, RepoRef } from "./types.js";

/**
 * Provider-agnostic issue access. GitHub issues are keyed by their numeric
 * `number` within a repo; JIRA issues are keyed by their string `key` within a
 * project that is mapped to a GitHub repo. The rest of the app only deals with
 * the common `Issue` shape returned here.
 */

/** List issues for a GitHub repo. */
export async function listGithubIssues(repo: RepoRef): Promise<Issue[]> {
  return github.listIssues(repo);
}

/** List issues for a JIRA project (must be mapped to a repo). */
export async function listJiraIssues(projectKey: string): Promise<Issue[]> {
  return jira.listIssues(projectKey);
}

/** Fetch one issue by source + key, using `repo` for GitHub lookups. */
export async function fetchIssue(
  source: IssueSource,
  key: string,
  repo: RepoRef,
): Promise<Issue> {
  if (source === "jira") return jira.getIssue(key);
  const num = Number(key);
  if (!Number.isInteger(num)) throw new Error(`invalid GitHub issue key: ${key}`);
  return github.getIssue(num, repo);
}

/**
 * The GitHub repo used to clone + open the PR for an issue. GitHub issues use
 * their own repo; JIRA issues use the project→repo mapping.
 */
export function repoForIssue(
  source: IssueSource,
  projectKey: string | null,
  githubRepo: RepoRef,
): RepoRef {
  if (source !== "jira") return githubRepo;
  if (!projectKey) throw new Error("JIRA project key is required");
  const repo = repoForProject(projectKey);
  if (!repo) throw new Error(`no repository mapping for JIRA project ${projectKey}`);
  return repo;
}
