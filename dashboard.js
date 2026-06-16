/* ═══════════════════════════════════════════════════════════════════════════
   HIVE PULSE — Live Dashboard (data layer + renderer)
   The destination of the "View Live Dashboard →" CTA. 100% bound to the
   backend: GET /api/snapshot on reveal, then live SSE /api/stream (30s fetch
   fallback). No hardcoded business data — every number comes from the scoring
   agents. The 3D scroll experience (main.js) is untouched.
═══════════════════════════════════════════════════════════════════════════ */

// VITE_API_URL is baked in at build time by Vite (set it in Vercel's project env vars).
// window.HIVE_PULSE_API overrides at runtime (useful for quick staging swaps).
const API = (window.HIVE_PULSE_API || import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/\/+$/, '')

// ── Mount points (declared in index.html) ────────────────────────────────────
const dashEl    = document.getElementById('dashboard')
const tickerEl  = document.getElementById('pulse-ticker')
const overlayEl = document.getElementById('detail-overlay')
const backTopEl = document.getElementById('backTop')
const ctaEl     = document.querySelector('.cta')
const skipEl    = document.getElementById('skipBtn')

// ── State ─────────────────────────────────────────────────────────────────────
let snapshot = null
let lastHash = null
let revealed = false
let es = null
let pollTimer = null
let mode = 'team'   // 'team' | 'leadership' — toggled in the header
let lastMode = null
let leadFilter = { kind: 'all', team: 'all' }   // leadership-view filters

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const pct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))
const DEP_LABELS = ['lox', 'pmx', 'uwx', 'akx', 'lgx']
const labelClass = (l) => DEP_LABELS.includes(String(l).toLowerCase()) ? String(l).toLowerCase() : 'generic'

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

// "LO2026.06.29 · ends Jun 29" — compact active-sprint label.
function sprintLabel(s) {
  if (!s || !s.name) return ''
  const end = s.endDate ? new Date(s.endDate) : null
  const ends = end && !isNaN(end) ? ` · ends ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''
  return `${s.name}${ends}`
}
function healthPill(t) {
  if (t.health === 'healthy') return { cls: 'hp-green', label: '🟢 Healthy' }
  if (t.health === 'blocked') return { cls: 'hp-red', label: '🔴 Blocked' }
  return { cls: 'hp-yellow', label: t.isCenter ? '🟡 Backlog' : '🟡 At Risk' }
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
      <div class="dash-title"><span id="agentEgg" class="agent-egg" title="">${hexMark()}</span> Hive Pulse — Live Status Dashboard</div>
      <div class="dash-sub" id="dashSub">Sprint ${esc(snap.sprint.number)} · Week of ${esc(snap.sprint.week)} · Updated ${esc(timeAgo(snap.generatedAt))}</div>
    </div>
    <div class="dash-meta">
      <div class="view-toggle" role="tablist">
        <button class="vt-btn ${mode === 'team' ? 'active' : ''}" data-mode="team">Team View</button>
        <button class="vt-btn ${mode === 'leadership' ? 'active' : ''}" data-mode="leadership">Leadership</button>
      </div>
      <span class="demo-pill ${cls}">${txt}</span>
      <span class="live-dot"></span><span>Live</span>
      <button class="dash-refresh" id="dashRefresh">↻ Refresh</button>
    </div>
  </div>`
}

function narrative(snap) {
  const n = snap.sprint.narrative
  if (!n) return ''
  return `<div class="narrative-box"><span class="nb-mark">🧠</span><div class="nb-text"><span class="nb-tag">AI Exec Summary</span>${esc(n)}</div></div>`
}

