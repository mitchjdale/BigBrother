import { useCallback, useEffect, useState } from "react";
import {
  api,
  type IssueSource,
  type JiraProject,
  type JiraProjectMapping,
  type RepoRef,
} from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Plus, RefreshCw, Trash2, Link2 } from "lucide-react";

const selectClass =
  "h-9 rounded-md border bg-background px-2 text-sm text-foreground disabled:opacity-50";

interface Props {
  source: IssueSource;
  setSource: (source: IssueSource) => void;
}

export default function SettingsPage({ source, setSource }: Props) {
  const [jiraConfigured, setJiraConfigured] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [repos, setRepos] = useState<RepoRef[]>([]);
  const [mappings, setMappings] = useState<JiraProjectMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [projectKey, setProjectKey] = useState("");
  const [owner, setOwner] = useState("");
  const [repoName, setRepoName] = useState("");

  const ownerOptions = [...new Set(repos.map((r) => r.owner))];
  const reposForOwner = repos.filter((r) => r.owner === owner);
  const selectedRepo = repos.find((r) => r.owner === owner && r.name === repoName) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sources = await api.listSources();
      setJiraConfigured(sources.jira);
      if (sources.jira) {
        const [proj, repoPayload, maps] = await Promise.all([
          api.listJiraProjects().catch(() => [] as JiraProject[]),
          api.listRepos(),
          api.listMappings(),
        ]);
        setProjects(proj);
        setRepos(repoPayload.repos);
        setMappings(maps);
      }
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

  useEffect(() => {
    if (owner && !reposForOwner.some((r) => r.name === repoName)) {
      setRepoName(reposForOwner[0]?.name ?? "");
    }
  }, [owner, repoName, reposForOwner]);

  const addMapping = async () => {
    if (!projectKey || !selectedRepo) return;
    const project = projects.find((p) => p.key === projectKey);
    setSaving(true);
    try {
      const created = await api.createMapping({
        projectKey,
        projectName: project?.name ?? projectKey,
        repo: selectedRepo,
      });
      setMappings((prev) => [...prev.filter((m) => m.projectKey !== created.projectKey), created]);
      setProjectKey("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeMapping = async (id: number) => {
    try {
      await api.deleteMapping(id);
      setMappings((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold">Settings</h2>
          <p className="text-sm text-muted-foreground">
            Choose the issue source and, for JIRA, map projects to GitHub repositories.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </header>

      <div className="mx-auto w-full max-w-3xl space-y-4 overflow-auto p-6">
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Issue source</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <label className="grid max-w-xs gap-1 text-xs text-muted-foreground">
                  Pull issues from
                  <select
                    className={selectClass}
                    value={source}
                    onChange={(e) => setSource(e.target.value as IssueSource)}
                  >
                    <option value="github">GitHub Issues</option>
                    <option value="jira" disabled={!jiraConfigured}>
                      JIRA{jiraConfigured ? "" : " (not configured)"}
                    </option>
                  </select>
                </label>
                <p className="text-sm text-muted-foreground">
                  {source === "github"
                    ? "GitHub Issues selected — no further configuration needed. Choose the repository on the Dashboard."
                    : "JIRA selected — map each JIRA project to the GitHub repository that will be cloned for planning and receive the draft PR."}
                </p>
              </CardContent>
            </Card>

            {source === "jira" &&
              (jiraConfigured === false ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">JIRA is not configured</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm text-muted-foreground">
                    <p>
                      Set <code>JIRA_BASE_URL</code>, <code>JIRA_EMAIL</code> and{" "}
                      <code>JIRA_API_TOKEN</code> in <code>backend/.env</code> and restart the backend
                      to enable JIRA as an issue source.
                    </p>
                    <p>
                      Create an API token at{" "}
                      <a
                        className="text-primary hover:underline"
                        href="https://id.atlassian.com/manage-profile/security/api-tokens"
                        target="_blank"
                        rel="noreferrer"
                      >
                        id.atlassian.com
                      </a>
                      .
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Add a project → repository mapping</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1 text-xs text-muted-foreground">
                  JIRA project
                  <select
                    className={selectClass}
                    value={projectKey}
                    onChange={(e) => setProjectKey(e.target.value)}
                    disabled={projects.length === 0}
                  >
                    <option value="">Select a project…</option>
                    {projects.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.key} — {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Owner
                  <select
                    className={selectClass}
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    disabled={ownerOptions.length === 0}
                  >
                    <option value="">Select…</option>
                    {ownerOptions.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Repository
                  <select
                    className={selectClass}
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    disabled={reposForOwner.length === 0}
                  >
                    {reposForOwner.map((r) => (
                      <option key={`${r.owner}/${r.name}`} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button onClick={addMapping} disabled={saving || !projectKey || !selectedRepo}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add mapping
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Current mappings</CardTitle>
              </CardHeader>
              <CardContent>
                {mappings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No mappings yet. Add one above to plan JIRA issues.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {mappings.map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium">{m.projectKey}</span>
                          <span className="text-muted-foreground">{m.projectName}</span>
                          <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="font-mono text-xs">
                            {m.repoOwner}/{m.repoName}
                            <span className="text-muted-foreground"> ({m.repoBase})</span>
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeMapping(m.id)}
                          title="Delete mapping"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
                </>
              ))}
          </>
        )}
      </div>
    </div>
  );
}
