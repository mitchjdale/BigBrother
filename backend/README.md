# BigBrother — Backend

Node/TypeScript API + async workers behind the ticket-planning dashboard. It generates
**read-only implementation plans** for issues (from **GitHub Issues** or **JIRA**) via the
Copilot CLI (capturing exact token/AI-Unit cost), lets developers iterate on them, and — on
approval — hands the plan to the Copilot cloud agent to open a **draft PR**.

Default target repo: `mitchjdale/WealthOlympics` (configurable in `.env`). The UI can
override this per run via owner/repository dropdowns.

## Issue sources (GitHub + JIRA)

Issues can be pulled from **GitHub Issues** or **JIRA** — the user chooses in the dashboard
"Source" selector. Planning always **clones a git repo** and execution always opens a
**GitHub PR**, so the code repository is always GitHub. JIRA is therefore only an *issue
source*: each JIRA **project is mapped to a GitHub repo** on the Settings page
(`jira_project_map` table), and that repo is used to clone + open the draft PR. JIRA
descriptions (ADF rich text) are converted to Markdown (`src/adf-to-markdown.ts`) for the
plan prompt and UI. Set `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` to enable it;
credentials stay server-side (never sent to the browser).

## How it works

```
POST /issues/:n/plan ──▶ queue (concurrent) ──▶ plan worker:
    1. git clone --depth 1 <repo>  (unique temp dir)
    2. copilot -p "<plan prompt>" --allow-all-tools --deny-tool write ...   (READ ONLY)
    3. capture stdout markdown  +  session cost from ~/.copilot/session-store.db
    4. save plan_version (+ input/output tokens, nano_aiu)  ──▶ status = ready
GET /plans/:id ──▶ status + plan markdown + per-version & total cost + PR

POST /plans/:id/execute ──▶ execute worker:
    gh agent-task create -F <approved plan>  ──▶ draft PR
    (best-effort request Copilot PR review)   ──▶ status = pr_open
```

Planning is **read-only**: the `write`, `git commit`, `git push`, `rm`, `mv` tools are
denied, so the agent physically cannot modify the repo — it only produces a plan.

Cost is captured by matching the CLI session on its `cwd` (the unique clone dir) in the
Copilot local session store, then summing `assistant_usage_events` (input/output tokens,
`total_nano_aiu`). 1 AIU = 1e9 nano_aiu; set `USD_PER_AIU` for a dollar figure.

