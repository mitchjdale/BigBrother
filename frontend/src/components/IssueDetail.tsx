import ReactMarkdown from "react-markdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Issue } from "@/api/client";
import { ExternalLink } from "lucide-react";

interface Props {
  issue: Issue;
}

export function IssueDetail({ issue }: Props) {
  const body = issue.body?.trim();
  return (
    <Card className="shrink-0">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base leading-snug">
            <span className="text-muted-foreground">#{issue.number}</span> {issue.title}
          </CardTitle>
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium text-primary hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" /> View on GitHub
          </a>
        </div>
        {(issue.labels.length > 0 || issue.state) && (
          <div className="flex flex-wrap items-center gap-1">
            {issue.state && (
              <Badge variant="secondary" className="text-[10px] capitalize">
                {issue.state}
              </Badge>
            )}
            {issue.labels.map((l) => (
              <Badge key={l} variant="outline" className="text-[10px]">
                {l}
              </Badge>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="max-h-[38vh] overflow-auto">
        {body ? (
          <article className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown>{body}</ReactMarkdown>
          </article>
        ) : (
          <p className="text-sm italic text-muted-foreground">No description provided.</p>
        )}
      </CardContent>
    </Card>
  );
}
