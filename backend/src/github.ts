import { Octokit } from "@octokit/rest";
import { config } from "./config.js";
import type { Issue } from "./types.js";

const octokit = new Octokit({ auth: config.ghToken || undefined });

export async function listIssues(): Promise<Issue[]> {
  const res = await octokit.issues.listForRepo({
    owner: config.repo.owner,
    repo: config.repo.name,
    state: "open",
    per_page: 50,
  });
  return res.data
    .filter((i) => !i.pull_request) // exclude PRs (the issues API returns both)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? null,
      state: i.state,
      url: i.html_url,
      labels: i.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
    }));
}

export async function getIssue(number: number): Promise<Issue> {
  const { data: i } = await octokit.issues.get({
    owner: config.repo.owner,
    repo: config.repo.name,
    issue_number: number,
  });
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? null,
    state: i.state,
    url: i.html_url,
    labels: i.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
  };
}