function metricsRow(snap) {
  const s = snap.sprint
  const down = String(s.trend).startsWith('-')
  const infraColor = s.infraAvgResponse >= 32 ? 'var(--ember)' : 'var(--amber)'
  return `
  <div class="metrics-row">
    <div class="metric-card"><div class="metric-val">${esc(s.totalShipped)}</div><div class="metric-lbl">Tickets shipped</div><div class="metric-trend" style="color:${down ? 'var(--ember)' : 'var(--circuit)'}">${down ? '↓' : '↑'} ${esc(s.trend)} vs last sprint</div></div>
    <div class="metric-card"><div class="metric-val" style="color:var(--ember)">${esc(s.activeBlockers)}</div><div class="metric-lbl">Active blockers</div><div class="metric-trend" style="color:var(--ember)">${esc(s.blockersPastSla)} past SLA threshold</div></div>
    <div class="metric-card"><div class="metric-val" style="color:var(--amber)">${esc(s.infraAvgResponse)}h</div><div class="metric-lbl">Infra avg response</div><div class="metric-trend" style="color:${infraColor}">${s.infraAvgResponse >= 24 ? '↑ within/above 24–32h SLA' : '↓ under SLA'}</div></div>
    <div class="metric-card"><div class="metric-val" style="color:var(--circuit)">${esc(s.achSuccessRate)}%</div><div class="metric-lbl">ACH success rate</div><div class="metric-trend" style="color:var(--circuit)">Payments processor KPI</div></div>
  </div>`
}

function teamCard(t, snap) {
  const pill = healthPill(t)
  const color = healthColorVar(t)
  const isInfra = !!t.isCenter
  const badge = isInfra ? (snap.infraBlockers?.length || 0) : (t.blockers?.length || 0)
  const badgeStyle = isInfra ? ' style="background:var(--amber);color:#000"' : ''
  const stats = isInfra
    ? [
        [t.openTickets ?? t.inFlight, 'open tickets', 'var(--ember)'],
        [t.shipped, 'deploys done', ''],
        [`${snap.sprint.infraAvgResponse}h`, 'avg response', 'var(--amber)'],
        [t.teamsWaiting ?? 0, 'teams waiting', ''],
      ]
    : [
        [t.shipped, 'shipped', ''],
        [t.inFlight, 'in-flight', ''],
        [t.stalled, 'stalled', t.stalled > 0 ? 'var(--ember)' : ''],
        [t.blockers.length, t.blockers[0]?.label ? `${t.blockers[0].label} blocked` : 'blockers', t.blockers.length > 0 ? 'var(--ember)' : ''],
      ]
  return `
  <div class="team-card ${t.health === 'blocked' ? 'blocked-glow' : ''}" data-team="${esc(t.id)}" role="button" tabindex="0">
    ${badge > 0 ? `<div class="blocker-badge"${badgeStyle}>${badge}</div>` : ''}
    <div class="tc-top">
      <div><div class="tc-name">${esc(t.name)}</div><div class="tc-board t-mono">${esc(t.board)}</div></div>
      <span class="health-pill ${pill.cls}">${pill.label}</span>
    </div>
    ${t.activeSprint ? `<div class="tc-sprint t-mono">⬡ ${esc(sprintLabel(t.activeSprint))}</div>` : ''}
    <div class="health-meter">
      <div class="hm-head"><span class="hm-label">AI Health</span><span class="hm-score">${esc(t.healthScore)}<span>/100</span></span></div>
      <div class="hm-track"><div class="hm-fill" style="width:${pct(t.healthScore)}%;background:${color}"></div></div>
    </div>
    <div class="tc-stats">
      ${stats.map(([v, l, c]) => `<div class="tc-stat"><div class="tc-val"${c ? ` style="color:${c}"` : ''}>${esc(v)}</div><div class="tc-lbl">${esc(l)}</div></div>`).join('')}
    </div>
  </div>`
}

