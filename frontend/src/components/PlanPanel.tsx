import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "./StatusBadge";
import { CostBar } from "./CostBar";
import { api, type PlanStatus, type PlanView } from "@/api/client";
import { ExternalLink, Loader2, Pencil, RefreshCw, Rocket, RotateCcw, Save, X } from "lucide-react";

const POLL_MS = 2500;

interface Props {
  planId: number;
  planningModel: string | null;
  executionModel: string | null;
  onStatusChange?: (status: PlanStatus) => void;
}

export function PlanPanel({ planId, planningModel, executionModel, onStatusChange }: Props) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastStatus = useRef<PlanStatus | null>(null);

  const applyPlan = useCallback(
    (next: PlanView) => {
      setPlan(next);
      if (lastStatus.current !== next.status) {
        lastStatus.current = next.status;
        onStatusChange?.(next.status);
      }
    },
    [onStatusChange],
  );

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    lastStatus.current = null;

    const tick = async () => {
      try {
        const p = await api.getPlan(planId);
        if (!active) return;
        applyPlan(p);
        setError(null);
        if (p.status === "planning" || p.status === "executing") {
          timer = window.setTimeout(tick, POLL_MS);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [applyPlan, planId]);

  const refresh = async () => applyPlan(await api.getPlan(planId));

  const doRegenerate = async () => {
    if (!feedback.trim()) return;
    setBusy(true);
    try {
      await api.regenerate(planId, feedback.trim(), planningModel);
      setFeedback("");
      await refresh();
      poll();
    } finally {
      setBusy(false);
    }
  };

  const doSaveEdit = async () => {
    setBusy(true);
    try {
      await api.editVersion(planId, draft);
      setEditing(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const doExecute = async () => {
    setBusy(true);
    try {
      await api.execute(planId, executionModel);
      await refresh();
      poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRetry = async () => {
    setBusy(true);
    try {
      await api.retry(planId, planningModel);
      setError(null);
      await refresh();
      poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRequestReview = async () => {
    setBusy(true);
    try {
      const updated = await api.requestReview(planId);
      setPlan(updated);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const poll = () => {
    const id = window.setInterval(async () => {
      const p = await api.getPlan(planId);
      applyPlan(p);
      if (p.status !== "planning" && p.status !== "executing") window.clearInterval(id);
    }, POLL_MS);
  };

  if (!plan) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading plan…
      </div>
    );
  }

  const isPlanning = plan.status === "planning";
  const canExecute = plan.status === "ready";
  const canRequestReview = !!plan.pr?.url && plan.pr.number != null;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Issue #{plan.issueNumber}</h2>
          <StatusBadge status={plan.status} />
        </div>
        <Button variant="ghost" size="icon" onClick={refresh} title="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <CostBar total={plan.totalCost} current={plan.currentPlan?.cost} />

      {error && <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
      {plan.error && (
        <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{plan.error}</div>
      )}

      {plan.status === "failed" && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2">
          <span className="text-sm text-muted-foreground">
            This plan attempt failed. Retry keeps the previous token usage.
          </span>
          <Button variant="outline" size="sm" onClick={doRetry} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            Retry plan
          </Button>
        </div>
      )}

      {plan.pr?.url && (
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={plan.pr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            <ExternalLink className="h-4 w-4" /> Draft PR #{plan.pr.number}
          </a>
          {plan.pr.reviewState === "requested" && <Badge variant="secondary">Copilot review requested</Badge>}
          {canRequestReview && plan.pr.reviewState !== "requested" && (
            <Button variant="outline" size="sm" onClick={doRequestReview} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Request Copilot review
            </Button>
          )}
        </div>
      )}

      <Card className="flex-1 overflow-hidden">
        <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
          <CardTitle className="text-sm">
            Plan{plan.currentPlan ? ` · v${plan.currentPlan.versionNo}` : ""}{" "}
            {plan.currentPlan && (
              <Badge variant="outline" className="ml-1 text-[10px]">
                {plan.currentPlan.source}
              </Badge>
            )}
          </CardTitle>
          {plan.currentPlan && !editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(plan.currentPlan!.markdown);
                setEditing(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
        </CardHeader>
        <CardContent className="h-[calc(100%-3.25rem)] overflow-auto">
          {isPlanning && !plan.currentPlan ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Copilot is researching the repo and drafting a plan…
            </div>
          ) : editing ? (
            <div className="flex h-full flex-col gap-2">
              <Textarea
                className="min-h-[300px] flex-1 font-mono text-xs"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={doSaveEdit} disabled={busy}>
                  <Save className="h-4 w-4" /> Save version
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  <X className="h-4 w-4" /> Cancel
                </Button>
              </div>
            </div>
          ) : plan.currentPlan ? (
            <article className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown>{plan.currentPlan.markdown}</ReactMarkdown>
            </article>
          ) : (
            <p className="text-sm text-muted-foreground">No plan yet.</p>
          )}
        </CardContent>
      </Card>

      {plan.currentPlan && !editing && (
        <div className="space-y-2">
          <Textarea
            placeholder="Not quite right? Describe how the plan should change, then Regenerate…"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" onClick={doRegenerate} disabled={busy || !feedback.trim() || isPlanning}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Regenerate with feedback
            </Button>
            <Button onClick={doExecute} disabled={busy || !canExecute}>
              <Rocket className="h-4 w-4" /> Approve &amp; execute
            </Button>
          </div>
          {plan.versions.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {plan.versions.length} versions · {plan.totalCost.aiu.toFixed(2)} AIU total
            </p>
          )}
        </div>
      )}
    </div>
  );
}
