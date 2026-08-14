import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Load backend/.env into process.env (Node >= 20.12 built-in; no dotenv needed).
try {
  process.loadEnvFile();
} catch {
  // no .env file present — rely on real env vars / gh auth fallback
}

function env(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolveGhToken(): string {
  const fromEnv = env("GH_TOKEN");
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export const config = {
  ghToken: resolveGhToken(),
  repo: {
    owner: env("REPO_OWNER", "mitchjdale"),
    name: env("REPO_NAME", "WealthOlympics"),
    base: env("REPO_BASE", "main"),
  },
  repoPrivate: env("REPO_PRIVATE", "false").toLowerCase() === "true",
  port: Number(env("PORT", "8787")),
  planConcurrency: Number(env("PLAN_CONCURRENCY", "5")),
  workDir: path.resolve(expandHome(env("WORK_DIR", "./.work"))),
  planModel: env("PLAN_MODEL"),
  executeModel: env("EXECUTE_MODEL"),
  copilotSessionStore: expandHome(env("COPILOT_SESSION_STORE", "~/.copilot/session-store.db")),
  usdPerAiu: Number(env("USD_PER_AIU", "0")),
  sqlitePath: path.resolve(expandHome(env("SQLITE_PATH", "./data/bigbrother.db"))),
  logLevel: env("LOG_LEVEL", "info"),
  jira: {
    baseUrl: env("JIRA_BASE_URL").replace(/\/+$/, ""),
    email: env("JIRA_EMAIL"),
    apiToken: env("JIRA_API_TOKEN"),
    // Optional JQL suffix appended to the per-project query (e.g. to hide Done).
    jql: env("JIRA_JQL", "statusCategory != Done ORDER BY updated DESC"),
  },
};

/** True when JIRA credentials are configured so the source can be offered. */
export function jiraConfigured(): boolean {
  return Boolean(config.jira.baseUrl && config.jira.email && config.jira.apiToken);
}

export type Config = typeof config;
