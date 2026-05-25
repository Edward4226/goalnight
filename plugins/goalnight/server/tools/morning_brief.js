/**
 * gn_morning_brief — generate the structured morning brief.
 *
 * Designed for low-judgement-load reading: a tired user must understand the
 * state in 5 seconds. Layout:
 *   1. One-liner summary
 *   2. ⚠️ Decisions waiting (the most important block — blocking + unflagged)
 *   3. 🤔 Decisions you might want to review (agent-flagged uncertain calls)
 *   4. ✅ Done milestones
 *   5. ⏳ Pending milestones
 *   6. 📝 Notable findings
 */

import { getDb } from '../db/client.js';
import { auditMilestones } from '../audit/runner.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', '..', 'templates', 'morning_brief.md');
const RECEIPT_RATES_PATH = join(__dirname, '..', 'dashboard', 'templates', 'receipt-rates.json');

// Codex's underlying quota refresh cycle. If this ever changes upstream,
// flip this constant — the receipt math is the only place it matters.
const QUOTA_WINDOW_SEC = 5 * 3600;

let _ratesCache = null;
function loadReceiptRates() {
  if (_ratesCache) return _ratesCache;
  try {
    _ratesCache = JSON.parse(readFileSync(RECEIPT_RATES_PATH, 'utf8'));
  } catch {
    // Fall back to a minimal embedded table so the receipt still renders if
    // the JSON ever goes missing. Same Pro rate as the file.
    _ratesCache = {
      default_plan: 'pro',
      plans: { pro: { name: 'Codex Pro', usd_per_million_tokens: 150 } },
    };
  }
  return _ratesCache;
}

export const morningBriefSchema = {
  description: `Generate the morning brief — the structured summary the user reads when they wake up.

Call this when:
  - The user runs 'gn brief' or asks 'what happened overnight?'
  - The goal naturally completes
  - You're about to hand control back to the user after a long run`,
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Specific session. Omit for the most recent.',
      },
    },
  },
};

export async function morningBrief(args) {
  const db = getDb();
  const session = args.session_id
    ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(args.session_id)
    : db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT 1').get();

  if (!session) throw new Error('No goalnight session found.');

  // Run the audit gate BEFORE we read milestones for rendering, so verification
  // status reflects reality at brief-time. Failures here trump everything else
  // in the layout — surfacing them at the top is the entire point.
  let audit = { audited: 0, failures: [], unknowns: [] };
  try {
    audit = await auditMilestones(session.id);
  } catch (err) {
    // Audit must never block the brief. If something exploded (e.g. DB shape
    // off after a partial migration), log and continue with empty results.
    console.error('[goalnight] audit gate failed:', err.message);
  }

  const milestones = db
    .prepare('SELECT title, state FROM milestones WHERE session_id = ? ORDER BY ordinal')
    .all(session.id);
  const milestonesDone = milestones.filter(m => m.state === 'done');
  const milestonesPending = milestones.filter(m => m.state !== 'done');

  // Old DBs (pre-v0.1.1) may lack the `uncertain` column. Detect once per call.
  const hasUncertainCol = db
    .prepare("SELECT 1 FROM pragma_table_info('decisions') WHERE name = 'uncertain'")
    .get();

  const decisions = hasUncertainCol
    ? db.prepare(
        `SELECT question, recommendation, reasoning, blocking
         FROM decisions
         WHERE session_id = ? AND resolved = 0 AND uncertain = 0
         ORDER BY blocking DESC, created_at`
      ).all(session.id)
    : db.prepare(
        `SELECT question, recommendation, reasoning, blocking
         FROM decisions
         WHERE session_id = ? AND resolved = 0
         ORDER BY blocking DESC, created_at`
      ).all(session.id);

  const uncertainDecisions = hasUncertainCol
    ? db.prepare(
        `SELECT question, recommendation, reasoning, created_at
         FROM decisions
         WHERE session_id = ? AND uncertain = 1 AND resolved = 0
         ORDER BY created_at DESC`
      ).all(session.id)
    : [];

  const findings = db
    .prepare(
      `SELECT type, severity, content
       FROM findings
       WHERE session_id = ?
       ORDER BY
         CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         created_at DESC
       LIMIT 10`
    )
    .all(session.id);

  const endedAt = session.completed_at ?? Date.now();
  const durationSec = Math.round((endedAt - session.created_at) / 1000);
  const hours = Math.floor(durationSec / 3600);
  const mins = Math.floor((durationSec % 3600) / 60);
  const durationHuman = `${hours}h ${mins}m`;

  const summary = buildOneLiner(
    session, milestones, milestonesDone, decisions, uncertainDecisions, audit.failures,
  );

  const allDecisions = db
    .prepare('SELECT blocking FROM decisions WHERE session_id = ?')
    .all(session.id);
  const allFindings = db
    .prepare('SELECT type FROM findings WHERE session_id = ?')
    .all(session.id);

  const receiptData = buildReceiptData({
    session,
    durationSec,
    durationHuman,
    milestonesDone,
    milestones,
    allDecisions,
    allFindings,
  });

  const data = {
    summary_one_liner: summary,
    status: session.state,
    objective: session.objective,
    duration_human: durationHuman,
    tokens_used: session.tokens_used,
    token_budget: session.token_budget,
    milestones_done: milestonesDone,
    milestones_pending: milestonesPending,
    decisions_awaiting: decisions,
    uncertain_decisions: uncertainDecisions,
    findings_highlights: findings,
    receipt_data: receiptData,
    verification_failures: audit.failures,
    verification_unknowns: audit.unknowns,
    verification_audited: audit.audited,
  };

  let markdown;
  try {
    const tpl = readFileSync(TEMPLATE_PATH, 'utf8');
    markdown = renderTemplate(tpl, data);
  } catch {
    markdown = buildFallbackBrief(data);
  }

  return { ...data, markdown };
}

