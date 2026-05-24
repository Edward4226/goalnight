#!/usr/bin/env node
/**
 * Stop hook — fires at end of each conversation turn.
 *
 * v0.1.2 behavior:
 *   - Read codex's hook payload (best-effort: codex 0.130.0 documents some
 *     payload fields but the exact key for the goal-state isn't confirmed;
 *     we try several candidates and fall back gracefully).
 *   - Determine the new state BEFORE inserting turn_log so before/after
 *     reflect the actual transition (Task #14 fix — earlier the row always
 *     wrote `after = before` and a later UPDATE silently changed it for
 *     the NEXT turn only).
 *   - Fire a notification if the state transitioned to usage_limited /
 *     blocked / complete.
 *   - Update sessions.state + updated_at.
 *
 * Hooks must never block codex. Any error → exit 0 with stderr log.
 */

import { getDb } from '../server/db/client.js';
import { notify } from '../server/notifications/index.js';

/**
 * Best-effort extraction of the new goal state from codex's hook payload.
 * Field name is unconfirmed in codex 0.130.0 (Task #12). Try candidates in
 * priority order: most-likely first. Returns null if none match.
 *
 * Exported for unit testing — the hook script itself runs main() only when
 * invoked directly (via the import.meta.url guard at the bottom).
 */
export function extractNewState(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.goal_state,
    payload.goalState,
    payload.session_state,
    payload.sessionState,
    payload.thread_state,
    payload.threadState,
    payload.state,
    // codex's ThreadStatus may live nested under a parent key
    payload.thread?.status,
    payload.session?.state,
    payload.goal?.state,
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    /* ignore — codex may send non-JSON or empty stdin in some cases */
  }

  try {
    const db = getDb();
    const session = db
      .prepare(
        `SELECT id, state, tokens_used
         FROM sessions
         WHERE state IN ('active', 'paused', 'usage_limited', 'blocked')
         ORDER BY updated_at DESC, rowid DESC LIMIT 1`
      )
      .get();
    if (!session) process.exit(0);

    const ts = Date.now();
    const toolsCalled = payload?.tools_called ?? payload?.tool_calls ?? [];

    // Detect transition FIRST so turn_log captures the real before/after pair.
    const candidate = extractNewState(payload);
    const newState = (candidate && candidate !== session.state) ? candidate : session.state;
    const transitioned = newState !== session.state;

    db.prepare(
      `INSERT INTO turn_log
         (session_id, turn_number, tokens_delta, tools_called,
          goal_state_before, goal_state_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      payload?.turn_number ?? null,
      payload?.token_usage?.delta ?? 0,
      JSON.stringify(toolsCalled),
      session.state,  // before
      newState,       // after — now reflects the transition in the same row
      ts
    );

    if (transitioned) {
      if (newState === 'usage_limited') {
        notify({
          type: 'usage-limited',
          title: 'Quota hit — auto-resume armed',
          body: 'goalnight will resume when quota refreshes',
        });
      } else if (newState === 'blocked') {
        notify({
          type: 'blocked',
          title: 'Goal blocked',
          body: 'Needs your attention',
          sound: true,
        });
      } else if (newState === 'complete') {
        notify({
          type: 'complete',
          title: 'Goal complete',
          body: 'Run `gn brief` to see the summary',
          sound: true,
        });
      }
      db.prepare(`UPDATE sessions SET state = ? WHERE id = ?`).run(newState, session.id);
    }

    db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(ts, session.id);
  } catch (err) {
    process.stderr.write(`[goalnight] stop error: ${err.message}\n`);
  }

  process.exit(0);
}

// Only run main() when invoked directly as a hook script — not on import
// from tests. import.meta.url is a `file://...` URL; process.argv[1] is the
// absolute filesystem path of the entry script.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
