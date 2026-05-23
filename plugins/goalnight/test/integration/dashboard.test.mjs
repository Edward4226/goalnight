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
