/* ═══════════════════════════════════════════════════════════════════════════
   HIVE PULSE · Live Dashboard (data layer + renderer)
   The destination of the "View Live Dashboard →" CTA. 100% bound to the
   backend: GET /api/snapshot on reveal, then live SSE /api/stream (30s fetch
   fallback). No hardcoded business data · every number comes from the scoring
   agents. The 3D scroll experience (main.js) is untouched.
═══════════════════════════════════════════════════════════════════════════ */

// VITE_API_URL is baked in at build time by Vite (set it in Vercel's project env vars).
// window.HIVE_PULSE_API overrides at runtime (useful for quick staging swaps).
const API = (window.HIVE_PULSE_API || import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/\/+$/, '')

// Jira base URL · window.HIVE_JIRA_BASE overrides at runtime for different tenants.
const JIRA_BASE = (window.HIVE_JIRA_BASE || 'https://hivefinancial.atlassian.net').replace(/\/+$/, '')
const jiraUrl  = (id) => `${JIRA_BASE}/browse/${String(id ?? '').replace(/[^A-Za-z0-9-]/g, '')}`
// Renders a ticket ID as a clickable Jira link, falling back to plain text if id is empty.
const jiraLink = (id, cls = '') =>
  id ? `<a href="${jiraUrl(id)}" target="_blank" rel="noopener noreferrer"${cls ? ` class="${esc(cls)}"` : ''}>${esc(id)}</a>`
     : esc(id || ' · ')

// ── Mount points (declared in index.html) ────────────────────────────────────
const dashEl    = document.getElementById('dashboard')
const overlayEl = document.getElementById('detail-overlay')
const ctaEl     = document.querySelector('.cta')
const skipEl    = document.getElementById('skipBtn')

// ── State ─────────────────────────────────────────────────────────────────────
let snapshot = null
let lastHash = null
let revealed = false
let es = null
let pollTimer = null
let mode = 'team'   // 'team' | 'sprint' | 'leadership' · toggled in the header
let lastMode = null
let leadFilter = { kind: 'all', team: 'all' }   // leadership-view filters
let leadSearch = ''                              // free-text initiative search
let sprintTeam = null                            // selected team id on the Sprint page (null = first)

// ── Auth (shared-password gate) ─────────────────────────────────────────────
// A signed bearer token from POST /api/login unlocks the API. Persisted in
// localStorage; the server expires it (default 7 days). If the backend has no
// ACCESS_PASSWORD set, login returns authRequired:false and nothing gates.
const AUTH_KEY = 'hivePulseToken'
let authToken = (() => { try { return localStorage.getItem(AUTH_KEY) || '' } catch { return '' } })()
const authHeaders = () => (authToken ? { Authorization: `Bearer ${authToken}` } : {})
function setToken(t) {
  authToken = t || ''
  try { t ? localStorage.setItem(AUTH_KEY, t) : localStorage.removeItem(AUTH_KEY) } catch { /* private mode */ }
}

// ── Theme system ──────────────────────────────────────────────────────────────
// Three visual skins of the SAME layout (visual re-skin only). All keep the Hive
// gold accent. Applied via data-theme on <body>; CSS var sets do the rest.
const THEMES = [
  { id: 'dark',   label: 'Dark' },
  { id: 'light',  label: 'Light' },
  { id: 'claude', label: 'Soft' },
]
let themeIdx = (() => {
  const saved = (() => { try { return localStorage.getItem('hivePulseTheme') } catch { return null } })()
  const i = THEMES.findIndex((t) => t.id === saved)
  return i >= 0 ? i : 0
})()
function applyTheme() {
  document.body.setAttribute('data-theme', THEMES[themeIdx].id)
  try { localStorage.setItem('hivePulseTheme', THEMES[themeIdx].id) } catch { /* private mode */ }
}
function cycleTheme() {
  themeIdx = (themeIdx + 1) % THEMES.length
  applyTheme()
  const btn = document.getElementById('themeToggle')
  if (btn) btn.querySelector('.tt-label').textContent = THEMES[themeIdx].label
}
const themeIcon = () => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor"/></svg>`

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const pct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0))
const DEP_LABELS = ['lox', 'pmx', 'uwx', 'akx', 'lgx']
const labelClass = (l) => DEP_LABELS.includes(String(l).toLowerCase()) ? String(l).toLowerCase() : 'generic'

// ── Stage normalization ───────────────────────────────────────────────────────
// Real Jira statuses are messy ("5. In Code Review", "Blcoked", "7. IN QA").
// Normalize them into a canonical 7-stage pipeline so the lifecycle + sprint
// board read consistently regardless of each board's local status names.
const LC_STAGES = ['Backlog', 'Analysis', 'In Dev', 'Code Review', 'QA', 'Ready', 'Released']
// raw (lowercased, numeric prefix stripped) → canonical index in LC_STAGES
const STAGE_MAP = [
  [/(backlog|to ?do|open|selected|new|triage)/, 0],
  [/(analysis|data collection|discovery|refine|groom|spec)/, 1],
  [/(in dev|development|in progress|building|implement)/, 2],
  [/(code review|review|pr |pull request|business review)/, 3],
  [/(qa|test|verif)/, 4],
  [/(ready to deploy|ready for release|waiting on release|approved|staged)/, 5],
  [/(released|merged to release|deployed|done|closed|shipped|complete)/, 6],
]
function stageIndex(raw) {
  const k = String(raw || '').toLowerCase().replace(/^\s*\d+\.\s*/, '').trim()
  for (const [re, idx] of STAGE_MAP) if (re.test(k)) return idx
  return 2 // default to "In Dev" · a sensible middle for unknown active work
}
// Build done/active/blocked chip states for one ticket's pipeline position.
function lcStages(rawStage, blocked = false) {
  const cur = stageIndex(rawStage)
  return LC_STAGES.map((label, i) => ({
    label,
    state: i < cur ? 'done' : i === cur ? (blocked ? 'blocked' : 'active') : 'pending',
  }))
}

const healthColorVar = (t) => t.health === 'healthy' ? 'var(--circuit)' : t.health === 'blocked' ? 'var(--ember)' : 'var(--amber)'

// The signature "hive cell": a glowing RAG hexagon that leads each initiative.
// status → color: on-track green · at-risk amber · blocked/overdue red.
const ragColor = (status) =>
  status === 'on-track' || status === 'healthy' || status === 'done' ? 'var(--circuit)'
  : status === 'blocked' || status === 'overdue' ? 'var(--ember)' : 'var(--amber)'
function hexCell(status, size = 18) {
  const c = ragColor(status)
  return `<span class="hexcell ${status === 'blocked' ? 'hx-pulse' : ''}" style="--hx:${c}"><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"><path d="M12 2L21 7V17L12 22L3 17V7Z" stroke="${c}" stroke-width="2" fill="${c}" fill-opacity="0.14" stroke-linejoin="round"/></svg></span>`
}

// "LO2026.06.29" · compact active-sprint label. The sprint name already
// encodes the end date, so no separate "· ends <date>" suffix is appended.
function sprintLabel(s) {
  if (!s || !s.name) return ''
  return `${s.name}`
}
function healthPill(t) {
  if (t.health === 'healthy') return { cls: 'hp-green', label: '🟢 Healthy' }
  if (t.health === 'blocked') return { cls: 'hp-red', label: '🔴 Blocked' }
  return { cls: 'hp-yellow', label: t.isCenter ? '🟡 Backlog' : '🟡 At Risk' }
}

