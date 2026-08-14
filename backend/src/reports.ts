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

/** Token/AIU/cost totals for a set of planning jobs. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiu: number;
  usd: number | null;
  estimatedUsd: number;
  attempts: number;
}

export interface UsageBucket extends UsageTotals {
  bucket: string; // ISO date of the bucket start (day, or Monday of the week)
}

export interface RepoUsage extends UsageTotals {
  owner: string;
  name: string;
}

export interface UsageReport {
  granularity: Granularity;
  from: string | null;
  to: string | null;
  usdPerAiu: number;
  summary: UsageTotals & {
    failedAttempts: number;
    plans: number;
    repos: number;
  };
  series: UsageBucket[];
  repos: RepoUsage[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usd(aiu: number): number | null {
  return config.usdPerAiu > 0 ? aiu * config.usdPerAiu : null;
}

/** Raw sums shared by the series, per-repo and totals queries. */
interface Sums {
  input: number;
  output: number;
  nano: number;
  attempts: number;
  failed: number;
  est_usd: number;
}

const EST_USD = sqlEstimatedUsd("j.input_tokens", "j.output_tokens", "j.model");

/** SQL fragment aggregating token/AIU/attempt sums for planning jobs. */
const SUMS = `
  COALESCE(SUM(j.input_tokens),0)                         AS input,
  COALESCE(SUM(j.output_tokens),0)                        AS output,
  COALESCE(SUM(j.nano_aiu),0)                             AS nano,
  COUNT(*)                                                AS attempts,
  COALESCE(SUM(CASE WHEN j.status='failed' THEN 1 END),0) AS failed,
  COALESCE(SUM(${EST_USD}),0)                             AS est_usd`;

function totalsOf(r: Sums): UsageTotals {
  const aiu = r.nano / 1e9;
  return {
    inputTokens: r.input,
    outputTokens: r.output,
    totalTokens: r.input + r.output,
    aiu,
    usd: usd(aiu),
    estimatedUsd: r.est_usd,
    attempts: r.attempts,
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
  // Only planning (`plan`) jobs are captured; implementation runs on the
  // Copilot cloud agent whose usage is not available locally.
  const clauses = ["j.type = 'plan'"];
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
 * Aggregate planning-job token/AIU usage into time buckets + summary +
 * per-repo totals.
 */
export function getUsageReport(q: UsageQuery): UsageReport {
  const granularity: Granularity = q.granularity === "week" ? "week" : "day";
  const { where, params } = buildFilters(q);
  const bucket = bucketExpr(granularity);

  const seriesRows = db
    .prepare(
      `SELECT ${bucket} AS bucket, ${SUMS}
       FROM jobs j
       JOIN plans p ON p.id = j.plan_id
       WHERE ${where}
       GROUP BY bucket
       ORDER BY bucket ASC`,
    )
    .all(...params) as (Sums & { bucket: string })[];

  const series: UsageBucket[] = seriesRows.map((r) => ({ bucket: r.bucket, ...totalsOf(r) }));

  const repoRows = db
    .prepare(
      `SELECT p.repo_owner AS owner, p.repo_name AS name, ${SUMS}
       FROM jobs j
       JOIN plans p ON p.id = j.plan_id
       WHERE ${where}
       GROUP BY p.repo_owner, p.repo_name
       ORDER BY nano DESC, input DESC`,
    )
    .all(...params) as (Sums & { owner: string; name: string })[];

  const repos: RepoUsage[] = repoRows.map((r) => ({
    owner: r.owner,
    name: r.name,
    ...totalsOf(r),
  }));

  const totalsRow = db
    .prepare(
      `SELECT ${SUMS},
         COUNT(DISTINCT j.plan_id) AS plans
       FROM jobs j
       JOIN plans p ON p.id = j.plan_id
       WHERE ${where}`,
    )
    .get(...params) as Sums & { plans: number };

  return {
    granularity,
    from: q.from && DATE_RE.test(q.from) ? q.from : null,
    to: q.to && DATE_RE.test(q.to) ? q.to : null,
    usdPerAiu: config.usdPerAiu,
    summary: {
      ...totalsOf(totalsRow),
      failedAttempts: totalsRow.failed,
      plans: totalsRow.plans,
      repos: repos.length,
    },
    series,
    repos,
  };
}
