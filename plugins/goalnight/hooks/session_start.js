#!/usr/bin/env node
/**
 * SessionStart hook — fires when a codex session begins (start / resume / clear).
 *
 * v0.1 behavior:
 *   - If an active or paused goalnight session exists, emit a one-line hint
 *     via stdout so codex injects it into model context.
 *   - Otherwise, no-op silently.
 *
 * Hooks must never block codex. Any error → exit 0 with stderr log.
 */

import { getDb } from '../server/db/client.js';

async function main() {
  // Drain stdin (codex sends a JSON payload we don't strictly need in v0.1).
  let _payload = '';
  for await (const chunk of process.stdin) _payload += chunk;

  try {
    const db = getDb();
    const session = db
      .prepare(
        `SELECT id, objective, state, tokens_used, token_budget
         FROM sessions
         WHERE state IN ('active', 'paused', 'usage_limited', 'blocked')
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get();

    if (!session) process.exit(0);

    const tokens = session.token_budget
      ? `${session.tokens_used}/${session.token_budget}`
      : `${session.tokens_used}`;
    // Codex injects stdout lines into model context.
    console.log(
      `[goalnight] Restoring active session "${session.objective}" (${session.state}, ${tokens} tokens). Call gn_status to re-ground before continuing.`
    );
  } catch (err) {
    process.stderr.write(`[goalnight] session_start error: ${err.message}\n`);
  }

  process.exit(0);
}

main();