// One-line plain-English subtitle for the health meter · written for non-technical readers.
function healthSubtitle(t) {
  if (t.isCenter) {
    const w = t.teamsWaiting ?? 0
    return w > 0 ? `${w} team${w !== 1 ? 's' : ''} waiting on infrastructure` : 'no teams blocked on infra'
  }
  if (t.health === 'blocked') {
    const b = t.blockers?.length || 0
    return `${b} active blocker${b !== 1 ? 's' : ''} · needs attention`
  }
  if (t.health === 'at-risk') {
    const s = t.stalled || 0
    return s > 0 ? `${s} ticket${s !== 1 ? 's' : ''} stalled, plan at risk` : 'tracking behind plan'
  }
  const v = t.healthBreakdown?.velocityDelta ?? 0
  return v > 0 ? 'delivering well, velocity up' : 'on track this sprint'
}
function ageClass(b) {
  if (b.slaState === 'breach' || b.slaState === 'warning') return 'red'
  if (b.slaState === 'approaching') return 'amber'
  return 'normal'
}
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  if (ms < 60000) return 'just now'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)}h ago`
}
const hexMark = () => `<svg width="20" height="20" viewBox="0 0 26 26" fill="none"><path d="M13 2L24 7.5V18.5L13 24L2 18.5V7.5L13 2Z" stroke="#F5A623" stroke-width="1.4" fill="rgba(245,166,35,.06)"/><path d="M13 7L20 10.75V16.25L13 20L6 16.25V10.75L13 7Z" fill="rgba(245,166,35,.14)" stroke="#F5A623" stroke-width=".6"/></svg>`

// ── Panel renderers ───────────────────────────────────────────────────────────
function header(snap) {
  const cls = snap.source === 'mock' ? 'mock' : 'jira'
  const txt = snap.source === 'mock' ? 'Demo data' : 'Live · Jira'
  return `
  <div class="dash-header">
    <div>
      <div class="dash-title"><span id="agentEgg" class="agent-egg" title="">${hexMark()}</span> Hive Pulse · Live Status Dashboard</div>
      <div class="dash-sub" id="dashSub">Sprint ${esc(snap.sprint.number)} · Week of ${esc(snap.sprint.week)} · Updated ${esc(timeAgo(snap.generatedAt))}</div>
    </div>
    <div class="dash-meta">
      <span class="demo-pill ${cls}">${txt}</span>
      <span class="live-dot"></span><span>Live</span>
      <button class="theme-toggle" id="themeToggle" title="Switch theme">${themeIcon()}<span class="tt-label">${THEMES[themeIdx].label}</span></button>
      <button class="dash-refresh" id="dashRefresh">↻ Refresh</button>
    </div>
  </div>`
}

function narrative(snap) {
  const n = snap.sprint.narrative
  if (!n) return ''
  return `<div class="narrative-box"><span class="nb-mark">🧠</span><div class="nb-text"><span class="nb-tag">AI Exec Summary</span>${esc(n)}</div></div>`
}

// Flow metrics derived from current ticket ages (no changelog history exists yet).
// Cycle time = avg age of active work; Lead time = avg age of work sitting idle in
// a waiting status (review / QA / ready) or blocked. Averaged across the 4 teams
// the scrum master listed: PAY, LO, INFRA, UL.
const FLOW_TEAMS = ['pay', 'lo', 'infra', 'uw']
function flowMetrics(snap) {
  const teams = (snap.teams || []).filter((t) => FLOW_TEAMS.includes(t.id))
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  const cyclePer = teams.map((t) => mean((t.inFlightTickets || []).map((k) => Number(k.days) || 0)))
  const leadPer = teams.map((t) => {
    const idle = (t.inFlightTickets || []).filter((k) => k.blocked || [4, 7, 8].includes(stageIndex(k.stage)))
    return mean(idle.map((k) => Number(k.days) || 0))
  })
  const r1 = (n) => Math.round(n * 10) / 10
  return { cycleDays: r1(mean(cyclePer.filter((n) => n > 0))), leadDays: r1(mean(leadPer.filter((n) => n > 0))) }
}

function metricsRow(snap) {
  const s = snap.sprint
  const f = flowMetrics(snap)
  const d = (v) => `${v}<span class="mv-unit">d</span>`
  return `
  <div class="metrics-row m3">
    <div class="metric-card"><div class="metric-val" style="color:var(--ember)">${esc(s.activeBlockers)}</div><div class="metric-lbl">Blocked</div><div class="metric-trend" style="color:var(--ember)">${esc(s.blockersPastSla)} past SLA threshold</div></div>
    <div class="metric-card" title="Average time from commitment to completion, derived from current ticket ages across PAY, LO, INFRA, UL.">
      <div class="metric-val">${d(f.cycleDays)}</div><div class="metric-lbl">Cycle time · 60d avg</div><div class="metric-trend" style="color:var(--silver)">commit to completion</div></div>
    <div class="metric-card" title="Average time work sits idle in a waiting status (code review, QA, ready to deploy) or blocked, sprint over sprint.">
      <div class="metric-val">${d(f.leadDays)}</div><div class="metric-lbl">Lead time · sprint over sprint</div><div class="metric-trend" style="color:var(--silver)">idle time in status</div></div>
  </div>`
}

// ── Sprint-flow stage bar (replaces the AI Health meter on each team card) ────
// A horizontal stacked bar of the team's sprint tickets across a 7-stage flow,
// with a compact colour legend below. Each in-flight ticket is bucketed by its
// (messy) Jira status; the team's shipped count fills the Done segment.
const STAGE_BAR = [
  { key: 'analysis', label: 'Analysis', color: '#A855F7', re: /(backlog|to ?do|open|selected|new|triage|analysis|discovery|refine|groom|spec)/ },
  { key: 'indev',    label: 'In Dev',   color: '#EAB308', re: /(in dev|in development|in progress|building|implement)/ },
  { key: 'devdone',  label: 'Dev Done', color: '#7DD3FC', re: /(dev done|development done|ready for review|code complete)/ },
  { key: 'review',   label: 'Review',   color: '#F97316', re: /(code review|review|pr |pull request|business review)/ },
  { key: 'qa',       label: 'QA',       color: '#3B82F6', re: /(qa|test|verif)/ },
  { key: 'deploy',   label: 'Deploy',   color: '#14B8A6', re: /(ready to deploy|ready for release|waiting on release|deploy|approved|staged|ready)/ },
  { key: 'done',     label: 'Done',     color: '#22C55E', re: /(released|merged|deployed|done|closed|shipped|complete)/ },
]
function stageBucket(raw) {
  const k = String(raw || '').toLowerCase().replace(/^\s*\d+\.\s*/, '').trim()
  for (const s of STAGE_BAR) if (s.re.test(k)) return s.key
  return 'indev'   // sensible default for unknown active work
}
function stageBar(t) {
  const counts = Object.fromEntries(STAGE_BAR.map((s) => [s.key, 0]))
  for (const k of (t.inFlightTickets || [])) counts[stageBucket(k.stage)]++
  counts.done += t.shipped || 0
  const total = STAGE_BAR.reduce((n, s) => n + counts[s.key], 0)
  if (!total) return `<div class="stage-bar"><div class="sb-head"><span class="sb-title">Sprint flow</span></div><div class="sb-empty">No sprint tickets</div></div>`
  const segs = STAGE_BAR.filter((s) => counts[s.key] > 0)
  const bar = segs.map((s) => `<div class="sb-seg" style="width:${(100 * counts[s.key] / total).toFixed(2)}%;background:${s.color}" title="${s.label}: ${counts[s.key]}"></div>`).join('')
  const legend = segs.map((s) => `<span class="sb-leg"><i style="background:${s.color}"></i>${s.label} (${counts[s.key]})</span>`).join('')
  return `<div class="stage-bar">
    <div class="sb-head"><span class="sb-title">Sprint flow</span><span class="sb-total">${total} tickets</span></div>
    <div class="sb-track">${bar}</div>
    <div class="sb-legend">${legend}</div>
  </div>`
}

// ── Burn-up chart (per team card) ─────────────────────────────────────────────
// Done vs Scope across the sprint's working days, plus the ideal trajectory.
// Sprint burn-up — issue count (Y) vs time (X), current sprint only (no backlog).
// Renders from t.burnup = { start, end, points:[{ t, scope, done }] } supplied by
// the backend from real Jira sprint history (synthesized fallback in mock/local).
// Work scope (stepped) · Completed work (stepped) · Guideline · Scope projection · Today.
function burnUp(t) {
  const bu = t.burnup
  if (!bu || !Array.isArray(bu.points) || bu.points.length < 2) {
    return `<div class="burn-up"><div class="bu-head"><span class="bu-title">BURN-UP</span></div><div class="sb-empty">No sprint data</div></div>`
  }
  const pts = bu.points
    .map((p) => ({ ms: Date.parse(p.t), scope: Number(p.scope) || 0, done: Number(p.done) || 0 }))
    .filter((p) => Number.isFinite(p.ms))
    .sort((a, b) => a.ms - b.ms)
  if (pts.length < 2) return `<div class="burn-up"><div class="bu-head"><span class="bu-title">BURN-UP</span></div><div class="sb-empty">No sprint data</div></div>`

  const startMs = Date.parse(bu.start) || pts[0].ms
  const endMs = Math.max(Date.parse(bu.end) || pts[pts.length - 1].ms, pts[pts.length - 1].ms)
  const span = Math.max(1, endMs - startMs)
  const todayMs = pts[pts.length - 1].ms
  const finalScope = pts[pts.length - 1].scope
  const finalDone = pts[pts.length - 1].done
  const yMax = Math.max(1, Math.ceil(Math.max(...pts.map((p) => p.scope)) * 1.15))

  // Plot geometry (viewBox 300×172)
  const PL = 30, PR = 292, PT = 24, PB = 150
  const X = (ms) => PL + ((ms - startMs) / span) * (PR - PL)
  const Y = (v) => PB - (v / yMax) * (PB - PT)

  // Step-after path — each value holds until the next daily sample.
  const step = (key) => {
    let d = `M ${X(pts[0].ms).toFixed(1)} ${Y(pts[0][key]).toFixed(1)}`
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${X(pts[i].ms).toFixed(1)} ${Y(pts[i - 1][key]).toFixed(1)} L ${X(pts[i].ms).toFixed(1)} ${Y(pts[i][key]).toFixed(1)}`
    }
    return d
  }
  const dots = (key, cls) => pts.map((p) => `<circle cx="${X(p.ms).toFixed(1)}" cy="${Y(p[key]).toFixed(1)}" r="2.1" class="${cls}"/>`).join('')

  const mid = Math.round(yMax / 2)
  const yticks = [0, mid, yMax].map((v) => `<text x="${PL - 5}" y="${(Y(v) + 3).toFixed(1)}" class="bu-ytick" text-anchor="end">${v}</text>`).join('')
  const fmt = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const midMs = startMs + span / 2
  const xticks = [[startMs, 'start'], [midMs, 'mid'], [endMs, 'end']].map(([ms], i) =>
    `<text x="${X(ms).toFixed(1)}" y="${PB + 14}" class="bu-xtick" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${esc(fmt(ms))}</text>`).join('')
  const tx = clamp(X(todayMs), PL + 12, PR - 12)

  return `<div class="burn-up">
    <div class="bu-head"><span class="bu-title">BURN-UP</span><span class="bu-sub">${esc(finalDone)} of ${esc(finalScope)} issues</span></div>
    <svg viewBox="0 0 300 172" class="bu-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Sprint burn-up chart: ${esc(finalDone)} of ${esc(finalScope)} issues completed">
      ${yticks}${xticks}
      <line x1="${PL}" y1="${PB}" x2="${PR}" y2="${PB}" class="bu-axis"/>
      <line x1="${X(startMs).toFixed(1)}" y1="${Y(0).toFixed(1)}" x2="${X(endMs).toFixed(1)}" y2="${Y(finalScope).toFixed(1)}" class="bu-ideal"/>
      <line x1="${X(todayMs).toFixed(1)}" y1="${Y(finalScope).toFixed(1)}" x2="${X(endMs).toFixed(1)}" y2="${Y(finalScope).toFixed(1)}" class="bu-proj"/>
      <line x1="${X(todayMs).toFixed(1)}" y1="${PT}" x2="${X(todayMs).toFixed(1)}" y2="${PB}" class="bu-today"/>
      <text x="${tx.toFixed(1)}" y="${PT - 4}" class="bu-today-lbl" text-anchor="middle">Today</text>
      <path d="${step('scope')}" class="bu-scope-line" fill="none"/>
      <path d="${step('done')}" class="bu-done-line" fill="none"/>
      ${dots('scope', 'bu-scope-dot')}${dots('done', 'bu-done-dot')}
    </svg>
    <div class="bu-legend">
      <span class="bu-leg"><i class="bu-leg-line scope"></i>Work scope</span>
      <span class="bu-leg"><i class="bu-leg-line proj"></i>Projection</span>
      <span class="bu-leg"><i class="bu-leg-line done"></i>Completed</span>
      <span class="bu-leg"><i class="bu-leg-line ideal"></i>Guideline</span>
    </div>
  </div>`
}

// ── Cycle-time stats (per team) ───────────────────────────────────────────────
// Prefer the backend's 90-day flow cycle time (real created→resolved over the
// window); fall back to in-flight ticket ages if a team has no flowCycle yet.
function cycleStats(t) {
  if (t.flowCycle) return t.flowCycle
  const days = (t.inFlightTickets || []).map((k) => Number(k.days) || 0)
  if (!days.length) return null
  const sorted = [...days].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const r1 = (n) => Math.round(n * 10) / 10
  return { avg: r1(days.reduce((a, b) => a + b, 0) / days.length), median: r1(median), max: r1(sorted[sorted.length - 1]) }
}
const cyTile = (v, l, col) => `<div class="cy-tile"><div class="cy-val" style="color:${col}">${v}<span>d</span></div><div class="cy-lbl">${l}</div></div>`
function cyTiles(c) {
  // All three stats rendered in white (var(--paper)) — the coloured
  // blue/purple/orange treatment was noisy and read as unrelated categories.
  return `<div class="cy-tiles">${cyTile(c.avg, 'AVG', 'var(--paper)')}${cyTile(c.median, 'MEDIAN', 'var(--paper)')}${cyTile(c.max, 'MAX', 'var(--paper)')}</div>`
}
const cyHead = () => `<div class="cy-head"><span class="cy-title">CYCLE TIME</span><span class="cy-range">90-day window</span></div>`

// Full panel for the detail overlay (stats + top-5 longest-running tickets).
function cyclePanel(t) {
  const c = cycleStats(t)
  if (!c) return ''
  const top = [...(t.inFlightTickets || [])].sort((a, b) => (Number(b.days) || 0) - (Number(a.days) || 0)).slice(0, 5)
  const max = Math.max(...top.map((k) => Number(k.days) || 0), 1)
  const rows = top.map((k) => {
    const d = Number(k.days) || 0
    const w = Math.max(4, Math.round((d / max) * 100))
    const col = d >= 5 ? '#F97316' : d >= 2 ? '#3B82F6' : 'var(--silver)'
    return `<div class="cy-row">
      <span class="cy-id">${jiraLink(k.id)}</span>
      <span class="cy-tt" title="${esc(k.title)}">${esc(k.title)}</span>
      <span class="cy-bar-wrap"><span class="cy-bar" style="width:${w}%;background:${col}"></span></span>
      <span class="cy-days">${d}d</span>
    </div>`
  }).join('')
  return `<div class="cycle-panel">${cyHead()}${cyTiles(c)}<div class="cy-list">${rows}</div></div>`
}

function teamCard(t, snap) {
  const pill = healthPill(t)
  const isInfra = !!t.isCenter
  // For infra, blockers are the cross-team tickets it's holding up; for product
  // teams it's their own blocker list. Everything else is identical so every
  // card reads the same way (consistent "AI health overview").
  const blockerCount = isInfra ? (snap.infraBlockers?.length || 0) : (t.blockers?.length || 0)
  const badge = blockerCount
  const badgeStyle = ''
  // Uniform flow-metric set across ALL teams. Cycle time is a 90-day rolling
  // window (flowCycle from the backend); WIP / Throughput / Blockers are scoped
  // to the team's active sprint. Tuple: [value, label, color, sublabel].
  const fc = t.flowCycle
  const stats = [
    [fc ? `${fc.avg}d` : '—', 'Cycle time', '', '(90 days)'],
    [t.inFlight, 'WIP', '', ''],
    [t.shipped, 'Throughput', '', ''],
    [blockerCount, 'Blockers', blockerCount > 0 ? 'var(--ember)' : '', ''],
  ]
  return `
  <div class="team-card ${t.health === 'blocked' ? 'blocked-glow' : ''}" data-team="${esc(t.id)}" role="button" tabindex="0">
    ${badge > 0 ? `<div class="blocker-badge"${badgeStyle}>${badge}</div>` : ''}
    <div class="tc-top">
      <div><div class="tc-name">${esc(t.name)}</div></div>
      <span class="health-pill ${pill.cls}">${pill.label}</span>
    </div>
    ${t.activeSprint ? `<div class="tc-sprint t-mono">⬡ ${esc(sprintLabel(t.activeSprint))}</div>` : ''}
    ${stageBar(t)}
    <div class="tc-stats">
      ${stats.map(([v, l, c, sub]) => `<div class="tc-stat"><div class="tc-val"${c ? ` style="color:${c}"` : ''}>${esc(v)}</div><div class="tc-lbl">${esc(l)}${sub ? `<span class="tc-sublbl">${esc(sub)}</span>` : ''}</div></div>`).join('')}
    </div>
    ${burnUp(t)}
  </div>`
}

