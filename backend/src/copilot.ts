import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { cloneUrl, copilotEnv } from "./auth.js";
import { log } from "./logger.js";
import type { Issue, RepoRef, Usage } from "./types.js";
import { captureUsageByCwd } from "./usage.js";
import { defaultPromptTemplate, getActivePrompt, renderPromptTemplate } from "./prompts.js";

const run = promisify(execFile);
const copilotLog = log("copilot");

// Tools denied during planning so the agent physically cannot modify the repo.
const READ_ONLY_DENY = [
  "write",
  "shell(git commit)",
  "shell(git push)",
  "shell(rm)",
  "shell(mv)",
];

function planPrompt(issue: Issue, feedback?: string, previousPlan?: string): string {
  const values = {
    issue_ref: issue.source === "github" ? `#${issue.number}` : issue.key,
    issue_source: issue.source === "jira" ? "JIRA" : "GitHub",
    issue_title: issue.title,
    issue_body: issue.body ?? "(no description)",
    feedback: feedback?.trim() || "(none)",
    previous_plan: previousPlan?.trim() || "(none)",
  };

  const fallback = renderPromptTemplate(defaultPromptTemplate("plan"), values);
  try {
    const active = getActivePrompt("plan");
    if (!active) return fallback;
    return renderPromptTemplate(active.template, values);
  } catch {
    return fallback;
  }
}

export interface PlanResult {
  markdown: string;
  usage: Usage;
  sessionCwd: string;
}

/**
 * Error thrown when a plan attempt fails after the Copilot session may already
 * have consumed tokens. Carries any usage captured so the spend isn't lost
 * (issue #11).
 */
export class PlanError extends Error {
  usage: Usage | null;
  constructor(message: string, usage: Usage | null) {
    super(message);
    this.name = "PlanError";
    this.usage = usage;
  }
}

function safeCaptureUsage(cwd: string, startedAt: string): Usage | null {
  try {
    return captureUsageByCwd(cwd, startedAt);
  } catch {
    return null;
  }
}

/**
 * Clone the target repo into a unique dir, run the Copilot CLI in read-only
 * plan mode, capture the plan markdown (stdout) and the per-session cost.
 */
export async function generatePlan(
  issue: Issue,
  repo: RepoRef,
  opts: { feedback?: string; previousPlan?: string; model?: string | null } = {},
): Promise<PlanResult> {
  fs.mkdirSync(config.workDir, { recursive: true });
  const jobDir = fs.mkdtempSync(path.join(config.workDir, `plan-${issue.number}-`));
  // Real cwd (mkdtemp may live under a symlinked temp root); the CLI records the
  // resolved path, so match on that.
  const cwd = fs.realpathSync(jobDir);
  const startedAt = new Date().toISOString();

  try {
    const url = cloneUrl(repo.owner, repo.name);

    copilotLog.debug({ repo: `${repo.owner}/${repo.name}`, base: repo.base, cwd }, "cloning repo");
    await run("git", ["clone", "--depth", "1", "--branch", repo.base, url, cwd], {
      maxBuffer: 64 * 1024 * 1024,
    });

    const args = [
      "-p",
      planPrompt(issue, opts.feedback, opts.previousPlan),
      "--allow-all-tools",
      "--allow-all-paths",
      ...READ_ONLY_DENY.flatMap((t) => ["--deny-tool", t]),
      "--log-dir",
      path.join(cwd, ".copilot-logs"),
    ];
    const selectedModel = opts.model === undefined ? config.planModel : opts.model;
    if (selectedModel) args.push("--model", selectedModel);

    copilotLog.debug(
      { issue: issue.number, model: selectedModel || "auto" },
      "running Copilot CLI (read-only plan)",
    );
    let stdout: string;
    try {
      ({ stdout } = await run("copilot", args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: copilotEnv(),
      }));
    } catch (err) {
      // The Copilot session may still have recorded token usage before failing;
      // capture it so the cost is retained (issue #11).
      const usage = safeCaptureUsage(cwd, startedAt);
      copilotLog.error({ err, issue: issue.number }, "Copilot CLI plan run failed");
      throw new PlanError(err instanceof Error ? err.message : String(err), usage);
    }

    const usage = captureUsageByCwd(cwd, startedAt);
    return { markdown: stdout.trim(), usage, sessionCwd: cwd };
  } finally {
    // Small repo, disposable clone — clean up.
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}
