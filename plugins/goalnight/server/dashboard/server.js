/**
 * Dashboard HTTP server.
 *
 * Routes:
 *   GET /                    → public/index.html
 *   GET /styles.css          → public/styles.css
 *   GET /dashboard.js        → public/dashboard.js
 *   GET /owl.svg etc.        → public/owl*.svg (4 mascot SVGs)
 *   GET /health              → { ok: true, port }
 *   GET /api/status          → one-shot status snapshot (augmented with started_at,
 *                              target_paths, wake_time, quota_windows_relit,
 *                              burn_series)
 *   GET /api/brief           → morning brief JSON
 *   GET /api/brief?format=html → morning brief rendered as standalone HTML
 *   GET /events              → SSE stream, pushes status every 2s
 *
 * Design notes:
 *   - Vanilla `node:http` only (no Express).
 *   - Static files served from ./public, never touch paths outside it.
 *   - SSE: heartbeat comment every tick keeps the connection alive even
 *     when there's no session yet.
 *   - Status and brief calls reuse the MCP tool implementations directly —
 *     single source of truth, no duplicated query logic.
 *   - The status augmentation reads a few extra columns directly (started_at
 *     = sessions.created_at, target_paths inferred, wake_time computed) so
 *     the dashboard never has to deal with missing fields.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { status } from '../tools/status.js';
import { morningBrief } from '../tools/morning_brief.js';
import { getDb } from '../db/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const TEMPLATES_DIR = join(__dirname, 'templates');
const RECEIPT_TEMPLATE_PATH = join(TEMPLATES_DIR, 'receipt.html');
const BRIEF_HTML_TEMPLATE_PATH = join(TEMPLATES_DIR, 'morning_brief.html');

let _receiptTemplateCache = null;
async function loadReceiptTemplate() {
  if (_receiptTemplateCache) return _receiptTemplateCache;
  _receiptTemplateCache = await readFile(RECEIPT_TEMPLATE_PATH, 'utf8');
  return _receiptTemplateCache;
}

function htmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderReceiptTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? htmlEscape(vars[k]) : ''
  );
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function formatCost(usd) {
  return `$${Number(usd || 0).toFixed(2)}`;
}

// Resolve URL session id to a real session id. Accepts the full uuid OR the
// first 8 chars (the form printed on the receipt itself). Returns the
// canonical id, or null if no match / ambiguous prefix.
function resolveSessionId(idOrPrefix) {
  if (!idOrPrefix || typeof idOrPrefix !== 'string') return null;
  if (!/^[a-z0-9-]+$/i.test(idOrPrefix)) return null;
  const db = getDb();
  const exact = db.prepare('SELECT id FROM sessions WHERE id = ?').get(idOrPrefix);
  if (exact) return exact.id;
  if (idOrPrefix.length >= 8 && idOrPrefix.length < 36) {
    const rows = db
      .prepare('SELECT id FROM sessions WHERE id LIKE ? LIMIT 2')
      .all(`${idOrPrefix}%`);
    if (rows.length === 1) return rows[0].id;
  }
  return null;
}

const PREFERRED_PORT = parseInt(process.env.GOALNIGHT_PORT || '8888', 10);
const MAX_PORT_TRIES = 10;
const SSE_INTERVAL_MS = 2000;
const BURN_SERIES_LEN = 13;  // matches the sparkline width in the dashboard frame

// In-memory ring buffer of recent burn-rate samples, keyed by session_id.
// Cleared whenever the session changes. 13 samples × ~2s tick ≈ 26s window —
// enough to give the sparkline visible variation without persisting state.
const burnSeries = new Map();

function pushBurnSample(sessionId, value) {
  if (!sessionId) return;
  let arr = burnSeries.get(sessionId);
  if (!arr) { arr = []; burnSeries.set(sessionId, arr); }
  arr.push(Number.isFinite(value) ? value : 0);
  while (arr.length > BURN_SERIES_LEN) arr.shift();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const STATIC_ROUTES = {
  '/':                  { file: 'index.html' },
  '/index.html':        { file: 'index.html' },
  '/styles.css':        { file: 'styles.css' },
  '/dashboard.js':      { file: 'dashboard.js' },
  '/owl.svg':           { file: 'owl.svg' },
  '/owl-16.svg':        { file: 'owl-16.svg' },
  '/owl-g5-mark.svg':   { file: 'owl-g5-mark.svg' },
  '/owl-sleeping.svg':  { file: 'owl-sleeping.svg' },
  '/favicon.ico':       { file: 'owl-16.svg' },  // legacy fallback
};

async function serveStatic(res, filename) {
  // Normalize and re-join under PUBLIC_DIR. Reject anything that escapes.
  const safe = normalize(filename).replace(/^(\.\.[/\\])+/, '');
  const full = join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const buf = await readFile(full);
    const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${filename}`);
  }
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Augment a raw status snapshot with the extra fields the new dashboard
 * needs. All additions are pure SQL reads — no schema changes.
 *
 *   started_at           sessions.created_at (unix ms)
 *   target_paths         best-effort string ("—" until plan_night captures it)
 *   wake_time            created_at + hours
 *   quota_windows_relit  count of usage_limited → active transitions in turn_log
 *   burn_series          server-side ring buffer for the sparkline (length 13)
 */