function blockersCard(snap) {
  const items = snap.infraBlockers.map((b) => `
    <div class="blocker-item">
      <span class="b-label ${labelClass(b.label)}">${esc(b.label || ' · ')}</span>
      <div class="b-text"><strong>${jiraLink(b.ticketId)}:</strong> ${esc(b.description || '')}<span class="b-id">${b.infraTicket ? jiraLink(b.infraTicket) : ''}${b.assignee ? ' · ' + esc(b.assignee) : ''}</span></div>
      <span class="b-age ${ageClass(b)}">${esc(b.age)}h${b.escalate ? ' ⚠' : ''}</span>
    </div>`).join('') || `<div class="empty-note">No cross-team blockers 🎉</div>`
  const past = snap.infraBlockers.filter((b) => b.escalate)
  const foot = past.length
    ? `<div class="card-foot alert">⚠ ${past.map((b) => `${esc(b.ticketId)} (${esc(b.age)}h)`).join(' and ')} exceed SLA · SMs should escalate at standup today</div>`
    : ''
  return `<div class="card"><div class="card-title">🚨 Cross-Team Infra Blockers<span class="ct-aside">HUB Central Kanban</span></div>${items}${foot}</div>`
}

function ceremoniesCard(snap) {
  const items = snap.ceremonies.map((c) => {
    const label = c.state === 'done' ? '✓ Done' : c.state === 'next' ? '▶ Next up' : 'Upcoming'
    return `<div class="ceremony-item"><div><div class="cer-name">${esc(c.name)}</div></div><div class="cer-time">${esc(c.time)}<div class="cer-state ${esc(c.state)}">${label}</div></div></div>`
  }).join('') || `<div class="empty-note">No ceremonies scheduled today.</div>`
  return `<div class="card"><div class="card-title">📅 Today's Ceremonies · ${esc(snap.sprint.week)}</div>${items}</div>`
}

// Render one ticket's lifecycle row (canonical 7-stage chip pipeline + note).
function lcRow(tk, team) {
  const blk = team?.blockers?.find((b) => b.ticketId === tk.id)
  const stages = lcStages(tk.stage, tk.blocked)
  const chips = stages.map((s) => `<div class="lc-stage ${s.state}">${s.state === 'blocked' ? '🔴 ' : s.state === 'active' ? '▶ ' : ''}${esc(s.label)}</div>`).join('')
  const note = (tk.blocked && blk)
    ? `<div class="lc-note alert">⚠ Blocked on ${blk.infraTicket ? jiraLink(blk.infraTicket) : ' · '}${blk.assignee ? ' (' + esc(blk.assignee) + ')' : ''} · ${esc(blk.age)}h waiting${blk.escalate ? ', exceeds SLA' : ''}</div>`
    : `<div class="lc-note dim">${esc(tk.stage)} · ${esc(tk.days)} day${tk.days === 1 ? '' : 's'} in flight</div>`
  return `<div class="lc-row"><div class="lc-head"><div class="lc-title">${jiraLink(tk.id)} · ${esc(tk.title)}</div></div><div class="lifecycle">${chips}</div>${note}</div>`
}

// Full in-flight lifecycle, every ticket, grouped by team in collapsible panels.
// (Previously capped at 4 rows server-side · now shows the complete picture.)
function lifecycleCard(snap) {
  const teamsWithWip = snap.teams.filter((t) => (t.inFlightTickets || []).length > 0)
  const totalWip = teamsWithWip.reduce((n, t) => n + t.inFlightTickets.length, 0)
  if (!totalWip) return `<div class="card"><div class="card-title">🔄 Live Ticket Lifecycle</div><div class="empty-note">No in-flight tickets.</div></div>`

  const groups = teamsWithWip.map((t) => {
    // Blocked first, then longest in WIP · most interesting at the top.
    const tickets = [...t.inFlightTickets].sort((a, b) => (Number(b.blocked) - Number(a.blocked)) || ((b.days || 0) - (a.days || 0)))
    const blocked = tickets.filter((k) => k.blocked).length
    const flag = blocked ? `<span class="grp-flag red">${blocked} blocked</span>` : ''
    const rows = tickets.map((tk) => lcRow(tk, t)).join('')
    // Auto-open teams that have a blocked ticket so risk is visible without a click.
    return `<details class="grp lc-grp"${blocked > 0 ? ' open' : ''}>
      <summary class="grp-summary"><span class="grp-chevron">▸</span><span class="grp-name">${esc(t.name)}</span><span class="grp-count">${tickets.length}</span>${flag}</summary>
      <div class="grp-body">${rows}</div>
    </details>`
  }).join('')

  return `<div class="card"><div class="card-title">🔄 Live Ticket Lifecycle · All In-Flight<span class="ct-aside">${totalWip} tickets across ${teamsWithWip.length} teams</span></div>
    <div class="card-hint">Every in-flight ticket mapped to the delivery pipeline. Teams with blocked work are expanded; click any team to see the rest.</div>${groups}</div>`
}

// Effort verdict → color. This card is about OUTPUT conversion, not team health,
// so the bar/dot/verdict are colored by the effort score (≥0.6 green, ≥0.4 amber,
// else red) — keeping a "Good" row green instead of inheriting a red health color.
const effortColor = (score) => score >= 0.6 ? 'var(--circuit)' : score >= 0.4 ? 'var(--amber)' : 'var(--ember)'
function roiCard(snap) {
  const order = [...snap.teams].sort((a, b) => b.effortScore - a.effortScore)
  const rows = order.map((t) => {
    const color = effortColor(t.effortScore)
    // Recompute the capacity terms client-side so the breakdown matches the bar.
    const shipped = t.shipped || 0, inFlight = t.inFlight || 0, stalled = t.stalled || 0
    const capacity = shipped + 0.5 * inFlight + 0.75 * stalled
    const breakdown = `${shipped} shipped · ${inFlight} in-flight (×0.5) · ${stalled} stalled (×0.75) → ${Math.round(capacity * 10) / 10} capacity used`
    return `<div class="roi-row" title="${esc(breakdown)}">
      <div class="roi-name"><div class="roi-dot" style="background:${color}"></div>${esc(t.shortName || t.name)}</div>
      <div class="roi-bar-wrap"><div class="roi-bar" style="width:${pct(t.effortScore * 100)}%;background:${color}"></div></div>
      <div class="roi-verdict" style="color:${color}">${esc(t.effortLabel)}</div>
    </div>
    <div class="roi-detail">${esc(breakdown)} · <strong style="color:${color}">${Math.round(t.effortScore * 100)}% conversion</strong></div>`
  }).join('')
  const formula = `<details class="grp roi-explain">
    <summary class="grp-summary"><span class="grp-chevron">▸</span><span class="grp-name">How is this calculated?</span></summary>
    <div class="grp-body roi-explain-body">
      <p><strong>Effort conversion</strong> answers: <em>of the capacity a team burned this sprint, how much turned into shipped work?</em> A high bar means output is keeping pace with effort; a low bar means effort is tied up in work that hasn't landed.</p>
      <div class="roi-eq t-mono">conversion = shipped ÷ ( shipped + 0.5· in-flight + 0.75· stalled )</div>
      <ul class="roi-legend">
        <li><strong>shipped</strong> · fully delivered this sprint (full credit)</li>
        <li><strong>in-flight ×0.5</strong> · work underway counts as half-consumed capacity</li>
        <li><strong>stalled ×0.75</strong> · stuck work has eaten most of its capacity with nothing to show</li>
      </ul>
      <div class="roi-verdicts">Verdict: <span style="color:var(--circuit)">Strong ≥80%</span> · <span style="color:var(--circuit)">Good ≥60%</span> · <span style="color:var(--amber)">Blocked ≥40%</span> · <span style="color:var(--ember)">Critical &lt;40%</span></div>
    </div>
  </details>`
  return `<div class="card"><div class="card-title">📊 Effort vs. Output · Sprint ${esc(snap.sprint.number)}<span class="ct-aside">shipped ÷ capacity consumed</span></div>
    <div class="card-hint">How much of each team's burned capacity converted into shipped work this sprint. Hover a row for the numbers.</div>${rows}${formula}</div>`
}

// Cycle-time-by-stage card (per-stage avg hours + bottleneck flag + P90 age).
// Per-stage bars need stageHistory (Jira changelog · not yet wired), so live
// mode shows "No stage data" until then; the P90 age column always works.
function cycleTimeCard(snap) {
  const SHOW = new Set(['In Dev', 'Code Review', 'In QA', 'QA Done', 'Ready to Deploy'])
  const allHours = snap.teams.flatMap((t) => (t.cycleTime?.byStage || [])
    .filter((s) => SHOW.has(s.stage)).map((s) => s.avgHours))
  const maxH = Math.max(...allHours, 1)

  const rows = snap.teams.map((t) => {
    const ct = t.cycleTime
    const color = healthColorVar(t)
    const stages = (ct?.byStage || []).filter((s) => SHOW.has(s.stage))
    const p90c = (ct?.p90AgeDays ?? 0) >= 7 ? 'var(--ember)' : (ct?.p90AgeDays ?? 0) >= 5 ? 'var(--amber)' : 'var(--silver)'
    const p90 = `<div class="ct-p90" style="color:${p90c}">${esc(ct?.p90AgeDays ?? 0)}d<div class="ct-p90lbl">P90</div></div>`
    if (!stages.length) {
      return `<div class="ct-row"><div class="ct-name" style="color:${color}">${esc(t.shortName)}</div><div class="ct-stages"><span class="ct-nodata" title="Per-stage timing requires Jira changelog access · available once the Jira integration is connected">Stage history pending</span></div>${p90}</div>`
    }
    const stageHtml = stages.map((s) => {
      const hot = ct.bottleneck?.stage === s.stage
      const w = Math.max(4, Math.round((s.avgHours / maxH) * 100))
      const c = hot ? 'var(--amber)' : 'rgba(139,143,168,.4)'
      return `<div class="ct-stage-wrap">
        <div class="ct-slbl"${hot ? ' style="color:var(--amber)"' : ''}>${esc(s.stage)}${hot ? ' ⚑' : ''}</div>
        <div class="ct-track"><div class="ct-bar" style="width:${w}%;background:${c}"></div></div>
        <div class="ct-hrs"${hot ? ' style="color:var(--amber)"' : ''}>${esc(s.avgHours)}h</div>
      </div>`
    }).join('')
    return `<div class="ct-row"><div class="ct-name" style="color:${color}">${esc(t.shortName)}</div><div class="ct-stages">${stageHtml}</div>${p90}</div>`
  }).join('')

  return `<div class="card"><div class="card-title">⏱ Cycle Time by Stage<span class="ct-aside">avg hours · ⚑ bottleneck · P90 ticket age</span></div>
    <div class="card-hint">Where tickets spend the most time. High P90 signals a zombie ticket hiding behind the average.</div>${rows}</div>`
}

function initiativeRow(i, snap) {
  const color = i.status === 'on-track' ? 'var(--circuit)' : i.status === 'at-risk' ? 'var(--amber)' : 'var(--ember)'
  const team = snap.teams.find((t) => t.id === i.teamId)
  return `<div class="init-row">
    <div class="init-head"><div class="init-headline">${hexCell(i.status, 15)}<span class="init-name">${esc(i.name)}</span> <span class="init-team">${esc(team?.shortName || i.teamId)}</span></div><span class="init-pct" style="color:${color}">${esc(i.progressPct)}%</span></div>
    <div class="init-bar-wrap"><div class="init-bar" style="width:${pct(i.progressPct)}%;background:${color}"></div></div>
    <div class="init-meta"><span>${esc(i.doneChildren)}/${esc(i.totalChildren)} done${i.blockedChildren ? ` · ${esc(i.blockedChildren)} blocked` : ''}</span><span class="init-status ${esc(i.status)}">${esc(String(i.status).replace('-', ' '))}</span></div>
  </div>`
}

