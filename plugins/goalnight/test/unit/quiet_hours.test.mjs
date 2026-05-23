import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb, notifyLogPath, readNotifyLog } from '../_helpers/db.mjs';
import { planNight } from '../../server/tools/plan_night.js';
import { getDb, closeDb } from '../../server/db/client.js';
import { notify, inQuietHours } from '../../server/notifications/index.js';

// === Window math (pure function — no DB, no time mocking needed) ===

test('inQuietHours: same-day window — inside is true, before/after/endpoint are false', () => {
  const w = '13:00-14:00';
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 13, 30)), true,  'inside');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 13, 0)),  true,  'start is inclusive');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 12, 59)), false, 'just before');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 14, 0)),  false, 'end is exclusive');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 14, 1)),  false, 'just after');
});

test('inQuietHours: overnight wrap (22:00-07:00) — covers late evening through morning', () => {
  const w = '22:00-07:00';
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 22, 0)),  true,  'start inclusive');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 23, 0)),  true,  'late evening');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 2, 30)),  true,  'dead of night');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 6, 59)),  true,  'just before end');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 7, 0)),   false, 'end exclusive');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 12, 0)),  false, 'midday');
  assert.equal(inQuietHours(w, new Date(2026, 0, 1, 21, 59)), false, 'just before start');
});

