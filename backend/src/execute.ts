import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import PQueue from "p-queue";
import { config } from "./config.js";
import { db } from "./db.js";
import { ghAgentEnv } from "./auth.js";

const run = promisify(execFile);

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
 * Approve + execute: hand the approved plan to the Copilot cloud agent, which
 * writes code and opens a DRAFT PR on the target repo.
 */
export function scheduleExecuteJob(
  planId: number,
  planMarkdown: string,
  opts: { model?: string | null } = {},
): void {
  const jobInfo = db
    .prepare(`INSERT INTO jobs (plan_id, type, status) VALUES (?, 'execute', 'queued')`)
    .run(planId);
  const jobId = Number(jobInfo.lastInsertRowid);

  db.prepare(`UPDATE plans SET status='executing', updated_at=datetime('now') WHERE id=?`).run(planId);

  void executeQueue.add(async () => {
    db.prepare(`UPDATE jobs SET status='running', updated_at=datetime('now') WHERE id=?`).run(jobId);
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
        `${config.repo.owner}/${config.repo.name}`,
        "--base",
        config.repo.base,
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
        config.repo.base,
        parsed.prUrl ? "pr_open" : "in_progress",
        stdout.trim(),
      );

      db.prepare(`UPDATE jobs SET status='done', session_id=?, updated_at=datetime('now') WHERE id=?`).run(
        parsed.sessionRef,
        jobId,
      );
      db.prepare(
        `UPDATE plans SET status=?, error=NULL, updated_at=datetime('now') WHERE id=?`,
      ).run(parsed.prUrl ? "pr_open" : "executing", planId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
    .prepare(`SELECT id, session_ref FROM prs WHERE plan_id=? ORDER BY id DESC LIMIT 1`)
    .get(planId) as { id: number; session_ref: string | null } | undefined;
  if (!pr?.session_ref) return;

  try {
    const { stdout } = await run(
      "gh",
      ["agent-task", "view", pr.session_ref, "--repo", `${config.repo.owner}/${config.repo.name}`],
      { env: ghEnv(), maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = parseAgentTaskOutput(stdout);
    if (parsed.prUrl) {
      db.prepare(
        `UPDATE prs SET pr_number=?, url=?, agent_state='pr_open', updated_at=datetime('now') WHERE id=?`,
      ).run(parsed.prNumber, parsed.prUrl, pr.id);
      db.prepare(`UPDATE plans SET status='pr_open', updated_at=datetime('now') WHERE id=?`).run(planId);
    }
  } catch {
    // best-effort refresh; leave state unchanged on failure
  }
}
