import { db } from "./db.js";
import { config } from "./config.js";
import { sqlEstimatedUsd } from "./pricing.js";

export type Granularity = "day" | "week";

export interface UsageQuery {
  repoOwner?: string;
  repoName?: string;
  from?: string; // 'YYYY-MM-DD' inclusive
  to?: string; // 'YYYY-MM-DD' inclusive
  granularity?: Granularity;
}

/** Token/AIU spend for a single phase (planning or implementation). */
export interface PhaseTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiu: number;
  usd: number | null;
  estimatedUsd: number;
  attempts: number;
  failedAttempts: number;
}

export interface UsageBucket {
  bucket: string; // ISO date of the bucket start (day, or Monday of the week)
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiu: number;
  usd: number | null;
  estimatedUsd: number;
  attempts: number;
  planning: PhaseTotals;
  implementation: PhaseTotals;
}

export interface RepoUsage {
  owner: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiu: number;
  usd: number | null;
  estimatedUsd: number;
  attempts: number;
  planning: PhaseTotals;
  implementation: PhaseTotals;
}

export interface UsageReport {
  granularity: Granularity;
  from: string | null;
  to: string | null;
  usdPerAiu: number;
  summary: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    aiu: number;
    usd: number | null;
    estimatedUsd: number;
    attempts: number;
    failedAttempts: number;
    plans: number;
    repos: number;
    planning: PhaseTotals;
    implementation: PhaseTotals;
  };
  series: UsageBucket[];
  repos: RepoUsage[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usd(aiu: number): number | null {
  return config.usdPerAiu > 0 ? aiu * config.usdPerAiu : null;
}

/** Raw per-phase sums shared by the series, per-repo and totals queries. */
interface PhaseSums {
  plan_input: number;
  plan_output: number;
  plan_nano: number;
  plan_attempts: number;
  plan_failed: number;
  plan_est_usd: number;
  exec_input: number;
  exec_output: number;
  exec_nano: number;
  exec_attempts: number;
  exec_failed: number;
  exec_est_usd: number;
}

const EST_USD = sqlEstimatedUsd("j.input_tokens", "j.output_tokens", "j.model");

/**
 * SQL fragment that splits token/AIU/attempt sums by job type so a single scan
 * yields both the planning (`plan`) and implementation (`execute`) phases.
 */
const PHASE_SUMS = `
  COALESCE(SUM(CASE WHEN j.type='plan' THEN j.input_tokens END),0)             AS plan_input,
  COALESCE(SUM(CASE WHEN j.type='plan' THEN j.output_tokens END),0)            AS plan_output,
  COALESCE(SUM(CASE WHEN j.type='plan' THEN j.nano_aiu END),0)                 AS plan_nano,
  COALESCE(SUM(CASE WHEN j.type='plan' THEN 1 END),0)                          AS plan_attempts,
  COALESCE(SUM(CASE WHEN j.type='plan' AND j.status='failed' THEN 1 END),0)    AS plan_failed,
  COALESCE(SUM(CASE WHEN j.type='plan' THEN ${EST_USD} END),0)                 AS plan_est_usd,
  COALESCE(SUM(CASE WHEN j.type='execute' THEN j.input_tokens END),0)          AS exec_input,
  COALESCE(SUM(CASE WHEN j.type='execute' THEN j.output_tokens END),0)         AS exec_output,
  COALESCE(SUM(CASE WHEN j.type='execute' THEN j.nano_aiu END),0)              AS exec_nano,
  COALESCE(SUM(CASE WHEN j.type='execute' THEN 1 END),0)                       AS exec_attempts,
  COALESCE(SUM(CASE WHEN j.type='execute' AND j.status='failed' THEN 1 END),0) AS exec_failed,
  COALESCE(SUM(CASE WHEN j.type='execute' THEN ${EST_USD} END),0)              AS exec_est_usd`;

function phaseTotals(
  input: number,
  output: number,
  nano: number,
  attempts: number,
  failed: number,
  estimatedUsd: number,
): PhaseTotals {
  const aiu = nano / 1e9;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    aiu,
    usd: usd(aiu),
    estimatedUsd,
    attempts,
    failedAttempts: failed,
  };
}

function planningOf(r: PhaseSums): PhaseTotals {
  return phaseTotals(
    r.plan_input,
    r.plan_output,
    r.plan_nano,
    r.plan_attempts,
    r.plan_failed,
    r.plan_est_usd,
  );
}

function implementationOf(r: PhaseSums): PhaseTotals {
  return phaseTotals(
    r.exec_input,
    r.exec_output,
    r.exec_nano,
    r.exec_attempts,
    r.exec_failed,
    r.exec_est_usd,
  );
}

