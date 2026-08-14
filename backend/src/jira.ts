import { config, jiraConfigured } from "./config.js";
import { log } from "./logger.js";
import { adfToMarkdown } from "./adf-to-markdown.js";
import type { Issue, JiraProject } from "./types.js";

const jiraLog = log("jira");

function authHeader(): string {
  const basic = Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString("base64");
  return `Basic ${basic}`;
}

function ensureConfigured(): void {
  if (!jiraConfigured()) {
    throw new Error("JIRA is not configured (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)");
  }
}

async function jiraFetch<T>(pathname: string, init?: RequestInit): Promise<T> {
  ensureConfigured();
  const url = `${config.jira.baseUrl}${pathname}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`JIRA ${res.status} ${res.statusText} for ${pathname}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface JiraProjectSearch {
  values: { key: string; name: string }[];
}

/** List selectable JIRA projects (paginated; first 100). */
export async function listProjects(): Promise<JiraProject[]> {
  const data = await jiraFetch<JiraProjectSearch>(
    "/rest/api/3/project/search?maxResults=100&orderBy=name",
  );
  return data.values.map((p) => ({ key: p.key, name: p.name }));
}

interface JiraIssueFields {
  summary?: string;
  description?: unknown; // ADF document or null
  labels?: string[];
  status?: { name?: string; statusCategory?: { key?: string } };
  issuetype?: { name?: string };
}

interface JiraIssueRaw {
  key: string;
  fields?: JiraIssueFields;
}

interface JiraSearchResponse {
  issues?: JiraIssueRaw[];
}

function issueUrl(key: string): string {
  return `${config.jira.baseUrl}/browse/${key}`;
}

function mapIssue(raw: JiraIssueRaw): Issue {
  const f = raw.fields ?? {};
  const body = adfToMarkdown(f.description);
  return {
    source: "jira",
    key: raw.key,
    number: null,
    title: f.summary ?? raw.key,
    body: body || null,
    state: f.status?.statusCategory?.key ?? "",
    url: issueUrl(raw.key),
    labels: f.labels ?? [],
    issueType: f.issuetype?.name ?? null,
    status: f.status?.name ?? null,
  };
}

const ISSUE_FIELDS = "summary,description,status,issuetype,labels";

function buildJql(projectKey: string): string {
  const suffix = config.jira.jql.trim();
  const base = `project = "${projectKey}"`;
  return suffix ? `${base} AND ${suffix}` : `${base} ORDER BY updated DESC`;
}

/**
 * Search issues for a project via JQL. Uses the current `/search/jql` endpoint
 * and falls back to the legacy `/search` endpoint for older sites.
 */
export async function listIssues(projectKey: string): Promise<Issue[]> {
  const jql = buildJql(projectKey);
  const params = new URLSearchParams({ jql, fields: ISSUE_FIELDS, maxResults: "50" });
  try {
    const data = await jiraFetch<JiraSearchResponse>(`/rest/api/3/search/jql?${params.toString()}`);
    return (data.issues ?? []).map(mapIssue);
  } catch (err) {
    jiraLog.warn({ err }, "/search/jql failed; falling back to legacy /search");
    const data = await jiraFetch<JiraSearchResponse>(`/rest/api/3/search?${params.toString()}`);
    return (data.issues ?? []).map(mapIssue);
  }
}

/** Fetch a single JIRA issue by key. */
export async function getIssue(key: string): Promise<Issue> {
  const raw = await jiraFetch<JiraIssueRaw>(
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
  );
  return mapIssue(raw);
}
