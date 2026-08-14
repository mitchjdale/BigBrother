export type IssueSource = "github" | "jira";

export interface Issue {
  source: IssueSource;
  key: string;
  number: number | null;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  url: string;
  labels: string[];
  issueType?: string | null;
  status?: string | null;
}

export interface RepoRef {
  owner: string;
  name: string;
  base: string;
}

export interface JiraProject {
  key: string;
  name: string;
}

export interface JiraProjectMapping {
  id: number;
  projectKey: string;
  projectName: string;
  repoOwner: string;
  repoName: string;
  repoBase: string;
}

export interface Sources {
  github: boolean;
  jira: boolean;
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

export type PlanStatus = "idle" | "planning" | "ready" | "executing" | "pr_open" | "completed" | "failed";
export interface PlanView {
  id: number;
  issueNumber: number | null;
  issueKey: string;
  source: IssueSource;
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

/** What the backend needs to resolve issues + the clone/PR repo per source. */
export type IssueContext =
  | { source: "github"; repo: RepoRef }
  | { source: "jira"; project: string };

const BASE = "/api";

function contextQuery(ctx: IssueContext): string {
  const params = new URLSearchParams({ source: ctx.source });
  if (ctx.source === "github") {
    params.set("repoOwner", ctx.repo.owner);
    params.set("repoName", ctx.repo.name);
    params.set("repoBase", ctx.repo.base);
  } else {
    params.set("project", ctx.project);
  }
  return `?${params.toString()}`;
}

function contextBody(ctx: IssueContext): Record<string, string> {
  if (ctx.source === "github") {
    return {
      source: "github",
      repoOwner: ctx.repo.owner,
      repoName: ctx.repo.name,
      repoBase: ctx.repo.base,
    };
  }
  return { source: "jira", project: ctx.project };
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

  listSources: () => fetch(`${BASE}/sources`).then(json<Sources>),

  listJiraProjects: () => fetch(`${BASE}/jira/projects`).then(json<JiraProject[]>),

  listMappings: () => fetch(`${BASE}/mappings`).then(json<JiraProjectMapping[]>),

  createMapping: (input: { projectKey: string; projectName: string; repo: RepoRef }) =>
    fetch(`${BASE}/mappings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectKey: input.projectKey,
        projectName: input.projectName,
        repoOwner: input.repo.owner,
        repoName: input.repo.name,
        repoBase: input.repo.base,
      }),
    }).then(json<JiraProjectMapping>),

  deleteMapping: (id: number) =>
    fetch(`${BASE}/mappings/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
    }),

  listIssues: (ctx: IssueContext, state: "open" | "closed" = "open") =>
    fetch(`${BASE}/repos/issues${contextQuery(ctx)}&state=${state}`).then(json<Issue[]>),

  listPlans: (ctx: IssueContext) =>
    fetch(`${BASE}/plans${contextQuery(ctx)}`).then(
      json<{
        issueKey: string;
        issueNumber: number | null;
        source: IssueSource;
        planId: number;
        status: PlanStatus;
        estimatedUsd: number;
      }[]>,
    ),

  getIssuePlan: (ctx: IssueContext, issueKey: string) =>
    fetch(`${BASE}/issues/${ctx.source}/${encodeURIComponent(issueKey)}/plan${contextQuery(ctx)}`).then(
      async (r) => {
        if (r.status === 404) return null;
        return json<PlanView>(r);
      },
    ),

  createPlan: (ctx: IssueContext, issueKey: string, model: string | null = null) =>
    fetch(`${BASE}/issues/${ctx.source}/${encodeURIComponent(issueKey)}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, ...contextBody(ctx) }),
    }).then(json<{ planId: number; status: PlanStatus }>),

  getPlan: (planId: number) => fetch(`${BASE}/plans/${planId}`).then(json<PlanView>),

  deletePlan: (planId: number) =>
    fetch(`${BASE}/plans/${planId}`, { method: "DELETE" }).then(async (r) => {
      if (!r.ok && r.status !== 204) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
      }
    }),

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
