import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Issue, type PlanStatus, type RepoRef } from "@/api/client";
import { IssueCard } from "@/components/IssueCard";
import { IssueDetail } from "@/components/IssueDetail";
import { PlanPanel } from "@/components/PlanPanel";
import { Button } from "@/components/ui/button";
import { usePersistentState, readCache, writeCache } from "@/lib/usePersistentState";
import { Eye, Loader2, RefreshCw } from "lucide-react";

interface PlanRef {
  planId: number;
  status: PlanStatus;
  estimatedUsd?: number;
}

const MODEL_OPTIONS = [
  { label: "Copilot default (auto)", value: "" },
  { label: "GPT-5.5", value: "gpt-5.5" },
  { label: "GPT-5.3-Codex", value: "gpt-5.3-codex" },
  { label: "GPT-5 mini", value: "gpt-5-mini" },
  { label: "Claude Sonnet 5", value: "claude-sonnet-5" },
  { label: "Claude Sonnet 4.5", value: "claude-sonnet-4.5" },
  { label: "Claude Opus 4.8", value: "claude-opus-4.8" },
  { label: "Claude Haiku 4.5", value: "claude-haiku-4.5" },
  { label: "Gemini 3.1 Pro Preview", value: "gemini-3.1-pro-preview" },
];

export default function DashboardPage() {
  const [repoOptions, setRepoOptions] = useState<RepoRef[]>(
    () => readCache<{ defaultRepo: RepoRef; repos: RepoRef[] }>("bb.cache.repos")?.repos ?? [],
  );
  const [selectedOwner, setSelectedOwner] = usePersistentState("bb.dashboard.owner", "");
  const [selectedRepoName, setSelectedRepoName] = usePersistentState("bb.dashboard.repo", "");
  const [issueState, setIssueState] = usePersistentState<"open" | "closed">(
    "bb.dashboard.issueState",
    "open",
  );
  const [loadingRepos, setLoadingRepos] = useState(
    () => readCache<{ repos: RepoRef[] }>("bb.cache.repos") == null,
  );
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<number, PlanRef>>({});
  const [creating, setCreating] = useState<Record<number, boolean>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [planningModel, setPlanningModel] = usePersistentState<string | null>(
    "bb.dashboard.planningModel",
    null,
  );
  const [executionModel, setExecutionModel] = usePersistentState<string | null>(
    "bb.dashboard.executionModel",
    null,
  );
  const pollers = useRef<Record<number, number>>({});
  const ownerOptions = [...new Set(repoOptions.map((r) => r.owner))];
  const reposForOwner = repoOptions.filter((r) => r.owner === selectedOwner);
  const selectedRepo =
    repoOptions.find((r) => r.owner === selectedOwner && r.name === selectedRepoName) ?? null;

  const clearPollers = useCallback(() => {
    const current = pollers.current;
    Object.values(current).forEach((t) => window.clearInterval(t));
    pollers.current = {};
  }, []);

  const loadIssues = useCallback(async () => {
    if (!selectedRepo) {
      setIssues([]);
      setLoading(false);
      return;
    }
    const cacheKey = `bb.cache.issues:${selectedRepo.owner}/${selectedRepo.name}:${issueState}`;
    const cached = readCache<Issue[]>(cacheKey);
    if (cached) {
      // Show cached issues immediately and revalidate in the background.
      setIssues(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    try {
      const fresh = await api.listIssues(selectedRepo, issueState);
      setIssues(fresh);
      writeCache(cacheKey, fresh);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [issueState, selectedRepo]);

  useEffect(() => {
    return () => clearPollers();
  }, [clearPollers]);

  const trackPlan = useCallback((issueNumber: number, planId: number) => {
    if (pollers.current[issueNumber]) window.clearInterval(pollers.current[issueNumber]);
    pollers.current[issueNumber] = window.setInterval(async () => {
      try {
        const p = await api.getPlan(planId);
        setPlans((prev) => ({
          ...prev,
          [issueNumber]: { planId, status: p.status, estimatedUsd: p.totalCost.estimatedUsd },
        }));
        if (p.status !== "planning" && p.status !== "executing") {
          window.clearInterval(pollers.current[issueNumber]);
          delete pollers.current[issueNumber];
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
  }, []);

  // Restore persisted plans after a page/server restart so previously planned
  // issues still show their plan (issue #7).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const payload = await api.listRepos();
        if (!active) return;
        setRepoOptions(payload.repos);
        writeCache("bb.cache.repos", payload);
        // Keep a persisted selection if it's still valid; otherwise fall back
        // to the backend default repo.
        if (!payload.repos.some((r) => r.owner === selectedOwner)) {
          setSelectedOwner(payload.defaultRepo.owner);
          setSelectedRepoName(payload.defaultRepo.name);
        }
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoadingRepos(false);
      }
    })();
    return () => {
      active = false;
    };
    // Runs once on mount; intentionally captures the initial persisted
    // selection to decide whether to apply the backend default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedOwner) return;
    // Wait until repos have loaded before "correcting" the selection, otherwise
    // we'd wipe the persisted repo name while the list is momentarily empty.
    if (reposForOwner.length === 0) return;
    if (reposForOwner.some((r) => r.name === selectedRepoName)) return;
    setSelectedRepoName(reposForOwner[0]?.name ?? "");
  }, [reposForOwner, selectedOwner, selectedRepoName, setSelectedRepoName]);

  useEffect(() => {
    clearPollers();
    const plansKey = selectedRepo
      ? `bb.cache.plans:${selectedRepo.owner}/${selectedRepo.name}`
      : null;
    // Seed plan badges from cache so they show instantly on refresh.
    setPlans(plansKey ? readCache<Record<number, PlanRef>>(plansKey) ?? {} : {});
    setCreating({});
    setSelected(null);
    loadIssues();
  }, [clearPollers, loadIssues, selectedRepo]);

  useEffect(() => {
    if (!selectedRepo) return;
    let active = true;
    (async () => {
      try {
        const existing = await api.listPlans(selectedRepo);
        if (!active) return;
        const map: Record<number, PlanRef> = {};
        for (const p of existing) {
          map[p.issueNumber] = { planId: p.planId, status: p.status, estimatedUsd: p.estimatedUsd };
          if (p.status === "planning" || p.status === "executing") trackPlan(p.issueNumber, p.planId);
        }
        writeCache(`bb.cache.plans:${selectedRepo.owner}/${selectedRepo.name}`, map);
        setPlans((prev) => ({ ...map, ...prev }));
      } catch {
        /* no persisted plans / backend unavailable — ignore */
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedRepo, trackPlan]);

  const createPlan = async (issue: Issue) => {
    if (!selectedRepo) return;
    setCreating((c) => ({ ...c, [issue.number]: true }));
    try {
      const { planId, status } = await api.createPlan(issue.number, selectedRepo, planningModel);
      setPlans((prev) => ({ ...prev, [issue.number]: { planId, status } }));
      setSelected(issue.number);
      trackPlan(issue.number, planId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating((c) => ({ ...c, [issue.number]: false }));
    }
  };

  const clearPlan = async (issue: Issue) => {
    if (!selectedRepo) return;
    const ref = plans[issue.number];
    if (!ref) return;
    if (pollers.current[issue.number]) {
      window.clearInterval(pollers.current[issue.number]);
      delete pollers.current[issue.number];
    }
    try {
      await api.deletePlan(ref.planId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setPlans((prev) => {
      const next = { ...prev };
      delete next[issue.number];
      writeCache(`bb.cache.plans:${selectedRepo.owner}/${selectedRepo.name}`, next);
      return next;
    });
    if (selected === issue.number) setSelected(null);
  };

  const selectedPlanId = selected != null ? plans[selected]?.planId : undefined;
  const selectedIssue = selected != null ? issues.find((i) => i.number === selected) ?? null : null;
  const visibleIssues = issues;

  useEffect(() => {
    if (!selectedRepo) return;
    writeCache(`bb.cache.plans:${selectedRepo.owner}/${selectedRepo.name}`, plans);
  }, [plans, selectedRepo]);

  // Reflect the current repo / selected issue in the browser tab title (issue #6).
  useEffect(() => {
    const repoLabel = selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : null;
    const issueTitle =
      selected != null ? issues.find((i) => i.number === selected)?.title : undefined;
    const parts = [issueTitle, repoLabel, "BigBrother"].filter(Boolean);
    document.title = parts.join(" · ");
  }, [selectedRepo, selected, issues]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold">Issues</h2>
          <p className="text-sm text-muted-foreground">
            Pick an issue and press "Create plan" to begin.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Owner
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
              value={selectedOwner}
              onChange={(e) => setSelectedOwner(e.target.value)}
              disabled={loadingRepos || ownerOptions.length === 0}
            >
              {ownerOptions.map((owner) => (
                <option key={owner} value={owner}>
                  {owner}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Repository
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
              value={selectedRepoName}
              onChange={(e) => setSelectedRepoName(e.target.value)}
              disabled={loadingRepos || reposForOwner.length === 0}
            >
              {reposForOwner.map((repo) => (
                <option key={`${repo.owner}/${repo.name}`} value={repo.name}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Issue state
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
              value={issueState}
              onChange={(e) => setIssueState((e.target.value as "open" | "closed") ?? "open")}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Planning model
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
              value={planningModel ?? ""}
              onChange={(e) => setPlanningModel(e.target.value || null)}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value || "auto-plan"} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Execution model
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
              value={executionModel ?? ""}
              onChange={(e) => setExecutionModel(e.target.value || null)}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value || "auto-exec"} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <Button variant="outline" size="sm" onClick={loadIssues}>
            <RefreshCw className="h-4 w-4" /> Refresh issues
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,420px)_1fr] overflow-hidden">
        <aside className="flex flex-col overflow-hidden border-r">
          <div className="border-b px-4 py-2 text-sm font-medium text-muted-foreground">
            {issueState === "open" ? "Open" : "Closed"} issues {issues.length > 0 && `(${issues.length})`}
          </div>
          <div className="flex-1 space-y-2 overflow-auto p-3">
            {loading ? (
              <div className="flex items-center gap-2 p-4 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading issues…
              </div>
            ) : error ? (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            ) : visibleIssues.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                {loadingRepos
                  ? "Loading repositories…"
                  : issueState === "open"
                    ? `No open issues found for ${selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : "the selected repository"}.`
                    : `No closed issues you've worked on for ${selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : "the selected repository"}.`}
              </div>
            ) : (
              visibleIssues.map((issue) => (
                <IssueCard
                  key={issue.number}
                  issue={issue}
                  status={plans[issue.number]?.status}
                  estimatedUsd={plans[issue.number]?.estimatedUsd}
                  selected={selected === issue.number}
                  busy={!!creating[issue.number]}
                  hasPlan={!!plans[issue.number]}
                  onCreatePlan={() => createPlan(issue)}
                  onClearPlan={() => clearPlan(issue)}
                  onSelect={() => setSelected(issue.number)}
                />
              ))
            )}
          </div>
        </aside>

        <main className="overflow-auto p-6">
          {selectedIssue ? (
            <div className="flex h-full min-h-0 flex-col gap-4">
              <IssueDetail issue={selectedIssue} />
              {selectedPlanId ? (
                <div className="min-h-0 flex-1">
                  <PlanPanel
                    key={selectedPlanId}
                    planId={selectedPlanId}
                    planningModel={planningModel}
                    executionModel={executionModel}
                    onStatusChange={(status) => {
                      if (selected == null || selectedPlanId == null) return;
                      setPlans((prev) => ({
                        ...prev,
                        [selected]: {
                          ...prev[selected],
                          planId: selectedPlanId,
                          status,
                        },
                      }));
                      if (status === "pr_open") void loadIssues();
                    }}
                  />
                </div>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed text-muted-foreground">
                  <Eye className="h-8 w-8" />
                  <p>Press "Create plan" on this issue to generate an implementation plan.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Eye className="h-8 w-8" />
              <p>Select an issue to view its details and create a plan.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