function initiativesCard(snap) {
  if (!snap.initiatives.length) {
    return `<div class="card"><div class="card-title">🎯 Initiatives & Epics · Progress</div><div class="empty-note">No initiatives tracked.</div></div>`
  }
  // Group initiatives per team, ordered to match the team list.
  const order = snap.teams.map((t) => t.id)
  const byTeam = new Map()
  for (const i of snap.initiatives) {
    if (!byTeam.has(i.teamId)) byTeam.set(i.teamId, [])
    byTeam.get(i.teamId).push(i)
  }
  const teamIds = [...byTeam.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))

  const rank = { blocked: 0, 'at-risk': 1, 'on-track': 2 }
  const groups = teamIds.map((tid, idx) => {
    const team = snap.teams.find((t) => t.id === tid)
    // Blocked first, then at-risk, then by most progress · surface what needs attention.
    const items = byTeam.get(tid).sort((a, b) =>
      (rank[a.status] - rank[b.status]) || (b.progressPct - a.progressPct))
    const blocked = items.filter((i) => i.status === 'blocked').length
    const atRisk = items.filter((i) => i.status === 'at-risk').length
    const flag = blocked ? `<span class="grp-flag red">${blocked} blocked</span>` : atRisk ? `<span class="grp-flag amber">${atRisk} at risk</span>` : ''
    const rows = items.map((i) => initiativeRow(i, snap)).join('')
    // All teams collapsed by default · click a team to expand its initiatives.
    return `<details class="grp">
      <summary class="grp-summary"><span class="grp-chevron">▸</span><span class="grp-name">${esc(team?.name || tid)}</span><span class="grp-count">${items.length}</span>${flag}</summary>
      <div class="grp-body">${rows}</div>
    </details>`
  }).join('')

  return `<div class="card"><div class="card-title">🎯 Initiatives &amp; Epics · by team<span class="ct-aside">${snap.initiatives.length} active epics</span></div>${groups}</div>`
}

// ── LEADERSHIP VIEW · company-level initiative health (the shared PM pitch) ────
const statusColor = (s) => s === 'on-track' ? 'var(--circuit)' : s === 'at-risk' ? 'var(--amber)' : 'var(--ember)'

// Plain-English summary card for executives · three bullets derived from live data,
// no Jira IDs, no jargon. Sits at the top of the leadership view.
function todayStory(snap) {
  const L = snap.leadership || {}
  const s = snap.sprint
  const nonCenter = snap.teams.filter((t) => !t.isCenter)
  const blockedTeams = nonCenter.filter((t) => t.health === 'blocked')
  const down = String(s.trend).startsWith('-')
  const bs = L.byStatus || {}

  const bullets = [
    {
      ok: !down,
      text: down
        ? `Delivery is down ${esc(s.trend)} vs last sprint · ${esc(s.totalShipped)} tickets shipped this sprint`
        : `Delivery up ${esc(s.trend)} vs last sprint · ${esc(s.totalShipped)} tickets shipped this sprint`,
    },
    {
      ok: (L.onTrackPct ?? 0) >= 70,
      text: `${L.onTrackPct ?? 0}% of ${L.totalInitiatives ?? 0} active initiatives are on track · ${bs.blocked || 0} blocked, ${bs.atRisk || 0} at risk, portfolio ${L.completionPct ?? 0}% complete`,
    },
    blockedTeams.length === 0
      ? { ok: true,  text: `No teams have active blockers this sprint · all ${nonCenter.length} product teams are clear to ship` }
      : { ok: false, text: `${blockedTeams.length} team${blockedTeams.length !== 1 ? 's' : ''} need${blockedTeams.length === 1 ? 's' : ''} attention: ${blockedTeams.map((t) => esc(t.shortName || t.name)).join(', ')} · ${s.activeBlockers} active blocker${s.activeBlockers !== 1 ? 's' : ''}${s.blockersPastSla > 0 ? `, ${s.blockersPastSla} past response window` : ''}` },
  ]

  return `<div class="card ts-card">
    <div class="card-title">Today's Story <span class="ct-aside">plain-language summary for leadership</span></div>
    <div class="ts-bullets">
      ${bullets.map((b) => `<div class="ts-bullet ts-bullet-${b.ok ? 'ok' : 'warn'}">
        <span class="ts-dot"></span>
        <span class="ts-text">${b.text}</span>
      </div>`).join('')}
    </div>
  </div>`
}

// Compact RAG legend shown above the initiative table so non-technical readers
// understand what the hexagon colours mean without having to ask.
function ragLegend() {
  return `<div class="rag-legend" aria-label="Status legend">
    <span class="rl-item">${hexCell('on-track', 11)}<span>On track</span></span>
    <span class="rl-item">${hexCell('at-risk', 11)}<span>At risk</span></span>
    <span class="rl-item">${hexCell('blocked', 11)}<span>Blocked</span></span>
  </div>`
}

// ── Exec summary (typewriter) ─────────────────────────────────────────────────
// Builds a 2–3 paragraph, plain-language briefing for leadership from live data.
// Deliberately non-technical: no ticket IDs, no jargon · outcomes and risks.
function execSummaryText(snap) {
  const s = snap.sprint
  const L = snap.leadership || {}
  const teams = snap.teams.filter((t) => !t.isCenter)
  const blocked = teams.filter((t) => t.health === 'blocked')
  const atRisk  = teams.filter((t) => t.health === 'at-risk')
  const down = String(s.trend).startsWith('-')
  const top = [...teams].sort((a, b) => (b.shipped || 0) - (a.shipped || 0))[0]
  const nm = (arr) => arr.map((t) => t.name).join(', ').replace(/, ([^,]*)$/, ' and $1')

  // Paragraph 1 · overall delivery & momentum.
  const p1 = `This sprint the engineering teams delivered ${s.totalShipped} pieces of work, ${down ? 'down' : 'up'} ${String(s.trend).replace(/^[+-]/, '')} from last sprint${down ? ', a dip worth watching' : ' · momentum is positive'}. Across ${L.totalInitiatives ?? 0} active initiatives, ${L.onTrackPct ?? 0}% are on track and the overall portfolio is ${L.completionPct ?? 0}% complete by delivered work. ${top ? `${top.name} is the strongest contributor this sprint.` : ''}`

  // Paragraph 2 · risk picture.
  let p2
  if (blocked.length) {
    p2 = `${blocked.length === 1 ? 'One team needs' : `${blocked.length} teams need`} leadership attention: ${nm(blocked)} ${blocked.length === 1 ? 'is' : 'are'} blocked, with ${s.activeBlockers} active blocker${s.activeBlockers !== 1 ? 's' : ''} company-wide${s.blockersPastSla > 0 ? ` and ${s.blockersPastSla} that have sat past our response window` : ''}. Most blockers trace back to shared platform dependencies, so clearing those is the single highest-leverage move available right now.`
  } else if (atRisk.length) {
    p2 = `No team is fully blocked, but ${nm(atRisk)} ${atRisk.length === 1 ? 'is' : 'are'} tracking behind plan and could slip without a course-correction. There ${s.activeBlockers === 1 ? 'is' : 'are'} ${s.activeBlockers} active blocker${s.activeBlockers !== 1 ? 's' : ''} to keep an eye on, none yet at a critical age.`
  } else {
    p2 = `There are no blocked teams this sprint and no blockers past our response window · an unusually clean risk picture. Every product team is clear to keep shipping.`
  }

  // Paragraph 3 · bottom line.
  const p3 = blocked.length
    ? `Bottom line: delivery is ${down ? 'softer than last sprint' : 'healthy overall'}, but the blocked work won't move without a decision · either unblock the dependency or consciously reset the date. Everything else is on a good path.`
    : `Bottom line: the org is in good shape · ${L.onTrackPct ?? 0}% of initiatives on track and no critical blockers. The focus should be on protecting that momentum and keeping the at-risk items from slipping.`

  return [p1, p2, p3]
}

function execSummary(snap) {
  // Paragraphs are rendered empty; runTypewriter() fills them after mount.
  const paras = execSummaryText(snap)
  const joined = paras.join('\n\n')
  return `<div class="card exec-summary" data-fulltext="${esc(joined)}">
    <div class="es-head">
      <span class="es-avatar">${hexMark()}</span>
      <div><div class="es-title">Hive Pulse · Executive Briefing</div><div class="es-sub">Generated from this sprint's live data · ${esc(snap.sprint.week)}</div></div>
      <span class="es-badge">AI summary</span>
    </div>
    <div class="es-body" id="esBody"></div>
  </div>`
}

// Character-by-character reveal, like a streaming AI answer. Honors reduced-motion.
let typeTimer = null
function runTypewriter() {
  if (typeTimer) { clearInterval(typeTimer); typeTimer = null }
  const card = dashEl.querySelector('.exec-summary')
  const body = document.getElementById('esBody')
  if (!card || !body) return
  const full = card.dataset.fulltext || ''
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  const paint = (text, typing) => {
    const html = esc(text).replace(/\n\n/g, '</p><p>')
    body.innerHTML = `<p>${html}${typing ? '<span class="es-caret">▋</span>' : ''}</p>`
  }
  if (reduced || full.length === 0) { paint(full, false); return }
  let i = 0
  // Reveal in chunks sized so the whole briefing finishes in ~250 ticks (~4–5s)
  // regardless of length · feels like live AI typing and stays bounded even if
  // the browser throttles timers (e.g. a backgrounded tab).
  const step = Math.max(1, Math.ceil(full.length / 250))
  typeTimer = setInterval(() => {
    i += step
    if (i >= full.length) { i = full.length; paint(full, false); clearInterval(typeTimer); typeTimer = null }
    else paint(full.slice(0, i), true)
  }, 18)
}

function leadershipRollup(L, snap) {
  const s = L.byStatus || { onTrack: 0, atRisk: 0, blocked: 0 }
  const down = String(L.trend || '').startsWith('-')
  return `<div class="metrics-row lead-rollup">
    <div class="metric-card"><div class="metric-val">${esc(L.totalInitiatives ?? 0)}</div><div class="metric-lbl">Active initiatives</div><div class="metric-trend">${esc(L.byKind?.tech ?? 0)} tech · ${esc(L.byKind?.ops ?? 0)} ops</div></div>
    <div class="metric-card"><div class="metric-val" style="color:var(--circuit)">${esc(L.onTrackPct ?? 0)}%</div><div class="metric-lbl">On track</div><div class="metric-trend">${s.onTrack} on track · ${s.atRisk} at risk · ${s.blocked} blocked</div></div>
    <div class="metric-card"><div class="metric-val" style="color:var(--ember)">${esc(s.blocked)}</div><div class="metric-lbl">Blocked initiatives</div><div class="metric-trend" style="color:var(--ember)">need attention</div></div>
    <div class="metric-card"><div class="metric-val" style="color:var(--amber)">${esc(L.completionPct ?? 0)}%</div><div class="metric-lbl">Overall completion</div><div class="metric-trend">${esc(L.doneChildren ?? 0)}/${esc(L.totalChildren ?? 0)} stories · <span style="color:${down ? 'var(--ember)' : 'var(--circuit)'}">${down ? '↓' : '↑'} ${esc(L.trend ?? '')} sprint</span></div></div>
  </div>`
}

