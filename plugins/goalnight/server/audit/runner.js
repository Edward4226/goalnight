/**
 * Audit gate — verifies that milestones marked `done` actually look done from
 * the outside (file exists / test passes / commit landed / PR merged), before
 * the morning brief is rendered.
 *
 * Security model: the verify command is supplied by the model at plan_night
 * time and locked in for the night. We do NOT exec arbitrary shells:
 *   - Whitelist of leading binaries: gh / git / test / npm
 *   - Shell metacharacters rejected: | & ; > < $ ` ( ) and newlines
 *   - Parsed into argv with a tiny lexer, exec'd via execFile (no shell)
 *   - Hard 10s timeout per command
 *
 * Tri-state result per milestone:
 *   verified   → exit 0
 *   failed     → exit non-zero
 *   unknown    → timeout or spawn error (env issue, dep missing, network down)
 *
 * `failed` is the only state that should worry the user; `unknown` is rendered
 * neutrally so we don't cry wolf when their laptop's network blinked.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb, now } from '../db/client.js';

const execFileP = promisify(execFile);

const TIMEOUT_MS = 10_000;
const OUTPUT_MAX_CHARS = 2048;       // truncate captured output before storing
const VERIFY_MAX_CHARS = 500;         // command-string sanity cap
const ALLOWED_PREFIXES = ['gh ', 'git ', 'test ', 'npm '];
const FORBIDDEN_CHARS_RE = /[|&;<>$`()\n\r]/;

/**
 * Validate a verify command without executing it. Throws on rejection.
 * Pure / sync — safe to call from plan_night for fail-fast UX.
 */
export function validateVerifyCommand(cmd) {
  if (typeof cmd !== 'string') throw new Error('must be a string');
  const trimmed = cmd.trim();
  if (!trimmed) throw new Error('must be non-empty');
  if (trimmed.length > VERIFY_MAX_CHARS) {
    throw new Error(`exceeds ${VERIFY_MAX_CHARS} chars`);
  }
  if (FORBIDDEN_CHARS_RE.test(trimmed)) {
    throw new Error('contains forbidden shell metacharacter (one of | & ; < > $ ` ( ) newline)');
  }
  if (!ALLOWED_PREFIXES.some(p => trimmed.startsWith(p))) {
    throw new Error(`must start with one of: ${ALLOWED_PREFIXES.map(s => s.trim()).join(', ')}`);
  }
  // Argv parsing must succeed — catches dangling quotes.
  parseArgv(trimmed);
}

/**
 * Tiny shell-ish lexer: splits on unquoted whitespace, treats "..." and '...'
 * as single tokens with no escape processing inside. Sufficient for the
 * commands we actually whitelist; throws on unclosed quote.
 */
export function parseArgv(s) {
  const argv = [];
  let cur = '';
  let quote = null;
  for (const c of s) {
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { argv.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} quote`);
  if (cur) argv.push(cur);
  return argv;
}

/**
 * Run a single verify command. Pure (besides spawning a subprocess) — does
 * not touch the DB. Returns { status, output, exitCode? }.
 */
export async function runVerify(cmd, { cwd = process.cwd(), timeoutMs = TIMEOUT_MS } = {}) {
  validateVerifyCommand(cmd); // belt-and-suspenders — runtime guard, not just plan-time
  const [bin, ...args] = parseArgv(cmd.trim());
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: OUTPUT_MAX_CHARS * 4,
      env: process.env,
    });
    return { status: 'verified', output: truncate(stdout + stderr), exitCode: 0 };
  } catch (err) {
    // execFile rejects on timeout, spawn error, or non-zero exit.
    // We distinguish them by err.code / err.killed.
    if (err.killed || err.signal === 'SIGTERM') {
      return { status: 'unknown', output: `timeout after ${timeoutMs}ms`, exitCode: null };
    }
    if (err.code === 'ENOENT') {
      return { status: 'unknown', output: `binary not found: ${bin}`, exitCode: null };
    }
    if (typeof err.code === 'number') {
      const captured = (err.stdout || '') + (err.stderr || '');
      return { status: 'failed', output: truncate(captured || err.message), exitCode: err.code };
    }
    return { status: 'unknown', output: truncate(err.message), exitCode: null };
  }
}

function truncate(s) {
  if (typeof s !== 'string') s = String(s ?? '');
  if (s.length <= OUTPUT_MAX_CHARS) return s;
  return s.slice(0, OUTPUT_MAX_CHARS) + `\n…[truncated ${s.length - OUTPUT_MAX_CHARS} chars]`;
}

/**
 * Audit all done milestones for a session.
 *
 * For each milestone whose state == 'done' AND has a verification_command,
 * runs the command and writes status/output/timestamp back to the row.
 * Milestones without a verify cmd are left at 'skipped'.
 *
 * Returns:
 *   {
 *     audited: <count of milestones with a verify cmd that ran>,
 *     failures: [{ ordinal, title, command, output }],   // status === 'failed'
 *     unknowns: [{ ordinal, title, command, output }],   // status === 'unknown'
 *   }
 *
 * Failures are what the morning brief surfaces at the top. Unknowns are
 * rendered separately in a muted block — "couldn't verify" ≠ "verification
 * failed".
 */
export async function auditMilestones(sessionId, opts = {}) {
  const db = getDb();
  const doneWithVerify = db
    .prepare(
      `SELECT id, ordinal, title, verification_command
       FROM milestones
       WHERE session_id = ?
         AND state = 'done'
         AND verification_command IS NOT NULL
         AND verification_command != ''
       ORDER BY ordinal`
    )
    .all(sessionId);

  const update = db.prepare(
    `UPDATE milestones
       SET verification_status = ?,
           verification_output = ?,
           verified_at         = ?
     WHERE id = ?`
  );

  const failures = [];
  const unknowns = [];

  for (const m of doneWithVerify) {
    const result = await runVerify(m.verification_command, opts);
    update.run(result.status, result.output, now(), m.id);
    if (result.status === 'failed') {
      failures.push({
        ordinal: m.ordinal,
        title: m.title,
        command: m.verification_command,
        output: result.output,
      });
    } else if (result.status === 'unknown') {
      unknowns.push({
        ordinal: m.ordinal,
        title: m.title,
        command: m.verification_command,
        output: result.output,
      });
    }
  }

  return { audited: doneWithVerify.length, failures, unknowns };
}
