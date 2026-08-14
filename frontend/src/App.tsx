import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Issue, type PlanStatus } from "@/api/client";
import { IssueCard } from "@/components/IssueCard";
import { PlanPanel } from "@/components/PlanPanel";
import { Button } from "@/components/ui/button";
import { Eye, Loader2, RefreshCw } from "lucide-react";

interface PlanRef {
  planId: number;
  status: PlanStatus;
}

export default function App() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<number, PlanRef>>({});
  const [creating, setCreating] = useState<Record<number, boolean>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const pollers = useRef<Record<number, number>>({});

  const loadIssues = useCallback(async () => {
    setLoading(true);
    try {
      setIssues(await api.listIssues());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadIssues();
    const current = pollers.current;
    return () => Object.values(current).forEach((t) => window.clearInterval(t));
  }, [loadIssues]);

  const trackPlan = useCallback((issueNumber: number, planId: number) => {
    if (pollers.current[issueNumber]) window.clearInterval(pollers.current[issueNumber]);
    pollers.current[issueNumber] = window.setInterval(async () => {
      try {
        const p = await api.getPlan(planId);
        setPlans((prev) => ({ ...prev, [issueNumber]: { planId, status: p.status } }));
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
        const existing = await api.listPlans();
        if (!active) return;
        const map: Record<number, PlanRef> = {};
        for (const p of existing) {
          map[p.issueNumber] = { planId: p.planId, status: p.status };
          if (p.status === "planning" || p.status === "executing") trackPlan(p.issueNumber, p.planId);
        }
        setPlans((prev) => ({ ...map, ...prev }));
      } catch {
        /* no persisted plans / backend unavailable — ignore */
      }
    })();
    return () => {
      active = false;
    };
  }, [trackPlan]);

  const createPlan = async (issue: Issue) => {
    setCreating((c) => ({ ...c, [issue.number]: true }));
    try {
      const { planId, status } = await api.createPlan(issue.number);
      setPlans((prev) => ({ ...prev, [issue.number]: { planId, status } }));
      setSelected(issue.number);
      trackPlan(issue.number, planId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating((c) => ({ ...c, [issue.number]: false }));
    }
  };

  const selectedPlanId = selected != null ? plans[selected]?.planId : undefined;

  return (
    <div className="mx-auto flex h-screen max-w-[1400px] flex-col">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">BigBrother</h1>
          <p className="text-sm text-muted-foreground">AI implementation planning for your tickets</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadIssues}>
          <RefreshCw className="h-4 w-4" /> Refresh issues
        </Button>
      </header>

      <div className="grid flex-1 grid-cols-[minmax(320px,420px)_1fr] overflow-hidden">
        <aside className="flex flex-col overflow-hidden border-r">
          <div className="border-b px-4 py-2 text-sm font-medium text-muted-foreground">
            Open issues {issues.length > 0 && `(${issues.length})`}
          </div>
          <div className="flex-1 space-y-2 overflow-auto p-3">
            {loading ? (
              <div className="flex items-center gap-2 p-4 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading issues…
              </div>
            ) : error ? (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            ) : issues.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No open issues found for the configured repository.
              </div>
            ) : (
              issues.map((issue) => (
                <IssueCard
                  key={issue.number}
                  issue={issue}
                  status={plans[issue.number]?.status}
                  selected={selected === issue.number}
                  busy={!!creating[issue.number]}
                  onCreatePlan={() => createPlan(issue)}
                  onSelect={() => setSelected(issue.number)}
                />
              ))
            )}
          </div>
        </aside>

        <main className="overflow-auto p-6">
          {selectedPlanId ? (
            <PlanPanel key={selectedPlanId} planId={selectedPlanId} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Eye className="h-8 w-8" />
              <p>Select an issue and press "Create plan" to begin.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