function blockersCard(snap) {
  const items = snap.infraBlockers.map((b) => `
    <div class="blocker-item">
      <span class="b-label ${labelClass(b.label)}">${esc(b.label || '—')}</span>
      <div class="b-text"><strong>${esc(b.ticketId)}:</strong> ${esc(b.description || '')}<span class="b-id">${esc(b.infraTicket)}${b.assignee ? ' · ' + esc(b.assignee) : ''}</span></div>
      <span class="b-age ${ageClass(b)}">${esc(b.age)}h${b.escalate ? ' ⚠' : ''}</span>
    </div>`).join('') || `<div class="empty-note">No cross-team blockers 🎉</div>`
  const past = snap.infraBlockers.filter((b) => b.escalate)
  const foot = past.length
    ? `<div class="card-foot alert">⚠ ${past.map((b) => `${esc(b.ticketId)} (${esc(b.age)}h)`).join(' and ')} exceed SLA — SMs should escalate at standup today</div>`
    : ''
  return `<div class="card"><div class="card-title">🚨 Cross-Team Infra Blockers<span class="ct-aside">HUB Central Kanban</span></div>${items}${foot}</div>`
}

function ceremoniesCard(snap) {
  const items = snap.ceremonies.map((c) => {
    const label = c.state === 'done' ? '✓ Done' : c.state === 'next' ? '▶ Next up' : 'Upcoming'
    return `<div class="ceremony-item"><div><div class="cer-name">${esc(c.name)}</div></div><div class="cer-time">${esc(c.time)}<div class="cer-state ${esc(c.state)}">${label}</div></div></div>`
  }).join('') || `<div class="empty-note">No ceremonies scheduled today.</div>`
  return `<div class="card"><div class="card-title">📅 Today's Ceremonies — ${esc(snap.sprint.week)}</div>${items}</div>`
}

function lifecycleCard(snap) {
  const rows = snap.lifecycle.map((r) => {
    const team = snap.teams.find((t) => t.id === r.teamId)
    const blk = team?.blockers.find((b) => b.ticketId === r.id)
    const chips = r.stages.map((s) => `<div class="lc-stage ${s.state}">${s.state === 'blocked' ? '🔴 ' : s.state === 'active' ? '▶ ' : ''}${esc(s.label)}</div>`).join('')
    const note = (r.blocked && blk)
      ? `<div class="lc-note alert">⚠ Blocked on ${esc(blk.infraTicket)}${blk.assignee ? ' (' + esc(blk.assignee) + ')' : ''} — ${esc(blk.age)}h waiting${blk.escalate ? ', exceeds SLA' : ''}</div>`
      : `<div class="lc-note dim">${esc(r.stage)} · ${esc(r.days)} day${r.days === 1 ? '' : 's'} in flight</div>`
    return `<div class="lc-row"><div class="lc-head"><div class="lc-title">${esc(r.id)} · ${esc(r.title)}</div></div><div class="lifecycle">${chips}</div>${note}</div>`
  }).join('') || `<div class="empty-note">No in-flight tickets.</div>`
  return `<div class="card"><div class="card-title">🔄 Live Ticket Lifecycle — Key In-Flight</div>${rows}</div>`
}

function roiCard(snap) {
  const order = [...snap.teams].sort((a, b) => b.effortScore - a.effortScore)
  const rows = order.map((t) => {
    const color = healthColorVar(t)
    return `<div class="roi-row"><div class="roi-name"><div class="roi-dot" style="background:${color}"></div>${esc(t.shortName || t.name)}</div><div class="roi-bar-wrap"><div class="roi-bar" style="width:${pct(t.effortScore * 100)}%;background:${color}"></div></div><div class="roi-verdict" style="color:${color}">${esc(t.effortLabel)}</div></div>`
  }).join('')
  return `<div class="card"><div class="card-title">📊 Effort vs. Output — Sprint ${esc(snap.sprint.number)}</div><div class="card-hint">Tickets shipped ÷ dev capacity consumed · effort-scoring agent</div>${rows}</div>`
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
    return `<div class="card"><div class="card-title">🎯 Initiatives & Epics — Progress</div><div class="empty-note">No initiatives tracked.</div></div>`
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
    // Blocked first, then at-risk, then by most progress — surface what needs attention.
    const items = byTeam.get(tid).sort((a, b) =>
      (rank[a.status] - rank[b.status]) || (b.progressPct - a.progressPct))
    const blocked = items.filter((i) => i.status === 'blocked').length
    const atRisk = items.filter((i) => i.status === 'at-risk').length
    const flag = blocked ? `<span class="grp-flag red">${blocked} blocked</span>` : atRisk ? `<span class="grp-flag amber">${atRisk} at risk</span>` : ''
    const rows = items.map((i) => initiativeRow(i, snap)).join('')
    // All teams collapsed by default — click a team to expand its initiatives.
    return `<details class="grp">
      <summary class="grp-summary"><span class="grp-chevron">▸</span><span class="grp-name">${esc(team?.name || tid)}</span><span class="grp-count">${items.length}</span>${flag}</summary>
      <div class="grp-body">${rows}</div>
    </details>`
  }).join('')

  return `<div class="card"><div class="card-title">🎯 Initiatives &amp; Epics — by team<span class="ct-aside">${snap.initiatives.length} active epics</span></div>${groups}</div>`
}