test('inQuietHours: malformed input returns false', () => {
  for (const bad of ['22-07', '26:00-07:00', '22:00-25:00', '22:60-07:00', '', null, undefined, '22:00 - 07:00', 'gibberish']) {
    assert.equal(inQuietHours(bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});

// === plan_night persistence + validation ===

let dataDir;
beforeEach(() => {
  dataDir = freshDb();
  notifyLogPath(dataDir);
});
afterEach(() => { cleanupDb(dataDir); });

test('plan_night accepts and persists quiet_hours', async () => {
  const r = await planNight({
    objective: 'test',
    milestones: ['m1'],
    quiet_hours: '22:00-07:00',
  });
  const row = getDb().prepare('SELECT quiet_hours FROM sessions WHERE id = ?').get(r.session_id);
  assert.equal(row.quiet_hours, '22:00-07:00');
});

test('plan_night stores null when quiet_hours is omitted (no failure)', async () => {
  const r = await planNight({ objective: 'test', milestones: ['m1'] });
  const row = getDb().prepare('SELECT quiet_hours FROM sessions WHERE id = ?').get(r.session_id);
  assert.equal(row.quiet_hours, null);
});

test('plan_night rejects malformed quiet_hours with a quiet_hours-mentioning error', async () => {
  for (const bad of ['26:00-07:00', '22-07', '22:00-25:00', '22:60-07:00', 'nope']) {
    await assert.rejects(
      () => planNight({ objective: 'x', milestones: ['m'], quiet_hours: bad }),
      /quiet_hours/,
      `should reject ${JSON.stringify(bad)}`
    );
  }
});

// === notify() quiet-hours gate ===

// Build a window that surrounds the current local time with a 2-hour buffer
// on each side. The buffer eliminates flake at the hour boundary (any window
// roll-over during test execution would still keep us inside).
function windowAroundNow() {
  const h = new Date().getHours();
  const startH = (h + 22) % 24;
  const endH   = (h + 2)  % 24;
  return `${String(startH).padStart(2, '0')}:00-${String(endH).padStart(2, '0')}:00`;
}

// Build a window 3 hours away from now (start +3h, end +4h) — never includes
// "right now" unless the test takes >3 hours to run.
function windowAwayFromNow() {
  const h = new Date().getHours();
  const startH = (h + 3) % 24;
  const endH   = (h + 4) % 24;
  return `${String(startH).padStart(2, '0')}:00-${String(endH).padStart(2, '0')}:00`;
}

test('notify: critical type bypasses the gate even inside the window', async () => {
  const logPath = process.env.GOALNIGHT_NOTIFY_LOG;
  await planNight({ objective: 'q', milestones: ['m'], quiet_hours: windowAroundNow() });
  notify({ type: 'critical', title: 'system error', body: 'foo' });
  const entries = readNotifyLog(logPath);
  assert.equal(entries.length, 1, 'critical must always fire');
  assert.equal(entries[0].type, 'critical');
});

test('notify: non-critical types inside the window are all suppressed', async () => {
  const logPath = process.env.GOALNIGHT_NOTIFY_LOG;
  await planNight({ objective: 'q', milestones: ['m'], quiet_hours: windowAroundNow() });
  notify({ type: 'blocking-decision', title: 'a', body: 'a' });
  notify({ type: 'usage-limited',     title: 'b', body: 'b' });
  notify({ type: 'blocked',           title: 'c', body: 'c' });
  notify({ type: 'complete',          title: 'd', body: 'd' });
  notify({ type: 'default',           title: 'e', body: 'e' });
  const entries = readNotifyLog(logPath);
  assert.equal(entries.length, 0, 'no non-critical types should fire inside quiet hours');
});

test('notify: non-critical type outside the window fires normally', async () => {
  const logPath = process.env.GOALNIGHT_NOTIFY_LOG;
  await planNight({ objective: 'q', milestones: ['m'], quiet_hours: windowAwayFromNow() });
  notify({ type: 'blocking-decision', title: 'decision', body: 'foo' });
  const entries = readNotifyLog(logPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'blocking-decision');
});

test('notify: no active session → fires (fail-open when no quiet_hours info)', () => {
  const logPath = process.env.GOALNIGHT_NOTIFY_LOG;
  // intentionally no planNight — DB is empty
  notify({ type: 'usage-limited', title: 'u', body: 'u' });
  const entries = readNotifyLog(logPath);
  assert.equal(entries.length, 1);
});

test('notify: session has no quiet_hours set → fires', async () => {
  const logPath = process.env.GOALNIGHT_NOTIFY_LOG;
  await planNight({ objective: 'q', milestones: ['m'] }); // no quiet_hours
  notify({ type: 'blocking-decision', title: 'd', body: 'd' });
  const entries = readNotifyLog(logPath);
  assert.equal(entries.length, 1);
});

test('notify: only completed/done sessions → fires (gate ignores non-active states)', async () => {
  const logPath = process.env.GOALNIGHT_NOTIFY_LOG;
  await planNight({ objective: 'q', milestones: ['m'], quiet_hours: windowAroundNow() });
  getDb().prepare("UPDATE sessions SET state = 'complete'").run();
  notify({ type: 'blocking-decision', title: 'd', body: 'd' });
  const entries = readNotifyLog(logPath);
  assert.equal(entries.length, 1, "completed session's quiet_hours should not gate new notifications");
});

test('notify: gate picks the MOST-RECENT active session when multiple exist', async () => {
  const logPath = process.env.GOALNIGHT_NOTIFY_LOG;
  // older session: no quiet_hours
  await planNight({ objective: 'old', milestones: ['m'] });
  // newer session: in-window quiet_hours — should win the ORDER BY updated_at DESC
  await planNight({ objective: 'new', milestones: ['m'], quiet_hours: windowAroundNow() });
  notify({ type: 'blocking-decision', title: 'd', body: 'd' });
  const entries = readNotifyLog(logPath);
  assert.equal(entries.length, 0, 'newer session quiet_hours should suppress');
});

test('notify: DB error → fires (fail-open in catch branch)', () => {
  const logPath = process.env.GOALNIGHT_NOTIFY_LOG;
  closeDb();
  // Point GOALNIGHT_DATA at a path under /dev/null — mkdirSync throws ENOTDIR.
  process.env.GOALNIGHT_DATA = '/dev/null/goalnight-cannot-mkdir';
  try {
    notify({ type: 'usage-limited', title: 'u', body: 'u' });
  } finally {
    process.env.GOALNIGHT_DATA = dataDir; // restore so afterEach cleans correctly
    closeDb();
  }
  const entries = readNotifyLog(logPath);
  assert.equal(entries.length, 1, 'DB throw should fall through to platform notify');
});

test('plan_night quiet_hours survives a lazy ALTER TABLE on pre-feature DBs', async () => {
  // Simulate an older DB that has the sessions table without the quiet_hours column.
  // Drop the schema's column to mimic the pre-feature state, then re-run planNight
  // — the lazy ALTER TABLE in plan_night.js should re-add it.
  const db = getDb();
  db.exec(`
    DROP TABLE turn_log;
    DROP TABLE decisions;
    DROP TABLE findings;
    DROP TABLE milestones;
    DROP TABLE sessions;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      hours INTEGER NOT NULL,
      target_quota_pct REAL DEFAULT 0.8,
      token_budget INTEGER,
      tokens_used INTEGER DEFAULT 0,
      state TEXT DEFAULT 'planned',
      next_quota_reset_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE milestones (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      estimated_tokens INTEGER,
      ordinal INTEGER NOT NULL,
      state TEXT DEFAULT 'pending',
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);
  // Pre-feature schema is in place. planNight should ALTER + insert successfully.
  const r = await planNight({ objective: 'lazy', milestones: ['m'], quiet_hours: '22:00-07:00' });
  const row = getDb().prepare('SELECT quiet_hours FROM sessions WHERE id = ?').get(r.session_id);
  assert.equal(row.quiet_hours, '22:00-07:00');
});