function augmentStatus(snap) {
  if (!snap || snap.state === 'none' || !snap.session_id) {
    return { ...snap, burn_series: [] };
  }

  const db = getDb();
  let session;
  try {
    session = db.prepare('SELECT created_at, hours FROM sessions WHERE id = ?').get(snap.session_id);
  } catch { session = null; }

  let quotaRelit = 0;
  try {
    quotaRelit = db.prepare(
      `SELECT COUNT(*) AS c
       FROM turn_log
       WHERE session_id = ?
         AND goal_state_before = 'usage_limited'
         AND goal_state_after  = 'active'`
    ).get(snap.session_id)?.c ?? 0;
  } catch { /* missing table on very old DBs — leave 0 */ }

  const startedAt = session?.created_at ?? null;
  const wakeTime = (startedAt && session?.hours)
    ? startedAt + session.hours * 60 * 60 * 1000
    : null;

  pushBurnSample(snap.session_id, snap.burn_rate_tokens_per_min || 0);

  return {
    ...snap,
    started_at:          startedAt,
    target_paths:        null,           // plan_night doesn't capture this yet
    wake_time:           wakeTime,
    quota_windows_relit: quotaRelit,
    burn_series:         (burnSeries.get(snap.session_id) || []).slice(),
  };
}

async function handleApiStatus(res) {
  try {
    const snapshot = await status({});
    sendJson(res, 200, augmentStatus(snapshot));
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleApiBrief(req, res) {
  const wantsHtml = (req.url || '').includes('format=html');
  try {
    const brief = await morningBrief({});
    if (wantsHtml) {
      sendHtml(res, 200, renderBriefHtml(brief));
    } else {
      sendJson(res, 200, brief);
    }
  } catch (err) {
    // Most common case: no session yet — return a soft 200 so the client
    // can show an empty state instead of an error banner.
    if (wantsHtml) {
      sendHtml(res, 200, renderBriefEmptyHtml(err.message));
    } else {
      sendJson(res, 200, { empty: true, message: err.message });
    }
  }
}

function sendReceiptNotFound(res, idOrPrefix) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt unavailable</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#0d0c0a;color:#a39e93;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}h1{color:#ededea;font-weight:500;font-size:20px}code{font-family:ui-monospace,Menlo,monospace;color:#F5B23E}</style>
</head><body><div><h1>Receipt unavailable — session not found</h1><p>No goalnight session matches <code>${htmlEscape(idOrPrefix)}</code>.</p></div></body></html>`;
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleApiReceipt(res, idOrPrefix) {
  let sessionId;
  try {
    sessionId = resolveSessionId(idOrPrefix);
  } catch {
    sessionId = null;
  }
  if (!sessionId) return sendReceiptNotFound(res, idOrPrefix);

  let brief;
  try {
    brief = await morningBrief({ session_id: sessionId });
  } catch {
    return sendReceiptNotFound(res, idOrPrefix);
  }

  const r = brief.receipt_data;
  const plan = (r.headline.plan_used || 'pro').toString();
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const isReclaim = r.headline.tokens_reclaimed > 0;

  // Conditional copy: when no quota window was relit, the receipt's hero
  // number is total tokens used (a clean run is honest, not a brag) and
  // the sub-line says so.
  const headlineLabel = isReclaim ? 'tokens reclaimed' : 'tokens used';
  const headlineValue = isReclaim
    ? formatNumber(r.headline.tokens_reclaimed)
    : formatNumber(brief.tokens_used);
  const windowsWord = r.headline.quota_windows_relit === 1 ? 'window' : 'windows';
  const headlineSub = isReclaim
    ? `≈ ${formatCost(r.headline.cost_estimate_usd)} at ${planLabel} plan rates · ${r.headline.quota_windows_relit} quota ${windowsWord} relit`
    : `≈ ${formatCost(r.headline.cost_estimate_usd)} at ${planLabel} plan rates · 0 quota windows relit · clean run`;

  const tpl = await loadReceiptTemplate();
  const html = renderReceiptTemplate(tpl, {
    headline_label: headlineLabel,
    headline_value: headlineValue,
    headline_sub: headlineSub,
    line_overnight: r.lines.overnight,
    line_milestones: r.lines.milestones,
    line_decisions: r.lines.decisions,
    line_findings: r.lines.findings,
    foot_session_short: r.foot.session_short,
    foot_brand_url: r.foot.brand_url,
  });

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': goalnight sse stream\n\n');

  let closed = false;
  const tick = async () => {
    if (closed) return;
    try {
      const snapshot = await status({});
      const augmented = augmentStatus(snapshot);
      res.write(`event: status\ndata: ${JSON.stringify(augmented)}\n\n`);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    }
  };

  // First frame immediately so the client doesn't wait 2s for content.
  tick();
  const timer = setInterval(tick, SSE_INTERVAL_MS);

  req.on('close', () => {
    closed = true;
    clearInterval(timer);
    try { res.end(); } catch { /* already closed */ }
  });
}

// ── morning-brief HTML renderer ────────────────────────────────────────────
// Lightweight templating: {{var}} substitution + a tiny list helper. No
// engine dep. The template lives next to the dashboard so it can reference
// the same /styles.css and /owl.svg as the live page.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderList(items, formatter) {
  if (!items || items.length === 0) {
    return '<li class="empty">—</li>';
  }
  return items.map(formatter).join('\n');
}

function renderDecisionLi(d) {
  const reasoning = d.reasoning
    ? `<span class="sub"><span class="k">why</span> ${escapeHtml(d.reasoning)}</span>`
    : '';
  const rec = d.recommendation
    ? `<span class="sub"><span class="k">recommended</span> ${escapeHtml(d.recommendation)}</span>`
    : '';
  return `<li>${escapeHtml(d.question)} ${rec} ${reasoning}</li>`;
}

function renderUncertainLi(d) {
  const reasoning = d.reasoning
    ? `<span class="sub"><span class="k">why</span> ${escapeHtml(d.reasoning)}</span>`
    : '';
  const chose = d.recommendation
    ? `<span class="sub"><span class="k">chose</span> ${escapeHtml(d.recommendation)}</span>`
    : '';
  return `<li>${escapeHtml(d.question)} ${chose} ${reasoning}</li>`;
}

function renderMilestoneLi(m) {
  return `<li>${escapeHtml(m.title)}</li>`;
}

function renderFindingLi(f) {
  const type = escapeHtml((f.type || 'note').toLowerCase());
  const sev  = escapeHtml((f.severity || 'low').toLowerCase());
  return `<li><b>${type}${sev !== 'low' ? `, ${sev}` : ''}:</b> ${escapeHtml(f.content || '')}</li>`;
}

function loadBriefTemplate() {
  try {
    return readFileSync(BRIEF_HTML_TEMPLATE_PATH, 'utf8');
  } catch {
    // Template file missing — return a minimal fallback so the route still works.
    return `<!doctype html><html><body style="font-family:system-ui;padding:32px">
      <h1>{{title}}</h1><p>{{summary}}</p>
      <h2>Done</h2><ul>{{milestones_done_html}}</ul>
      <h2>Pending</h2><ul>{{milestones_pending_html}}</ul>
    </body></html>`;
  }
}

function renderBriefHtml(brief) {
  const tpl = loadBriefTemplate();

  const tokensStr = brief.token_budget
    ? `${(brief.tokens_used / 1000).toFixed(1)}k / ${(brief.token_budget / 1000).toFixed(0)}k`
    : `${(brief.tokens_used / 1000).toFixed(1)}k`;

  const data = {
    title:                     'goalnight — morning brief',
    summary:                   brief.summary_one_liner || '',
    objective:                 brief.objective || '',
    status:                    brief.status || '',
    duration_human:            brief.duration_human || '',
    tokens_human:              tokensStr,
    decisions_blocking_count:  brief.decisions_awaiting?.length || 0,
    decisions_uncertain_count: brief.uncertain_decisions?.length || 0,
    milestones_done_count:     brief.milestones_done?.length || 0,
    milestones_pending_count:  brief.milestones_pending?.length || 0,
    findings_count:            brief.findings_highlights?.length || 0,
    decisions_blocking_html:   renderList(brief.decisions_awaiting,  renderDecisionLi),
    decisions_uncertain_html:  renderList(brief.uncertain_decisions, renderUncertainLi),
    milestones_done_html:      renderList(brief.milestones_done,     renderMilestoneLi),
    milestones_pending_html:   renderList(brief.milestones_pending,  renderMilestoneLi),
    findings_html:             renderList(brief.findings_highlights, renderFindingLi),
  };

  // Section-visibility flags: hide sections with zero items by injecting a
  // `hidden` attribute. Keeps the template static and readable.
  const sections = [
    ['hide_blocking',  data.decisions_blocking_count  === 0 ? 'hidden' : ''],
    ['hide_uncertain', data.decisions_uncertain_count === 0 ? 'hidden' : ''],
    ['hide_findings',  data.findings_count            === 0 ? 'hidden' : ''],
  ];
  for (const [k, v] of sections) data[k] = v;

  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(data, key) ? String(data[key] ?? '') : ''
  );
}

function renderBriefEmptyHtml(message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>goalnight — morning brief</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body style="background:var(--bg-base);padding:48px;color:var(--text-secondary);font-family:var(--font-ui)">
  <h1 style="color:var(--text-primary);font-weight:600;margin:0 0 12px">No brief available</h1>
  <p style="color:var(--text-muted);margin:0">${escapeHtml(message || 'No goalnight session found.')}</p>
</body>
</html>`;
}

function makeHandler(port) {
  return async function handle(req, res) {
    // Strip query string for route matching (brief preserves it via req.url).
    const url = (req.url || '/').split('?')[0];

    if (url === '/health') {
      return sendJson(res, 200, { ok: true, port });
    }
    if (url === '/events') {
      return handleEvents(req, res);
    }
    if (url === '/api/status') {
      return handleApiStatus(res);
    }
    if (url === '/api/brief') {
      return handleApiBrief(req, res);
    }
    if (url.startsWith('/api/receipt/')) {
      const idOrPrefix = decodeURIComponent(url.slice('/api/receipt/'.length));
      return handleApiReceipt(res, idOrPrefix);
    }

    const route = STATIC_ROUTES[url];
    if (route) {
      return serveStatic(res, route.file);
    }

    // Fallback 404 — keep it small.
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  };
}

export async function startDashboard() {
  return new Promise((resolve, reject) => {
    let port = PREFERRED_PORT;
    let attempt = 0;

    function tryListen() {
      const server = createServer(makeHandler(port));

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_TRIES) {
          attempt++;
          port++;
          tryListen();
        } else {
          reject(err);
        }
      });

      server.listen(port, '127.0.0.1', () => {
        console.error(`[goalnight] dashboard listening at http://localhost:${port}`);
        resolve({ server, port });
      });
    }

    tryListen();
  });
}

// Allow `node server/dashboard/server.js` for local iteration.
if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboard().catch(err => {
    console.error('[goalnight] dashboard failed:', err);
    process.exit(1);
  });
}
