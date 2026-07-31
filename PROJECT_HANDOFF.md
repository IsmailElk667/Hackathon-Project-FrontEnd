# Hive Pulse — Live Delivery Dashboard · Project Handoff

_Last updated: 2026-07-27_

## 1. What this is
**Hive Pulse** is an internal, live engineering-delivery dashboard for Hive's PM/leadership.
It shows, per team, a sprint-flow bar, flow metrics (Cycle time / WIP / Throughput / Blockers),
and a sprint burn-up chart, plus a click-through detail overlay. Data is pulled live from Jira.

It is a **two-repo system**, both deployed on **Vercel (git-connected: push to `master` → production)**.

| | Frontend | Backend |
|---|---|---|
| Repo (local) | `C:\Users\IsmailElKtiri\Desktop\hive-pulse-scroll` | `C:\Users\IsmailElKtiri\Desktop\hive-pulse-server` |
| GitHub | `IsmailElk667/Hackathon-Project-FrontEnd` | `IsmailElk667/Hackathon-Project-BackEnd` |
| Vercel project | `hive-pulse-scroll` | `hive-pulse-server` |
| Prod URL | https://hive-pulse-scroll.vercel.app | https://hive-pulse-server.vercel.app |
| Stack | Vanilla JS + Vite (no framework) | Node + Express + SSE |
| Prod `master` @ handoff | `907e5f2` | `8544f7b` |

> Note: the frontend repo `package.json` still self-describes as a "Scroll-driven 3D WebGL
> experience" — that's **stale metadata**. The 3D scroll landing (`main.js`/`style.css`) is
> stashed; `index.html` boots straight into the dashboard via `/dashboard.js`.

## 2. How it fits together (data flow)
```
Jira (hivefinancial.atlassian.net)
   │  REST v3 + Agile changelog   (DATA_SOURCE=jira + JIRA_* creds)
   ▼
hive-pulse-server  ── builds a "snapshot" JSON ──►  GET /api/snapshot  (+ SSE /api/stream)
   │  (mock/seed fallback if Jira unavailable)              ▲
   │                                                        │ VITE_API_URL (baked at build)
   ▼                                                        │
data/seed.json (cold-boot cache)                    hive-pulse-scroll (dashboard.js)
                                                     password gate → /api/login → bearer token
```
- Frontend `API` base = `VITE_API_URL` (set in Vercel) → `https://hive-pulse-server.vercel.app`.
  Falls back to `http://localhost:8787` for local dev. `window.HIVE_PULSE_API` overrides at runtime.
- The dashboard is **password-gated**: `/api/snapshot` returns 401 until the user logs in via
  `/api/login` (shared `ACCESS_PASSWORD`), which returns a bearer token used on subsequent calls.

## 3. Backend architecture (`hive-pulse-server`)
Key files under `src/`:
- `config.js` — env → effective config. `dataSource` = `jira` only if `DATA_SOURCE=jira` **and**
  all of `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` are set; else silently `mock`.
- `server.js` — Express routes + SSE + auth guard. Notable:
  - `/api/health` (public) — `{ok, source, generatedAt, lastIngestAt, hash, mongo, authRequired}`.
  - `/api/snapshot`, `/api/stream`, `/api/team/:id` (auth), `/api/login`, `/api/ingest`.
  - **`ensureFresh()` (refresh-on-read)** — re-ingests when the cached snapshot is older than
    `SNAPSHOT_TTL_SEC` (default 120s). This is what keeps serverless fresh (the node-cron poller
    does not run between requests on Vercel).
- `jira/client.js` — axios client (basic auth), `searchAll` (JQL), `resolveCustomFields`,
  `getStatusCategoryMap`, `fetchChangelog`.
- `jira/fetchIssues.js` — the ingest. `buildTeam` (sprint-scopes WIP/throughput/blockers to the
  active sprint), `computeFlowCycle` (fallback cycle time), `buildBurnup` (sprint issue-count
  history), `attachSprintCycleTime` (Actionable-Agile-style cycle time from changelog),
  `buildEpics`, `getJiraIngest`.
