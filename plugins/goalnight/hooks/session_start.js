#!/usr/bin/env node
/**
 * SessionStart hook — fires when a codex session begins (start / resume / clear).
 *
 * v0.1.x behavior (Feature I, context preservation):
 *   - On `resume`, if an in-flight goalnight session exists, write a
 *     structured recap to stdout. Codex injects stdout from SessionStart
 *     hooks into the next model turn, so this becomes the resumed thread's
 *     opening context. Without it, the model is operationally amnesiac
 *     across cross-quota auto-resume.
 *   - On `startup` / `clear` / unknown triggers, silently no-op. A fresh
 *     session has nothing to recap, and clearing the thread is the user
 *     explicitly asking for amnesia.
 *
 * Hooks must never block codex. Any error → exit 0 with stderr log.
 *
 * NOTE: the codex hook payload's "this is a resume" signal field is not yet
 * pinned down across versions; we check both `trigger` and `hook_event_name`.
 * If neither matches and the payload is empty (e.g. dev invocation with no
 * stdin), we conservatively do nothing.
 */

import { getDb } from '../server/db/client.js';
import { buildRecap } from '../server/recap/builder.js';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    // Malformed payload — treat as unknown trigger.
  }

  const trigger = String(
    payload?.trigger || payload?.hook_event_name || ''
  ).toLowerCase();

  if (trigger !== 'resume') {
    process.exit(0);
  }

  try {
    const db = getDb();
    const session = db
      .prepare(
        `SELECT *
         FROM sessions
         WHERE state IN ('active', 'paused', 'usage_limited', 'blocked')
         ORDER BY updated_at DESC, rowid DESC
         LIMIT 1`
      )
      .get();

    if (!session) {
      // Resume fired but no in-flight goalnight session — nothing to inject.
      process.exit(0);
    }

    const recap = buildRecap({ db, session });
    if (recap) process.stdout.write(recap);
  } catch (err) {
    process.stderr.write(`[goalnight] session_start error: ${err.message}\n`);
  }

  process.exit(0);
}

main();
