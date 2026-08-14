# BigBrother — Frontend

Dashboard UI (React + Vite + Tailwind + shadcn-style components) for the AI ticket
planner. Lists a repo's GitHub issues, generates read-only implementation plans via the
backend, shows live status + token/AIU cost, and lets you edit / regenerate / approve.

## Run

```bash
# 1) start the backend first (../backend): npm run build && npm start   -> :8787
# 2) then:
npm install
npm run dev            # -> http://localhost:5173  (proxies /api -> :8787)
```

The dev server proxies `/api/*` to `http://localhost:8787` (see `vite.config.ts`).

## What it does
- Issues column: open issues for the configured repo; each card has Create plan and a
  live status badge (planning -> ready -> executing -> pr_open). Multiple tickets can
  plan concurrently.
- Header controls: choose planning and execution models independently, or leave either on
  **Copilot default (auto)** to let Copilot choose.
- Plan panel: polls status, renders plan markdown, shows a cost bar (AIU, tokens, model,
  duration), and supports:
  - Edit the plan inline -> saved as a new user_edited version.
  - Regenerate with feedback -> agent revises the plan (new version).
  - Approve & execute -> backend fires the Copilot cloud agent -> draft PR link.

## Structure
- src/api/client.ts - typed fetch client for the backend.
- src/components/ - IssueCard, PlanPanel, CostBar, StatusBadge, ui/* (shadcn primitives).
- src/App.tsx - two-column dashboard + concurrent plan trackers.

## Tech stack
- React 19 + Vite + TypeScript
- Tailwind CSS v3 + `tailwindcss-animate` + `@tailwindcss/typography`
- shadcn-style components (Radix + CVA) checked into `src/components/ui` — no shadcn CLI
- `react-markdown` for rendering plans, `lucide-react` icons

## Scripts
| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on :5173 (proxies `/api` → :8787) |
| `npm run build` | type-check (`tsc -b`) + production build |
| `npm run preview` | serve the production build locally |

## Backend connection
- All calls go to `/api/*` and are proxied to `http://localhost:8787` by `vite.config.ts`.
- To point at a different backend, edit the `server.proxy` target there (or serve the
  built assets behind the same origin as the API in production).

## Key components
- `App.tsx` — loads issues, tracks a plan per ticket, polls active plans concurrently.
- `PlanPanel.tsx` — polls one plan; renders markdown, cost bar, edit/regenerate/execute.
- `CostBar.tsx` — AIU, in/out tokens, model, duration, version count.
- `StatusBadge.tsx` — maps plan status → labelled badge (pulses while planning/executing).

## Notes
- Purely a client for the backend; no GitHub token lives in the browser.
- Components are local shadcn primitives (no shadcn CLI needed).
