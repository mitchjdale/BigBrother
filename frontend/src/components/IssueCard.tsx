import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./StatusBadge";
import type { Issue, PlanStatus } from "@/api/client";
import { Loader2, Coins, X } from "lucide-react";

interface Props {
  issue: Issue;
  status?: PlanStatus;
  estimatedUsd?: number;
  selected: boolean;
  busy: boolean;
  hasPlan: boolean;
  onCreatePlan: () => void;
  onClearPlan: () => void;
  onSelect: () => void;
}

function fmtUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function IssueCard({
  issue,
  status,
  estimatedUsd,
  selected,
  busy,
  hasPlan,
  onCreatePlan,
  onClearPlan,
  onSelect,
}: Props) {
  const isClosed = issue.state === "closed";

  return (
    <Card
      className={selected ? "ring-2 ring-ring cursor-pointer" : "cursor-pointer hover:bg-accent/40"}
      onClick={onSelect}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm">
            <span className="text-muted-foreground">#{issue.number}</span> {issue.title}
          </CardTitle>
          {estimatedUsd != null && estimatedUsd > 0 && (
            <Badge
              variant="secondary"
              className="shrink-0 gap-1 tabular-nums"
              title="Estimated cost for this ticket (planning + implementation)"
            >
              <Coins className="h-3 w-3" />
              {fmtUsd(estimatedUsd)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-2">
        <div className="flex flex-col items-start gap-2">
          <div className="flex flex-wrap gap-1">
            {issue.labels.map((l) => (
              <Badge key={l} variant="outline" className="text-[10px]">
                {l}
              </Badge>
            ))}
          </div>
          {status && <StatusBadge status={status} />}
          {isClosed && (
            <Badge variant="secondary" className="text-[10px]">
              Closed
            </Badge>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          {estimatedUsd != null && estimatedUsd > 0 && (
            <span
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground tabular-nums"
              title="Estimated cost for this ticket (planning + implementation)"
            >
              <Coins className="h-3.5 w-3.5" />
              {fmtUsd(estimatedUsd)} est.
            </span>
          )}
          {hasPlan ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || status === "planning" || status === "executing"}
              onClick={(e) => {
                e.stopPropagation();
                onClearPlan();
              }}
            >
              <X className="h-4 w-4" />
              Clear plan
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy || status === "planning" || isClosed}
              onClick={(e) => {
                e.stopPropagation();
                onCreatePlan();
              }}
            >
              {(busy || status === "planning") && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {isClosed ? "Issue closed" : "Create plan"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
