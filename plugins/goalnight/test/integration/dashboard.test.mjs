/**
 * Dashboard integration smoke.
 *
 * Boots server/dashboard/server.js as a child process against an isolated
 * fixture DB, hits each public route, and asserts the response shape matches
 * what the React-less vanilla dashboard expects.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { populateFixtureDb, cleanupFixtureDir } from '../_helpers/fixture-db.mjs';
import { waitForPort, fetchJson, withTimeoutKill, pickFreePort } from '../_helpers/spawn.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const SERVER_ENTRY = join(PLUGIN_ROOT, 'server', 'dashboard', 'server.js');

let proc;
let dataDir;
let fixture;
let port;
let baseUrl;

before(async () => {
  dataDir = `/tmp/goalnight-it-dash-${Date.now()}-${process.pid}`;
  fixture = await populateFixtureDb({ dir: dataDir });
  port = await pickFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      GOALNIGHT_DATA: dataDir,
      GOALNIGHT_PORT: String(port),
      // HOME override: keep the dashboard from accidentally touching the
      // dev's real ~/.goalnight if the env var is ever dropped.
      HOME: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Surface boot errors instead of hanging on waitForPort.
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  await waitForPort(port, '127.0.0.1', 5000);
});

after(async () => {
  if (proc) await withTimeoutKill(proc, 1500);
  cleanupFixtureDir(dataDir);
});

test('GET /health → { ok: true, port }', async () => {
  const r = await fetchJson(`${baseUrl}/health`);
  assert.equal(r.ok, true);
  assert.equal(r.port, port);
});

test('GET /api/status returns the fixture session shape', async () => {
  const r = await fetchJson(`${baseUrl}/api/status`);
  assert.equal(r.session_id, fixture.session_id);
  assert.equal(r.state, 'active');
  assert.equal(r.objective, 'implement user profile feature');
  assert.equal(r.tokens_used, 45000);
  assert.equal(r.token_budget, 240000);
  assert.equal(r.milestones.length, 3);
  assert.equal(r.pending_decisions_count, 1);
  assert.equal(r.findings_count, 2);

  const states = r.milestones.map(m => m.state).sort();
  assert.deepEqual(states, ['done', 'in_progress', 'pending']);

  // v0.1.2 augmentations — dashboard needs these for the goal meta-row,
  // quota timeline, and sparkline.
  assert.ok(Number.isInteger(r.started_at), 'started_at is set from sessions.created_at');
  assert.ok(Number.isInteger(r.wake_time),  'wake_time is started_at + hours');
  assert.equal(typeof r.quota_windows_relit, 'number');
  assert.ok(Array.isArray(r.burn_series),    'burn_series is a ring buffer (possibly empty on first call)');
});

test('GET /api/brief?format=html renders the morning-brief template', async () => {
  const res = await fetch(`${baseUrl}/api/brief?format=html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /morning brief/i);
  assert.match(html, /implement user profile feature/);  // objective substituted
  assert.match(html, /Postgres or stay on SQLite/);      // blocking decision rendered
  assert.doesNotMatch(html, /\{\{\s*\w+\s*\}\}/, 'no unresolved template vars');
});

test('GET /owl-16.svg serves the favicon SVG', async () => {
  const res = await fetch(`${baseUrl}/owl-16.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  const body = await res.text();
  assert.match(body, /<svg/);
});

test('GET /owl.svg serves the topbar mark', async () => {
  const res = await fetch(`${baseUrl}/owl.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
});

test('GET / serves the dashboard with the new DOM ids', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  // Spot-check ids the SSE renderer keys off — fails fast if the HTML
  // and JS contracts drift apart.
  for (const id of [
    'status-pill', 'status-pill-dot', 'quota-pill',
    'goal-objective', 'goal-session-short', 'goal-started-when',
    'goal-target', 'goal-budget', 'goal-wake',
    'stat-elapsed-v', 'stat-tokens-v', 'stat-burn-v', 'stat-burn-sparkline',
    'stat-eta-v', 'stat-refresh-v',
    'milestones-meta', 'milestones-list',
    'decisions-meta', 'decisions-blocking-list', 'decisions-uncertain-list',
    'findings-meta', 'findings-list',
    'quota-reset', 'quota-timeline', 'quota-legend',
    'footer-receipt-link',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html is missing id="${id}"`);
  }
});

test('GET /api/brief includes decisions, findings, markdown', async () => {
  const r = await fetchJson(`${baseUrl}/api/brief`);
  assert.equal(r.decisions_awaiting.length, 1);
  assert.equal(r.decisions_awaiting[0].blocking, 1);
  assert.match(r.decisions_awaiting[0].question, /Postgres or stay on SQLite/);

  assert.equal(r.findings_highlights.length, 2);
  // High-severity warning should sort first.
  assert.equal(r.findings_highlights[0].severity, 'high');

  assert.equal(r.objective, 'implement user profile feature');
  assert.match(r.markdown, /Decisions waiting/);
  assert.match(r.markdown, /goalnight/);
});

test('GET /api/status returns a static 404 for unknown route', async () => {
  const res = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(res.status, 404);
});

test('GET /api/receipt/:id returns rendered HTML with brand watermark', async () => {
  const res = await fetch(`${baseUrl}/api/receipt/${fixture.session_id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  // Brand watermark must be present.
  assert.match(body, /goalnight\.dev/);
  // Session short-id (first 8 chars) must be in the foot.
  assert.match(body, new RegExp(`session ${fixture.session_id.slice(0, 8)}`));
  // Lines should reflect the fixture: 1 done of 3 milestones, 1 blocking decision, 2 findings.
  assert.match(body, /1 \/ 3/);
  assert.match(body, /1 routed · 1 woke you/);
  assert.match(body, /2 logged · 0 bugs fixed/);
  // Static template structure preserved (overnight receipt header).
  assert.match(body, /overnight receipt/);
});

test('GET /api/receipt/:id accepts an 8-char session prefix', async () => {
  const short = fixture.session_id.slice(0, 8);
  const res = await fetch(`${baseUrl}/api/receipt/${short}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, new RegExp(`session ${short}`));
});

test('GET /api/receipt/:id returns a clean 404 for an unknown session', async () => {
  const res = await fetch(`${baseUrl}/api/receipt/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /Receipt unavailable/);
  assert.match(body, /session not found/);
});

test('GET /events emits at least one `status` SSE frame', async () => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  let buf = '';
  try {
    const res = await fetch(`${baseUrl}/events`, { signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const start = Date.now();
    while (Date.now() - start < 3500) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      if (buf.includes('event: status')) break;
    }
    try { reader.cancel(); } catch { /* already done */ }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(t);
  }
  assert.match(buf, /event: status/);
  assert.match(buf, /"state":"active"/);
});
