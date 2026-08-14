import express from "express";
import { config } from "./config.js";
import { db } from "./db.js";
import { listIssues, getIssue } from "./github.js";
import {
  createPlanRecord,
  schedulePlanJob,
  getPlanView,
  saveUserEditedVersion,
  getCurrentPlanMarkdown,
} from "./planner.js";
import { scheduleExecuteJob, refreshExecution } from "./execute.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, repo: `${config.repo.owner}/${config.repo.name}`, hasToken: !!config.ghToken });
});

// --- M1: list issues for the configured repo ---
app.get("/repos/issues", async (_req, res) => {
  try {
    res.json(await listIssues());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- M2: "Create plan" — enqueue a read-only planning job ---
app.post("/issues/:number/plan", async (req, res) => {
  const issueNumber = Number(req.params.number);
  if (!Number.isInteger(issueNumber)) return res.status(400).json({ error: "invalid issue number" });

  try {
    const issue = await getIssue(issueNumber);
    const planId = createPlanRecord(issue.number, issue.title);
    schedulePlanJob(planId, issue.number);
    res.status(202).json({ planId, status: "planning" });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- M3 hook: regenerate with feedback ---
app.post("/plans/:id/regenerate", (req, res) => {
  const planId = Number(req.params.id);
  const feedback = String(req.body?.feedback ?? "").trim();
  if (!feedback) return res.status(400).json({ error: "feedback is required" });

  const plan = db.prepare(`SELECT issue_number FROM plans WHERE id=?`).get(planId) as
    | { issue_number: number }
    | undefined;
  if (!plan) return res.status(404).json({ error: "plan not found" });

  schedulePlanJob(planId, plan.issue_number, { feedback });
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
  const plan = db.prepare(`SELECT status FROM plans WHERE id=?`).get(planId) as
    | { status: string }
    | undefined;
  if (!plan) return res.status(404).json({ error: "plan not found" });
  if (plan.status !== "ready") {
    return res.status(409).json({ error: `plan not ready (status: ${plan.status})` });
  }
  const markdown = getCurrentPlanMarkdown(planId);
  if (!markdown) return res.status(409).json({ error: "no plan version to execute" });

  scheduleExecuteJob(planId, markdown);
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

app.listen(config.port, () => {
  console.log(
    `bigbrother backend on :${config.port} → ${config.repo.owner}/${config.repo.name} ` +
      `(token: ${config.ghToken ? "yes" : "MISSING"}, concurrency: ${config.planConcurrency})`,
  );
});
