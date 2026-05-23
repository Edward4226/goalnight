/**
 * goalnight auto-resume watcher.
 *
 * Polls every POLL_INTERVAL_MS for goalnight sessions that are waiting on a
 * Codex quota reset. When the reset moment arrives, kicks off
 * `codex exec resume <thread_id> "continue"` so the user wakes to progress
 * instead of a paused task.
 *
 * Designed for macOS launchd:
 *   - KeepAlive=true → if we crash, launchd restarts us
 *   - stdout/stderr → ~/.goalnight/watcher.log[.err]
 *
 * SAFETY DEFAULT: resume is dry-run (prints the command, does not spawn it).
 *   To actually trigger resume, set GOALNIGHT_WATCHER_RESUME=1 in the launchd
 *   plist EnvironmentVariables. v0.1 ships dry-run; flip the flag once the
 *   user has verified the dry-run command is what they want.
 */

import { spawn } from 'node:child_process';
import { getDb, now } from '../db/client.js';
import {
  readCodexThreadState,
  findActiveCodexThread,
} from '../codex/state_parser.js';

const POLL_INTERVAL_MS = Number(process.env.GOALNIGHT_WATCHER_POLL_MS) || 60_000;

// Don't fire resume more than once per cooldown — protects against a botched
// resume that fails to clear `usage_limited` from the codex side.
const RESUME_COOLDOWN_MS = 5 * 60 * 1000;

// In-process memory: thread_id → unix ms of last resume attempt.
const lastResumeAt = new Map();

function log(line) {
  // launchd captures stdout into the configured StandardOutPath, so a bare
  // console.log with a timestamp is enough — no logger dep needed.
  const ts = new Date().toISOString();
  console.log(`${ts} [goalnight-watcher] ${line}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Pick the goalnight session most worth checking on. Newest session in a
 * non-terminal state wins. Sessions without a thread_id (haven't been linked
 * to a codex thread yet) are skipped — we can't act on them.
 */
function pickActiveSession() {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, thread_id, objective, state, token_budget, tokens_used,
              next_quota_reset_at, updated_at
         FROM sessions
        WHERE state IN ('planned','active','usage_limited','blocked','paused')
          AND thread_id IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get();
}

/**
 * Mirror the latest codex-side facts back into our sessions row so the
 * dashboard and morning-brief see current numbers. Best-effort: skip silently
 * if there's nothing new to write.
 */
function syncSessionState(session, codexState) {
  const updates = {};
  if (codexState.goal_state && codexState.goal_state !== session.state) {
    updates.state = codexState.goal_state;
  }
  if (codexState.tokens_used != null && codexState.tokens_used !== session.tokens_used) {
    updates.tokens_used = codexState.tokens_used;
  }
  if (codexState.token_budget != null && codexState.token_budget !== session.token_budget) {
    updates.token_budget = codexState.token_budget;
  }
  if (
    codexState.next_quota_reset_at != null &&
    codexState.next_quota_reset_at !== session.next_quota_reset_at
  ) {
    updates.next_quota_reset_at = codexState.next_quota_reset_at;
  }
  if (Object.keys(updates).length === 0) return;

  updates.updated_at = now();
  const cols = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  getDb()
    .prepare(`UPDATE sessions SET ${cols} WHERE id = @id`)
    .run({ ...updates, id: session.id });
}

/**
 * Trigger a codex resume for the given thread. Returns true if the dry-run
 * cooldown allowed it (whether or not the spawn actually happened).
 *
 * Dry-run default: logs the command and exits. Set
 * GOALNIGHT_WATCHER_RESUME=1 to actually spawn.
 */
function triggerResume(threadId) {
  const last = lastResumeAt.get(threadId);
  if (last && now() - last < RESUME_COOLDOWN_MS) {
    log(`skip resume thread=${threadId} (cooldown, ${Math.round((RESUME_COOLDOWN_MS - (now() - last)) / 1000)}s left)`);
    return false;
  }
  lastResumeAt.set(threadId, now());

  const cmd = ['codex', 'exec', 'resume', threadId, 'continue'];
  log(`resume command: ${cmd.join(' ')}`);

  if (process.env.GOALNIGHT_WATCHER_RESUME !== '1') {
    log(`dry-run mode (set GOALNIGHT_WATCHER_RESUME=1 in plist to actually spawn)`);
    return true;
  }

  try {
    const child = spawn(cmd[0], cmd.slice(1), {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log(`spawned resume pid=${child.pid} thread=${threadId}`);
  } catch (err) {
    log(`resume spawn failed: ${err?.message || err}`);
  }
  return true;
}

/**
 * Placeholder hook for notification (Worker C owns server/notifications/*).
 * Logs the event so it's visible in watcher.log; Worker C will wire this to
 * macOS osascript / cross-platform notifier in their PR.
 */
function notifyResume(session) {
  log(`would-notify event=resume_triggered session=${session.id} objective="${(session.objective || '').slice(0, 80)}"`);
}

async function tick() {
  const session = pickActiveSession();
  if (!session) {
    log('tick session=none');
    return POLL_INTERVAL_MS;
  }

  let codexState = null;
  try {
    codexState = readCodexThreadState(session.thread_id);
  } catch (err) {
    log(`state_parser error: ${err?.message || err}`);
  }

  if (codexState) {
    try { syncSessionState(session, codexState); } catch (err) {
      log(`sync error: ${err?.message || err}`);
    }
  }

  // Decide what to do based on the freshest signal we have.
  // Prefer codex_state.goal_state if available; fall back to our session row.
  const effectiveState = codexState?.goal_state || session.state;
  const effectiveReset = codexState?.next_quota_reset_at ?? session.next_quota_reset_at;

  log(`tick session=${session.id} thread=${session.thread_id} state=${effectiveState} reset_at=${effectiveReset ?? 'null'}`);

  if (effectiveState === 'usage_limited' && effectiveReset) {
    const msUntil = effectiveReset - now();
    if (msUntil <= 0) {
      log(`quota reset has passed (${-Math.round(msUntil / 1000)}s ago) — triggering resume`);
      if (triggerResume(session.thread_id)) {
        notifyResume(session);
      }
      return POLL_INTERVAL_MS;
    }
    if (msUntil < POLL_INTERVAL_MS) {
      // Reset fires soon — sleep right up to it, then loop will catch it next tick.
      log(`quota reset in ${Math.round(msUntil / 1000)}s — short-sleeping`);
      return msUntil + 1000;
    }
    log(`quota reset in ${Math.round(msUntil / 1000)}s — normal poll`);
  }

  return POLL_INTERVAL_MS;
}

async function main() {
  log(`starting watcher (poll=${POLL_INTERVAL_MS}ms, dry_run=${process.env.GOALNIGHT_WATCHER_RESUME !== '1'})`);

  // Quick env probe so install issues surface in logs immediately.
  const activeCodexThread = findActiveCodexThread();
  log(`codex thread with active /goal: ${activeCodexThread ?? 'none'}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let nextSleepMs = POLL_INTERVAL_MS;
    try {
      nextSleepMs = await tick();
    } catch (err) {
      // Don't let an unexpected error kill the daemon — log and keep going.
      // launchd will only restart on actual process death.
      log(`tick error: ${err?.message || err}`);
    }
    await sleep(nextSleepMs);
  }
}

main().catch(err => {
  console.error(`[goalnight-watcher] fatal: ${err?.stack || err}`);
  process.exit(1);
});
