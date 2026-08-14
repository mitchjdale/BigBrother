import { Badge } from "@/components/ui/badge";
import type { PlanStatus } from "@/api/client";

const MAP: Record<
  PlanStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "success" | "warning" | "outline" }
> = {
  idle: { label: "Idle", variant: "outline" },
  planning: { label: "Planning…", variant: "secondary" },
  ready: { label: "Plan ready", variant: "success" },
  executing: { label: "Executing…", variant: "secondary" },
  pr_open: { label: "PR open", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
};

export function StatusBadge({ status }: { status: PlanStatus }) {
  const s = MAP[status] ?? MAP.idle;
  const pulsing = status === "planning" || status === "executing";
  return (
    <Badge variant={s.variant} className={pulsing ? "animate-pulse" : undefined}>
      {s.label}
    </Badge>
  );
}
