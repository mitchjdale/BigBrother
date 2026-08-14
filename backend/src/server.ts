import express from "express";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { config, jiraConfigured } from "./config.js";
import { db } from "./db.js";
import { logger, log } from "./logger.js";
import { listIssues, listSelectableRepos } from "./github.js";
import { listIssues as listJiraIssues, listProjects } from "./jira.js";
import { fetchIssue, repoForIssue } from "./issues.js";
import { listMappings, upsertMapping, deleteMapping } from "./mapping.js";
import {
  createPlanRecord,
  schedulePlanJob,
  getPlanView,
  saveUserEditedVersion,
  getCurrentPlanMarkdown,
  getLatestPlanIdForIssue,
  listLatestPlansByIssue,
  listWorkedIssueNumbers,
  deletePlan,
} from "./planner.js";
import { scheduleExecuteJob, refreshExecution, requestReviewForPlan } from "./execute.js";
import { getUsageReport, type Granularity } from "./reports.js";
import type { IssueSource, RepoRef } from "./types.js";

const httpLog = log("http");
const app = express();
const clearPlanLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests" },
});
const reviewRequestLimiter = rateLimit({
  windowMs: 10_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "review request is rate-limited; try again shortly" },
});

// Structured per-request logging (method, url, status, latency). Health checks
// are logged at debug to keep the stream readable.
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/health" },
    // pino-http binds `req` into the per-request child logger, so the only way
    // to keep it out of the success line is to log completions from the base
    // logger (quietResLogger). We then re-attach req/res explicitly on errors.
    quietResLogger: true,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    // Title line for every request (time + level + this message).
    customSuccessMessage: (req, res, responseTime) =>
      `${req.method} ${req.url} ${res.statusCode} (${responseTime}ms)`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} ${res.statusCode} - ${err.message}`,
    // Keep normal requests to a one-line summary; only attach the full
    // req/res JSON body when something went wrong (status >= 400 or an error).
    customSuccessObject: (req, res, val) =>
      res.statusCode >= 400 ? { req, ...val } : {},
    customErrorObject: (req, _res, _err, val) => ({ req, ...val }),
  }),
);

app.use(express.json({ limit: "2mb" }));

function parseModel(body: unknown): { model: string | null | undefined; error: string | null } {
  if (!body || typeof body !== "object") return { model: undefined, error: null };
  if (!Object.hasOwn(body, "model")) return { model: undefined, error: null };
  const model = (body as { model?: unknown }).model;
  if (model == null) return { model: null, error: null };
  if (typeof model !== "string") return { model: undefined, error: "model must be a string or null" };
  const trimmed = model.trim();
  return { model: trimmed || null, error: null };
}

function validRepoPart(v: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(v);
}

function validBranch(v: string): boolean {
  return !/\s/.test(v);
}

function parseRepo(
  source: Record<string, unknown> | undefined,
): { repo: RepoRef; error: string | null } {
  const ownerRaw = typeof source?.repoOwner === "string" ? source.repoOwner.trim() : config.repo.owner;
  const nameRaw = typeof source?.repoName === "string" ? source.repoName.trim() : config.repo.name;
  const baseRaw = typeof source?.repoBase === "string" ? source.repoBase.trim() : config.repo.base;

  if (!ownerRaw || !validRepoPart(ownerRaw)) {
    return { repo: { ...config.repo }, error: "repoOwner is invalid" };
  }
  if (!nameRaw || !validRepoPart(nameRaw)) {
    return { repo: { ...config.repo }, error: "repoName is invalid" };
  }
  if (!baseRaw || !validBranch(baseRaw)) {
    return { repo: { ...config.repo }, error: "repoBase is invalid" };
  }

  return { repo: { owner: ownerRaw, name: nameRaw, base: baseRaw }, error: null };
}

function queryToRecord(query: Record<string, unknown>): Record<string, unknown> {
  return {
    repoOwner: query.repoOwner,
    repoName: query.repoName,
    repoBase: query.repoBase,
  };
}

function parseSource(v: unknown): IssueSource {
  return v === "jira" ? "jira" : "github";
}

/**
 * Resolve the effective repo (clone + PR target) and optional JIRA project for
 * a request. GitHub uses the selected repo directly; JIRA resolves the repo
 * from the project→repo mapping.
 */
function resolveContext(
  source: IssueSource,
  data: Record<string, unknown> | undefined,
): { repo: RepoRef; projectKey: string | null; error: string | null } {
  if (source === "jira") {
    const projectKey = typeof data?.project === "string" ? data.project.trim() : "";
    if (!projectKey) return { repo: { ...config.repo }, projectKey: null, error: "project is required for JIRA" };
    try {
      const repo = repoForIssue("jira", projectKey, config.repo);
      return { repo, projectKey, error: null };
    } catch (err) {
      return {
        repo: { ...config.repo },
        projectKey,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const parsed = parseRepo(data);
  return { repo: parsed.repo, projectKey: null, error: parsed.error };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    defaultRepo: `${config.repo.owner}/${config.repo.name}`,
    hasToken: !!config.ghToken,
  });
});

app.get("/repos", async (_req, res) => {
  try {
    const repos = await listSelectableRepos();
    res.json({ defaultRepo: { ...config.repo }, repos });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Issue sources available to the UI (GitHub always; JIRA if configured) ---
app.get("/sources", (_req, res) => {
  res.json({ github: true, jira: jiraConfigured() });
});

// --- JIRA projects (for the Settings mapping form) ---
app.get("/jira/projects", async (_req, res) => {
  if (!jiraConfigured()) return res.status(400).json({ error: "JIRA is not configured" });
  try {
    res.json(await listProjects());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- JIRA project → GitHub repo mappings (managed on the Settings page) ---
app.get("/mappings", (_req, res) => {
  res.json(listMappings());
});

app.post("/mappings", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectKey = typeof body.projectKey === "string" ? body.projectKey.trim() : "";
  const projectName = typeof body.projectName === "string" ? body.projectName.trim() : "";
  if (!projectKey) return res.status(400).json({ error: "projectKey is required" });
  const parsedRepo = parseRepo(body);
  if (parsedRepo.error) return res.status(400).json({ error: parsedRepo.error });
  const mapping = upsertMapping({
    projectKey,
    projectName: projectName || projectKey,
    repo: parsedRepo.repo,
  });
  res.status(201).json(mapping);
});

app.delete("/mappings/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid mapping id" });
  const removed = deleteMapping(id);
  if (!removed) return res.status(404).json({ error: "mapping not found" });
  res.status(204).end();
});

// --- M1: list issues for the selected source (GitHub repo or JIRA project) ---
app.get("/repos/issues", async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const source = parseSource(query.source);
  if (source === "jira") {
    const projectKey = typeof query.project === "string" ? query.project.trim() : "";
    if (!projectKey) return res.status(400).json({ error: "project is required for JIRA" });
    try {
      return res.json(await listJiraIssues(projectKey));
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
  const parsedRepo = parseRepo(queryToRecord(query));
  if (parsedRepo.error) return res.status(400).json({ error: parsedRepo.error });
  const stateRaw = typeof req.query.state === "string" ? req.query.state.trim().toLowerCase() : "open";
  if (stateRaw !== "open" && stateRaw !== "closed") {
    return res.status(400).json({ error: "state must be 'open' or 'closed'" });
  }
  try {
    if (stateRaw === "closed") {
      const numbers = listWorkedIssueNumbers(parsedRepo.repo);
      if (numbers.length === 0) return res.json([]);
      return res.json(await listIssues(parsedRepo.repo, { state: "closed", numbers }));
    }
    res.json(await listIssues(parsedRepo.repo, { state: "open" }));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Issue #1: aggregated token/AIU usage across plans (global, optional repo filter) ---
app.get("/usage", (req, res) => {
  const query = req.query as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  const repoOwner = str(query.repoOwner);
  const repoName = str(query.repoName);
  if ((repoOwner && !repoName) || (!repoOwner && repoName)) {
    return res.status(400).json({ error: "repoOwner and repoName must be provided together" });
  }
  if (repoOwner && !validRepoPart(repoOwner)) {
    return res.status(400).json({ error: "repoOwner is invalid" });
  }
  if (repoName && !validRepoPart(repoName)) {
    return res.status(400).json({ error: "repoName is invalid" });
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = str(query.from);
  const to = str(query.to);
  if (from && !dateRe.test(from)) return res.status(400).json({ error: "from must be YYYY-MM-DD" });
  if (to && !dateRe.test(to)) return res.status(400).json({ error: "to must be YYYY-MM-DD" });

  const granularity: Granularity = query.granularity === "week" ? "week" : "day";

  res.json(getUsageReport({ repoOwner, repoName, from, to, granularity }));
});

// --- Hydration: latest plan per issue, so the UI can restore state after a reload ---
app.get("/plans", (req, res) => {
  const query = req.query as Record<string, unknown>;
  const source = parseSource(query.source);
  const ctx = resolveContext(source, {
    ...queryToRecord(query),
    project: query.project,
  });
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  res.json(listLatestPlansByIssue(ctx.repo, source));
});

// --- Fetch the latest persisted plan for a given issue (source + key) ---
app.get("/issues/:source/:key/plan", (req, res) => {
  const source = parseSource(req.params.source);
  const issueKey = String(req.params.key);
  const ctx = resolveContext(source, {
    ...queryToRecord(req.query as Record<string, unknown>),
    project: (req.query as Record<string, unknown>).project,
  });
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  const planId = getLatestPlanIdForIssue(source, issueKey, ctx.repo);
  if (planId == null) return res.status(404).json({ error: "no plan for issue" });
  const view = getPlanView(planId);
  if (!view) return res.status(404).json({ error: "no plan for issue" });
  res.json(view);
});

// --- M2: "Create plan" — enqueue a read-only planning job ---
// Reuses an existing plan record for the issue if one exists, so a re-run
// accumulates onto the same plan and its prior token usage is retained (#11).
app.post("/issues/:source/:key/plan", async (req, res) => {
  const source = parseSource(req.params.source);
  const issueKey = String(req.params.key);
  const parsedModel = parseModel(req.body);
  if (parsedModel.error) return res.status(400).json({ error: parsedModel.error });
  const ctx = resolveContext(source, (req.body ?? {}) as Record<string, unknown>);
  if (ctx.error) return res.status(400).json({ error: ctx.error });

  try {
    const issue = await fetchIssue(source, issueKey, ctx.repo);

    const existingId = getLatestPlanIdForIssue(source, issue.key, ctx.repo);
    if (existingId != null) {
      const existing = db.prepare(`SELECT status FROM plans WHERE id=?`).get(existingId) as
        | { status: string }
        | undefined;
      // Don't double-schedule while a job for this plan is already in flight.
      if (existing && (existing.status === "planning" || existing.status === "executing")) {
        return res.status(202).json({ planId: existingId, status: existing.status });
      }
      schedulePlanJob(existingId, { model: parsedModel.model });
      return res.status(202).json({ planId: existingId, status: "planning" });
    }

    const planId = createPlanRecord(issue, ctx.repo);
    schedulePlanJob(planId, { model: parsedModel.model });
    res.status(202).json({ planId, status: "planning" });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Issue #11: retry a failed (or completed) plan in-place, retaining cost ---
app.post("/plans/:id/retry", (req, res) => {
  const planId = Number(req.params.id);
  const parsedModel = parseModel(req.body);
  if (parsedModel.error) return res.status(400).json({ error: parsedModel.error });

  const plan = db.prepare(`SELECT status FROM plans WHERE id=?`).get(planId) as
    | { status: string }
    | undefined;
  if (!plan) return res.status(404).json({ error: "plan not found" });
  if (plan.status === "planning" || plan.status === "executing") {
    return res.status(409).json({ error: `plan is already ${plan.status}` });
  }

  schedulePlanJob(planId, { model: parsedModel.model });
  res.status(202).json({ planId, status: "planning" });
});

// --- M3 hook: regenerate with feedback ---
app.post("/plans/:id/regenerate", (req, res) => {
  const planId = Number(req.params.id);
  const feedback = String(req.body?.feedback ?? "").trim();
  if (!feedback) return res.status(400).json({ error: "feedback is required" });
  const parsedModel = parseModel(req.body);
  if (parsedModel.error) return res.status(400).json({ error: parsedModel.error });

  const plan = db.prepare(`SELECT issue_number FROM plans WHERE id=?`).get(planId) as
    | { issue_number: number }
    | undefined;
  if (!plan) return res.status(404).json({ error: "plan not found" });

  schedulePlanJob(planId, { feedback, model: parsedModel.model });
  res.status(202).json({ planId, status: "planning" });
});

// --- Poll plan status + markdown + cost ---
app.get("/plans/:id", (req, res) => {
  const view = getPlanView(Number(req.params.id));
  if (!view) return res.status(404).json({ error: "plan not found" });
  res.json(view);
});

app.delete("/plans/:id", clearPlanLimiter, (req, res) => {
  const planId = Number(req.params.id);
  if (!Number.isInteger(planId)) return res.status(400).json({ error: "invalid plan id" });
  const plan = db.prepare(`SELECT status FROM plans WHERE id=?`).get(planId) as
    | { status: string }
    | undefined;
  if (!plan) return res.status(404).json({ error: "plan not found" });
  if (plan.status === "planning" || plan.status === "executing") {
    return res.status(409).json({ error: `cannot clear while ${plan.status}` });
  }
  deletePlan(planId);
  res.status(204).end();
});

// --- M3: developer edits the plan markdown → new version ---
app.patch("/plans/:id/version", (req, res) => {
  const planId = Number(req.params.id);
  const markdown = String(req.body?.markdown ?? "").trim();
  if (!markdown) return res.status(400).json({ error: "markdown is required" });
  const versionId = saveUserEditedVersion(planId, markdown);
  if (!versionId) return res.status(404).json({ error: "plan not found" });
  res.json({ planId, versionId, status: "ready" });
});

// --- M4: approve → execute → draft PR via the Copilot cloud agent ---
app.post("/plans/:id/execute", (req, res) => {
  const planId = Number(req.params.id);
  const parsedModel = parseModel(req.body);
  if (parsedModel.error) return res.status(400).json({ error: parsedModel.error });
  const plan = db.prepare(`SELECT status FROM plans WHERE id=?`).get(planId) as
    | { status: string }
    | undefined;
  if (!plan) return res.status(404).json({ error: "plan not found" });
  if (plan.status !== "ready") {
    return res.status(409).json({ error: `plan not ready (status: ${plan.status})` });
  }
  const markdown = getCurrentPlanMarkdown(planId);
  if (!markdown) return res.status(409).json({ error: "no plan version to execute" });

  scheduleExecuteJob(planId, markdown, { model: parsedModel.model });
  res.status(202).json({ planId, status: "executing" });
});

// --- M4: re-poll the cloud agent to pick up the draft PR / latest state ---
app.post("/plans/:id/refresh-execution", async (req, res) => {
  const planId = Number(req.params.id);
  await refreshExecution(planId);
  const view = getPlanView(planId);
  if (!view) return res.status(404).json({ error: "plan not found" });
  res.json(view);
});

// --- Request (or re-request) Copilot code review on the draft PR ---
app.post("/plans/:id/review", reviewRequestLimiter, async (req, res) => {
  const planId = Number(req.params.id);
  const plan = db.prepare(`SELECT id FROM plans WHERE id=?`).get(planId) as { id: number } | undefined;
  if (!plan) return res.status(404).json({ error: "plan not found" });

  const result = await requestReviewForPlan(planId, { force: true });
  if (result === "no_pr" || result === "not_found") {
    return res.status(409).json({ error: "no PR to review yet" });
  }

  const view = getPlanView(planId);
  if (!view) return res.status(404).json({ error: "plan not found" });
  res.json(view);
});

// --- Centralised error + process logging ---
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  (req.log ?? httpLog).error({ err, path: req.path }, "unhandled request error");
  if (!res.headersSent) res.status(500).json({ error: message });
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
});

app.listen(config.port, () => {
  httpLog.info(
    {
      port: config.port,
      repo: `${config.repo.owner}/${config.repo.name}`,
      hasToken: !!config.ghToken,
      planConcurrency: config.planConcurrency,
      planModel: config.planModel || "auto",
      logLevel: config.logLevel,
    },
    "bigbrother backend started",
  );
});