Both phases are tracked separately (#18): planning cost comes from the local CLI session
above, while implementation cost is captured best-effort from the cloud agent-task session
(`captureUsageBySessionRef`, refreshed on `/plans/:id/refresh-execution`). The `/usage`
report and the dedicated usage page split every total, time bucket and per-repo row into
**planning** vs **implementation** so the two can be compared. Note: the implementation
phase runs on the Copilot cloud coding agent (`gh agent-task`); its usage only appears if
that session is recorded in the local session store, otherwise it reports as zero.

Cost is also translated to a rough **dollar estimate** (#19). `pricing.ts` holds an
approximate USD-per-1M-token price list keyed by model (overridable via `MODEL_PRICING`),
so `estimatedUsd = input×rate_in + output×rate_out` per attempt. Estimates are summed
(model-aware) into the plan view (`totalCost.estimatedUsd`), the `/usage` report, and a
per-issue total surfaced by `/plans` — the dashboard shows that as a small cost badge on
each ticket. These figures are deliberately rough ball-parks for comparison, not billing.

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
| GET  | `/sources` | which issue sources are available (`{ github, jira }`; JIRA true only if configured) |
| GET  | `/jira/projects` | list selectable JIRA projects (for the Settings mapping form) |
| GET  | `/mappings` | list JIRA project → GitHub repo mappings |
| POST | `/mappings` | create/replace a mapping (`{ projectKey, projectName, repoOwner, repoName, repoBase }`) |
| DELETE | `/mappings/:id` | delete a mapping |
| GET  | `/repos/issues` | list issues for the selected source (`?source=github&repo…&state=open\|closed` or `?source=jira&project=KEY`); closed returns only GitHub issues with plan records in this DB (M1) |
| GET  | `/plans` | latest plan per issue + per-issue `estimatedUsd` for the ticket cost badge (dashboard hydration) (#19) |
| GET  | `/issues/:source/:key/plan` | latest persisted plan for an issue (404 if none) |
| POST | `/issues/:source/:key/plan` | enqueue a plan (`{ model?, repo… \| project }`) → `{ planId }` (202). Reuses the issue's existing plan record so token usage accumulates (#11) |
| POST | `/plans/:id/retry` | re-run a failed/completed plan in-place (`{ model?: string\|null }`), retaining prior token usage (#11) |
| GET  | `/plans/:id` | status + plan markdown + cost + PR |
| POST | `/plans/:id/regenerate` | `{ feedback, model?: string\|null }` → revised plan (M3) |
| PATCH | `/plans/:id/version` | `{ markdown }` → developer-edited version (M3) |
| POST | `/plans/:id/execute` | approve (`{ model?: string|null }`) → Copilot cloud agent → draft PR (M4) |
| POST | `/plans/:id/refresh-execution` | re-poll agent task for the draft PR / state; also re-captures implementation token usage (M4, #18) |
| POST | `/plans/:id/review` | request (or re-request) Copilot code review on the latest draft PR for this plan |
| GET  | `/usage` | aggregated planning + implementation token/AIU usage split by phase, with time series + per-repo breakdown (optional `repoOwner`/`repoName`/`from`/`to`/`granularity`) (#18) |

`/plans/:id/review` (and the automatic review request during execute/refresh) is best-effort: it requires
repo permission to request PR reviewers plus Copilot code review enabled for the repo/org.

## Not in this milestone
- Playwright screenshot on the PR — **M5**
- Swap p-queue → BullMQ + Redis, and SQLite → Postgres for production durability.
- Webhook listener (`pull_request`) to auto-update PR state instead of manual refresh.

## Project structure

```
src/
  config.ts    env loading; resolves GH_TOKEN (falls back to `gh auth token`)
  logger.ts    pino structured logger (JSON in prod, pretty in dev) + child loggers
  auth.ts      per-tool credential routing (token-kind detection, clone URL, subprocess env)
  db.ts        better-sqlite3 schema init (plans / plan_versions / jobs / prs / jira_project_map)
  github.ts    Octokit — list & get issues
  jira.ts      JIRA Cloud REST v3 — list projects, search + get issues (Basic auth)
  adf-to-markdown.ts  convert JIRA ADF rich-text descriptions to Markdown
  mapping.ts   JIRA project → GitHub repo mappings (CRUD + resolve)
  issues.ts    provider-agnostic issue dispatcher (GitHub | JIRA) + repo resolution
  queue.ts     p-queue — enqueue on click, run plans concurrently
  copilot.ts   clone repo + run read-only Copilot CLI plan; capture markdown + cost
  usage.ts     cost adapter — sum a session's tokens/AIU from ~/.copilot/session-store.db
               (by cwd for planning, by session ref for implementation #18)
  pricing.ts   rough per-model USD price list + token→dollar estimate helpers (#19)
  planner.ts   plan job orchestration, versions, edit, plan view (status + cost + PR)
  execute.ts   execute queue — gh agent-task, output parser, PR refresh
  server.ts    Express routes
  types.ts     shared types
```

## Data model (SQLite)

| Table | Purpose |
|---|---|
| `plans` | one row per issue plan: `issue_source` (github/jira), `issue_key` (stable id: GH number or JIRA key), `issue_number` (GH only), `status` (idle/planning/ready/executing/pr_open/failed), `current_version_id`, `error` |
| `plan_versions` | each plan revision: `markdown`, `source` (generated/regenerated/user_edited), `feedback_prompt`, `input_tokens`, `output_tokens`, `nano_aiu`, `model`, `duration_ms` |
| `jobs` | queued/running plan & execute jobs: `type`, `status`, `session_id`, `error`, plus per-attempt cost (`input_tokens`, `output_tokens`, `nano_aiu`, `model`, `duration_ms`). Cumulative plan cost is summed from these so failed/superseded attempts are retained (#11) |
| `prs` | execution result: `session_ref`, `pr_number`, `url`, `branch`, `agent_state`, review status/error (`review_state`, `review_error`), `screenshot_url` |
| `jira_project_map` | JIRA project → GitHub repo mapping (`project_key`, `project_name`, `repo_owner`, `repo_name`, `repo_base`) used to clone + open the PR for JIRA-sourced plans |

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
| `COPILOT_REVIEW` | `true` | when `true`, automatically request `copilot-pull-request-reviewer[bot]` on newly discovered draft PRs (best-effort) |
| `COPILOT_SESSION_STORE` | `~/.copilot/session-store.db` | CLI usage store for cost capture |
| `USD_PER_AIU` | `0` | USD per AI Unit for a dollar figure (0 = report AIU/tokens only) |
| `MODEL_PRICING` | *(built-in)* | JSON overriding the rough per-model USD/1M-token rates used for cost estimates (#19) |
| `SQLITE_PATH` | `./data/bigbrother.db` | app database file |
| `JIRA_BASE_URL` | *(empty)* | JIRA Cloud site, e.g. `https://your-domain.atlassian.net`. Enables the JIRA source when set with email + token |
| `JIRA_EMAIL` | *(empty)* | Atlassian account email for JIRA Basic auth |
| `JIRA_API_TOKEN` | *(empty)* | JIRA API token (create at id.atlassian.com). Server-side secret |
| `JIRA_JQL` | `statusCategory != Done ORDER BY updated DESC` | JQL suffix appended per project when listing issues |
| `LOG_LEVEL` | `info` | pino level: `trace`/`debug`/`info`/`warn`/`error`/`fatal`/`silent` |
| `LOG_PRETTY` | *(auto)* | `false` forces JSON logs in dev; JSON is always used when `NODE_ENV=production` |

## Logging

Structured logging uses [**pino**](https://getpino.io) (`src/logger.ts`) with
[`pino-http`](https://github.com/pinojs/pino-http) for per-request logs.

- **Development:** human-readable, colourised output (`pino-pretty`).
- **Production (`NODE_ENV=production`):** newline-delimited **JSON** on stdout, ready to
  ship to Datadog, Grafana Loki, ELK/OpenSearch, CloudWatch, etc. — no code changes needed.
- Every HTTP request is logged with method, url, status and latency (`/health` is muted);
  4xx → `warn`, 5xx/errors → `error`.
- Domain events carry structured context via child loggers (`module`, `jobId`, `planId`,
  `issueNumber`, `repo`): plan/execute jobs log queued → started → succeeded/**failed**,
  and all exceptions are logged with the full error. Secrets (tokens, auth headers) are
  redacted.
- Tune verbosity with `LOG_LEVEL` (e.g. `LOG_LEVEL=debug` to see clone / CLI-invocation logs).

## Requirements
- Node ≥ 20, `git`, and the `copilot` + `gh` CLIs on PATH.
- A GitHub account with **Copilot Business**.
- `gh auth login` via **web browser (OAuth)** — required for plan execution (`gh agent-task`).
- `copilot /login` — authenticates the Copilot CLI for planning.
