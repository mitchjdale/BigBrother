# BigBrother — Backend

Node/TypeScript API + async workers behind the ticket-planning dashboard. It generates
**read-only implementation plans** for GitHub issues via the Copilot CLI (capturing exact
token/AI-Unit cost), lets developers iterate on them, and — on approval — hands the plan
to the Copilot cloud agent to open a **draft PR**.

Default target repo: `mitchjdale/WealthOlympics` (configurable in `.env`). The UI can
override this per run via owner/repository dropdowns.

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
cp .env.example .env      # GH_TOKEN is optional; see Authentication below
npm install
npm run dev               # or: npm run build && npm start
```

## Authentication

BigBrother touches GitHub through three tools that each accept **different**
credential kinds, so it routes (or withholds) tokens per operation instead of
forcing a single `GH_TOKEN` everywhere (see `src/auth.ts`):

| Operation | Tool | Accepts | What BigBrother does |
|---|---|---|---|
| List/read issues | Octokit (REST) | any token | uses `GH_TOKEN` / `gh auth token` |
| Clone repo | `git clone` | none for public repos | anonymous clone unless `REPO_PRIVATE=true` |
| Generate plan | Copilot CLI | fine-grained PAT or OAuth (**not** classic `ghp_`) | passes token only if fine-grained/OAuth; otherwise strips it so the CLI uses `copilot /login` |
| Execute plan | `gh agent-task` | **OAuth only** | strips non-OAuth `GH_TOKEN` so gh uses your `gh auth login` (browser/OAuth) keyring |

Token kinds are detected by prefix: `ghp_` = classic PAT, `github_pat_` =
fine-grained PAT, `gho_`/`ghu_`/`ghs_` = OAuth.

**Recommended one-time setup for each developer:**

```bash
gh auth login        # choose "Login with a web browser" → yields an OAuth token (required for execute)
copilot /login       # authenticates the Copilot CLI for planning
```

With that, you can leave `GH_TOKEN` blank. Set `GH_TOKEN` only if you want a
specific token for the REST API (e.g. a classic PAT for higher rate limits) —
it will **not** break planning or execution, because non-OAuth/classic tokens
are stripped before those subprocesses run.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/health` | sanity + token check |
| GET  | `/repos` | list selectable repositories (owner/name/base) for the UI dropdowns |
| GET  | `/repos/issues` | list open issues for the selected repo (M1) |
| GET  | `/plans` | latest plan per issue (dashboard hydration after reload) |
| GET  | `/issues/:number/plan` | latest persisted plan for an issue (404 if none) |
| POST | `/issues/:number/plan` | enqueue a plan (`{ model?: string\|null }`) → `{ planId }` (202). Reuses the issue's existing plan record so token usage accumulates (#11) |
| POST | `/plans/:id/retry` | re-run a failed/completed plan in-place (`{ model?: string\|null }`), retaining prior token usage (#11) |
| GET  | `/plans/:id` | status + plan markdown + cost + PR |
| POST | `/plans/:id/regenerate` | `{ feedback, model?: string\|null }` → revised plan (M3) |
| PATCH | `/plans/:id/version` | `{ markdown }` → developer-edited version (M3) |
| POST | `/plans/:id/execute` | approve (`{ model?: string|null }`) → Copilot cloud agent → draft PR (M4) |
| POST | `/plans/:id/refresh-execution` | re-poll agent task for the draft PR / state (M4) |

## Not in this milestone
- Playwright screenshot on the PR — **M5**
- Swap p-queue → BullMQ + Redis, and SQLite → Postgres for production durability.
- Webhook listener (`pull_request`) to auto-update PR state instead of manual refresh.

## Project structure

```
src/
  config.ts    env loading; resolves GH_TOKEN (falls back to `gh auth token`)
  auth.ts      per-tool credential routing (token-kind detection, clone URL, subprocess env)
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
| `jobs` | queued/running plan & execute jobs: `type`, `status`, `session_id`, `error`, plus per-attempt cost (`input_tokens`, `output_tokens`, `nano_aiu`, `model`, `duration_ms`). Cumulative plan cost is summed from these so failed/superseded attempts are retained (#11) |
| `prs` | execution result: `session_ref`, `pr_number`, `url`, `branch`, `agent_state`, `screenshot_url` |

## Environment variables (`.env`)

| Var | Default | Purpose |
|---|---|---|
| `GH_TOKEN` | `gh auth token` | GitHub REST token (issues). Any kind works; non-OAuth tokens are stripped before Copilot planning/execute (see Authentication) |
| `REPO_OWNER` / `REPO_NAME` / `REPO_BASE` | `mitchjdale` / `WealthOlympics` / `main` | default repo used when a request does not pass a selected repo |
| `REPO_PRIVATE` | `false` | `true` embeds `GH_TOKEN` in the clone URL; public repos clone anonymously |
| `PORT` | `8787` | API port |
| `PLAN_CONCURRENCY` | `5` | how many plan/execute jobs run in parallel |
| `WORK_DIR` | `./.work` | per-job clone dir (unique subdir, deleted after) |
| `PLAN_MODEL` | *(auto)* | pin a Copilot model for planning |
| `EXECUTE_MODEL` | *(auto)* | pin a Copilot model for execution |
| `COPILOT_SESSION_STORE` | `~/.copilot/session-store.db` | CLI usage store for cost capture |
| `USD_PER_AIU` | `0` | USD per AI Unit for a dollar figure (0 = report AIU/tokens only) |
| `SQLITE_PATH` | `./data/bigbrother.db` | app database file |

## Requirements
- Node ≥ 20, `git`, and the `copilot` + `gh` CLIs on PATH.
- A GitHub account with **Copilot Business**.
- `gh auth login` via **web browser (OAuth)** — required for plan execution (`gh agent-task`).
- `copilot /login` — authenticates the Copilot CLI for planning.
