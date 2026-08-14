import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Issue,
  type IssueContext,
  type IssueSource,
  type JiraProjectMapping,
  type PlanStatus,
  type RepoRef,
} from "@/api/client";
import { IssueCard } from "@/components/IssueCard";
import { IssueDetail } from "@/components/IssueDetail";
import { PlanPanel } from "@/components/PlanPanel";
import { Button } from "@/components/ui/button";
import { usePersistentState, readCache, writeCache } from "@/lib/usePersistentState";
import { Eye, Loader2, RefreshCw } from "lucide-react";

interface PlanRef {
  planId: number;
  status: PlanStatus;
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

const selectClass = "h-9 rounded-md border bg-background px-2 text-sm text-foreground";

/** Stable per-context cache/label key. */
function contextKey(ctx: IssueContext): string {
  return ctx.source === "github" ? `gh:${ctx.repo.owner}/${ctx.repo.name}` : `jira:${ctx.project}`;
}

export default function DashboardPage() {
  const [source, setSource] = usePersistentState<IssueSource>("bb.dashboard.source", "github");
  const [jiraAvailable, setJiraAvailable] = useState(false);

  const [repoOptions, setRepoOptions] = useState<RepoRef[]>(
    () => readCache<{ defaultRepo: RepoRef; repos: RepoRef[] }>("bb.cache.repos")?.repos ?? [],
  );
  const [selectedOwner, setSelectedOwner] = usePersistentState("bb.dashboard.owner", "");
  const [selectedRepoName, setSelectedRepoName] = usePersistentState("bb.dashboard.repo", "");
  const [loadingRepos, setLoadingRepos] = useState(
    () => readCache<{ repos: RepoRef[] }>("bb.cache.repos") == null,
  );

  const [mappings, setMappings] = useState<JiraProjectMapping[]>(
    () => readCache<JiraProjectMapping[]>("bb.cache.mappings") ?? [],
  );
  const [selectedProject, setSelectedProject] = usePersistentState("bb.dashboard.project", "");

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, PlanRef>>({});
  const [creating, setCreating] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [planningModel, setPlanningModel] = usePersistentState<string | null>(
    "bb.dashboard.planningModel",
    null,
  );
  const [executionModel, setExecutionModel] = usePersistentState<string | null>(
    "bb.dashboard.executionModel",
    null,
  );
  const pollers = useRef<Record<string, number>>({});

  const ownerOptions = [...new Set(repoOptions.map((r) => r.owner))];
  const reposForOwner = repoOptions.filter((r) => r.owner === selectedOwner);
  const selectedRepo =
    repoOptions.find((r) => r.owner === selectedOwner && r.name === selectedRepoName) ?? null;
  const selectedMapping = mappings.find((m) => m.projectKey === selectedProject) ?? null;

  // The effective issue-source context used for all API calls.
  const ctx: IssueContext | null =
    source === "github"
      ? selectedRepo
        ? { source: "github", repo: selectedRepo }
        : null
      : selectedProject
        ? { source: "jira", project: selectedProject }
        : null;
  const ctxId = ctx ? contextKey(ctx) : null;

  const clearPollers = useCallback(() => {
    const current = pollers.current;
    Object.values(current).forEach((t) => window.clearInterval(t));
    pollers.current = {};
  }, []);

  const loadIssues = useCallback(async () => {
    if (!ctx || !ctxId) {
      setIssues([]);
      setLoading(false);
      return;
    }
    const cacheKey = `bb.cache.issues:${ctxId}`;
    const cached = readCache<Issue[]>(cacheKey);
    if (cached) {
      setIssues(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    try {
      const fresh = await api.listIssues(ctx);
      setIssues(fresh);
      writeCache(cacheKey, fresh);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxId]);

  useEffect(() => {
    return () => clearPollers();
  }, [clearPollers]);

  const trackPlan = useCallback((issueKey: string, planId: number) => {
    if (pollers.current[issueKey]) window.clearInterval(pollers.current[issueKey]);
    pollers.current[issueKey] = window.setInterval(async () => {
      try {
        const p = await api.getPlan(planId);
        setPlans((prev) => ({ ...prev, [issueKey]: { planId, status: p.status } }));
        if (p.status !== "planning" && p.status !== "executing") {
          window.clearInterval(pollers.current[issueKey]);
          delete pollers.current[issueKey];
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
  }, []);

  // One-time load: sources, repos, and JIRA mappings.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [sources, payload] = await Promise.all([
          api.listSources().catch(() => ({ github: true, jira: false })),
          api.listRepos(),
        ]);
        if (!active) return;
        setJiraAvailable(sources.jira);
        setRepoOptions(payload.repos);
        writeCache("bb.cache.repos", payload);
        if (!payload.repos.some((r) => r.owner === selectedOwner)) {
          setSelectedOwner(payload.defaultRepo.owner);
          setSelectedRepoName(payload.defaultRepo.name);
        }
        if (sources.jira) {
          const maps = await api.listMappings().catch(() => [] as JiraProjectMapping[]);
          if (!active) return;
          setMappings(maps);
          writeCache("bb.cache.mappings", maps);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fall back to GitHub if a persisted JIRA source is no longer available.
  useEffect(() => {
    if (source === "jira" && !jiraAvailable && !loadingRepos) setSource("github");
  }, [source, jiraAvailable, loadingRepos, setSource]);

  // Keep the GitHub repo selection valid for the chosen owner.
  useEffect(() => {
    if (!selectedOwner) return;
    if (reposForOwner.length === 0) return;
    if (reposForOwner.some((r) => r.name === selectedRepoName)) return;
    setSelectedRepoName(reposForOwner[0]?.name ?? "");
  }, [reposForOwner, selectedOwner, selectedRepoName, setSelectedRepoName]);

  // Default the JIRA project selection to the first mapping.
  useEffect(() => {
    if (source !== "jira") return;
    if (mappings.length === 0) return;
    if (mappings.some((m) => m.projectKey === selectedProject)) return;
    setSelectedProject(mappings[0]?.projectKey ?? "");
  }, [source, mappings, selectedProject, setSelectedProject]);

  // Reset the view whenever the effective context changes.
  useEffect(() => {
    clearPollers();
    const plansKey = ctxId ? `bb.cache.plans:${ctxId}` : null;
    setPlans(plansKey ? readCache<Record<string, PlanRef>>(plansKey) ?? {} : {});
    setCreating({});
    setSelected(null);
    loadIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearPollers, loadIssues, ctxId]);

  // Hydrate persisted plans for the current context.
  useEffect(() => {
    if (!ctx || !ctxId) return;
    let active = true;
    (async () => {
      try {
        const existing = await api.listPlans(ctx);
        if (!active) return;
        const map: Record<string, PlanRef> = {};
        for (const p of existing) {
          map[p.issueKey] = { planId: p.planId, status: p.status };
          if (p.status === "planning" || p.status === "executing") trackPlan(p.issueKey, p.planId);
        }
        writeCache(`bb.cache.plans:${ctxId}`, map);
        setPlans((prev) => ({ ...map, ...prev }));
      } catch {
        /* no persisted plans / backend unavailable — ignore */
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxId, trackPlan]);

  const createPlan = async (issue: Issue) => {
    if (!ctx) return;
    setCreating((c) => ({ ...c, [issue.key]: true }));
    try {
      const { planId, status } = await api.createPlan(ctx, issue.key, planningModel);
      setPlans((prev) => ({ ...prev, [issue.key]: { planId, status } }));
      setSelected(issue.key);
      trackPlan(issue.key, planId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating((c) => ({ ...c, [issue.key]: false }));
    }
  };

  const selectedPlanId = selected != null ? plans[selected]?.planId : undefined;
  const selectedIssue = selected != null ? issues.find((i) => i.key === selected) ?? null : null;

  const contextLabel =
    source === "github"
      ? selectedRepo
        ? `${selectedRepo.owner}/${selectedRepo.name}`
        : null
      : selectedMapping
        ? `${selectedMapping.projectKey}`
        : null;

  useEffect(() => {
    const issueTitle = selectedIssue?.title;
    const parts = [issueTitle, contextLabel, "BigBrother"].filter(Boolean);
    document.title = parts.join(" · ");
  }, [contextLabel, selectedIssue]);

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
            Source
            <select
              className={selectClass}
              value={source}
              onChange={(e) => setSource(e.target.value as IssueSource)}
            >
              <option value="github">GitHub Issues</option>
              <option value="jira" disabled={!jiraAvailable}>
                JIRA{jiraAvailable ? "" : " (not configured)"}
              </option>
            </select>
          </label>

          {source === "github" ? (
            <>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Owner
                <select
                  className={selectClass}
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
                  className={selectClass}
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
            </>
          ) : (
            <label className="grid gap-1 text-xs text-muted-foreground">
              JIRA project
              <select
                className={selectClass}
                value={selectedProject}
                onChange={(e) => setSelectedProject(e.target.value)}
                disabled={mappings.length === 0}
              >
                {mappings.length === 0 && <option value="">No mappings</option>}
                {mappings.map((m) => (
                  <option key={m.projectKey} value={m.projectKey}>
                    {m.projectKey} — {m.projectName}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="grid gap-1 text-xs text-muted-foreground">
            Planning model
            <select
              className={selectClass}
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
              className={selectClass}
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

      {source === "jira" && selectedMapping && (
        <div className="border-b bg-muted/30 px-6 py-1.5 text-xs text-muted-foreground">
          Plans &amp; PRs for <span className="font-medium">{selectedMapping.projectKey}</span> target{" "}
          <span className="font-mono">
            {selectedMapping.repoOwner}/{selectedMapping.repoName}
          </span>{" "}
          ({selectedMapping.repoBase})
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,420px)_1fr] overflow-hidden">
        <aside className="flex flex-col overflow-hidden border-r">
          <div className="border-b px-4 py-2 text-sm font-medium text-muted-foreground">
            Open issues {issues.length > 0 && `(${issues.length})`}
          </div>
          <div className="flex-1 space-y-2 overflow-auto p-3">
            {source === "jira" && mappings.length === 0 && !loadingRepos ? (
              <div className="p-4 text-sm text-muted-foreground">
                No JIRA projects are mapped yet. Add a project → repository mapping on the{" "}
                <span className="font-medium">Settings</span> page.
              </div>
            ) : loading ? (
              <div className="flex items-center gap-2 p-4 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading issues…
              </div>
            ) : error ? (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            ) : issues.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                {loadingRepos
                  ? "Loading…"
                  : `No open issues found for ${contextLabel ?? "the selected source"}.`}
              </div>
            ) : (
              issues.map((issue) => (
                <IssueCard
                  key={issue.key}
                  issue={issue}
                  status={plans[issue.key]?.status}
                  selected={selected === issue.key}
                  busy={!!creating[issue.key]}
                  onCreatePlan={() => createPlan(issue)}
                  onSelect={() => setSelected(issue.key)}
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
