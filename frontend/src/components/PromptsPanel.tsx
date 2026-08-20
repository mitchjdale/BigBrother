import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Prompt, type PromptType, type PromptVersion } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, RotateCcw, Save } from "lucide-react";

const PLACEHOLDERS: Record<PromptType, string[]> = {
  plan: [
    "{{issue_ref}}",
    "{{issue_source}}",
    "{{issue_title}}",
    "{{issue_body}}",
    "{{feedback}}",
    "{{previous_plan}}",
  ],
  execute: ["{{plan_markdown}}"],
};

const LABELS: Record<PromptType, string> = {
  plan: "Planning prompt",
  execute: "Execution prompt",
};

export function PromptsPanel() {
  const [activeType, setActiveType] = useState<PromptType>("plan");
  const [prompts, setPrompts] = useState<Partial<Record<PromptType, Prompt>>>({});
  const [versions, setVersions] = useState<Partial<Record<PromptType, PromptVersion[]>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<PromptType, string>>>({});
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [planPrompt, executePrompt, planVersions, executeVersions] = await Promise.all([
        api.getPrompt("plan"),
        api.getPrompt("execute"),
        api.getPromptVersions("plan"),
        api.getPromptVersions("execute"),
      ]);
      setPrompts({ plan: planPrompt, execute: executePrompt });
      setVersions({ plan: planVersions, execute: executeVersions });
      setDrafts({ plan: planPrompt.template, execute: executePrompt.template });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const prompt = prompts[activeType];
  const draft = drafts[activeType] ?? "";
  const activeVersions = versions[activeType] ?? [];
  const changed = prompt ? draft !== prompt.template : false;
  const canSave = Boolean(prompt && draft.trim() && changed && !saving);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const updated = await api.updatePrompt(activeType, draft, reason.trim() || undefined);
      const updatedVersions = await api.getPromptVersions(activeType);
      setPrompts((prev) => ({ ...prev, [activeType]: updated }));
      setVersions((prev) => ({ ...prev, [activeType]: updatedVersions }));
      setReason("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm(`Reset the ${LABELS[activeType].toLowerCase()} to default?`)) return;
    setSaving(true);
    try {
      const updated = await api.resetPrompt(activeType);
      const updatedVersions = await api.getPromptVersions(activeType);
      setPrompts((prev) => ({ ...prev, [activeType]: updated }));
      setDrafts((prev) => ({ ...prev, [activeType]: updated.template }));
      setVersions((prev) => ({ ...prev, [activeType]: updatedVersions }));
      setReason("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const updatedAt = useMemo(() => {
    if (!prompt) return "";
    return new Date(prompt.updatedAt).toLocaleString();
  }, [prompt]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Prompts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}

        <div className="flex gap-2">
          <Button variant={activeType === "plan" ? "default" : "outline"} size="sm" onClick={() => setActiveType("plan")}>
            Planning
          </Button>
          <Button
            variant={activeType === "execute" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveType("execute")}
          >
            Execution
          </Button>
        </div>

        {loading || !prompt ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading prompt…
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {LABELS[activeType]} · last updated {updatedAt}
            </p>
            <Textarea
              className="min-h-[260px] font-mono text-xs"
              value={draft}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [activeType]: e.target.value }))}
            />
            <label className="grid gap-1 text-xs text-muted-foreground">
              Change reason (optional)
              <input
                className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={save} disabled={!canSave}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save prompt
              </Button>
              <Button size="sm" variant="outline" onClick={reset} disabled={saving}>
                <RotateCcw className="h-4 w-4" /> Reset to default
              </Button>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Required placeholders</p>
              <div className="flex flex-wrap gap-1">
                {PLACEHOLDERS[activeType].map((placeholder) => (
                  <code key={placeholder} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {placeholder}
                  </code>
                ))}
              </div>
            </div>
            {activeVersions.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Version history ({activeVersions.length})
                </summary>
                <ul className="mt-2 space-y-2 text-xs">
                  {activeVersions.slice(0, 10).map((v) => (
                    <li key={v.id} className="rounded border p-2">
                      <div className="font-medium">
                        v{v.versionNo} · {new Date(v.createdAt).toLocaleString()}
                      </div>
                      {v.changeReason && <div className="text-muted-foreground">{v.changeReason}</div>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
