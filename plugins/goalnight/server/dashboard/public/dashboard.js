/* ─────────────────────────────────────────────────────────────
 * goalnight dashboard — SSE client + DOM renderer (v0.1.2)
 *
 * Connects to /events, receives `status` events every ~2s,
 * renders them into the handback-derived block scaffolding.
 *
 * Decisions/findings bodies come from /api/brief (gn_status only
 * carries counts). We refetch when counts shift or every ~10s
 * so the dashboard stays in sync.
 * ──────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  // ─── DOM refs ────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const dom = {
    body:              document.body,

    statusPill:        $('status-pill'),
    statusPillDot:     $('status-pill-dot'),
    statusPillText:    $('status-pill-text'),
    quotaPill:         $('quota-pill'),
    quotaPillText:     $('quota-pill-text'),

    goalObjective:     $('goal-objective'),
    goalSessionShort:  $('goal-session-short'),
    goalStartedWhen:   $('goal-started-when'),
    goalTarget:        $('goal-target'),
    goalBudget:        $('goal-budget'),
    goalWake:          $('goal-wake'),

    statElapsedV:      $('stat-elapsed-v'),
    statElapsedSub:    $('stat-elapsed-sub'),
    statTokensV:       $('stat-tokens-v'),
    statTokensSub:     $('stat-tokens-sub'),
    statBurnV:         $('stat-burn-v'),
    statBurnSub:       $('stat-burn-sub'),
    statBurnSparkline: $('stat-burn-sparkline'),
    statEtaV:          $('stat-eta-v'),
    statEtaSub:        $('stat-eta-sub'),
    statRefreshV:      $('stat-refresh-v'),
    statRefreshSub:    $('stat-refresh-sub'),

    milestonesMeta:    $('milestones-meta'),
    milestonesList:    $('milestones-list'),

    decisionsCard:        $('decisions-card'),
    decisionsMeta:        $('decisions-meta'),
    decisionsBlockingH:   $('decisions-blocking-h'),
    decisionsBlockingList:$('decisions-blocking-list'),
    decisionsUncertainH:  $('decisions-uncertain-h'),
    decisionsUncertainList:$('decisions-uncertain-list'),

    findingsMeta:      $('findings-meta'),
    findingsList:      $('findings-list'),

    quotaReset:        $('quota-reset'),
    quotaTimeline:     $('quota-timeline'),
    quotaLegend:       $('quota-legend'),

    footerReceipt:     $('footer-receipt-link'),
    connState:         $('conn-state'),
  };

  // ─── state ───────────────────────────────────────────────
  // 13 points matches the sparkline viewBox in the handback frame.
  const SPARK_POINTS = 13;
  let lastBriefFetchAt = 0;
  let lastSessionId    = null;
  let lastDecCount     = -1;
  let lastFindCount    = -1;
  let lastFindingsAtMs = null;

  const STATE_LABEL = {
    active:        'active',
    paused:        'paused',
    usage_limited: 'quota wait',
    blocked:       'blocked',
    complete:      'complete',
    planned:       'planned',
    none:          'no session',
  };

  // ─── time / number helpers ───────────────────────────────
  function fmtDuration(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${sec}s`;
  }

  function fmtDurationShort(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  function fmtKTokens(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n >= 100_000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000)    return `${(n / 1000).toFixed(1)}k`;
    return `${n}`;
  }

  function fmtTimeOfDay(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  function fmtStarted(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
    return `started ${dow} ${fmtTimeOfDay(ms)}`;
  }

  function fmtRelativePast(ms) {
    if (!ms) return '—';
    const diff = Math.max(0, Date.now() - ms);
    return `${fmtDuration(diff / 1000)} ago`;
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── status pill ─────────────────────────────────────────
  function renderStatusPill(snap) {
    const state = snap.state || 'planned';
    dom.statusPill.classList.remove('active', 'warn');
    if (state === 'active' || state === 'complete') dom.statusPill.classList.add('active');
    else if (state === 'usage_limited' || state === 'blocked') dom.statusPill.classList.add('warn');

    const relit = snap.quota_windows_relit || 0;
    const relitSuffix = relit > 0 ? ` · relit ${relit}×` : '';
    setText(dom.statusPillText, `${STATE_LABEL[state] || state}${relitSuffix}`);
  }

  function renderQuotaPill(snap) {
    if (snap.next_quota_reset_at) {
      const diffSec = Math.max(0, Math.round((snap.next_quota_reset_at - Date.now()) / 1000));
      setText(dom.quotaPillText, `resets in ${fmtDurationShort(diffSec)}`);
    } else {
      setText(dom.quotaPillText, 'no reset scheduled');
    }
  }

  // ─── goal card ───────────────────────────────────────────
  function renderGoalCard(snap) {
    setText(dom.goalObjective, snap.objective || '—');
    setText(dom.goalSessionShort, (snap.session_id || '').slice(0, 8) || '—');
    setText(dom.goalStartedWhen, fmtStarted(snap.started_at));

    // target_paths: plan_night doesn't capture this in v0.1, so we stub
    // gracefully with a placeholder rather than expanding scope.
    setText(dom.goalTarget, snap.target_paths || '—');

    // budget: derive hours-budget from elapsed + remaining, plus tokens.
    let budgetTxt = '—';
    if (snap.token_budget && snap.wake_time && snap.started_at) {
      const totalH = Math.round((snap.wake_time - snap.started_at) / 3600_000);
      budgetTxt = `${totalH}h / ${fmtKTokens(snap.token_budget)} tokens`;
    } else if (snap.token_budget) {
      budgetTxt = `${fmtKTokens(snap.token_budget)} tokens`;
    }
    setText(dom.goalBudget, budgetTxt);

    setText(dom.goalWake, snap.wake_time ? `${fmtTimeOfDay(snap.wake_time)}` : '—');
  }

  // ─── stats row ───────────────────────────────────────────
  function renderStats(snap) {
    setText(dom.statElapsedV, fmtDuration(snap.elapsed_seconds));
    setText(dom.statElapsedSub,
      snap.wake_time && snap.started_at
        ? `of ${Math.round((snap.wake_time - snap.started_at) / 3600_000)}h budget`
        : 'since start');

    setText(dom.statTokensV, fmtKTokens(snap.tokens_used));
    if (snap.token_budget) {
      const pct = clamp(Math.round((snap.tokens_used / snap.token_budget) * 100), 0, 999);
      setText(dom.statTokensSub, `/ ${fmtKTokens(snap.token_budget)} · ${pct}%`);
    } else {
      setText(dom.statTokensSub, 'no budget set');
    }

    // Burn rate is emitted as tokens-per-minute; the stat card shows /hr to
    // match the handback frame.
    const burnPerHr = (snap.burn_rate_tokens_per_min || 0) * 60;
    setText(dom.statBurnV, fmtKTokens(burnPerHr));
    setText(dom.statBurnSub, '/hr');
    renderSparkline(snap.burn_series || []);

    // ETA = wake_time if scheduled; otherwise derive from burn vs remaining.
    if (snap.wake_time) {
      setText(dom.statEtaV, fmtTimeOfDay(snap.wake_time));
      setText(dom.statEtaSub, etaLabel(snap));
    } else {
      const sec = etaFromBurn(snap);
      setText(dom.statEtaV, sec != null ? fmtDuration(sec) : '—');
      setText(dom.statEtaSub, sec != null ? 'until budget' : 'no budget');
    }

    // Next refresh — countdown to next_quota_reset_at.
    if (snap.next_quota_reset_at) {
      const diffSec = Math.max(0, Math.round((snap.next_quota_reset_at - Date.now()) / 1000));
      setText(dom.statRefreshV, fmtDurationShort(diffSec));
      const win = snap.quota_windows_relit != null
        ? `window ${snap.quota_windows_relit + 1}`
        : '—';
      setText(dom.statRefreshSub, win);
    } else {
      setText(dom.statRefreshV, '—');
      setText(dom.statRefreshSub, 'no refresh scheduled');
    }
  }

  function etaFromBurn(snap) {
    if (!snap.token_budget || !snap.burn_rate_tokens_per_min) return null;
    const remaining = snap.token_budget - (snap.tokens_used || 0);
    if (remaining <= 0) return 0;
    const ratePerSec = snap.burn_rate_tokens_per_min / 60;
    if (ratePerSec <= 0) return null;
    return Math.round(remaining / ratePerSec);
  }

  function etaLabel(snap) {
    // "on schedule" / "behind" / "ahead" based on elapsed vs wake time.
    if (!snap.wake_time || !snap.started_at || !snap.token_budget) return '—';
    const totalMs    = snap.wake_time - snap.started_at;
    const elapsedMs  = Date.now() - snap.started_at;
    const expectedPct = clamp(elapsedMs / totalMs, 0, 1);
    const actualPct   = clamp((snap.tokens_used || 0) / snap.token_budget, 0, 1);
    const diff = actualPct - expectedPct;
    if (diff > 0.08) return 'ahead';
    if (diff < -0.08) return 'behind';
    return 'on schedule';
  }

  // ─── sparkline ───────────────────────────────────────────
  function renderSparkline(series) {
    const poly = dom.statBurnSparkline.querySelector('polyline');
    if (!poly) return;
    if (!series || series.length < 2) {
      poly.setAttribute('points', '');
      return;
    }
    const w = 100, h = 18;
    const max = Math.max(...series, 1);
    const min = Math.min(...series, 0);
    const range = Math.max(max - min, 1);
    const n = Math.min(series.length, SPARK_POINTS);
    const pts = series.slice(-n).map((v, i) => {
      const x = (i / (SPARK_POINTS - 1)) * w;
      const y = h - 2 - ((v - min) / range) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    poly.setAttribute('points', pts.join(' '));
  }

  // ─── milestones ──────────────────────────────────────────
  const ICON_DONE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="7" fill="#9EC76A" fill-opacity="0.18" stroke="currentColor" stroke-width="1.4"/>
    <path d="M4.5 8.2 L7 10.5 L11.5 5.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
  const ICON_PENDING = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 2.4" opacity="0.7"/>
  </svg>`;
  const ICON_SKIPPED = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.4" opacity="0.4"/>
    <path d="M5 8 L11 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;
  const ICON_ACTIVE = `<span class="spinner" aria-label="in progress"></span>`;

  function milestoneIcon(state) {
    switch (state) {
      case 'done':         return ICON_DONE;
      case 'in_progress':  return ICON_ACTIVE;
      case 'skipped':      return ICON_SKIPPED;
      default:             return ICON_PENDING;
    }
  }

  function milestoneAux(m) {
    if (m.state === 'in_progress' && m.started_at) {
      const elapsedSec = (Date.now() - m.started_at) / 1000;
      return `${fmtDuration(elapsedSec)} elapsed`;
    }
    if (m.state === 'done' && m.started_at && m.completed_at) {
      return fmtDuration((m.completed_at - m.started_at) / 1000);
    }
    if (m.state === 'done' && m.completed_at) {
      return fmtRelativePast(m.completed_at);
    }
    if (m.state === 'pending' && m.estimated_tokens) {
      return `est. ${fmtKTokens(m.estimated_tokens)}`;
    }
    return '';
  }

  function renderMilestones(milestones) {
    const total = milestones.length;
    const done  = milestones.filter(m => m.state === 'done').length;
    const inProg = milestones.filter(m => m.state === 'in_progress').length;
    const pending = milestones.filter(m => m.state === 'pending').length;
    setText(dom.milestonesMeta, `${done} done · ${inProg} in progress · ${pending} pending`);

    if (total === 0) {
      dom.milestonesList.innerHTML =
        `<div class="ms-row pending"><span class="icon">${ICON_PENDING}</span><span class="title">No milestones yet — run <span class="mono">gn plan-night</span> to seed one.</span><span class="aux"></span></div>`;
      return;
    }

    dom.milestonesList.innerHTML = milestones.map(m => {
      const stateClass = m.state === 'in_progress' ? 'active'
        : (m.state === 'done' ? 'done' : 'pending');
      return `
        <div class="ms-row ${stateClass}">
          <span class="icon">${milestoneIcon(m.state)}</span>
          <span class="title">${escapeHtml(m.title || '(untitled)')}</span>
          <span class="aux">${escapeHtml(milestoneAux(m))}</span>
        </div>`;
    }).join('');
  }

  // ─── decisions ───────────────────────────────────────────
  function renderDecisionItem(d, marker) {
    const reasoning = d.reasoning
      ? `<span class="a"><span class="k">why</span> ${escapeHtml(d.reasoning)}</span>`
      : '';
    const rec = d.recommendation
      ? `<span class="a"><span class="k">${marker === '?' ? 'recommended' : 'chose'}</span> ${escapeHtml(d.recommendation)}</span>`
      : '';
    return `
      <li>
        <span class="marker ${marker === '?' ? '' : 'dim'}">${marker}</span>
        <div>
          <span class="q">${escapeHtml(d.question || '(question missing)')}</span>
          ${rec}
          ${reasoning}
        </div>
      </li>`;
  }

  function renderDecisions(blocking, uncertain) {
    const bCount = blocking.length;
    const uCount = uncertain.length;
    setText(dom.decisionsMeta, `${bCount} blocking · ${uCount} to review`);

    // Whole card hidden when both are empty — keeps the dashboard calm
    // overnight when nothing needs attention.
    dom.decisionsCard.style.display = (bCount + uCount) === 0 ? 'none' : '';

    if (bCount === 0) {
      dom.decisionsBlockingH.hidden = true;
      dom.decisionsBlockingList.innerHTML = '';
    } else {
      dom.decisionsBlockingH.hidden = false;
      dom.decisionsBlockingList.innerHTML =
        blocking.map(d => renderDecisionItem(d, '?')).join('');
    }

    if (uCount === 0) {
      dom.decisionsUncertainH.hidden = true;
      dom.decisionsUncertainList.innerHTML = '';
    } else {
      dom.decisionsUncertainH.hidden = false;
      dom.decisionsUncertainList.innerHTML =
        uncertain.map(d => renderDecisionItem(d, '·')).join('');
    }
  }

  // ─── findings ────────────────────────────────────────────
  function renderFindings(items) {
    const count = items.length;
    if (count === 0) {
      setText(dom.findingsMeta, '0 logged');
      dom.findingsList.innerHTML =
        `<li><span class="type note">note</span><span class="msg" style="color:var(--text-muted)">No findings logged yet.</span><span class="when"></span></li>`;
      lastFindingsAtMs = null;
      return;
    }

    lastFindingsAtMs = Date.now();
    setText(dom.findingsMeta, `${count} logged · last just now`);

    dom.findingsList.innerHTML = items.map(f => {
      const type = (f.type || 'note').toLowerCase();
      const typeClass = ({
        bug: 'bug', warning: 'warn', warn: 'warn', insight: 'win', win: 'win',
      })[type] || 'note';
      const when = f.created_at
        ? fmtRelativePast(f.created_at)
        : '';
      return `
        <li>
          <span class="type ${typeClass}">${escapeHtml(type)}</span>
          <span class="msg">${escapeHtml(f.content || '')}</span>
          <span class="when">${escapeHtml(when)}</span>
        </li>`;
    }).join('');
  }

  // ─── quota timeline ──────────────────────────────────────
  function renderQuota(snap) {
    // Header — preserve the "<b>0:43</b>" markup from the handback frame.
    if (snap.next_quota_reset_at) {
      const diffSec = Math.max(0, Math.round((snap.next_quota_reset_at - Date.now()) / 1000));
      const relit = snap.quota_windows_relit || 0;
      const relitSuffix = relit > 0 ? ` · relit ${relit}× tonight` : '';
      dom.quotaReset.innerHTML =
        `next refresh in <b>${escapeHtml(fmtDurationShort(diffSec))}</b>${escapeHtml(relitSuffix)}`;
    } else {
      dom.quotaReset.innerHTML = `next refresh <b>—</b>`;
    }

    // Build the segments. Anatomy:
    //   - one "used" seg per fully-consumed prior window (= quota_windows_relit)
    //   - one "now" seg covering the current window's used fraction
    //   - one "refill" seg covering the rest of the current window
    const relit = snap.quota_windows_relit || 0;
    const segs = [];
    for (let i = 0; i < relit; i++) {
      segs.push(`<div class="seg used" style="flex:5"></div>`);
    }

    // Current-window position: how far into the 5h window are we?
    let nowFlex = 0;
    let refillFlex = 5;
    if (snap.next_quota_reset_at) {
      const msToReset = snap.next_quota_reset_at - Date.now();
      const usedH = Math.max(0, Math.min(5, 5 - msToReset / 3_600_000));
      nowFlex = usedH;
      refillFlex = Math.max(0.001, 5 - usedH);
    } else if (snap.elapsed_seconds && relit === 0) {
      const hoursIn = snap.elapsed_seconds / 3600;
      nowFlex = Math.min(5, hoursIn);
      refillFlex = Math.max(0.001, 5 - nowFlex);
    }
    segs.push(`<div class="seg now" style="flex:${nowFlex.toFixed(2)}"></div>`);
    segs.push(`<div class="seg refill" style="flex:${refillFlex.toFixed(2)}"></div>`);
    dom.quotaTimeline.innerHTML = segs.join('');

    // Legend: start time · (relit marker if any) · now · wake-or-reset.
    const start = snap.started_at ? fmtTimeOfDay(snap.started_at) : '—';
    const now   = fmtTimeOfDay(Date.now());
    const end   = snap.wake_time ? fmtTimeOfDay(snap.wake_time)
      : (snap.next_quota_reset_at ? fmtTimeOfDay(snap.next_quota_reset_at) : '—');
    const middle = relit > 0
      ? `<span style="color:var(--moon-yellow)">↑ relit ×${relit}</span>`
      : '';
    dom.quotaLegend.innerHTML = `
      <span>${escapeHtml(start)}</span>
      ${middle}
      <span style="color:var(--moon-yellow)">now · ${escapeHtml(now)}</span>
      <span>${escapeHtml(end)}</span>`;
  }

  // ─── footer ──────────────────────────────────────────────
  function renderFooterReceipt(sessionId) {
    if (!sessionId) {
      dom.footerReceipt.setAttribute('href', '#');
      return;
    }
    dom.footerReceipt.setAttribute('href', `/api/receipt/${encodeURIComponent(sessionId)}`);
  }

  // ─── render: top-level status snapshot ───────────────────
  function renderStatus(snap) {
    if (!snap || snap.state === 'none' || !snap.session_id) {
      renderEmpty();
      return;
    }

    dom.body.dataset.empty = 'false';
    const stateChanged = lastSessionId !== snap.session_id;
    lastSessionId = snap.session_id;

    renderStatusPill(snap);
    renderQuotaPill(snap);
    renderGoalCard(snap);
    renderStats(snap);
    renderMilestones(snap.milestones || []);
    renderQuota(snap);
    renderFooterReceipt(snap.session_id);

    // Document title — tiny live signal in the browser tab.
    const tokenPct = snap.token_budget
      ? Math.round(((snap.tokens_used || 0) / snap.token_budget) * 100)
      : null;
    document.title = tokenPct != null
      ? `(${tokenPct}%) goalnight · ${STATE_LABEL[snap.state] || snap.state}`
      : `goalnight · ${STATE_LABEL[snap.state] || snap.state}`;

    // Refetch the brief body if counts shifted, session changed, or 10s old.
    const decCount  = snap.pending_decisions_count || 0;
    const findCount = snap.findings_count || 0;
    if (stateChanged
        || decCount !== lastDecCount
        || findCount !== lastFindCount
        || (Date.now() - lastBriefFetchAt) > 10_000) {
      lastDecCount = decCount;
      lastFindCount = findCount;
      fetchBrief();
    }
  }

  function renderEmpty() {
    dom.body.dataset.empty = 'true';
    lastSessionId = null;
    lastDecCount = -1;
    lastFindCount = -1;

    setText(dom.statusPillText, 'no session');
    dom.statusPill.classList.remove('active', 'warn');
    setText(dom.quotaPillText, '—');
    document.title = 'goalnight · idle';
    renderFooterReceipt(null);
  }

  // ─── brief fetch (decisions + findings + uncertain) ──────
  async function fetchBrief() {
    lastBriefFetchAt = Date.now();
    try {
      const r = await fetch('/api/brief', { cache: 'no-store' });
      const d = await r.json();
      if (d && !d.empty) {
        renderDecisions(d.decisions_awaiting || [], d.uncertain_decisions || []);
        renderFindings(d.findings_highlights || []);
      } else {
        renderDecisions([], []);
        renderFindings([]);
      }
    } catch (err) {
      console.warn('[goalnight] brief fetch failed:', err.message);
    }
  }

  // ─── SSE wiring ──────────────────────────────────────────
  let es = null;
  let retryTimer = null;
  let retryDelay = 1000;

  function connect() {
    if (es) { try { es.close(); } catch {} es = null; }
    setText(dom.connState, 'connecting…');

    es = new EventSource('/events');

    es.addEventListener('open', () => {
      setText(dom.connState, 'live');
      retryDelay = 1000;
    });

    es.addEventListener('status', (ev) => {
      try {
        const snap = JSON.parse(ev.data);
        renderStatus(snap);
      } catch (err) {
        console.warn('[goalnight] bad status payload:', err);
      }
    });

    es.addEventListener('error', () => {
      setText(dom.connState, 'reconnecting…');
      try { es.close(); } catch {}
      es = null;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15_000);
    });
  }

  // ─── boot ────────────────────────────────────────────────
  renderEmpty();
  fetchBrief();
  connect();

  // Gentle visibility-aware: pause SSE when tab hidden to save battery.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (es) { try { es.close(); } catch {} es = null; }
      setText(dom.connState, 'paused (tab hidden)');
    } else if (!es) {
      connect();
    }
  });
})();
