#!/usr/bin/env node
/**
 * PostToolUse hook — fires after each tool call.
 *
 * v0.1 behavior:
 *   - Parse codex's payload (tolerant to schema drift).
 *   - Extract token usage delta if present.
 *   - Accumulate into the active session's tokens_used.
 *   - No-op if no active session.
 *
 * Must be fast (timeout 3s) — do minimal work.
 */

import { getDb } from '../server/db/client.js';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    /* ignore parse error — payload may be empty for some events */
  }

  try {
    const db = getDb();
    const session = db
      .prepare(
        `SELECT id FROM sessions WHERE state = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1`
      )
      .get();
    if (!session) process.exit(0);

    // Tolerant extraction — codex hook payload schema may evolve.
    const tokenDelta =
      payload?.token_usage?.delta ??
      payload?.tokens_delta ??
      payload?.usage?.total_tokens_delta ??
      payload?.usage?.total_tokens ??
      0;

    if (tokenDelta > 0) {
      const ts = Date.now();
      db.prepare(
        `UPDATE sessions SET tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?`
      ).run(tokenDelta, ts, session.id);
    }
  } catch (err) {
    process.stderr.write(`[goalnight] post_tool_use error: ${err.message}\n`);
  }

  process.exit(0);
}

main();
