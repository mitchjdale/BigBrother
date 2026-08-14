import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  api,
  type RepoRef,
  type UsageGranularity,
  type UsageReport,
} from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePersistentState, readCache, writeCache } from "@/lib/usePersistentState";
import { Coins, Hash, Loader2, RefreshCw, Zap } from "lucide-react";

type Metric = "tokens" | "aiu" | "usd";
type Preset = "7" | "30" | "90" | "all" | "custom";

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function rangeForPreset(preset: Preset): { from?: string; to?: string } {
  if (preset === "all" || preset === "custom") return {};
  const days = Number(preset);
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return { from: isoDate(from), to: isoDate(to) };
}

const PRESET_OPTIONS: { label: string; value: Preset }[] = [
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "All time", value: "all" },
  { label: "Custom", value: "custom" },
];

function fmtInt(n: number): string {
  return n.toLocaleString();
}

export default function UsagePage() {
  const [repos, setRepos] = useState<RepoRef[]>(
    () => readCache<{ repos: RepoRef[] }>("bb.cache.repos")?.repos ?? [],
  );
  const [repoKey, setRepoKey] = usePersistentState("bb.usage.repo", ""); // "" = all, else "owner/name"
  const [granularity, setGranularity] = usePersistentState<UsageGranularity>("bb.usage.granularity", "day");
  const [preset, setPreset] = usePersistentState<Preset>("bb.usage.preset", "30");
  const [customFrom, setCustomFrom] = usePersistentState("bb.usage.customFrom", "");
  const [customTo, setCustomTo] = usePersistentState("bb.usage.customTo", "");
  const [metric, setMetric] = usePersistentState<Metric>("bb.usage.metric", "tokens");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedRepo: RepoRef | null = useMemo(() => {
    if (!repoKey) return null;
    return repos.find((r) => `${r.owner}/${r.name}` === repoKey) ?? null;
  }, [repoKey, repos]);

  const range = useMemo(() => {
    if (preset === "custom") {
      return { from: customFrom || undefined, to: customTo || undefined };
    }
    return rangeForPreset(preset);
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    let active = true;
    api
      .listRepos()
      .then((payload) => {
        if (active) setRepos(payload.repos);
        writeCache("bb.cache.repos", payload);
      })
      .catch(() => {
        /* repo filter is optional — ignore */
      });
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(async () => {
    const cacheKey = `bb.cache.usage:${repoKey || "all"}:${range.from ?? ""}:${range.to ?? ""}:${granularity}`;
    const cached = readCache<UsageReport>(cacheKey);
    if (cached) {
      // Show cached report immediately and revalidate in the background.
      setReport(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    try {
      const data = await api.getUsage({
        repo: selectedRepo,
        from: range.from,
        to: range.to,
        granularity,
      });
      setReport(data);
      writeCache(cacheKey, data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedRepo, repoKey, range.from, range.to, granularity]);

  useEffect(() => {
    load();
  }, [load]);

  // Estimated USD is model-based and always present, so USD is always available.
  const chartData = useMemo(
    () =>
      (report?.series ?? []).map((b) => ({
        bucket: b.bucket,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        totalTokens: b.totalTokens,
        aiu: Number(b.aiu.toFixed(4)),
        usd: Number(b.estimatedUsd.toFixed(4)),
      })),
    [report],
  );

  const metricButtons: { label: string; value: Metric; disabled?: boolean }[] = [
    { label: "Tokens", value: "tokens" },
    { label: "AIU", value: "aiu" },
    { label: "USD (est.)", value: "usd" },
  ];

  const s = report?.summary;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold">Token usage</h2>
          <p className="text-sm text-muted-foreground">
            Planning token and cost usage across all plans.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Repository
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
              value={repoKey}
              onChange={(e) => setRepoKey(e.target.value)}
            >
              <option value="">All repositories</option>
              {repos.map((r) => (
                <option key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`}>
                  {r.owner}/{r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Range
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
              value={preset}
              onChange={(e) => setPreset(e.target.value as Preset)}
            >
              {PRESET_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {preset === "custom" && (
            <>
              <label className="grid gap-1 text-xs text-muted-foreground">
                From
                <input
                  type="date"
                  className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                To
                <input
                  type="date"
                  className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </label>
            </>
          )}
          <label className="grid gap-1 text-xs text-muted-foreground">
            Granularity
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as UsageGranularity)}
            >
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
            </select>
          </label>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </header>

      <div className="space-y-4 p-6">
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryCard
            title="Total tokens"
            icon={<Hash className="h-4 w-4" />}
            value={s ? fmtInt(s.totalTokens) : "—"}
            sub={s ? `${fmtInt(s.inputTokens)} in / ${fmtInt(s.outputTokens)} out` : undefined}
          />
          <SummaryCard
            title="Total AIU"
            icon={<Zap className="h-4 w-4" />}
            value={s ? s.aiu.toFixed(2) : "—"}
            sub={s ? `${fmtInt(s.attempts)} plan run(s)` : undefined}
          />
          <SummaryCard
            title="Estimated cost"
            icon={<Coins className="h-4 w-4" />}
            value={s ? `~$${s.estimatedUsd.toFixed(2)}` : "—"}
            sub={s ? `${s.aiu.toFixed(2)} AIU` : undefined}
          />
          <SummaryCard
            title="Plans"
            icon={<Hash className="h-4 w-4" />}
            value={s ? fmtInt(s.plans) : "—"}
            sub={s ? `${fmtInt(s.failedAttempts)} failed run(s)` : undefined}
          />
        </div>

        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Usage over time</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex overflow-hidden rounded-md border">
                {metricButtons.map((m) => (
                  <button
                    key={m.value}
                    disabled={m.disabled}
                    onClick={() => setMetric(m.value)}
                    className={`px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      metric === m.value
                        ? "bg-primary text-primary-foreground"
                        : "bg-background hover:bg-accent"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading && !report ? (
              <div className="flex h-72 items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading usage…
              </div>
            ) : chartData.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-muted-foreground">
                No usage recorded for this range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={64} />
                  <Tooltip
                    formatter={(value) => {
                      const n = typeof value === "number" ? value : Number(value);
                      return metric === "tokens" ? fmtInt(n) : n;
                    }}
                  />
                  <Legend />
                  {metric === "tokens" ? (
                    <>
                      <Bar dataKey="inputTokens" name="Input" stackId="t" fill="#6366f1" />
                      <Bar dataKey="outputTokens" name="Output" stackId="t" fill="#22c55e" />
                    </>
                  ) : (
                    <Bar
                      dataKey={metric === "aiu" ? "aiu" : "usd"}
                      name={metric === "aiu" ? "AIU" : "USD"}
                      fill={metric === "aiu" ? "#f59e0b" : "#10b981"}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {report && report.repos.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">By repository</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Repository</th>
                      <th className="py-2 pr-4 text-right font-medium">Total tokens</th>
                      <th className="py-2 pr-4 text-right font-medium">Input</th>
                      <th className="py-2 pr-4 text-right font-medium">Output</th>
                      <th className="py-2 pr-4 text-right font-medium">AIU</th>
                      <th className="py-2 pr-4 text-right font-medium">Est. cost</th>
                      <th className="py-2 text-right font-medium">Runs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.repos.map((r) => (
                      <tr key={`${r.owner}/${r.name}`} className="border-b last:border-0">
                        <td className="py-2 pr-4">
                          {r.owner}/{r.name}
                        </td>
                        <td className="py-2 pr-4 text-right">{fmtInt(r.totalTokens)}</td>
                        <td className="py-2 pr-4 text-right">{fmtInt(r.inputTokens)}</td>
                        <td className="py-2 pr-4 text-right">{fmtInt(r.outputTokens)}</td>
                        <td className="py-2 pr-4 text-right">{r.aiu.toFixed(2)}</td>
                        <td className="py-2 pr-4 text-right">~${r.estimatedUsd.toFixed(2)}</td>
                        <td className="py-2 text-right">{fmtInt(r.attempts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  sub,
  icon,
}: {
  title: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {title}
        </div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
