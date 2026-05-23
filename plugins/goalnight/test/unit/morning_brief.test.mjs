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
  'decisions_awaiting', 'uncertain_decisions', 'findings_highlights', 'markdown',
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
  assert.equal(brief.uncertain_decisions.length, 0);
  assert.equal(brief.findings_highlights.length, 0);

  // Empty-state markdown: no empty Decisions/Findings sections, but Pending block present.
  assert.match(brief.markdown, /goalnight — morning brief/);
  assert.match(brief.markdown, /Goal:.*ship the feature/);
  assert.doesNotMatch(brief.markdown, /Decisions waiting/);
  assert.doesNotMatch(brief.markdown, /Decisions you might want to review/);
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
  const b = await planNight({ objective: 'session B', milestones: ['n'] });
  assert.equal((await morningBrief({ session_id: a.session_id })).objective, 'session A');
  assert.equal((await morningBrief({ session_id: b.session_id })).objective, 'session B');
});

test('morning_brief: no uncertain decisions → uncertain_decisions=[] and section omitted', async () => {
  await planNight({ objective: 'no uncertainty', milestones: ['m'] });
  await logDecision({ question: 'plain choice' });
  const brief = await morningBrief({});
  assert.deepEqual(brief.uncertain_decisions, []);
  assert.doesNotMatch(brief.markdown, /Decisions you might want to review/);
});

test('morning_brief: 2 uncertain decisions render in dedicated section', async () => {
  await planNight({ objective: 'with doubts', milestones: ['m'] });
  await logDecision({
    question: 'Postgres or SQLite?',
    recommendation: 'Postgres',
    reasoning: 'prod uses it',
    uncertain: true,
  });
  await logDecision({
    question: 'Camel or snake for new fields?',
    recommendation: 'snake_case',
    reasoning: 'matches surrounding code',
    uncertain: true,
  });

  const brief = await morningBrief({});
  assert.equal(brief.uncertain_decisions.length, 2);
  assert.match(brief.markdown, /Decisions you might want to review \(2\)/);
  assert.match(brief.markdown, /Postgres or SQLite\?/);
  assert.match(brief.markdown, /Camel or snake for new fields\?/);
  assert.match(brief.markdown, /\*\*Chose:\*\* Postgres/);
  assert.match(brief.markdown, /\*\*Chose:\*\* snake_case/);
  assert.match(brief.markdown, /prod uses it/);
  // one-liner mentions uncertain count
  assert.match(brief.summary_one_liner, /2 to double-check/);
});

test('morning_brief: mixed 1 blocking + 2 uncertain → split cleanly, no cross-contamination', async () => {
  await planNight({ objective: 'mixed', milestones: ['m'] });
  await logDecision({
    question: 'BLOCK: drop legacy table?',
    recommendation: 'drop',
    blocking: true,
  });
  await logDecision({
    question: 'UNC: use lib X?',
    recommendation: 'X',
    uncertain: true,
  });
  await logDecision({
    question: 'UNC: name it Foo?',
    recommendation: 'Foo',
    uncertain: true,
  });

  const brief = await morningBrief({});
  assert.equal(brief.decisions_awaiting.length, 1);
  assert.equal(brief.decisions_awaiting[0].question, 'BLOCK: drop legacy table?');
  assert.equal(brief.uncertain_decisions.length, 2);
  for (const u of brief.uncertain_decisions) {
    assert.ok(u.question.startsWith('UNC:'), `uncertain row leaked into blocking: ${u.question}`);
  }
  // The blocking question must NOT appear under "Decisions you might want to review",
  // and the uncertain questions must NOT appear under "Decisions waiting".
  const md = brief.markdown;
  const waitingIdx = md.indexOf('Decisions waiting');
  const reviewIdx = md.indexOf('Decisions you might want to review');
  assert.ok(waitingIdx >= 0 && reviewIdx > waitingIdx, 'review section comes after waiting');
  const waitingBlock = md.slice(waitingIdx, reviewIdx);
  const reviewBlock = md.slice(reviewIdx);
  assert.match(waitingBlock, /BLOCK: drop legacy table/);
  assert.doesNotMatch(waitingBlock, /UNC: use lib X/);
  assert.doesNotMatch(waitingBlock, /UNC: name it Foo/);
  assert.match(reviewBlock, /UNC: use lib X/);
  assert.match(reviewBlock, /UNC: name it Foo/);
  assert.doesNotMatch(reviewBlock, /BLOCK: drop legacy table/);
  // one-liner mentions both counts
  assert.match(brief.summary_one_liner, /1 decision need you/);
  assert.match(brief.summary_one_liner, /2 to double-check/);
});

test('morning_brief: resolved uncertain decisions do NOT surface', async () => {
  const p = await planNight({ objective: 'cleanup', milestones: ['m'] });
  const r = await logDecision({
    question: 'pick one',
    recommendation: 'A',
    uncertain: true,
  });
  // Mark as resolved.
  getDb().prepare('UPDATE decisions SET resolved = 1 WHERE id = ?').run(r.id);

  const brief = await morningBrief({ session_id: p.session_id });
  assert.equal(brief.uncertain_decisions.length, 0);
  assert.doesNotMatch(brief.markdown, /Decisions you might want to review/);
  assert.doesNotMatch(brief.summary_one_liner, /double-check/);
});
