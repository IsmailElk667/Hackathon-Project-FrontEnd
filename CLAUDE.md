# CLAUDE.md — hive-pulse-scroll (frontend)

Guidance for anyone (human or Claude Code) editing this repo. For the full narrative,
env vars, and history, see [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md).

## What this repo is
The **frontend** of Hive Pulse — an internal live engineering-delivery dashboard. Plain
**vanilla JS + Vite, no framework**. It renders a JSON "snapshot" served by the sibling
backend repo **`hive-pulse-server`** (`../hive-pulse-server`).

- Prod: https://hive-pulse-scroll.vercel.app (Vercel project `hive-pulse-scroll`)
- GitHub: `IsmailElk667/Hackathon-Project-FrontEnd`
- Backend API it talks to: `VITE_API_URL` (prod = `https://hive-pulse-server.vercel.app`),
  local fallback `http://localhost:8787`.

> `package.json` still says "3D WebGL scroll experience" — **stale**. The 3D landing
> (`main.js`, `style.css`) is stashed; the app boots straight into the dashboard.

## Run / build / deploy
```bash
npm install
npm run dev        # Vite dev server (default :5177). Needs the backend on :8787 for data.
npm run build      # → dist/  (Vercel build command)
```
**Deploy = `git push origin master`.** Vercel is git-connected and auto-builds `master` to
production. There is no Vercel CLI/token here — do not try to deploy any other way.

## Files (only 3 matter)
- `index.html` — mounts `#dashboard` + `#detail-overlay`, loads `/dashboard.js`.
- `dashboard.js` — **all logic**: data fetching, rendering, interactions.
- `dashboard.css` — all styling (CSS variables + light/dark/"claude" themes).

## How `dashboard.js` works
- Entry: `reveal()` → `boot()` → `load()` (`GET {API}/api/snapshot`) → `render(snap)`.
  Live updates via `connectSSE()` (`/api/stream`), 30s polling fallback. Password gate:
  a 401 shows `showLogin()`; `doLogin()` posts to `/api/login` for a bearer token.
- `render()` mounts **only** `header(snap) + teamBody(snap)` (Team View is the only view).
- Per team: `teamCard()` → `stageBar()` (the sprint-flow bar) + flow-metric tiles + `burnUp()`.
  Click a card → `openDetail()` → `detailPanel()` → `cyclePanel()`.
- **Rendering style**: HTML is built with template strings; **always wrap dynamic text in
  `esc()`**. Charts (burn-up) are **hand-built inline SVG** — no chart library.
- **Dead code** (defined but never mounted — safe to ignore/delete): `metricsRow`,
  `leadershipRollup`, `sprintHealth`, `businessBridge`, `cycleTimeCard`, `roiCard`,
  `lifecycleCard`, `leadershipBody`, `sprintBody`.
- **Graceful fallbacks** (so the UI never blanks if the backend lacks a field):
  `synthBurnupClient()` synthesizes a burn-up from totals; `cycleStats()` falls back to
  in-flight ticket ages when `t.flowCycle` is absent. Keep these working.

## Snapshot fields this UI consumes (produced by the backend)
Per team: `id, name, board, shipped (Throughput), inFlight (WIP), stalled, blockers[],
inFlightTickets[], activeSprint{name,startDate,endDate}, burnup{start,end,points:[{t,scope,done}]},
flowCycle{avg,median,max,basis}`. Top-level: `source, generatedAt, hash, teams[]`.
If you change what the UI reads, the field must exist in the backend snapshot (or add a fallback).

## How to edit common things
| Want to change… | Edit |
|---|---|
| Sprint-flow stages / colors / status→stage regex | `STAGE_BAR` array in `dashboard.js` |
| The 4 flow-metric tiles (label / value / color / sublabel) | `stats` array in `teamCard()` |
| Burn-up chart look/behavior | `burnUp()` (+ `.bu-*` classes in `dashboard.css`) |
| Cycle-time metric | `teamCard()` stats + `cycleStats()`/`cyHead()`/`cyclePanel()` |
| Detail overlay | `detailPanel()`, `cyclePanel()` |
| Colors / theming | CSS variables at top of `dashboard.css`; theme blocks `body[data-theme=…]` |

## Gotchas
- **Verify visually.** Run `npm run dev` + the backend, open the dev URL, and check the DOM
  (charts are SVG; inspect `.team-card`, `.stage-bar`, `.burn-up`). Watch the console.
- Numbers must be white unless the color means something (blockers red). Don't reintroduce
  the colored cycle-time tiles.
- Deploy history quirk: work was done on the worktree branch
  `claude/sprint-status-cleanup-8f0d87` and **cherry-picked onto `master`** to deploy, so the
  branch and `master` diverge. For new work, prefer committing on `master` directly (main dir).
- The checked-in `dist/` may lag source — harmless; Vercel rebuilds on push.
- Harmless Windows `LF→CRLF` git warnings.

## The other repo
Almost every "the number is wrong / a status isn't populating / no live data" issue is in the
**backend** (`../hive-pulse-server`), not here. This repo only renders what the snapshot gives.