function buildOneLiner(session, milestones, done, decisions, uncertainDecisions = [], failures = []) {
  const total = milestones.length;
  const doneCount = done.length;
  const decisionCount = decisions.length;
  const uncertainCount = uncertainDecisions.length;
  const failureCount = failures.length;
  // Verification failures lead — "5 of 5 done" means nothing if 2 don't verify.
  const failureNote = failureCount > 0
    ? ` ⚠️ ${failureCount} claimed-done milestone${failureCount > 1 ? 's' : ''} failed verification.`
    : '';
  const decisionNote = decisionCount > 0 ? ` ${decisionCount} decision${decisionCount > 1 ? 's' : ''} need you.` : '';
  const uncertainNote = uncertainCount > 0 ? ` ${uncertainCount} to double-check.` : '';
  const tail = `${failureNote}${decisionNote}${uncertainNote}`;

  switch (session.state) {
    case 'complete':
      return doneCount === total
        ? `Done. All ${total} milestones complete.${tail}`
        : `Marked complete. ${doneCount} of ${total} milestones done.${tail}`;
    case 'usage_limited':
      return `Paused on quota. ${doneCount} of ${total} done. Auto-resume armed.${tail}`;
    case 'blocked':
      return `Blocked. ${doneCount} of ${total} done. Needs your call.${tail}`;
    case 'paused':
      return `Paused. ${doneCount} of ${total} done.${tail}`;
    default:
      return `Still running. ${doneCount} of ${total} done.${tail}`;
  }
}

function renderTemplate(tpl, data) {
  // Minimal mustache-ish: {{ key }} and {{#list}}...{{/list}} blocks.
  // Full template engine not in v0.1 scope — fallback handles 99% of the layout.
  let out = tpl;
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => formatScalar(data[k]));
  return out;
}

function formatScalar(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.length.toString();
  return String(v);
}

function buildReceiptData({ session, durationSec, durationHuman, milestonesDone, milestones, allDecisions, allFindings }) {
  const db = getDb();

  // quota_windows_relit: count of state transitions from usage_limited → active
  // (the moment goalnight successfully relit the run after a quota hit).
  // If turn_log lacks those rows yet, fall back to 0 — never invent reclaim.
  let quotaWindowsRelit = 0;
  try {
    quotaWindowsRelit = db
      .prepare(
        `SELECT COUNT(*) AS c FROM turn_log
         WHERE session_id = ?
           AND goal_state_before = 'usage_limited'
           AND goal_state_after  = 'active'`
      )
      .get(session.id).c;
  } catch {
    quotaWindowsRelit = 0;
  }

  // Burn rate: same shape as gn_status — tokens per minute, rounded.
  const burnRateTokensPerMin = durationSec > 0
    ? Math.round((session.tokens_used / durationSec) * 60)
    : 0;

  // tokens_reclaimed = tokens that *would* have been wasted during quota
  // refresh windows that goalnight bridged through. Capped at elapsed time
  // so we never claim more reclaim than the session actually ran.
  let tokensReclaimed = 0;
  if (quotaWindowsRelit > 0) {
    const timeInRelitWindowsSec = quotaWindowsRelit * QUOTA_WINDOW_SEC;
    const capped = Math.min(timeInRelitWindowsSec, durationSec);
    tokensReclaimed = Math.round((capped / 60) * burnRateTokensPerMin);
  }

  const rates = loadReceiptRates();
  const planKey = process.env.GOALNIGHT_PLAN || rates.default_plan;
  const planEntry = rates.plans[planKey] || rates.plans[rates.default_plan];
  const usdPerMtok = planEntry?.usd_per_million_tokens ?? 0;

  const headlineTokens = tokensReclaimed > 0 ? tokensReclaimed : (session.tokens_used || 0);
  const costEstimateUsd = +((headlineTokens / 1_000_000) * usdPerMtok).toFixed(2);

  // Decision/finding line composition.
  const decisionsTotal = allDecisions.length;
  const blockingCount = allDecisions.filter(d => d.blocking === 1).length;
  const findingsTotal = allFindings.length;
  const bugFixedCount = allFindings.filter(f => f.type === 'bug').length;

  return {
    session_id: session.id,
    headline: {
      tokens_reclaimed: tokensReclaimed,
      cost_estimate_usd: costEstimateUsd,
      plan_used: planKey,
      quota_windows_relit: quotaWindowsRelit,
    },
    lines: {
      overnight: durationHuman,
      milestones: `${milestonesDone.length} / ${milestones.length}`,
      decisions: `${decisionsTotal} routed · ${blockingCount} woke you`,
      findings: `${findingsTotal} logged · ${bugFixedCount} bug${bugFixedCount === 1 ? '' : 's'} fixed`,
    },
    foot: {
      session_short: session.id.slice(0, 8),
      brand_url: 'goalnight.dev',
    },
  };
}