- `score/buildSnapshot.js` — assembles the snapshot; adds `burnup` + `flowCycle` per team with
  `synthBurnup`/`deriveFlowCycle` fallbacks (used by mock/local).
- `score/weights.js` — `STATUS_ALIASES` (Jira status → canonical lifecycle index).
- `ingest/mockSource.js` + `data/seed.json` — demo/cold-boot data.

**Snapshot shape (per team, relevant fields):** `id, name, board, shipped, inFlight, stalled,
blockers[], inFlightTickets[], activeSprint{id,name,startDate,endDate}, burnup{start,end,
points:[{t,scope,done}]}, flowCycle{avg,median,max,sampleSize,basis}`. Top-level: `source,
generatedAt, hash, teams[], sprint, infraBlockers[], initiatives[], leadership, ceremonies`.

## 4. Frontend architecture (`hive-pulse-scroll`)
- `index.html` → `/dashboard.js` (module). `dashboard.css` = all styling.
- `dashboard.js` render path: `render()` mounts `header(snap) + teamBody(snap)` (Team View only).
  Per team: `teamCard()` → `stageBar()` (STAGE_BAR sprint-flow) + flow-metric tiles + `burnUp()`.
  Detail overlay: `openDetail()` → `detailPanel()` → `cyclePanel()`.
  Data plumbing: `load()` (GET snapshot), `connectSSE()` (live), 30s poll fallback, `boot()`,
  login gate (`showLogin`/`doLogin`).
- **Dead code** (defined, never mounted): `metricsRow`, `leadershipRollup`, `sprintHealth`,
  `businessBridge`, `cycleTimeCard`, `roiCard`, `lifecycleCard`, `leadershipBody`, `sprintBody`.
- **Client-side fallbacks** so the UI never breaks if the backend lacks new fields:
  `synthBurnupClient()` (burn-up) and `cycleStats()` (cycle time from in-flight ages).

## 5. What changed this engagement (all live in prod)
Driven by PM feedback, in order:
1. **Removed the Live Feed ticker** (JS + CSS + mount).
2. **Removed the "· ends <date>"** sprint-name suffix (`sprintLabel`).
3. **Removed the hand-off queue chips** ("in review" first, then the whole QA done / ready row).
4. **Team-card restructure**: removed the board sub-label (e.g. "LO Board · HCM"); metric row is
   now **Cycle time · WIP · Throughput · Blockers**; removed the separate bottom cycle-time strip.
5. **Burn-up rebuilt** to Jira-style **issue-count vs. time, current sprint only (no backlog)**,
   then restyled to the original look (orange Work-scope line, green Completed line + end-dot +
   "done/scope" callout, dashed Guideline, Today marker).
6. **Bug fix**: burn-up `scope` was double-counting `stalled` (a subset of `inFlight`); now
   `scope = done + inFlight`.
7. **Backend**: refresh-on-read freshness; **status-mapping fix** (`Merged to Release` /
   `Waiting On Release` now map to the deploy stage instead of Ready-for-Analysis);
   **sprint-scoped** WIP/Throughput/Blockers; real burn-up series from sprint issue history.
8. **Cycle time from Jira** (Actionable-Agile method): first in-progress transition → completion,
   inclusive days, **sprint median**, labeled **"Cycle time (this sprint)"**.
9. **Merged Deploy + Done** into a single "Done" segment in the sprint-flow bar.
10. Captured the pre-existing (uncommitted) **auth gate** into version control.

