import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb } from '../_helpers/db.mjs';
import { planNight } from '../../server/tools/plan_night.js';
import { logFinding } from '../../server/tools/log_finding.js';
import { getDb } from '../../server/db/client.js';

let dataDir;
beforeEach(() => { dataDir = freshDb(); });
afterEach(() => { cleanupDb(dataDir); });

const withSession = () => planNight({ objective: 'host', milestones: ['m'] });

test('log_finding persists row with default severity + ties to session', async () => {
  const p = await withSession();
  const r = await logFinding({ type: 'insight', content: 'legacy User model exists' });
  assert.ok(r.id);
  assert.equal(r.session_id, p.session_id);
  assert.equal(typeof r.logged_at, 'number');

  const row = getDb().prepare('SELECT * FROM findings WHERE id = ?').get(r.id);
  assert.equal(row.type, 'insight');
  assert.equal(row.content, 'legacy User model exists');
  assert.equal(row.severity, 'low');
  assert.equal(row.context_files, null);
});

test('log_finding accepts all 4 types and 3 severity values', async () => {
  await withSession();
  for (const type of ['insight', 'warning', 'bug', 'note']) {
    await logFinding({ type, content: `${type} body` });
  }
  for (const severity of ['low', 'medium', 'high']) {
    await logFinding({ type: 'note', content: severity, severity });
  }
  const db = getDb();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM findings').get().c, 7);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM findings WHERE severity = ?').get('high').c, 1);
});

test('log_finding stores context_files as JSON-encoded array', async () => {
  await withSession();
  const files = ['src/a.js', 'src/b.js'];
  const r = await logFinding({
    type: 'bug',
    content: 'null pointer',
    context_files: files,
    severity: 'high',
  });
  const row = getDb().prepare('SELECT * FROM findings WHERE id = ?').get(r.id);
  assert.equal(row.severity, 'high');
  assert.deepEqual(JSON.parse(row.context_files), files);
});

test('log_finding throws when type or content missing, or no session exists', async () => {
  // No session yet
  await assert.rejects(() => logFinding({ type: 'insight', content: 'orphan' }), /No active session/);
  await withSession();
  await assert.rejects(() => logFinding({ content: 'no type' }), /required/);
  await assert.rejects(() => logFinding({ type: 'insight' }), /required/);
});

test('log_finding attaches to the most recent session', async () => {
  await planNight({ objective: 'first', milestones: ['x'] });
  await new Promise(r => setTimeout(r, 5));
  const second = await planNight({ objective: 'second', milestones: ['y'] });
  const r = await logFinding({ type: 'note', content: 'belongs to second' });
  assert.equal(r.session_id, second.session_id);
});
