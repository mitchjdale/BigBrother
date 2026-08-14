import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./StatusBadge";
import type { Issue, PlanStatus } from "@/api/client";
import { Loader2, Sparkles } from "lucide-react";

interface Props {
  issue: Issue;
  status?: PlanStatus;
  selected: boolean;
  busy: boolean;
  onCreatePlan: () => void;
  onSelect: () => void;
}

export function IssueCard({ issue, status, selected, busy, onCreatePlan, onSelect }: Props) {
  const ref = issue.source === "github" ? `#${issue.number}` : issue.key;
  return (
    <Card
      className={selected ? "ring-2 ring-ring cursor-pointer" : "cursor-pointer hover:bg-accent/40"}
      onClick={onSelect}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm">
            <span className="text-muted-foreground">{ref}</span> {issue.title}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-2">
        <div className="flex flex-col items-start gap-2">
          <div className="flex flex-wrap gap-1">
            {issue.issueType && (
              <Badge variant="secondary" className="text-[10px]">
                {issue.issueType}
              </Badge>
            )}
            {issue.status && issue.source === "jira" && (
              <Badge variant="outline" className="text-[10px]">
                {issue.status}
              </Badge>
            )}
            {issue.labels.map((l) => (
              <Badge key={l} variant="outline" className="text-[10px]">
                {l}
              </Badge>
            ))}
          </div>
          {status && <StatusBadge status={status} />}
        </div>
        <Button
          size="sm"
          disabled={busy || status === "planning"}
          onClick={(e) => {
            e.stopPropagation();
            onCreatePlan();
          }}
        >
          {busy || status === "planning" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          Create plan
        </Button>
      </CardContent>
    </Card>
  );
}
