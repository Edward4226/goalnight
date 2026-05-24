import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end test for the stop hook:
//   - spawn the hook as codex would (stdin = JSON payload)
//   - verify the turn_log row + session state changes
//   - exercise the Task #14 fix (turn_log goal_state_after reflects the
//     transition in the SAME row, not the next one)
//   - exercise the Task #12 multi-field-name fallback by sending payloads
//     with different state-field names

const ROOT = new URL('../..', import.meta.url).pathname;  // plugin root
const HOOK = join(ROOT, 'hooks', 'stop.js');

let dataDir;
let notifyLog;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gn-stop-hook-'));
  notifyLog = join(dataDir, 'notify.log');
});

after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

// Spawn the hook with a payload over stdin. Returns { exitCode, stderr }.
function runHook(payload) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK], {
      env: {
        ...process.env,
        GOALNIGHT_DATA: dataDir,
        GOALNIGHT_NOTIFY_LOG: notifyLog,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => resolve({ exitCode: code, stderr }));
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

// Open the isolated DB the hook just wrote to (via direct better-sqlite3).
async function openDb() {
  const { default: Database } = await import('better-sqlite3');
  return new Database(join(dataDir, 'goalnight.db'));
}

test('stop hook records turn_log with before=after when no transition (Task #14)', async () => {
  // Set up a session in DB by calling plan_night + manually flipping state to active.
  process.env.GOALNIGHT_DATA = dataDir;
  const { planNight } = await import('../../server/tools/plan_night.js');
  const plan = await planNight({ objective: 'no-transition test', milestones: ['m'] });
  const db = await openDb();
  db.prepare("UPDATE sessions SET state='active' WHERE id=?").run(plan.session_id);

  // Hook fires with the same active state — no transition expected.
  const r = await runHook({
    turn_number: 1,
    token_usage: { delta: 100 },
    tools_called: ['read_file'],
    goal_state: 'active',
  });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);

  const row = db.prepare(
    `SELECT goal_state_before, goal_state_after, tokens_delta
     FROM turn_log WHERE session_id=? ORDER BY rowid DESC LIMIT 1`
  ).get(plan.session_id);
  assert.equal(row.goal_state_before, 'active');
  assert.equal(row.goal_state_after, 'active');  // no transition — same as before
  assert.equal(row.tokens_delta, 100);

  // Session state should be unchanged.
  const s = db.prepare('SELECT state FROM sessions WHERE id=?').get(plan.session_id);
  assert.equal(s.state, 'active');

  // No notification should have fired (no transition).
  if (existsSync(notifyLog)) {
    const log = readFileSync(notifyLog, 'utf8');
    assert.equal(log, '', `unexpected notify: ${log}`);
  }
  db.close();
});

test('stop hook captures real transition in turn_log SAME row (Task #14 fix)', async () => {
  // Reset notify log between tests.
  try { unlinkSync(notifyLog); } catch {}

  process.env.GOALNIGHT_DATA = dataDir;
  const { planNight } = await import('../../server/tools/plan_night.js');
  const plan = await planNight({ objective: 'transition test', milestones: ['m'] });
  const db = await openDb();
  db.prepare("UPDATE sessions SET state='active' WHERE id=?").run(plan.session_id);

  // Hook fires with NEW state = usage_limited — transition expected.
  const r = await runHook({
    turn_number: 5,
    token_usage: { delta: 300 },
    goal_state: 'usage_limited',
  });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);

  // The turn_log row from THIS turn should already capture the transition.
  // Pre-fix: it would have shown after='active' (the old state).
  const row = db.prepare(
    `SELECT goal_state_before, goal_state_after
     FROM turn_log WHERE session_id=? ORDER BY rowid DESC LIMIT 1`
  ).get(plan.session_id);
  assert.equal(row.goal_state_before, 'active');
  assert.equal(row.goal_state_after, 'usage_limited');  // ← Task #14 fix

  // sessions.state should have been updated.
  const s = db.prepare('SELECT state FROM sessions WHERE id=?').get(plan.session_id);
  assert.equal(s.state, 'usage_limited');

  // Notification should have fired with type='usage-limited'.
  const log = readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(log.length, 1);
  const notif = JSON.parse(log[0]);
  assert.equal(notif.type, 'usage-limited');
  db.close();
});

test('stop hook reads alternate field names — Task #12 fallback chain', async () => {
  try { unlinkSync(notifyLog); } catch {}

  process.env.GOALNIGHT_DATA = dataDir;
  const { planNight } = await import('../../server/tools/plan_night.js');
  const plan = await planNight({ objective: 'field name fallback test', milestones: ['m'] });
  const db = await openDb();
  db.prepare("UPDATE sessions SET state='active' WHERE id=?").run(plan.session_id);

  // Fire hook with NO `goal_state` — use camelCase `goalState` instead.
  const r = await runHook({
    turn_number: 1,
    goalState: 'blocked',  // ← alternate field name
  });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);

  const row = db.prepare(
    `SELECT goal_state_after FROM turn_log
     WHERE session_id=? ORDER BY rowid DESC LIMIT 1`
  ).get(plan.session_id);
  assert.equal(row.goal_state_after, 'blocked');

  const s = db.prepare('SELECT state FROM sessions WHERE id=?').get(plan.session_id);
  assert.equal(s.state, 'blocked');

  db.close();
});

test('stop hook handles payload with no state field — no transition', async () => {
  try { unlinkSync(notifyLog); } catch {}

  process.env.GOALNIGHT_DATA = dataDir;
  const { planNight } = await import('../../server/tools/plan_night.js');
  const plan = await planNight({ objective: 'no-state test', milestones: ['m'] });
  const db = await openDb();
  db.prepare("UPDATE sessions SET state='active' WHERE id=?").run(plan.session_id);

  // Fire hook with payload missing any recognized state field — should no-op
  // gracefully (no crash, no fake transition).
  const r = await runHook({ turn_number: 1, token_usage: { delta: 50 } });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);

  const row = db.prepare(
    `SELECT goal_state_before, goal_state_after FROM turn_log
     WHERE session_id=? ORDER BY rowid DESC LIMIT 1`
  ).get(plan.session_id);
  assert.equal(row.goal_state_before, 'active');
  assert.equal(row.goal_state_after, 'active');

  const s = db.prepare('SELECT state FROM sessions WHERE id=?').get(plan.session_id);
  assert.equal(s.state, 'active');

  // No notify fired.
  if (existsSync(notifyLog)) {
    const log = readFileSync(notifyLog, 'utf8');
    assert.equal(log, '', `unexpected notify: ${log}`);
  }
  db.close();
});
