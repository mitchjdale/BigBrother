export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  labels: string[];
}

export interface RepoRef {
  owner: string;
  name: string;
  base: string;
}

export interface Cost {
  inputTokens: number;
  outputTokens: number;
  aiu: number;
  usd: number | null;
  estimatedUsd?: number;
  model?: string | null;
  durationMs?: number;
}

export interface PlanVersionMeta {
  versionNo: number;
  source: string;
  feedbackPrompt: string | null;
  aiu: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export type PlanStatus = "idle" | "planning" | "ready" | "executing" | "pr_open" | "failed";
export interface PlanView {
  id: number;
  issueNumber: number;
  status: PlanStatus;
  error: string | null;
  pr: {
    number: number | null;
    url: string | null;
    branch: string | null;
    agentState: string | null;
    reviewState: string | null;
    screenshotUrl: string | null;
  } | null;
  currentPlan: {
    versionNo: number;
    markdown: string;
    source: string;
    cost: Cost;
  } | null;
  totalCost: {
    inputTokens: number;
    outputTokens: number;
    aiu: number;
    usd: number | null;
    estimatedUsd: number;
    versions: number;
    attempts: number;
    failedAttempts: number;
  };
  versions: PlanVersionMeta[];
}

export type UsageGranularity = "day" | "week";

export interface PhaseTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiu: number;
  usd: number | null;
  estimatedUsd: number;
  attempts: number;
  failedAttempts: number;
}

export interface UsageBucket {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiu: number;
  usd: number | null;
  estimatedUsd: number;
  attempts: number;
  planning: PhaseTotals;
  implementation: PhaseTotals;
}

export interface RepoUsage {
  owner: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiu: number;
  usd: number | null;
  estimatedUsd: number;
  attempts: number;
  planning: PhaseTotals;
  implementation: PhaseTotals;
}

export interface UsageReport {
  granularity: UsageGranularity;
  from: string | null;
  to: string | null;
  usdPerAiu: number;
  summary: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    aiu: number;
    usd: number | null;
    estimatedUsd: number;
    attempts: number;
    failedAttempts: number;
    plans: number;
    repos: number;
    planning: PhaseTotals;
    implementation: PhaseTotals;
  };
  series: UsageBucket[];
  repos: RepoUsage[];
}

export interface UsageParams {
  repo?: RepoRef | null;
  from?: string;
  to?: string;
  granularity?: UsageGranularity;
}

const BASE = "/api";
function repoQuery(repo: RepoRef): string {
  const params = new URLSearchParams({
    repoOwner: repo.owner,
    repoName: repo.name,
    repoBase: repo.base,
  });
  return `?${params.toString()}`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listRepos: () =>
    fetch(`${BASE}/repos`).then(json<{ defaultRepo: RepoRef; repos: RepoRef[] }>),

  listIssues: (repo: RepoRef) => fetch(`${BASE}/repos/issues${repoQuery(repo)}`).then(json<Issue[]>),

  listPlans: (repo: RepoRef) =>
    fetch(`${BASE}/plans${repoQuery(repo)}`).then(
      json<{ issueNumber: number; planId: number; status: PlanStatus; estimatedUsd: number }[]>,
    ),

  getIssuePlan: (issueNumber: number, repo: RepoRef) =>
    fetch(`${BASE}/issues/${issueNumber}/plan${repoQuery(repo)}`).then(async (r) => {
      if (r.status === 404) return null;
      return json<PlanView>(r);
    }),

  createPlan: (issueNumber: number, repo: RepoRef, model: string | null = null) =>
    fetch(`${BASE}/issues/${issueNumber}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        repoOwner: repo.owner,
        repoName: repo.name,
        repoBase: repo.base,
      }),
    }).then(
      json<{ planId: number; status: PlanStatus }>,
    ),

  getPlan: (planId: number) => fetch(`${BASE}/plans/${planId}`).then(json<PlanView>),

  regenerate: (planId: number, feedback: string, model: string | null = null) =>
    fetch(`${BASE}/plans/${planId}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback, model }),
    }).then(json<{ planId: number; status: PlanStatus }>),

  retry: (planId: number, model: string | null = null) =>
    fetch(`${BASE}/plans/${planId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }).then(json<{ planId: number; status: PlanStatus }>),

  editVersion: (planId: number, markdown: string) =>
    fetch(`${BASE}/plans/${planId}/version`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown }),
    }).then(json<{ planId: number; versionId: number; status: PlanStatus }>),

  execute: (planId: number, model: string | null = null) =>
    fetch(`${BASE}/plans/${planId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }).then(
      json<{ planId: number; status: PlanStatus }>,
    ),

  refreshExecution: (planId: number) =>
    fetch(`${BASE}/plans/${planId}/refresh-execution`, { method: "POST" }).then(json<PlanView>),

  requestReview: (planId: number) =>
    fetch(`${BASE}/plans/${planId}/review`, { method: "POST" }).then(json<PlanView>),

  getUsage: (params: UsageParams = {}) => {
    const qs = new URLSearchParams();
    if (params.repo) {
      qs.set("repoOwner", params.repo.owner);
      qs.set("repoName", params.repo.name);
    }
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.granularity) qs.set("granularity", params.granularity);
    const q = qs.toString();
    return fetch(`${BASE}/usage${q ? `?${q}` : ""}`).then(json<UsageReport>);
  },
};
