import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb } from '../_helpers/db.mjs';
import { planNight } from '../../server/tools/plan_night.js';
import { getDb } from '../../server/db/client.js';

let dataDir;
beforeEach(() => { dataDir = freshDb(); });
afterEach(() => { cleanupDb(dataDir); });

test('plan_night returns full shape + persists session/milestones to SQLite', async () => {
  const result = await planNight({
    objective: 'test goal',
    hours: 8,
    milestones: ['a', 'b', 'c'],
  });
  assert.ok(result.session_id);
  assert.equal(result.objective, 'test goal');
  assert.equal(result.milestones.length, 3);
  assert.equal(result.milestones[0].ordinal, 1);
  assert.equal(result.milestones[2].ordinal, 3);
  assert.ok(result.codex_goal_command.includes('test goal'));

  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.session_id);
  assert.equal(row.objective, 'test goal');
  assert.equal(row.hours, 8);
  assert.equal(row.state, 'planned');
  const ms = db.prepare('SELECT title, ordinal FROM milestones WHERE session_id = ? ORDER BY ordinal').all(result.session_id);
  assert.deepEqual(ms.map(m => m.title), ['a', 'b', 'c']);
});

test('plan_night token_budget = (hours/5)*QUOTA*target_pct, distributed evenly', async () => {
  // QUOTA default 200_000. (10/5)*200000*0.5 = 200000, split across 4 milestones → 50000 each.
  const r = await planNight({
    objective: 'budget math',
    hours: 10,
    target_quota_pct: 0.5,
    milestones: ['a', 'b', 'c', 'd'],
  });
  assert.equal(r.estimated_token_budget, 200_000);
  assert.equal(r.quota_periods_covered, 2);
  for (const m of r.milestones) assert.equal(m.estimated_tokens, 50_000);
});

test('plan_night defaults to hours=8, target_quota_pct=0.8', async () => {
  // (8/5)*200000*0.8 = 256000
  const r = await planNight({ objective: 'defaults', milestones: ['x'] });
  assert.equal(r.estimated_token_budget, 256_000);
});

test('plan_night throws when objective is missing or empty', async () => {
  await assert.rejects(() => planNight({ milestones: ['x'] }), /objective is required/);
  await assert.rejects(() => planNight({ objective: '   ', milestones: ['x'] }), /objective is required/);
});

test('plan_night throws when milestones is empty or not an array', async () => {
  await assert.rejects(() => planNight({ objective: 'x', milestones: [] }), /at least 1 item/);
  await assert.rejects(() => planNight({ objective: 'x', milestones: 'no' }), /at least 1 item/);
});

test('plan_night throws when target_quota_pct is out of (0, 1] range', async () => {
  for (const bad of [0, 1.5, -0.1]) {
    await assert.rejects(
      () => planNight({ objective: 'x', milestones: ['m'], target_quota_pct: bad }),
      /target_quota_pct/
    );
  }
});