function buildFallbackBrief(d) {
  const lines = [];
  lines.push('# 🌙 goalnight — morning brief');
  lines.push('');
  lines.push(`> **${d.summary_one_liner}**`);
  lines.push('');
  lines.push(`**Goal:** ${d.objective}`);
  lines.push(`**Status:** ${d.status}  ·  **Time:** ${d.duration_human}  ·  **Tokens:** ${d.tokens_used}${d.token_budget ? ` / ${d.token_budget}` : ''}`);
  lines.push('');

  // Verification failures lead — these are "the model said done but check
  // disagrees". Higher signal than any decision because they indicate the
  // claimed progress isn't real.
  if (d.verification_failures && d.verification_failures.length > 0) {
    lines.push(`## ⚠️ Claimed done but verification failed (${d.verification_failures.length})`);
    lines.push('These milestones were marked done overnight but their verify command rejected. Treat as not actually done until you eyeball them.');
    lines.push('');
    for (const f of d.verification_failures) {
      lines.push(`- **#${f.ordinal} ${f.title}**`);
      lines.push(`  - _Check:_ \`${f.command}\``);
      if (f.output) {
        const oneLine = String(f.output).split('\n').filter(Boolean).slice(0, 3).join(' · ');
        lines.push(`  - _Output:_ ${oneLine}`);
      }
    }
    lines.push('');
  }

  // Unknowns rendered separately + muted — "couldn't run the check" is not
  // the same as "the work is wrong". Common cause: laptop slept, network died.
  if (d.verification_unknowns && d.verification_unknowns.length > 0) {
    lines.push(`## 🟡 Verification couldn't run (${d.verification_unknowns.length})`);
    lines.push('The check command errored or timed out — the work itself may be fine, but we couldn\'t confirm. Worth re-running manually.');
    lines.push('');
    for (const u of d.verification_unknowns) {
      lines.push(`- **#${u.ordinal} ${u.title}** — \`${u.command}\``);
    }
    lines.push('');
  }

  if (d.decisions_awaiting.length > 0) {
    lines.push(`## ⚠️ Decisions waiting for you (${d.decisions_awaiting.length})`);
    lines.push('');
    for (const dec of d.decisions_awaiting) {
      lines.push(`- **${dec.question}**${dec.blocking ? '  _(blocking)_' : ''}`);
      if (dec.recommendation) lines.push(`  - **Recommended:** ${dec.recommendation}`);
      if (dec.reasoning) lines.push(`  - _Why:_ ${dec.reasoning}`);
    }
    lines.push('');
  }

  if (d.uncertain_decisions && d.uncertain_decisions.length > 0) {
    lines.push(`## 🤔 Decisions you might want to review (${d.uncertain_decisions.length})`);
    lines.push('The agent proceeded with these but flagged them as uncertain. Worth a quick sanity check.');
    lines.push('');
    for (const dec of d.uncertain_decisions) {
      lines.push(`- **${dec.question}**`);
      if (dec.recommendation) lines.push(`  - **Chose:** ${dec.recommendation}`);
      if (dec.reasoning) lines.push(`  - _Why:_ ${dec.reasoning}`);
    }
    lines.push('');
  }

  lines.push(`## ✅ Done (${d.milestones_done.length})`);
  if (d.milestones_done.length === 0) {
    lines.push('_(none yet)_');
  } else {
    for (const m of d.milestones_done) lines.push(`- ${m.title}`);
  }
  lines.push('');

  lines.push(`## ⏳ Pending (${d.milestones_pending.length})`);
  if (d.milestones_pending.length === 0) {
    lines.push('_(none — all milestones done)_');
  } else {
    for (const m of d.milestones_pending) lines.push(`- ${m.title}`);
  }
  lines.push('');

  if (d.findings_highlights.length > 0) {
    lines.push(`## 📝 Notable findings (${d.findings_highlights.length})`);
    for (const f of d.findings_highlights) {
      lines.push(`- [${f.type}/${f.severity}] ${f.content}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
