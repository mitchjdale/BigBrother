import express from "express";
import { pinoHttp } from "pino-http";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { db } from "./db.js";
import { logger, log } from "./logger.js";
import { getIssue, listIssues, listSelectableRepos } from "./github.js";
import {
  createPlanRecord,
  schedulePlanJob,
  getPlanView,
  saveUserEditedVersion,
  getCurrentPlanMarkdown,
  getLatestPlanIdForIssue,
  listLatestPlansByIssue,
} from "./planner.js";
import { scheduleExecuteJob, refreshExecution, requestReviewForPlan } from "./execute.js";
import { getUsageReport, type Granularity } from "./reports.js";
import type { RepoRef } from "./types.js";

const httpLog = log("http");
const app = express();
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

function parseIssueState(query: Record<string, unknown>): {
  state: "open" | "closed" | "all";
  error: string | null;
} {
  const raw = typeof query.state === "string" ? query.state.trim().toLowerCase() : "";
  if (!raw) return { state: "all", error: null };
  if (raw === "open" || raw === "closed" || raw === "all") return { state: raw, error: null };
  return { state: "all", error: "state must be one of: open, closed, all" };
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

// --- M1: list issues for the selected repo ---
app.get("/repos/issues", async (req, res) => {
  const parsedRepo = parseRepo(queryToRecord(req.query as Record<string, unknown>));
  if (parsedRepo.error) return res.status(400).json({ error: parsedRepo.error });
  const parsedState = parseIssueState(req.query as Record<string, unknown>);
  if (parsedState.error) return res.status(400).json({ error: parsedState.error });
  try {
    res.json(await listIssues(parsedRepo.repo, parsedState.state));
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
  const parsedRepo = parseRepo(queryToRecord(req.query as Record<string, unknown>));
  if (parsedRepo.error) return res.status(400).json({ error: parsedRepo.error });
  res.json(listLatestPlansByIssue(parsedRepo.repo));
});

// --- Fetch the latest persisted plan for a given issue ---
app.get("/issues/:number/plan", (req, res) => {
  const issueNumber = Number(req.params.number);
  if (!Number.isInteger(issueNumber)) return res.status(400).json({ error: "invalid issue number" });
  const parsedRepo = parseRepo(queryToRecord(req.query as Record<string, unknown>));
  if (parsedRepo.error) return res.status(400).json({ error: parsedRepo.error });
  const planId = getLatestPlanIdForIssue(issueNumber, parsedRepo.repo);
  if (planId == null) return res.status(404).json({ error: "no plan for issue" });
  const view = getPlanView(planId);
  if (!view) return res.status(404).json({ error: "no plan for issue" });
  res.json(view);
});

// --- M2: "Create plan" — enqueue a read-only planning job ---
// Reuses an existing plan record for the issue if one exists, so a re-run
// accumulates onto the same plan and its prior token usage is retained (#11).
app.post("/issues/:number/plan", async (req, res) => {
  const issueNumber = Number(req.params.number);
  if (!Number.isInteger(issueNumber)) return res.status(400).json({ error: "invalid issue number" });
  const parsedModel = parseModel(req.body);
  if (parsedModel.error) return res.status(400).json({ error: parsedModel.error });
  const parsedRepo = parseRepo((req.body ?? {}) as Record<string, unknown>);
  if (parsedRepo.error) return res.status(400).json({ error: parsedRepo.error });

  try {
    const issue = await getIssue(issueNumber, parsedRepo.repo);

    const existingId = getLatestPlanIdForIssue(issue.number, parsedRepo.repo);
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

    const planId = createPlanRecord(issue.number, issue.title, parsedRepo.repo);
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