// Tier-3 strategic metrics. Some are derivable TODAY from the ticket/stage data
// we already have (shown live); the rest need a Jira field that doesn't exist yet
// (shown with exactly what to add and why it matters). This answers "why is
// nothing showing" · it's not broken, it's gated on data we don't yet collect.
function strategicMetrics(L, snap) {
  // ── Derivable now: Discovery → Delivery balance ──
  // Of all active work, how much is still in discovery (backlog/analysis) vs in
  // delivery (dev→released)? A healthy pipeline is delivery-weighted.
  const allWip = snap.teams.flatMap((t) => t.inFlightTickets || [])
  const discovery = allWip.filter((k) => stageIndex(k.stage) <= 1).length
  const delivery = allWip.filter((k) => stageIndex(k.stage) >= 2).length
  const ddTotal = discovery + delivery
  const deliveryPct = ddTotal ? Math.round((100 * delivery) / ddTotal) : 0
  const ddColor = deliveryPct >= 70 ? 'var(--circuit)' : deliveryPct >= 50 ? 'var(--amber)' : 'var(--ember)'

  // ── Derivable now: Portfolio completion (story-weighted, from initiatives) ──
  const compColor = (L.completionPct ?? 0) >= 60 ? 'var(--circuit)' : (L.completionPct ?? 0) >= 40 ? 'var(--amber)' : 'var(--ember)'

  const live = [
    {
      name: 'Discovery → Delivery',
      val: `${deliveryPct}%`, color: ddColor,
      desc: `${delivery} of ${ddTotal} active tickets are past discovery and in delivery`,
      foot: `${discovery} in discovery · ${delivery} in delivery`,
    },
    {
      name: 'Portfolio completion',
      val: `${L.completionPct ?? 0}%`, color: compColor,
      desc: `story-weighted across all ${L.totalInitiatives ?? 0} initiatives`,
      foot: `${L.doneChildren ?? 0} of ${L.totalChildren ?? 0} stories done`,
    },
  ]

  const pending = [
    ['Outcome hit rate', '% of shipped epics that hit their target metric', 'Add a "Success Metric" field to epics + a post-ship review flag', 'Tells leadership if we shipped the right thing, not just shipped something'],
    ['Stakeholder alignment', '% of epics signed off by the business before dev started', 'Add a sign-off checkbox/date on each epic', 'Catches work that started without business agreement · the #1 source of rework'],
    ['Committed date confidence', 'how often we hit the date we promised the business', 'Add a "Committed date" field on initiatives', 'Turns "it\'ll be ready soon" into a track record leadership can plan around'],
  ]

  return `<details class="grp strat-pending" open>
    <summary class="grp-summary"><span class="grp-chevron">▸</span><span class="grp-name">📐 Strategic metrics</span><span class="grp-flag amber">2 live · 3 pending Jira fields</span></summary>
    <div class="grp-body">
      <div class="strat-grid">
        ${live.map((m) => `<div class="strat-card strat-live">
          <div class="strat-name">${esc(m.name)}<span class="strat-tag live">live</span></div>
          <div class="strat-val" style="color:${m.color}">${esc(m.val)}</div>
          <div class="strat-desc">${esc(m.desc)}</div>
          <div class="strat-foot">${esc(m.foot)}</div>
        </div>`).join('')}
      </div>
      <div class="strat-pending-head">Not shown yet · each needs one Jira field we don't collect today:</div>
      <div class="strat-grid">
        ${pending.map(([name, desc, need, why]) => `<div class="strat-card">
          <div class="strat-name">${esc(name)}<span class="strat-tag pending">pending</span></div>
          <div class="strat-val"> · </div>
          <div class="strat-desc">${esc(desc)}</div>
          <div class="strat-need">⚙ ${esc(need)}</div>
          <div class="strat-why">Why it matters: ${esc(why)}</div>
        </div>`).join('')}
      </div>
    </div>
  </details>`
}

function filterControls(snap) {
  const teams = snap.teams.map((t) => t.id)
  const chip = (k, label) => `<button class="lead-chip ${leadFilter.kind === k ? 'active' : ''}" data-kind="${k}">${label}</button>`
  const teamOpts = ['all', ...teams].map((tid) => {
    const t = snap.teams.find((x) => x.id === tid)
    return `<option value="${tid}" ${leadFilter.team === tid ? 'selected' : ''}>${tid === 'all' ? 'All teams' : esc(t?.name || tid)}</option>`
  }).join('')
  return `<span class="lead-filters">
    <span class="lead-search-wrap"><span class="lead-search-icon">⌕</span><input class="lead-search" id="leadSearch" placeholder="Search initiatives…" value="${esc(leadSearch)}" autocomplete="off"></span>
    ${chip('all', 'All')}${chip('tech', 'Tech')}${chip('ops', 'Ops')}
    <select class="lead-team-select" id="leadTeamSelect">${teamOpts}</select>
  </span>`
}

function filteredInitiatives(snap) {
  const q = leadSearch.trim().toLowerCase()
  return (snap.initiatives || [])
    .filter((i) => leadFilter.kind === 'all' || (i.kind || 'tech') === leadFilter.kind)
    .filter((i) => leadFilter.team === 'all' || i.teamId === leadFilter.team)
    .filter((i) => !q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
    .sort((a, b) => (b.progressPct - a.progressPct))  // done → in progress
}

// Collapsible initiative groups for the leadership view.
// Each team is a <details> (auto-opens when it has blocked initiatives).
// Each initiative inside is another <details> that expands the story list.
// Sorted done → in progress (progressPct DESC) within each team.
function initiativeGroups(snap) {
  const items = filteredInitiatives(snap)
  if (!items.length) return '<div class="empty-note">No initiatives match this filter.</div>'

  const order = snap.teams.map((t) => t.id)
  const byTeam = new Map()
  for (const i of items) {
    if (!byTeam.has(i.teamId)) byTeam.set(i.teamId, [])
    byTeam.get(i.teamId).push(i)
  }
  const teamIds = [...byTeam.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))

  return teamIds.map((tid) => {
    const team = snap.teams.find((t) => t.id === tid)
    const inits = byTeam.get(tid)
    const blocked = inits.filter((i) => i.status === 'blocked').length
    const atRisk  = inits.filter((i) => i.status === 'at-risk').length
    const flag = blocked ? `<span class="grp-flag red">${blocked} blocked</span>`
               : atRisk  ? `<span class="grp-flag amber">${atRisk} at risk</span>` : ''

    const initRows = inits.map((i) => {
      const ic = statusColor(i.status)
      const kindBadge = (i.kind || 'tech') === 'ops'
        ? `<span class="kind-badge ops">Ops</span>`
        : `<span class="kind-badge tech">Tech</span>`
      const stories = i.stories || []
      const storyHtml = stories.length
        ? stories.map((s) => {
            const st = s.done ? 'done' : s.blocked ? 'blocked' : 'on-track'
            return `<div class="story-row">${hexCell(st, 13)}<span class="story-id">${jiraLink(s.id)}</span><span class="story-title ${s.done ? 'is-done' : ''}">${esc(s.title)}</span><span class="story-stage">${esc(s.stage)}${s.blocked ? ' · blocked' : ''}</span></div>`
          }).join('')
        : `<div class="story-empty">No linked stories · add child issues in Jira.</div>`
      return `<details class="li-init">
        <summary class="li-init-head">
          <span class="li-chev">▸</span>
          ${hexCell(i.status, 15)}
          <span class="li-init-name">${esc(i.name)}</span>
          ${kindBadge}
          <div class="li-prog-wrap"><div class="li-prog-bar"><div class="li-prog-fill" style="width:${pct(i.progressPct)}%;background:${ic}"></div></div><span class="li-prog-pct" style="color:${ic}">${esc(i.progressPct)}%</span></div>
          <span class="li-stories-lbl">${esc(i.doneChildren)}/${esc(i.totalChildren)}${i.blockedChildren ? `<span style="color:var(--ember)"> · ${esc(i.blockedChildren)}⛔</span>` : ''}</span>
          <span class="li-status-lbl" style="color:${ic}">${esc(String(i.status).replace('-', ' '))}</span>
        </summary>
        <div class="li-init-body"><div class="story-list">${storyHtml}</div></div>
      </details>`
    }).join('')

    return `<details class="li-team">
      <summary class="li-team-head">
        <span class="li-chev">▸</span>
        ${hexCell(team?.health || 'on-track', 16)}
        <span class="li-team-name">${esc(team?.name || tid)}</span>
        <span class="grp-count">${inits.length}</span>
        ${flag}
      </summary>
      <div class="li-team-body">${initRows}</div>
    </details>`
  }).join('')
}

