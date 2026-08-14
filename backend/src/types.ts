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

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  url: string;
  labels: string[];
}

export interface RepoRef {
  owner: string;
  name: string;
  base: string;
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
