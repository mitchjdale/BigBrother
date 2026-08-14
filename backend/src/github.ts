import { Octokit } from "@octokit/rest";
import { config } from "./config.js";
import type { Issue, RepoRef } from "./types.js";

const octokit = new Octokit({ auth: config.ghToken || undefined });

function normalizeRepo(repo?: Partial<RepoRef>): RepoRef {
  return {
    owner: repo?.owner ?? config.repo.owner,
    name: repo?.name ?? config.repo.name,
    base: repo?.base ?? config.repo.base,
  };
}

export async function listIssues(repo?: Partial<RepoRef>): Promise<Issue[]> {
  const target = normalizeRepo(repo);
  const res = await octokit.issues.listForRepo({
    owner: target.owner,
    repo: target.name,
    state: "all",
    per_page: 50,
  });
  return res.data
    .filter((i) => !i.pull_request) // exclude PRs (the issues API returns both)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? null,
      state: i.state,
      state_reason: i.state_reason ?? null,
      url: i.html_url,
      labels: i.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
    }));
}

export async function listSelectableRepos(): Promise<RepoRef[]> {
  const defaultRepo = normalizeRepo();
  try {
    const res = await octokit.repos.listForAuthenticatedUser({
      affiliation: "owner,collaborator,organization_member",
      sort: "updated",
      per_page: 100,
    });

    const seen = new Set<string>();
    const repos: RepoRef[] = [];
    for (const repo of res.data) {
      if (!repo.owner?.login || !repo.name || !repo.default_branch) continue;
      const key = `${repo.owner.login}/${repo.name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push({ owner: repo.owner.login, name: repo.name, base: repo.default_branch });
    }

    if (!seen.has(`${defaultRepo.owner}/${defaultRepo.name}`.toLowerCase())) {
      repos.unshift(defaultRepo);
    }

    return repos;
  } catch {
    return [defaultRepo];
  }
}

export async function getIssue(number: number, repo?: Partial<RepoRef>): Promise<Issue> {
  const target = normalizeRepo(repo);
  const { data: i } = await octokit.issues.get({
    owner: target.owner,
    repo: target.name,
    issue_number: number,
  });
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? null,
    state: i.state,
    state_reason: i.state_reason ?? null,
    url: i.html_url,
    labels: i.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
  };
}

export async function isPullRequestMerged(
  prNumber: number,
  repo?: Partial<RepoRef>,
): Promise<boolean> {
  const target = normalizeRepo(repo);
  try {
    const { data } = await octokit.pulls.get({
      owner: target.owner,
      repo: target.name,
      pull_number: prNumber,
    });
    return !!data.merged;
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && err.status === 404) return false;
    throw err;
  }
}

export async function closeIssueAsCompleted(number: number, repo?: Partial<RepoRef>): Promise<void> {
  const target = normalizeRepo(repo);
  await octokit.issues.update({
    owner: target.owner,
    repo: target.name,
    issue_number: number,
    state: "closed",
    state_reason: "completed",
  });
}
