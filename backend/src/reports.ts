import { db } from "./db.js";
import { config } from "./config.js";

export type Granularity = "day" | "week";

export interface UsageQuery {
  repoOwner?: string;
  repoName?: string;
  from?: string; // 'YYYY-MM-DD' inclusive
  to?: string; // 'YYYY-MM-DD' inclusive
  granularity?: Granularity;
}

export interface UsageBucket {
  bucket: string; // ISO date of the bucket start (day, or Monday of the week)
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiu: number;
  usd: number | null;
  attempts: number;
}

export interface RepoUsage {
  owner: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  aiu: number;
  usd: number | null;
  attempts: number;
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
    attempts: number;
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

/**
 * SQLite expression that maps a UTC `created_at` timestamp to the ISO date of
 * its bucket. For weeks we snap to the Monday of the containing week so the
 * value is chart-friendly and sortable.
 */
function bucketExpr(granularity: Granularity): string {
  if (granularity === "week") {
    // `weekday 0` → next Sunday; `-6 days` → Monday of the current week.
    return "date(j.created_at, 'weekday 0', '-6 days')";
  }
  return "date(j.created_at)";
}

interface Filters {
  where: string;
  params: unknown[];
}

function buildFilters(q: UsageQuery): Filters {
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

/** Aggregate plan-job token/AIU usage into time buckets + summary + per-repo totals. */
export function getUsageReport(q: UsageQuery): UsageReport {
  const granularity: Granularity = q.granularity === "week" ? "week" : "day";
  const { where, params } = buildFilters(q);
  const bucket = bucketExpr(granularity);

  const seriesRows = db
    .prepare(
      `SELECT
         ${bucket}                            AS bucket,
         COALESCE(SUM(j.input_tokens),0)      AS input_tokens,
         COALESCE(SUM(j.output_tokens),0)     AS output_tokens,
         COALESCE(SUM(j.nano_aiu),0)          AS nano_aiu,
         COUNT(*)                             AS attempts
       FROM jobs j
       JOIN plans p ON p.id = j.plan_id
       WHERE ${where}
       GROUP BY bucket
       ORDER BY bucket ASC`,
    )
    .all(...params) as {
    bucket: string;
    input_tokens: number;
    output_tokens: number;
    nano_aiu: number;
    attempts: number;
  }[];

  const series: UsageBucket[] = seriesRows.map((r) => {
    const aiu = r.nano_aiu / 1e9;
    return {
      bucket: r.bucket,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.input_tokens + r.output_tokens,
      aiu,
      usd: usd(aiu),
      attempts: r.attempts,
    };
  });

  const repoRows = db
    .prepare(
      `SELECT
         p.repo_owner                         AS owner,
         p.repo_name                          AS name,
         COALESCE(SUM(j.input_tokens),0)      AS input_tokens,
         COALESCE(SUM(j.output_tokens),0)     AS output_tokens,
         COALESCE(SUM(j.nano_aiu),0)          AS nano_aiu,
         COUNT(*)                             AS attempts
       FROM jobs j
       JOIN plans p ON p.id = j.plan_id
       WHERE ${where}
       GROUP BY p.repo_owner, p.repo_name
       ORDER BY nano_aiu DESC, input_tokens DESC`,
    )
    .all(...params) as {
    owner: string;
    name: string;
    input_tokens: number;
    output_tokens: number;
    nano_aiu: number;
    attempts: number;
  }[];

  const repos: RepoUsage[] = repoRows.map((r) => {
    const aiu = r.nano_aiu / 1e9;
    return {
      owner: r.owner,
      name: r.name,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.input_tokens + r.output_tokens,
      aiu,
      usd: usd(aiu),
      attempts: r.attempts,
    };
  });

  const totalsRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(j.input_tokens),0)                          AS input_tokens,
         COALESCE(SUM(j.output_tokens),0)                         AS output_tokens,
         COALESCE(SUM(j.nano_aiu),0)                              AS nano_aiu,
         COUNT(*)                                                 AS attempts,
         COALESCE(SUM(CASE WHEN j.status='failed' THEN 1 ELSE 0 END),0) AS failed_attempts,
         COUNT(DISTINCT j.plan_id)                                AS plans
       FROM jobs j
       JOIN plans p ON p.id = j.plan_id
       WHERE ${where}`,
    )
    .get(...params) as {
    input_tokens: number;
    output_tokens: number;
    nano_aiu: number;
    attempts: number;
    failed_attempts: number;
    plans: number;
  };

  const totalAiu = totalsRow.nano_aiu / 1e9;

  return {
    granularity,
    from: q.from && DATE_RE.test(q.from) ? q.from : null,
    to: q.to && DATE_RE.test(q.to) ? q.to : null,
    usdPerAiu: config.usdPerAiu,
    summary: {
      inputTokens: totalsRow.input_tokens,
      outputTokens: totalsRow.output_tokens,
      totalTokens: totalsRow.input_tokens + totalsRow.output_tokens,
      aiu: totalAiu,
      usd: usd(totalAiu),
      attempts: totalsRow.attempts,
      failedAttempts: totalsRow.failed_attempts,
      plans: totalsRow.plans,
      repos: repos.length,
    },
    series,
    repos,
  };
}
