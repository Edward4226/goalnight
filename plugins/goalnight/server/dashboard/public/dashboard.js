/* ─────────────────────────────────────────────────────────────
 * goalnight dashboard — SSE client + DOM renderer
 *
 * Connects to /events, receives `status` events every ~2s,
 * renders them into the existing block scaffolding. Brief data
 * (decisions, findings) is fetched separately because gn_status
 * doesn't carry the full bodies — only counts.
 * ──────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  // ─── DOM refs ────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const dom = {
    connState:     $('conn-state'),
    brandSub:      $('brand-sub'),
    heroObjective: $('hero-objective'),
    statusPill:    $('status-pill'),
    statusLabel:   $('status-label'),
    quotaChip:     $('quota-chip'),

    goalText:      $('goal-text'),
    goalStarted:   $('goal-started'),
    goalSessionId: $('goal-session-id'),

    statElapsed:    $('stat-elapsed'),
    statElapsedSub: $('stat-elapsed-sub'),
    statTokens:     $('stat-tokens'),
    statTokensSub:  $('stat-tokens-sub'),
    statBurn:       $('stat-burn'),
    statEta:        $('stat-eta'),
    sparkline:      $('sparkline'),
    sparklinePath:  $('sparkline-path'),
    sparklineHead:  $('sparkline-head'),

    msList:     $('milestone-list'),
    msProgress: $('ms-progress'),

    decisionsCard: $('decisions-card'),
    decisionsBody: $('decisions-body'),
    decCount:      $('dec-count'),

    findingsList: $('findings-list'),

    quota5hFill:     $('quota-5h-fill'),
    quota5hPct:      $('quota-5h-pct'),
    quotaSonnetFill: $('quota-sonnet-fill'),
    quotaSonnetPct:  $('quota-sonnet-pct'),
    quotaOpusFill:   $('quota-opus-fill'),
    quotaOpusPct:    $('quota-opus-pct'),
    quotaReset:      $('quota-reset'),
    quotaFoot:       $('quota-foot'),
  };

  // ─── state ───────────────────────────────────────────────
  const SPARK_POINTS = 60;
  const sparkSeries = []; // burn rate (tokens/min) over time, newest last
  let lastBriefFetchAt = 0;
  let lastSessionId = null;

  const STATUS_LABELS = {
    active:        'Running',
    paused:        'Paused',
    usage_limited: 'Quota wait',
    blocked:       'Blocked',
    complete:      'Done',
    planned:       'Planned',
    none:          'No session',
  };

  const FAVICON_BY_STATE = {
    active:        '🔆',
    usage_limited: '⏳',
    blocked:       '⚠️',
    complete:      '✅',
  };

  // ─── helpers ─────────────────────────────────────────────
  function fmtDuration(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function fmtNumber(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US');
  }

  function fmtRelativePast(unixMs) {
    if (!unixMs) return '—';
    const diff = Date.now() - unixMs;
    if (diff < 0) return 'just now';
    return `${fmtDuration(diff / 1000)} ago`;
  }

  function fmtRelativeFuture(unixMs) {
    if (!unixMs) return '—';
    const diff = unixMs - Date.now();
    if (diff <= 0) return 'now';
    return `in ${fmtDuration(diff / 1000)}`;
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setFavicon(emoji) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>${emoji}</text></svg>`;
    const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    let link = document.querySelector("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = url;
  }

  // ─── sparkline (pure SVG, no Chart.js) ───────────────────
  function pushSpark(value) {
    sparkSeries.push(value);
    while (sparkSeries.length > SPARK_POINTS) sparkSeries.shift();
  }

  function renderSparkline() {
    if (sparkSeries.length < 2) {
      dom.sparklinePath.setAttribute('points', '');
      dom.sparklineHead.setAttribute('cx', '0');
      dom.sparklineHead.setAttribute('cy', '0');
      dom.sparklineHead.setAttribute('opacity', '0');
      return;
    }
    const max = Math.max(...sparkSeries, 1);
    const min = Math.min(...sparkSeries, 0);
    const range = Math.max(max - min, 1);
    const w = 100, h = 32, pad = 2;
    const points = sparkSeries.map((v, i) => {
      const x = (i / (SPARK_POINTS - 1)) * w;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    dom.sparklinePath.setAttribute('points', points.join(' '));
    const last = points[points.length - 1].split(',');
    dom.sparklineHead.setAttribute('cx', last[0]);
    dom.sparklineHead.setAttribute('cy', last[1]);
    dom.sparklineHead.setAttribute('opacity', '1');
  }

  // ─── render: status snapshot ─────────────────────────────
  function renderStatus(snap) {
    // empty / no-session shape
    if (!snap || snap.state === 'none' || !snap.session_id) {
      renderEmpty();
      return;
    }

    const stateChanged = lastSessionId !== snap.session_id;
    lastSessionId = snap.session_id;

    // top bar
    const stateKey = snap.state || 'planned';
    dom.statusPill.dataset.state = stateKey;
    setText(dom.statusLabel, STATUS_LABELS[stateKey] || stateKey);
    setText(dom.brandSub, `/goal · ${STATUS_LABELS[stateKey] || stateKey}`);
    setText(dom.heroObjective, snap.objective || '—');

    // quota chip (5h-window approximation: tokens_used / token_budget)
    const pct5h = computeQuotaPct(snap.tokens_used, snap.token_budget);
    setText(dom.quotaChip, `${pct5h}% / 5h`);

    // document title sync
    document.title = `(${pct5h}%) goalnight · ${STATUS_LABELS[stateKey] || stateKey}`;
    setFavicon(FAVICON_BY_STATE[stateKey] || '🌙');

    // goal card
    setText(dom.goalText, snap.objective || '—');
    setText(dom.goalSessionId, `session ${snap.session_id}`);
    // goal-started: derive from elapsed_seconds, since status doesn't carry created_at
    setText(dom.goalStarted, snap.elapsed_seconds != null
      ? `Started ${fmtDuration(snap.elapsed_seconds)} ago`
      : '—');

    // stats row
    setText(dom.statElapsed, fmtDuration(snap.elapsed_seconds));
    setText(dom.statElapsedSub,
      snap.next_quota_reset_at
        ? `reset ${fmtRelativeFuture(snap.next_quota_reset_at)}`
        : 'since start');

    setText(dom.statTokens, fmtNumber(snap.tokens_used));
    setText(dom.statTokensSub,
      snap.token_budget
        ? `of ${fmtNumber(snap.token_budget)} budget`
        : 'no budget set');

    setText(dom.statBurn, fmtNumber(snap.burn_rate_tokens_per_min));
    const etaSec = computeEta(snap);
    setText(dom.statEta, etaSec != null ? `ETA ${fmtDuration(etaSec)}` : 'ETA —');

    pushSpark(snap.burn_rate_tokens_per_min || 0);
    renderSparkline();

    // milestones
    renderMilestones(snap.milestones || []);

    // quota timeline
    renderQuota(snap, pct5h);

    // if decisions/findings count changed (or session changed) → re-fetch brief
    const decCountText = dom.decCount.textContent || '';
    const decShown = parseInt(decCountText, 10) || 0;
    const decFromStatus = snap.pending_decisions_count || 0;
    if (stateChanged || decFromStatus !== decShown || (Date.now() - lastBriefFetchAt) > 10_000) {
      fetchBrief();
    }
  }

  function renderEmpty() {
    dom.statusPill.dataset.state = 'none';
    setText(dom.statusLabel, 'No session');
    setText(dom.brandSub, 'idle');
    setText(dom.heroObjective, 'set a goal, go to bed, wake up to a PR.');
    setText(dom.quotaChip, '— / —');
    document.title = 'goalnight · idle';
    setFavicon('🌙');

    setText(dom.goalText, 'No active goalnight session.');
    setText(dom.goalSessionId, '');
    setText(dom.goalStarted, '—');

    setText(dom.statElapsed, '—');
    setText(dom.statElapsedSub, 'since start');
    setText(dom.statTokens, '—');
    setText(dom.statTokensSub, 'of budget');
    setText(dom.statBurn, '—');
    setText(dom.statEta, 'ETA —');
    sparkSeries.length = 0;
    renderSparkline();

    dom.msList.innerHTML = `<li class="empty-row">No milestones yet — run <code>gn plan-night</code> to seed one.</li>`;
    setText(dom.msProgress, '0 of 0 done');

    dom.decisionsCard.dataset.empty = 'true';
    setText(dom.decCount, '0 pending');
    dom.decisionsBody.innerHTML = `<div class="empty-row">Nothing waiting on you right now.</div>`;

    dom.findingsList.innerHTML = `<li class="empty-row">No findings logged yet.</li>`;

    setQuotaBar(dom.quota5hFill,     dom.quota5hPct,     0);
    setQuotaBar(dom.quotaSonnetFill, dom.quotaSonnetPct, 0);
    setQuotaBar(dom.quotaOpusFill,   dom.quotaOpusPct,   0);
    setText(dom.quotaReset, 'next reset —');
    setText(dom.quotaFoot, '5h resets —');
  }

  function computeQuotaPct(used, budget) {
    if (!budget || !Number.isFinite(used)) return 0;
    return clamp(Math.round((used / budget) * 100), 0, 100);
  }

  function computeEta(snap) {
    if (!snap.token_budget || !snap.burn_rate_tokens_per_min) return null;
    const remaining = snap.token_budget - (snap.tokens_used || 0);
    if (remaining <= 0) return 0;
    const ratePerSec = snap.burn_rate_tokens_per_min / 60;
    if (ratePerSec <= 0) return null;
    return Math.round(remaining / ratePerSec);
  }

  // ─── render: milestones ──────────────────────────────────
  function milestoneIcon(state) {
    switch (state) {
      case 'done':        return '✓';
      case 'in_progress': return '◐';
      case 'skipped':     return '↷';
      default:            return '○';
    }
  }

  function renderMilestones(milestones) {
    const total = milestones.length;
    const done  = milestones.filter(m => m.state === 'done').length;
    setText(dom.msProgress, `${done} of ${total} done`);

    if (total === 0) {
      dom.msList.innerHTML = `<li class="empty-row">No milestones yet — run <code>gn plan-night</code> to seed one.</li>`;
      return;
    }

    const html = milestones
      .map(m => {
        const dur = (m.started_at && m.completed_at)
          ? fmtDuration((m.completed_at - m.started_at) / 1000)
          : (m.started_at ? `${fmtRelativePast(m.started_at)}` : '');
        return `
          <li class="milestone-row" data-state="${escapeAttr(m.state || 'pending')}">
            <span class="milestone-icon" aria-hidden="true">${milestoneIcon(m.state)}</span>
            <span class="milestone-name">${escapeHtml(m.title || '(untitled)')}</span>
            <span class="milestone-duration">${escapeHtml(dur)}</span>
          </li>`;
      })
      .join('');
    dom.msList.innerHTML = html;
  }

  // ─── render: quota timeline ──────────────────────────────
  function setQuotaBar(fillEl, pctEl, pct) {
    if (!fillEl || !pctEl) return;
    const p = clamp(Math.round(pct), 0, 100);
    fillEl.style.width = `${p}%`;
    fillEl.classList.toggle('warn', p >= 80);
    pctEl.textContent = `${p}%`;
  }

  function renderQuota(snap, pct5h) {
    setQuotaBar(dom.quota5hFill, dom.quota5hPct, pct5h);

    // Weekly Sonnet / Opus: v0.1 we don't read state_5.sqlite from the dashboard
    // (Worker A scope ends at the dashboard surface). Show 0% placeholders so the
    // bars render visually but don't lie about real numbers.
    setQuotaBar(dom.quotaSonnetFill, dom.quotaSonnetPct, 0);
    setQuotaBar(dom.quotaOpusFill,   dom.quotaOpusPct,   0);

    if (snap.next_quota_reset_at) {
      setText(dom.quotaReset, `next reset ${fmtRelativeFuture(snap.next_quota_reset_at)}`);
      const d = new Date(snap.next_quota_reset_at);
      const hh = d.getHours().toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      setText(dom.quotaFoot, `5h resets at ${hh}:${mm}`);
    } else {
      setText(dom.quotaReset, 'next reset —');
      setText(dom.quotaFoot, '5h resets —');
    }
  }

  // ─── render: decisions + findings (from /api/brief) ──────
  async function fetchBrief() {
    lastBriefFetchAt = Date.now();
    try {
      const r = await fetch('/api/brief', { cache: 'no-store' });
      const d = await r.json();
      if (d && !d.empty) {
        renderDecisions(d.decisions_awaiting || []);
        renderFindings(d.findings_highlights || []);
      } else {
        renderDecisions([]);
        renderFindings([]);
      }
    } catch (err) {
      // Network blip — keep last paint, just log to console.
      console.warn('[goalnight] brief fetch failed:', err.message);
    }
  }

  function renderDecisions(items) {
    const count = items.length;
    setText(dom.decCount, count === 0 ? '0 pending' : `${count} pending`);
    dom.decisionsCard.dataset.empty = count === 0 ? 'true' : 'false';

    if (count === 0) {
      dom.decisionsBody.innerHTML = `<div class="empty-row">Nothing waiting on you right now.</div>`;
      return;
    }

    const html = items.map(it => {
      const rec = it.recommendation
        ? `<div class="decision-rec"><strong>Suggested:</strong> ${escapeHtml(it.recommendation)}</div>`
        : '';
      const reasoning = it.reasoning
        ? `<div class="decision-rec">${escapeHtml(it.reasoning)}</div>`
        : '';
      const blockingChip = it.blocking
        ? `<span class="decision-blocking">blocking</span>`
        : '';
      return `
        <div class="decision-item">
          <div class="decision-question">${escapeHtml(it.question || '(question missing)')}</div>
          ${rec}${reasoning}
          <div class="decision-meta">
            ${blockingChip}
            <span>Awaiting your call</span>
          </div>
        </div>`;
    }).join('');
    dom.decisionsBody.innerHTML = html;
  }

  function renderFindings(items) {
    if (!items || items.length === 0) {
      dom.findingsList.innerHTML = `<li class="empty-row">No findings logged yet.</li>`;
      return;
    }
    const html = items.map(f => {
      const type = (f.type || 'note').toLowerCase();
      const sev  = (f.severity || 'low').toLowerCase();
      return `
        <li class="finding-row" data-type="${escapeAttr(type)}" data-severity="${escapeAttr(sev)}">
          <span class="finding-dot" aria-hidden="true"></span>
          <div>
            <div class="finding-meta">
              <span class="finding-tag">${escapeHtml(type)}</span>
              <span class="finding-tag">${escapeHtml(sev)}</span>
            </div>
            <div class="finding-text">${escapeHtml(f.content || '')}</div>
          </div>
        </li>`;
    }).join('');
    dom.findingsList.innerHTML = html;
  }

  // ─── safety: tiny escape helpers (no innerHTML user-string interpolation) ──
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/\s+/g, '-');
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
      retryDelay = Math.min(retryDelay * 2, 15_000); // exp backoff capped at 15s
    });
  }

  // ─── boot ────────────────────────────────────────────────
  renderEmpty(); // paint default state immediately so the UI is never blank
  fetchBrief(); // first paint of decisions/findings
  connect();    // SSE for live status

  // gentle visibility-aware: pause SSE when tab hidden to save battery
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (es) { try { es.close(); } catch {} es = null; }
      setText(dom.connState, 'paused (tab hidden)');
    } else if (!es) {
      connect();
    }
  });
})();
