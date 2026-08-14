import type { Cost } from "@/api/client";
import { Coins, Hash, Clock } from "lucide-react";

interface Props {
  total: {
    aiu: number;
    usd: number | null;
    inputTokens: number;
    outputTokens: number;
    versions: number;
    attempts?: number;
    failedAttempts?: number;
  };
  current?: Cost;
}

export function CostBar({ total, current }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
      <span className="inline-flex items-center gap-1 font-medium">
        <Coins className="h-3.5 w-3.5" />
        {total.aiu.toFixed(2)} AIU
        {total.usd != null && <span className="text-muted-foreground">(${total.usd.toFixed(3)})</span>}
      </span>
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Hash className="h-3.5 w-3.5" />
        {total.inputTokens.toLocaleString()} in / {total.outputTokens.toLocaleString()} out
      </span>
      {current?.model && (
        <span className="inline-flex items-center gap-1 text-muted-foreground">{current.model}</span>
      )}
      {current?.durationMs != null && current.durationMs > 0 && (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          {(current.durationMs / 1000).toFixed(1)}s
        </span>
      )}
      <span className="ml-auto text-muted-foreground">
        {total.attempts != null && total.attempts !== total.versions
          ? `${total.attempts} attempt(s) · ${total.versions} version(s)`
          : `${total.versions} version(s)`}
        {total.failedAttempts ? ` · ${total.failedAttempts} failed` : ""}
      </span>
    </div>
  );
}
