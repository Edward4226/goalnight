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

// ── Token Waste Receipt: receipt_data shape + compute ─────────────────────

const QUOTA_WINDOW_SEC = 5 * 3600;

/** Backdate a session and add fake tokens so burn-rate math is deterministic. */
function ageSessionWithUsage(sessionId, elapsedSec, tokensUsed) {
  const db = getDb();
  const created = Date.now() - elapsedSec * 1000;
  db.prepare('UPDATE sessions SET created_at = ?, tokens_used = ? WHERE id = ?')
    .run(created, tokensUsed, sessionId);
}

/** Insert a turn_log row representing a quota refresh window goalnight relit through. */
function logRelitTurn(sessionId) {
  const db = getDb();
  db.prepare(
    `INSERT INTO turn_log
       (session_id, turn_number, tokens_delta, tools_called,
        goal_state_before, goal_state_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, 1, 0, null, 'usage_limited', 'active', Date.now());
}

test('receipt_data: shape — all expected keys present, even on empty state', async () => {
  const p = await planNight({ objective: 'shape check', milestones: ['m'] });
  const brief = await morningBrief({ session_id: p.session_id });
  const r = brief.receipt_data;

  assert.ok(r, 'receipt_data present');
  assert.equal(r.session_id, p.session_id);
  for (const k of ['tokens_reclaimed', 'cost_estimate_usd', 'plan_used', 'quota_windows_relit']) {
    assert.ok(k in r.headline, `headline.${k} present`);
  }
  for (const k of ['overnight', 'milestones', 'decisions', 'findings']) {
    assert.ok(k in r.lines, `lines.${k} present`);
  }
  assert.equal(r.foot.session_short.length, 8, 'session_short is 8 chars');
  assert.equal(r.foot.session_short, p.session_id.slice(0, 8));
  assert.equal(r.foot.brand_url, 'goalnight.dev');

  // Empty / 0-relit branch: reclaim is honestly 0; lines render sane defaults.
  assert.equal(r.headline.tokens_reclaimed, 0);
  assert.equal(r.headline.quota_windows_relit, 0);
  assert.equal(r.lines.milestones, '0 / 1');
  assert.equal(r.lines.decisions, '0 routed · 0 woke you');
  assert.equal(r.lines.findings, '0 logged · 0 bugs fixed');
});

test('receipt_data: 0 relits → tokens_reclaimed=0; cost falls back on actual tokens_used', async () => {
  const p = await planNight({ objective: 'clean run', milestones: ['m'] });
  ageSessionWithUsage(p.session_id, 3600, 50000); // 1h, 50k tokens

  const r = (await morningBrief({ session_id: p.session_id })).receipt_data;
  assert.equal(r.headline.tokens_reclaimed, 0);
  assert.equal(r.headline.quota_windows_relit, 0);
  // 50k tok × $150/Mtok = $7.50 — cost shown on the actual usage in the 0-relit branch.
  assert.equal(r.headline.cost_estimate_usd, 7.5);
});

test('receipt_data: 1 relit → tokens_reclaimed matches formula', async () => {
  const p = await planNight({ objective: 'one relight', milestones: ['m'] });
  // 6h elapsed, 60k tokens used → burn rate = 60000/360 min = ~167 tok/min, then rounded → 167.
  // capped = min(1 * 18000s, 21600s) = 18000s = 300min.
  // tokens_reclaimed = 300 * 167 = 50100.
  ageSessionWithUsage(p.session_id, 6 * 3600, 60000);
  logRelitTurn(p.session_id);

  const r = (await morningBrief({ session_id: p.session_id })).receipt_data;
  assert.equal(r.headline.quota_windows_relit, 1);

  const burnRate = Math.round((60000 / (6 * 3600)) * 60);
  const expectedReclaim = Math.round((QUOTA_WINDOW_SEC / 60) * burnRate);
  assert.equal(r.headline.tokens_reclaimed, expectedReclaim);
});

test('receipt_data: tokens_reclaimed capped at elapsed time (multi-relit short session)', async () => {
  // 1h elapsed but 3 windows relit — capped at the 1h of actual run.
  const p = await planNight({ objective: 'cap me', milestones: ['m'] });
  ageSessionWithUsage(p.session_id, 3600, 30000);
  logRelitTurn(p.session_id);
  logRelitTurn(p.session_id);
  logRelitTurn(p.session_id);

  const r = (await morningBrief({ session_id: p.session_id })).receipt_data;
  assert.equal(r.headline.quota_windows_relit, 3);

  // burn rate = 30000/60 = 500 tok/min. capped at 60 min = 30000 tokens.
  assert.equal(r.headline.tokens_reclaimed, 30000);
});

test('receipt_data: cost_estimate uses GOALNIGHT_PLAN override; 2 decimals exactly', async () => {
  const p = await planNight({ objective: 'plan switch', milestones: ['m'] });
  ageSessionWithUsage(p.session_id, 6 * 3600, 60000);
  logRelitTurn(p.session_id);

  // Default (pro = $150/Mtok).
  const defaultBrief = await morningBrief({ session_id: p.session_id });
  const defaultCost = defaultBrief.receipt_data.headline.cost_estimate_usd;
  const reclaim = defaultBrief.receipt_data.headline.tokens_reclaimed;
  assert.equal(defaultCost, +((reclaim / 1_000_000) * 150).toFixed(2));
  // Always 2 decimals → Number with at most 2 fractional digits.
  assert.ok(/^\d+(\.\d{1,2})?$/.test(String(defaultCost)), `${defaultCost} has ≤2 decimals`);

  process.env.GOALNIGHT_PLAN = 'plus';
  try {
    const r = (await morningBrief({ session_id: p.session_id })).receipt_data;
    assert.equal(r.headline.plan_used, 'plus');
    assert.equal(r.headline.cost_estimate_usd, +((reclaim / 1_000_000) * 200).toFixed(2));
  } finally {
    delete process.env.GOALNIGHT_PLAN;
  }
});

test('receipt_data: lines reflect milestones/decisions/findings counts', async () => {
  const p = await planNight({ objective: 'count me', milestones: ['a', 'b', 'c'] });
  // 2 done, 1 pending.
  getDb().prepare(
    `UPDATE milestones SET state='done' WHERE session_id=? AND ordinal<=2`
  ).run(p.session_id);

  await logDecision({ question: 'normal one' });
  await logDecision({ question: 'blocking one', blocking: true });

  await logFinding({ type: 'bug', content: 'fixed a thing', severity: 'high' });
  await logFinding({ type: 'insight', content: 'noted', severity: 'low' });
  await logFinding({ type: 'note', content: 'fyi', severity: 'low' });

  const r = (await morningBrief({ session_id: p.session_id })).receipt_data;
  assert.equal(r.lines.milestones, '2 / 3');
  assert.equal(r.lines.decisions, '2 routed · 1 woke you');
  assert.equal(r.lines.findings, '3 logged · 1 bug fixed');
});

test('morning_brief.markdown remains unchanged when receipt_data is added (additive)', async () => {
  // Regression guard: adding receipt_data must NOT touch the markdown output
  // that downstream skills depend on.
  await planNight({ objective: 'additive', milestones: ['m1', 'm2'] });
  const brief = await morningBrief({});
  assert.match(brief.markdown, /goalnight — morning brief/);
  assert.match(brief.markdown, /Goal:.*additive/);
  assert.match(brief.markdown, /Pending \(2\)/);
  // Receipt data must not have bled into markdown.
  assert.doesNotMatch(brief.markdown, /receipt_data/);
  assert.doesNotMatch(brief.markdown, /tokens_reclaimed/);
});