// ── LEADERSHIP VIEW — company-level initiative health (the shared PM pitch) ────
const statusColor = (s) => s === 'on-track' ? 'var(--circuit)' : s === 'at-risk' ? 'var(--amber)' : 'var(--ember)'

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

// Tier-3 strategic metrics the PMs asked for but Jira can't yet supply.
function strategicPending(L) {
  const cards = [
    ['Outcome hit rate', '% of shipped epics that hit their success metric', 'needs a "Success Metric" field + post-ship review'],
    ['Stakeholder alignment', '% of epics with sign-off before dev started', 'needs a sign-off field / checklist on each epic'],
    ['Discovery → Delivery', 'ratio of time/tickets in discovery vs delivery', 'needs Discovery vs Delivery tagging on tickets'],
    ['Date committed', 'when the business team signs off', 'needs a business-sign-off date field on initiatives'],
  ]
  return `<details class="grp strat-pending">
    <summary class="grp-summary"><span class="grp-chevron">▸</span><span class="grp-name">📐 Strategic metrics</span><span class="grp-flag amber">pending Jira setup</span><span class="grp-hint">4 metrics ready once fields exist</span></summary>
    <div class="grp-body"><div class="strat-grid">
      ${cards.map(([name, desc, need]) => `<div class="strat-card">
        <div class="strat-name">${esc(name)}</div>
        <div class="strat-val">—</div>
        <div class="strat-desc">${esc(desc)}</div>
        <div class="strat-need">⚙ ${esc(need)}</div>
      </div>`).join('')}
    </div></div>
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
    ${chip('all', 'All')}${chip('tech', 'Tech')}${chip('ops', 'Ops')}
    <select class="lead-team-select" id="leadTeamSelect">${teamOpts}</select>
  </span>`
}

function filteredInitiatives(snap) {
  const rank = { blocked: 0, 'at-risk': 1, 'on-track': 2 }
  return (snap.initiatives || [])
    .filter((i) => leadFilter.kind === 'all' || (i.kind || 'tech') === leadFilter.kind)
    .filter((i) => leadFilter.team === 'all' || i.teamId === leadFilter.team)
    .sort((a, b) => (rank[a.status] - rank[b.status]) || (b.progressPct - a.progressPct))
}

function storyDetailRow(i) {
  const stories = i.stories || []
  if (!stories.length) return `<td colspan="8"><div class="story-empty">No linked stories — add child issues in Jira.</div></td>`
  const items = stories.map((s) => {
    const st = s.done ? 'done' : s.blocked ? 'blocked' : 'on-track'
    return `<div class="story-row">
      ${hexCell(st, 13)}
      <span class="story-id">${esc(s.id)}</span>
      <span class="story-title ${s.done ? 'is-done' : ''}">${esc(s.title)}</span>
      <span class="story-stage">${esc(s.stage)}${s.blocked ? ' · blocked' : ''}</span>
    </div>`
  }).join('')
  return `<td colspan="8"><div class="story-list">${items}</div></td>`
}

