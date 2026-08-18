import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { config } from "./config.js";
import { ghAgentEnv } from "./auth.js";
import type { Usage, RepoRef } from "./types.js";

const run = promisify(execFile);

const EMPTY: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  nanoAiu: 0,
  aiu: 0,
  usd: null,
  durationMs: 0,
  model: null,
  turns: 0,
};

function parseIntToken(text: string, re: RegExp): number {
  const raw = text.match(re)?.[1];
  if (!raw) return 0;
  const n = Number(raw.replaceAll(",", ""));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function parseAiu(text: string): number {
  const matched =
    text.match(/ai credit usage[^0-9]*([0-9][0-9,]*(?:\.[0-9]+)?)/i)?.[1] ??
    text.match(/\baiu\b[^0-9]*([0-9][0-9,]*(?:\.[0-9]+)?)/i)?.[1] ??
    null;
  if (!matched) return 0;
  const aiu = Number(matched.replaceAll(",", ""));
  return Number.isFinite(aiu) ? aiu : 0;
}

function parseAgentTaskUsageText(text: string): Usage {
  const inputTokens = parseIntToken(text, /input[_\s-]*tokens?[^0-9]*([0-9][0-9,]*)/i);
  const outputTokens = parseIntToken(text, /output[_\s-]*tokens?[^0-9]*([0-9][0-9,]*)/i);
  const durationMs = parseIntToken(text, /duration[^0-9]*([0-9][0-9,]*)\s*ms/i);
  const model = text.match(/model[^A-Za-z0-9._-]*([A-Za-z0-9._-]+)/i)?.[1] ?? null;
  const aiu = parseAiu(text);
  const nanoAiu = Math.round(aiu * 1e9);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    nanoAiu,
    aiu,
    usd: config.usdPerAiu > 0 ? aiu * config.usdPerAiu : null,
    durationMs,
    model,
    turns: 0,
  };
}

/**
 * Fetch implementation usage for a cloud `gh agent-task` run.
 *
 * The cloud agent does not write usage rows to the local Copilot session store,
 * so we query `gh agent-task view --log` and parse any reported usage data.
 */
export async function captureAgentTaskUsage(sessionId: string, repo: RepoRef): Promise<Usage> {
  if (!sessionId) return EMPTY;
  try {
    const { stdout, stderr } = await run(
      "gh",
      ["agent-task", "view", sessionId, "--repo", `${repo.owner}/${repo.name}`, "--log"],
      { env: ghAgentEnv(), maxBuffer: 32 * 1024 * 1024 },
    );
    return parseAgentTaskUsageText(`${stdout}\n${stderr}`);
  } catch {
    return EMPTY;
  }
}

/**
 * Find the Copilot CLI session that ran in `cwd` and sum its per-turn usage.
 *
 * The CLI records every assistant turn's token + AI-Unit cost in its local
 * session store (~/.copilot/session-store.db). Because each plan job clones the
 * repo into a unique directory, we can reliably match the session by `cwd`.
 *
 * NOTE: the CLI session-store schema is prerelease; this adapter is the single
 * place to update if columns change.
 */
export function captureUsageByCwd(cwd: string, sinceIso: string): Usage {
  if (!fs.existsSync(config.copilotSessionStore)) return EMPTY;

  const store = new Database(config.copilotSessionStore, { readonly: true, fileMustExist: true });
  try {
    const session = store
      .prepare(
        `SELECT id FROM sessions
         WHERE cwd = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(cwd, sinceIso) as { id: string } | undefined;

    if (!session) return EMPTY;
    return sumUsageForSession(store, session.id);
  } finally {
    store.close();
  }
}

/** Sum the per-turn token/AI-Unit usage for a single Copilot session. */
function sumUsageForSession(store: Database.Database, sessionId: string): Usage {
  const row = store
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens),0)        AS input_tokens,
         COALESCE(SUM(output_tokens),0)       AS output_tokens,
         COALESCE(SUM(cache_read_tokens),0)   AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens),0)  AS cache_write_tokens,
         COALESCE(SUM(reasoning_tokens),0)    AS reasoning_tokens,
         COALESCE(SUM(total_nano_aiu),0)      AS nano_aiu,
         COALESCE(SUM(duration_ms),0)         AS duration_ms,
         COUNT(*)                             AS turns,
         MAX(model)                           AS model
       FROM assistant_usage_events WHERE session_id = ?`,
    )
    .get(sessionId) as {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    nano_aiu: number;
    duration_ms: number;
    turns: number;
    model: string | null;
  };

  const aiu = row.nano_aiu / 1e9;
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    nanoAiu: row.nano_aiu,
    aiu,
    usd: config.usdPerAiu > 0 ? aiu * config.usdPerAiu : null,
    durationMs: row.duration_ms,
    model: row.model,
    turns: row.turns,
  };
}
