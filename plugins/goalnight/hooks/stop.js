#!/usr/bin/env node
/**
 * Stop hook — fires at end of each conversation turn.
 *
 * v0.1 behavior:
 *   - Append a turn_log row capturing the turn's tool calls + token delta.
 *   - Update session updated_at timestamp.
 *   - State transition detection (active → usage_limited / blocked) is best-effort;
 *     full detection lands in v0.1 final via state_parser.js reading codex's state DB.
 */

import { getDb } from '../server/db/client.js';
import { notify } from '../server/notifications/index.js';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  try {
    const db = getDb();
    const session = db
      .prepare(
        `SELECT id, state, tokens_used
         FROM sessions
         WHERE state IN ('active', 'paused', 'usage_limited', 'blocked')
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get();
    if (!session) process.exit(0);

    const ts = Date.now();
    const toolsCalled = payload?.tools_called ?? payload?.tool_calls ?? [];

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
      session.state,
      session.state, // v0.1 doesn't detect transitions yet
      ts
    );

    const newState = payload?.goal_state ?? session.state;
    if (newState !== session.state) {
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

main();
