export type PlanStatus =
  | "idle"
  | "planning"
  | "ready"
  | "executing"
  | "pr_open"
  | "completed"
  | "failed";

export type JobType = "plan" | "execute";
export type JobStatus = "queued" | "running" | "done" | "failed";

export type IssueSource = "github" | "jira";

export interface Issue {
  /** Provider the issue was pulled from. */
  source: IssueSource;
  /** Stable identity: GitHub issue number as a string, or JIRA key ("PROJ-12"). */
  key: string;
  /** GitHub issue number; null for JIRA issues. */
  number: number | null;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  url: string;
  labels: string[];
  /** JIRA issue type (e.g. "Story", "Bug"); null for GitHub. */
  issueType?: string | null;
  /** JIRA status name (e.g. "In Progress"); null for GitHub. */
  status?: string | null;
}

export interface RepoRef {
  owner: string;
  name: string;
  base: string;
}

/** Maps a JIRA project to the GitHub repo used for planning + execution. */
export interface JiraProjectMapping {
  id: number;
  projectKey: string;
  projectName: string;
  repoOwner: string;
  repoName: string;
  repoBase: string;
}

/** A selectable JIRA project. */
export interface JiraProject {
  key: string;
  name: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  nanoAiu: number;
  aiu: number;
  usd: number | null;
  durationMs: number;
  model: string | null;
  turns: number;
}

export interface PlanVersionRow {
  id: number;
  plan_id: number;
  version_no: number;
  markdown: string;
  source: "generated" | "user_edited" | "regenerated";
  feedback_prompt: string | null;
  input_tokens: number;
  output_tokens: number;
  nano_aiu: number;
  model: string | null;
  duration_ms: number;
  created_at: string;
}
