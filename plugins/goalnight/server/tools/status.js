/**
 * gn_status — fetch current goalnight session status.
 *
 * Returns a snapshot the model (and dashboard SSE) can use to reason about
 * progress. Crucially: this status lives in OUR SQLite, immune to codex
 * context compaction. Re-reading it after a long gap restores grounding.
 */

import { getDb } from '../db/client.js';

export const statusSchema = {
  description: `Read the current goalnight session status.

Call this when:
  - You need to re-orient after a long gap or context compaction
  - The user asks 'where are we?'
  - You're deciding whether to wrap up vs continue

Status is read from goalnight's own SQLite — it survives codex context
compaction. Trust it over your internal memory of progress.`,
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Specific session ID. Omit to get the most recent session.',
      },
    },
  },
};

export async function status(args) {
  const db = getDb();
  const session = args.session_id
    ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(args.session_id)
    : db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1').get();

  if (!session) {
    return {
      state: 'none',
      message: 'No goalnight session found. Call gn_plan_night to start one.',
    };
  }

  const milestones = db
    .prepare(
      'SELECT id, title, ordinal, state, started_at, completed_at FROM milestones WHERE session_id = ? ORDER BY ordinal'
    )
    .all(session.id);

  const pendingDecisions = db
    .prepare('SELECT COUNT(*) as c FROM decisions WHERE session_id = ? AND resolved = 0')
    .get(session.id).c;

  const findingsCount = db
    .prepare('SELECT COUNT(*) as c FROM findings WHERE session_id = ?')
    .get(session.id).c;

  const elapsedSec = Math.round((Date.now() - session.created_at) / 1000);
  const burnRate = elapsedSec > 0
    ? Math.round((session.tokens_used / elapsedSec) * 60)
    : 0;

  return {
    session_id: session.id,
    state: session.state,
    objective: session.objective,
    tokens_used: session.tokens_used,
    token_budget: session.token_budget,
    elapsed_seconds: elapsedSec,
    burn_rate_tokens_per_min: burnRate,
    milestones,
    pending_decisions_count: pendingDecisions,
    findings_count: findingsCount,
    next_quota_reset_at: session.next_quota_reset_at,
  };
}
