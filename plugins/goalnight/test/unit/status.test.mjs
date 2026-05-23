import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb } from '../_helpers/db.mjs';
import { planNight } from '../../server/tools/plan_night.js';
import { logDecision } from '../../server/tools/log_decision.js';
import { logFinding } from '../../server/tools/log_finding.js';
import { status } from '../../server/tools/status.js';
import { getDb } from '../../server/db/client.js';

let dataDir;
beforeEach(() => { dataDir = freshDb(); });
afterEach(() => { cleanupDb(dataDir); });

test('status returns none-state when no session exists or unknown id', async () => {
  const empty = await status({});
  assert.equal(empty.state, 'none');
  assert.match(empty.message, /No goalnight session/);

  await planNight({ objective: 'real', milestones: ['m'] });
  const unknown = await status({ session_id: 'not-a-real-id' });
  assert.equal(unknown.state, 'none');
});

test('status returns session + milestones in ordinal order', async () => {
  const p = await planNight({ objective: 'recent', milestones: ['first', 'second', 'third'] });
  const r = await status({});
  assert.equal(r.session_id, p.session_id);
  assert.equal(r.state, 'planned');
  assert.equal(r.objective, 'recent');
  assert.equal(r.tokens_used, 0);
  assert.ok(r.token_budget > 0);
  assert.deepEqual(r.milestones.map(m => m.title), ['first', 'second', 'third']);
  assert.equal(r.milestones[0].ordinal, 1);
  for (const m of r.milestones) assert.equal(m.state, 'pending');
});

test('status pending_decisions_count tracks unresolved decisions', async () => {
  await planNight({ objective: 'd', milestones: ['m'] });
  await logDecision({ question: 'q1?' });
  await logDecision({ question: 'q2?' });
  assert.equal((await status({})).pending_decisions_count, 2);

  getDb().prepare('UPDATE decisions SET resolved = 1 WHERE question = ?').run('q1?');
  assert.equal((await status({})).pending_decisions_count, 1);
});

test('status picks the most-recently-INSERTed session when updated_at is tied (rowid tiebreaker — regression for Task #33)', async () => {
  // Same-ms tie: two sessions share updated_at. The query ORDER BY updated_at DESC,
  // rowid DESC must return the second-INSERTed session.
  const a = await planNight({ objective: 'first', milestones: ['x'] });
  const b = await planNight({ objective: 'second', milestones: ['y'] });
  const ts = Date.now();
  const db = getDb();
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(ts, a.session_id);
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(ts, b.session_id);
  const r = await status({});
  assert.equal(r.session_id, b.session_id);
  assert.equal(r.objective, 'second');
});

test('status findings_count + elapsed/burn-rate fields present', async () => {
  await planNight({ objective: 'f', milestones: ['m'] });
  for (const t of ['insight', 'note', 'warning']) {
    await logFinding({ type: t, content: t });
  }
  const r = await status({});
  assert.equal(r.findings_count, 3);
  assert.equal(typeof r.elapsed_seconds, 'number');
  assert.ok(r.elapsed_seconds >= 0);
  assert.equal(typeof r.burn_rate_tokens_per_min, 'number');
});