function initiativeTableRow(i, snap) {
  const team = snap.teams.find((t) => t.id === i.teamId)
  const color = statusColor(i.status)
  const kindBadge = (i.kind || 'tech') === 'ops'
    ? `<span class="kind-badge ops">Ops</span>`
    : `<span class="kind-badge tech">Tech</span>`
  return `<tr class="it-row" data-init="${esc(i.id)}" tabindex="0">
    <td class="it-hex">${hexCell(i.status)}</td>
    <td class="it-name">${esc(i.name)}<span class="it-id">${esc(i.id)}</span></td>
    <td>${esc(team?.shortName || i.teamId)}</td>
    <td>${kindBadge}</td>
    <td class="it-prog">
      <div class="it-bar-wrap"><div class="it-bar" style="width:${pct(i.progressPct)}%;background:${color}"></div></div>
      <span class="it-pct" style="color:${color}">${esc(i.progressPct)}%</span>
    </td>
    <td class="it-stories">${esc(i.doneChildren)}/${esc(i.totalChildren)}${i.blockedChildren ? ` <span style="color:var(--ember)">· ${esc(i.blockedChildren)}⛔</span>` : ''}</td>
    <td><span class="it-status" style="color:${color}">${esc(String(i.status).replace('-', ' '))}</span></td>
    <td class="it-chev"><span class="it-chevron">▸</span></td>
  </tr>
  <tr class="it-detail" data-detail="${esc(i.id)}" hidden>${storyDetailRow(i)}</tr>`
}

