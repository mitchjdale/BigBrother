import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import PQueue from "p-queue";
import { config } from "./config.js";
import { db } from "./db.js";
import { log } from "./logger.js";
import { ghAgentEnv } from "./auth.js";
import { captureUsageBySessionRef } from "./usage.js";

const run = promisify(execFile);
const execLog = log("execute");

export const executeQueue = new PQueue({ concurrency: config.planConcurrency });

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i;

export interface ParsedAgentTask {
  sessionRef: string | null;
  prNumber: number | null;
  prUrl: string | null;
}

/** Tolerant parser for `gh agent-task` human output (no --json flag exists yet). */
export function parseAgentTaskOutput(text: string): ParsedAgentTask {
  const session = text.match(UUID_RE)?.[0] ?? null;
  const prMatch = text.match(PR_URL_RE);
  return {
    sessionRef: session,
    prNumber: prMatch ? Number(prMatch[1]) : null,
    prUrl: prMatch ? prMatch[0] : null,
  };
}

function ghEnv() {
  return ghAgentEnv();
}

/**
 * Best-effort: look up the cloud agent session's token/AI-Unit spend and record
 * it on the execute job so implementation usage feeds the same totals and the
 * dedicated usage page (issue #18). Silent no-op when usage isn't available.
 */
function recordExecuteUsage(jobId: number, sessionRef: string | null, logger = execLog): void {
  if (!sessionRef) return;
  const usage = captureUsageBySessionRef(sessionRef);
  if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.nanoAiu === 0) return;
  db.prepare(
    `UPDATE jobs SET input_tokens=?, output_tokens=?, nano_aiu=?, model=?, duration_ms=?,
       updated_at=datetime('now') WHERE id=?`,
  ).run(
    usage.inputTokens,
    usage.outputTokens,
    usage.nanoAiu,
    usage.model,
    usage.durationMs,
    jobId,
  );
  logger.info(
    {
      sessionRef,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      aiu: usage.nanoAiu / 1e9,
    },
    "recorded implementation token usage",
  );
}

/**
 * Approve + execute: hand the approved plan to the Copilot cloud agent, which
 * writes code and opens a DRAFT PR on the target repo.
 */
export function scheduleExecuteJob(
  planId: number,
  planMarkdown: string,
  opts: { model?: string | null } = {},
): void {
  const plan = db
    .prepare(`SELECT repo_owner, repo_name, repo_base FROM plans WHERE id=?`)
    .get(planId) as { repo_owner: string; repo_name: string; repo_base: string | null } | undefined;
  if (!plan) throw new Error(`plan ${planId} not found`);

  const jobInfo = db
    .prepare(`INSERT INTO jobs (plan_id, type, status) VALUES (?, 'execute', 'queued')`)
    .run(planId);
  const jobId = Number(jobInfo.lastInsertRowid);

  db.prepare(`UPDATE plans SET status='executing', updated_at=datetime('now') WHERE id=?`).run(planId);

  const jobLog = execLog.child({
    jobId,
    planId,
    repo: `${plan.repo_owner}/${plan.repo_name}`,
  });
  jobLog.info("execute job queued");

  void executeQueue.add(async () => {
    db.prepare(`UPDATE jobs SET status='running', updated_at=datetime('now') WHERE id=?`).run(jobId);
    jobLog.info({ model: opts.model ?? config.executeModel ?? "auto" }, "execute job started");
    const planFile = path.join(os.tmpdir(), `bb-plan-${planId}-${Date.now()}.md`);
    try {
      fs.writeFileSync(
        planFile,
        `Implement the following approved plan. Open a draft pull request with the changes.\n\n${planMarkdown}`,
      );

      const args = [
        "agent-task",
        "create",
        "--from-file",
        planFile,
        "--repo",
        `${plan.repo_owner}/${plan.repo_name}`,
        "--base",
        plan.repo_base || config.repo.base,
      ];
      const selectedModel = opts.model === undefined ? config.executeModel : opts.model;
      if (selectedModel) args.push("--model", selectedModel);

      const { stdout, stderr } = await run("gh", args, { env: ghEnv(), maxBuffer: 32 * 1024 * 1024 });

      const parsed = parseAgentTaskOutput(`${stdout}\n${stderr}`);

      db.prepare(
        `INSERT INTO prs (plan_id, session_ref, pr_number, url, branch, agent_state, raw_output)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        planId,
        parsed.sessionRef,
        parsed.prNumber,
        parsed.prUrl,
        plan.repo_base || config.repo.base,
        parsed.prUrl ? "pr_open" : "in_progress",
        stdout.trim(),
      );

      db.prepare(`UPDATE jobs SET status='done', session_id=?, updated_at=datetime('now') WHERE id=?`).run(
        parsed.sessionRef,
        jobId,
      );
      recordExecuteUsage(jobId, parsed.sessionRef, jobLog);
      db.prepare(
        `UPDATE plans SET status=?, error=NULL, updated_at=datetime('now') WHERE id=?`,
      ).run(parsed.prUrl ? "pr_open" : "executing", planId);
      jobLog.info(
        { sessionRef: parsed.sessionRef, prNumber: parsed.prNumber, prUrl: parsed.prUrl },
        parsed.prUrl ? "execute job opened draft PR" : "execute job dispatched (PR pending)",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      jobLog.error({ err }, "execute job failed");
      db.prepare(`UPDATE jobs SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`).run(
        msg,
        jobId,
      );
      db.prepare(`UPDATE plans SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`).run(
        msg,
        planId,
      );
    } finally {
      fs.rmSync(planFile, { force: true });
    }
  });
}

/**
 * Re-poll a running agent task to pick up the draft PR / latest state once the
 * cloud agent has progressed. Called on demand from the API.
 */
export async function refreshExecution(planId: number): Promise<void> {
  const pr = db
    .prepare(
      `SELECT pr.id, pr.session_ref, p.repo_owner, p.repo_name
       FROM prs pr
       JOIN plans p ON p.id = pr.plan_id
       WHERE pr.plan_id=?
       ORDER BY pr.id DESC LIMIT 1`,
    )
    .get(planId) as
    | { id: number; session_ref: string | null; repo_owner: string; repo_name: string }
    | undefined;
  if (!pr?.session_ref) return;

  try {
    const { stdout } = await run(
      "gh",
      ["agent-task", "view", pr.session_ref, "--repo", `${pr.repo_owner}/${pr.repo_name}`],
      { env: ghEnv(), maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = parseAgentTaskOutput(stdout);
    if (parsed.prUrl) {
      db.prepare(
        `UPDATE prs SET pr_number=?, url=?, agent_state='pr_open', updated_at=datetime('now') WHERE id=?`,
      ).run(parsed.prNumber, parsed.prUrl, pr.id);
      db.prepare(`UPDATE plans SET status='pr_open', updated_at=datetime('now') WHERE id=?`).run(planId);
      execLog.info({ planId, prNumber: parsed.prNumber, prUrl: parsed.prUrl }, "refresh picked up draft PR");
    }
    // The cloud agent keeps working after dispatch, so re-capture its usage on
    // every refresh to keep implementation totals current (issue #18).
    const execJob = db
      .prepare(`SELECT id FROM jobs WHERE plan_id=? AND type='execute' ORDER BY id DESC LIMIT 1`)
      .get(planId) as { id: number } | undefined;
    if (execJob && pr.session_ref) recordExecuteUsage(execJob.id, pr.session_ref);
  } catch (err) {
    // best-effort refresh; leave state unchanged on failure
    execLog.warn({ err, planId }, "execute refresh failed (leaving state unchanged)");
  }
}
