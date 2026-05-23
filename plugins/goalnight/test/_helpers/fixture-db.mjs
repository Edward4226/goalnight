/**
 * Integration-test fixture DB: 1 active session, 3 milestones (done /
 * in_progress / pending), 2 findings (insight + high-sev warning), 1
 * blocking unresolved decision. Mirrors what a mid-flight overnight run
 * looks like so dashboard + brief output stay believable.
 *
 * Uses better-sqlite3 directly + schema.sql rather than server/db/client.js
 * — the client caches a singleton that would leak across fixture calls.
 */

import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'server', 'db', 'schema.sql');

const id = (prefix) => `${prefix}-${Math.random().toString(16).slice(2, 10)}`;

export async function populateFixtureDb({ dir }) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'goalnight.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  const now = Date.now();
  const sessionId = id('sess');
  db.prepare(`
    INSERT INTO sessions
      (id, thread_id, objective, hours, target_quota_pct, token_budget,
       tokens_used, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, 'codex-thread-fixture-001', 'implement user profile feature',
    8, 0.8, 240000, 45000, 'active', now - 90*60*1000, now);

  const milestoneIds = [id('ms-done'), id('ms-prog'), id('ms-pend')];
  const insertMs = db.prepare(`
    INSERT INTO milestones (id, session_id, title, estimated_tokens, ordinal,
      state, started_at, completed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMs.run(milestoneIds[0], sessionId, 'sketch user profile schema', 80000, 1, 'done',        now - 80*60*1000, now - 60*60*1000, now - 90*60*1000);
  insertMs.run(milestoneIds[1], sessionId, 'wire profile API endpoints', 80000, 2, 'in_progress', now - 55*60*1000, null,             now - 90*60*1000);
  insertMs.run(milestoneIds[2], sessionId, 'add profile settings UI',    80000, 3, 'pending',     null,             null,             now - 90*60*1000);

  const findingIds = [id('find-i'), id('find-w')];
  const insertFinding = db.prepare(`
    INSERT INTO findings (id, session_id, type, severity, content, context_files, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertFinding.run(findingIds[0], sessionId, 'insight', 'low',
    'found existing user model in /lib/user.js — can extend instead of duplicate',
    JSON.stringify(['lib/user.js']), now - 50*60*1000);
  insertFinding.run(findingIds[1], sessionId, 'warning', 'high',
    'migration will lock the users table for ~3s on prod',
    JSON.stringify(['db/migrations/0042_user_profile.sql']), now - 20*60*1000);

  const decisionIds = [id('dec-block')];
  db.prepare(`
    INSERT INTO decisions
      (id, session_id, question, options, recommendation, reasoning,
       blocking, resolved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(decisionIds[0], sessionId,
    'Use Postgres or stay on SQLite for this feature?',
    JSON.stringify(['Postgres', 'SQLite']), 'Postgres',
    'production already uses it; avoids dual-store ops',
    1, 0, now - 10*60*1000);

  db.close();
  return { dataDir: dir, session_id: sessionId, milestone_ids: milestoneIds, finding_ids: findingIds, decision_ids: decisionIds };
}

export function cleanupFixtureDir(dir) {
  if (dir && existsSync(dir) && dir.startsWith('/tmp/')) {
    rmSync(dir, { recursive: true, force: true });
  }
}
