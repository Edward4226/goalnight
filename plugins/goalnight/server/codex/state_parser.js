/**
 * Codex state parser.
 *
 * Reads codex-owned state to answer two questions:
 *   1. Given a thread_id, what is its goal state, token usage, and next
 *      quota reset time?
 *   2. Which codex thread is currently the most relevant (active or waiting
 *      on quota) for goalnight to act on?
 *
 * Data sources (all read-only, never written to):
 *   - ~/.codex/goals_<N>.sqlite      table: thread_goals
 *   - ~/.codex/state_<N>.sqlite      table: threads (joins rollout_path)
 *   - ~/.codex/sessions/.../*.jsonl  rollout stream (resets_at lives here)
 *
 * Schema versions can bump (state_5 → state_6) — we glob for the highest
 * version number and degrade to nulls if anything is missing or unparseable,
 * never crash the watcher daemon.
 */

import Database from 'better-sqlite3';
import {
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEX_DIR = join(homedir(), '.codex');

// How many bytes from the end of a rollout JSONL to scan for the most recent
// token_count event. 256KB covers many turns; bump if real sessions are denser.
const ROLLOUT_TAIL_BYTES = 256 * 1024;

// Cached opened DB handles. The watcher reads frequently — keep handles warm.
let _goalsDb = null;
let _stateDb = null;

function findLatestVersionedFile(prefix, suffix) {
  if (!existsSync(CODEX_DIR)) return null;
  const re = new RegExp(`^${prefix}(\\d+)${suffix.replace('.', '\\.')}$`);
  let bestNum = -1;
  let bestPath = null;
  for (const name of readdirSync(CODEX_DIR)) {
    const m = name.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > bestNum) {
      bestNum = n;
      bestPath = join(CODEX_DIR, name);
    }
  }
  return bestPath;
}

function openReadOnly(path) {
  // fileMustExist=true so we fail fast if codex hasn't created it yet.
  return new Database(path, { readonly: true, fileMustExist: true });
}

function getGoalsDb() {
  if (_goalsDb) return _goalsDb;
  const path = findLatestVersionedFile('goals_', '.sqlite');
  if (!path) return null;
  try {
    _goalsDb = openReadOnly(path);
  } catch {
    return null;
  }
  return _goalsDb;
}

function getStateDb() {
  if (_stateDb) return _stateDb;
  const path = findLatestVersionedFile('state_', '.sqlite');
  if (!path) return null;
  try {
    _stateDb = openReadOnly(path);
  } catch {
    return null;
  }
  return _stateDb;
}

/**
 * Read last N bytes of a file, return them as a UTF-8 string with the
 * (likely partial) leading line trimmed off. Never throws — returns '' on
 * any IO error.
 */
function tailBytes(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const { size } = fstatSync(fd);
    const readLen = Math.min(maxBytes, size);
    const start = size - readLen;
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, start);
    let s = buf.toString('utf8');
    // If we didn't read from offset 0, the first line is probably partial.
    if (start > 0) {
      const nl = s.indexOf('\n');
      if (nl >= 0) s = s.slice(nl + 1);
    }
    return s;
  } catch {
    return '';
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Scan rollout JSONL tail for the latest `event_msg/token_count` event and
 * return rate_limits.primary.resets_at as unix ms, or null.
 *
 * The 5h quota lives in rate_limits.primary (window_minutes = 300).
 * The weekly quota is rate_limits.secondary — ignored here, v0.1 only acts
 * on the 5h period.
 */
function parseResetsAtFromRollout(rolloutPath) {
  if (!rolloutPath || !existsSync(rolloutPath)) return null;
  const tail = tailBytes(rolloutPath, ROLLOUT_TAIL_BYTES);
  if (!tail) return null;

  const lines = tail.split('\n');
  // Walk newest → oldest.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    // Cheap pre-filter to avoid parsing JSON for every line.
    if (line.indexOf('"resets_at"') < 0) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const primary = evt?.payload?.rate_limits?.primary;
    if (primary && typeof primary.resets_at === 'number') {
      return primary.resets_at * 1000; // seconds → ms
    }
  }
  return null;
}

/**
 * Read state for a specific thread_id.
 *
 * Returns null if the thread isn't tracked by /goal at all. Otherwise returns
 * a fully-populated object with best-effort fields (any of which may be null).
 */
export function readCodexThreadState(threadId) {
  if (!threadId) return null;

  const goals = getGoalsDb();
  const state = getStateDb();
  if (!goals) return null;

  let goalRow;
  try {
    goalRow = goals
      .prepare(
        `SELECT thread_id, goal_id, objective, status,
                token_budget, tokens_used, updated_at_ms
           FROM thread_goals
          WHERE thread_id = ?`,
      )
      .get(threadId);
  } catch {
    return null; // schema drift
  }
  if (!goalRow) return null;

  let threadRow = null;
  if (state) {
    try {
      threadRow = state
        .prepare(
          `SELECT id, rollout_path, updated_at_ms
             FROM threads
            WHERE id = ?`,
        )
        .get(threadId);
    } catch {
      threadRow = null;
    }
  }

  const resetsAt = threadRow
    ? parseResetsAtFromRollout(threadRow.rollout_path)
    : null;

  return {
    thread_id: goalRow.thread_id,
    goal_state: goalRow.status, // 'active'|'paused'|'usage_limited'|'blocked'|'budget_limited'|'complete'
    objective: goalRow.objective || null,
    tokens_used: goalRow.tokens_used ?? 0,
    token_budget: goalRow.token_budget ?? null,
    next_quota_reset_at: resetsAt,
    last_activity_at: threadRow?.updated_at_ms ?? goalRow.updated_at_ms ?? null,
  };
}

/**
 * Find the codex thread most relevant for the watcher to act on:
 * the most recently updated thread that has a goal row and isn't complete.
 *
 * Returns a thread_id string, or null if none qualify.
 */
export function findActiveCodexThread() {
  const goals = getGoalsDb();
  if (!goals) return null;

  let row;
  try {
    row = goals
      .prepare(
        `SELECT thread_id
           FROM thread_goals
          WHERE status IN ('active','usage_limited','paused','blocked','budget_limited')
          ORDER BY updated_at_ms DESC
          LIMIT 1`,
      )
      .get();
  } catch {
    return null;
  }
  return row?.thread_id ?? null;
}

/**
 * Close cached DB handles. Useful for tests; the daemon doesn't need to call
 * this — handles live for the process lifetime.
 */
export function closeCodexState() {
  try { _goalsDb?.close(); } catch { /* ignore */ }
  try { _stateDb?.close(); } catch { /* ignore */ }
  _goalsDb = null;
  _stateDb = null;
}
