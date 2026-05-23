import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, cleanupDb } from '../_helpers/db.mjs';
import { planNight } from '../../server/tools/plan_night.js';
import { logDecision } from '../../server/tools/log_decision.js';
import { logFinding } from '../../server/tools/log_finding.js';
import { buildRecap } from '../../server/recap/builder.js';
import { getDb } from '../../server/db/client.js';

let dataDir;
beforeEach(() => { dataDir = freshDb(); });
afterEach(() => { cleanupDb(dataDir); });

function loadSession() {
  return getDb().prepare('SELECT * FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT 1').get();
}

function setMilestoneStates(sessionId, statesByOrdinal) {
  const db = getDb();
  const stmt = db.prepare('UPDATE milestones SET state = ? WHERE session_id = ? AND ordinal = ?');
  for (const [ord, state] of Object.entries(statesByOrdinal)) {
    stmt.run(state, sessionId, Number(ord));
  }
}

function setSessionState(sessionId, patch) {
  const db = getDb();
  const sets = Object.keys(patch).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE sessions SET ${sets} WHERE id = ?`).run(...Object.values(patch), sessionId);
}

test('buildRecap: empty session returns concise recap with goal + token line + footer', async () => {
  await planNight({ objective: 'ship the feature', milestones: ['design', 'code', 'test'], hours: 8 });
  const db = getDb();
  const session = loadSession();
  const recap = buildRecap({ db, session });

  assert.match(recap, /goalnight — context recap/);
  assert.match(recap, /GOAL: ship the feature/);
  assert.match(recap, /TOKENS USED: 0/);
  assert.match(recap, /ELAPSED: \d+h \d+m/);
  // No done/in_progress milestones yet → no DONE/CURRENT sections,
  // but PENDING should list all 3.
  assert.doesNotMatch(recap, /MILESTONES DONE/);
  assert.doesNotMatch(recap, /CURRENT MILESTONE:/);
  assert.match(recap, /MILESTONES PENDING \(3\)/);
  assert.doesNotMatch(recap, /DECISIONS ALREADY LOGGED/);
  assert.doesNotMatch(recap, /FINDINGS ALREADY LOGGED/);
  // Anti-restart footer is the contract — must always be present.
  assert.match(recap, /CONTEXT preservation message, not a fresh task/);
  assert.match(recap, /do not restart/);
  assert.match(recap, /re-explore/);
});

test('buildRecap: full session (done/current/pending + decisions + findings)', async () => {
  const plan = await planNight({
    objective: 'wire up the auth flow',
    milestones: ['schema', 'endpoint', 'tests', 'docs'],
    hours: 8,
  });
  setMilestoneStates(plan.session_id, { 1: 'done', 2: 'done', 3: 'in_progress' });
  setSessionState(plan.session_id, { tokens_used: 60_000, state: 'active' });

  await logDecision({
    question: 'Use lib X or lib Y for hashing?',
    recommendation: 'X',
    reasoning: 'X is already in the dep tree and matches our node version.',
    blocking: false,
  });
  await logDecision({
    question: 'Block on missing migration?',
    recommendation: 'Write the migration inline',
    reasoning: 'Faster than waiting for review.',
    blocking: true,
  });
  await logFinding({ type: 'insight', content: 'helper auth/util.js already covers token parsing' });
  await logFinding({ type: 'warning', content: 'index migration will lock users table ~3s', severity: 'high' });

  const recap = buildRecap({ db: getDb(), session: loadSession() });

  assert.match(recap, /GOAL: wire up the auth flow/);
  assert.match(recap, /MILESTONES DONE \(2\)/);
  assert.match(recap, /✅ schema/);
  assert.match(recap, /✅ endpoint/);
  assert.match(recap, /CURRENT MILESTONE/);
  assert.match(recap, /⏳ tests/);
  assert.match(recap, /MILESTONES PENDING \(1\)/);
  assert.match(recap, /• docs/);

  assert.match(recap, /DECISIONS ALREADY LOGGED/);
  // Blocking decision comes first.
  assert.ok(
    recap.indexOf('Block on missing migration') < recap.indexOf('Use lib X or lib Y'),
    'blocking decision listed first'
  );
  assert.match(recap, /\[blocking\]/);
  assert.match(recap, /A \(your recommendation\): X/);
  assert.match(recap, /Why: X is already in the dep tree/);

  assert.match(recap, /FINDINGS ALREADY LOGGED/);
  assert.match(recap, /\[insight\] helper auth\/util\.js/);
  assert.match(recap, /\[warning\/high\] index migration/);
});

test('buildRecap: only decisions, no findings — findings section absent', async () => {
  await planNight({ objective: 'fix the bug', milestones: ['repro', 'fix'] });
  await logDecision({ question: 'extract helper?', recommendation: 'no', reasoning: 'one caller' });

  const recap = buildRecap({ db: getDb(), session: loadSession() });
  assert.match(recap, /DECISIONS ALREADY LOGGED/);
  assert.doesNotMatch(recap, /FINDINGS ALREADY LOGGED/);
});

test('buildRecap: only findings, no decisions — decisions section absent', async () => {
  await planNight({ objective: 'audit', milestones: ['scan'] });
  await logFinding({ type: 'bug', content: 'race in queue worker', severity: 'medium' });

  const recap = buildRecap({ db: getDb(), session: loadSession() });
  assert.match(recap, /FINDINGS ALREADY LOGGED/);
  assert.doesNotMatch(recap, /DECISIONS ALREADY LOGGED/);
  assert.match(recap, /\[bug\/medium\] race in queue/);
});

test('buildRecap: 20 findings truncates to 5 most recent with "more in morning brief" hint', async () => {
  await planNight({ objective: 'noisy run', milestones: ['m'] });
  for (let i = 0; i < 20; i++) {
    await logFinding({ type: 'note', content: `finding number ${i}` });
    // Tiny stagger so created_at orders deterministically — better-sqlite3 is sync,
    // but Date.now() can tie. We don't actually need this if the SQL order is
    // deterministic on rowid as a tiebreaker, but the schema doesn't promise that
    // — so we'll just verify the truncation count is right, not which 5.
  }
  const recap = buildRecap({ db: getDb(), session: loadSession() });
  const finding19 = (recap.match(/finding number/g) || []).length;
  assert.equal(finding19, 5, 'exactly 5 findings rendered');
  assert.match(recap, /\(\.\.\. and 15 more in morning brief\)/);
  assert.match(recap, /FINDINGS ALREADY LOGGED — don't re-discover\. \(5 of 20\)/);
});

test('buildRecap: complete session returns short "session complete" message — no overnight grind', async () => {
  const plan = await planNight({ objective: 'wrap up', milestones: ['x'] });
  setSessionState(plan.session_id, { state: 'complete', completed_at: Date.now() });

  const recap = buildRecap({ db: getDb(), session: loadSession() });
  assert.match(recap, /session already complete/);
  assert.match(recap, /No further automated work is needed/);
  // None of the in-flight sections should appear on a complete session.
  assert.doesNotMatch(recap, /MILESTONES DONE/);
  assert.doesNotMatch(recap, /CURRENT MILESTONE/);
  assert.doesNotMatch(recap, /CONTEXT preservation message/);
});

test('buildRecap: missing optional fields on decisions/findings do not blow up', async () => {
  const plan = await planNight({ objective: 'sparse', milestones: ['m'] });
  setMilestoneStates(plan.session_id, { 1: 'in_progress' });

  // Decision with only the required `question`. The model logged it without a
  // recommendation or reasoning (the schema allows this).
  await logDecision({ question: 'should we deploy on Friday?' });
  // Finding without severity defaults to 'low' at the tool layer, but
  // belt-and-braces: directly insert a finding with NULL severity.
  const db = getDb();
  const sid = plan.session_id;
  db.prepare(
    `INSERT INTO findings (id, session_id, type, severity, content, created_at)
     VALUES ('f1', ?, 'note', NULL, 'naked finding', ?)`
  ).run(sid, Date.now());

  const recap = buildRecap({ db, session: loadSession() });
  assert.match(recap, /Q: should we deploy on Friday\?/);
  assert.doesNotMatch(recap, /A \(your recommendation\):.*should we deploy/);
  assert.match(recap, /\[note\] naked finding/);
  // Severity 'low' or null should not surface a /sev suffix.
  assert.doesNotMatch(recap, /\[note\/(low|null)\]/);
});

test('buildRecap: output is safe to inject — no backticks, no triple-quotes, no control chars', async () => {
  const plan = await planNight({
    objective: 'objective with `backticks` and "quotes" and \n newline',
    milestones: ['mile`stone'],
  });
  setMilestoneStates(plan.session_id, { 1: 'in_progress' });
  await logFinding({ type: 'insight', content: 'line one\nline twowith bell' });
  await logDecision({
    question: 'tricky `q`',
    recommendation: '`rec`',
    reasoning: 'multi\nline\nreason',
  });

  const recap = buildRecap({ db: getDb(), session: loadSession() });
  assert.doesNotMatch(recap, /`/, 'no backticks');
  assert.doesNotMatch(recap, /"""/, 'no triple quotes');
  // No bell (0x07) or other low control chars (we keep \n and \t).
  for (const ch of recap) {
    const code = ch.charCodeAt(0);
    const isControl = code < 0x20 && code !== 0x0a && code !== 0x09;
    assert.ok(!isControl, `control char 0x${code.toString(16)} leaked into recap`);
  }
  // The recap collapses embedded newlines in fields so the line-oriented layout stays intact.
  assert.match(recap, /line one line two/);
});

test('buildRecap: returns empty string when called with falsy db or session', () => {
  assert.equal(buildRecap({ db: null, session: { id: 'x' } }), '');
  assert.equal(buildRecap({ db: {}, session: null }), '');
  assert.equal(buildRecap({}), '');
});

test('buildRecap: realistic full-session fixture stays under 3000 chars', async () => {
  const plan = await planNight({
    objective: 'refactor the auth middleware to comply with new session-token storage rules',
    milestones: [
      'audit current middleware paths',
      'design new token store schema',
      'write migration with backfill',
      'add unit tests for token rotation',
      'wire middleware into request pipeline',
      'integration tests against staging',
    ],
  });
  setMilestoneStates(plan.session_id, { 1: 'done', 2: 'done', 3: 'in_progress' });
  setSessionState(plan.session_id, { tokens_used: 90_000, state: 'active' });

  await logDecision({
    question: 'Backfill in one transaction or batched chunks?',
    recommendation: 'batched chunks of 10k rows',
    reasoning: 'single transaction would lock the users table too long under production load.',
    blocking: false,
  });
  await logDecision({
    question: 'Drop the legacy token column now or in a follow-up?',
    recommendation: 'follow-up after one release cycle',
    reasoning: 'gives us a rollback window if the new format misbehaves.',
    blocking: false,
  });
  await logFinding({ type: 'insight', content: 'TokenStore interface already exists in lib/auth/store.ts' });
  await logFinding({ type: 'warning', content: 'staging seed includes test users with the legacy column NULL', severity: 'medium' });
  await logFinding({ type: 'bug', content: 'session expiry check off-by-one when DST transition happens mid-session', severity: 'high' });

  const recap = buildRecap({ db: getDb(), session: loadSession() });
  assert.ok(recap.length < 3000, `recap is ${recap.length} chars, expected < 3000`);
  assert.ok(recap.length > 500, `recap is only ${recap.length} chars — suspiciously short`);
});
