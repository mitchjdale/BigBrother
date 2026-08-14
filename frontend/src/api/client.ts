export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  labels: string[];
}

export interface Cost {
  inputTokens: number;
  outputTokens: number;
  aiu: number;
  usd: number | null;
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
    versions: number;
  };
  versions: PlanVersionMeta[];
}

const BASE = "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listIssues: () => fetch(`${BASE}/repos/issues`).then(json<Issue[]>),

  createPlan: (issueNumber: number) =>
    fetch(`${BASE}/issues/${issueNumber}/plan`, { method: "POST" }).then(
      json<{ planId: number; status: PlanStatus }>,
    ),

  getPlan: (planId: number) => fetch(`${BASE}/plans/${planId}`).then(json<PlanView>),

  regenerate: (planId: number, feedback: string) =>
    fetch(`${BASE}/plans/${planId}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback }),
    }).then(json<{ planId: number; status: PlanStatus }>),

  editVersion: (planId: number, markdown: string) =>
    fetch(`${BASE}/plans/${planId}/version`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown }),
    }).then(json<{ planId: number; versionId: number; status: PlanStatus }>),

  execute: (planId: number) =>
    fetch(`${BASE}/plans/${planId}/execute`, { method: "POST" }).then(
      json<{ planId: number; status: PlanStatus }>,
    ),

  refreshExecution: (planId: number) =>
    fetch(`${BASE}/plans/${planId}/refresh-execution`, { method: "POST" }).then(json<PlanView>),
};
