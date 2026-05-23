/**
 * Builds the context-recap string injected into a resumed codex session.
 *
 * Audience: the model, not the human. The recap exists so a resumed turn
 * doesn't restart work, re-discover findings, or re-ask decisions the
 * previous turn already endorsed on the (sleeping) user's behalf.
 *
 * Pure function — no I/O, no globals. Caller drains the DB and pipes the
 * returned string to stdout (where codex picks it up as opening context).
 */

const RULE = '────────────────────────────────────────────';
const MAX_FINDINGS = 5; // most-recent N; older ones live in the morning brief
const SOFT_CHAR_BUDGET = 3000; // documented in DoD; we don't hard-truncate

export function buildRecap({ db, session }) {
  if (!db || !session) return '';

  // Completed sessions don't need a recap — they need a "stop overnight work"
  // signal. The watcher shouldn't be firing resume on these, but if codex
  // sends a resume trigger anyway (manual user invocation, etc.) we want the
  // model to know not to keep grinding.
  if (session.state === 'complete') {
    return [
      '🌙 goalnight — session already complete',
      RULE,
      `The overnight session "${sanitize(session.objective)}" is marked complete.`,
      'No further automated work is needed. If the user is asking you',
      'something new, treat this as a fresh task.',
      RULE,
      '',
    ].join('\n');
  }

  const milestones = db
    .prepare(
      `SELECT title, state, ordinal
       FROM milestones
       WHERE session_id = ?
       ORDER BY ordinal`
    )
    .all(session.id);

  const done = milestones.filter(m => m.state === 'done');
  const current = milestones.filter(m => m.state === 'in_progress');
  const pending = milestones.filter(m => m.state === 'pending');

  // Decisions: ALL unresolved (sorted: blocking first, then oldest first so
  // the model walks the chain in the order it logged them). These are the
  // implicit-endorsement set the model must NOT re-ask.
  const decisions = db
    .prepare(
      `SELECT question, recommendation, reasoning, blocking
       FROM decisions
       WHERE session_id = ? AND resolved = 0
       ORDER BY blocking DESC, created_at ASC`
    )
    .all(session.id);

  // Findings: most recent N (severity is informational here — recency matters
  // more for "did I already look at this"). Older findings are still in the
  // morning brief, just not in the recap.
  const findingsAll = db
    .prepare(
      `SELECT type, severity, content, created_at
       FROM findings
       WHERE session_id = ?
       ORDER BY created_at DESC`
    )
    .all(session.id);
  const findings = findingsAll.slice(0, MAX_FINDINGS);
  const truncatedFindings = Math.max(0, findingsAll.length - findings.length);

  const elapsed = formatElapsed(Date.now() - session.created_at);
  const tokenLine = formatTokenLine(session.tokens_used, session.token_budget);

  const out = [];
  out.push('🌙 goalnight — context recap (resuming session)');
  out.push(RULE);
  out.push(
    "You're picking up an in-flight overnight goal. The previous quota"
  );
  out.push(
    'period (or periods) made the progress below. Continue from there;'
  );
  out.push(
    "don't restart the work and don't re-ask the user about decisions"
  );
  out.push("they've already implicitly endorsed.");
  out.push('');

  if (session.objective) {
    out.push(`GOAL: ${sanitize(session.objective)}`);
  }
  if (tokenLine) out.push(tokenLine);
  out.push(`ELAPSED: ${elapsed}`);
  out.push('');

  if (done.length > 0) {
    out.push(`MILESTONES DONE (${done.length}):`);
    for (const m of done) out.push(`  ✅ ${sanitize(m.title)}`);
    out.push('');
  }

  // If the run is genuinely mid-flight but nothing is in_progress (e.g. quota
  // ran out right after a milestone closed) we synthesize the next pending
  // milestone as CURRENT so the model has somewhere to pick up. We then drop
  // that one from the PENDING list so we don't double-list it.
  let synthesizedFromPending = false;
  if (current.length > 0) {
    out.push('CURRENT MILESTONE:');
    for (const m of current) out.push(`  ⏳ ${sanitize(m.title)}`);
    out.push('');
  } else if (pending.length > 0 && done.length > 0) {
    out.push('CURRENT MILESTONE:');
    out.push(`  ⏳ (none in_progress — pick up next pending: ${sanitize(pending[0].title)})`);
    out.push('');
    synthesizedFromPending = true;
  }

  if (pending.length > 0) {
    const remaining = synthesizedFromPending ? pending.slice(1) : pending;
    if (remaining.length > 0) {
      out.push(`MILESTONES PENDING (${remaining.length}):`);
      for (const m of remaining) out.push(`  • ${sanitize(m.title)}`);
      out.push('');
    }
  }

  if (decisions.length > 0) {
    out.push(
      `DECISIONS ALREADY LOGGED — the user will review these in the brief.`
    );
    out.push(`Do NOT re-ask; proceed with the recommendation. (${decisions.length})`);
    for (const d of decisions) {
      out.push(`  ▸ Q: ${sanitize(d.question)}${d.blocking ? '  [blocking]' : ''}`);
      if (d.recommendation) {
        out.push(`    A (your recommendation): ${sanitize(d.recommendation)}`);
      }
      if (d.reasoning) {
        out.push(`    Why: ${sanitize(d.reasoning)}`);
      }
    }
    out.push('');
  }

  if (findings.length > 0) {
    out.push(`FINDINGS ALREADY LOGGED — don't re-discover. (${findings.length}${truncatedFindings > 0 ? ` of ${findingsAll.length}` : ''})`);
    for (const f of findings) {
      const sev = f.severity && f.severity !== 'low' ? `/${f.severity}` : '';
      out.push(`  • [${f.type}${sev}] ${sanitize(f.content)}`);
    }
    if (truncatedFindings > 0) {
      out.push(`  (... and ${truncatedFindings} more in morning brief)`);
    }
    out.push('');
  }

  // Trust mode / guards section: placeholder anchor for Feature C/F. When
  // those land, push them here with the same "ACTIVE GUARDS:" heading.

  out.push(RULE);
  out.push(
    'This is a CONTEXT preservation message, not a fresh task. Pick up'
  );
  out.push(
    'from the in-progress milestone above; do not restart and do not'
  );
  out.push(
    're-explore code you already understood. If the user wakes up before'
  );
  out.push(
    'you finish, the morning brief will show them what shipped and what'
  );
  out.push('is still pending.');
  out.push('');

  return out.join('\n');
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0h 0m';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function formatTokenLine(used, budget) {
  const u = Number.isFinite(used) ? used : 0;
  if (budget && Number.isFinite(budget) && budget > 0) {
    const pct = Math.round((u / budget) * 100);
    return `TOKENS USED: ${u} / ${budget}  (${pct}%)`;
  }
  if (u > 0) return `TOKENS USED: ${u}`;
  return '';
}

function sanitize(s) {
  if (s == null) return '';
  // Strip control chars except newline/tab; collapse newlines so a logged
  // multi-line finding doesn't break our line-oriented layout.
  return String(s)
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/`/g, "'") // backticks would risk codex injection ambiguity
    .trim();
}

export const __test__ = { formatElapsed, formatTokenLine, sanitize, SOFT_CHAR_BUDGET, MAX_FINDINGS };