function initiativeTable(snap) {
  const rows = filteredInitiatives(snap)
  if (!rows.length) return `<div class="card"><div class="empty-note">No initiatives match this filter.</div></div>`

  // Group by team (in team-list order); rows within a team keep the blocked-first
  // sort from filteredInitiatives. A team sub-header leads each group.
  const order = snap.teams.map((t) => t.id)
  const byTeam = new Map()
  for (const i of rows) {
    if (!byTeam.has(i.teamId)) byTeam.set(i.teamId, [])
    byTeam.get(i.teamId).push(i)
  }
  const teamIds = [...byTeam.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))

  const body = teamIds.map((tid) => {
    const team = snap.teams.find((t) => t.id === tid)
    const items = byTeam.get(tid)
    const blocked = items.filter((i) => i.status === 'blocked').length
    const atRisk = items.filter((i) => i.status === 'at-risk').length
    const flag = blocked ? `<span class="grp-flag red">${blocked} blocked</span>`
      : atRisk ? `<span class="grp-flag amber">${atRisk} at risk</span>` : ''
    const header = `<tr class="it-group"><td colspan="8"><span class="itg-name">${esc(team?.name || tid)}</span><span class="itg-count">${items.length}</span>${flag}</td></tr>`
    return header + items.map((i) => initiativeTableRow(i, snap)).join('')
  }).join('')

  return `<div class="card lead-table-card"><table class="lead-table">
    <thead><tr><th class="th-hex">Health</th><th>Initiative</th><th>Team</th><th>Type</th><th>Completion</th><th>Stories</th><th>Status</th><th></th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

function leadershipBody(snap) {
  const L = snap.leadership || {}
  return `<div class="dash-body">
    <div class="section-label">Company initiatives — leadership health check</div>
    ${leadershipRollup(L, snap)}
    ${strategicPending(L)}
    <div class="section-label lead-table-head" style="margin-top:8px">All initiatives ${filterControls(snap)}</div>
    <div id="leadTableMount">${initiativeTable(snap)}</div>
  </div>`
}

function wireInitiativeRows() {
  const toggle = (row) => {
    const detail = row.nextElementSibling
    if (!detail || !detail.classList.contains('it-detail')) return
    const open = detail.hidden
    detail.hidden = !open
    row.classList.toggle('expanded', open)
  }
  dashEl.querySelectorAll('.it-row').forEach((row) => {
    row.addEventListener('click', () => toggle(row))
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(row) } })
  })
}
function wireLeadership(snap) {
  const remount = () => {
    const mount = document.getElementById('leadTableMount')
    if (mount) mount.innerHTML = initiativeTable(snap)
    // re-sync chip active states
    dashEl.querySelectorAll('.lead-chip').forEach((c) => c.classList.toggle('active', c.dataset.kind === leadFilter.kind))
    wireInitiativeRows()
  }
  dashEl.querySelectorAll('.lead-chip').forEach((c) => c.addEventListener('click', () => {
    leadFilter.kind = c.dataset.kind; remount()
  }))
  document.getElementById('leadTeamSelect')?.addEventListener('change', (e) => {
    leadFilter.team = e.target.value; remount()
  })
  wireInitiativeRows()
}

// Hidden easter egg — revealed only by clicking the hex logo in the header.
function agentsPanel() {
  const rows = [
    ['Health agent', 'health.js', '100 − 15·breaches − 6·blockers − 40·stalledRatio − 10·wipAge + velocity', '≥75 healthy · 40–74 at-risk · <40 or ≥1 breach → blocked'],
    ['SLA agent', 'sla.js', 'age vs 24–32h window', '≥32h breach · 24–32h warning · ≥18h approaching'],
    ['Effort agent', 'effort.js', 'shipped ÷ (shipped + 0.5·inFlight + 0.75·stalled)', '≥0.8 Strong · ≥0.6 Good · ≥0.4 Blocked · else Critical'],
    ['Initiative agent', 'deriveInitiatives.js', 'done ÷ total children vs expected pace', 'blocked if any child blocked · at-risk if behind pace'],
  ]
  return `<div class="detail-panel">
    <div class="detail-top">
      <div><div class="detail-title">🤖 Scoring Agents — deterministic & explainable</div><div class="detail-sub">No LLM in the score · every health number is pure math · you found the easter egg 🥚</div></div>
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
  return (t.shippedTickets || []).map((k) => `<div class="ticket-item ti-green"><div><div class="ti-id">${esc(k.id)}</div><div class="ti-name">${esc(k.title)}</div></div><div class="ti-right"><div class="ti-stage">Done</div><div class="ti-age">${esc(k.day)}</div></div></div>`).join('') || '<div class="empty-note">—</div>'
}
function ticketRow(k) {
  const cls = k.blocked ? 'ti-red' : (k.days >= 5 ? 'ti-amber' : 'ti-blue')
  const c = k.blocked ? ' style="color:var(--ember)"' : ''
  return `<div class="ticket-item ${cls}"><div><div class="ti-id">${esc(k.id)}</div><div class="ti-name">${esc(k.title)}</div></div><div class="ti-right"><div class="ti-stage"${c}>${esc(k.stage)}</div><div class="ti-age"${c}>${k.blocked ? 'blocked · ' : ''}${esc(k.days)}d</div></div></div>`
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
  if (!items.length) return '<div class="empty-note">—</div>'
  return stageDropdowns(items, { openBlocked: true })  // surface blocked stages open
}
function backlogSection(t) {
  const items = t.backlogTickets || []
  if (!items.length) return ''
  return `<details class="grp backlog-grp">
    <summary class="grp-summary"><span class="grp-chevron">▸</span><span class="grp-name">📥 Backlog</span><span class="grp-count">${items.length}</span><span class="grp-hint">not started — click to expand</span></summary>
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
    ${row(`Stalled ratio (${b.stalledRatio ?? 0})`, b.stalled ?? 0, 'minus')}
    ${row(`WIP age (${b.avgInFlightDays ?? 0}d avg)`, b.wip ?? 0, 'minus')}
    ${row(`Velocity (Δ ${b.velocityDelta ?? 0})`, b.velocity ?? 0, (b.velocity ?? 0) >= 0 ? 'plus' : 'minus')}
    <div class="why-total"><span class="wt-k">Health score</span><span class="wt-v" style="color:${healthColorVar(t)}">${esc(t.healthScore)}/100 · ${esc(t.health)}</span></div>
  </div>`
}
function detailPanel(t, snap) {
  const escalated = (t.blockers || []).filter((b) => b.escalate)
  const alert = escalated.length
    ? `<div class="alert-box"><strong style="color:var(--ember)">🚨 Action needed:</strong> ${escalated.map((b) => `${esc(b.ticketId)} waiting ${esc(b.age)}h on ${esc(b.infraTicket)}${b.assignee ? ' (' + esc(b.assignee) + ')' : ''}`).join('; ')}. ${escalated.some((b) => b.slaState === 'breach') ? 'Exceeds the 24–32h SLA — escalate at standup today.' : 'Flagged for escalation — monitor closely.'}</div>`
    : ''
  return `<div class="detail-panel">
    <div class="detail-top">
      <div><div class="detail-title">${esc(t.name)} — Sprint ${esc(snap.sprint.number)}</div><div class="detail-sub">${esc(t.board)}${(t.systems || []).length ? ' · ' + esc(t.systems.join(' · ')) : ''}</div></div>
      <button class="close-btn">✕ Close</button>
    </div>
    <div>
      <span class="person-chip"><span class="pc-role">PM:</span><span class="pc-name">${esc(t.pm)}</span></span>
      ${t.activeSprint ? `<span class="person-chip sprint-chip"><span class="pc-role">Sprint:</span><span class="pc-name">${esc(sprintLabel(t.activeSprint))}</span></span>` : ''}
      ${(t.systems || []).map((s) => `<span class="person-chip"><span class="pc-name">${esc(s)}</span></span>`).join('')}
    </div>
    ${whyBox(t)}
    <div class="detail-grid">
      <div>
        <div class="sub-title">✅ Recently shipped (${esc((t.shippedTickets || []).length)} of ${esc(t.shipped)})</div>
        ${shippedRows(t)}
      </div>
      <div>
        <div class="sub-title">🔄 Active — in flight (${esc(t.inFlight)})</div>
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

// ── Ticker ────────────────────────────────────────────────────────────────────
function decorate(line) {
  let s = esc(line).replace(/\b([A-Z]{2,5}-\d+)\b/g, '<span class="t-id">$1</span>')
  if (/exceeds SLA|past SLA|BLOCKED|breached|escalat/i.test(line)) return `<span class="t-alert">${s}</span>`
  if (/shipped|success rate|leads|on-track|down 0|↓/i.test(line)) return `<span class="t-good">${s}</span>`
  return s
}
function renderTicker(snap) {
  const content = snap.ticker.map((l) => `<span class="t-dim"> · </span>${decorate(l)}`).join('') + '<span class="t-dim"> · </span>'
  tickerEl.innerHTML = `<div class="ticker-label"><span class="live-dot"></span>Live Feed</div><div class="ticker-wrap"><div class="ticker-track"><span class="ticker-content">${content}</span><span class="ticker-content" aria-hidden="true">${content}</span></div></div>`
}

// ── Master render (hash-guarded so the ticker doesn't reset on no-op pushes) ──
function teamBody(snap) {
  return `<div class="dash-body">`
    + narrative(snap)
    + `<div class="section-label">Sprint ${esc(snap.sprint.number)} at a glance</div>` + metricsRow(snap)
    + `<div class="section-label" style="margin-top:8px">All teams — AI health overview</div>`
    + `<div class="exec-grid">${snap.teams.map((t) => teamCard(t, snap)).join('')}</div>`
    + `<div class="two-col">${blockersCard(snap)}${ceremoniesCard(snap)}</div>`
    + `<div class="two-col">${lifecycleCard(snap)}${roiCard(snap)}</div>`
    + initiativesCard(snap)
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
  dashEl.innerHTML = header(snap) + (mode === 'leadership' ? leadershipBody(snap) : teamBody(snap))
  dashEl.dataset.rendered = '1'
  if (mode === 'team') {
    dashEl.querySelectorAll('.team-card').forEach((el) => {
      el.addEventListener('click', () => openDetail(el.dataset.team))
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(el.dataset.team) } })
    })
  } else {
    wireLeadership(snap)
  }
  document.getElementById('dashRefresh')?.addEventListener('click', manualRefresh)
  document.getElementById('agentEgg')?.addEventListener('click', openAgents)
  dashEl.querySelectorAll('.vt-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.mode === mode) return
    mode = b.dataset.mode
    render(snapshot)
    dashEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }))
  renderTicker(snap)
}

function showError(msg) {
  dashEl.innerHTML = `<div class="dash-body"><div class="card"><div class="card-title">⚠ Can't reach the Hive Pulse API</div><div class="empty-note">Tried <span class="t-mono">${esc(API)}/api/snapshot</span> — ${esc(msg)}.<br><br>Start the backend in a terminal:<br><span class="t-mono">cd hive-pulse-server &amp;&amp; npm run dev</span><br><br>Then click <strong>↻ Refresh</strong>.</div><button class="dash-refresh" id="dashRetry" style="margin-top:12px">↻ Retry</button></div></div>`
  document.getElementById('dashRetry')?.addEventListener('click', load)
}

