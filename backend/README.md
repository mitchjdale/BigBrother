# BigBrother — Backend

Node/TypeScript API + async workers behind the ticket-planning dashboard. It generates
**read-only implementation plans** for GitHub issues via the Copilot CLI (capturing exact
token/AI-Unit cost), lets developers iterate on them, and — on approval — hands the plan
to the Copilot cloud agent to open a **draft PR**.

Default target repo: `mitchjdale/WealthOlympics` (configurable in `.env`).

## How it works

```
POST /issues/:n/plan ──▶ queue (concurrent) ──▶ plan worker:
    1. git clone --depth 1 <repo>  (unique temp dir)
    2. copilot -p "<plan prompt>" --allow-all-tools --deny-tool write ...   (READ ONLY)
    3. capture stdout markdown  +  session cost from ~/.copilot/session-store.db
    4. save plan_version (+ input/output tokens, nano_aiu)  ──▶ status = ready
GET /plans/:id ──▶ status + plan markdown + per-version & total cost + PR

POST /plans/:id/execute ──▶ execute worker:
    gh agent-task create -F <approved plan>  ──▶ draft PR  ──▶ status = pr_open
```

Planning is **read-only**: the `write`, `git commit`, `git push`, `rm`, `mv` tools are
denied, so the agent physically cannot modify the repo — it only produces a plan.

Cost is captured by matching the CLI session on its `cwd` (the unique clone dir) in the
Copilot local session store, then summing `assistant_usage_events` (input/output tokens,
`total_nano_aiu`). 1 AIU = 1e9 nano_aiu; set `USD_PER_AIU` for a dollar figure.

## Setup

```bash
cp .env.example .env      # GH_TOKEN falls back to `gh auth token` if left blank
npm install
npm run dev               # or: npm run build && npm start
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/health` | sanity + token check |
| GET  | `/repos/issues` | list open issues (M1) |
| GET  | `/plans` | latest plan per issue (dashboard hydration after reload) |
| GET  | `/issues/:number/plan` | latest persisted plan for an issue (404 if none) |
| POST | `/issues/:number/plan` | enqueue a plan → `{ planId }` (202) |
| GET  | `/plans/:id` | status + plan markdown + cost + PR |
| POST | `/plans/:id/regenerate` | `{ feedback }` → revised plan (M3) |
| PATCH | `/plans/:id/version` | `{ markdown }` → developer-edited version (M3) |
| POST | `/plans/:id/execute` | approve → Copilot cloud agent → draft PR (M4) |
| POST | `/plans/:id/refresh-execution` | re-poll agent task for the draft PR / state (M4) |

## Not in this milestone
- Playwright screenshot on the PR — **M5**
- Swap p-queue → BullMQ + Redis, and SQLite → Postgres for production durability.
- Webhook listener (`pull_request`) to auto-update PR state instead of manual refresh.

## Project structure

```
src/
  config.ts    env loading; resolves GH_TOKEN (falls back to `gh auth token`)
  db.ts        better-sqlite3 schema init (plans / plan_versions / jobs / prs)
  github.ts    Octokit — list & get issues
  queue.ts     p-queue — enqueue on click, run plans concurrently
  copilot.ts   clone repo + run read-only Copilot CLI plan; capture markdown + cost
  usage.ts     cost adapter — sum a session's tokens/AIU from ~/.copilot/session-store.db
  planner.ts   plan job orchestration, versions, edit, plan view (status + cost + PR)
  execute.ts   execute queue — gh agent-task, output parser, PR refresh
  server.ts    Express routes
  types.ts     shared types
```

## Data model (SQLite)

| Table | Purpose |
|---|---|
| `plans` | one row per issue plan: `status` (idle/planning/ready/executing/pr_open/failed), `current_version_id`, `error` |
| `plan_versions` | each plan revision: `markdown`, `source` (generated/regenerated/user_edited), `feedback_prompt`, `input_tokens`, `output_tokens`, `nano_aiu`, `model`, `duration_ms` |
| `jobs` | queued/running plan & execute jobs: `type`, `status`, `session_id`, `error` |
| `prs` | execution result: `session_ref`, `pr_number`, `url`, `branch`, `agent_state`, `screenshot_url` |

## Environment variables (`.env`)

| Var | Default | Purpose |
|---|---|---|
| `GH_TOKEN` | `gh auth token` | GitHub token (Copilot Business) for Octokit + clone + agent |
| `REPO_OWNER` / `REPO_NAME` / `REPO_BASE` | `mitchjdale` / `WealthOlympics` / `main` | target repo |
| `PORT` | `8787` | API port |
| `PLAN_CONCURRENCY` | `5` | how many plan/execute jobs run in parallel |
| `WORK_DIR` | `./.work` | per-job clone dir (unique subdir, deleted after) |
| `PLAN_MODEL` | *(auto)* | pin a Copilot model for planning |
| `COPILOT_SESSION_STORE` | `~/.copilot/session-store.db` | CLI usage store for cost capture |
| `USD_PER_AIU` | `0` | USD per AI Unit for a dollar figure (0 = report AIU/tokens only) |
| `SQLITE_PATH` | `./data/bigbrother.db` | app database file |

## Requirements
- Node ≥ 20, `git`, and the `copilot` + `gh` CLIs on PATH.
- A GitHub account with **Copilot Business** (token via `GH_TOKEN` or `gh auth`).
