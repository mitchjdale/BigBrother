import { config } from "./config.js";
import { db } from "./db.js";
import { generatePlan, PlanError } from "./copilot.js";
import { getIssue } from "./github.js";
import { enqueuePlan } from "./queue.js";
import type { PlanVersionRow, RepoRef } from "./types.js";

interface PlanRow {
  id: number;
  repo_owner: string;
  repo_name: string;
  repo_base: string;
  issue_number: number;
  status: string;
  current_version_id: number | null;
}

export function createPlanRecord(issueNumber: number, issueTitle: string, repo: RepoRef): number {
  const info = db
    .prepare(
      `INSERT INTO plans (repo_owner, repo_name, repo_base, issue_number, issue_title, status)
       VALUES (?, ?, ?, ?, ?, 'planning')`,
    )
    .run(repo.owner, repo.name, repo.base, issueNumber, issueTitle);
  return Number(info.lastInsertRowid);
}

/** Most recent plan id for an issue in the configured repo, or null. */
export function getLatestPlanIdForIssue(issueNumber: number, repo: RepoRef): number | null {
  const row = db
    .prepare(
      `SELECT id FROM plans
       WHERE repo_owner=? AND repo_name=? AND issue_number=?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(repo.owner, repo.name, issueNumber) as { id: number } | undefined;
  return row?.id ?? null;
}

/** One entry per issue (its latest plan) for dashboard hydration after a reload. */
export function listLatestPlansByIssue(repo: RepoRef): {
  issueNumber: number;
  planId: number;
  status: string;
}[] {
  return db
    .prepare(
      `SELECT p.issue_number AS issueNumber, p.id AS planId, p.status AS status
       FROM plans p
       WHERE p.repo_owner=? AND p.repo_name=?
         AND p.id = (
           SELECT MAX(id) FROM plans
           WHERE issue_number = p.issue_number
             AND repo_owner = p.repo_owner AND repo_name = p.repo_name
         )
       ORDER BY p.id DESC`,
    )
    .all(repo.owner, repo.name) as {
    issueNumber: number;
    planId: number;
    status: string;
  }[];
}

function nextVersionNo(planId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM plan_versions WHERE plan_id = ?`)
    .get(planId) as { n: number };
  return row.n;
}

/** M3: persist a developer-edited plan as a new version (no agent, no cost). */
export function saveUserEditedVersion(planId: number, markdown: string): number | null {
  const plan = db.prepare(`SELECT id FROM plans WHERE id=?`).get(planId) as { id: number } | undefined;
  if (!plan) return null;
  const versionNo = nextVersionNo(planId);
  const info = db
    .prepare(
      `INSERT INTO plan_versions (plan_id, version_no, markdown, source)
       VALUES (?, ?, ?, 'user_edited')`,
    )
    .run(planId, versionNo, markdown);
  const versionId = Number(info.lastInsertRowid);
  db.prepare(
    `UPDATE plans SET status='ready', current_version_id=?, updated_at=datetime('now') WHERE id=?`,
  ).run(versionId, planId);
  return versionId;
}

/** Markdown of the plan version currently selected (for execute). */
export function getCurrentPlanMarkdown(planId: number): string | null {
  const plan = db.prepare(`SELECT current_version_id FROM plans WHERE id=?`).get(planId) as
    | { current_version_id: number | null }
    | undefined;
  if (!plan) return null;
  const row = plan.current_version_id
    ? (db.prepare(`SELECT markdown FROM plan_versions WHERE id=?`).get(plan.current_version_id) as
        | { markdown: string }
        | undefined)
    : (db
        .prepare(`SELECT markdown FROM plan_versions WHERE plan_id=? ORDER BY version_no DESC LIMIT 1`)
        .get(planId) as { markdown: string } | undefined);
  return row?.markdown ?? null;
}

