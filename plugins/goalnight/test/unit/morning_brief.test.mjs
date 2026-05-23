import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb } from '../_helpers/db.mjs';
import { planNight } from '../../server/tools/plan_night.js';
import { logFinding } from '../../server/tools/log_finding.js';
import { logDecision } from '../../server/tools/log_decision.js';
import { morningBrief } from '../../server/tools/morning_brief.js';
import { getDb } from '../../server/db/client.js';

let dataDir;
beforeEach(() => { dataDir = freshDb(); });
afterEach(() => { cleanupDb(dataDir); });

const KEYS = [
  'summary_one_liner', 'status', 'objective', 'duration_human', 'tokens_used',
  'token_budget', 'milestones_done', 'milestones_pending',
  'decisions_awaiting', 'findings_highlights', 'markdown',
];

test('morning_brief returns full shape + handles empty state (no decisions/findings)', async () => {
  await planNight({ objective: 'ship the feature', milestones: ['design', 'code', 'test'] });
  const brief = await morningBrief({});

  for (const k of KEYS) assert.ok(k in brief, `key ${k} present`);
  assert.equal(brief.objective, 'ship the feature');
  assert.equal(brief.status, 'planned');
  assert.equal(brief.milestones_pending.length, 3);
  assert.equal(brief.milestones_done.length, 0);
  assert.equal(brief.decisions_awaiting.length, 0);
  assert.equal(brief.findings_highlights.length, 0);

  // Empty-state markdown: no empty Decisions/Findings sections, but Pending block present.
  assert.match(brief.markdown, /goalnight — morning brief/);
  assert.match(brief.markdown, /Goal:.*ship the feature/);
  assert.doesNotMatch(brief.markdown, /Decisions waiting/);
  assert.doesNotMatch(brief.markdown, /Notable findings/);
  assert.match(brief.markdown, /Pending \(3\)/);
});

test('morning_brief surfaces decisions awaiting + findings (with severity ordering)', async () => {
  await planNight({ objective: 'with state', milestones: ['m'] });
  await logDecision({
    question: 'Pick lib X or lib Y?',
    recommendation: 'X',
    reasoning: 'X has better types',
    blocking: true,
  });
  await logFinding({ type: 'warning', content: 'migration locks table 3s', severity: 'high' });
  await logFinding({ type: 'insight', content: 'helper already exists', severity: 'low' });

  const brief = await morningBrief({});
  assert.equal(brief.decisions_awaiting.length, 1);
  assert.equal(brief.findings_highlights.length, 2);

  assert.match(brief.markdown, /Decisions waiting/);
  assert.match(brief.markdown, /Pick lib X or lib Y/);
  assert.match(brief.markdown, /Recommended:.*X/);
  assert.match(brief.markdown, /better types/);
  assert.match(brief.markdown, /blocking/);
  assert.match(brief.markdown, /Notable findings/);
  // high severity sorts before low
  assert.ok(
    brief.markdown.indexOf('migration locks table') < brief.markdown.indexOf('helper already exists'),
    'high severity rendered first'
  );
});

test('morning_brief one-liner reflects state + decision count', async () => {
  const p = await planNight({ objective: 'state line', milestones: ['m1', 'm2'] });
  assert.match((await morningBrief({})).summary_one_liner, /Still running/);

  await logDecision({ question: 'q1?' });
  await logDecision({ question: 'q2?' });
  assert.match((await morningBrief({})).summary_one_liner, /2 decisions need you/);

  // Flip to complete with all milestones done.
  const db = getDb();
  db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run('complete', p.session_id);
  db.prepare('UPDATE milestones SET state = ? WHERE session_id = ?').run('done', p.session_id);
  const done = await morningBrief({});
  assert.match(done.summary_one_liner, /Done/);
  assert.equal(done.milestones_done.length, 2);
  assert.equal(done.milestones_pending.length, 0);
});

test('morning_brief throws when no session exists', async () => {
  await assert.rejects(() => morningBrief({}), /No goalnight session/);
});

test('morning_brief by session_id returns that specific session', async () => {
  const a = await planNight({ objective: 'session A', milestones: ['m'] });
  await new Promise(r => setTimeout(r, 5));
  const b = await planNight({ objective: 'session B', milestones: ['n'] });
  assert.equal((await morningBrief({ session_id: a.session_id })).objective, 'session A');
  assert.equal((await morningBrief({ session_id: b.session_id })).objective, 'session B');
});