// Sprint Health panel · sprint timeline progress + velocity + blockers + per-team bars.
// Derives sprint end date from team active sprints, assumes 2-week cadence.
function sprintHealth(snap) {
  const s = snap.sprint
  const teamSprints = snap.teams.map((t) => t.activeSprint).filter((sp) => sp?.endDate)
  let progressPct = 50, daysLeft = null, endLabel = s.week
  if (teamSprints.length) {
    const now = Date.now()
    // Only use sprint dates within ±4 weeks to exclude stale/far-future outliers from Jira
    const reasonable = teamSprints
      .map((sp) => new Date(sp.endDate).getTime())
      .filter((ms) => Number.isFinite(ms) && Math.abs(ms - now) < 28 * 86400000)
    if (reasonable.length) {
      const endMs = Math.max(...reasonable)
      const msLeft = Math.max(0, endMs - now)
      progressPct = Math.min(100, Math.max(0, Math.round(((14 * 86400000 - msLeft) / (14 * 86400000)) * 100)))
      daysLeft = Math.ceil(msLeft / 86400000)
      endLabel = new Date(endMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
  }
  const down = String(s.trend).startsWith('-')
  const barColor = daysLeft != null && daysLeft <= 2 ? 'var(--ember)' : progressPct > 70 ? 'var(--amber)' : 'var(--circuit)'
  const slaStatus = s.infraAvgResponse >= 32
    ? `<span style="color:var(--ember)">⚠ SLA breach</span>`
    : s.infraAvgResponse >= 24
      ? `<span style="color:var(--amber)">approaching SLA</span>`
      : `<span style="color:var(--circuit)">✓ within SLA</span>`
  const teamBars = snap.teams.filter((t) => !t.isCenter).map((t) => {
    const color = healthColorVar(t)
    return `<div class="sh-team">
      <div class="sh-team-name">${esc(t.shortName)}</div>
      <div class="sh-team-bar"><div class="sh-team-fill" style="width:${pct(t.healthScore)}%;background:${color}"></div></div>
      <div class="sh-team-score" style="color:${color}">${t.healthScore}</div>
    </div>`
  }).join('')
  return `<div class="card sh-section">
    <div class="card-title">🏃 Sprint Health · Sprint ${esc(s.number)}<span class="ct-aside">${daysLeft != null ? `${daysLeft}d left · ends ${endLabel}` : esc(s.week)}</span></div>
    <div class="sh-grid">
      <div class="sh-progress">
        <div class="sh-label">Sprint progress</div>
        <div class="sh-bar-wrap"><div class="sh-bar" style="width:${progressPct}%;background:${barColor}"></div></div>
        <div class="sh-bar-meta"><span style="color:${barColor}">${progressPct}% elapsed</span>${daysLeft != null ? `<span>${daysLeft}d remaining</span>` : ''}</div>
      </div>
      <div class="sh-stat">
        <div class="sh-stat-val" style="color:${down ? 'var(--ember)' : 'var(--circuit)'}">${esc(s.totalShipped)}</div>
        <div class="sh-stat-lbl">shipped</div>
        <div class="sh-stat-trend" style="color:${down ? 'var(--ember)' : 'var(--circuit)'}">${down ? '↓' : '↑'} ${esc(s.trend)} vs last</div>
      </div>
      <div class="sh-stat">
        <div class="sh-stat-val" style="color:${s.activeBlockers > 0 ? 'var(--ember)' : 'var(--circuit)'}">${esc(s.activeBlockers)}</div>
        <div class="sh-stat-lbl">blockers</div>
        <div class="sh-stat-trend" style="color:${s.blockersPastSla > 0 ? 'var(--ember)' : 'var(--silver)'}">${s.blockersPastSla} past SLA</div>
      </div>
      <div class="sh-stat">
        <div class="sh-stat-val" style="color:var(--amber)">${esc(s.infraAvgResponse)}h</div>
        <div class="sh-stat-lbl">infra avg</div>
        <div class="sh-stat-trend">${slaStatus}</div>
      </div>
    </div>
    <div class="sh-teams">${teamBars}</div>
  </div>`
}

// Business ↔ Tech Bridge · the COO/PM translation layer. For each domain it
// answers the three questions a non-engineer actually asks: what does this team
// drive for the business, are we winning or losing ground, and what should I do
// about it. Engineering signals (blocked initiatives, momentum, KPIs) are
// rewritten as business outcomes, risks, and a recommended action.
function businessBridge(snap) {
  const DOMAINS = {
    lo:        { icon: '🏦', goal: 'Lender activation & portal experience', drives: 'how fast new lenders go live and start originating loans' },
    pay:       { icon: '💳', goal: 'Payment processing & ACH reliability',  drives: 'money movement · every payment, ACH pull and collection' },
    uw:        { icon: '⚖️', goal: 'Underwriting, risk & lead generation',   drives: 'who we approve and the quality of leads we buy' },
    analytics: { icon: '📊', goal: 'Reporting & decision data',             drives: 'the numbers leadership and lenders make decisions on' },
    infra:     { icon: '🔧', goal: 'Platform reliability & dev velocity',    drives: 'uptime and how fast every other team can ship' },
  }

  const teams = snap.teams.filter((t) => !t.isCenter)
  // Portfolio bottom-line across all product domains.
  const allInits = snap.initiatives || []
  const pBlocked = allInits.filter((i) => i.status === 'blocked').length
  const pAtRisk  = allInits.filter((i) => i.status === 'at-risk').length
  const pOk      = allInits.filter((i) => i.status === 'on-track').length
  const bottomLine = pBlocked
    ? `<strong style="color:var(--ember)">${pBlocked} initiative${pBlocked !== 1 ? 's are' : ' is'} blocked</strong> and need a leadership decision; ${pAtRisk} more at risk. The remaining ${pOk} are delivering business value on schedule.`
    : pAtRisk
      ? `No initiatives are blocked. <strong style="color:var(--amber)">${pAtRisk} at risk</strong> could slip their target · worth a check-in. ${pOk} delivering on schedule.`
      : `<strong style="color:var(--circuit)">All ${pOk} initiatives are delivering on schedule.</strong> No business-level risks this sprint.`

  const cards = teams.map((t) => {
    const d = DOMAINS[t.id] || { icon: '⬡', goal: 'Engineering delivery', drives: 'product delivery' }
    const inits = allInits.filter((i) => i.teamId === t.id)
    const blocked = inits.filter((i) => i.status === 'blocked').length
    const atRisk  = inits.filter((i) => i.status === 'at-risk').length
    const onTrack = inits.filter((i) => i.status === 'on-track').length
    const vel = t.healthBreakdown?.velocityDelta ?? 0
    const momentum = vel > 0.08
      ? `<span class="br-mom up">▲ gaining momentum</span>`
      : vel < -0.08
        ? `<span class="br-mom down">▼ slowing down</span>`
        : `<span class="br-mom flat">▬ steady</span>`

    // Business read + recommended action, by severity.
    let cls, read, action
    if (t.health === 'blocked' || blocked > 0) {
      cls = 'red'
      read = `${blocked || 'Key'} initiative${blocked === 1 ? '' : 's'} ${blocked ? 'blocked' : 'stalled'} · ${d.drives} is at risk of slipping this sprint.`
      action = blocked
        ? `Unblock the dependency (see blockers below) or formally move the date.`
        : `Decide: add capacity, cut scope, or accept the slip.`
    } else if (t.health === 'at-risk' || atRisk > 0) {
      cls = 'amber'
      read = `${atRisk || 'Some'} item${atRisk === 1 ? '' : 's'} at risk · ${d.drives} may slip if nothing changes.`
      action = `Monitor this week; revisit scope at the next planning if it doesn't recover.`
    } else {
      cls = 'green'
      read = `On track · ${d.drives} is delivering as planned.`
      action = `No action needed. Keep current pace.`
    }

    const kpiLine = t.id === 'pay'
      ? `<div class="br-kpi"><span class="br-kpi-dot" style="background:${snap.sprint.achSuccessRate >= 98 ? 'var(--circuit)' : 'var(--amber)'}"></span>ACH success rate <strong>${esc(snap.sprint.achSuccessRate)}%</strong> · the reliability customers feel directly</div>`
      : ''

    const dist = (onTrack + atRisk + blocked) || 1
    const distBar = `<div class="br-dist" title="${onTrack} on track · ${atRisk} at risk · ${blocked} blocked">
      ${onTrack ? `<span style="width:${(100 * onTrack / dist)}%;background:var(--circuit)"></span>` : ''}
      ${atRisk ? `<span style="width:${(100 * atRisk / dist)}%;background:var(--amber)"></span>` : ''}
      ${blocked ? `<span style="width:${(100 * blocked / dist)}%;background:var(--ember)"></span>` : ''}
    </div>`

    return `<div class="br-card br-${cls}">
      <div class="br-top">
        <span class="br-icon">${d.icon}</span>
        <div class="br-info"><div class="br-name">${esc(t.name)}</div><div class="br-goal">${esc(d.goal)}</div></div>
        ${momentum}
      </div>
      <div class="br-read br-read-${cls}">${read}</div>
      ${kpiLine}
      <div class="br-action"><span class="br-action-lbl">Recommended</span> ${esc(action)}</div>
      ${distBar}
      <div class="br-stats">
        <span>${inits.length} initiatives</span>
        ${onTrack ? `<span style="color:var(--circuit)">${onTrack} on track</span>` : ''}
        ${atRisk  ? `<span style="color:var(--amber)">${atRisk} at risk</span>` : ''}
        ${blocked ? `<span style="color:var(--ember)">${blocked} blocked</span>` : ''}
      </div>
    </div>`
  }).join('')

  const escal = snap.infraBlockers?.filter((b) => b.escalate).length || 0
  const infraNote = snap.infraBlockers?.length
    ? `<div class="br-infra-note">🔧 <strong>${snap.infraBlockers.length}</strong> cross-team dependenc${snap.infraBlockers.length !== 1 ? 'ies' : 'y'} sit in the platform team · ${escal > 0 ? `<span style="color:var(--ember)">${escal} past the response window and need escalation.</span>` : 'all within the response window.'} These are the single biggest lever on the red items above.</div>`
    : ''

  return `<div class="card br-section">
    <div class="card-title">🌉 Business ↔ Tech Bridge<span class="ct-aside">what engineering means for the business</span></div>
    <div class="card-hint">Each domain in plain business terms: what it drives, whether it's gaining or losing ground, and what leadership should do.</div>
    <div class="br-bottomline">Bottom line: ${bottomLine}</div>
    <div class="br-grid">${cards}</div>
    ${infraNote}
  </div>`
}

// ── SPRINT PAGE · per-team sprint cadence & health ────────────────────────────
// A dedicated analysis page (like Leadership) focused on a single team's current
// sprint: a purpose-built Sprint Health score, scope/pace gauge, story-status
// board, and throughput · all from live data, with the score fully explained.

// Sprint elapsed fraction (0..1) from a team's active sprint dates. Falls back
// to the company-wide sprint window, then 0.5, so it degrades gracefully.
function sprintElapsed(snap, t) {
  const sp = t?.activeSprint
  const now = Date.now()
  const span = (start, end) => {
    const a = new Date(start).getTime(), b = new Date(end).getTime()
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null
    return { pct: clamp((now - a) / (b - a), 0, 1), end: b, start: a }
  }
  if (sp?.startDate && sp?.endDate) {
    const r = span(sp.startDate, sp.endDate); if (r) return r
  }
  // Fallback: any team's reasonable end date, assume 14-day cadence.
  const ends = snap.teams.map((x) => x.activeSprint?.endDate).map((d) => new Date(d).getTime())
    .filter((ms) => Number.isFinite(ms) && Math.abs(ms - now) < 28 * 86400000)
  if (ends.length) {
    const end = Math.max(...ends), start = end - 14 * 86400000
    return { pct: clamp((now - start) / (end - start), 0, 1), end, start }
  }
  return { pct: 0.5, end: null, start: null }
}

// THE sprint health equation. Distinct from team "AI health" (which is about
// blockers/SLA) · this answers "is this sprint on pace to land its committed
// scope?" Every term is returned for the explainability box.
function sprintScore(snap, t) {
  const shipped = t.shipped || 0, inFlight = t.inFlight || 0, stalled = t.stalled || 0
  const committed = shipped + inFlight + stalled
  const completion = committed ? shipped / committed : 0
  const { pct: elapsed, end } = sprintElapsed(snap, t)
  const behindGap = Math.max(0, elapsed - completion)           // behind the time-pace
  const stalledRatio = committed ? stalled / committed : 0
  const velocityDelta = clamp(t.healthBreakdown?.velocityDelta ?? 0, -1, 1)

  const pBehind = Math.round(50 * behindGap)
  const pStalled = Math.round(40 * stalledRatio)
  const pVel = Math.round(10 * velocityDelta)
  const score = Math.round(clamp(100 - pBehind - pStalled + pVel, 0, 100))
  const status = score >= 70 ? 'on-track' : score >= 45 ? 'at-risk' : 'blocked'
  const daysLeft = end ? Math.max(0, Math.ceil((end - Date.now()) / 86400000)) : null

  return {
    score, status, shipped, inFlight, stalled, committed, daysLeft,
    completionPct: Math.round(completion * 100), elapsedPct: Math.round(elapsed * 100),
    breakdown: { pBehind, pStalled, pVel, behindGap: Math.round(behindGap * 100), stalledRatio: Math.round(stalledRatio * 100), velocityDelta: Math.round(velocityDelta * 100) },
  }
}

// Radial scope/pace gauge: filled arc = % of committed work delivered, the tick
// marks where we *should* be by elapsed time. Below the tick = behind schedule.
function scopeGauge(sc) {
  const R = 78, C = 2 * Math.PI * R
  const filled = (sc.completionPct / 100) * C
  const tickAngle = (sc.elapsedPct / 100) * 360 - 90
  const color = statusColor(sc.status)
  const tx = 100 + R * Math.cos(tickAngle * Math.PI / 180)
  const ty = 100 + R * Math.sin(tickAngle * Math.PI / 180)
  return `<div class="sp-gauge">
    <svg width="200" height="200" viewBox="0 0 200 200">
      <circle cx="100" cy="100" r="${R}" fill="none" stroke="var(--track)" stroke-width="16"/>
      <circle cx="100" cy="100" r="${R}" fill="none" stroke="${color}" stroke-width="16"
        stroke-dasharray="${filled} ${C}" stroke-linecap="round" transform="rotate(-90 100 100)"/>
      <circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="5" fill="var(--paper)" stroke="var(--graphite)" stroke-width="2"/>
      <text x="100" y="94" text-anchor="middle" class="sp-gauge-val" fill="${color}">${sc.completionPct}%</text>
      <text x="100" y="116" text-anchor="middle" class="sp-gauge-lbl">delivered</text>
    </svg>
    <div class="sp-gauge-legend">
      <span><span class="sp-dot" style="background:${color}"></span>${sc.completionPct}% delivered</span>
      <span><span class="sp-dot" style="background:var(--paper)"></span>${sc.elapsedPct}% time elapsed</span>
    </div>
    <div class="sp-gauge-note">${sc.completionPct >= sc.elapsedPct
      ? `<span style="color:var(--circuit)">On or ahead of pace</span>`
      : `<span style="color:var(--amber)">${sc.elapsedPct - sc.completionPct} pts behind the time-pace</span>`}${sc.daysLeft != null ? ` · ${sc.daysLeft}d left` : ''}</div>
  </div>`
}

// Story-status board: every in-flight ticket bucketed into pipeline columns.
function sprintBoard(t) {
  const COLS = [
    { name: 'To Do', test: (i) => i <= 1 },
    { name: 'In Dev', test: (i) => i === 2 },
    { name: 'Review', test: (i) => i === 3 },
    { name: 'QA', test: (i) => i === 4 },
    { name: 'Ready', test: (i) => i >= 5 },
  ]
  const wip = t.inFlightTickets || []
  const cols = COLS.map((c) => {
    const items = wip.filter((k) => c.test(stageIndex(k.stage)))
    const chips = items.slice(0, 8).map((k) => `<div class="sp-chip${k.blocked ? ' blocked' : ''}">
      <span class="sp-chip-id">${jiraLink(k.id)}</span>
      <span class="sp-chip-title">${esc(k.title)}</span>
      ${k.blocked ? '<span class="sp-chip-flag">⛔</span>' : ''}
    </div>`).join('')
    const more = items.length > 8 ? `<div class="sp-more">+${items.length - 8} more</div>` : ''
    return `<div class="sp-col">
      <div class="sp-col-head">${c.name}<span class="sp-col-n">${items.length}</span></div>
      <div class="sp-col-body">${chips || '<div class="sp-col-empty"> · </div>'}${more}</div>
    </div>`
  }).join('')
  return `<div class="card"><div class="card-title">📋 Story status · current sprint<span class="ct-aside">${wip.length} in flight</span></div>
    <div class="sp-board">${cols}</div></div>`
}

function sprintWhy(sc) {
  const row = (k, v, neg) => `<div class="why-row"><span class="wr-k">${k}</span><span class="wr-v ${neg ? (v > 0 ? 'minus' : 'base') : (v >= 0 ? 'plus' : 'minus')}">${neg && v > 0 ? '−' : (!neg && v >= 0 ? '+' : '')}${Math.abs(v)}</span></div>`
  return `<div class="why-box">
    <div class="why-title">🧮 How this sprint score is calculated</div>
    <div class="why-row"><span class="wr-k">Base</span><span class="wr-v base">100</span></div>
    ${row(`Behind time-pace (${sc.breakdown.behindGap}% gap)`, sc.breakdown.pBehind, true)}
    ${row(`Stalled work (${sc.breakdown.stalledRatio}% of scope)`, sc.breakdown.pStalled, true)}
    ${row(`Momentum vs last sprint (${sc.breakdown.velocityDelta >= 0 ? '+' : ''}${sc.breakdown.velocityDelta}%)`, sc.breakdown.pVel, false)}
    <div class="why-total"><span class="wt-k">Sprint health</span><span class="wt-v" style="color:${statusColor(sc.status)}">${sc.score}/100 · ${String(sc.status).replace('-', ' ')}</span></div>
    <div class="why-foot">Score = 100 − 50· (pace gap) − 40· (stalled ratio) + 10· (momentum). A team that has delivered as much of its committed scope as the sprint clock has elapsed scores ~100; falling behind, or piling up stalled work, pulls it down.</div>
  </div>`
}

function sprintBody(snap) {
  const teams = snap.teams
  // Resolve the selected team (default: first non-center, else first).
  const sel = teams.find((t) => t.id === sprintTeam) || teams.find((t) => !t.isCenter) || teams[0]
  if (!sel) return `<div class="dash-body"><div class="empty-note">No team data.</div></div>`
  sprintTeam = sel.id
  const sc = sprintScore(snap, sel)
  const color = statusColor(sc.status)
  const opts = teams.map((t) => `<option value="${esc(t.id)}" ${t.id === sel.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
  const inits = (snap.initiatives || []).filter((i) => i.teamId === sel.id)
  const initOk = inits.filter((i) => i.status === 'on-track').length
  const initRisk = inits.filter((i) => i.status === 'at-risk').length
  const initBlk = inits.filter((i) => i.status === 'blocked').length

  const stat = (v, l, c) => `<div class="sp-stat"><div class="sp-stat-val"${c ? ` style="color:${c}"` : ''}>${v}</div><div class="sp-stat-lbl">${l}</div></div>`

  return `<div class="dash-body">
    <div class="sp-pagehead">
      <div>
        <div class="section-label">Sprint health</div>
        <div class="sp-question">Is this team's sprint on pace to land its committed scope?</div>
      </div>
      <div class="sp-teamselect-wrap">
        <label class="sp-teamselect-lbl" for="sprintTeamSelect">Team</label>
        <select class="lead-team-select" id="sprintTeamSelect">${opts}</select>
      </div>
    </div>

    <div class="sp-hero">
      <div class="card sp-scorecard">
        <div class="sp-score-top">
          <div><div class="sp-team-name">${esc(sel.name)}</div><div class="sp-team-board t-mono">${esc(sel.board)}</div></div>
          <span class="health-pill ${sc.status === 'on-track' ? 'hp-green' : sc.status === 'at-risk' ? 'hp-yellow' : 'hp-red'}">${sc.status === 'on-track' ? '🟢 On track' : sc.status === 'at-risk' ? '🟡 At risk' : '🔴 Behind'}</span>
        </div>
        ${sel.activeSprint ? `<div class="sp-activesprint t-mono">⬡ ${esc(sprintLabel(sel.activeSprint))}${sc.daysLeft != null ? ` · ${sc.daysLeft}d left` : ''}</div>` : ''}
        <div class="sp-bigscore" style="color:${color}">${sc.score}<span>/100</span></div>
        <div class="sp-bigscore-lbl">Sprint health score</div>
        <div class="sp-stats">
          ${stat(sc.shipped, 'delivered', 'var(--circuit)')}
          ${stat(sel.inFlight, 'in flight')}
          ${stat(sel.stalled, 'stalled', sel.stalled > 0 ? 'var(--ember)' : '')}
          ${stat(sel.backlog ?? 0, 'backlog')}
        </div>
      </div>
      ${scopeGauge(sc).replace('<div class="sp-gauge">', '<div class="card sp-gauge">')}
    </div>

    ${sprintWhy(sc)}

    ${sprintBoard(snap.teams.find((t) => t.id === sel.id))}

    <div class="card sp-initsum">
      <div class="card-title">🎯 ${esc(sel.name)} initiatives this sprint<span class="ct-aside">${inits.length} active</span></div>
      <div class="sp-initstats">
        ${initOk ? `<span class="sp-ipill" style="color:var(--circuit)">${initOk} on track</span>` : ''}
        ${initRisk ? `<span class="sp-ipill" style="color:var(--amber)">${initRisk} at risk</span>` : ''}
        ${initBlk ? `<span class="sp-ipill" style="color:var(--ember)">${initBlk} blocked</span>` : ''}
        ${!inits.length ? '<span class="empty-note">No initiatives mapped to this team.</span>' : ''}
      </div>
    </div>
  </div>`
}

function wireSprint(snap) {
  document.getElementById('sprintTeamSelect')?.addEventListener('change', (e) => {
    sprintTeam = e.target.value
    lastMode = null   // force a full re-render of the sprint body
    render(snapshot)
  })
}

function leadershipBody(snap) {
  const L = snap.leadership || {}
  return `<div class="dash-body">
    <div class="section-label">Executive briefing</div>
    ${execSummary(snap)}
    ${todayStory(snap)}
    <div class="section-label" style="margin-top:8px">Company initiatives · leadership health check</div>
    ${leadershipRollup(L, snap)}
    ${sprintHealth(snap)}
    ${strategicMetrics(L, snap)}
    <div class="section-label lead-table-head" style="margin-top:8px">All initiatives ${filterControls(snap)}</div>
    <div id="leadTableMount"><div class="card li-card"><div class="li-rag-legend">${ragLegend()}</div>${initiativeGroups(snap)}</div></div>
    <div class="section-label" style="margin-top:8px">Business translation</div>
    ${businessBridge(snap)}
  </div>`
}

function wireLeadership(snap) {
  const remount = () => {
    const mount = document.getElementById('leadTableMount')
    if (mount) mount.innerHTML = `<div class="card li-card"><div class="li-rag-legend">${ragLegend()}</div>${initiativeGroups(snap)}</div>`
    dashEl.querySelectorAll('.lead-chip').forEach((c) => c.classList.toggle('active', c.dataset.kind === leadFilter.kind))
  }
  dashEl.querySelectorAll('.lead-chip').forEach((c) => c.addEventListener('click', () => { leadFilter.kind = c.dataset.kind; remount() }))
  document.getElementById('leadTeamSelect')?.addEventListener('change', (e) => { leadFilter.team = e.target.value; remount() })
  document.getElementById('leadSearch')?.addEventListener('input', (e) => { leadSearch = e.target.value; remount(); document.getElementById('leadSearch')?.focus() })
}

// Hidden easter egg · revealed only by clicking the hex logo in the header.
function agentsPanel() {
  const rows = [
    ['Health agent', 'health.js', '100 − 15· breaches − (3/6/9)· blockers − 40· stalledRatio − 10· wipAge + velocity', '≥75 healthy · 40–74 at-risk · <40 or ≥2 breaches → blocked'],
    ['SLA agent', 'sla.js', 'age vs 24–32h window', '≥32h breach · 24–32h warning · ≥18h approaching'],
    ['Effort agent', 'effort.js', 'shipped ÷ (shipped + 0.5· inFlight + 0.75· stalled)', '≥0.8 Strong · ≥0.6 Good · ≥0.4 Blocked · else Critical'],
    ['Initiative agent', 'deriveInitiatives.js', 'done ÷ total children', 'blocked if any child blocked · at-risk if sizable & 0% done'],
    ['Queue depth', 'queueDepth.js', 'tickets at Code Review · QA Done · Ready to Deploy', 'high count = review bottleneck or deploy-queue jam'],
    ['Cycle time', 'cycleTime.js', 'avg hours per stage + P90 ticket age', 'bottleneck = stage with highest avg · P90 catches zombie tickets'],
  ]
  return `<div class="detail-panel">
    <div class="detail-top">
      <div><div class="detail-title">🤖 Scoring Agents · deterministic & explainable</div><div class="detail-sub">No LLM in the score · every health number is pure math · you found the easter egg 🥚</div></div>
      <button class="close-btn">✕ Close</button>
    </div>
    ${rows.map(([n, f, eq, th]) => `<div class="agent-formula">
      <div class="af-head"><span class="af-name">${esc(n)}</span><span class="t-mono af-file">${esc(f)}</span></div>
      <div class="t-mono af-eq">${esc(eq)}</div>
      <div class="af-th">${esc(th)}</div>
    </div>`).join('')}
    <div class="agent-foot">Click any team card to see its exact score breakdown applied to live numbers.</div>
  </div>`
}
function openAgents() {
  overlayEl.innerHTML = agentsPanel()
  overlayEl.classList.add('open')
  overlayEl.querySelector('.close-btn')?.addEventListener('click', closeDetail)
}

// ── Team detail modal ───────────────────────────────────────────────────────
function shippedRows(t) {
  return (t.shippedTickets || []).map((k) => `<div class="ticket-item ti-green"><div><div class="ti-id">${jiraLink(k.id)}</div><div class="ti-name">${esc(k.title)}</div></div><div class="ti-right"><div class="ti-stage">Done</div><div class="ti-age">${esc(k.day)}</div></div></div>`).join('') || '<div class="empty-note"> · </div>'
}
function ticketRow(k) {
  const cls = k.blocked ? 'ti-red' : (k.days >= 5 ? 'ti-amber' : 'ti-blue')
  const c = k.blocked ? ' style="color:var(--ember)"' : ''
  return `<div class="ticket-item ${cls}"><div><div class="ti-id">${jiraLink(k.id)}</div><div class="ti-name">${esc(k.title)}</div></div><div class="ti-right"><div class="ti-stage"${c}>${esc(k.stage)}</div><div class="ti-age"${c}>${k.blocked ? 'blocked · ' : ''}${esc(k.days)}d</div></div></div>`
}
// Build a collapsible <details> dropdown per stage from a list of tickets.
// openBlocked: auto-expand stages that contain a blocked ticket.
function stageDropdowns(items, { openBlocked = false } = {}) {
  const byStage = new Map()
  for (const k of items) {
    if (!byStage.has(k.stage)) byStage.set(k.stage, [])
    byStage.get(k.stage).push(k)
  }
  const stages = [...byStage.keys()].sort((a, b) => byStage.get(b).length - byStage.get(a).length)
  return stages.map((stage) => {
    const rows = byStage.get(stage)
    const blk = rows.filter((r) => r.blocked).length
    const open = openBlocked && blk > 0
    return `<details class="grp stage-grp"${open ? ' open' : ''}>
      <summary class="grp-summary"><span class="grp-chevron">▸</span><span class="grp-name">${esc(stage)}</span><span class="grp-count">${rows.length}</span>${blk ? `<span class="grp-flag red">${blk} blocked</span>` : ''}</summary>
      <div class="grp-body">${rows.map(ticketRow).join('')}</div>
    </details>`
  }).join('')
}
function inflightRows(t) {
  const items = t.inFlightTickets || []
  if (!items.length) return '<div class="empty-note"> · </div>'
  return stageDropdowns(items, { openBlocked: true })  // surface blocked stages open
}
function backlogSection(t) {
  const items = t.backlogTickets || []
  if (!items.length) return ''
  return `<details class="grp backlog-grp">
    <summary class="grp-summary"><span class="grp-chevron">▸</span><span class="grp-name">📥 Backlog</span><span class="grp-count">${items.length}</span><span class="grp-hint">not started · click to expand</span></summary>
    <div class="grp-body">${stageDropdowns(items)}</div>
  </details>`
}
function whyBox(t) {
  const b = t.healthBreakdown || {}
  const row = (k, v, cls) => `<div class="why-row"><span class="wr-k">${esc(k)}</span><span class="wr-v ${cls}">${cls === 'plus' && Number(v) > 0 ? '+' : ''}${esc(v)}</span></div>`
  return `<div class="why-box">
    <div class="why-title">🧮 Why this score</div>
    <div class="why-row"><span class="wr-k">Base</span><span class="wr-v base">100</span></div>
    ${row(`SLA breaches (${b.breaches ?? 0})`, b.sla ?? 0, 'minus')}
    ${row(`Active blockers (${b.blockerCount ?? 0})`, b.blockers ?? 0, 'minus')}
    ${(() => { const s = b.blockersByState || {}; const parts = [s.warning && `${s.warning} warning (−9)`, s.approaching && `${s.approaching} approaching (−6)`, s.ok && `${s.ok} ok (−3)`].filter(Boolean); return parts.length ? `<div class="why-row why-sub"><span class="wr-k">↳ by age</span><span class="wr-v wr-sub">${parts.join(' · ')}</span></div>` : '' })()}
    ${row(`Stalled ratio (${b.stalledRatio ?? 0})`, b.stalled ?? 0, 'minus')}
    ${row(`WIP age (${b.avgInFlightDays ?? 0}d avg)`, b.wip ?? 0, 'minus')}
    ${row(`Velocity (Δ ${b.velocityDelta ?? 0})`, b.velocity ?? 0, (b.velocity ?? 0) >= 0 ? 'plus' : 'minus')}
    <div class="why-total"><span class="wt-k">Health score</span><span class="wt-v" style="color:${healthColorVar(t)}">${esc(t.healthScore)}/100 · ${esc(t.health)}</span></div>
  </div>`
}
function detailPanel(t, snap) {
  const escalated = (t.blockers || []).filter((b) => b.escalate)
  const alert = escalated.length
    ? `<div class="alert-box"><strong style="color:var(--ember)">🚨 Action needed:</strong> ${escalated.map((b) => `${esc(b.ticketId)} waiting ${esc(b.age)}h on ${esc(b.infraTicket)}${b.assignee ? ' (' + esc(b.assignee) + ')' : ''}`).join('; ')}. ${escalated.some((b) => b.slaState === 'breach') ? 'Exceeds the 24–32h SLA · escalate at standup today.' : 'Flagged for escalation · monitor closely.'}</div>`
    : ''
  return `<div class="detail-panel">
    <div class="detail-top">
      <div><div class="detail-title">${esc(t.name)} · Sprint ${esc(snap.sprint.number)}</div><div class="detail-sub">${esc(t.board)}${(t.systems || []).length ? ' · ' + esc(t.systems.join(' · ')) : ''}</div></div>
      <button class="close-btn">✕ Close</button>
    </div>
    <div>
      <span class="person-chip"><span class="pc-role">PM:</span><span class="pc-name">${esc(t.pm)}</span></span>
      ${t.activeSprint ? `<span class="person-chip sprint-chip"><span class="pc-role">Sprint:</span><span class="pc-name">${esc(sprintLabel(t.activeSprint))}</span></span>` : ''}
      ${(t.systems || []).map((s) => `<span class="person-chip"><span class="pc-name">${esc(s)}</span></span>`).join('')}
    </div>
    ${whyBox(t)}
    ${cyclePanel(t)}
    <div class="detail-grid">
      <div>
        <div class="sub-title">✅ Recently shipped (${esc((t.shippedTickets || []).length)} of ${esc(t.shipped)})</div>
        ${shippedRows(t)}
      </div>
      <div>
        <div class="sub-title">🔄 Active · in flight (${esc(t.inFlight)})</div>
        ${inflightRows(t)}
        ${backlogSection(t)}
        <div class="sub-title">📅 Sprint cadence</div>
        <div class="cadence-box"><div>Standup: ${esc(t.standup)}</div><div>Sprint Planning: ${esc(t.sprintPlanning)}</div></div>
      </div>
    </div>
    ${alert}
  </div>`
}
function openDetail(teamId) {
  const t = snapshot?.teams.find((x) => x.id === teamId)
  if (!t) return
  overlayEl.innerHTML = detailPanel(t, snapshot)
  overlayEl.classList.add('open')
  overlayEl.querySelector('.close-btn')?.addEventListener('click', closeDetail)
}
function closeDetail() { overlayEl.classList.remove('open') }

// ── Master render ─────────────────────────────────────────────────────────────
function teamBody(snap) {
  return `<div class="dash-body">`
    + narrative(snap)
    + `<div class="section-label" style="margin-top:8px">All teams · AI health overview</div>`
    + `<div class="exec-grid">${snap.teams.map((t) => teamCard(t, snap)).join('')}</div>`
    + `</div>`
}

function render(snap) {
  snapshot = snap
  const changed = snap.hash !== lastHash || mode !== lastMode
  if (!changed && dashEl.dataset.rendered) {
    const sub = document.getElementById('dashSub')
    if (sub) sub.textContent = `Sprint ${snap.sprint.number} · Week of ${snap.sprint.week} · Updated ${timeAgo(snap.generatedAt)}`
    return
  }
  lastHash = snap.hash
  lastMode = mode
  // Team View is the only view · Sprint + Leadership have been removed.
  dashEl.innerHTML = header(snap) + teamBody(snap)
  dashEl.dataset.rendered = '1'
  dashEl.querySelectorAll('.team-card').forEach((el) => {
    el.addEventListener('click', () => openDetail(el.dataset.team))
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(el.dataset.team) } })
  })
  document.getElementById('dashRefresh')?.addEventListener('click', manualRefresh)
  document.getElementById('themeToggle')?.addEventListener('click', cycleTheme)
  document.getElementById('agentEgg')?.addEventListener('click', openAgents)
}

function showError(msg) {
  dashEl.innerHTML = `<div class="dash-body"><div class="card"><div class="card-title">⚠ Can't reach the Hive Pulse API</div><div class="empty-note">Tried <span class="t-mono">${esc(API)}/api/snapshot</span> · ${esc(msg)}.<br><br>Start the backend in a terminal:<br><span class="t-mono">cd hive-pulse-server &amp;&amp; npm run dev</span><br><br>Then click <strong>↻ Refresh</strong>.</div><button class="dash-refresh" id="dashRetry" style="margin-top:12px">↻ Retry</button></div></div>`
  document.getElementById('dashRetry')?.addEventListener('click', load)
}

// ── Data plumbing ──────────────────────────────────────────────────────────────
async function load() {
  try {
    const r = await fetch(`${API}/api/snapshot`, { cache: 'no-store', headers: authHeaders() })
    if (r.status === 401) { onUnauthorized(); return false }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    render(await r.json())
    return true
  } catch (err) {
    if (!snapshot) showError(err.message)
    return false
  }
}

function connectSSE() {
  if (es || typeof EventSource === 'undefined') { if (!es) startPolling(); return }
  try {
    // EventSource can't send headers, so the token rides as a query param.
    es = new EventSource(`${API}/api/stream${authToken ? `?token=${encodeURIComponent(authToken)}` : ''}`)
    es.addEventListener('snapshot', (e) => { try { render(JSON.parse(e.data)) } catch { /* ignore malformed frame */ } })
    es.onopen = stopPolling                 // live again → no need to poll
    es.onerror = startPolling               // outage (or auth) → poll; load() surfaces a 401
  } catch {
    startPolling()
  }
}
function startPolling() { if (!pollTimer) pollTimer = setInterval(load, 30000) }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }

async function manualRefresh() {
  const btn = document.getElementById('dashRefresh')
  if (btn) { btn.disabled = true; btn.textContent = '↻ …' }
  try { await fetch(`${API}/api/ingest`, { method: 'POST', headers: authHeaders() }) } catch { /* server may be mock-only */ }
  await load()
  if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh' }
}

// ── Login gate ────────────────────────────────────────────────────────────────
// boot() is the single entry after reveal: load the snapshot (which 401s into the
// login screen if a password is required and we don't have a valid token), then
// open the live stream only once we're authenticated.
async function boot() {
  if (await load()) connectSSE()
}
function onUnauthorized() {
  if (es) { es.close(); es = null }
  stopPolling()
  setToken('')
  showLogin(snapshot ? 'Your session expired. Please sign in again.' : '')
}
function showLogin(msg = '') {
  dashEl.innerHTML = `<div class="login-screen"><form class="login-card" id="loginForm" autocomplete="on">
    <div class="login-mark">${hexMark()}</div>
    <div class="login-title">Hive Pulse</div>
    <div class="login-sub">This dashboard is private. Enter the team access password.</div>
    <input class="login-input" id="loginPw" type="password" placeholder="Access password" autocomplete="current-password">
    <button class="login-btn" type="submit">Unlock →</button>
    <div class="login-error${msg ? ' show' : ''}" id="loginErr">${esc(msg)}</div>
  </form></div>`
  document.getElementById('loginForm')?.addEventListener('submit', (e) => { e.preventDefault(); doLogin() })
  document.getElementById('loginPw')?.focus()
}
async function doLogin() {
  const pw = document.getElementById('loginPw')?.value || ''
  const btn = dashEl.querySelector('.login-btn')
  if (!pw) return
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…' }
  try {
    const r = await fetch(`${API}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }),
    })
    if (r.ok) { const j = await r.json(); setToken(j.token); boot(); return }
    if (r.status === 429) { loginError('Too many attempts. Wait a few minutes and try again.'); return }
    loginError('Incorrect password. Try again.')
  } catch {
    loginError('Can’t reach the server. Check your connection.')
  }
}
function loginError(msg) {
  const btn = dashEl.querySelector('.login-btn')
  if (btn) { btn.disabled = false; btn.textContent = 'Unlock →' }
  const err = document.getElementById('loginErr')
  if (err) { err.textContent = msg; err.classList.add('show') }
  const pw = document.getElementById('loginPw'); if (pw) { pw.value = ''; pw.focus() }
}

// ── Reveal (boots the dashboard; the scroll landing + its CTA are stashed) ────
function reveal({ scroll = true } = {}) {
  if (revealed) { if (scroll) dashEl.scrollIntoView({ behavior: 'smooth' }); return }
  revealed = true
  if (skipEl) skipEl.hidden = true   // hide skip button once dashboard is revealed
  dashEl.hidden = false
  dashEl.classList.add('revealing')
  // If the scroll landing is ever restored, let GSAP ScrollTrigger recalc.
  window.dispatchEvent(new Event('resize'))
  if (scroll) requestAnimationFrame(() => dashEl.scrollIntoView({ behavior: 'smooth' }))
  boot()   // load snapshot → shows the login screen if a password is required
}

// ── Wire-up ─────────────────────────────────────────────────────────────────
applyTheme()   // restore saved theme before first paint
if (ctaEl)  ctaEl.addEventListener('click',  (e) => { e.preventDefault(); reveal() })
if (skipEl) skipEl.addEventListener('click', (e) => { e.preventDefault(); reveal() })
// Scroll experience stashed · boot straight into the dashboard (Team View).
// No landing to scroll past, so skip the scroll-into-view on this initial reveal.
reveal({ scroll: false })
overlayEl?.addEventListener('click', (e) => { if (e.target === overlayEl) closeDetail() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail() })

// Keep "Updated … ago" honest between pushes.
setInterval(() => {
  if (!snapshot) return
  const sub = document.getElementById('dashSub')
  if (sub) sub.textContent = `Sprint ${snapshot.sprint.number} · Week of ${snapshot.sprint.week} · Updated ${timeAgo(snapshot.generatedAt)}`
}, 30000)