/** Run a plan (or regeneration) as a queued, concurrent job. */
export function schedulePlanJob(
  planId: number,
  opts: { feedback?: string; model?: string | null } = {},
): void {
  const plan = db
    .prepare(`SELECT issue_number, repo_owner, repo_name, repo_base FROM plans WHERE id=?`)
    .get(planId) as
    | { issue_number: number; repo_owner: string; repo_name: string; repo_base: string | null }
    | undefined;
  if (!plan) throw new Error(`plan ${planId} not found`);

  const jobInfo = db
    .prepare(`INSERT INTO jobs (plan_id, type, status) VALUES (?, 'plan', 'queued')`)
    .run(planId);
  const jobId = Number(jobInfo.lastInsertRowid);

  db.prepare(`UPDATE plans SET status='planning', updated_at=datetime('now') WHERE id=?`).run(planId);

  enqueuePlan(async () => {
    db.prepare(`UPDATE jobs SET status='running', updated_at=datetime('now') WHERE id=?`).run(jobId);
    try {
      const targetRepo: RepoRef = {
        owner: plan.repo_owner,
        name: plan.repo_name,
        base: plan.repo_base || config.repo.base,
      };
      const issue = await getIssue(plan.issue_number, targetRepo);

      let previousPlan: string | undefined;
      if (opts.feedback) {
        const prev = db
          .prepare(
            `SELECT markdown FROM plan_versions WHERE plan_id=? ORDER BY version_no DESC LIMIT 1`,
          )
          .get(planId) as { markdown: string } | undefined;
        previousPlan = prev?.markdown;
      }

      const result = await generatePlan(issue, targetRepo, {
        feedback: opts.feedback,
        previousPlan,
        model: opts.model,
      });

      const versionNo = nextVersionNo(planId);
      const source = opts.feedback ? "regenerated" : "generated";
      const versionInfo = db
        .prepare(
          `INSERT INTO plan_versions
             (plan_id, version_no, markdown, source, feedback_prompt,
              input_tokens, output_tokens, nano_aiu, model, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          planId,
          versionNo,
          result.markdown,
          source,
          opts.feedback ?? null,
          result.usage.inputTokens,
          result.usage.outputTokens,
          result.usage.nanoAiu,
          result.usage.model,
          result.usage.durationMs,
        );
      const versionId = Number(versionInfo.lastInsertRowid);

      // Record the attempt's token spend on the job so cumulative usage is
      // retained across all attempts (issue #11).
      db.prepare(
        `UPDATE jobs SET status='done', input_tokens=?, output_tokens=?, nano_aiu=?,
           model=?, duration_ms=?, updated_at=datetime('now') WHERE id=?`,
      ).run(
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.nanoAiu,
        result.usage.model,
        result.usage.durationMs,
        jobId,
      );

      db.prepare(
        `UPDATE plans SET status='ready', current_version_id=?, error=NULL, updated_at=datetime('now') WHERE id=?`,
      ).run(versionId, planId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A failed attempt may still have consumed tokens — retain that spend on
      // the job row so it counts toward cumulative usage (issue #11).
      const usage = err instanceof PlanError ? err.usage : null;
      db.prepare(
        `UPDATE plans SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`,
      ).run(msg, planId);
      db.prepare(
        `UPDATE jobs SET status='failed', error=?, input_tokens=?, output_tokens=?, nano_aiu=?,
           model=?, duration_ms=?, updated_at=datetime('now') WHERE id=?`,
      ).run(
        msg,
        usage?.inputTokens ?? 0,
        usage?.outputTokens ?? 0,
        usage?.nanoAiu ?? 0,
        usage?.model ?? null,
        usage?.durationMs ?? 0,
        jobId,
      );
    }
  });
}

/** Full plan view for the API: status + latest version + accumulated cost. */
export function getPlanView(planId: number) {
  const plan = db.prepare(`SELECT * FROM plans WHERE id=?`).get(planId) as
    | (PlanRow & Record<string, unknown>)
    | undefined;
  if (!plan) return null;

  const versions = db
    .prepare(`SELECT * FROM plan_versions WHERE plan_id=? ORDER BY version_no ASC`)
    .all(planId) as PlanVersionRow[];

  const current = versions.find((v) => v.id === plan.current_version_id) ?? versions.at(-1) ?? null;

  // Cumulative cost is summed from the plan's JOB attempts, so it retains the
  // token spend of every attempt — including failed ones and superseded
  // versions — not just the versions that produced markdown (issue #11).
  const attempts = db
    .prepare(
      `SELECT input_tokens, output_tokens, nano_aiu, status
       FROM jobs WHERE plan_id=? AND type='plan'`,
    )
    .all(planId) as { input_tokens: number; output_tokens: number; nano_aiu: number; status: string }[];

  const totalNanoAiu = attempts.reduce((s, a) => s + a.nano_aiu, 0);
  const totalInput = attempts.reduce((s, a) => s + a.input_tokens, 0);
  const totalOutput = attempts.reduce((s, a) => s + a.output_tokens, 0);
  const failedAttempts = attempts.filter((a) => a.status === "failed").length;
  const aiu = totalNanoAiu / 1e9;

  const pr = db
    .prepare(`SELECT pr_number, url, branch, agent_state, screenshot_url FROM prs WHERE plan_id=? ORDER BY id DESC LIMIT 1`)
    .get(planId) as
    | { pr_number: number | null; url: string | null; branch: string | null; agent_state: string | null; screenshot_url: string | null }
    | undefined;

  return {
    id: plan.id,
    issueNumber: plan.issue_number,
    status: plan.status,
    error: plan.error,
    pr: pr
      ? {
          number: pr.pr_number,
          url: pr.url,
          branch: pr.branch,
          agentState: pr.agent_state,
          screenshotUrl: pr.screenshot_url,
        }
      : null,
    currentPlan: current
      ? {
          versionNo: current.version_no,
          markdown: current.markdown,
          source: current.source,
          cost: {
            inputTokens: current.input_tokens,
            outputTokens: current.output_tokens,
            aiu: current.nano_aiu / 1e9,
            usd: config.usdPerAiu > 0 ? (current.nano_aiu / 1e9) * config.usdPerAiu : null,
            model: current.model,
            durationMs: current.duration_ms,
          },
        }
      : null,
    totalCost: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      aiu,
      usd: config.usdPerAiu > 0 ? aiu * config.usdPerAiu : null,
      versions: versions.length,
      attempts: attempts.length,
      failedAttempts,
    },
    versions: versions.map((v) => ({
      versionNo: v.version_no,
      source: v.source,
      feedbackPrompt: v.feedback_prompt,
      aiu: v.nano_aiu / 1e9,
      inputTokens: v.input_tokens,
      outputTokens: v.output_tokens,
      createdAt: v.created_at,
    })),
  };
}