/** Combined (planning + implementation) headline numbers for a row. */
function combined(p: PhaseTotals, i: PhaseTotals) {
  const aiu = p.aiu + i.aiu;
  return {
    inputTokens: p.inputTokens + i.inputTokens,
    outputTokens: p.outputTokens + i.outputTokens,
    totalTokens: p.totalTokens + i.totalTokens,
    aiu,
    usd: usd(aiu),
    estimatedUsd: p.estimatedUsd + i.estimatedUsd,
    attempts: p.attempts + i.attempts,
  };
}

/**
 * SQLite expression that maps a UTC `created_at` timestamp to the ISO date of
 * its bucket. For weeks we snap to the Monday of the containing week so the
 * value is chart-friendly and sortable.
 */
function bucketExpr(granularity: Granularity): string {
  if (granularity === "week") {
    // `weekday 0` -> next Sunday; `-6 days` -> Monday of the current week.
    return "date(j.created_at, 'weekday 0', '-6 days')";
  }
  return "date(j.created_at)";
}

interface Filters {
  where: string;
  params: unknown[];
}

function buildFilters(q: UsageQuery): Filters {
  // Both planning (plan) and implementation (execute) jobs count toward usage.
  const clauses = ["j.type IN ('plan','execute')"];
  const params: unknown[] = [];

  if (q.repoOwner && q.repoName) {
    clauses.push("p.repo_owner = ? AND p.repo_name = ?");
    params.push(q.repoOwner, q.repoName);
  }
  if (q.from && DATE_RE.test(q.from)) {
    clauses.push("date(j.created_at) >= ?");
    params.push(q.from);
  }
  if (q.to && DATE_RE.test(q.to)) {
    clauses.push("date(j.created_at) <= ?");
    params.push(q.to);
  }

  return { where: clauses.join(" AND "), params };
}

/**
 * Aggregate plan + execute job token/AIU usage into time buckets + summary +
 * per-repo totals, each split into planning vs implementation phases (#18).
 */
export function getUsageReport(q: UsageQuery): UsageReport {
  const granularity: Granularity = q.granularity === "week" ? "week" : "day";
  const { where, params } = buildFilters(q);
  const bucket = bucketExpr(granularity);

  const seriesRows = db
    .prepare(
      `SELECT ${bucket} AS bucket, ${PHASE_SUMS}
       FROM jobs j
       JOIN plans p ON p.id = j.plan_id
       WHERE ${where}
       GROUP BY bucket
       ORDER BY bucket ASC`,
    )
    .all(...params) as (PhaseSums & { bucket: string })[];

  const series: UsageBucket[] = seriesRows.map((r) => {
    const planning = planningOf(r);
    const implementation = implementationOf(r);
    return { bucket: r.bucket, ...combined(planning, implementation), planning, implementation };
  });

  const repoRows = db
    .prepare(
      `SELECT p.repo_owner AS owner, p.repo_name AS name, ${PHASE_SUMS}
       FROM jobs j
       JOIN plans p ON p.id = j.plan_id
       WHERE ${where}
       GROUP BY p.repo_owner, p.repo_name
       ORDER BY (plan_nano + exec_nano) DESC, (plan_input + exec_input) DESC`,
    )
    .all(...params) as (PhaseSums & { owner: string; name: string })[];

  const repos: RepoUsage[] = repoRows.map((r) => {
    const planning = planningOf(r);
    const implementation = implementationOf(r);
    return {
      owner: r.owner,
      name: r.name,
      ...combined(planning, implementation),
      planning,
      implementation,
    };
  });

  const totalsRow = db
    .prepare(
      `SELECT ${PHASE_SUMS},
         COUNT(DISTINCT CASE WHEN j.type='plan' THEN j.plan_id END) AS plans
       FROM jobs j
       JOIN plans p ON p.id = j.plan_id
       WHERE ${where}`,
    )
    .get(...params) as PhaseSums & { plans: number };

  const planning = planningOf(totalsRow);
  const implementation = implementationOf(totalsRow);
  const total = combined(planning, implementation);

  return {
    granularity,
    from: q.from && DATE_RE.test(q.from) ? q.from : null,
    to: q.to && DATE_RE.test(q.to) ? q.to : null,
    usdPerAiu: config.usdPerAiu,
    summary: {
      ...total,
      failedAttempts: planning.failedAttempts + implementation.failedAttempts,
      plans: totalsRow.plans,
      repos: repos.length,
      planning,
      implementation,
    },
    series,
    repos,
  };
}
