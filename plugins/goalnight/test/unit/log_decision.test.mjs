import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshDb, cleanupDb, notifyLogPath, readNotifyLog, clearNotifyLog,
} from '../_helpers/db.mjs';
import { planNight } from '../../server/tools/plan_night.js';
import { logDecision } from '../../server/tools/log_decision.js';
import { getDb } from '../../server/db/client.js';

let dataDir, notifyPath;
beforeEach(() => {
  dataDir = freshDb();
  notifyPath = notifyLogPath(dataDir);
});
afterEach(() => {
  clearNotifyLog();
  cleanupDb(dataDir);
});

const withSession = () => planNight({ objective: 'host', milestones: ['m'] });

test('log_decision (non-blocking) persists row, does NOT fire notify', async () => {
  const p = await withSession();
  const r = await logDecision({
    question: 'A or B?',
    options: ['A', 'B'],
    recommendation: 'A',
    reasoning: 'A has fewer deps',
  });

  assert.ok(r.id);
  assert.equal(r.session_id, p.session_id);
  assert.equal(r.resolved, false);
  assert.equal(r.will_appear_in_brief, true);

  const row = getDb().prepare('SELECT * FROM decisions WHERE id = ?').get(r.id);
  assert.equal(row.question, 'A or B?');
  assert.equal(row.recommendation, 'A');
  assert.equal(row.reasoning, 'A has fewer deps');
  assert.equal(row.blocking, 0);
  assert.equal(row.resolved, 0);
  assert.deepEqual(JSON.parse(row.options), ['A', 'B']);

  assert.equal(readNotifyLog(notifyPath).length, 0);
});

test('log_decision (blocking=true) sets blocking=1 + fires notify with sound', async () => {
  await withSession();
  const r = await logDecision({
    question: 'Should we drop the legacy migration?',
    recommendation: 'Drop',
    blocking: true,
  });
  assert.equal(getDb().prepare('SELECT blocking FROM decisions WHERE id = ?').get(r.id).blocking, 1);

  const notifies = readNotifyLog(notifyPath);
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].type, 'blocking-decision');
  assert.equal(notifies[0].sound, true);
  assert.match(notifies[0].title, /Decision/);
  assert.ok(notifies[0].body.includes('legacy migration'));
});

test('log_decision truncates notify body to 120 chars', async () => {
  await withSession();
  await logDecision({ question: 'Q'.repeat(300), blocking: true });
  assert.equal(readNotifyLog(notifyPath)[0].body.length, 120);
});

test('log_decision throws when question missing or no session exists', async () => {
  await assert.rejects(() => logDecision({ question: 'orphan?' }), /No active session/);
  await withSession();
  await assert.rejects(() => logDecision({}), /question is required/);
});

test('log_decision options/recommendation/reasoning are all optional', async () => {
  await withSession();
  const r = await logDecision({ question: 'minimal?' });
  const row = getDb().prepare('SELECT * FROM decisions WHERE id = ?').get(r.id);
  assert.equal(row.options, null);
  assert.equal(row.recommendation, null);
  assert.equal(row.reasoning, null);
  assert.equal(row.blocking, 0);
});

test('log_decision attaches to the most recent session', async () => {
  await planNight({ objective: 'first', milestones: ['x'] });
  const second = await planNight({ objective: 'second', milestones: ['y'] });
  const r = await logDecision({ question: 'belongs where?' });
  assert.equal(r.session_id, second.session_id);
});