// ── Data plumbing ──────────────────────────────────────────────────────────────
async function load() {
  try {
    const r = await fetch(`${API}/api/snapshot`, { cache: 'no-store' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    render(await r.json())
  } catch (err) {
    if (!snapshot) showError(err.message)
  }
}

function connectSSE() {
  if (es || typeof EventSource === 'undefined') { if (!es) startPolling(); return }
  try {
    es = new EventSource(`${API}/api/stream`)
    es.addEventListener('snapshot', (e) => { try { render(JSON.parse(e.data)) } catch { /* ignore malformed frame */ } })
    es.onopen = stopPolling                 // live again → no need to poll
    es.onerror = startPolling               // outage → poll until EventSource auto-reconnects
  } catch {
    startPolling()
  }
}
function startPolling() { if (!pollTimer) pollTimer = setInterval(load, 30000) }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }

async function manualRefresh() {
  const btn = document.getElementById('dashRefresh')
  if (btn) { btn.disabled = true; btn.textContent = '↻ …' }
  try { await fetch(`${API}/api/ingest`, { method: 'POST' }) } catch { /* server may be mock-only */ }
  await load()
  if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh' }
}

// ── Reveal (wired to the existing "View Live Dashboard →" CTA) ────────────────
function reveal() {
  if (revealed) { dashEl.scrollIntoView({ behavior: 'smooth' }); return }
  revealed = true
  if (skipEl) skipEl.hidden = true   // hide skip button once dashboard is revealed
  dashEl.hidden = false
  dashEl.classList.add('revealing')
  tickerEl.hidden = false
  backTopEl.hidden = false
  // The document grew — let the GSAP ScrollTrigger recalc (main.js listens for resize).
  window.dispatchEvent(new Event('resize'))
  requestAnimationFrame(() => dashEl.scrollIntoView({ behavior: 'smooth' }))
  load()
  connectSSE()
}

// ── Wire-up ─────────────────────────────────────────────────────────────────
if (ctaEl)  ctaEl.addEventListener('click',  (e) => { e.preventDefault(); reveal() })
if (skipEl) skipEl.addEventListener('click', (e) => { e.preventDefault(); reveal() })
overlayEl?.addEventListener('click', (e) => { if (e.target === overlayEl) closeDetail() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail() })
backTopEl?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))

// Keep "Updated … ago" honest between pushes.
setInterval(() => {
  if (!snapshot) return
  const sub = document.getElementById('dashSub')
  if (sub) sub.textContent = `Sprint ${snapshot.sprint.number} · Week of ${snapshot.sprint.week} · Updated ${timeAgo(snapshot.generatedAt)}`
}, 30000)
