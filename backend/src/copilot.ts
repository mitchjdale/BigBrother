import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { cloneUrl, copilotEnv } from "./auth.js";
import type { Issue, RepoRef, Usage } from "./types.js";
import { captureUsageByCwd } from "./usage.js";

const run = promisify(execFile);

// Tools denied during planning so the agent physically cannot modify the repo.
const READ_ONLY_DENY = [
  "write",
  "shell(git commit)",
  "shell(git push)",
  "shell(rm)",
  "shell(mv)",
];

function planPrompt(issue: Issue, feedback?: string, previousPlan?: string): string {
  const base = `You are a senior engineer. Research THIS repository (it is checked out in the current directory) and produce a detailed, actionable implementation plan for the GitHub issue below.

Rules:
- Do NOT modify any files. Output ONLY the plan.
- Respond in Markdown. Include: Summary, Affected files/areas, Step-by-step tasks, Risks/edge cases, and a Testing strategy.

Issue #${issue.number}: ${issue.title}

${issue.body ?? "(no description)"}`;

  if (feedback && previousPlan) {
    return `${base}

A previous plan was generated (below). The developer gave this feedback — revise the plan accordingly and output the full revised plan:

## Developer feedback
${feedback}

## Previous plan
${previousPlan}`;
  }
  return base;
}

export interface PlanResult {
  markdown: string;
  usage: Usage;
  sessionCwd: string;
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

    const { stdout } = await run("copilot", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: copilotEnv(),
    });

    const usage = captureUsageByCwd(cwd, startedAt);
    return { markdown: stdout.trim(), usage, sessionCwd: cwd };
  } finally {
    // Small repo, disposable clone — clean up.
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}