## 6. Run / deploy / verify
**Local dev:**
```bash
# backend (serves seed/mock without creds; :8787)
cd hive-pulse-server && npm install && npm start
# frontend (Vite; :5177 by default)
cd hive-pulse-scroll && npm install && npm run dev
```
**Deploy = git push to `master`** (Vercel auto-builds both). There is **no Vercel CLI/token** in
this environment — deploys are done via git push. Verify:
- Frontend: check the served bundle at `https://hive-pulse-scroll.vercel.app` changed.
- Backend: `curl https://hive-pulse-server.vercel.app/api/health` → `source:"jira"`, recent
  `generatedAt`.

## 7. Environment variables (backend Vercel project)
`DATA_SOURCE=jira`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_BOARDS`
(default `LO,PAY,UL,ANA,INFRA`), `ACCESS_PASSWORD` (dashboard gate), `SESSION_SECRET`,
`SESSION_TTL_DAYS`, `SNAPSHOT_TTL_SEC` (default 120), `MONGO_URI` (optional),
`ACH_SUCCESS_RATE`, `SPRINT_NUMBER/WEEK/LENGTH_DAYS/ELAPSED_DAYS`.
Frontend Vercel project: `VITE_API_URL=https://hive-pulse-server.vercel.app`.
Jira: cloudId `af587a58-346d-4edf-9336-eb78d577a08c`; teams `infra, lo, pay, uw (board UL),
analytics (board AK)`.

## 8. Open items / follow-ups
- **Verbiage meeting** (PM): align dashboard status labels with team vocabulary. Per-team
  **commitment/completion points** (In Dev for PAY/UL/AK; Analysis Done for LendingOps; completion
  = Merged to Release / Ready to Deploy) are only partially implemented — deferred pending this.
- **Cycle-time parity with Actionable Agile**: the backend *replicates* AA's method from the
  changelog (AA's own numbers/config aren't API-exposed). **Verify on the live dashboard vs. AA**;
  if off, adjust the start-status detection in `attachSprintCycleTime` (one line). The Jira paths
  were **not run locally** (no creds in the dev env) — validated by logic + a changelog sample.
- **Mongo not connected** in prod (`mongo.connected:false`) — running on seed + in-memory + live
  ingest. Set `MONGO_URI` if a persistence/history layer is wanted.
- **Exact Greenhopper sprint-report parse** for the burn-up (to reflect mid-sprint scope
  *removals*) — optional; needs a sample response from the Jira sprint-report endpoint.

## 9. Gotchas / history
- **Serverless freshness**: no long-lived process on Vercel → the cron poller never fires between
  requests. `ensureFresh()` (refresh-on-read) is the mechanism; don't rely on fire-and-forget
  background work after a response (the function freezes).
- **Two deploy paths existed**: both repos are git-connected to Vercel, but the backend had also
  been deployed via the Vercel CLI at least once. A **stray session** (during this engagement)
  overwrote the local frontend files and CLI-deployed its own version to prod; it was restored
  from git (`origin/master` was untouched) + an empty commit to force a rebuild. A backup of that
  session's files is in the scratchpad (`othersession-backup/`).
- **Frontend work happens on the worktree branch** `claude/sprint-status-cleanup-8f0d87`; commits
  are cherry-picked onto `master` to deploy (branch and master diverged after an empty
  redeploy commit). Backend work is on `fix/status-mapping-merged-to-release` (pushed to master).
- Git shows harmless `LF will be replaced by CRLF` warnings (Windows).
- The checked-in `dist/` can lag source; Vercel rebuilds on push, so it doesn't matter for prod.

## 10. Quick pointers (where to change things)
- Sprint-flow stages/colors → `STAGE_BAR` in `dashboard.js`.
- Flow-metric tiles/labels → `teamCard()` `stats` array in `dashboard.js`.
- Burn-up rendering → `burnUp()` (frontend) / `buildBurnup()` (backend).
- Cycle-time definition → `attachSprintCycleTime()` (backend) + `cyHead()`/`cycleStats()` (frontend).
- Status → stage mapping → `STATUS_ALIASES` (`weights.js`) and `STAGE_BAR` regex (frontend).
