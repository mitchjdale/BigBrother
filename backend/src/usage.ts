import Database from "better-sqlite3";
import fs from "node:fs";
import { config } from "./config.js";
import type { Usage } from "./types.js";

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

/**
 * Sum the per-turn usage for a Copilot session identified directly by its id.
 *
 * The implementation phase runs via `gh agent-task` (the Copilot cloud coding
 * agent) rather than the local CLI, and we only learn its session id from the
 * command output. When that session's usage is recorded in the local session
 * store this returns its token/AI-Unit spend; otherwise it returns EMPTY.
 *
 * Returns EMPTY (never throws) so a best-effort capture can't break execution.
 */
export function captureUsageBySessionRef(sessionId: string): Usage {
  if (!sessionId || !fs.existsSync(config.copilotSessionStore)) return EMPTY;

  try {
    const store = new Database(config.copilotSessionStore, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const session = store
        .prepare(`SELECT id FROM sessions WHERE id = ? LIMIT 1`)
        .get(sessionId) as { id: string } | undefined;
      if (!session) return EMPTY;
      return sumUsageForSession(store, session.id);
    } finally {
      store.close();
    }
  } catch {
    return EMPTY;
  }
}

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
